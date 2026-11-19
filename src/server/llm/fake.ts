import { APICallError } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';

/*
 * Scripted fake provider (ADR 3). Built on `MockLanguageModelV4` from `ai/test` (ai 7.0.x,
 * LanguageModel spec v4). Every model call (doGenerate or doStream) consumes the next turn of
 * the script, so one turn = one agent step. Scripts are plain JSON so demo mode can load them.
 */

const Count = z.number().int().min(0);

/** Token counts in the disjoint buckets of `Usage` from src/shared/budget.ts. */
export const FakeUsageSchema = z.strictObject({
  input: Count.default(0),
  output: Count.default(0),
  cacheRead: Count.default(0),
  cacheWrite: Count.default(0),
  reasoning: Count.default(0),
});

export const FakeToolCallSchema = z.strictObject({
  name: z.string().min(1),
  input: z.unknown().default({}),
});

/** Injected provider failure: 429 is retryable (optionally with retry-after), 401 is not. */
export const FakeErrorSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal(429),
    retryAfterSeconds: z.number().min(0).optional(),
    message: z.string().optional(),
  }),
  z.strictObject({ status: z.literal(401), message: z.string().optional() }),
]);

/** One model call. `text` and string values inside tool `input` support `{{path.to.var}}`. */
export const FakeTurnSchema = z.strictObject({
  text: z.string().optional(),
  toolCalls: z.array(FakeToolCallSchema).optional(),
  usage: FakeUsageSchema.optional(),
  error: FakeErrorSchema.optional(),
});
export const FakeScriptSchema = z.array(FakeTurnSchema);

export type FakeTurn = z.input<typeof FakeTurnSchema>;
export type FakeScript = z.input<typeof FakeScriptSchema>;
export type FakeModelOptions = {
  /** Template variables, e.g. `{issue: {number: 11}}` for `{{issue.number}}`. */
  vars?: Record<string, unknown>;
};

type ParsedTurn = z.output<typeof FakeTurnSchema>;
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type Content = GenerateResult['content'][number];
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let value: unknown = vars;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function fillString(text: string, vars: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_match, path: string) => {
    const value = lookup(vars, path);
    if (value === undefined || value === null || typeof value === 'object') {
      throw new Error(`Fake script: no value for template variable {{${path}}}`);
    }
    return String(value);
  });
}

function fill(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') return fillString(value, vars);
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

function injectedError(error: NonNullable<ParsedTurn['error']>): APICallError {
  const retryAfter = error.status === 429 ? error.retryAfterSeconds : undefined;
  return new APICallError({
    message: error.message ?? (error.status === 429 ? 'Rate limit exceeded' : 'Invalid API key'),
    url: 'fake://model',
    requestBodyValues: {},
    statusCode: error.status,
    responseHeaders: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
    isRetryable: error.status === 429,
  });
}

function toUsage(usage: ParsedTurn['usage']): GenerateResult['usage'] {
  const u = usage ?? FakeUsageSchema.parse({});
  return {
    inputTokens: {
      total: u.input + u.cacheRead + u.cacheWrite,
      noCache: u.input,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
    },
    outputTokens: { total: u.output + u.reasoning, text: u.output, reasoning: u.reasoning },
  };
}

/** Resolves a turn into AI SDK content parts, or throws its injected error. */
function render(turn: ParsedTurn, index: number, vars: Record<string, unknown>) {
  if (turn.error !== undefined) throw injectedError(turn.error);
  const text = turn.text === undefined ? undefined : fillString(turn.text, vars);
  const toolCalls = (turn.toolCalls ?? []).map((call, i) => ({
    type: 'tool-call' as const,
    toolCallId: `fake-call-${index}-${i}`,
    toolName: call.name,
    input: JSON.stringify(fill(call.input, vars)),
  }));
  const finishReason: GenerateResult['finishReason'] =
    toolCalls.length > 0
      ? { unified: 'tool-calls', raw: 'tool_calls' }
      : { unified: 'stop', raw: 'stop' };
  return { text, toolCalls, finishReason, usage: toUsage(turn.usage) };
}

/**
 * A language model that replays `script`, one turn per call, through generateText/streamText.
 * Throws when the script is exhausted; invalid scripts are rejected up front.
 */
export function fakeModel(script: FakeScript, options: FakeModelOptions = {}): MockLanguageModelV4 {
  const turns = FakeScriptSchema.parse(script);
  const vars = options.vars ?? {};
  let cursor = 0;
  const next = () => {
    const index = cursor;
    const turn = turns[index];
    if (turn === undefined) {
      throw new Error(`Fake script exhausted: all ${turns.length} turns were used`);
    }
    cursor += 1;
    return render(turn, index, vars);
  };

  return new MockLanguageModelV4({
    provider: 'fake',
    modelId: 'fake',
    doGenerate: async () => {
      const { text, toolCalls, finishReason, usage } = next();
      const content: Content[] = [];
      if (text !== undefined) content.push({ type: 'text', text });
      content.push(...toolCalls);
      return { content, finishReason, usage, warnings: [] };
    },
    doStream: async () => {
      const { text, toolCalls, finishReason, usage } = next();
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (text !== undefined) {
        parts.push(
          { type: 'text-start', id: 'text-0' },
          { type: 'text-delta', id: 'text-0', delta: text },
          { type: 'text-end', id: 'text-0' },
        );
      }
      parts.push(...toolCalls, { type: 'finish', finishReason, usage });
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}
