import { describe, expect, it, vi } from 'vitest';
import type { PlanResult } from '../../shared/agent-results.ts';
import type { Event, EventDraft } from '../../shared/events.ts';
import { ProductIdSchema, type IssueId, type ProductId } from '../../shared/ids.ts';
import { applyPlan, cancelIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { Redactor, redactor as sharedRedactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { createScheduler, type RunHandle, type Runners, type Timer } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const P2 = ProductIdSchema.parse('product-2');

const draft = (type: string, productId: ProductId | null, entityId: string | null, data: object) =>
  ({ type, productId, entityId, v: 1, data }) as EventDraft;

type Deferred = { resolve(): void; reject(err: unknown): void };
type Call =
  | ({ kind: 'orchestrator'; productId: ProductId; triggers: Event[]; run: RunHandle } & Deferred)
  | ({ kind: 'attempt'; issueId: IssueId; run: RunHandle } & Deferred);

/** Runners that never finish until the test resolves them. */
function fakeRunners() {
  const calls: Call[] = [];
  const runners: Runners = {
    runOrchestrator: (productId, triggers, run) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ kind: 'orchestrator', productId, triggers, run, resolve, reject });
      }),
    runAttempt: (issueId, run) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ kind: 'attempt', issueId, run, resolve, reject });
      }),
  };
  const attempts = () => calls.filter((c) => c.kind === 'attempt');
  const orchestrators = () => calls.filter((c) => c.kind === 'orchestrator');
  return { calls, runners, attempts, orchestrators };
}

/** `xs[i]`, failing the test when it is missing. */
function nth<T>(xs: readonly T[], i: number): T {
  const x = xs.at(i);
  if (x === undefined) throw new Error(`no element at ${String(i)}`);
  return x;
}

/** The id created for `key`. */
function idOf(ids: Record<string, IssueId>, key: string): IssueId {
  const id = ids[key];
  if (id === undefined) throw new Error(`no issue for key ${key}`);
  return id;
}

class FakeTimer implements Timer {
  fns = new Set<() => void>();
  setInterval(fn: () => void): unknown {
    this.fns.add(fn);
    return fn;
  }
  clearInterval(h: unknown): void {
    this.fns.delete(h as () => void);
  }
  fire(): void {
    for (const fn of this.fns) fn();
  }
}

/** Let promise callbacks (runner settle → kick) run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

function createProduct(
  store: Store,
  p: ProductId,
  opts: {
    maxParallel?: number;
    budgetUsd?: number | null;
    handOff?: boolean;
    models?: Record<string, { provider: string; model: string }>;
  } = {},
) {
  store.commit(() => [
    draft('product.created', p, null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: opts.budgetUsd ?? null,
      maxParallel: opts.maxParallel ?? 3,
      maxAttempts: 2,
      models: opts.models ?? {},
      gitRemote: null,
    }),
    draft('prd.applied', p, null, { version: 1, markdown: '# v1', summary: null }),
    ...(opts.handOff === false ? [] : [draft('product.handed_off', p, null, { prdVersion: 1 })]),
  ]);
}

const create = (key: string, dependsOn: string[] = [], priority?: number) => ({
  op: 'create' as const,
  key,
  title: `Title ${key}`,
  body: `Body ${key}`,
  dependsOn,
  ...(priority === undefined ? {} : { priority }),
});

function setup(
  productOpts: Parameters<typeof createProduct>[2] = {},
  extra: Partial<Parameters<typeof createScheduler>[0]> = {},
) {
  const db = open(':memory:');
  const clock = new FakeClock();
  const store = createStore({ db, clock, redactor: new Redactor() });
  const ids = new FakeIdGen();
  createProduct(store, P, productOpts);
  const fake = fakeRunners();
  const timer = new FakeTimer();
  const scheduler = createScheduler({
    store,
    clock,
    runners: fake.runners,
    ids,
    timer,
    isBackendBlocked: () => false,
    ...extra,
  });

  /** Applies a plan (consuming all triggers so far, so no orchestrator wakes) → ids by key. */
  function plan(ops: PlanResult['issueOps'], productId = P): Record<string, IssueId> {
    const r = applyPlan(
      { store, ids },
      productId,
      { issueOps: ops, questions: [], summary: 's' },
      store.snapshot().lastSeq,
    );
    if (!r.ok) throw new Error(r.reason);
    return r.createdIds;
  }

  function complete(id: IssueId, productId = P) {
    store.commit(() => [
      draft('issue.status_changed', productId, id, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.status_changed', productId, id, {
        from: 'in_progress',
        to: 'in_review',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.completed', productId, id, {
        attemptId: 'attempt-x',
        mergedOrder: 1,
        mergeSha: 'c'.repeat(40),
      }),
    ]);
  }

  /** Resolves every outstanding fake run, then stops the scheduler. */
  async function shutdown() {
    const stopped = scheduler.stop();
    for (const c of fake.calls) c.resolve();
    await stopped;
  }

  return { store, clock, ids, scheduler, timer, plan, complete, shutdown, ...fake };
}

