import { describe, expect, it } from 'vitest';
import type { IssueView } from './domain.ts';
import { EventSchema, type Event, type EventDraft, type EventOf } from './events.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
  type ProductId,
} from './ids.ts';
import { ClientStateSchema, emptyState, reduce, type ClientState } from './state.ts';

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

/** Narrows a lookup that the test expects to exist. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

const product = (s: ClientState) => must(s.products[P]);

/** One replay case: start from `given`, apply `when`, assert with `then`. */
type Case = {
  name: string;
  given?: () => ClientState;
  when: () => Event;
  then: (after: ClientState, before: ClientState) => void;
};

const PRODUCT_CASES: Case[] = [
  {
    name: 'product.created adds a sparring product with its settings',
    given: () => emptyState,
    when: productCreated,
    then: (s) =>
      expect(product(s)).toEqual({
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
      }),
  },
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

const issue = (s: ClientState) => must(s.issues[I]);

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

const attemptStarted = (): Event =>
  ev(
    {
      type: 'attempt.started',
      productId: P,
      entityId: AT,
      v: 1,
      data: { issueId: I, n: 1, issueRev: 1, baseSha: SHA, branch: 'attempt/01ATTEMPT' },
    },
    T0 + 10,
  );

const attempt = (s: ClientState) => must(s.attempts[AT]);
const withAttempt = () => apply(withIssue({ status: 'in_progress' }), attemptStarted());

const ATTEMPT_CASES: Case[] = [
  {
    name: 'attempt.started adds a running, uncounted attempt at the implement step',
    given: () => withIssue({ status: 'in_progress' }),
    when: attemptStarted,
    then: (s) =>
      expect(attempt(s)).toEqual({
        id: AT,
        productId: P,
        issueId: I,
        n: 1,
        issueRev: 1,
        baseSha: SHA,
        branch: 'attempt/01ATTEMPT',
        headSha: null,
        status: 'running',
        step: 'implement',
        counted: false,
        feedback: null,
        review: null,
        checkExit: null,
        interruptReason: null,
        startedAt: T0 + 10,
        endedAt: null,
      }),
  },
  {
    name: 'attempt.step moves the attempt to the next step',
    given: withAttempt,
    when: () =>
      ev({
        type: 'attempt.step',
        productId: P,
        entityId: AT,
        v: 1,
        data: { issueId: I, step: 'review' },
      }),
    then: (s) => expect(attempt(s).step).toBe('review'),
  },
  {
    name: 'attempt.ended records outcome, feedback, review and check exit',
    given: withAttempt,
    when: () =>
      ev(
        {
          type: 'attempt.ended',
          productId: P,
          entityId: AT,
          v: 1,
          data: {
            issueId: I,
            status: 'rejected',
            counted: true,
            headSha: SHA2,
            feedback: 'missing tests',
            review: { approve: false, findings: ['missing tests'] },
            checkExit: 0,
            interruptReason: null,
          },
        },
        T0 + 900,
      ),
    then: (s) =>
      expect(attempt(s)).toMatchObject({
        status: 'rejected',
        counted: true,
        headSha: SHA2,
        feedback: 'missing tests',
        review: { approve: false, findings: ['missing tests'] },
        checkExit: 0,
        interruptReason: null,
        endedAt: T0 + 900,
      }),
  },
];

const agentSpawned = (): Event =>
  ev(
    {
      type: 'agent.spawned',
      productId: P,
      entityId: AG,
      v: 1,
      data: { role: 'implementer', model: MODEL, issueId: I, attemptId: AT },
    },
    T0 + 20,
  );

const agent = (s: ClientState) => must(s.agents[AG]);
const withAgent = () => apply(withAttempt(), agentSpawned());

const AGENT_CASES: Case[] = [
  {
    name: 'agent.spawned adds a working agent with provider and model',
    given: withAttempt,
    when: agentSpawned,
    then: (s) =>
      expect(agent(s)).toEqual({
        id: AG,
        productId: P,
        role: 'implementer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        issueId: I,
        attemptId: AT,
        state: 'working',
        until: null,
        lastActivity: null,
        startedAt: T0 + 20,
        endedAt: null,
      }),
  },
  {
    name: 'agent.state sets state and until',
    given: withAgent,
    when: () =>
      ev({
        type: 'agent.state',
        productId: P,
        entityId: AG,
        v: 1,
        data: { state: 'rate_limited', until: T0 + 60_000 },
      }),
    then: (s) => expect(agent(s)).toMatchObject({ state: 'rate_limited', until: T0 + 60_000 }),
  },
  {
    name: 'agent.activity keeps only the last line',
    given: withAgent,
    when: () =>
      ev({
        type: 'agent.activity',
        productId: P,
        entityId: AG,
        v: 1,
        data: { lines: ['read_file src/a.ts', 'run npm test'] },
      }),
    then: (s, before) => {
      expect(agent(s).lastActivity).toBe('run npm test');
      expect({ ...s, agents: before.agents, lastSeq: before.lastSeq }).toEqual(before);
      expect({ ...agent(s), lastActivity: null }).toEqual(before.agents[AG]);
    },
  },
  {
    name: 'agent.exited marks the agent exited and clears until',
    given: () =>
      apply(
        withAgent(),
        ev({
          type: 'agent.state',
          productId: P,
          entityId: AG,
          v: 1,
          data: { state: 'rate_limited', until: T0 + 60_000 },
        }),
      ),
    when: () =>
      ev(
        { type: 'agent.exited', productId: P, entityId: AG, v: 1, data: { outcome: 'ok' } },
        T0 + 5000,
      ),
    then: (s) =>
      expect(agent(s)).toMatchObject({ state: 'exited', until: null, endedAt: T0 + 5000 }),
  },
];

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

type UsageData = EventOf<'usage.recorded'>['data'];

const API_USAGE: UsageData = {
  agentId: AG,
  role: 'implementer',
  model: MODEL,
  issueId: I,
  attemptId: AT,
  billing: 'api',
  tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  webSearches: 0,
  calls: 1,
  costUsd: 0.5,
  unpriced: false,
  estCostUsd: null,
  source: 'computed',
};

const SUBSCRIPTION_USAGE: UsageData = {
  ...API_USAGE,
  model: CC_MODEL,
  billing: 'subscription',
  tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 0 },
  calls: 2,
  costUsd: null,
  estCostUsd: 0.75,
  source: 'cli',
};

