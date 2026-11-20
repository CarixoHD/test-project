import { describe, expect, it } from 'vitest';
import { AddIssueResponseSchema, EditIssueResponseSchema } from '../../shared/dto.ts';
import type { EventDraft } from '../../shared/events.ts';
import {
  AttemptIdSchema,
  ProductIdSchema,
  type IssueId,
  type ProductId,
} from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { createGit } from '../git/index.ts';
import { createApp } from '../http/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { addIssue, applyPlan } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const P2 = ProductIdSchema.parse('product-2');
const SHA = 'c'.repeat(40);

const draft = (type: string, productId: ProductId, entityId: string | null, data: object) =>
  ({ type, productId, entityId, v: 1, data }) as EventDraft;

function setup() {
  const db = open(':memory:');
  const redactor = new Redactor();
  const store = createStore({ db, clock: new FakeClock(), redactor });
  const ids = new FakeIdGen();
  for (const p of [P, P2]) {
    store.commit(() => [
      draft('product.created', p, null, {
        name: 'Todo',
        idea: 'todos',
        budgetUsd: null,
        maxParallel: 3,
        maxAttempts: 2,
        models: {},
        gitRemote: null,
      }),
      draft('prd.applied', p, null, { version: 1, markdown: '# v1', summary: null }),
      draft('product.handed_off', p, null, { prdVersion: 1 }),
    ]);
  }
  const app = createApp({
    store,
    redactor,
    ids,
    // These routes never touch git.
    git: createGit({ dataDir: '/nonexistent/vibecode-issues-tests' }),
  });
  return { store, ids, app };
}

type Ctx = ReturnType<typeof setup>;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function add(ctx: Ctx, body: object, productId: string = P): Promise<IssueId> {
  const res = await ctx.app.request(`/api/products/${productId}/issues`, json('POST', body));
  expect(res.status).toBe(200);
  return AddIssueResponseSchema.parse(await res.json()).issueId;
}

const issueOf = (ctx: Ctx, id: IssueId) => ctx.store.snapshot().state.issues[id];
const lastEvent = (ctx: Ctx) => ctx.store.eventsSince(0).at(-1);

async function expectError(res: Response, status: number, message: RegExp) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { message: string } };
  expect(body.error.message).toMatch(message);
}

const started = { from: 'open', to: 'in_progress', attemptCount: 0, runAfter: 0 };

/** Drives an issue to `completed` (merged). */
function completeIssue(ctx: Ctx, id: IssueId): void {
  ctx.store.commit(() => [
    draft('issue.status_changed', P, id, started),
    draft('issue.status_changed', P, id, { ...started, from: 'in_progress', to: 'in_review' }),
    draft('issue.completed', P, id, {
      attemptId: AttemptIdSchema.parse(`attempt-${id}`),
      mergedOrder: 1,
      mergeSha: SHA,
    }),
  ]);
}

