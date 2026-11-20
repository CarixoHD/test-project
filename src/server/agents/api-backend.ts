// ApiBackend (ADR 3, docs/ARCHITECTURE.md §4.6): our own step loop over AI SDK `streamText`, one
// model call per step. Tools execute in the sandbox; the loop itself runs on the host so API keys
// never enter a container. The only agents module allowed to import `ai`.
import {
  APICallError,
  RetryError,
  dynamicTool,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { ModelRef } from '../../shared/models.ts';
import {
  MissingProviderSetupError,
  WEB_SEARCH_TOOL_NAME,
  capabilities,
  model,
  webSearchTool,
} from '../llm/index.ts';
import type { Sandbox } from '../sandbox/index.ts';
import { redactor } from '../security/index.ts';
import type { Clock } from '../util/clock.ts';
import { agentTools, truncateMiddle } from './tools.ts';
import type { AgentResult, AgentSpec, StepUsage } from './types.ts';

export const FINISH_TOOL_NAME = 'finish';
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_MS = 60_000;
const ACTIVITY_LINE_LIMIT = 500;

type Failure = Exclude<AgentResult<never>, { kind: 'ok' }>;

/** Why a call was aborted by the loop itself. */
type AbortCause = 'wall_clock' | 'step_timeout';

type StepOutcome<T> =
  | { kind: 'finished'; result: T }
  | { kind: 'continue'; messages: ModelMessage[] }
  | { kind: 'failed'; failure: Failure };

type Run<T> = {
  spec: AgentSpec<T>;
  languageModel: LanguageModel;
  tools: ToolSet;
  finished: { value: T } | undefined;
  runSignal: AbortSignal;
  abortCause: AbortCause | undefined;
};

export async function runApiBackend<T>(spec: AgentSpec<T>): Promise<AgentResult<T>> {
  if (spec.tools.length > 0 && spec.sandbox === undefined) {
    return {
      kind: 'error',
      message: 'Agent tools need a sandbox, but none was given',
      transient: false,
    };
  }
  const wantsSearch = spec.webSearch === true && capabilities(spec.model).webSearch;
  let languageModel: LanguageModel;
  try {
    languageModel = model(spec.model, { ...spec.modelDeps, webSearch: wantsSearch });
  } catch (err) {
    if (err instanceof MissingProviderSetupError) {
      return { kind: 'error', message: redactor.redact(err.message), transient: false };
    }
    throw err;
  }

  const controller = new AbortController();
  const startedAt = spec.clock.now();
  const run: Run<T> = {
    spec,
    languageModel,
    tools: {},
    finished: undefined,
    runSignal: controller.signal,
    abortCause: undefined,
  };
  run.tools = buildTools(run, wantsSearch);
  const wallTimer = setTimeout(() => {
    run.abortCause ??= 'wall_clock';
    controller.abort(new Error('Agent wall-clock limit reached'));
  }, spec.limits.wallClockMs);

  const messages: ModelMessage[] = [{ role: 'user', content: spec.prompt }];
  try {
    for (let step = 0; ; step++) {
      if (spec.shouldStop()) return { kind: 'stopped' };
      if (step >= spec.limits.maxSteps) {
        return {
          kind: 'error',
          message: `Agent did not call finish within ${String(spec.limits.maxSteps)} steps`,
          transient: false,
        };
      }
      if (spec.clock.now() - startedAt >= spec.limits.wallClockMs) return wallClockError(spec);
      const outcome = await runStep(run, messages, step);
      switch (outcome.kind) {
        case 'finished':
          return { kind: 'ok', result: outcome.result };
        case 'failed':
          return outcome.failure;
        case 'continue':
          messages.push(...outcome.messages);
      }
    }
  } finally {
    clearTimeout(wallTimer);
    controller.abort(new Error('Agent run ended'));
  }
}

function wallClockError(spec: AgentSpec<unknown>): Failure {
  const minutes = Math.round(spec.limits.wallClockMs / 60_000);
  return {
    kind: 'error',
    message: `Agent exceeded its time limit (${String(minutes)} min) without calling finish`,
    transient: false,
  };
}

/** The role's agent tools (executed in the sandbox), `finish`, and the provider web search. */
function buildTools<T>(run: Run<T>, wantsSearch: boolean): ToolSet {
  const { spec } = run;
  const tools: ToolSet = {};
  const sandbox: Sandbox | undefined = spec.sandbox;
  if (sandbox !== undefined) {
    for (const agentTool of agentTools.filter((t) => spec.tools.includes(t.name))) {
      tools[agentTool.name] = dynamicTool({
        description: agentTool.description,
        inputSchema: agentTool.inputSchema,
        execute: (input) => agentTool.execute(input, sandbox),
      });
    }
  }
  tools[FINISH_TOOL_NAME] = tool({
    description:
      'Call exactly once when the task is complete, with the final result. If the input is ' +
      'rejected, fix it and call finish again.',
    inputSchema: spec.schema,
    execute: (value: T) => {
      run.finished = { value };
      return 'Result accepted.';
    },
  });
  const search = wantsSearch ? webSearchTool(spec.model) : undefined;
  if (search !== undefined) tools[WEB_SEARCH_TOOL_NAME] = search;
  return tools;
}

/** One model call: streams it, reports activity and usage, and decides how the run goes on. */
async function runStep<T>(
  run: Run<T>,
  messages: ModelMessage[],
  step: number,
): Promise<StepOutcome<T>> {
  const { spec } = run;
  const stepController = new AbortController();
  const stepTimeoutMs = spec.limits.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const stepTimer = setTimeout(() => {
    run.abortCause ??= 'step_timeout';
    stepController.abort(new Error('Model call timed out'));
  }, stepTimeoutMs);
  const signal = AbortSignal.any([run.runSignal, stepController.signal]);
  const activity = (line: string) => {
    spec.onActivity?.(truncateMiddle(redactor.redact(line), ACTIVITY_LINE_LIMIT));
  };

  let streamError: unknown;
  let usage: LanguageModelUsage | undefined;
  let providerMetadata: unknown;
  let webSearchResults = 0;
  let text = '';
  try {
    const result = streamText({
      model: run.languageModel,
      instructions: spec.instructions,
      messages,
      tools: run.tools,
      maxRetries: 0,
      abortSignal: signal,
      // Errors arrive as `error` parts below and are mapped to a result there.
      onError: () => undefined,
    });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          text += part.text;
          break;
        case 'tool-call':
          activity(
            `${part.providerExecuted === true ? 'provider tool' : 'tool'} ${part.toolName} ${JSON.stringify(part.input)}`,
          );
          break;
        case 'tool-error':
          activity(`tool error ${part.toolName}: ${errorText(part.error)}`);
          break;
        case 'tool-result':
          if (part.providerExecuted === true && part.toolName === WEB_SEARCH_TOOL_NAME) {
            webSearchResults += 1;
          }
          break;
        case 'finish-step':
          usage = part.usage;
          providerMetadata = part.providerMetadata;
          break;
        case 'error':
          streamError ??= part.error;
          break;
        default:
          break;
      }
    }
    if (text.trim() !== '') activity(`text: ${text.trim()}`);
    if (signal.aborted) return { kind: 'failed', failure: abortFailure(run) };
    if (streamError !== undefined) {
      return { kind: 'failed', failure: classifyError(streamError, spec.model, spec.clock) };
    }
    spec.onUsage?.(toStepUsage(step, usage, providerMetadata, webSearchResults));
    if (run.finished !== undefined) return { kind: 'finished', result: run.finished.value };
    return { kind: 'continue', messages: (await result.response).messages };
  } catch (err) {
    if (signal.aborted) return { kind: 'failed', failure: abortFailure(run) };
    return { kind: 'failed', failure: classifyError(err, spec.model, spec.clock) };
  } finally {
    clearTimeout(stepTimer);
  }
}