describe('scheduler: attempts', () => {
  it('starts at most maxParallel (default 3) attempts and fills a freed slot on the next tick', async () => {
    const t = setup();
    t.plan(['a', 'b', 'c', 'd', 'e'].map((k) => create(k)));
    t.scheduler.start();
    expect(t.attempts()).toHaveLength(3);
    expect(t.scheduler.liveRuns().size).toBe(3);

    t.timer.fire();
    t.scheduler.kick();
    expect(t.attempts()).toHaveLength(3); // live issues are not started twice

    nth(t.attempts(), 0).resolve();
    await flush();
    t.timer.fire();
    expect(t.attempts()).toHaveLength(4);
    expect(t.scheduler.liveRuns().size).toBe(3);
    await t.shutdown();
  });

  it('respects a product maxParallel of 1', () => {
    const t = setup({ maxParallel: 1 });
    t.plan([create('a'), create('b')]);
    t.scheduler.start();
    expect(t.attempts()).toHaveLength(1);
  });

  it('starts ready issues by priority (higher first) then number', async () => {
    const t = setup({ maxParallel: 1 });
    const ids = t.plan([
      create('low', [], -1),
      create('normal1', [], 0),
      create('urgent', [], 3),
      create('normal2', [], 0),
      create('high', [], 1),
    ]);
    t.scheduler.start();
    const order: IssueId[] = [];
    for (let i = 0; i < 5; i++) {
      const last = nth(t.attempts(), -1);
      if (last.kind !== 'attempt') throw new Error('expected attempt');
      order.push(last.issueId);
      last.resolve();
      await flush();
      t.complete(last.issueId); // the run's end events tick the scheduler
    }
    expect(order).toEqual([ids.urgent, ids.high, ids.normal1, ids.normal2, ids.low]);
  });

  it('starts an issue only after its dependencies are completed', async () => {
    const t = setup();
    const ids = t.plan([create('a'), create('b', ['a']), create('c', ['b'])]);
    t.scheduler.start();
    const started = () => t.attempts().map((c) => (c.kind === 'attempt' ? c.issueId : null));
    expect(started()).toEqual([ids.a]);

    nth(t.attempts(), 0).resolve();
    await flush();
    expect(started()).toEqual([ids.a]);
    t.complete(idOf(ids, 'a'));
    expect(started()).toEqual([ids.a, ids.b]);
    await t.shutdown();
  });

  it('ticks on the interval timer, so an issue starts once its runAfter passes', () => {
    const t = setup();
    const ids = t.plan([create('a')]);
    const runAfter = t.clock.now() + 10_000;
    t.store.commit(() => [
      draft('issue.status_changed', P, idOf(ids, 'a'), {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.status_changed', P, idOf(ids, 'a'), {
        from: 'in_progress',
        to: 'open',
        attemptCount: 0,
        runAfter,
      }),
    ]);
    t.scheduler.start();
    expect(t.attempts()).toHaveLength(0);
    t.clock.advance(10_000);
    expect(t.attempts()).toHaveLength(0); // no event, no tick yet
    t.timer.fire();
    expect(t.attempts()).toHaveLength(1);
  });

  it('starts runs when new issues arrive over the bus', () => {
    const t = setup();
    t.plan([]);
    t.scheduler.start();
    expect(t.calls).toHaveLength(0);
    t.plan([create('a')]);
    expect(t.attempts()).toHaveLength(1);
  });

  it('does not start attempts while the implementer backend is blocked', () => {
    const t = setup({}, { isBackendBlocked: (_p, role) => role === 'implementer' });
    t.plan([create('a')]);
    t.scheduler.start();
    expect(t.calls).toHaveLength(0);
  });
});

