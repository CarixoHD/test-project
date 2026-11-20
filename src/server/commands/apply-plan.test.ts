import { describe, expect, it } from 'vitest';
import type { PlanResult } from '../../shared/agent-results.ts';
import type { EventDraft } from '../../shared/events.ts';
import {
  AttemptIdSchema,
  ProductIdSchema,
  type IssueId,
  type ProductId,
} from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { applyPlan, type ApplyPlanResult, type CommandDeps } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const P2 = ProductIdSchema.parse('product-2');
const SHA = 'c'.repeat(40);

const draft = (type: string, productId: ProductId, entityId: string | null, data: object) =>
  ({ type, productId, entityId, v: 1, data }) as EventDraft;

function setup(maxAttempts = 2) {
  const db = open(':memory:');
  const clock = new FakeClock();
  const store = createStore({ db, clock, redactor: new Redactor() });
  const deps: CommandDeps = { store, ids: new FakeIdGen() };
  for (const p of [P, P2]) {
    store.commit(() => [
      draft('product.created', p, null, {
        name: 'Todo',
        idea: 'todos',
        budgetUsd: null,
        maxParallel: 3,
        maxAttempts,
        models: {},
        gitRemote: null,
      }),
      draft('prd.applied', p, null, { version: 1, markdown: '# v1', summary: null }),
      draft('product.handed_off', p, null, { prdVersion: 1 }),
    ]);
  }
  return { store, deps };
}

const plan = (issueOps: PlanResult['issueOps'], questions: string[] = []): PlanResult => ({
  issueOps,
  questions,
  summary: 'the plan',
});

const create = (key: string, dependsOn: string[] = [], priority?: number) => ({
  op: 'create' as const,
  key,
  title: `Title ${key}`,
  body: `Body ${key}`,
  dependsOn,
  ...(priority === undefined ? {} : { priority }),
});

/** The id created for `key`; throws (failing the test) when the plan was refused. */
function idOf(r: ApplyPlanResult, key: string): IssueId {
  if (!r.ok) throw new Error(r.reason);
  const id = r.createdIds[key];
  if (id === undefined) throw new Error(`no issue created for key "${key}"`);
  return id;
}

/** Creates issues a, b (← a) in product P and returns their ids. */
function seedIssues(deps: CommandDeps): { a: IssueId; b: IssueId } {
  const r = applyPlan(deps, P, plan([create('a'), create('b', ['a'])]), 1);
  return { a: idOf(r, 'a'), b: idOf(r, 'b') };
}

/** Drives an issue to `failed` through the attempt events (maxAttempts 1 attempt here). */
function failIssue(deps: CommandDeps, id: IssueId): void {
  deps.store.commit(() => [
    draft('issue.status_changed', P, id, {
      from: 'open',
      to: 'in_progress',
      attemptCount: 0,
      runAfter: 0,
    }),
    draft('issue.failed', P, id, { from: 'in_progress', attemptCount: 2, reason: 'rejected' }),
  ]);
}

function completeIssue(deps: CommandDeps, id: IssueId): void {
  deps.store.commit(() => [
    draft('issue.status_changed', P, id, {
      from: 'open',
      to: 'in_progress',
      attemptCount: 0,
      runAfter: 0,
    }),
    draft('issue.status_changed', P, id, {
      from: 'in_progress',
      to: 'in_review',
      attemptCount: 0,
      runAfter: 0,
    }),
    draft('issue.completed', P, id, {
      attemptId: AttemptIdSchema.parse('attempt-x'),
      mergedOrder: 1,
      mergeSha: SHA,
    }),
  ]);
}

function expectNothingCommitted(deps: CommandDeps, run: () => { ok: boolean }) {
  const before = deps.store.snapshot();
  const result = run();
  expect(result.ok).toBe(false);
  expect(deps.store.snapshot()).toStrictEqual(before);
}

