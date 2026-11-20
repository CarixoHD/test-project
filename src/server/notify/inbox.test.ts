import { describe, expect, it } from 'vitest';
import type { AttemptStatus, IssueView } from '../../shared/domain.ts';
import type { EventDraft } from '../../shared/events.ts';
import {
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
} from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { inboxHook, inboxRoutes, markInboxRead } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const I = IssueIdSchema.parse('issue-1');
const Q = QuestionIdSchema.parse('question-1');
const AT = AttemptIdSchema.parse('attempt-1');
const T0 = 1_700_000_000_000;

function setup() {
  const db = open(':memory:');
  const clock = new FakeClock(T0);
  const ids = new FakeIdGen();
  const redactor = new Redactor();
  const store = createStore({
    db,
    clock,
    redactor,
    hooks: [inboxHook({ ids, timeZone: 'UTC' })],
  });
  return { db, clock, redactor, store };
}

const productCreated: EventDraft = {
  type: 'product.created',
  productId: P,
  entityId: null,
  v: 1,
  data: {
    name: 'Todo',
    idea: 'todos',
    budgetUsd: 10,
    maxParallel: 2,
    maxAttempts: 2,
    models: {},
    gitRemote: null,
  },
};

const issue: IssueView = {
  id: I,
  number: 1,
  title: 'Login form',
  body: 'Do it',
  status: 'open',
  rev: 1,
  priority: 1,
  origin: 'orchestrator',
  prdVersion: 1,
  attemptCount: 0,
  heldQuestionId: null,
  runAfter: 0,
  mergedOrder: null,
  mergeSha: null,
  failureReason: null,
  dependsOn: [],
};

/** A product with one in-progress issue, so every rule has something to talk about. */
function seeded() {
  const ctx = setup();
  ctx.store.commit(() => [
    productCreated,
    { type: 'issue.created', productId: P, entityId: I, v: 1, data: { issue } },
    {
      type: 'issue.status_changed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'open', to: 'in_progress', attemptCount: 0, runAfter: 0 },
    },
  ]);
  return ctx;
}

const attemptStarted: EventDraft = {
  type: 'attempt.started',
  productId: P,
  entityId: AT,
  v: 1,
  data: { issueId: I, n: 1, issueRev: 1, baseSha: 'a'.repeat(40), branch: 'vibecode/issue-1' },
};

function attemptEnded(
  status: Exclude<AttemptStatus, 'running'>,
  feedback: string | null,
  counted = false,
): EventDraft {
  return {
    type: 'attempt.ended',
    productId: P,
    entityId: AT,
    v: 1,
    data: {
      issueId: I,
      status,
      counted,
      headSha: null,
      feedback,
      review: null,
      checkExit: null,
      interruptReason: status === 'interrupted' ? 'issue_changed' : null,
    },
  };
}

/** `seeded()` plus a running attempt on the issue. */
function withAttempt() {
  const ctx = seeded();
  ctx.store.commit(() => [attemptStarted]);
  return ctx;
}

const sources: { kind: string; draft: EventDraft }[] = [
  {
    kind: 'question',
    draft: {
      type: 'question.asked',
      productId: P,
      entityId: Q,
      v: 1,
      data: { target: 'issue', issueId: I, agentId: null, text: 'OAuth?' },
    },
  },
  {
    kind: 'failed',
    draft: {
      type: 'issue.failed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_progress', attemptCount: 2, reason: 'checks failed' },
    },
  },
  {
    kind: 'budget_warn',
    draft: {
      type: 'budget.warned',
      productId: P,
      entityId: null,
      v: 1,
      data: { spentUsd: 8, budgetUsd: 10 },
    },
  },
  {
    kind: 'budget_paused',
    draft: {
      type: 'product.paused',
      productId: P,
      entityId: null,
      v: 1,
      data: { reason: 'budget' },
    },
  },
  {
    kind: 'rate_limited',
    draft: {
      type: 'backend.limited',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code', until: T0 + 60_000, needsLogin: false, reason: 'limit' },
    },
  },
  {
    kind: 'auth_required',
    draft: {
      type: 'backend.limited',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code', until: null, needsLogin: true, reason: 'Login expired' },
    },
  },
  {
    kind: 'complete',
    draft: {
      type: 'product.phase_changed',
      productId: P,
      entityId: null,
      v: 1,
      data: { phase: 'complete' },
    },
  },
];

