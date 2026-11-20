import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Event, EventOf } from '../../shared/events.ts';
import { AttemptIdSchema, IssueIdSchema, ProductIdSchema } from '../../shared/ids.ts';
import type { ModelRef } from '../../shared/models.ts';
import type { StepUsage } from '../agents/index.ts';
import { open, schema } from '../db/index.ts';
import { API_KEY_SECRETS, type FakeScript, type ModelDeps } from '../llm/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import {
  ACTIVITY_INTERVAL_MS,
  ActivityBatcher,
  agentLogPath,
  runRecordedAgent,
  SETTING_KEYS,
  usageCost,
  type RecordedAgentSpec,
  type RecordedRunContext,
  type SetTimer,
} from './index.ts';

const START = 1_700_000_000_000;
const P = ProductIdSchema.parse('product-1');
const SECRET = 'sk-test-secret-value-1234567890';
const FAKE: ModelRef = { provider: 'fake', model: 'fake' };
const ResultSchema = z.strictObject({ summary: z.string().min(1) });
type Result = z.infer<typeof ResultSchema>;

let logsDir: string;
let clock: FakeClock;

beforeEach(async () => {
  logsDir = path.join(await mkdtemp(path.join(tmpdir(), 'vibecode-recorded-')), 'logs');
  clock = new FakeClock(START);
});

afterEach(async () => {
  await rm(path.dirname(logsDir), { recursive: true, force: true });
});

/** A timer the test fires by hand. */
function manualTimers() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer: SetTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false };
    pending.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const fireAll = () => {
    for (const t of pending.splice(0)) if (!t.cancelled) t.fn();
  };
  return { setTimer, pending, fireAll };
}

function setup(opts: { settings?: Record<string, unknown> } = {}) {
  const redactor = new Redactor();
  redactor.register(SECRET);
  const store = createStore({ db: open(':memory:'), clock, redactor });
  store.commit((tx) => {
    for (const [key, value] of Object.entries(opts.settings ?? {})) {
      tx.db.insert(schema.settings).values({ key, value }).run();
    }
    return [
      {
        type: 'product.created',
        productId: P,
        entityId: null,
        v: 1,
        data: {
          name: 'Todo',
          idea: '',
          budgetUsd: null,
          maxParallel: 1,
          maxAttempts: 1,
          models: {},
          gitRemote: null,
        },
      },
    ];
  });
  const events: Event[] = [];
  store.subscribe((e) => events.push(e));
  const timers = manualTimers();
  const ctx: RecordedRunContext = {
    store,
    ids: new FakeIdGen(),
    clock,
    redactor,
    logsDir,
    setTimer: timers.setTimer,
  };
  return { store, ctx, events, timers };
}

function spec(
  script: FakeScript,
  over: Partial<RecordedAgentSpec<Result>> = {},
): RecordedAgentSpec<Result> {
  return {
    productId: P,
    role: 'implementer',
    model: FAKE,
    instructions: 'You are a test agent.',
    prompt: 'Do the task.',
    schema: ResultSchema,
    tools: [],
    limits: { maxSteps: 10, wallClockMs: 600_000 },
    shouldStop: () => false,
    modelDeps: { getSecret: () => undefined, fake: { script } },
    ...over,
  };
}

const finish = (summary: string) => ({ toolCalls: [{ name: 'finish', input: { summary } }] });
const USAGE = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const types = (events: Event[]) => events.map((e) => e.type);
const ofType = <T extends Event['type']>(events: Event[], type: T) =>
  events.filter((e): e is EventOf<T> => e.type === type);

