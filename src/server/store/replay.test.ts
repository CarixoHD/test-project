import { describe, expect, it } from 'vitest';
import type { IssueView } from '../../shared/domain.ts';
import { EVENT_TYPES, type EventDraft } from '../../shared/events.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
  type AgentId,
  type AttemptId,
  type IssueId,
  type ProductId,
} from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { FakeClock } from '../util/clock.ts';
import { createStore } from './index.ts';
import { expectSnapshotMatchesReplay } from './testing.ts';

// The snapshot≡replay invariant over a hand-written command sequence that contains every
// event type of the catalogue at least once (the coverage test fails for a new type).

const P = ProductIdSchema.parse('product-1');
const P2 = ProductIdSchema.parse('product-2');
const I1 = IssueIdSchema.parse('issue-1');
const I2 = IssueIdSchema.parse('issue-2');
const I3 = IssueIdSchema.parse('issue-3');
const AT1 = AttemptIdSchema.parse('attempt-1');
const AT2 = AttemptIdSchema.parse('attempt-2');
const AG1 = AgentIdSchema.parse('agent-1');
const AG2 = AgentIdSchema.parse('agent-2');
const Q1 = QuestionIdSchema.parse('question-1');
const IN1 = InboxIdSchema.parse('inbox-1');
const IN2 = InboxIdSchema.parse('inbox-2');
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;
const CC = { provider: 'claude-code', model: 'sonnet' } as const;

// Drafts are loosely typed here on purpose: commit() validates every one with zod.
const onProduct = (type: string, data: object, productId: ProductId | null = P): EventDraft =>
  ({ type, productId, entityId: null, v: 1, data }) as EventDraft;
const on = (
  type: string,
  entityId: string,
  data: object,
  productId: ProductId | null = P,
): EventDraft => ({ type, productId, entityId, v: 1, data }) as EventDraft;

const issue = (id: IssueId, number: number, dependsOn: IssueId[] = []): IssueView => ({
  id,
  number,
  title: `Issue ${number}`,
  body: 'Do it',
  status: 'open',
  rev: 1,
  priority: number,
  origin: 'orchestrator',
  prdVersion: 1,
  attemptCount: 0,
  heldQuestionId: null,
  runAfter: 0,
  mergedOrder: null,
  mergeSha: null,
  failureReason: null,
  dependsOn,
});

let usageN = 0;
function usage(over: {
  billing?: 'api' | 'subscription';
  costUsd?: number | null;
  issueId?: IssueId | null;
  attemptId?: AttemptId | null;
  agentId?: AgentId;
}): EventDraft {
  const billing = over.billing ?? 'api';
  const costUsd = over.costUsd === undefined ? (billing === 'api' ? 0.1 : null) : over.costUsd;
  return on('usage.recorded', `usage-${++usageN}`, {
    agentId: over.agentId ?? AG1,
    role: 'implementer',
    model: billing === 'api' ? MODEL : CC,
    issueId: over.issueId === undefined ? I1 : over.issueId,
    attemptId: over.attemptId === undefined ? AT1 : over.attemptId,
    billing,
    tokens: { input: 1200, output: 340, cacheRead: 50, cacheWrite: 7, reasoning: 11 },
    webSearches: 0,
    calls: 2,
    costUsd,
    unpriced: billing === 'api' && costUsd === null,
    estCostUsd: billing === 'subscription' ? 0.42 : null,
    source: billing === 'api' ? 'computed' : 'cli',
  });
}

const ended = (status: string, extra: object = {}) => ({
  issueId: I1,
  status,
  counted: status !== 'interrupted',
  headSha: SHA2,
  feedback: null,
  review: null,
  checkExit: null,
  interruptReason: null,
  ...extra,
});

