import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelRef } from '../../shared/models.ts';
import { API_KEY_SECRETS, type FakeCallPrompt, type FakeScript } from '../llm/index.ts';
import { FakeContainerRuntime, type Sandbox } from '../sandbox/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FINISH_NUDGE } from './api-backend.ts';
import { runAgent, type AgentSpec, type StepUsage } from './index.ts';

const START = 1_700_000_000_000;
const ResultSchema = z.strictObject({ summary: z.string().min(1) });
type Result = z.infer<typeof ResultSchema>;

let base: string;
let wt: string;
let sandbox: Sandbox;
let clock: FakeClock;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibecode-run-agent-'));
  const dataDir = path.join(base, 'data');
  wt = path.join(dataDir, 'worktrees', '01RUN');
  await mkdir(wt, { recursive: true });
  const rt = new FakeContainerRuntime({ dataDir });
  sandbox = await rt.open({
    runId: '01RUN',
    productId: '01PROD',
    role: 'agent',
    image: 'vibecode/base',
    worktree: wt,
    readOnly: false,
    network: 'egress',
  });
  clock = new FakeClock(START);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(base, { recursive: true, force: true });
});

type Recorded = { activity: string[]; usage: StepUsage[] };

function spec(
  script: FakeScript,
  over: Partial<AgentSpec<Result>> = {},
): { spec: AgentSpec<Result>; rec: Recorded } {
  const rec: Recorded = { activity: [], usage: [] };
  return {
    rec,
    spec: {
      agentId: '01AGENT',
      role: 'implementer',
      model: { provider: 'fake', model: 'fake' },
      instructions: 'You are a test agent.',
      prompt: 'Do the task.',
      schema: ResultSchema,
      sandbox,
      tools: ['read_file', 'write_file', 'run'],
      limits: { maxSteps: 10, wallClockMs: 60_000 },
      shouldStop: () => false,
      modelDeps: { getSecret: () => undefined, fake: { script } },
      clock,
      onActivity: (line) => rec.activity.push(line),
      onUsage: (u) => rec.usage.push(u),
      ...over,
    },
  };
}

const finish = (summary: unknown) => ({ name: 'finish', input: { summary } });

