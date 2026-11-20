import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import type { IssueId, ProductId } from '../../shared/ids.ts';
import { createApp } from '../http/index.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../http/testing.ts';
import { createScheduler, type RunHandle, type Runners, type Timer } from '../scheduler/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { applyPlan, pauseProduct, resumeProduct } from './index.ts';

const draft = (type: string, data: object, entityId: string | null = null) =>
  ({ type, productId: TEST_PRODUCT, entityId, v: 1, data }) as EventDraft;

function setup() {
  const deps = setupStore();
  deps.store.commit(() => [
    productCreated(),
    draft('prd.applied', { version: 1, markdown: '# v1', summary: null }),
    draft('product.handed_off', { prdVersion: 1 }),
  ]);
  const app = createApp(deps);
  return { ...deps, app };
}

const post = (app: ReturnType<typeof setup>['app'], action: string, id: string = TEST_PRODUCT) =>
  app.request(`/api/products/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

const pauseEvents = (store: ReturnType<typeof setup>['store']) =>
  store.eventsSince(0).filter((e) => e.type === 'product.paused' || e.type === 'product.resumed');

const usage = (costUsd: number) =>
  draft(
    'usage.recorded',
    {
      agentId: 'agent-1',
      role: 'implementer',
      model: { provider: 'anthropic', model: 'm' },
      issueId: null,
      attemptId: null,
      billing: 'api',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      webSearches: 0,
      calls: 1,
      costUsd,
      unpriced: false,
      estCostUsd: null,
      source: 'computed',
    },
    'usage-1',
  );

describe('pauseProduct / resumeProduct', () => {
  it('pause emits product.paused{owner}; resume emits product.resumed', () => {
    const { store, ids } = setup();
    expect(pauseProduct({ store, ids }, TEST_PRODUCT).ok).toBe(true);
    expect(store.q.product(TEST_PRODUCT)).toMatchObject({ paused: true, pauseReason: 'owner' });
    expect(resumeProduct({ store, ids }, TEST_PRODUCT).ok).toBe(true);
    expect(store.q.product(TEST_PRODUCT)).toMatchObject({ paused: false, pauseReason: null });
    expect(pauseEvents(store).map((e) => [e.type, e.data])).toEqual([
      ['product.paused', { reason: 'owner' }],
      ['product.resumed', {}],
    ]);
    expectSnapshotMatchesReplay(store);
  });

  it('refuses to resume while the budget is still exhausted', () => {
    const { store, ids } = setup();
    store.commit(() => [usage(10), draft('product.paused', { reason: 'budget' })]);
    const r = resumeProduct({ store, ids }, TEST_PRODUCT);
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(store.q.product(TEST_PRODUCT)?.paused).toBe(true);
  });

  it('resumes a budget pause once the budget is raised', () => {
    const { store, ids } = setup();
    store.commit(() => [
      usage(10),
      draft('product.paused', { reason: 'budget' }),
      draft('product.settings_changed', { budgetUsd: 20 }),
    ]);
    expect(resumeProduct({ store, ids }, TEST_PRODUCT).ok).toBe(true);
  });
});

describe('POST /api/products/:id/pause and /resume', () => {
  it('pause → 200, pause again → 409; resume → 200, resume again → 409', async () => {
    const { app, store } = setup();
    expect((await post(app, 'pause')).status).toBe(200);
    expect(store.q.product(TEST_PRODUCT)?.paused).toBe(true);

    const again = await post(app, 'pause');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'conflict' } });

    expect((await post(app, 'resume')).status).toBe(200);
    expect(store.q.product(TEST_PRODUCT)?.paused).toBe(false);
    expect((await post(app, 'resume')).status).toBe(409);
    expect(pauseEvents(store)).toHaveLength(2);
  });

  it('answers 404 for an unknown product', async () => {
    const { app } = setup();
    expect((await post(app, 'pause', 'product-nope')).status).toBe(404);
    expect((await post(app, 'resume', 'product-nope')).status).toBe(404);
  });
});

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

describe('pause/resume with the scheduler', () => {
  function withScheduler() {
    const t = setup();
    const started: { issueId: IssueId; run: RunHandle; done: () => void }[] = [];
    const runners: Runners = {
      runOrchestrator: () => Promise.resolve(),
      runAttempt: (issueId, run) =>
        new Promise<void>((resolve) => {
          started.push({ issueId, run, done: resolve });
        }),
    };
    const timer = new FakeTimer();
    const scheduler = createScheduler({
      store: t.store,
      clock: t.clock,
      runners,
      ids: t.ids,
      timer,
      isBackendBlocked: () => false,
    });
    const plan = (keys: string[], productId: ProductId = TEST_PRODUCT) => {
      const r = applyPlan(
        { store: t.store, ids: t.ids },
        productId,
        {
          issueOps: keys.map((key) => ({
            op: 'create' as const,
            key,
            title: `Title ${key}`,
            body: `Body ${key}`,
            dependsOn: [],
          })),
          questions: [],
          summary: 's',
        },
        t.store.snapshot().lastSeq,
      );
      if (!r.ok) throw new Error(r.reason);
    };
    const shutdown = async () => {
      const stopped = scheduler.stop();
      for (const s of started) s.done();
      await stopped;
    };
    return { ...t, scheduler, timer, started, plan, shutdown };
  }

  it('pause makes shouldStop true for live runs and starts nothing; resume restarts scheduling', async () => {
    const t = withScheduler();
    t.plan(['a']);
    t.scheduler.start();
    expect(t.started).toHaveLength(1);
    const live = t.started[0];
    if (live === undefined) throw new Error('no run');
    expect(live.run.shouldStop()).toBe(false);

    expect((await post(t.app, 'pause')).status).toBe(200);
    expect(live.run.shouldStop()).toBe(true);

    // A new ready issue arrives while paused: nothing starts, even on timer ticks.
    t.plan(['b']);
    t.timer.fire();
    expect(t.started).toHaveLength(1);

    // The live run stops (interrupted) and the slot frees up: still nothing starts.
    live.done();
    await new Promise<void>((r) => setImmediate(r));
    t.timer.fire();
    expect(t.started).toHaveLength(1);

    expect((await post(t.app, 'resume')).status).toBe(200);
    // Resuming is a store event, which wakes the scheduler without waiting for the timer.
    expect(t.started.length).toBeGreaterThan(1);
    expect(t.started.slice(1).every((s) => !s.run.shouldStop())).toBe(true);
    await t.shutdown();
  });
});