function abortFailure(run: Run<unknown>): Failure {
  if (run.abortCause === 'wall_clock') return wallClockError(run.spec);
  const seconds = Math.round((run.spec.limits.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS) / 1000);
  return {
    kind: 'error',
    message: `The model call timed out after ${String(seconds)} s`,
    transient: true,
  };
}

function count(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Splits AI SDK usage into the disjoint `Usage` buckets. */
function toStepUsage(
  step: number,
  usage: LanguageModelUsage | undefined,
  providerMetadata: unknown,
  webSearchResults: number,
): StepUsage {
  const cacheRead = count(usage?.inputTokenDetails.cacheReadTokens);
  const cacheWrite = count(usage?.inputTokenDetails.cacheWriteTokens);
  const reasoning = count(usage?.outputTokenDetails.reasoningTokens);
  const input =
    usage?.inputTokenDetails.noCacheTokens ??
    count(count(usage?.inputTokens) - cacheRead - cacheWrite);
  const output =
    usage?.outputTokenDetails.textTokens ?? count(count(usage?.outputTokens) - reasoning);
  return {
    step,
    input: count(input),
    output: count(output),
    cacheRead,
    cacheWrite,
    reasoning,
    webSearches: Math.max(webSearchResults, metadataWebSearches(providerMetadata)),
    providerMetadata,
  };
}

/** Anthropic reports billed searches as `usage.server_tool_use.web_search_requests`. */
function metadataWebSearches(providerMetadata: unknown): number {
  const requests = path(providerMetadata, [
    'anthropic',
    'usage',
    'server_tool_use',
    'web_search_requests',
  ]);
  return typeof requests === 'number' ? count(requests) : 0;
}

function path(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Retry-After as seconds or an HTTP date; falls back to one minute. */
function rateLimitedUntil(headers: Record<string, string> | undefined, clock: Clock): number {
  const now = clock.now();
  const raw = headers?.['retry-after']?.trim();
  if (raw !== undefined && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return now + Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  return now + DEFAULT_RATE_LIMIT_MS;
}

/** Maps a provider failure to a run result: 429 → rate_limited, 401/403 → fix Settings, else error. */
export function classifyError(err: unknown, ref: ModelRef, clock: Clock): Failure {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  if (cause instanceof MissingProviderSetupError) {
    return { kind: 'error', message: redactor.redact(cause.message), transient: false };
  }
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 429) {
      return {
        kind: 'rate_limited',
        until: rateLimitedUntil(cause.responseHeaders, clock),
        backend: ref.provider,
      };
    }
    if (status === 401 || status === 403) {
      return {
        kind: 'error',
        message: `The ${ref.provider} API rejected the request (HTTP ${String(status)}): check the API key and model access in Settings`,
        transient: false,
      };
    }
    const transient = status === undefined || status >= 500 || cause.isRetryable;
    const detail = redactor.redact(cause.message);
    return {
      kind: 'error',
      message: `The ${ref.provider} API call failed${status === undefined ? '' : ` (HTTP ${String(status)})`}: ${detail}`,
      transient,
    };
  }
  // Network failures (fetch errors, resets) and unexpected stream errors: worth another attempt.
  return {
    kind: 'error',
    message: `The ${ref.provider} model call failed: ${redactor.redact(errorText(cause))}`,
    transient: true,
  };
}