describe('runAgent with the API backend', () => {
  it('writes a file through the sandbox, then finishes with a valid result', async () => {
    const { spec: s, rec } = spec([
      {
        text: 'Writing the file.',
        toolCalls: [{ name: 'write_file', input: { path: 'hello.txt', content: 'hi\n' } }],
      },
      { toolCalls: [finish('wrote hello.txt')] },
    ]);

    const result = await runAgent(s);

    expect(result).toEqual({ kind: 'ok', result: { summary: 'wrote hello.txt' } });
    expect(await readFile(path.join(wt, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(rec.activity.some((l) => l.includes('Writing the file.'))).toBe(true);
    expect(rec.activity.some((l) => l.includes('write_file') && l.includes('hello.txt'))).toBe(
      true,
    );
  });

  it('returns an invalid finish to the model as a tool error and accepts the next valid one', async () => {
    const { spec: s, rec } = spec([
      { toolCalls: [finish(42)] },
      { toolCalls: [finish('second try')] },
    ]);

    const result = await runAgent(s);

    expect(result).toEqual({ kind: 'ok', result: { summary: 'second try' } });
    expect(rec.usage).toHaveLength(2);
    expect(rec.activity.some((l) => /finish/.test(l) && /error|invalid/i.test(l))).toBe(true);
  });

  it('ends with a non-transient error when maxSteps is exceeded without finish', async () => {
    const { spec: s, rec } = spec(
      [{ text: 'thinking' }, { text: 'still thinking' }, { toolCalls: [finish('late')] }],
      { limits: { maxSteps: 2, wallClockMs: 60_000 } },
    );

    const result = await runAgent(s);

    expect(result).toMatchObject({ kind: 'error', transient: false });
    expect(result.kind === 'error' && result.message).toMatch(/2 steps/);
    expect(rec.usage).toHaveLength(2);
  });

  describe('finish nudge after a text-only step', () => {
    function recordingSpec(script: FakeScript): {
      spec: AgentSpec<Result>;
      prompts: FakeCallPrompt[];
    } {
      const prompts: FakeCallPrompt[] = [];
      const { spec: s } = spec(script, {
        modelDeps: {
          getSecret: () => undefined,
          fake: { script, onCall: (prompt) => prompts.push(prompt) },
        },
      });
      return { spec: s, prompts };
    }

    const lastMessage = (prompt: FakeCallPrompt | undefined) => prompt?.at(-1);
    const mentionsNudge = (prompt: FakeCallPrompt | undefined) =>
      JSON.stringify(prompt).includes(JSON.stringify(FINISH_NUDGE).slice(1, -1));

    it('ends the next prompt with a user message carrying the finish nudge', async () => {
      const { spec: s, prompts } = recordingSpec([
        { text: 'Here is my answer.' },
        { toolCalls: [finish('done')] },
      ]);

      await runAgent(s);

      expect(prompts).toHaveLength(2);
      const last = lastMessage(prompts[1]);
      expect(last?.role).toBe('user');
      expect(JSON.stringify(last?.content)).toContain(JSON.stringify(FINISH_NUDGE).slice(1, -1));
      expect(FINISH_NUDGE).toMatch(/finish/);
    });

    it('does not nudge after a step that made tool calls', async () => {
      const { spec: s, prompts } = recordingSpec([
        {
          text: 'Writing.',
          toolCalls: [{ name: 'write_file', input: { path: 'a.txt', content: 'a' } }],
        },
        { toolCalls: [finish('done')] },
      ]);

      await runAgent(s);

      expect(prompts).toHaveLength(2);
      expect(lastMessage(prompts[1])?.role).toBe('tool');
      expect(mentionsNudge(prompts[1])).toBe(false);
    });

    it('returns ok when the model answers in text first and calls finish next', async () => {
      const { spec: s } = recordingSpec([
        { text: 'The summary is: all good.' },
        { toolCalls: [finish('all good')] },
      ]);

      const result = await runAgent(s);

      expect(result).toEqual({ kind: 'ok', result: { summary: 'all good' } });
    });
  });

  it('checks shouldStop between steps and returns stopped', async () => {
    let checks = 0;
    const { spec: s } = spec(
      [
        { toolCalls: [{ name: 'write_file', input: { path: 'a.txt', content: 'a' } }] },
        { toolCalls: [{ name: 'write_file', input: { path: 'b.txt', content: 'b' } }] },
        { toolCalls: [finish('done')] },
      ],
      { shouldStop: () => ++checks > 1 },
    );

    const result = await runAgent(s);

    expect(result).toEqual({ kind: 'stopped' });
    expect(checks).toBe(2);
    expect(await readFile(path.join(wt, 'a.txt'), 'utf8')).toBe('a');
    await expect(readFile(path.join(wt, 'b.txt'), 'utf8')).rejects.toThrow();
  });

  it('returns stopped without calling the model when shouldStop is already true', async () => {
    const { spec: s, rec } = spec([{ toolCalls: [finish('never')] }], { shouldStop: () => true });

    expect(await runAgent(s)).toEqual({ kind: 'stopped' });
    expect(rec.usage).toHaveLength(0);
  });

  it('maps a 429 to rate_limited using retry-after, consuming exactly one turn', async () => {
    // A retry by the SDK would consume the second turn and finish ok.
    const { spec: s } = spec([
      { error: { status: 429, retryAfterSeconds: 7 } },
      { toolCalls: [finish('retried')] },
    ]);

    expect(await runAgent(s)).toEqual({
      kind: 'rate_limited',
      until: START + 7_000,
      backend: 'fake',
    });
  });

  it('defaults rate_limited.until to 60 s from now without retry-after', async () => {
    const { spec: s } = spec([{ error: { status: 429 } }]);

    expect(await runAgent(s)).toEqual({
      kind: 'rate_limited',
      until: START + 60_000,
      backend: 'fake',
    });
  });

  it.each([401, 403] as const)(
    'maps HTTP %i to an actionable non-transient error',
    async (status) => {
      const { spec: s } = spec([{ error: { status, message: 'bad key sk-ant-secret123' } }]);

      const result = await runAgent(s);

      expect(result).toMatchObject({ kind: 'error', transient: false });
      expect(result.kind === 'error' && result.message).toMatch(/Settings/);
      expect(result.kind === 'error' && result.message).toContain(String(status));
    },
  );

  it('maps a 5xx to a transient error', async () => {
    const { spec: s } = spec([{ error: { status: 503 } }, { toolCalls: [finish('x')] }]);

    expect(await runAgent(s)).toMatchObject({ kind: 'error', transient: true });
  });

  it('maps MissingProviderSetupError to a non-transient error with its message', async () => {
    const { spec: s } = spec([], { model: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });

    expect(await runAgent(s)).toEqual({
      kind: 'error',
      message: 'Add an Anthropic API key in Settings',
      transient: false,
    });
  });

  it('runs provider claude-code through the Claude Code CLI in the sandbox', async () => {
    const { spec: s } = spec([], { model: { provider: 'claude-code', model: 'sonnet' } });

    // The fake runtime has no `claude` binary: the CLI exits 127 without a result.
    expect(await runAgent(s)).toMatchObject({ kind: 'error', transient: true });
  });

  it('refuses tools without a sandbox', async () => {
    const { spec: s } = spec([{ toolCalls: [finish('x')] }]);
    const { sandbox: _omit, ...noSandbox } = s;

    expect(await runAgent(noSandbox)).toMatchObject({ kind: 'error', transient: false });
  });

  it('runs without a sandbox when no tools are requested', async () => {
    const { spec: s } = spec([{ toolCalls: [finish('plain')] }], { tools: [] });
    const { sandbox: _omit, ...noSandbox } = s;

    expect(await runAgent(noSandbox)).toEqual({ kind: 'ok', result: { summary: 'plain' } });
  });

  it('fires onUsage once per step with the usage buckets', async () => {
    const { spec: s, rec } = spec([
      {
        text: 'step one',
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 7 },
      },
      { toolCalls: [finish('ok')], usage: { input: 10, output: 2 } },
    ]);

    await runAgent(s);

    expect(rec.usage).toEqual([
      {
        step: 0,
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        reasoning: 7,
        webSearches: 0,
        providerMetadata: undefined,
      },
      {
        step: 1,
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        webSearches: 0,
        providerMetadata: undefined,
      },
    ]);
  });

  it('counts provider-executed web search results in onUsage', async () => {
    const { spec: s, rec } = spec(
      [
        { text: 'Researching.', webSearches: [{ query: 'hono sse' }, { query: 'vite 8' }] },
        { toolCalls: [finish('researched')] },
      ],
      { webSearch: true },
    );

    expect(await runAgent(s)).toEqual({ kind: 'ok', result: { summary: 'researched' } });
    expect(rec.usage.map((u) => u.webSearches)).toEqual([2, 0]);
    expect(rec.activity.some((l) => l.includes('hono sse'))).toBe(true);
  });

  it('aborts a hanging model call after stepTimeoutMs and returns a transient error', async () => {
    vi.useFakeTimers();
    const { spec: s } = spec([{ hang: true }, { toolCalls: [finish('x')] }], {
      limits: { maxSteps: 5, wallClockMs: 3_600_000, stepTimeoutMs: 1_000 },
    });

    const pending = runAgent(s);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result).toMatchObject({ kind: 'error', transient: true });
    expect(result.kind === 'error' && result.message).toMatch(/timed out/i);
  });

  it('aborts the in-flight call when wallClockMs elapses and returns an error', async () => {
    vi.useFakeTimers();
    const { spec: s } = spec([{ hang: true }], {
      limits: { maxSteps: 5, wallClockMs: 5_000 },
    });

    const pending = runAgent(s);
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await pending;
    expect(result).toMatchObject({ kind: 'error', transient: false });
    expect(result.kind === 'error' && result.message).toMatch(/time limit/i);
  });

  it('passes its abort signal into tool execution, cancelling a hanging run', async () => {
    vi.useFakeTimers();
    const signals: (AbortSignal | undefined)[] = [];
    const hanging: Sandbox = {
      name: sandbox.name,
      close: () => sandbox.close(),
      exec: (argv, o) => {
        signals.push(o.signal);
        // Runs until aborted; without the signal this call would never return.
        return new Promise((resolve, reject) => {
          o.signal?.addEventListener('abort', () => {
            sandbox.exec(argv, o).then(resolve, reject);
          });
        });
      },
    };
    const { spec: s } = spec(
      [{ toolCalls: [{ name: 'run', input: { command: 'sleep 3600' } }] }, { hang: true }],
      { sandbox: hanging, limits: { maxSteps: 5, wallClockMs: 5_000 } },
    );

    const pending = runAgent(s);
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await pending;
    expect(result).toMatchObject({ kind: 'error', transient: false });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('checks the wall clock between steps', async () => {
    const { spec: s, rec } = spec([{ text: 'slow step' }, { toolCalls: [finish('late')] }], {
      limits: { maxSteps: 5, wallClockMs: 5_000 },
      onUsage: (u) => {
        rec.usage.push(u);
        clock.advance(5_000);
      },
    });

    const result = await runAgent(s);

    expect(result).toMatchObject({ kind: 'error', transient: false });
    expect(rec.usage).toHaveLength(1);
  });
});

type Captured = { url: string; body: Record<string, unknown> };

/** A fetch stand-in that records each request body and answers with a streamed `finish` call. */
function recordingFetch(respond: () => Response) {
  const requests: Captured[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return Promise.resolve(respond());
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

function sse(chunks: unknown[], done = false): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  if (done) lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const FINISH_ARGS = JSON.stringify({ summary: 'searched' });

/** Anthropic Messages stream: one `finish` tool_use block. */
const anthropicFinish = () =>
  sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'finish', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: FINISH_ARGS },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);

/** OpenAI Responses stream: one `finish` function call. */
const openaiFinish = () => {
  const item = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'finish',
    arguments: FINISH_ARGS,
    status: 'completed',
  };
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_1', created_at: 1, model: 'gpt-5', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 0,
      delta: FINISH_ARGS,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        service_tier: null,
      },
    },
  ]);
};