describe('scheduler: gating', () => {
  it('a paused product starts nothing', () => {
    const t = setup();
    t.store.commit(() => [draft('product.paused', P, null, { reason: 'owner' })]);
    t.plan([create('a')]);
    t.store.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    t.scheduler.start();
    t.timer.fire();
    expect(t.calls).toHaveLength(0);
  });

  it('a budget-exhausted product starts nothing', () => {
    const t = setup({ budgetUsd: 0 });
    t.plan([create('a')]);
    t.store.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    t.scheduler.start();
    expect(t.calls).toHaveLength(0);
  });

  it('a product still sparring starts nothing', () => {
    const t = setup({ handOff: false });
    t.scheduler.start();
    expect(t.calls).toHaveLength(0);
  });

  it('shouldStop flips when the product is paused and back when resumed', async () => {
    const t = setup();
    t.plan([create('a')]);
    t.scheduler.start();
    const run = nth(t.attempts(), 0).run;
    expect(run.shouldStop()).toBe(false);
    expect(t.scheduler.shouldStop(run.runId)).toBe(false);

    t.store.commit(() => [draft('product.paused', P, null, { reason: 'owner' })]);
    expect(run.shouldStop()).toBe(true);
    expect(t.scheduler.shouldStop(run.runId)).toBe(true);

    t.store.commit(() => [draft('product.resumed', P, null, {})]);
    expect(run.shouldStop()).toBe(false);
    await t.shutdown();
  });

  it('shouldStop is true when the budget becomes exhausted', () => {
    const t = setup({ budgetUsd: 1 });
    t.plan([create('a')]);
    t.scheduler.start();
    const run = nth(t.attempts(), 0).run;
    expect(run.shouldStop()).toBe(false);
    t.store.commit(() => [
      draft('usage.recorded', P, 'usage-1', {
        agentId: 'agent-1',
        role: 'implementer',
        model: { provider: 'anthropic', model: 'm' },
        issueId: null,
        attemptId: null,
        billing: 'api',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        webSearches: 0,
        calls: 1,
        costUsd: 2,
        unpriced: false,
        estCostUsd: null,
        source: 'computed',
      }),
    ]);
    expect(run.shouldStop()).toBe(true);
  });

  it('stop() aborts live runs, makes shouldStop true and awaits them', async () => {
    const t = setup();
    t.plan([create('a'), create('b')]);
    t.scheduler.start();
    const a = nth(t.attempts(), 0);
    const b = nth(t.attempts(), 1);
    let stopped = false;
    const stopping = t.scheduler.stop().then(() => {
      stopped = true;
    });
    expect(a.run.signal.aborted).toBe(true);
    expect(a.run.shouldStop()).toBe(true);
    await flush();
    expect(stopped).toBe(false);
    a.resolve();
    b.reject(new Error('boom'));
    await stopping;
    expect(t.scheduler.liveRuns().size).toBe(0);
    // Nothing new starts after stop.
    t.plan([create('c')]);
    expect(t.attempts()).toHaveLength(2);
  });

  it('an unknown run id should stop', () => {
    const t = setup();
    expect(t.scheduler.shouldStop('run-nope' as never)).toBe(true);
  });
});