describe('POST /api/products/:id/issues', () => {
  it('adds owner issues with dependencies, next numbers and the product prd version', async () => {
    const ctx = setup();
    const planned = applyPlan(
      ctx,
      P,
      {
        issueOps: [{ op: 'create', key: 'o', title: 'O', body: 'o', dependsOn: [] }],
        questions: [],
        summary: 's',
      },
      1,
    );
    if (!planned.ok) throw new Error(planned.reason);
    const o = planned.createdIds['o'] as IssueId;

    const a = await add(ctx, { title: 'Login', body: 'Make a login form', dependsOn: [o] });
    expect(lastEvent(ctx)).toMatchObject({ type: 'issue.created', entityId: a, productId: P });
    const b = await add(ctx, { title: 'Logout', body: '', dependsOn: [a, o, a], priority: 5 });

    expect(issueOf(ctx, a)).toMatchObject({
      number: 2,
      title: 'Login',
      body: 'Make a login form',
      status: 'open',
      rev: 1,
      priority: 0,
      origin: 'owner',
      prdVersion: 1,
      dependsOn: [o],
    });
    expect(issueOf(ctx, b)).toMatchObject({ number: 3, priority: 5, dependsOn: [a, o] });
    expectSnapshotMatchesReplay(ctx.store);
  });

  it('defaults dependsOn to none', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'Solo', body: 'b' });
    expect(issueOf(ctx, a)?.dependsOn).toEqual([]);
  });

  it('sets a complete product back to building in the same commit', async () => {
    const ctx = setup();
    ctx.store.commit(() => [draft('product.phase_changed', P, null, { phase: 'complete' })]);
    const before = ctx.store.snapshot().lastSeq;
    const a = await add(ctx, { title: 'More', body: '' });
    const events = ctx.store.eventsSince(before);
    expect(events.map((e) => e.type)).toEqual(['issue.created', 'product.phase_changed']);
    expect(events[1]?.data).toEqual({ phase: 'building' });
    expect(ctx.store.snapshot().state.products[P]?.phase).toBe('building');
    expect(issueOf(ctx, a)?.status).toBe('open');
    expectSnapshotMatchesReplay(ctx.store);
  });

  it('does not change the phase of a building product', async () => {
    const ctx = setup();
    const before = ctx.store.snapshot().lastSeq;
    await add(ctx, { title: 'More', body: '' });
    expect(ctx.store.eventsSince(before).map((e) => e.type)).toEqual(['issue.created']);
  });

  it.each([
    {
      name: 'unknown dependency',
      body: { title: 't', body: '', dependsOn: ['ghost'] },
      msg: /unknown dependency "ghost"/,
    },
    { name: 'empty title', body: { title: '', body: '' }, msg: /title/ },
    { name: 'missing body', body: { title: 't' }, msg: /body/ },
    {
      name: 'non-integer priority',
      body: { title: 't', body: '', priority: 1.5 },
      msg: /priority/,
    },
  ])('rejects $name with 400 and commits nothing', async ({ body, msg }) => {
    const ctx = setup();
    const before = ctx.store.snapshot();
    await expectError(
      await ctx.app.request(`/api/products/${P}/issues`, json('POST', body)),
      400,
      msg,
    );
    expect(ctx.store.snapshot()).toStrictEqual(before);
  });

  it('rejects a dependency on an issue of another product with 400', async () => {
    const ctx = setup();
    const other = await add(ctx, { title: 'Other', body: '' }, P2);
    const res = await ctx.app.request(
      `/api/products/${P}/issues`,
      json('POST', { title: 't', body: '', dependsOn: [other] }),
    );
    await expectError(res, 400, /unknown dependency/);
  });

  it('rejects a dependency on a cancelled issue with 400', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    expect((await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'))).status).toBe(200);
    const before = ctx.store.snapshot();
    const res = await ctx.app.request(
      `/api/products/${P}/issues`,
      json('POST', { title: 't', body: '', dependsOn: [a] }),
    );
    await expectError(res, 400, /is cancelled/);
    expect(ctx.store.snapshot()).toStrictEqual(before);
  });

  it('returns 404 for an unknown product', async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      '/api/products/nope/issues',
      json('POST', { title: 't', body: '' }),
    );
    await expectError(res, 404, /unknown product/);
  });

  it('can be called directly as a command', () => {
    const ctx = setup();
    const r = addIssue(ctx, P, { title: 'Direct', body: '', dependsOn: [] });
    expect(r).toMatchObject({ ok: true, issueId: expect.any(String) });
    expect(
      addIssue(ctx, ProductIdSchema.parse('nope'), { title: 't', body: '', dependsOn: [] }),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('PATCH /api/issues/:id', () => {
  it('edits title, body and dependsOn and bumps rev', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    const b = await add(ctx, { title: 'B', body: 'old' });

    const res = await ctx.app.request(
      `/api/issues/${b}`,
      json('PATCH', { title: 'B2', body: 'new', dependsOn: [a], rev: 1 }),
    );
    expect(res.status).toBe(200);
    expect(EditIssueResponseSchema.parse(await res.json())).toEqual({ ok: true, rev: 2 });
    expect(lastEvent(ctx)).toMatchObject({
      type: 'issue.edited',
      entityId: b,
      data: { rev: 2, title: 'B2', body: 'new', dependsOn: [a] },
    });
    expect(issueOf(ctx, b)).toMatchObject({ title: 'B2', body: 'new', dependsOn: [a], rev: 2 });

    const res2 = await ctx.app.request(
      `/api/issues/${b}`,
      json('PATCH', { body: 'newer', rev: 2 }),
    );
    expect(res2.status).toBe(200);
    expect(lastEvent(ctx)?.data).toEqual({ rev: 3, body: 'newer' });
    expect(issueOf(ctx, b)).toMatchObject({ title: 'B2', body: 'newer', dependsOn: [a], rev: 3 });
    expectSnapshotMatchesReplay(ctx.store);
  });

  it('edits only the priority and bumps rev', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: 'keep', priority: 0 });

    const res = await ctx.app.request(`/api/issues/${a}`, json('PATCH', { priority: 2, rev: 1 }));
    expect(res.status).toBe(200);
    expect(EditIssueResponseSchema.parse(await res.json())).toEqual({ ok: true, rev: 2 });
    expect(lastEvent(ctx)).toMatchObject({ type: 'issue.edited', entityId: a });
    expect(lastEvent(ctx)?.data).toEqual({ rev: 2, priority: 2 });
    expect(issueOf(ctx, a)).toMatchObject({ title: 'A', body: 'keep', priority: 2, rev: 2 });
    expect(ctx.store.q.issue(a)?.priority).toBe(2);
    expectSnapshotMatchesReplay(ctx.store);
  });

  it('rejects a fractional priority with 400', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    const res = await ctx.app.request(`/api/issues/${a}`, json('PATCH', { priority: 1.5, rev: 1 }));
    expect(res.status).toBe(400);
    expect(issueOf(ctx, a)).toMatchObject({ priority: 0, rev: 1 });
  });

  it('returns 409 on a stale rev for a priority edit and writes no event', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    expect(
      (await ctx.app.request(`/api/issues/${a}`, json('PATCH', { priority: 1, rev: 1 }))).status,
    ).toBe(200);
    const before = ctx.store.snapshot();
    const eventCount = ctx.store.eventsSince(0).length;
    const res = await ctx.app.request(`/api/issues/${a}`, json('PATCH', { priority: -1, rev: 1 }));
    await expectError(res, 409, /stale rev 1.*current rev is 2/);
    expect(ctx.store.eventsSince(0)).toHaveLength(eventCount);
    expect(ctx.store.snapshot()).toStrictEqual(before);
    expect(issueOf(ctx, a)?.priority).toBe(1);
  });

  it('edits an in-progress issue (its attempt will discard itself at merge time)', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    ctx.store.commit(() => [draft('issue.status_changed', P, a, started)]);
    const res = await ctx.app.request(`/api/issues/${a}`, json('PATCH', { body: 'steer', rev: 1 }));
    expect(res.status).toBe(200);
    expect(issueOf(ctx, a)).toMatchObject({ status: 'in_progress', rev: 2, body: 'steer' });
  });

  it('returns 409 on a stale rev and commits nothing', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    expect(
      (await ctx.app.request(`/api/issues/${a}`, json('PATCH', { title: 'A2', rev: 1 }))).status,
    ).toBe(200);
    const before = ctx.store.snapshot();
    const res = await ctx.app.request(`/api/issues/${a}`, json('PATCH', { title: 'A3', rev: 1 }));
    await expectError(res, 409, /stale rev 1.*current rev is 2/);
    expect(ctx.store.snapshot()).toStrictEqual(before);
  });

  it('rejects a dependency cycle with 400 and commits nothing', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    const b = await add(ctx, { title: 'B', body: '', dependsOn: [a] });
    const c = await add(ctx, { title: 'C', body: '', dependsOn: [b] });
    const before = ctx.store.snapshot();
    const res = await ctx.app.request(
      `/api/issues/${a}`,
      json('PATCH', { dependsOn: [c], rev: 1 }),
    );
    await expectError(res, 400, /dependency cycle: #1 → #3 → #2 → #1/);
    expect(ctx.store.snapshot()).toStrictEqual(before);
  });

  it('rejects a self dependency with 400', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    const res = await ctx.app.request(
      `/api/issues/${a}`,
      json('PATCH', { dependsOn: [a], rev: 1 }),
    );
    await expectError(res, 400, /dependency cycle/);
  });

  it('rejects a dependency on a cancelled issue with 400', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    const b = await add(ctx, { title: 'B', body: '' });
    expect((await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'))).status).toBe(200);
    const res = await ctx.app.request(
      `/api/issues/${b}`,
      json('PATCH', { dependsOn: [a], rev: 1 }),
    );
    await expectError(res, 400, /is cancelled/);
  });

  it.each(['completed', 'cancelled'] as const)(
    'returns 409 when the issue is %s',
    async (status) => {
      const ctx = setup();
      const a = await add(ctx, { title: 'A', body: '' });
      if (status === 'completed') completeIssue(ctx, a);
      else
        expect((await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'))).status).toBe(200);
      const res = await ctx.app.request(`/api/issues/${a}`, json('PATCH', { title: 'x', rev: 1 }));
      await expectError(res, 409, new RegExp(`cannot edit an issue that is ${status}`));
    },
  );

  it('returns 404 for an unknown issue', async () => {
    const ctx = setup();
    const res = await ctx.app.request('/api/issues/ghost', json('PATCH', { title: 'x', rev: 1 }));
    await expectError(res, 404, /unknown issue "ghost"/);
  });

  it('returns 400 without a rev', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    await expectError(
      await ctx.app.request(`/api/issues/${a}`, json('PATCH', { title: 'x' })),
      400,
      /rev/,
    );
  });
});