/** Chat Completions stream (OpenRouter, openai-compatible): one `finish` tool call. */
const chatFinish = () =>
  sse(
    [
      {
        id: 'gen-1',
        created: 1,
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'finish', arguments: FINISH_ARGS },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'gen-1',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    true,
  );

const SECRETS: Record<string, string> = {
  [API_KEY_SECRETS.anthropic]: 'sk-ant-test',
  [API_KEY_SECRETS.openai]: 'sk-openai-test',
  [API_KEY_SECRETS.openrouter]: 'sk-or-test',
};

/** Runs a tool-less agent against `ref` with a recording fetch; returns the result and requests. */
async function runWithProvider(
  ref: ModelRef,
  respond: () => Response,
  webSearch: boolean | undefined,
) {
  const { fetch, requests } = recordingFetch(respond);
  const { spec: s } = spec([], {
    model: ref,
    tools: [],
    ...(webSearch === undefined ? {} : { webSearch }),
    modelDeps: {
      getSecret: (key) => SECRETS[key],
      providerConfig: { openaiCompatible: { baseURL: 'http://llm.local/v1' } },
      fetch,
    },
  });
  const { sandbox: _omit, ...noSandbox } = s;
  const result = await runAgent(noSandbox);
  return { result, requests };
}

/** The single model request of a one-step run. */
function only(requests: Captured[]): Captured {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error('no request captured');
  return request;
}

function toolList(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : [];
}

const isFunctionNamed = (name: string) => (t: Record<string, unknown>) =>
  t.name === name ||
  (typeof t.function === 'object' &&
    t.function !== null &&
    (t.function as Record<string, unknown>).name === name);

describe('runAgent provider web search', () => {
  const ok = { kind: 'ok', result: { summary: 'searched' } };
  const anthropicRef: ModelRef = { provider: 'anthropic', model: 'claude-sonnet-4-5' };

  it('anthropic + webSearch: sends the Anthropic web search tool', async () => {
    const { result, requests } = await runWithProvider(anthropicRef, anthropicFinish, true);

    expect(result).toEqual(ok);
    const tools = toolList(only(requests).body);
    expect(tools).toContainEqual(
      expect.objectContaining({ name: 'web_search', type: expect.stringMatching(/^web_search_/) }),
    );
    expect(tools.some(isFunctionNamed('finish'))).toBe(true);
  });

  it.each([false, undefined])('anthropic + webSearch %s: no web search tool', async (webSearch) => {
    const { result, requests } = await runWithProvider(anthropicRef, anthropicFinish, webSearch);

    expect(result).toEqual(ok);
    const tools = toolList(only(requests).body);
    expect(tools.some((t) => String(t.type).startsWith('web_search'))).toBe(false);
    expect(tools.some(isFunctionNamed('web_search'))).toBe(false);
    expect(tools.some(isFunctionNamed('finish'))).toBe(true);
  });

  it('openai + webSearch: sends the OpenAI web search tool', async () => {
    const { result, requests } = await runWithProvider(
      { provider: 'openai', model: 'gpt-5' },
      openaiFinish,
      true,
    );

    expect(result).toEqual(ok);
    expect(only(requests).url).toMatch(/\/responses$/);
    const tools = toolList(only(requests).body);
    expect(tools).toContainEqual(expect.objectContaining({ type: 'web_search' }));
    expect(tools.some(isFunctionNamed('finish'))).toBe(true);
  });

  it('openrouter + webSearch: uses the :online model and sends no web_search function', async () => {
    const { result, requests } = await runWithProvider(
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
      chatFinish,
      true,
    );

    expect(result).toEqual(ok);
    expect(only(requests).body.model).toBe('anthropic/claude-sonnet-4.5:online');
    const tools = toolList(only(requests).body);
    expect(tools.some(isFunctionNamed('web_search'))).toBe(false);
    expect(tools.some((t) => String(t.type).startsWith('web_search'))).toBe(false);
    expect(tools.some(isFunctionNamed('finish'))).toBe(true);
  });

  it('openrouter without webSearch: plain model id', async () => {
    const { requests } = await runWithProvider(
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
      chatFinish,
      false,
    );

    expect(only(requests).body.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('openai-compatible + webSearch: no search tool and the plain model id', async () => {
    const { result, requests } = await runWithProvider(
      { provider: 'openai-compatible', model: 'llama3.2' },
      chatFinish,
      true,
    );

    expect(result).toEqual(ok);
    expect(only(requests).url).toBe('http://llm.local/v1/chat/completions');
    expect(only(requests).body.model).toBe('llama3.2');
    const tools = toolList(only(requests).body);
    expect(tools.map((t) => (t.function as { name: string }).name)).toEqual(['finish']);
  });
});
