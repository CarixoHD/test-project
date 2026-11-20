import { describe, expect, it } from 'vitest';
import type { PlanResult } from '../../shared/agent-results.ts';
import type { Event, EventDraft } from '../../shared/events.ts';
import { ProductIdSchema, type IssueId, type ProductId } from '../../shared/ids.ts';
import type { Role } from '../../shared/models.ts';
import { addIssue, applyPlan, cancelIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { inboxHook } from '../notify/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { createScheduler, type Runners, type Timer } from './index.ts';

// Flow 9: a building product with every non-cancelled issue completed, no pending triggers and
// no live runs becomes complete in the scheduler tick; new work sets it back to building.

const P = ProductIdSchema.parse('product-1');

const draft = (type: string, productId: ProductId | null, entityId: string | null, data: object) =>
  ({ type, productId, entityId, v: 1, data }) as EventDraft;

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

const flush = () => new Promise<void>((r) => setImmediate(r));

const create = (key: string, dependsOn: string[] = []) => ({
  op: 'create' as const,
  key,
  title: `Title ${key}`,
  body: `Body ${key}`,
  dependsOn,
});

function completeEvents(id: IssueId): EventDraft[] {
  const step = { attemptCount: 0, runAfter: 0 };
  return [
    draft('issue.status_changed', P, id, { ...step, from: 'open', to: 'in_progress' }),
    draft('issue.status_changed', P, id, { ...step, from: 'in_progress', to: 'in_review' }),
    draft('issue.completed', P, id, {
      attemptId: `attempt-${id}`,
      mergedOrder: 1,
      mergeSha: 'c'.repeat(40),
    }),
  ];
}

function setup(opts: { blocked?: (role: Role) => boolean } = {}) {
  const db = open(':memory:');
  const clock = new FakeClock();
  const ids = new FakeIdGen();
  const store: Store = createStore({
    db,
    clock,
    redactor: new Redactor(),
    hooks: [inboxHook({ ids })],
  });
  store.commit(() => [
    draft('product.created', P, null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 2,
      models: {},
      gitRemote: null,
    }),
    draft('prd.applied', P, null, { version: 1, markdown: '# v1', summary: null }),
    draft('product.handed_off', P, null, { prdVersion: 1 }),
  ]);

  // Attempt runs that hold their slot until released; `finish` merges the issue first.
  const pending = new Map<IssueId, () => void>();
  const runners: Runners = {
    runOrchestrator: () => Promise.resolve(),
    runAttempt: (issueId) =>
      new Promise<void>((resolve) => {
        pending.set(issueId, resolve);
      }),
  };
  const timer = new FakeTimer();
  const scheduler = createScheduler({
    store,
    clock,
    runners,
    ids,
    timer,
    isBackendBlocked: (_p, role) => opts.blocked?.(role) ?? false,
  });

  function plan(ops: PlanResult['issueOps']): Record<string, IssueId> {
    const r = applyPlan(
      { store, ids },
      P,
      { issueOps: ops, questions: [], summary: 's' },
      store.snapshot().lastSeq,
    );
    if (!r.ok) throw new Error(r.reason);
    return r.createdIds;
  }

  /** Merges the issue (as its attempt would) and lets its run end. */
  async function finish(id: IssueId) {
    store.commit(() => completeEvents(id));
    pending.get(id)?.();
    pending.delete(id);
    await flush();
  }

  const phase = () => store.q.product(P)?.phase;
  const phaseEvents = (): Event[] =>
    store.eventsSince(0).filter((e) => e.type === 'product.phase_changed');
  const completions = () =>
    phaseEvents().filter((e) => e.type === 'product.phase_changed' && e.data.phase === 'complete');

  async function shutdown() {
    const stopped = scheduler.stop();
    for (const release of pending.values()) release();
    await stopped;
  }

  return { store, ids, scheduler, timer, plan, finish, phase, completions, shutdown };
}

