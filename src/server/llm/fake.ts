import { APICallError } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { WEB_SEARCH_TOOL_NAME } from './capabilities.ts';

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

/**
 * Injected provider failure: 429 (optionally with retry-after) and 503 are retryable; 401 and
 * 403 are not.
 */
export const FakeErrorSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal(429),
    retryAfterSeconds: z.number().min(0).optional(),
    message: z.string().optional(),
  }),
  z.strictObject({ status: z.literal(401), message: z.string().optional() }),
  z.strictObject({ status: z.literal(403), message: z.string().optional() }),
  z.strictObject({ status: z.literal(503), message: z.string().optional() }),
]);

/** A provider-executed web search (call + result), streamed under the `web_search` tool name. */
export const FakeWebSearchSchema = z.strictObject({ query: z.string() });

/** One model call. `text` and string values inside tool `input` support `{{path.to.var}}`. */
export const FakeTurnSchema = z.strictObject({
  text: z.string().optional(),
  toolCalls: z.array(FakeToolCallSchema).optional(),
  usage: FakeUsageSchema.optional(),
  error: FakeErrorSchema.optional(),
  webSearches: z.array(FakeWebSearchSchema).optional(),
  /** Never answers: the call only ends (with an abort error) when its abortSignal fires. */
  hang: z.literal(true).optional(),
});
export const FakeScriptSchema = z.array(FakeTurnSchema);

export type FakeTurn = z.input<typeof FakeTurnSchema>;
export type FakeScript = z.input<typeof FakeScriptSchema>;
/** The prompt (system + messages) a model call receives. */
export type FakeCallPrompt = Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'];

export type FakeModelOptions = {
  /** Template variables, e.g. `{issue: {number: 11}}` for `{{issue.number}}`. */
  vars?: Record<string, unknown>;
  /** Called with the prompt of every model call, before its turn is replayed (tests). */
  onCall?: (prompt: FakeCallPrompt) => void;
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

const DEFAULT_ERROR_MESSAGES = {
  429: 'Rate limit exceeded',
  401: 'Invalid API key',
  403: 'Permission denied',
  503: 'Service unavailable',
} as const;

function injectedError(error: NonNullable<ParsedTurn['error']>): APICallError {
  const retryAfter = error.status === 429 ? error.retryAfterSeconds : undefined;
  return new APICallError({
    message: error.message ?? DEFAULT_ERROR_MESSAGES[error.status],
    url: 'fake://model',
    requestBodyValues: {},
    statusCode: error.status,
    responseHeaders: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
    isRetryable: error.status === 429 || error.status === 503,
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
  const searches = (turn.webSearches ?? []).flatMap((search, i) => {
    const toolCallId = `fake-search-${index}-${i}`;
    const query = fillString(search.query, vars);
    return [
      {
        type: 'tool-call' as const,
        toolCallId,
        toolName: WEB_SEARCH_TOOL_NAME,
        input: JSON.stringify({ query }),
        providerExecuted: true,
        dynamic: true,
      },
      {
        type: 'tool-result' as const,
        toolCallId,
        toolName: WEB_SEARCH_TOOL_NAME,
        result: [{ url: `https://example.com/search?q=${encodeURIComponent(query)}` }],
        dynamic: true,
      },
    ];
  });
  const finishReason: GenerateResult['finishReason'] =
    toolCalls.length > 0
      ? { unified: 'tool-calls', raw: 'tool_calls' }
      : { unified: 'stop', raw: 'stop' };
  return { text, toolCalls, searches, finishReason, usage: toUsage(turn.usage) };
}

/** Never resolves; rejects with the abort reason once `signal` fires. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('The call was aborted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
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
    return { turn, rendered: () => render(turn, index, vars) };
  };

  return new MockLanguageModelV4({
    provider: 'fake',
    modelId: 'fake',
    doGenerate: async ({ abortSignal, prompt }) => {
      options.onCall?.(prompt);
      const { turn, rendered } = next();
      if (turn.hang === true) return hangUntilAborted(abortSignal);
      const { text, toolCalls, searches, finishReason, usage } = rendered();
      const content: Content[] = [...searches];
      if (text !== undefined) content.push({ type: 'text', text });
      content.push(...toolCalls);
      return { content, finishReason, usage, warnings: [] };
    },
    doStream: async ({ abortSignal, prompt }) => {
      options.onCall?.(prompt);
      const { turn, rendered } = next();
      if (turn.hang === true) return hangUntilAborted(abortSignal);
      const { text, toolCalls, searches, finishReason, usage } = rendered();
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }, ...searches];
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
