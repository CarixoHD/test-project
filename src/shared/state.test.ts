import { describe, expect, it } from 'vitest';
import type { IssueView } from './domain.ts';
import { EventSchema, type Event, type EventDraft } from './events.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
} from './ids.ts';
import { emptyState, reduce, type ClientState } from './state.ts';

// ---- fixtures ---------------------------------------------------------------------------

const P = ProductIdSchema.parse('01PRODUCT');
const I = IssueIdSchema.parse('01ISSUE');
const I2 = IssueIdSchema.parse('01ISSUE2');
const AT = AttemptIdSchema.parse('01ATTEMPT');
const AG = AgentIdSchema.parse('01AGENT');
const Q = QuestionIdSchema.parse('01QUESTION');
const IN = InboxIdSchema.parse('01INBOX');
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const T0 = 1_700_000_000_000;
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;
const CC_MODEL = { provider: 'claude-code', model: 'sonnet' } as const;
const PROJECT = { check: ['npm', 'test'], imageInputs: ['package-lock.json'] };

let nextSeq = 1;

/** Builds a fully validated event so fixtures cannot drift from the catalogue. */
function ev(draft: EventDraft, ts = T0 + nextSeq): Event {
  return EventSchema.parse({ ...draft, seq: nextSeq++, ts });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Reduces with frozen inputs: any mutation of the state or event throws (ESM is strict). */
function apply(state: ClientState, ...events: Event[]): ClientState {
  return events.reduce((s, e) => reduce(deepFreeze(s), deepFreeze(e)), state);
}

const productCreated = (): Event =>
  ev({
    type: 'product.created',
    productId: P,
    entityId: null,
    v: 1,
    data: {
      name: 'Todo',
      idea: 'A todo app',
      budgetUsd: 20,
      maxParallel: 3,
      maxAttempts: 3,
      models: { implementer: MODEL },
      gitRemote: null,
    },
  });

/** State with one product, created at seq 1. */
function withProduct(): ClientState {
  nextSeq = 1;
  return apply(emptyState, productCreated());
}

const product = (s: ClientState) => s.products[P]!;

/** One replay case: start from `given`, apply `when`, assert with `then`. */
type Case = {
  name: string;
  given?: () => ClientState;
  when: () => Event;
  then: (after: ClientState, before: ClientState) => void;
};

const PRODUCT_CASES: Case[] = [
  {
    name: 'product.settings_changed merges only the given settings and sets project',
    when: () =>
      ev({
        type: 'product.settings_changed',
        productId: P,
        entityId: null,
        v: 1,
        data: { budgetUsd: null, maxParallel: 5, project: PROJECT },
      }),
    then: (s) => {
      expect(product(s).settings).toEqual({
        budgetUsd: null,
        maxParallel: 5,
        maxAttempts: 3,
        models: { implementer: MODEL },
        gitRemote: null,
      });
      expect(product(s).project).toEqual(PROJECT);
    },
  },
  {
    name: 'product.settings_changed without project keeps the previous project',
    given: () =>
      apply(
        withProduct(),
        ev({
          type: 'product.settings_changed',
          productId: P,
          entityId: null,
          v: 1,
          data: { project: PROJECT },
        }),
      ),
    when: () =>
      ev({
        type: 'product.settings_changed',
        productId: P,
        entityId: null,
        v: 1,
        data: { gitRemote: { url: 'https://example.com/r.git' } },
      }),
    then: (s) => {
      expect(product(s).project).toEqual(PROJECT);
      expect(product(s).settings.gitRemote).toEqual({ url: 'https://example.com/r.git' });
    },
  },
  {
    name: 'product.handed_off moves to building at the handed-off PRD version',
    when: () =>
      ev({
        type: 'product.handed_off',
        productId: P,
        entityId: null,
        v: 1,
        data: { prdVersion: 1 },
      }),
    then: (s) => {
      expect(product(s).phase).toBe('building');
      expect(product(s).prdVersion).toBe(1);
    },
  },
  {
    name: 'product.paused records the reason',
    when: () =>
      ev({
        type: 'product.paused',
        productId: P,
        entityId: null,
        v: 1,
        data: { reason: 'budget' },
      }),
    then: (s) => {
      expect(product(s).paused).toBe(true);
      expect(product(s).pauseReason).toBe('budget');
    },
  },
  {
    name: 'product.resumed clears pause and reason',
    given: () =>
      apply(
        withProduct(),
        ev({
          type: 'product.paused',
          productId: P,
          entityId: null,
          v: 1,
          data: { reason: 'owner' },
        }),
      ),
    when: () => ev({ type: 'product.resumed', productId: P, entityId: null, v: 1, data: {} }),
    then: (s) => {
      expect(product(s).paused).toBe(false);
      expect(product(s).pauseReason).toBeNull();
    },
  },
  {
    name: 'product.phase_changed sets the phase',
    when: () =>
      ev({
        type: 'product.phase_changed',
        productId: P,
        entityId: null,
        v: 1,
        data: { phase: 'complete' },
      }),
    then: (s) => expect(product(s).phase).toBe('complete'),
  },
  {
    name: 'spar.message appends to the product conversation in order',
    given: () =>
      apply(
        withProduct(),
        ev({
          type: 'spar.message',
          productId: P,
          entityId: 'm1',
          v: 1,
          data: { role: 'owner', text: 'Build a todo app' },
        }),
      ),
    when: () =>
      ev(
        {
          type: 'spar.message',
          productId: P,
          entityId: 'm2',
          v: 1,
          data: { role: 'agent', text: 'Who is it for?' },
        },
        T0 + 50,
      ),
    then: (s) => {
      expect(s.sparMessages[P]).toEqual([
        { id: 'm1', role: 'owner', text: 'Build a todo app', createdAt: T0 + 2 },
        { id: 'm2', role: 'agent', text: 'Who is it for?', createdAt: T0 + 50 },
      ]);
    },
  },
  {
    name: 'prd.draft_saved replaces the draft',
    when: () =>
      ev(
        {
          type: 'prd.draft_saved',
          productId: P,
          entityId: null,
          v: 1,
          data: { markdown: '# PRD', baseVersion: 0 },
        },
        T0 + 99,
      ),
    then: (s) =>
      expect(s.prdDrafts[P]).toEqual({ markdown: '# PRD', baseVersion: 0, updatedAt: T0 + 99 }),
  },
  {
    name: 'prd.applied appends version metadata, bumps prdVersion and rebases the draft',
    given: () =>
      apply(
        withProduct(),
        ev({
          type: 'prd.applied',
          productId: P,
          entityId: null,
          v: 1,
          data: { version: 1, markdown: '# v1', summary: null },
        }),
      ),
    when: () =>
      ev(
        {
          type: 'prd.applied',
          productId: P,
          entityId: null,
          v: 1,
          data: { version: 2, markdown: '# v2', summary: 'Added sharing' },
        },
        T0 + 200,
      ),
    then: (s) => {
      expect(s.prdVersions[P]).toEqual([
        { version: 1, summary: null, createdAt: T0 + 2 },
        { version: 2, summary: 'Added sharing', createdAt: T0 + 200 },
      ]);
      expect(product(s).prdVersion).toBe(2);
      expect(s.prdDrafts[P]).toEqual({ markdown: '# v2', baseVersion: 2, updatedAt: T0 + 200 });
    },
  },
  {
    name: 'orchestrator.cursor_advanced moves the cursor',
    when: () =>
      ev({
        type: 'orchestrator.cursor_advanced',
        productId: P,
        entityId: null,
        v: 1,
        data: { cursor: 42 },
      }),
    then: (s) => expect(product(s).orchestratorCursor).toBe(42),
  },
  {
    name: 'budget.warned marks the warning as sent',
    when: () =>
      ev({
        type: 'budget.warned',
        productId: P,
        entityId: null,
        v: 1,
        data: { spentUsd: 16, budgetUsd: 20 },
      }),
    then: (s) => expect(product(s).budgetWarned).toBe(true),
  },
  {
    name: 'preview.started records the running preview',
    when: () =>
      ev(
        {
          type: 'preview.started',
          productId: P,
          entityId: null,
          v: 1,
          data: { url: 'http://127.0.0.1:49152/', container: 'vibecode-01RUN' },
        },
        T0 + 7,
      ),
    then: (s) =>
      expect(s.previews[P]).toEqual({
        url: 'http://127.0.0.1:49152/',
        container: 'vibecode-01RUN',
        startedAt: T0 + 7,
      }),
  },
  {
    name: 'preview.stopped removes the preview',
    given: () =>
      apply(
        withProduct(),
        ev({
          type: 'preview.started',
          productId: P,
          entityId: null,
          v: 1,
          data: { url: 'http://127.0.0.1:49152/', container: 'vibecode-01RUN' },
        }),
      ),
    when: () => ev({ type: 'preview.stopped', productId: P, entityId: null, v: 1, data: {} }),
    then: (s) => expect(s.previews).toEqual({}),
  },
];

const ISSUE_VIEW: IssueView = {
  id: I,
  number: 1,
  title: 'Add login',
  body: 'As the owner…',
  status: 'open',
  rev: 1,
  priority: 0,
  origin: 'orchestrator',
  prdVersion: 1,
  attemptCount: 0,
  heldQuestionId: null,
  runAfter: 0,
  mergedOrder: null,
  mergeSha: null,
  failureReason: null,
  dependsOn: [I2],
};

const issueCreated = (view: IssueView = ISSUE_VIEW): Event =>
  ev({ type: 'issue.created', productId: P, entityId: view.id, v: 1, data: { issue: view } });

const issue = (s: ClientState) => s.issues[I]!;

/** Product plus issue I in the given status. */
function withIssue(over: Partial<IssueView> = {}): ClientState {
  return apply(withProduct(), issueCreated({ ...ISSUE_VIEW, ...over }));
}

const ISSUE_CASES: Case[] = [
  {
    name: 'issue.created adds the issue view under its product',
    when: () => issueCreated(),
    then: (s) => expect(s.issues[I]).toEqual({ ...ISSUE_VIEW, productId: P }),
  },
  {
    name: 'issue.edited applies the given fields and the new rev',
    given: () => withIssue(),
    when: () =>
      ev({
        type: 'issue.edited',
        productId: P,
        entityId: I,
        v: 1,
        data: { rev: 2, title: 'Add login page', dependsOn: [] },
      }),
    then: (s) => {
      expect(issue(s)).toMatchObject({ rev: 2, title: 'Add login page', dependsOn: [] });
      expect(issue(s).body).toBe(ISSUE_VIEW.body);
    },
  },
  {
    name: 'issue.status_changed sets status, attempt count and runAfter',
    given: () => withIssue({ status: 'in_progress' }),
    when: () =>
      ev({
        type: 'issue.status_changed',
        productId: P,
        entityId: I,
        v: 1,
        data: { from: 'in_progress', to: 'open', attemptCount: 1, runAfter: T0 + 5000 },
      }),
    then: (s) =>
      expect(issue(s)).toMatchObject({ status: 'open', attemptCount: 1, runAfter: T0 + 5000 }),
  },
  {
    name: 'issue.held records the blocking question',
    given: () => withIssue(),
    when: () =>
      ev({ type: 'issue.held', productId: P, entityId: I, v: 1, data: { questionId: Q } }),
    then: (s) => expect(issue(s).heldQuestionId).toBe(Q),
  },
  {
    name: 'issue.released clears the hold',
    given: () => withIssue({ heldQuestionId: Q }),
    when: () =>
      ev({ type: 'issue.released', productId: P, entityId: I, v: 1, data: { questionId: Q } }),
    then: (s) => expect(issue(s).heldQuestionId).toBeNull(),
  },
  {
    name: 'issue.cancelled sets status cancelled',
    given: () => withIssue({ status: 'in_review' }),
    when: () =>
      ev({
        type: 'issue.cancelled',
        productId: P,
        entityId: I,
        v: 1,
        data: { from: 'in_review', by: 'owner', reason: 'not needed' },
      }),
    then: (s) => expect(issue(s).status).toBe('cancelled'),
  },
  {
    name: 'issue.completed records merge order and sha',
    given: () => withIssue({ status: 'in_review' }),
    when: () =>
      ev({
        type: 'issue.completed',
        productId: P,
        entityId: I,
        v: 1,
        data: { attemptId: AT, mergedOrder: 3, mergeSha: SHA },
      }),
    then: (s) =>
      expect(issue(s)).toMatchObject({ status: 'completed', mergedOrder: 3, mergeSha: SHA }),
  },
  {
    name: 'issue.failed records the reason and the final attempt count',
    given: () => withIssue({ status: 'in_progress', attemptCount: 2 }),
    when: () =>
      ev({
        type: 'issue.failed',
        productId: P,
        entityId: I,
        v: 1,
        data: { from: 'in_progress', attemptCount: 3, reason: 'checks keep failing' },
      }),
    then: (s) =>
      expect(issue(s)).toMatchObject({
        status: 'failed',
        attemptCount: 3,
        failureReason: 'checks keep failing',
      }),
  },
  {
    name: 'issue.rewritten reopens with a new body and resets attempts and failure',
    given: () =>
      withIssue({ status: 'failed', attemptCount: 3, failureReason: 'checks keep failing' }),
    when: () =>
      ev({
        type: 'issue.rewritten',
        productId: P,
        entityId: I,
        v: 1,
        data: { rev: 2, body: 'Smaller scope' },
      }),
    then: (s) =>
      expect(issue(s)).toMatchObject({
        status: 'open',
        rev: 2,
        body: 'Smaller scope',
        attemptCount: 0,
        failureReason: null,
      }),
  },
];

const ALL_CASES: Case[] = [...PRODUCT_CASES, ...ISSUE_CASES];

// ---- tests ------------------------------------------------------------------------------

describe('replay per event type', () => {
  it.each(ALL_CASES)('$name', (c) => {
    const before = (c.given ?? withProduct)();
    const e = c.when();
    const after = apply(before, e);
    c.then(after, before);
    expect(after.lastSeq).toBe(e.seq);
  });
});

describe('emptyState', () => {
  it('has no entities and lastSeq 0', () => {
    expect(emptyState.lastSeq).toBe(0);
    expect(emptyState.products).toEqual({});
    expect(emptyState.issues).toEqual({});
  });
});

describe('product events', () => {
  it('product.created adds a sparring product with its settings', () => {
    const s = withProduct();
    expect(s.products[P]).toEqual({
      id: P,
      name: 'Todo',
      idea: 'A todo app',
      createdAt: T0 + 1,
      settings: {
        budgetUsd: 20,
        maxParallel: 3,
        maxAttempts: 3,
        models: { implementer: MODEL },
        gitRemote: null,
      },
      phase: 'sparring',
      paused: false,
      pauseReason: null,
      budgetWarned: false,
      prdVersion: 0,
      project: null,
      orchestratorCursor: 0,
    });
    expect(s.lastSeq).toBe(1);
  });
});