describe('scheduler: product completion', () => {
  it('completes the product exactly once when every issue is merged and nothing is pending', async () => {
    const t = setup();
    const ids = t.plan([create('a'), create('b')]);
    t.scheduler.start();
    await t.finish(ids['a'] as IssueId);
    t.timer.fire();
    expect(t.phase()).toBe('building');

    await t.finish(ids['b'] as IssueId);
    expect(t.phase()).toBe('building'); // the merge event arrives while its run is still live
    t.timer.fire();
    expect(t.phase()).toBe('complete');

    t.timer.fire();
    t.scheduler.kick();
    expect(t.completions()).toHaveLength(1);
    expectSnapshotMatchesReplay(t.store);
    await t.shutdown();
  });

  it('posts a completion item to the inbox', async () => {
    const t = setup();
    const ids = t.plan([create('a')]);
    t.scheduler.start();
    await t.finish(ids['a'] as IssueId);
    t.timer.fire();

    const inbox = Object.values(t.store.snapshot().state.inbox);
    expect(inbox).toMatchObject([
      { productId: P, kind: 'complete', title: 'Todo is complete', link: `/products/${P}` },
    ]);
    await t.shutdown();
  });

  it('does not complete a product without issues', async () => {
    const t = setup();
    t.plan([]);
    t.scheduler.start();
    t.timer.fire();
    expect(t.phase()).toBe('building');
    await t.shutdown();
  });

  it('does not complete while a trigger is pending', async () => {
    const t = setup({ blocked: (role) => role === 'orchestrator' });
    const ids = t.plan([create('a')]);
    t.scheduler.start();
    t.store.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    await t.finish(ids['a'] as IssueId);
    t.timer.fire();
    expect(t.phase()).toBe('building');
    await t.shutdown();
  });

  it('does not complete while an issue is unfinished', async () => {
    const t = setup();
    t.plan([create('a'), create('b', ['a'])]);
    t.scheduler.start();
    t.timer.fire();
    expect(t.phase()).toBe('building');
    await t.shutdown();
  });

  it('owner-cancelling the last unfinished issue wakes the scheduler, which completes the product', async () => {
    const t = setup({ blocked: (role) => role === 'implementer' });
    const ids = t.plan([create('a'), create('b')]);
    t.store.commit(() => completeEvents(ids['a'] as IssueId));
    t.scheduler.start();
    expect(t.phase()).toBe('building');

    const r = cancelIssue({ store: t.store, ids: t.ids }, ids['b'] as IssueId);
    expect(r.ok).toBe(true);
    // No timer tick: the issue.cancelled event itself wakes the scheduler.
    expect(t.phase()).toBe('complete');
    expect(t.completions()).toHaveLength(1);
    await t.shutdown();
  });

  it('adding an issue sets the product back to building, and it completes again later', async () => {
    const t = setup();
    const ids = t.plan([create('a')]);
    t.scheduler.start();
    await t.finish(ids['a'] as IssueId);
    t.timer.fire();
    expect(t.phase()).toBe('complete');

    const added = addIssue({ store: t.store, ids: t.ids }, P, {
      title: 'More',
      body: '',
      dependsOn: [],
    });
    if (!added.ok) throw new Error(added.reason);
    expect(t.phase()).toBe('building');

    await t.finish(added.issueId);
    t.timer.fire();
    expect(t.phase()).toBe('complete');
    expect(t.completions()).toHaveLength(2);
    expectSnapshotMatchesReplay(t.store);
    await t.shutdown();
  });

  it('a plan that creates an issue sets the product back to building', async () => {
    const t = setup();
    const ids = t.plan([create('a')]);
    t.scheduler.start();
    await t.finish(ids['a'] as IssueId);
    t.timer.fire();
    expect(t.phase()).toBe('complete');

    t.plan([create('b')]);
    expect(t.phase()).toBe('building');
    await t.shutdown();
  });
});