describe('scheduler: orchestrator', () => {
  it('starts one orchestrator for pending triggers and never a second while it is live', async () => {
    const t = setup();
    t.scheduler.start();
    expect(t.orchestrators()).toHaveLength(1);
    const o = nth(t.orchestrators(), 0);
    if (o.kind !== 'orchestrator') throw new Error('expected orchestrator');
    expect(o.productId).toBe(P);
    expect(o.triggers.map((e) => e.type)).toEqual(['prd.applied', 'product.handed_off']);

    t.store.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    t.timer.fire();
    expect(t.orchestrators()).toHaveLength(1);

    // It ends without consuming the triggers → the next tick starts a fresh one.
    o.resolve();
    await flush();
    t.timer.fire();
    expect(t.orchestrators()).toHaveLength(2);
    await t.shutdown();
  });

  it('does not restart once the cursor consumed the triggers', async () => {
    const t = setup();
    t.scheduler.start();
    const o = nth(t.orchestrators(), 0);
    t.plan([]); // advances the cursor past every trigger
    o.resolve();
    await flush();
    t.timer.fire();
    expect(t.orchestrators()).toHaveLength(1);
  });

  it('counts the orchestrator against maxParallel', () => {
    const t = setup({ maxParallel: 2 });
    t.plan([create('a'), create('b'), create('c')]);
    t.store.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    t.scheduler.start();
    expect(t.orchestrators()).toHaveLength(1);
    expect(t.attempts()).toHaveLength(1);
    expect(t.scheduler.liveRuns().size).toBe(2);
  });

  it('honours orchestratorNotBefore backoff', () => {
    const t0 = 1_700_000_000_000;
    const t = setup({}, { orchestratorNotBefore: () => t0 + 5_000 });
    t.scheduler.start();
    expect(t.orchestrators()).toHaveLength(0);
    t.clock.advance(5_000);
    t.timer.fire();
    expect(t.orchestrators()).toHaveLength(1);
  });

  it('skips the orchestrator while its backend is blocked', () => {
    const t = setup({}, { isBackendBlocked: (_p, role) => role === 'orchestrator' });
    t.scheduler.start();
    expect(t.orchestrators()).toHaveLength(0);
  });

  it('owner-cancelling an issue that others wait on wakes the orchestrator (stranded dependents)', () => {
    const t = setup();
    const ids = t.plan([create('a'), create('b', ['a']), create('c')]);
    t.scheduler.start();
    expect(t.orchestrators()).toHaveLength(0);

    const r = cancelIssue({ store: t.store, ids: t.ids }, idOf(ids, 'a'));
    expect(r.ok).toBe(true);
    // No timer tick: the issue.cancelled event itself wakes the scheduler.
    expect(t.orchestrators()).toHaveLength(1);
    const o = nth(t.orchestrators(), 0);
    if (o.kind !== 'orchestrator') throw new Error('expected orchestrator');
    expect(o.triggers).toMatchObject([
      { type: 'issue.cancelled', entityId: idOf(ids, 'a'), data: { stranded: [idOf(ids, 'b')] } },
    ]);
  });

  it('owner-cancelling an issue nothing waits on does not wake the orchestrator', () => {
    const t = setup();
    const ids = t.plan([create('a'), create('b', ['a']), create('c')]);
    t.scheduler.start();
    expect(cancelIssue({ store: t.store, ids: t.ids }, idOf(ids, 'c')).ok).toBe(true);
    t.timer.fire();
    expect(t.orchestrators()).toHaveLength(0);
  });

  it('runs one orchestrator per product independently', () => {
    const t = setup();
    createProduct(t.store, P2);
    t.scheduler.start();
    expect(
      t
        .orchestrators()
        .map((c) => (c.kind === 'orchestrator' ? c.productId : null))
        .sort(),
    ).toEqual([P, P2]);
  });
});

describe('scheduler: default backend check (backend_limits)', () => {
  it('blocks a role whose configured provider is rate-limited until the limit passes', () => {
    const db = open(':memory:');
    const clock = new FakeClock();
    const store = createStore({ db, clock, redactor: new Redactor() });
    store.commit(() => [
      draft('product.created', P, null, {
        name: 'Todo',
        idea: 'todos',
        budgetUsd: null,
        maxParallel: 3,
        maxAttempts: 2,
        models: { orchestrator: { provider: 'claude-code', model: 'opus' } },
        gitRemote: null,
      }),
      draft('prd.applied', P, null, { version: 1, markdown: '# v1', summary: null }),
      draft('product.handed_off', P, null, { prdVersion: 1 }),
      draft('backend.limited', null, null, {
        backend: 'claude-code',
        until: clock.now() + 1_000,
        needsLogin: false,
        reason: 'rate limit',
      }),
    ]);
    const fake = fakeRunners();
    const timer = new FakeTimer();
    const scheduler = createScheduler({ store, clock, runners: fake.runners, timer });
    scheduler.start();
    expect(fake.orchestrators()).toHaveLength(0);
    clock.advance(1_000);
    timer.fire();
    expect(fake.orchestrators()).toHaveLength(1);
  });
});