describe('runRecordedAgent lifecycle', () => {
  it('records spawned, activity, usage and exited in order for a successful run', async () => {
    const { store, ctx, events } = setup();

    const run = await runRecordedAgent(
      ctx,
      spec([
        { text: 'Looking around.', usage: USAGE },
        { ...finish('done'), usage: USAGE },
      ]),
    );

    expect(run.result).toEqual({ kind: 'ok', result: { summary: 'done' } });
    expect(types(events)).toEqual([
      'agent.spawned',
      'agent.activity',
      'usage.recorded',
      'usage.recorded',
      'agent.exited',
    ]);
    expect(events.every((e) => e.entityId === run.agentId || e.type === 'usage.recorded')).toBe(
      true,
    );
    expect(events[0]?.data).toEqual({
      role: 'implementer',
      model: FAKE,
      issueId: null,
      attemptId: null,
    });
    expect(ofType(events, 'agent.exited')[0]?.data).toEqual({ outcome: 'ok' });
    expect(store.snapshot().state.agents[run.agentId]).toMatchObject({
      state: 'exited',
      lastActivity: 'text: Looking around.',
    });
    expectSnapshotMatchesReplay(store);
  });

  it('emits agent.exited with outcome error when the agent returns an error', async () => {
    const { store, ctx, events } = setup();

    const run = await runRecordedAgent(ctx, spec([{ error: { status: 503 } }]));

    expect(run.result).toMatchObject({ kind: 'error', transient: true });
    expect(types(events)).toEqual(['agent.spawned', 'agent.exited']);
    expect(ofType(events, 'agent.exited')[0]?.data).toEqual({ outcome: 'error' });
    expectSnapshotMatchesReplay(store);
  });

  it('emits agent.exited and rethrows when recording fails mid-run', async () => {
    const { store, ctx, events } = setup();
    const steps: number[] = [];
    ctx.afterUsage = (e) => {
      steps.push(e.seq);
      throw new Error('budget check failed');
    };

    await expect(
      runRecordedAgent(
        ctx,
        spec([{ text: 'one', usage: USAGE }, { text: 'two', usage: USAGE }, finish('x')]),
      ),
    ).rejects.toThrow('budget check failed');

    // The agent is stopped after the failing step, not driven on.
    expect(steps).toHaveLength(1);
    expect(types(events).at(0)).toBe('agent.spawned');
    expect(types(events).at(-1)).toBe('agent.exited');
    expect(ofType(events, 'agent.exited')[0]?.data).toEqual({ outcome: 'error' });
    expectSnapshotMatchesReplay(store);
  });

  it('marks the agent rate_limited with until before it exits', async () => {
    const { store, ctx, events } = setup();

    const run = await runRecordedAgent(
      ctx,
      spec([{ error: { status: 429, retryAfterSeconds: 30 } }]),
    );

    expect(run.result).toEqual({ kind: 'rate_limited', until: START + 30_000, backend: 'fake' });
    expect(types(events)).toEqual(['agent.spawned', 'agent.state', 'agent.exited']);
    expect(ofType(events, 'agent.state')[0]?.data).toEqual({
      state: 'rate_limited',
      until: START + 30_000,
    });
    expect(ofType(events, 'agent.exited')[0]?.data).toEqual({ outcome: 'rate_limited' });
    expectSnapshotMatchesReplay(store);
  });

  it('records issue and attempt links on the agent and its usage', async () => {
    const { store, ctx, events } = setup();
    const issueId = IssueIdSchema.parse('issue-1');
    const attemptId = AttemptIdSchema.parse('attempt-1');

    const run = await runRecordedAgent(
      ctx,
      spec([{ ...finish('ok'), usage: USAGE }], { issueId, attemptId }),
    );

    expect(ofType(events, 'agent.spawned')[0]?.data).toMatchObject({ issueId, attemptId });
    expect(ofType(events, 'usage.recorded')[0]?.data).toMatchObject({
      agentId: run.agentId,
      issueId,
      attemptId,
    });
    expect(store.q.issueUsage(issueId).apiUnpriced).toBe(false);
    expectSnapshotMatchesReplay(store);
  });
});