describe('inbox hook in store.commit', () => {
  it.each(sources)('$draft.type creates exactly one $kind item in the same commit', (c) => {
    const { store } = seeded();
    const committed = store.commit(() => [c.draft]);

    expect(committed.map((e) => e.type)).toEqual([c.draft.type, 'inbox.created']);
    const [source, created] = committed;
    expect(created).toMatchObject({
      seq: (source?.seq ?? 0) + 1,
      ts: source?.ts,
      productId: c.draft.productId,
      data: { kind: c.kind },
    });
    const items = Object.values(store.snapshot().state.inbox);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: created?.entityId, kind: c.kind, read: false });
    expectSnapshotMatchesReplay(store);
  });

  it('creates no inbox item for events without a rule', () => {
    const { store } = setup();
    const committed = store.commit(() => [
      productCreated,
      { type: 'product.paused', productId: P, entityId: null, v: 1, data: { reason: 'owner' } },
      { type: 'product.resumed', productId: P, entityId: null, v: 1, data: {} },
    ]);
    expect(committed.map((e) => e.type)).not.toContain('inbox.created');
    expect(store.snapshot().state.inbox).toEqual({});
  });

  it('uses names the same commit just created', () => {
    const { store } = setup();
    store.commit(() => [
      productCreated,
      {
        type: 'product.phase_changed',
        productId: P,
        entityId: null,
        v: 1,
        data: { phase: 'complete' },
      },
    ]);
    expect(Object.values(store.snapshot().state.inbox)[0]?.title).toBe('Todo is complete');
  });

  it('rolls the inbox item back with its source event', () => {
    const { store, db } = seeded();
    const before = store.snapshot().lastSeq;
    const invalid = { type: 'spar.message', productId: P, entityId: 'm', v: 1, data: {} };
    expect(() =>
      store.commit(() => [sources[0]?.draft as EventDraft, invalid as EventDraft]),
    ).toThrow();

    expect(store.snapshot().lastSeq).toBe(before);
    expect(db.$client.prepare('SELECT count(*) FROM inbox').pluck().get()).toBe(0);
    expect(db.$client.prepare('SELECT count(*) FROM questions').pluck().get()).toBe(0);
  });
});

describe('inbox hook for attempt.ended', () => {
  it('creates one error item linking the issue with the redacted message', () => {
    const { store, redactor } = withAttempt();
    redactor.register('sk-secret-123456');
    const committed = store.commit(() => [
      attemptEnded('error', 'docker run failed: token sk-secret-123456 rejected'),
    ]);

    expect(committed.map((e) => e.type)).toEqual(['attempt.ended', 'inbox.created']);
    const items = Object.values(store.snapshot().state.inbox);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      productId: P,
      kind: 'error',
      title: 'Attempt on #1 Login form hit an error',
      link: `/products/${P}/issues/${I}`,
      read: false,
    });
    expect(item?.body).toContain('docker run failed: token');
    expect(item?.body).not.toContain('sk-secret-123456');
    expectSnapshotMatchesReplay(store);
  });

  it.each([
    { status: 'merged', counted: false },
    { status: 'check_failed', counted: true },
    { status: 'rejected', counted: true },
    { status: 'conflict', counted: true },
    { status: 'interrupted', counted: false },
    { status: 'discarded', counted: false },
    { status: 'error', counted: true },
  ] as const)('creates no item for status $status (counted: $counted)', ({ status, counted }) => {
    const { store } = withAttempt();
    const committed = store.commit(() => [attemptEnded(status, 'why', counted)]);

    expect(committed.map((e) => e.type)).toEqual(['attempt.ended']);
    expect(store.snapshot().state.inbox).toEqual({});
    expectSnapshotMatchesReplay(store);
  });
});

