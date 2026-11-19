import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  EVENT_VERSION,
  EventSchema,
  parseEvent,
  type EventDraft,
  type EventType,
} from './events.ts';
import type { IssueView } from './domain.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
} from './ids.ts';

const P = ProductIdSchema.parse('01PRODUCT');
const I = IssueIdSchema.parse('01ISSUE');
const I2 = IssueIdSchema.parse('01ISSUE2');
const AT = AttemptIdSchema.parse('01ATTEMPT');
const AG = AgentIdSchema.parse('01AGENT');
const Q = QuestionIdSchema.parse('01QUESTION');
const IN = InboxIdSchema.parse('01INBOX');
const SHA = 'a'.repeat(40);
const T0 = 1_700_000_000_000;
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;
const PROJECT = { check: ['npm', 'test'], imageInputs: ['package-lock.json'] };

// The catalogue from docs/ARCHITECTURE.md §5, spelled out so drift is caught.
const ARCHITECTURE_EVENT_TYPES = [
  'product.created',
  'product.settings_changed',
  'product.handed_off',
  'product.paused',
  'product.resumed',
  'product.phase_changed',
  'spar.message',
  'prd.draft_saved',
  'prd.applied',
  'orchestrator.cursor_advanced',
  'issue.created',
  'issue.edited',
  'issue.status_changed',
  'issue.held',
  'issue.released',
  'issue.cancelled',
  'issue.completed',
  'issue.failed',
  'issue.rewritten',
  'attempt.started',
  'attempt.step',
  'attempt.ended',
  'agent.spawned',
  'agent.state',
  'agent.activity',
  'agent.exited',
  'usage.recorded',
  'budget.warned',
  'question.asked',
  'question.answered',
  'inbox.created',
  'inbox.read',
  'backend.limited',
  'backend.cleared',
  'preview.started',
  'preview.stopped',
];

type Sample<K extends EventType> = {
  valid: Extract<EventDraft, { type: K }>;
  invalidData: unknown;
};

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

const USAGE = {
  agentId: AG,
  role: 'implementer',
  model: MODEL,
  issueId: I,
  attemptId: AT,
  billing: 'api',
  tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  webSearches: 0,
  calls: 1,
  costUsd: 0.012,
  unpriced: false,
  estCostUsd: null,
  source: 'computed',
} as const;