/** Each inner array is one commit (one owner/scheduler command). */
function commands(): EventDraft[][] {
  usageN = 0;
  const settings = { budgetUsd: 1, maxParallel: 2, maxAttempts: 2, gitRemote: null };
  return [
    [
      onProduct('product.created', {
        name: 'Todo',
        idea: 'todos',
        ...settings,
        models: { implementer: MODEL },
      }),
    ],
    [
      onProduct(
        'product.created',
        { name: 'Other', idea: '', ...settings, budgetUsd: null, models: {} },
        P2,
      ),
    ],
    [
      on('spar.message', 'spar-1', { role: 'owner', text: 'a todo app' }),
      on('spar.message', 'spar-2', { role: 'agent', text: 'Sure' }),
    ],
    [usage({ billing: 'subscription', issueId: null, attemptId: null })],
    [onProduct('prd.draft_saved', { markdown: '# Todo', baseVersion: 0 })],
    [
      onProduct('prd.applied', { version: 1, markdown: '# Todo v1', summary: null }),
      onProduct('product.handed_off', { prdVersion: 1 }),
    ],
    [
      on('issue.created', I1, { issue: issue(I1, 1) }),
      on('issue.created', I3, { issue: issue(I3, 3, [I2, I1]) }), // depends on an issue created later
      on('issue.created', I2, { issue: issue(I2, 2, [I1]) }),
      onProduct('orchestrator.cursor_advanced', { cursor: 6 }),
    ],
    [
      onProduct('product.settings_changed', {
        maxParallel: 4,
        gitRemote: { url: 'https://example.com/r.git' },
        project: { check: ['npm', 'test'], imageInputs: ['package-lock.json'] },
      }),
    ],
    [on('issue.edited', I3, { rev: 2, title: 'Issue three', dependsOn: [I1, I2] })],
    // attempt 1: rejected
    [
      on('issue.status_changed', I1, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      on('attempt.started', AT1, {
        issueId: I1,
        n: 1,
        issueRev: 1,
        baseSha: SHA,
        branch: 'attempt/1',
      }),
      on('agent.spawned', AG1, { role: 'implementer', model: MODEL, issueId: I1, attemptId: AT1 }),
    ],
    [on('agent.activity', AG1, { lines: ['npm install', 'edit src/a.ts'] })],
    [usage({ costUsd: 0.1 }), usage({ costUsd: 0.2 })],
    [usage({ costUsd: 0.3 }), usage({ costUsd: null })],
    [on('agent.state', AG1, { state: 'rate_limited', until: 1_700_000_100_000 })],
    [
      onProduct(
        'backend.limited',
        { backend: 'anthropic', until: 1_700_000_100_000, needsLogin: false, reason: '429' },
        null as never,
      ),
    ],
    [
      onProduct(
        'backend.limited',
        { backend: 'claude-code', until: null, needsLogin: true, reason: 'login' },
        null as never,
      ),
    ],
    [
      onProduct('backend.cleared', { backend: 'anthropic' }, null),
      onProduct(
        'settings.changed',
        { sections: ['keys'], keys: [{ provider: 'anthropic', set: true }] },
        null,
      ),
      on('agent.state', AG1, { state: 'working', until: null }),
    ],
    [
      on('attempt.step', AT1, { issueId: I1, step: 'check' }),
      on('agent.exited', AG1, { outcome: 'ok' }),
    ],
    [
      on('issue.status_changed', I1, {
        from: 'in_progress',
        to: 'in_review',
        attemptCount: 0,
        runAfter: 0,
      }),
      on('attempt.step', AT1, { issueId: I1, step: 'review' }),
      on('agent.spawned', AG2, { role: 'reviewer', model: CC, issueId: I1, attemptId: AT1 }),
    ],
    [usage({ billing: 'subscription', agentId: AG2 })],
    [
      on(
        'attempt.ended',
        AT1,
        ended('rejected', {
          feedback: 'missing tests',
          review: { approve: false, findings: ['no tests'] },
          checkExit: 0,
        }),
      ),
      on('issue.status_changed', I1, {
        from: 'in_review',
        to: 'open',
        attemptCount: 1,
        runAfter: 1_700_000_000_500,
      }),
      on('agent.exited', AG2, { outcome: 'ok' }),
    ],
    // a question holds the issue
    [
      on('question.asked', Q1, { target: 'issue', issueId: I1, agentId: AG1, text: 'Which DB?' }),
      on('issue.held', I1, { questionId: Q1 }),
      on('inbox.created', IN1, {
        kind: 'question',
        title: 'Question',
        body: 'Which DB?',
        link: '/products/product-1',
      }),
    ],
    [
      on('question.answered', Q1, { answer: 'SQLite' }),
      on('issue.released', I1, { questionId: Q1 }),
      on('inbox.read', IN1, {}),
    ],
    // attempt 2: merged
    [
      on('issue.status_changed', I1, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 1,
        runAfter: 1_700_000_000_500,
      }),
      on('attempt.started', AT2, {
        issueId: I1,
        n: 2,
        issueRev: 1,
        baseSha: SHA,
        branch: 'attempt/2',
      }),
    ],
    [usage({ costUsd: 0.7, attemptId: AT2 })],
    [
      on(
        'attempt.ended',
        AT2,
        ended('merged', { review: { approve: true, findings: [] }, checkExit: 0 }),
      ),
      on('issue.completed', I1, { attemptId: AT2, mergedOrder: 1, mergeSha: SHA2 }),
    ],
    [
      onProduct('budget.warned', { spentUsd: 0.8, budgetUsd: 1 }),
      onProduct('product.paused', { reason: 'budget' }),
    ],
    [onProduct('product.settings_changed', { budgetUsd: 5, budgetWarned: false })],
    [onProduct('product.resumed', {})],
    // issue 2 fails, then is rewritten; issue 3 is cancelled
    [
      on('issue.failed', I2, {
        from: 'in_progress',
        attemptCount: 2,
        reason: 'checks keep failing',
      }),
    ],
    [on('issue.rewritten', I2, { rev: 2, body: 'Smaller scope' })],
    [on('issue.cancelled', I3, { from: 'open', by: 'owner', reason: 'not needed' })],
    [
      on(
        'inbox.created',
        IN2,
        { kind: 'error', title: 'Docker down', body: 'Start Docker', link: null },
        null as never,
      ),
    ],
    [onProduct('preview.started', { url: 'http://127.0.0.1:5000/', container: 'c1' })],
    [
      onProduct('preview.stopped', {}),
      onProduct('preview.started', { url: 'http://127.0.0.1:5001/', container: 'c2' }, P2),
    ],
    [onProduct('prd.draft_saved', { markdown: '# Todo v2', baseVersion: 1 })],
    [onProduct('prd.applied', { version: 2, markdown: '# Todo v2!', summary: 'Adds sharing' })],
    [onProduct('prd.summarized', { version: 2, summary: 'Planned sharing issues' })],
    [onProduct('product.phase_changed', { phase: 'complete' })],
  ];
}