describe('POST /api/issues/:id/cancel', () => {
  it.each(['open', 'in_progress'] as const)('cancels a %s issue', async (status) => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    if (status === 'in_progress') {
      ctx.store.commit(() => [draft('issue.status_changed', P, a, started)]);
    }
    const res = await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(lastEvent(ctx)).toMatchObject({
      type: 'issue.cancelled',
      entityId: a,
      data: { from: status, by: 'owner' },
    });
    expect(issueOf(ctx, a)?.status).toBe('cancelled');
    expectSnapshotMatchesReplay(ctx.store);
  });

  it('allows cancelling an issue that others depend on', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    await add(ctx, { title: 'B', body: '', dependsOn: [a] });
    expect((await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'))).status).toBe(200);
  });

  it('returns 409 for a completed issue and commits nothing', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    completeIssue(ctx, a);
    const before = ctx.store.snapshot();
    const res = await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'));
    await expectError(res, 409, /cannot cancel an issue that is completed/);
    expect(ctx.store.snapshot()).toStrictEqual(before);
  });

  it('returns 409 for an already cancelled issue', async () => {
    const ctx = setup();
    const a = await add(ctx, { title: 'A', body: '' });
    expect((await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'))).status).toBe(200);
    await expectError(
      await ctx.app.request(`/api/issues/${a}/cancel`, json('POST')),
      409,
      /cancelled/,
    );
  });

  it('returns 404 for an unknown issue', async () => {
    const ctx = setup();
    await expectError(
      await ctx.app.request('/api/issues/ghost/cancel', json('POST')),
      404,
      /unknown issue/,
    );
  });
});

describe('owner issue commands', () => {
  it('snapshot ≡ replay after a mixed sequence', async () => {
    const ctx = setup();
    ctx.store.commit(() => [draft('product.phase_changed', P, null, { phase: 'complete' })]);
    const a = await add(ctx, { title: 'A', body: 'a' });
    const b = await add(ctx, { title: 'B', body: 'b', dependsOn: [a], priority: 2 });
    const c = await add(ctx, { title: 'C', body: 'c' });
    await ctx.app.request(
      `/api/issues/${b}`,
      json('PATCH', { title: 'B2', dependsOn: [c], rev: 1 }),
    );
    await ctx.app.request(`/api/issues/${a}/cancel`, json('POST'));
    completeIssue(ctx, c);
    expect(ctx.store.eventsSince(0).map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'issue.created',
        'issue.edited',
        'issue.cancelled',
        'product.phase_changed',
      ]),
    );
    expectSnapshotMatchesReplay(ctx.store);
  });
});