const SAMPLES: { [K in EventType]: Sample<K> } = {
  'product.created': {
    valid: {
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
    },
    invalidData: { name: '', idea: 'x', budgetUsd: null, maxParallel: 3, maxAttempts: 3 },
  },
  'product.settings_changed': {
    valid: {
      type: 'product.settings_changed',
      productId: P,
      entityId: null,
      v: 1,
      data: { budgetUsd: null, maxParallel: 5, project: PROJECT },
    },
    invalidData: { maxParallel: 0 },
  },
  'product.handed_off': {
    valid: {
      type: 'product.handed_off',
      productId: P,
      entityId: null,
      v: 1,
      data: { prdVersion: 1 },
    },
    invalidData: { prdVersion: 0 },
  },
  'product.paused': {
    valid: {
      type: 'product.paused',
      productId: P,
      entityId: null,
      v: 1,
      data: { reason: 'budget' },
    },
    invalidData: { reason: 'bored' },
  },
  'product.resumed': {
    valid: { type: 'product.resumed', productId: P, entityId: null, v: 1, data: {} },
    invalidData: null,
  },
  'product.phase_changed': {
    valid: {
      type: 'product.phase_changed',
      productId: P,
      entityId: null,
      v: 1,
      data: { phase: 'complete' },
    },
    invalidData: { phase: 'done' },
  },
  'spar.message': {
    valid: {
      type: 'spar.message',
      productId: P,
      entityId: '01MSG',
      v: 1,
      data: { role: 'agent', text: 'Who are the users?' },
    },
    invalidData: { role: 'system', text: 'x' },
  },
  'prd.draft_saved': {
    valid: {
      type: 'prd.draft_saved',
      productId: P,
      entityId: null,
      v: 1,
      data: { markdown: '# PRD', baseVersion: 0 },
    },
    invalidData: { markdown: 1, baseVersion: 0 },
  },
  'prd.applied': {
    valid: {
      type: 'prd.applied',
      productId: P,
      entityId: null,
      v: 1,
      data: { version: 2, markdown: '# PRD v2', summary: null },
    },
    invalidData: { version: 0, markdown: '# PRD', summary: null },
  },
  'orchestrator.cursor_advanced': {
    valid: {
      type: 'orchestrator.cursor_advanced',
      productId: P,
      entityId: null,
      v: 1,
      data: { cursor: 42 },
    },
    invalidData: { cursor: -1 },
  },
  'issue.created': {
    valid: { type: 'issue.created', productId: P, entityId: I, v: 1, data: { issue: ISSUE_VIEW } },
    invalidData: { issue: { ...ISSUE_VIEW, number: 0 } },
  },
  'issue.edited': {
    valid: {
      type: 'issue.edited',
      productId: P,
      entityId: I,
      v: 1,
      data: { rev: 2, title: 'Add login form', dependsOn: [] },
    },
    invalidData: { title: 'no rev' },
  },
  'issue.status_changed': {
    valid: {
      type: 'issue.status_changed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_progress', to: 'open', attemptCount: 1, runAfter: T0 },
    },
    invalidData: { from: 'open', to: 'merged', attemptCount: 0, runAfter: 0 },
  },
  'issue.held': {
    valid: { type: 'issue.held', productId: P, entityId: I, v: 1, data: { questionId: Q } },
    invalidData: { questionId: '' },
  },
  'issue.released': {
    valid: { type: 'issue.released', productId: P, entityId: I, v: 1, data: { questionId: Q } },
    invalidData: {},
  },
  'issue.cancelled': {
    valid: {
      type: 'issue.cancelled',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'failed', by: 'owner', reason: 'Not needed' },
    },
    invalidData: { from: 'cancelled', by: 'owner', reason: 'again' },
  },
  'issue.completed': {
    valid: {
      type: 'issue.completed',
      productId: P,
      entityId: I,
      v: 1,
      data: { attemptId: AT, mergedOrder: 1, mergeSha: SHA },
    },
    invalidData: { attemptId: AT, mergedOrder: 1, mergeSha: 'not-a-sha' },
  },
  'issue.failed': {
    valid: {
      type: 'issue.failed',
      productId: P,
      entityId: I,
      v: 1,
      data: { from: 'in_review', attemptCount: 3, reason: 'Reviewer rejected 3 times' },
    },
    invalidData: { from: 'open', attemptCount: 3, reason: 'x' },
  },
  'issue.rewritten': {
    valid: {
      type: 'issue.rewritten',
      productId: P,
      entityId: I,
      v: 1,
      data: { rev: 3, body: 'Smaller scope' },
    },
    invalidData: { rev: 3 },
  },
  'attempt.started': {
    valid: {
      type: 'attempt.started',
      productId: P,
      entityId: AT,
      v: 1,
      data: { issueId: I, n: 1, issueRev: 1, baseSha: SHA, branch: 'attempt/01ATTEMPT' },
    },
    invalidData: { issueId: I, n: 0, issueRev: 1, baseSha: SHA, branch: 'b' },
  },
  'attempt.step': {
    valid: {
      type: 'attempt.step',
      productId: P,
      entityId: AT,
      v: 1,
      data: { issueId: I, step: 'review' },
    },
    invalidData: { issueId: I, step: 'deploy' },
  },
  'attempt.ended': {
    valid: {
      type: 'attempt.ended',
      productId: P,
      entityId: AT,
      v: 1,
      data: {
        issueId: I,
        status: 'rejected',
        counted: true,
        headSha: SHA,
        feedback: 'Missing tests',
        review: { approve: false, findings: ['Missing tests'] },
        checkExit: 0,
        interruptReason: null,
      },
    },
    invalidData: {
      issueId: I,
      status: 'interrupted',
      counted: false,
      headSha: null,
      feedback: null,
      review: null,
      checkExit: null,
      interruptReason: null,
    },
  },
  'agent.spawned': {
    valid: {
      type: 'agent.spawned',
      productId: P,
      entityId: AG,
      v: 1,
      data: { role: 'implementer', model: MODEL, issueId: I, attemptId: AT },
    },
    invalidData: { role: 'janitor', model: MODEL, issueId: null, attemptId: null },
  },
  'agent.state': {
    valid: {
      type: 'agent.state',
      productId: P,
      entityId: AG,
      v: 1,
      data: { state: 'rate_limited', until: T0 },
    },
    invalidData: { state: 'exited', until: null },
  },
  'agent.activity': {
    valid: {
      type: 'agent.activity',
      productId: P,
      entityId: AG,
      v: 1,
      data: { lines: ['run npm test', 'exit 0'] },
    },
    invalidData: { lines: [] },
  },
  'agent.exited': {
    valid: { type: 'agent.exited', productId: P, entityId: AG, v: 1, data: { outcome: 'ok' } },
    invalidData: { outcome: 'vanished' },
  },
  'usage.recorded': {
    valid: { type: 'usage.recorded', productId: P, entityId: '01USAGE', v: 1, data: USAGE },
    invalidData: { ...USAGE, costUsd: null, unpriced: false },
  },
  'budget.warned': {
    valid: {
      type: 'budget.warned',
      productId: P,
      entityId: null,
      v: 1,
      data: { spentUsd: 16.5, budgetUsd: 20 },
    },
    invalidData: { spentUsd: -1, budgetUsd: 20 },
  },
  'question.asked': {
    valid: {
      type: 'question.asked',
      productId: P,
      entityId: Q,
      v: 1,
      data: { target: 'issue', issueId: I, agentId: AG, text: 'Which auth provider?' },
    },
    invalidData: { target: 'issue', issueId: null, agentId: null, text: 'Q?' },
  },
  'question.answered': {
    valid: {
      type: 'question.answered',
      productId: P,
      entityId: Q,
      v: 1,
      data: { answer: 'Use passkeys' },
    },
    invalidData: { answer: '' },
  },
  'inbox.created': {
    valid: {
      type: 'inbox.created',
      productId: null,
      entityId: IN,
      v: 1,
      data: { kind: 'rate_limited', title: 'Claude rate limited', body: '', link: null },
    },
    invalidData: { kind: 'spam', title: 't', body: '', link: null },
  },
  'inbox.read': {
    valid: { type: 'inbox.read', productId: P, entityId: IN, v: 1, data: {} },
    invalidData: 'read',
  },
  'backend.limited': {
    valid: {
      type: 'backend.limited',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code', until: null, needsLogin: true, reason: 'Login expired' },
    },
    invalidData: { backend: 'claude-code', until: null, reason: 'x' },
  },
  'backend.cleared': {
    valid: {
      type: 'backend.cleared',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code' },
    },
    invalidData: { backend: '' },
  },
  'preview.started': {
    valid: {
      type: 'preview.started',
      productId: P,
      entityId: null,
      v: 1,
      data: { url: 'http://127.0.0.1:49153/', container: 'vibecode-01RUN' },
    },
    invalidData: { url: 'not a url', container: 'c' },
  },
  'preview.stopped': {
    valid: { type: 'preview.stopped', productId: P, entityId: null, v: 1, data: {} },
    invalidData: [],
  },
};

