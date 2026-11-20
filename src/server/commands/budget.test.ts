import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import { createApp } from '../http/index.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../http/testing.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { budgetAfterUsage, checkBudget, resumeProduct, updateProductSettings } from './index.ts';

// TEST_PRODUCT is created with budgetUsd 10.

const draft = (type: string, data: object, entityId: string | null = null) =>
  ({ type, productId: TEST_PRODUCT, entityId, v: 1, data }) as EventDraft;

let usageN = 0;
const usageData = (billing: 'api' | 'subscription', costUsd: number | null) => ({
  agentId: 'agent-1',
  role: 'implementer',
  model: { provider: billing === 'api' ? 'anthropic' : 'claude-code', model: 'm' },
  issueId: null,
  attemptId: null,
  billing,
  tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  webSearches: 0,
  calls: 1,
  costUsd,
  unpriced: billing === 'api' && costUsd === null,
  estCostUsd: billing === 'subscription' ? 50 : null,
  source: billing === 'api' ? 'computed' : 'cli',
});
const usage = (costUsd: number | null, billing: 'api' | 'subscription' = 'api') =>
  draft('usage.recorded', usageData(billing, costUsd), `usage-${String(++usageN)}`);

function setup() {
  const deps = setupStore();
  deps.store.commit(() => [
    productCreated(),
    draft('prd.applied', { version: 1, markdown: '# v1', summary: null }),
    draft('product.handed_off', { prdVersion: 1 }),
  ]);
  const spend = (costUsd: number | null, billing: 'api' | 'subscription' = 'api') =>
    deps.store.commit(() => [usage(costUsd, billing)]);
  const check = () => checkBudget({ store: deps.store, ids: deps.ids }, TEST_PRODUCT);
  const ofType = (type: string) => deps.store.eventsSince(0).filter((e) => e.type === type);
  return { ...deps, app: createApp(deps), spend, check, ofType };
}

