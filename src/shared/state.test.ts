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

const ALL_CASES: Case[] = [...PRODUCT_CASES];

// ---- tests ------------------------------------------------------------------------------

describe.each(ALL_CASES)('replay', (c) => {
  it(c.name, () => {
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