describe('withMergeLock', () => {
  it('serialises concurrent callers per product, in call order, and survives a throwing holder', async () => {
    const t = setup();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = t.scheduler.withMergeLock(P, async () => {
      log.push('1 start');
      await new Promise<void>((r) => (releaseFirst = r));
      log.push('1 end');
      return 1;
    });
    const second = t.scheduler.withMergeLock(P, async () => {
      log.push('2 start');
      await Promise.resolve();
      throw new Error('merge failed');
    });
    const third = t.scheduler.withMergeLock(P, () => {
      log.push('3 start');
      return Promise.resolve(3);
    });
    const other = t.scheduler.withMergeLock(P2, () => {
      log.push('other');
      return Promise.resolve('x');
    });
    await flush();
    expect(log).toEqual(['1 start', 'other']);
    releaseFirst();
    expect(await first).toBe(1);
    await expect(second).rejects.toThrow('merge failed');
    expect(await third).toBe(3);
    expect(await other).toBe('x');
    expect(log).toEqual(['1 start', 'other', '1 end', '2 start', '3 start']);
  });
});

describe('scheduler: clearing backend limits', () => {
  const CLAUDE = { provider: 'claude-code', model: 'sonnet' } as const;

  /** A building product whose implementer runs on Claude Code, with the default backend check. */
  function limited(limit: { until: number | null; needsLogin: boolean }) {
    const db = open(':memory:');
    const clock = new FakeClock();
    const store = createStore({ db, clock, redactor: new Redactor() });
    const ids = new FakeIdGen();
    createProduct(store, P, { models: { implementer: CLAUDE } });
    const r = applyPlan(
      { store, ids },
      P,
      { issueOps: [create('a')], questions: [], summary: 's' },
      store.snapshot().lastSeq,
    );
    if (!r.ok) throw new Error(r.reason);
    store.commit(() => [
      draft('backend.limited', null, null, { backend: 'claude-code', reason: 'limit', ...limit }),
    ]);
    const fake = fakeRunners();
    const timer = new FakeTimer();
    const scheduler = createScheduler({ store, clock, runners: fake.runners, ids, timer });
    const cleared = () => store.eventsSince(0).filter((e) => e.type === 'backend.cleared');
    return { store, clock, timer, scheduler, cleared, ...fake };
  }

  it('commits backend.cleared once `until` has passed, then starts the next attempt', () => {
    const t = limited({ until: new FakeClock().now() + 60_000, needsLogin: false });
    t.scheduler.start();
    expect(t.attempts()).toHaveLength(0);
    expect(t.cleared()).toHaveLength(0);

    t.clock.advance(59_999);
    t.timer.fire();
    expect(t.cleared()).toHaveLength(0);
    expect(t.attempts()).toHaveLength(0);

    t.clock.advance(1);
    t.timer.fire();
    expect(t.cleared().map((e) => e.data)).toEqual([{ backend: 'claude-code' }]);
    expect(t.store.q.backendLimit('claude-code')).toBeNull();
    expect(t.attempts()).toHaveLength(1);

    t.timer.fire();
    t.scheduler.kick();
    expect(t.cleared()).toHaveLength(1);
  });

  it('does not clear needs_login on its own: it waits for the owner', () => {
    const t = limited({ until: null, needsLogin: true });
    t.scheduler.start();
    t.clock.advance(24 * 60 * 60_000);
    t.timer.fire();
    expect(t.cleared()).toHaveLength(0);
    expect(t.store.q.backendLimit('claude-code')).toMatchObject({ needsLogin: true });
    expect(t.attempts()).toHaveLength(0);
  });
});