describe('markInboxRead', () => {
  function withItem() {
    const ctx = seeded();
    const [, created] = ctx.store.commit(() => [sources[1]?.draft as EventDraft]);
    return { ...ctx, id: InboxIdSchema.parse(created?.entityId) };
  }

  it('emits inbox.read once and is idempotent', () => {
    const { store, id } = withItem();
    expect(markInboxRead(store, id)).toEqual({ ok: true });
    expect(markInboxRead(store, id)).toEqual({ ok: true });

    const reads = store.eventsSince(0).filter((e) => e.type === 'inbox.read');
    expect(reads.map((e) => e.entityId)).toEqual([id]);
    expect(store.snapshot().state.inbox[id]?.read).toBe(true);
    expectSnapshotMatchesReplay(store);
  });

  it('reports an unknown id as not found', () => {
    const { store } = setup();
    expect(markInboxRead(store, InboxIdSchema.parse('nope'))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(store.eventsSince(0)).toEqual([]);
  });
});

describe('POST /api/inbox/:id/read', () => {
  it('marks the item read', async () => {
    const { store } = seeded();
    const [, created] = store.commit(() => [sources[2]?.draft as EventDraft]);
    const id = InboxIdSchema.parse(created?.entityId);
    const app = inboxRoutes({ store });

    const res = await app.request(`/api/inbox/${id}/read`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.snapshot().state.inbox[id]?.read).toBe(true);

    const again = await app.request(`/api/inbox/${id}/read`, { method: 'POST' });
    expect(again.status).toBe(200);
  });

  it('answers 404 for an unknown id', async () => {
    const { store } = setup();
    const res = await inboxRoutes({ store }).request('/api/inbox/unknown/read', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Inbox item unknown not found' },
    });
  });
});

describe('inbox hook for question.withdrawn', () => {
  const asked = (id: string, text: string): EventDraft => ({
    type: 'question.asked',
    productId: P,
    entityId: QuestionIdSchema.parse(id),
    v: 1,
    data: { target: 'issue', issueId: I, agentId: null, text },
  });
  const withdrawn = (id: string): EventDraft => ({
    type: 'question.withdrawn',
    productId: P,
    entityId: QuestionIdSchema.parse(id),
    v: 1,
    data: { reason: 'The issue was cancelled.' },
  });

  it("marks the question's inbox item read in the same commit and creates no item", () => {
    const { store } = seeded();
    const [, created] = store.commit(() => [asked('question-1', 'OAuth?')]);
    const [, other] = store.commit(() => [asked('question-2', 'Which theme?')]);

    const committed = store.commit(() => [withdrawn('question-1')]);

    expect(committed.map((e) => [e.type, e.entityId])).toEqual([
      ['question.withdrawn', 'question-1'],
      ['inbox.read', created?.entityId],
    ]);
    const inbox = store.snapshot().state.inbox;
    expect(Object.keys(inbox)).toHaveLength(2);
    expect(inbox[InboxIdSchema.parse(created?.entityId)]?.read).toBe(true);
    expect(inbox[InboxIdSchema.parse(other?.entityId)]?.read).toBe(false);
    expectSnapshotMatchesReplay(store);
  });

  it('emits nothing more when the item was already read', () => {
    const { store } = seeded();
    const [, created] = store.commit(() => [asked('question-1', 'OAuth?')]);
    expect(markInboxRead(store, InboxIdSchema.parse(created?.entityId)).ok).toBe(true);

    const committed = store.commit(() => [withdrawn('question-1')]);

    expect(committed.map((e) => e.type)).toEqual(['question.withdrawn']);
  });
});