let usageRow = 0;
const usage = (over: Partial<UsageData> = {}): Event =>
  ev({
    type: 'usage.recorded',
    productId: P,
    entityId: `u${++usageRow}`,
    v: 1,
    data: { ...API_USAGE, ...over },
  });

const USAGE_CASES: Case[] = [
  {
    name: 'usage.recorded (api, priced) adds USD to product and issue totals',
    given: () => apply(withIssue(), usage({ costUsd: 0.25 })),
    when: () => usage(),
    then: (s) => {
      const expected = {
        apiUsd: 0.75,
        apiUnpriced: false,
        subscriptionTokens: ZERO_TOKENS,
        subscriptionCalls: 0,
      };
      expect(s.usage.byProduct[P]).toEqual(expected);
      expect(s.usage.byIssue[I]).toEqual(expected);
    },
  },
  {
    name: 'usage.recorded (api, unpriced) sets the unpriced flag and adds no USD',
    given: () => apply(withIssue(), usage()),
    when: () => usage({ costUsd: null, unpriced: true }),
    then: (s) => {
      expect(s.usage.byProduct[P]).toMatchObject({ apiUsd: 0.5, apiUnpriced: true });
      expect(s.usage.byIssue[I]).toMatchObject({ apiUsd: 0.5, apiUnpriced: true });
    },
  },
  {
    name: 'usage.recorded (subscription) adds tokens and calls, never USD',
    given: () => apply(withIssue(), usage({ ...SUBSCRIPTION_USAGE })),
    when: () => usage({ ...SUBSCRIPTION_USAGE }),
    then: (s) => {
      const expected = {
        apiUsd: 0,
        apiUnpriced: false,
        subscriptionTokens: { input: 20, output: 40, cacheRead: 60, cacheWrite: 80, reasoning: 0 },
        subscriptionCalls: 4,
      };
      expect(s.usage.byProduct[P]).toEqual(expected);
      expect(s.usage.byIssue[I]).toEqual(expected);
    },
  },
  {
    name: 'usage.recorded without an issue only counts towards the product',
    when: () => usage({ issueId: null, attemptId: null, role: 'orchestrator' }),
    then: (s) => {
      expect(s.usage.byProduct[P]?.apiUsd).toBe(0.5);
      expect(s.usage.byIssue).toEqual({});
    },
  },
];