describe('applyPlan: valid plans', () => {
  it('creates issues with deps, questions and advances the cursor in one commit', () => {
    const { store, deps } = setup();
    const before = store.snapshot().lastSeq;
    const commits: number[] = [];
    store.subscribe((e) => commits.push(e.ts));

    const r = applyPlan(
      deps,
      P,
      plan(
        [create('api'), create('ui', ['api'], 5), create('docs', ['ui', 'api'])],
        ['Which database?'],
      ),
      3,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.map((e) => e.type)).toEqual([
      'issue.created',
      'issue.created',
      'issue.created',
      'question.asked',
      'orchestrator.cursor_advanced',
    ]);
    // One commit: consecutive seqs right after the previous last seq.
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5].map((n) => before + n));

    const { api, ui, docs } = r.createdIds as Record<'api' | 'ui' | 'docs', IssueId>;
    const issues = store.q.issuesByProduct(P);
    expect(issues.map((i) => [i.number, i.id, i.dependsOn])).toEqual([
      [1, api, []],
      [2, ui, [api]],
      [3, docs, [ui, api]],
    ]);
    expect(issues[1]).toMatchObject({
      title: 'Title ui',
      body: 'Body ui',
      status: 'open',
      rev: 1,
      priority: 5,
      origin: 'orchestrator',
      prdVersion: 1,
      attemptCount: 0,
    });
    expect(issues[0]?.priority).toBe(0);

    const { state } = store.snapshot();
    expect(Object.values(state.questions)).toMatchObject([
      { productId: P, target: 'orchestrator', issueId: null, text: 'Which database?' },
    ]);
    expect(state.products[P]?.orchestratorCursor).toBe(3);
    expectSnapshotMatchesReplay(store);
  });

  it('numbers issues per product, continuing after existing ones', () => {
    const { store, deps } = setup();
    seedIssues(deps);
    const r = applyPlan(deps, P2, plan([create('x')]), 1);
    const r2 = applyPlan(deps, P, plan([create('c')]), 2);
    expect(r.ok && r2.ok).toBe(true);
    expect(store.q.issuesByProduct(P2).map((i) => i.number)).toEqual([1]);
    expect(store.q.issuesByProduct(P).map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it('accepts dependencies on existing issue ids of the product', () => {
    const { store, deps } = setup();
    const { a, b } = seedIssues(deps);
    const r = applyPlan(deps, P, plan([create('c', [b, a])]), 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.q.issue(idOf(r, 'c'))?.dependsOn).toEqual([b, a]);
  });

  it('edits an open issue (rev + 1) and cancels another', () => {
    const { store, deps } = setup();
    const { a, b } = seedIssues(deps);
    const r = applyPlan(
      deps,
      P,
      plan([
        { op: 'edit', id: b, title: 'New title', dependsOn: [] },
        { op: 'cancel', id: a, reason: 'not needed' },
      ]),
      2,
    );
    expect(r.ok).toBe(true);
    expect(store.q.issue(b)).toMatchObject({ title: 'New title', rev: 2, dependsOn: [] });
    expect(store.q.issue(a)?.status).toBe('cancelled');
    expectSnapshotMatchesReplay(store);
  });

  it('edits a failed issue', () => {
    const { store, deps } = setup();
    const { a } = seedIssues(deps);
    failIssue(deps, a);
    const r = applyPlan(deps, P, plan([{ op: 'edit', id: a, body: 'clearer' }]), 2);
    expect(r.ok).toBe(true);
    expect(store.q.issue(a)).toMatchObject({ body: 'clearer', rev: 2, status: 'failed' });
  });

  it('rewrite moves a failed issue back to open and resets attempts', () => {
    const { store, deps } = setup();
    const { a } = seedIssues(deps);
    failIssue(deps, a);
    expect(store.q.issue(a)).toMatchObject({ status: 'failed', attemptCount: 2 });

    const r = applyPlan(deps, P, plan([{ op: 'rewrite', id: a, body: 'try this way' }]), 9);
    expect(r.ok).toBe(true);
    expect(store.q.issue(a)).toMatchObject({
      status: 'open',
      attemptCount: 0,
      failureReason: null,
      body: 'try this way',
      rev: 2,
    });
    expect(store.snapshot().state.products[P]?.orchestratorCursor).toBe(9);
    expectSnapshotMatchesReplay(store);
  });

  it('a create may depend on a key defined later in the plan, and edits may use keys', () => {
    const { store, deps } = setup();
    const { b } = seedIssues(deps);
    const r = applyPlan(
      deps,
      P,
      plan([
        create('late-user', ['late']),
        create('late'),
        { op: 'edit', id: b, dependsOn: ['late'] },
      ]),
      2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.q.issue(idOf(r, 'late-user'))?.dependsOn).toEqual([idOf(r, 'late')]);
    expect(store.q.issue(b)?.dependsOn).toEqual([idOf(r, 'late')]);
    expectSnapshotMatchesReplay(store);
  });

  it('an empty plan only advances the cursor', () => {
    const { store, deps } = setup();
    const r = applyPlan(deps, P, plan([]), 3);
    expect(r.ok && r.events.map((e) => e.type)).toEqual(['orchestrator.cursor_advanced']);
    expect(store.snapshot().state.products[P]?.orchestratorCursor).toBe(3);
  });
});

describe('applyPlan: invalid plans commit nothing', () => {
  const cases: {
    name: string;
    reason: RegExp;
    ops: (ids: { a: IssueId; b: IssueId }, deps: CommandDeps) => PlanResult['issueOps'];
  }[] = [
    {
      name: 'unknown dependency key',
      reason: /unknown dependency "nope"/,
      ops: () => [create('x', ['nope'])],
    },
    {
      name: 'duplicate create key',
      reason: /duplicate key "x"/,
      ops: () => [create('x'), create('x')],
    },
    {
      name: 'cycle among new issues',
      reason: /cycle/,
      ops: () => [create('x', ['y']), create('y', ['z']), create('z', ['x'])],
    },
    {
      name: 'self dependency',
      reason: /cycle/,
      ops: () => [create('x', ['x'])],
    },
    {
      name: 'cycle through an existing issue via edit',
      reason: /cycle/,
      ops: ({ a }) => [create('x', [a]), { op: 'edit', id: a, dependsOn: ['x'] }],
    },
    {
      name: 'dependency on an issue of another product',
      reason: /unknown dependency/,
      ops: (_ids, deps) => {
        const r = applyPlan(deps, P2, plan([create('other')]), 1);
        return [create('x', [idOf(r, 'other')])];
      },
    },
    {
      name: 'edit of an unknown issue',
      reason: /unknown issue "ghost"/,
      ops: () => [{ op: 'edit', id: 'ghost', title: 't' }],
    },
    {
      name: 'illegal cancel of a completed issue',
      reason: /cannot cancel an issue that is completed/,
      ops: ({ a }, deps) => {
        completeIssue(deps, a);
        return [{ op: 'cancel', id: a, reason: 'x' }];
      },
    },
    {
      name: 'edit of a completed issue',
      reason: /only open or failed issues can be edited/,
      ops: ({ a }, deps) => {
        completeIssue(deps, a);
        return [{ op: 'edit', id: a, title: 'x' }];
      },
    },
    {
      name: 'rewrite of an open issue',
      reason: /cannot rewrite an issue that is open/,
      ops: ({ a }) => [{ op: 'rewrite', id: a, body: 'x' }],
    },
    {
      name: 'edit after cancel in the same plan',
      reason: /only open or failed issues can be edited/,
      ops: ({ a }) => [
        { op: 'cancel', id: a, reason: 'gone' },
        { op: 'edit', id: a, title: 'x' },
      ],
    },
    {
      name: 'create depending on a cancelled issue',
      reason: /create "x": dependency ".*" is cancelled/,
      ops: ({ a }, deps) => {
        expect(applyPlan(deps, P, plan([{ op: 'cancel', id: a, reason: 'gone' }]), 1).ok).toBe(
          true,
        );
        return [create('x', [a])];
      },
    },
    {
      name: 'edit to depend on a cancelled issue',
      reason: /edit #2: dependency ".*" is cancelled/,
      ops: ({ a, b }) => [
        create('x'),
        { op: 'cancel', id: a, reason: 'gone' },
        { op: 'edit', id: b, dependsOn: [a] },
      ],
    },
    {
      name: 'cancel then create depending on it in the same plan',
      reason: /create "x": dependency ".*" is cancelled/,
      ops: ({ a }) => [{ op: 'cancel', id: a, reason: 'gone' }, create('x', [a])],
    },
    {
      name: 'a valid op followed by an invalid one',
      reason: /unknown dependency/,
      ops: () => [create('fine'), create('bad', ['missing'])],
    },
  ];

  it.each(cases)('$name', ({ ops, reason }) => {
    const { store, deps } = setup();
    const ids = seedIssues(deps);
    const issueOps = ops(ids, deps);
    const before = store.snapshot();
    const r = applyPlan(deps, P, plan(issueOps, ['a question']), 7);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(reason) });
    expect(store.snapshot()).toStrictEqual(before);
    expect(before.state.products[P]?.orchestratorCursor).toBe(1);
  });

  it('refuses an unknown product', () => {
    const { deps } = setup();
    expectNothingCommitted(deps, () =>
      applyPlan(deps, ProductIdSchema.parse('nope'), plan([create('x')]), 1),
    );
  });

  it('refuses to move the cursor backwards', () => {
    const { deps } = setup();
    seedIssues(deps);
    expectNothingCommitted(deps, () => applyPlan(deps, P, plan([create('x')]), 0));
  });

  it('refuses a malformed plan', () => {
    const { deps } = setup();
    expectNothingCommitted(deps, () =>
      applyPlan(deps, P, { issueOps: [], questions: [''], summary: 's' }, 1),
    );
  });

  it('the cursor only advances on success', () => {
    const { store, deps } = setup();
    expect(applyPlan(deps, P, plan([create('x', ['y'])]), 5).ok).toBe(false);
    expect(store.snapshot().state.products[P]?.orchestratorCursor).toBe(0);
    expect(applyPlan(deps, P, plan([create('x')]), 5).ok).toBe(true);
    expect(store.snapshot().state.products[P]?.orchestratorCursor).toBe(5);
    expectSnapshotMatchesReplay(store);
  });
});