describe('scheduler: tick robustness', () => {
  /** A store whose snapshot()/eventsSince() calls are counted and can be made to fail. */
  function instrumented() {
    const db = open(':memory:');
    const clock = new FakeClock();
    const subscriberErrors: unknown[] = [];
    const inner = createStore({
      db,
      clock,
      redactor: new Redactor(),
      onSubscriberError: (err) => subscriberErrors.push(err),
    });
    const spy = { snapshots: 0, failNext: 0, cursors: [] as number[] };
    const store: Store = {
      ...inner,
      snapshot() {
        spy.snapshots += 1;
        if (spy.failNext > 0) {
          spy.failNext -= 1;
          throw new Error('disk I/O error');
        }
        return inner.snapshot();
      },
      eventsSince(seq, limit) {
        spy.cursors.push(seq);
        return inner.eventsSince(seq, limit);
      },
    };
    const ids = new FakeIdGen();
    const fake = fakeRunners();
    const timer = new FakeTimer();
    const tickErrors: unknown[] = [];
    const scheduler = createScheduler({
      store,
      clock,
      runners: fake.runners,
      ids,
      timer,
      isBackendBlocked: () => false,
      onTickError: (err) => tickErrors.push(err),
    });
    function plan(ops: PlanResult['issueOps'], productId = P): Record<string, IssueId> {
      const r = applyPlan(
        { store: inner, ids },
        productId,
        { issueOps: ops, questions: [], summary: 's' },
        inner.snapshot().lastSeq,
      );
      if (!r.ok) throw new Error(r.reason);
      return r.createdIds;
    }
    return { inner, store, spy, scheduler, timer, plan, tickErrors, subscriberErrors, ...fake };
  }

  it('one committed batch of N events triggers at most 2 ticks, not N', () => {
    const t = instrumented();
    createProduct(t.inner, P, { maxParallel: 1 });
    t.plan([]);
    t.scheduler.start();
    t.spy.snapshots = 0;
    const before = t.inner.snapshot().lastSeq;
    t.plan(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => create(k)));
    const committed = t.inner.snapshot().lastSeq - before;
    expect(committed).toBeGreaterThanOrEqual(6);
    expect(t.spy.snapshots).toBeLessThanOrEqual(2);
    expect(t.attempts()).toHaveLength(1);
  });

  it('a paused product with an older cursor does not lower the eventsSince cursor', () => {
    const t = instrumented();
    createProduct(t.inner, P2);
    t.inner.commit(() => [draft('product.paused', P2, null, { reason: 'owner' })]);
    createProduct(t.inner, P);
    t.plan([], P);
    t.inner.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    const cursor = t.inner.q.product(P)?.orchestratorCursor ?? -1;
    expect(t.inner.q.product(P2)?.orchestratorCursor).toBeLessThan(cursor);

    t.scheduler.start();
    expect(t.spy.cursors.length).toBeGreaterThan(0);
    expect(Math.min(...t.spy.cursors)).toBe(cursor);
    const o = nth(t.orchestrators(), 0);
    if (o.kind !== 'orchestrator') throw new Error('expected orchestrator');
    expect(o.productId).toBe(P);
    expect(o.triggers.map((e) => e.type)).toEqual(['prd.applied']);
  });

  it('a failing snapshot neither throws from commit() nor from the interval; the next tick runs', () => {
    const t = instrumented();
    createProduct(t.inner, P);
    t.plan([]);
    t.scheduler.start();

    t.spy.failNext = 1;
    expect(() =>
      t.inner.commit(() => [draft('product.paused', P, null, { reason: 'owner' })]),
    ).not.toThrow();
    expect(t.subscriberErrors).toEqual([]);
    expect(t.tickErrors).toHaveLength(1);

    t.spy.failNext = 1;
    expect(() => t.timer.fire()).not.toThrow();
    expect(t.tickErrors).toHaveLength(2);

    t.inner.commit(() => [draft('product.resumed', P, null, {})]);
    t.plan([create('a')]);
    expect(t.attempts()).toHaveLength(1);
    expect(t.tickErrors).toHaveLength(2);
  });
});

