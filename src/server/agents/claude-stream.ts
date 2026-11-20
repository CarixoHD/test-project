// Parser for `claude -p --output-format stream-json --verbose` output (NDJSON, one event per
// line; docs/research/how-can-the-platform-drive-the-official-claude-cod.md §3–5). Pure: it folds
// lines into a state, then `outcome()` classifies the finished run. Every line is external input
// and validated with zod; unknown or malformed lines are ignored.
import { z } from 'zod';
import type { AgentResult, StepUsage } from './types.ts';

export const CLAUDE_BACKEND = 'claude-code';
/** Used when the CLI says it is rate limited but gives no parseable reset time. */
export const DEFAULT_CLAUDE_RATE_LIMIT_MS = 15 * 60_000;
/** Below this, `resetsAt` is epoch seconds (the docs leave the unit open); at or above, epoch ms. */
const EPOCH_MS_THRESHOLD = 1e12;

const Count = z.number().finite().nonnegative();

const ContentBlock = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.looseObject({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.looseObject({ type: z.string() }),
]);

const AssistantEvent = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({ content: z.array(ContentBlock).catch([]) }),
  error: z.string().optional(),
});

const UserEvent = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]).catch([]) }),
});

const ApiRetryEvent = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  attempt: z.number().optional(),
  max_retries: z.number().optional(),
  error: z.string().optional(),
});

const RateLimitEvent = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({
    status: z.string(),
    resetsAt: z.number().finite().positive().optional(),
    utilization: z.number().finite().optional(),
  }),
});

const ModelUsageEntry = z.looseObject({
  inputTokens: Count.catch(0),
  outputTokens: Count.catch(0),
  thinkingTokens: Count.optional().catch(undefined),
  cacheReadInputTokens: Count.catch(0),
  cacheCreationInputTokens: Count.catch(0),
  webSearchRequests: Count.catch(0),
  costUSD: Count.optional().catch(undefined),
});

const ResultEvent = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().catch(false),
  result: z.string().nullish(),
  errors: z.array(z.string()).optional().catch(undefined),
  api_error_status: z.number().nullish(),
  num_turns: Count.optional().catch(undefined),
  session_id: z.string().optional(),
  total_cost_usd: Count.optional().catch(undefined),
  usage: z
    .looseObject({
      input_tokens: Count.catch(0),
      output_tokens: Count.catch(0),
      cache_creation_input_tokens: Count.catch(0),
      cache_read_input_tokens: Count.catch(0),
    })
    .optional()
    .catch(undefined),
  modelUsage: z.record(z.string(), ModelUsageEntry).optional().catch(undefined),
  structured_output: z.unknown().optional(),
});
type ResultEvent = z.infer<typeof ResultEvent>;

const ClaudeEvent = z.union([
  AssistantEvent,
  UserEvent,
  ApiRetryEvent,
  RateLimitEvent,
  ResultEvent,
]);

export type ClaudeStreamState = {
  toolNames: Map<string, string>;
  /** Epoch ms from a `rejected` rate_limit_event, or null when it carried no `resetsAt`. */
  rejectedUntil: number | null | undefined;
  rateLimitHint: boolean;
  authFailed: boolean;
  /** Assistant text, for the "resets …" / "Login expired" fallbacks. */
  texts: string[];
  result: ResultEvent | undefined;
};

export function newStreamState(): ClaudeStreamState {
  return {
    toolNames: new Map(),
    rejectedUntil: undefined,
    rateLimitHint: false,
    authFailed: false,
    texts: [],
    result: undefined,
  };
}

/** Folds one stdout line into `state`; returns the activity lines it produces (unredacted). */
export function parseStreamLine(state: ClaudeStreamState, line: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return [];
  }
  const parsed = ClaudeEvent.safeParse(json);
  if (!parsed.success) return [];
  const ev = parsed.data;
  switch (ev.type) {
    case 'assistant':
      return assistantActivity(state, ev);
    case 'user':
      return userActivity(state, ev);
    case 'system':
      if (ev.error === 'rate_limit') state.rateLimitHint = true;
      if (ev.error === 'authentication_failed') state.authFailed = true;
      return [`api retry ${ev.attempt ?? '?'}/${ev.max_retries ?? '?'}: ${ev.error ?? 'unknown'}`];
    case 'rate_limit_event': {
      const info = ev.rate_limit_info;
      if (info.status === 'rejected') {
        state.rejectedUntil = info.resetsAt === undefined ? null : toEpochMs(info.resetsAt);
      }
      const used =
        info.utilization === undefined ? '' : ` (${Math.round(info.utilization * 100)}% used)`;
      return [`rate limit ${info.status}${used}`];
    }
    case 'result':
      state.result = ev;
      return [];
  }
}

function assistantActivity(state: ClaudeStreamState, ev: z.infer<typeof AssistantEvent>): string[] {
  if (ev.error === 'rate_limit') state.rateLimitHint = true;
  if (ev.error === 'authentication_failed') state.authFailed = true;
  const out: string[] = [];
  for (const block of ev.message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      state.texts.push(block.text);
      if (block.text.trim() !== '') out.push(`text: ${block.text.trim()}`);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      if (typeof block.id === 'string') state.toolNames.set(block.id, block.name);
      out.push(`tool ${block.name} ${JSON.stringify(block.input ?? {})}`);
    }
  }
  return out;
}

function userActivity(state: ClaudeStreamState, ev: z.infer<typeof UserEvent>): string[] {
  if (typeof ev.message.content === 'string') return [];
  const out: string[] = [];
  for (const block of ev.message.content) {
    if (block.type !== 'tool_result' || block.is_error !== true) continue;
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    out.push(
      `tool error ${state.toolNames.get(id) ?? 'unknown'}: ${toolResultText(block.content)}`,
    );
  }
  return out;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) =>
        typeof c === 'object' && c !== null && 'text' in c && typeof c.text === 'string'
          ? c.text
          : '',
      )
      .join('');
  }
  return '';
}