const question = (s: ClientState) => must(s.questions[Q]);
const questionAsked = (): Event =>
  ev(
    {
      type: 'question.asked',
      productId: P,
      entityId: Q,
      v: 1,
      data: { target: 'issue', issueId: I, agentId: AG, text: 'Which auth provider?' },
    },
    T0 + 30,
  );

const inboxCreated = (productId: ProductId | null = P): Event =>
  ev(
    {
      type: 'inbox.created',
      productId,
      entityId: IN,
      v: 1,
      data: { kind: 'question', title: 'Question on #1', body: 'Which?', link: '/products/x' },
    },
    T0 + 40,
  );

const limited = (backend = 'claude-code'): Event =>
  ev({
    type: 'backend.limited',
    productId: null,
    entityId: null,
    v: 1,
    data: { backend, until: T0 + 3_600_000, needsLogin: false, reason: 'usage limit' },
  });

const ACCOUNT_CASES: Case[] = [
  {
    name: 'question.asked adds an unanswered question',
    given: () => withIssue(),
    when: questionAsked,
    then: (s) =>
      expect(question(s)).toEqual({
        id: Q,
        productId: P,
        issueId: I,
        agentId: AG,
        target: 'issue',
        text: 'Which auth provider?',
        answer: null,
        createdAt: T0 + 30,
        answeredAt: null,
      }),
  },
  {
    name: 'question.answered records the answer and time',
    given: () => apply(withIssue(), questionAsked()),
    when: () =>
      ev(
        { type: 'question.answered', productId: P, entityId: Q, v: 1, data: { answer: 'GitHub' } },
        T0 + 300,
      ),
    then: (s) => expect(question(s)).toMatchObject({ answer: 'GitHub', answeredAt: T0 + 300 }),
  },
  {
    name: 'inbox.created adds an unread item',
    when: () => inboxCreated(),
    then: (s) =>
      expect(s.inbox[IN]).toEqual({
        id: IN,
        productId: P,
        kind: 'question',
        title: 'Question on #1',
        body: 'Which?',
        link: '/products/x',
        read: false,
        createdAt: T0 + 40,
      }),
  },
  {
    name: 'inbox.created accepts account-wide items without a product',
    given: () => emptyState,
    when: () => inboxCreated(null),
    then: (s) => expect(s.inbox[IN]?.productId).toBeNull(),
  },
  {
    name: 'inbox.read marks the item read',
    given: () => apply(withProduct(), inboxCreated()),
    when: () => ev({ type: 'inbox.read', productId: P, entityId: IN, v: 1, data: {} }),
    then: (s) => expect(s.inbox[IN]?.read).toBe(true),
  },
  {
    name: 'backend.limited records the account-wide limit by backend',
    when: () => limited(),
    then: (s) =>
      expect(s.backendLimits['claude-code']).toEqual({
        backend: 'claude-code',
        until: T0 + 3_600_000,
        needsLogin: false,
        reason: 'usage limit',
      }),
  },
  {
    name: 'backend.cleared removes only that backend limit',
    given: () => apply(withProduct(), limited('claude-code'), limited('anthropic')),
    when: () =>
      ev({
        type: 'backend.cleared',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code' },
      }),
    then: (s) => expect(Object.keys(s.backendLimits)).toEqual(['anthropic']),
  },
  {
    name: 'settings.changed records when account settings changed, and nothing else',
    when: () =>
      ev(
        {
          type: 'settings.changed',
          productId: null,
          entityId: null,
          v: 1,
          data: { sections: ['keys'], keys: [{ provider: 'openai', set: true }] },
        },
        T0 + 500,
      ),
    then: (s, before) => {
      expect(s.settingsChangedAt).toBe(T0 + 500);
      expect({ ...s, settingsChangedAt: null, lastSeq: before.lastSeq }).toEqual(before);
    },
  },
];

const ALL_CASES: Case[] = [
  ...PRODUCT_CASES,
  ...ISSUE_CASES,
  ...ATTEMPT_CASES,
  ...AGENT_CASES,
  ...USAGE_CASES,
  ...ACCOUNT_CASES,
];

// ---- tests ------------------------------------------------------------------------------

describe('replay per event type', () => {
  it.each(ALL_CASES)('$name', (c) => {
    nextSeq = 1;
    const before = (c.given ?? withProduct)();
    const e = c.when();
    const after = apply(before, e);
    c.then(after, before);
    expect(after.lastSeq).toBe(e.seq);
  });
});

/** Everything except lastSeq, to tell a real reducer case from a pass-through. */
const content = ({ lastSeq: _lastSeq, ...rest }: ClientState) => rest;