describe('runRecordedAgent log file', () => {
  it('writes every activity line, redacted, plus the exit line', async () => {
    const { ctx, events } = setup();

    const run = await runRecordedAgent(
      ctx,
      spec([{ text: `Using key ${SECRET} now.` }, { text: 'second line' }, finish('ok')]),
    );

    const raw = await readFile(agentLogPath(logsDir, run.agentId), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SECRET.slice(0, 12));
    const entries = raw
      .trim()
      .split('\n')
      .map((l) => z.object({ ts: z.number(), line: z.string() }).parse(JSON.parse(l)));
    expect(entries.map((e) => e.line)).toEqual([
      'text: Using key ***7890 now.',
      'text: second line',
      expect.stringMatching(/^tool finish /),
      'exited ok',
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe('agent.activity batching', () => {
  it('emits at most one agent.activity per 250 ms of clock time', async () => {
    const { store, ctx, events, timers } = setup();
    // Each step's usage moves the clock by 100 ms, so lines arrive at +0, +100, +200, ...
    ctx.afterUsage = () => clock.advance(100);
    const step = (n: number) => ({ text: `step ${String(n)}`, usage: USAGE });

    await runRecordedAgent(
      ctx,
      spec([step(1), step(2), step(3), step(4), step(5), step(6), { ...finish('ok') }]),
    );

    const activity = ofType(events, 'agent.activity');
    expect(activity.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < activity.length; i++) {
      const gap = (activity[i]?.ts ?? 0) - (activity[i - 1]?.ts ?? 0);
      expect(gap).toBeGreaterThanOrEqual(ACTIVITY_INTERVAL_MS);
    }
    expect(activity.map((e) => e.data.lines)).toEqual([
      ['text: step 1'],
      ['text: step 2', 'text: step 3', 'text: step 4'],
      ['text: step 5', 'text: step 6', expect.stringMatching(/^tool finish /)],
    ]);
    // Held lines were sent by the next line once the window had passed, never by the timer.
    timers.fireAll();
    expect(ofType(events, 'agent.activity')).toHaveLength(3);
    expectSnapshotMatchesReplay(store);
  });

  it('flushes held lines from the timer when no further line arrives', () => {
    const { setTimer, pending, fireAll } = manualTimers();
    const emitted: { at: number; lines: string[] }[] = [];
    const batcher = new ActivityBatcher({
      clock,
      setTimer,
      emit: (lines) => emitted.push({ at: clock.now() - START, lines }),
    });

    batcher.push('a');
    clock.advance(50);
    batcher.push('b');
    batcher.push('c');
    expect(emitted).toEqual([{ at: 0, lines: ['a'] }]);
    expect(pending.map((t) => t.ms)).toEqual([200]);

    // A timer firing early (wall time ahead of the clock) re-arms instead of emitting.
    clock.advance(100);
    fireAll();
    expect(emitted).toHaveLength(1);
    expect(pending.map((t) => t.ms)).toEqual([100]);

    clock.advance(100);
    fireAll();
    expect(emitted).toEqual([
      { at: 0, lines: ['a'] },
      { at: 250, lines: ['b', 'c'] },
    ]);
  });

  it('keeps only the last lines in one event and drops held lines at close inside the window', () => {
    const { setTimer, pending } = manualTimers();
    const emitted: string[][] = [];
    const batcher = new ActivityBatcher({ clock, setTimer, emit: (l) => emitted.push(l) });

    batcher.push('first');
    for (let i = 1; i <= 8; i++) batcher.push(`line ${String(i)}`);
    batcher.close();
    expect(emitted).toEqual([['first']]);
    expect(pending.every((t) => t.cancelled)).toBe(true);

    const later = new ActivityBatcher({ clock, setTimer, emit: (l) => emitted.push(l) });
    later.push('x');
    clock.advance(10);
    for (let i = 1; i <= 8; i++) later.push(`line ${String(i)}`);
    clock.advance(ACTIVITY_INTERVAL_MS);
    later.close();
    expect(emitted.at(-1)).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
  });
});

describe('usage.recorded pricing', () => {
  const base = { id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'm' };

  /** An OpenRouter stand-in answering one streamed `finish` call with the given usage. */
  function openRouterDeps(usage: Record<string, number>): ModelDeps {
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'finish', arguments: '{"summary":"ok"}' },
                },
              ],
            },
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { ...base, choices: [], usage },
    ];
    const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
    const fetch = (async () =>
      new Response(body.join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch;
    return { getSecret: (k) => (k === API_KEY_SECRETS.openrouter ? SECRET : undefined), fetch };
  }

  async function recordedUsage(model: ModelRef, usage: Record<string, number>) {
    const { store, ctx, events } = setup();
    const run = await runRecordedAgent(ctx, spec([], { model, modelDeps: openRouterDeps(usage) }));
    expect(run.result.kind).toBe('ok');
    expectSnapshotMatchesReplay(store);
    return { rows: ofType(events, 'usage.recorded'), store };
  }

  const TOKENS = { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000 };

  it('prices a known model from the price table', async () => {
    // prices.json: openrouter anthropic/claude-haiku-4.5 = $1 in / $5 out per 1M tokens.
    const { rows, store } = await recordedUsage(
      { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
      TOKENS,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      billing: 'api',
      calls: 1,
      unpriced: false,
      source: 'computed',
      tokens: { input: 1_000_000, output: 100_000 },
    });
    expect(rows[0]?.data.costUsd).toBeCloseTo(1.5, 10);
    expect(store.q.productUsage(P).apiUsd).toBeCloseTo(1.5, 10);
  });

  it('records an unknown model as unpriced, not $0', async () => {
    const { rows, store } = await recordedUsage(
      { provider: 'openrouter', model: 'nobody/unknown-model' },
      TOKENS,
    );

    expect(rows[0]?.data).toMatchObject({ billing: 'api', costUsd: null, unpriced: true });
    expect(store.q.productUsage(P)).toMatchObject({ apiUsd: 0, apiUnpriced: true });
  });

  it('prefers the provider-reported cost over the price table', async () => {
    const { rows } = await recordedUsage(
      { provider: 'openrouter', model: 'nobody/unknown-model' },
      { ...TOKENS, cost: 0.0123 },
    );

    expect(rows[0]?.data).toMatchObject({
      costUsd: 0.0123,
      unpriced: false,
      source: 'provider',
    });
  });

  it('persists web searches and prices them with a per-search price from settings', async () => {
    const { store, ctx, events } = setup({
      settings: {
        [SETTING_KEYS.priceOverrides]: { 'fake/fake': { input: 2, output: 10, webSearch: 0.01 } },
      },
    });

    await runRecordedAgent(
      ctx,
      spec([
        { webSearches: [{ query: 'a' }, { query: 'b' }], usage: USAGE },
        { ...finish('ok'), usage: USAGE },
      ]),
    );

    const rows = ofType(events, 'usage.recorded');
    expect(rows.map((r) => r.data.webSearches)).toEqual([2, 0]);
    // 1000 in × $2/M + 200 out × $10/M = $0.004 per step, + 2 × $0.01 for searches.
    expect(rows[0]?.data.costUsd).toBeCloseTo(0.024, 10);
    expect(rows[1]?.data.costUsd).toBeCloseTo(0.004, 10);
    expectSnapshotMatchesReplay(store);
  });

  it('leaves searches unpriced when the price has no per-search price', async () => {
    const { ctx, events } = setup({
      settings: { [SETTING_KEYS.priceOverrides]: { 'fake/fake': { input: 2, output: 10 } } },
    });

    await runRecordedAgent(
      ctx,
      spec([{ webSearches: [{ query: 'a' }], usage: USAGE }, finish('ok')]),
    );

    expect(ofType(events, 'usage.recorded')[0]?.data).toMatchObject({
      webSearches: 1,
      costUsd: null,
      unpriced: true,
    });
  });
});

describe('usageCost', () => {
  const step: StepUsage = {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    webSearches: 0,
    step: 1,
    providerMetadata: undefined,
  };

  it('bills claude-code as subscription: no spend, tokens and calls, estimate only', () => {
    const cost = usageCost({ provider: 'claude-code', model: 'sonnet' }, step, {
      'claude-code/sonnet': { input: 3, output: 15 },
    });

    expect(cost).toEqual({
      billing: 'subscription',
      tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      webSearches: 0,
      calls: 1,
      costUsd: null,
      unpriced: false,
      estCostUsd: 3,
      source: 'cli',
    });
    expect(usageCost({ provider: 'claude-code', model: 'sonnet' }, step, {}).estCostUsd).toBeNull();
  });
});
