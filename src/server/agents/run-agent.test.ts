import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { FakeScript } from '../llm/index.ts';
import { FakeContainerRuntime, type Sandbox } from '../sandbox/index.ts';
import { FakeClock } from '../util/clock.ts';
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

  it('reports the Claude Code backend as not available yet', async () => {
    const { spec: s } = spec([], { model: { provider: 'claude-code', model: 'sonnet' } });

    expect(await runAgent(s)).toEqual({
      kind: 'error',
      message: 'Claude Code backend not available yet',
      transient: false,
    });
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