describe('event catalogue coverage', () => {
  const catalogue = EventSchema.options.map((o) => o.shape.type.value);

  it.each(catalogue)('%s has a reducer case that changes state', (type) => {
    const cases = ALL_CASES.filter((c) => {
      nextSeq = 1;
      (c.given ?? withProduct)();
      return c.when().type === type;
    });
    expect(cases, `no replay case for ${type}`).not.toHaveLength(0);
    for (const c of cases) {
      nextSeq = 1;
      const before = (c.given ?? withProduct)();
      const after = apply(before, c.when());
      expect(content(after)).not.toEqual(content(before));
    }
  });
});

describe('unknown and orphan events', () => {
  it('leaves state unchanged for an unknown event type', () => {
    const before = withIssue();
    const unknown = {
      seq: 99,
      ts: T0 + 99,
      type: 'issue.teleported',
      productId: P,
      entityId: I,
      v: 1,
      data: { to: 'mars' },
    } as unknown as Event;
    expect(apply(before, unknown)).toBe(before);
  });

  it('ignores updates to entities it has never seen, apart from lastSeq', () => {
    const before = withProduct();
    const after = apply(
      before,
      ev({ type: 'issue.held', productId: P, entityId: I2, v: 1, data: { questionId: Q } }),
      ev({
        type: 'attempt.step',
        productId: P,
        entityId: AT,
        v: 1,
        data: { issueId: I, step: 'check' },
      }),
      ev({ type: 'agent.exited', productId: P, entityId: AG, v: 1, data: { outcome: 'ok' } }),
      ev({ type: 'inbox.read', productId: P, entityId: IN, v: 1, data: {} }),
    );
    expect(content(after)).toEqual(content(before));
    expect(after.lastSeq).toBe(5);
  });
});

describe('purity', () => {
  it('never mutates the input state or event', () => {
    for (const c of ALL_CASES) {
      nextSeq = 1;
      const before = (c.given ?? withProduct)();
      const e = c.when();
      const stateCopy = structuredClone(before);
      const eventCopy = structuredClone(e);
      reduce(before, e);
      expect(before, c.name).toEqual(stateCopy);
      expect(e, c.name).toEqual(eventCopy);
    }
  });

  it('returns the same output for the same input', () => {
    const events = scenario();
    expect(events.reduce(reduce, emptyState)).toEqual(events.reduce(reduce, emptyState));
  });
});

// ---- multi-event scenario -----------------------------------------------------------------

const AT2 = AttemptIdSchema.parse('01ATTEMPT2');
const AG2 = AgentIdSchema.parse('01AGENT2');