describe('scheduler: tick robustness (logging and ineligible products)', () => {
  it('logs a failed tick through the shared redactor by default', () => {
    const secret = 'sk-test-SECRET-value-1234567890';
    sharedRedactor.register(secret);
    const db = open(':memory:');
    const clock = new FakeClock();
    const inner = createStore({ db, clock, redactor: new Redactor() });
    createProduct(inner, P);
    const store: Store = {
      ...inner,
      snapshot() {
        throw new Error(`db fault with ${secret}`);
      },
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const scheduler = createScheduler({
        store,
        clock,
        runners: fakeRunners().runners,
        timer: new FakeTimer(),
        isBackendBlocked: () => false,
      });
      scheduler.start();
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('scheduler tick failed');
    expect(lines[0]).not.toContain(secret);
  });

  /** A paused building product whose only issue is completed; optionally a pending trigger. */
  function pausedAllDone(withTrigger: boolean) {
    const db = open(':memory:');
    const clock = new FakeClock();
    const inner = createStore({ db, clock, redactor: new Redactor() });
    const cursors: number[] = [];
    const store: Store = {
      ...inner,
      eventsSince(seq, limit) {
        cursors.push(seq);
        return inner.eventsSince(seq, limit);
      },
    };
    const ids = new FakeIdGen();
    createProduct(inner, P);
    const r = applyPlan(
      { store: inner, ids },
      P,
      { issueOps: [create('a')], questions: [], summary: 's' },
      inner.snapshot().lastSeq,
    );
    if (!r.ok) throw new Error(r.reason);
    const a = idOf(r.createdIds, 'a');
    inner.commit(() => [
      draft('issue.status_changed', P, a, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.status_changed', P, a, {
        from: 'in_progress',
        to: 'in_review',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.completed', P, a, {
        attemptId: 'attempt-x',
        mergedOrder: 1,
        mergeSha: 'c'.repeat(40),
      }),
      draft('product.paused', P, null, { reason: 'owner' }),
      ...(withTrigger
        ? [draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null })]
        : []),
    ]);
    const timer = new FakeTimer();
    const scheduler = createScheduler({
      store,
      clock,
      runners: fakeRunners().runners,
      ids,
      timer,
      isBackendBlocked: () => false,
    });
    return { inner, cursors, timer, scheduler };
  }

  it('a paused product with all issues done and pending triggers reads its backlog at most once', () => {
    const t = pausedAllDone(true);
    t.scheduler.start();
    t.timer.fire();
    t.timer.fire();
    expect(t.cursors.length).toBeLessThanOrEqual(1);
    expect(t.inner.q.product(P)?.phase).toBe('building');
  });

  it('a paused product with all issues done and nothing pending still completes (paused or not)', () => {
    const t = pausedAllDone(false);
    t.scheduler.start();
    t.timer.fire();
    t.timer.fire();
    expect(t.inner.q.product(P)?.phase).toBe('complete');
  });

  it('a backed-off product with all issues done re-reads its backlog only when something changed', () => {
    const db = open(':memory:');
    const clock = new FakeClock();
    const inner = createStore({ db, clock, redactor: new Redactor() });
    const cursors: number[] = [];
    const store: Store = {
      ...inner,
      eventsSince(seq, limit) {
        cursors.push(seq);
        return inner.eventsSince(seq, limit);
      },
    };
    const ids = new FakeIdGen();
    createProduct(inner, P);
    const r = applyPlan(
      { store: inner, ids },
      P,
      { issueOps: [create('a')], questions: [], summary: 's' },
      inner.snapshot().lastSeq,
    );
    if (!r.ok) throw new Error(r.reason);
    const a = idOf(r.createdIds, 'a');
    inner.commit(() => [
      draft('issue.status_changed', P, a, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.status_changed', P, a, {
        from: 'in_progress',
        to: 'in_review',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('issue.completed', P, a, {
        attemptId: 'attempt-x',
        mergedOrder: 1,
        mergeSha: 'c'.repeat(40),
      }),
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    const timer = new FakeTimer();
    const fake = fakeRunners();
    const scheduler = createScheduler({
      store,
      clock,
      runners: fake.runners,
      ids,
      timer,
      isBackendBlocked: () => false,
      orchestratorNotBefore: () => Number.MAX_SAFE_INTEGER,
    });
    scheduler.start();
    expect(cursors).toHaveLength(1);
    timer.fire();
    timer.fire();
    expect(cursors).toHaveLength(1); // nothing changed: the cached result is reused
    expect(inner.q.product(P)?.phase).toBe('building'); // the prd.applied trigger is pending
    expect(fake.orchestrators()).toHaveLength(0);
  });
});