function toEpochMs(resetsAt: number): number {
  return resetsAt < EPOCH_MS_THRESHOLD ? Math.round(resetsAt * 1000) : Math.round(resetsAt);
}

/**
 * One subscription StepUsage for the whole CLI run: `modelUsage` summed over models (it includes
 * subagents), `calls` = `num_turns`, and the CLI's `total_cost_usd` as the estimate.
 */
export function resultUsage(result: ResultEvent): StepUsage | undefined {
  const entries = Object.values(result.modelUsage ?? {});
  const u = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    webSearches: 0,
  };
  let costSum: number | undefined;
  if (entries.length > 0) {
    for (const m of entries) {
      const thinking = Math.min(m.thinkingTokens ?? 0, m.outputTokens);
      u.input += m.inputTokens;
      u.output += m.outputTokens - thinking;
      u.reasoning += thinking;
      u.cacheRead += m.cacheReadInputTokens;
      u.cacheWrite += m.cacheCreationInputTokens;
      u.webSearches += m.webSearchRequests;
      if (m.costUSD !== undefined) costSum = (costSum ?? 0) + m.costUSD;
    }
  } else if (result.usage !== undefined) {
    u.input = result.usage.input_tokens;
    u.output = result.usage.output_tokens;
    u.cacheRead = result.usage.cache_read_input_tokens;
    u.cacheWrite = result.usage.cache_creation_input_tokens;
  }
  if (Object.values(u).every((n) => n === 0)) return undefined;
  const reported = result.total_cost_usd ?? costSum;
  return {
    ...u,
    step: 1,
    calls: Math.max(1, result.num_turns ?? 1),
    ...(reported === undefined ? {} : { reportedEstCostUsd: reported }),
    providerMetadata: {
      claudeCode: { sessionId: result.session_id, modelUsage: result.modelUsage },
    },
  };
}

const LOGIN_EXPIRED = /login expired/i;
const RESETS =
  /resets\s+(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Epoch ms of the next "resets 3:45pm" / "resets Mon 12:00am" after `now`, read in the server's
 * local time zone (the CLI formats it in the container's, which is UTC unless TZ is set).
 */
export function parseResetsText(text: string, now: number): number | undefined {
  const m = RESETS.exec(text);
  if (m === null) return undefined;
  const [, day, h, min, ampm] = m;
  const hour12 = Number(h);
  const minute = min === undefined ? 0 : Number(min);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (ampm?.toLowerCase() === 'pm' ? 12 : 0);
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (day !== undefined) {
    const target = WEEKDAYS.indexOf(day.toLowerCase());
    at.setDate(at.getDate() + ((target - at.getDay() + 7) % 7));
    if (at.getTime() <= now) at.setDate(at.getDate() + 7);
  } else if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

type Failure = Exclude<AgentResult<never>, { kind: 'ok' | 'stopped' }>;

/**
 * Classifies a finished run that did not stop: a clean `result` with structured output → ok;
 * otherwise rate limit, login and error signals, in that order.
 */
export function streamOutcome<T>(
  state: ClaudeStreamState,
  o: {
    schema: z.ZodType<T>;
    now: number;
    exitCode: number | null;
    stderr: string;
  },
): AgentResult<T> {
  const r = state.result;
  if (r !== undefined && !r.is_error && r.subtype === 'success') {
    const parsed = o.schema.safeParse(r.structured_output);
    if (parsed.success) return { kind: 'ok', result: parsed.data };
    return {
      kind: 'error',
      message: `Claude Code returned structured output that does not match the result schema: ${z.prettifyError(parsed.error)}`,
      transient: false,
    };
  }
  return failure(state, r, o);
}

function failure(
  state: ClaudeStreamState,
  r: ResultEvent | undefined,
  o: { now: number; exitCode: number | null; stderr: string },
): Failure {
  const texts = [...state.texts, r?.result ?? '', ...(r?.errors ?? []), o.stderr].join('\n');
  if (state.rejectedUntil !== undefined) {
    return rateLimited(state.rejectedUntil ?? parseResetsText(texts, o.now), o.now);
  }
  if (state.authFailed || r?.api_error_status === 401 || LOGIN_EXPIRED.test(texts)) {
    return { kind: 'auth_required', backend: CLAUDE_BACKEND };
  }
  const resetsAt = parseResetsText(texts, o.now);
  if (state.rateLimitHint || r?.api_error_status === 429 || resetsAt !== undefined) {
    return rateLimited(resetsAt, o.now);
  }
  if (r === undefined) {
    const tail = o.stderr.trim().split('\n').slice(-5).join('\n');
    return {
      kind: 'error',
      message: `Claude Code exited with code ${o.exitCode ?? 'null'} without a result${tail === '' ? '' : `: ${tail}`}`,
      transient: true,
    };
  }
  const detail = r.errors?.join('; ') || r.result || '';
  const prefix = r.subtype === 'success' ? '' : `${r.subtype}: `;
  const status = r.api_error_status ?? 0;
  return {
    kind: 'error',
    message: `Claude Code: ${prefix}${detail}`.trim(),
    transient: status >= 500,
  };
}

function rateLimited(until: number | undefined, now: number): Failure {
  return {
    kind: 'rate_limited',
    until: until !== undefined && until > now ? until : now + DEFAULT_CLAUDE_RATE_LIMIT_MS,
    backend: CLAUDE_BACKEND,
  };
}
