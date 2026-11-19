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

// ---- tests ------------------------------------------------------------------------------

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