function setup() {
  const store = createStore({
    db: open(':memory:'),
    clock: new FakeClock(),
    redactor: new Redactor(),
  });
  return store;
}

describe('snapshot ≡ replay', () => {
  it('holds after every commit of a sequence covering the whole event catalogue', () => {
    const store = setup();
    for (const command of commands()) {
      store.commit(() => command);
      expectSnapshotMatchesReplay(store);
    }
  });

  it('the sample sequence contains every event type', () => {
    const used = new Set(
      commands()
        .flat()
        .map((d) => d.type),
    );
    expect(EVENT_TYPES.filter((t) => !used.has(t))).toEqual([]);
  });

  it('keeps exact float totals (no SUM reordering) and subscription usage apart', () => {
    const store = setup();
    for (const command of commands()) store.commit(() => command);
    const { state } = store.snapshot();
    // Same left-to-right addition as the reducer: ((0.1 + 0.2) + 0.3) + 0 + 0.7.
    expect(state.usage.byIssue[I1]?.apiUsd).toBe(0.1 + 0.2 + 0.3 + 0 + 0.7);
    expect(state.usage.byIssue[I1]?.apiUnpriced).toBe(true);
    expect(state.usage.byProduct[P]?.subscriptionCalls).toBe(4);
    expect(store.q.productUsage(P)).toEqual(state.usage.byProduct[P]);
    expect(store.q.issueUsage(I1)).toEqual(state.usage.byIssue[I1]);
    expect(store.q.issueUsage(I3).apiUsd).toBe(0);
  });
});

describe('store.q', () => {
  it('reads products, issues and attempts in the ClientState shapes', () => {
    const store = setup();
    for (const command of commands()) store.commit(() => command);
    const { state } = store.snapshot();

    expect(store.q.product(P)).toEqual(state.products[P]);
    expect(store.q.product(ProductIdSchema.parse('nope'))).toBeNull();
    expect(store.q.issuesByProduct(P).map((i) => i.id)).toEqual([I1, I2, I3]);
    expect(store.q.issuesByProduct(P2)).toEqual([]);
    expect(store.q.issue(I3)).toEqual(state.issues[I3]);
    expect(store.q.issue(I3)?.dependsOn).toEqual([I1, I2]);
    expect(store.q.attemptsByIssue(I1).map((a) => [a.n, a.status])).toEqual([
      [1, 'rejected'],
      [2, 'merged'],
    ]);
    expect(store.q.attempt(AT1)).toEqual(state.attempts[AT1]);
  });

  it('keeps the last activity line of an exited agent', () => {
    const store = setup();
    for (const command of commands()) store.commit(() => command);
    expect(store.snapshot().state.agents[AG1]).toMatchObject({
      state: 'exited',
      lastActivity: 'edit src/a.ts',
    });
  });
});