const at = (draft: EventDraft, seq = 7) => ({ seq, ts: T0, ...draft });
const CASES = EVENT_TYPES.map((type) => [type, SAMPLES[type]] as const);

describe('event catalogue', () => {
  it('matches ARCHITECTURE §5 exactly', () => {
    expect([...EVENT_TYPES].sort()).toEqual([...ARCHITECTURE_EVENT_TYPES].sort());
  });

  it('uses EVENT_VERSION 1', () => {
    expect(EVENT_VERSION).toBe(1);
  });

  it.each(CASES)('%s parses a valid sample', (_type, sample) => {
    const raw = at(sample.valid);
    expect(EventSchema.parse(raw)).toEqual(raw);
    expect(parseEvent(raw)).toEqual(raw);
  });

  it.each(CASES)('%s rejects invalid data', (_type, sample) => {
    const raw = { ...at(sample.valid), data: sample.invalidData };
    expect(EventSchema.safeParse(raw).success).toBe(false);
    expect(() => parseEvent(raw)).toThrow();
  });
});

describe('event envelope', () => {
  const issueCreated = SAMPLES['issue.created'].valid;
  const backendCleared = SAMPLES['backend.cleared'].valid;

  it.each([
    ['missing seq', { ts: T0, ...issueCreated }],
    ['seq 0', at(issueCreated, 0)],
    ['fractional ts', { ...at(issueCreated), ts: 1.5 }],
    ['unknown version', { ...at(issueCreated), v: 2 }],
    ['issue event without productId', { ...at(issueCreated), productId: null }],
    ['issue event without entityId', { ...at(issueCreated), entityId: null }],
    ['global event with a productId', { ...at(backendCleared), productId: P }],
    ['product event with an entityId', { ...at(SAMPLES['product.resumed'].valid), entityId: 'x' }],
  ])('rejects %s', (_name, raw) => {
    expect(EventSchema.safeParse(raw).success).toBe(false);
    expect(() => parseEvent(raw)).toThrow();
  });
});

describe('parseEvent', () => {
  it('returns null for an unknown type (forward compat)', () => {
    expect(
      parseEvent({
        seq: 1,
        ts: T0,
        type: 'robot.danced',
        productId: P,
        entityId: null,
        v: 1,
        data: {},
      }),
    ).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'issue.created'],
    ['an object without type', { seq: 1, ts: T0, v: 1, data: {} }],
    ['a non-string type', { seq: 1, ts: T0, type: 7, v: 1, data: {} }],
  ])('throws for %s', (_name, raw) => {
    expect(() => parseEvent(raw)).toThrow();
  });

  it('narrows to the right payload type', () => {
    const e = parseEvent(at(SAMPLES['issue.completed'].valid));
    if (e?.type !== 'issue.completed') throw new Error('expected issue.completed');
    expect(e.data.mergeSha).toBe(SHA);
    expect(e.entityId).toBe(I);
  });
});