describe('checkBudget', () => {
  it('does nothing below 80 % of the budget', () => {
    const t = setup();
    t.spend(7.9);
    expect(t.check()).toMatchObject({ ok: true, level: 'ok', spentUsd: 7.9, events: [] });
    expect(t.ofType('budget.warned')).toHaveLength(0);
    expect(t.store.q.product(TEST_PRODUCT)?.paused).toBe(false);
  });

  it('warns exactly once from 80 %', () => {
    const t = setup();
    t.spend(8);
    expect(t.check()).toMatchObject({ ok: true, level: 'warn' });
    expect(t.ofType('budget.warned').map((e) => e.data)).toEqual([{ spentUsd: 8, budgetUsd: 10 }]);
    expect(t.store.q.product(TEST_PRODUCT)?.budgetWarned).toBe(true);

    t.spend(0.5);
    expect(t.check()).toMatchObject({ ok: true, events: [] });
    t.check();
    expect(t.ofType('budget.warned')).toHaveLength(1);
    expect(t.store.q.product(TEST_PRODUCT)?.paused).toBe(false);
    expectSnapshotMatchesReplay(t.store);
  });

  it('auto-pauses once with reason budget at 100 %', () => {
    const t = setup();
    t.spend(8);
    t.check();
    t.spend(2);
    expect(t.check()).toMatchObject({ ok: true, level: 'exhausted' });
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({ paused: true, pauseReason: 'budget' });

    t.spend(1);
    t.check();
    expect(t.ofType('product.paused').map((e) => e.data)).toEqual([{ reason: 'budget' }]);
    expect(t.ofType('budget.warned')).toHaveLength(1);
    expectSnapshotMatchesReplay(t.store);
  });

  it('warns and pauses in one commit when one step jumps past 100 %', () => {
    const t = setup();
    t.spend(12);
    const r = t.check();
    expect(r.ok && r.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['budget.warned', 'product.paused']),
    );
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({
      paused: true,
      pauseReason: 'budget',
      budgetWarned: true,
    });
  });

  it('never counts subscription usage toward the USD budget', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.spend(null, 'subscription');
    expect(t.check()).toMatchObject({ ok: true, level: 'ok', spentUsd: 0, events: [] });
    expect(t.ofType('budget.warned')).toHaveLength(0);
    expect(t.store.q.product(TEST_PRODUCT)?.paused).toBe(false);
  });

  it('flags unpriced API usage: it is not counted and the spend is marked a lower bound', () => {
    const t = setup();
    t.spend(1);
    expect(t.check()).toMatchObject({ ok: true, unpriced: false });
    t.spend(null);
    expect(t.check()).toMatchObject({ ok: true, level: 'ok', spentUsd: 1, unpriced: true });
  });

  it('does nothing without a budget', () => {
    const t = setup();
    updateProductSettings(t, TEST_PRODUCT, { budgetUsd: null });
    t.spend(1000);
    expect(t.check()).toMatchObject({ ok: true, level: 'ok', events: [] });
  });

  it('does not add a budget pause to a product the owner already paused', () => {
    const t = setup();
    t.store.commit(() => [draft('product.paused', { reason: 'owner' })]);
    t.spend(10);
    t.check();
    expect(t.ofType('product.paused')).toHaveLength(1);
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({ paused: true, pauseReason: 'owner' });
  });

  it('reports an unknown product', () => {
    const t = setup();
    expect(checkBudget(t, 'product-nope' as typeof TEST_PRODUCT)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('budgetAfterUsage (the agent-run afterUsage hook)', () => {
  it('checks the budget of the usage event’s product', () => {
    const t = setup();
    const [event] = t.spend(10);
    if (event?.type !== 'usage.recorded') throw new Error('expected usage.recorded');
    budgetAfterUsage(t)(event);
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({ paused: true, pauseReason: 'budget' });
  });
});

describe('budget and settings changes', () => {
  it('raising the budget clears the warning; the next crossing warns exactly once more', () => {
    const t = setup();
    t.spend(8);
    t.check();
    expect(t.store.q.product(TEST_PRODUCT)?.budgetWarned).toBe(true);

    const r = updateProductSettings(t, TEST_PRODUCT, { budgetUsd: 20 });
    expect(r.ok).toBe(true);
    expect(t.ofType('product.settings_changed').at(-1)?.data).toEqual({
      budgetUsd: 20,
      budgetWarned: false,
    });
    expect(t.store.q.product(TEST_PRODUCT)?.budgetWarned).toBe(false);

    t.spend(4); // 12 / 20
    t.check();
    expect(t.ofType('budget.warned')).toHaveLength(1);
    t.spend(4); // 16 / 20
    t.check();
    t.check();
    expect(t.ofType('budget.warned').map((e) => e.data)).toEqual([
      { spentUsd: 8, budgetUsd: 10 },
      { spentUsd: 16, budgetUsd: 20 },
    ]);
    expectSnapshotMatchesReplay(t.store);
  });

  it('keeps the warning when the raised budget is still 80 % spent', () => {
    const t = setup();
    t.spend(8.5);
    t.check();
    updateProductSettings(t, TEST_PRODUCT, { budgetUsd: 10.5 }); // 81 %
    expect(t.ofType('product.settings_changed').at(-1)?.data).toEqual({ budgetUsd: 10.5 });
    expect(t.store.q.product(TEST_PRODUCT)?.budgetWarned).toBe(true);
    expect(t.ofType('budget.warned')).toHaveLength(1);
  });

  it('removing the budget clears the warning', () => {
    const t = setup();
    t.spend(8);
    t.check();
    updateProductSettings(t, TEST_PRODUCT, { budgetUsd: null });
    expect(t.store.q.product(TEST_PRODUCT)?.budgetWarned).toBe(false);
  });

  it('lowering the budget below the spend warns and pauses straight away', () => {
    const t = setup();
    t.spend(5);
    updateProductSettings(t, TEST_PRODUCT, { budgetUsd: 5 });
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({
      paused: true,
      pauseReason: 'budget',
      budgetWarned: true,
    });
    expect(t.ofType('budget.warned').map((e) => e.data)).toEqual([{ spentUsd: 5, budgetUsd: 5 }]);
    expectSnapshotMatchesReplay(t.store);
  });

  it('settings changes that do not touch the budget leave the warning alone', () => {
    const t = setup();
    t.spend(1);
    updateProductSettings(t, TEST_PRODUCT, { maxParallel: 2 });
    expect(t.ofType('product.settings_changed').at(-1)?.data).toEqual({ maxParallel: 2 });
    expect(t.ofType('budget.warned')).toHaveLength(0);
  });
});

describe('resume while the budget is exhausted', () => {
  const post = (app: ReturnType<typeof setup>['app'], action: string) =>
    app.request(`/api/products/${TEST_PRODUCT}/${action}`, { method: 'POST' });
  const patch = (app: ReturnType<typeof setup>['app'], body: object) =>
    app.request(`/api/products/${TEST_PRODUCT}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('is refused with 409 until the budget is raised, then allowed', async () => {
    const t = setup();
    t.spend(10);
    t.check();
    expect(t.store.q.product(TEST_PRODUCT)?.pauseReason).toBe('budget');

    const refused = await post(t.app, 'resume');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: 'conflict', message: 'Budget exhausted: raise the budget in Settings' },
    });
    expect(t.store.q.product(TEST_PRODUCT)?.paused).toBe(true);

    expect((await patch(t.app, { budgetUsd: 20 })).status).toBe(200);
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({ paused: true, budgetWarned: false });

    expect((await post(t.app, 'resume')).status).toBe(200);
    expect(t.store.q.product(TEST_PRODUCT)).toMatchObject({ paused: false, pauseReason: null });
    expect(t.ofType('product.resumed')).toHaveLength(1);
    expectSnapshotMatchesReplay(t.store);
  });

  it('resumeProduct reports the same reason', () => {
    const t = setup();
    t.spend(10);
    t.check();
    expect(resumeProduct(t, TEST_PRODUCT)).toEqual({
      ok: false,
      code: 'conflict',
      reason: 'Budget exhausted: raise the budget in Settings',
    });
  });
});