/** create → spar → handoff → plan → rejected attempt → retry → merge, with usage throughout. */
function scenario(): Event[] {
  nextSeq = 1;
  usageRow = 0;
  const e = (d: EventDraft) => ev(d);
  return [
    productCreated(),
    e({
      type: 'spar.message',
      productId: P,
      entityId: 'm1',
      v: 1,
      data: { role: 'owner', text: 'todo app' },
    }),
    usage({ ...SUBSCRIPTION_USAGE, issueId: null, attemptId: null, role: 'sparring' }),
    e({
      type: 'prd.draft_saved',
      productId: P,
      entityId: null,
      v: 1,
      data: { markdown: '# v1', baseVersion: 0 },
    }),
    e({
      type: 'prd.applied',
      productId: P,
      entityId: null,
      v: 1,
      data: { version: 1, markdown: '# v1', summary: null },
    }),
    e({ type: 'product.handed_off', productId: P, entityId: null, v: 1, data: { prdVersion: 1 } }),
    issueCreated({ ...ISSUE_VIEW, dependsOn: [] }),
    issueCreated({ ...ISSUE_VIEW, id: I2, number: 2, title: 'Add logout', dependsOn: [I] }),
    e({
      type: 'orchestrator.cursor_advanced',
      productId: P,
      entityId: null,
      v: 1,
      data: { cursor: 6 },
    }),
    // attempt 1: rejected by review
    e({
      type: 'issue.status_changed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'open', to: 'in_progress', attemptCount: 0, runAfter: 0 },
    }),
    attemptStarted(),
    agentSpawned(),
    e({
      type: 'agent.activity',
      productId: P,
      entityId: AG,
      v: 1,
      data: { lines: ['edit src/login.ts'] },
    }),
    usage({ costUsd: 0.5 }),
    e({ type: 'agent.exited', productId: P, entityId: AG, v: 1, data: { outcome: 'ok' } }),
    e({
      type: 'attempt.step',
      productId: P,
      entityId: AT,
      v: 1,
      data: { issueId: I, step: 'review' },
    }),
    e({
      type: 'issue.status_changed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_progress', to: 'in_review', attemptCount: 0, runAfter: 0 },
    }),
    usage({ costUsd: null, unpriced: true, role: 'reviewer' }),
    e({
      type: 'attempt.ended',
      productId: P,
      entityId: AT,
      v: 1,
      data: {
        issueId: I,
        status: 'rejected',
        counted: true,
        headSha: SHA,
        feedback: 'add tests',
        review: { approve: false, findings: ['add tests'] },
        checkExit: 0,
        interruptReason: null,
      },
    }),
    e({
      type: 'issue.status_changed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_review', to: 'open', attemptCount: 1, runAfter: 0 },
    }),
    // attempt 2: merged
    e({
      type: 'issue.status_changed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'open', to: 'in_progress', attemptCount: 1, runAfter: 0 },
    }),
    e({
      type: 'attempt.started',
      productId: P,
      entityId: AT2,
      v: 1,
      data: { issueId: I, n: 2, issueRev: 1, baseSha: SHA, branch: 'attempt/01ATTEMPT2' },
    }),
    e({
      type: 'agent.spawned',
      productId: P,
      entityId: AG2,
      v: 1,
      data: { role: 'implementer', model: CC_MODEL, issueId: I, attemptId: AT2 },
    }),
    usage({ ...SUBSCRIPTION_USAGE, attemptId: AT2 }),
    e({ type: 'agent.exited', productId: P, entityId: AG2, v: 1, data: { outcome: 'ok' } }),
    e({
      type: 'attempt.ended',
      productId: P,
      entityId: AT2,
      v: 1,
      data: {
        issueId: I,
        status: 'merged',
        counted: true,
        headSha: SHA2,
        feedback: null,
        review: { approve: true, findings: [] },
        checkExit: 0,
        interruptReason: null,
      },
    }),
    e({
      type: 'issue.completed',
      productId: P,
      entityId: I,
      v: 1,
      data: { attemptId: AT2, mergedOrder: 1, mergeSha: SHA2 },
    }),
    e({
      type: 'inbox.created',
      productId: P,
      entityId: IN,
      v: 1,
      data: { kind: 'budget_warn', title: 'Budget 80%', body: '', link: null },
    }),
    e({ type: 'inbox.read', productId: P, entityId: IN, v: 1, data: {} }),
  ];
}

describe('multi-event scenario', () => {
  it('replays a build from creation to the first merge', () => {
    const events = scenario();
    const s = apply(emptyState, ...events);

    expect(ClientStateSchema.parse(s)).toEqual(s);
    expect(s.lastSeq).toBe(events.length);
    expect(product(s)).toMatchObject({ phase: 'building', prdVersion: 1, orchestratorCursor: 6 });
    expect(s.prdDrafts[P]).toMatchObject({ markdown: '# v1', baseVersion: 1 });
    expect(s.sparMessages[P]).toHaveLength(1);
    expect(issue(s)).toMatchObject({
      status: 'completed',
      attemptCount: 1,
      mergedOrder: 1,
      mergeSha: SHA2,
    });
    expect(s.issues[I2]).toMatchObject({ status: 'open', dependsOn: [I] });
    expect(s.attempts[AT]).toMatchObject({
      status: 'rejected',
      step: 'review',
      feedback: 'add tests',
    });
    expect(s.attempts[AT2]).toMatchObject({ status: 'merged', step: 'implement', headSha: SHA2 });
    expect(agent(s)).toMatchObject({ state: 'exited', lastActivity: 'edit src/login.ts' });
    expect(s.agents[AG2]).toMatchObject({ state: 'exited', provider: 'claude-code' });
    expect(s.inbox[IN]?.read).toBe(true);
    expect(s.usage.byProduct[P]).toEqual({
      apiUsd: 0.5,
      apiUnpriced: true,
      subscriptionTokens: { input: 20, output: 40, cacheRead: 60, cacheWrite: 80, reasoning: 0 },
      subscriptionCalls: 4,
    });
    expect(s.usage.byIssue[I]).toEqual({
      apiUsd: 0.5,
      apiUnpriced: true,
      subscriptionTokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 0 },
      subscriptionCalls: 2,
    });
  });
});