describe('applyPlan options: project config and replan summary', () => {
  const PROJECT = { check: ['npm', 'test'], imageInputs: ['package-lock.json'] };

  it('stores the project config and posts the replan inbox item in the same commit', () => {
    const { store, deps } = setup();
    store.commit(() => [
      draft('prd.applied', P, null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    const before = store.snapshot().lastSeq;

    const r = applyPlan(deps, P, plan([create('x')]), 3, {
      project: PROJECT,
      replan: { version: 2, summary: 'Added dark mode issues' },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.map((e) => e.type)).toEqual([
      'issue.created',
      'product.settings_changed',
      'prd.summarized',
      'inbox.created',
      'orchestrator.cursor_advanced',
    ]);
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5].map((n) => before + n));
    const { state } = store.snapshot();
    expect(state.products[P]?.project).toEqual(PROJECT);
    expect(Object.values(state.inbox)).toMatchObject([
      { productId: P, kind: 'replan', body: 'Added dark mode issues', link: `/products/${P}` },
    ]);
    expect(state.prdVersions[P]?.find((v) => v.version === 2)?.summary).toBe(
      'Added dark mode issues',
    );
    expectSnapshotMatchesReplay(store);
  });

  it('without options emits neither settings nor inbox events', () => {
    const { deps } = setup();
    const r = applyPlan(deps, P, plan([create('x')]), 3, {});
    expect(r.ok && r.events.map((e) => e.type)).toEqual([
      'issue.created',
      'orchestrator.cursor_advanced',
    ]);
  });

  it('a failing plan commits neither the project config nor the replan item', () => {
    const { store, deps } = setup();
    expectNothingCommitted(deps, () =>
      applyPlan(deps, P, plan([create('x', ['missing'])]), 3, {
        project: PROJECT,
        replan: { version: 2, summary: 'summary' },
      }),
    );
    const { state } = store.snapshot();
    expect(state.products[P]?.project).toBeNull();
    expect(Object.values(state.inbox)).toEqual([]);
  });

  it('refuses an invalid project config', () => {
    const { deps } = setup();
    expectNothingCommitted(deps, () =>
      applyPlan(deps, P, plan([create('x')]), 3, {
        project: { check: [], imageInputs: ['../etc/passwd'] },
      }),
    );
  });
});
