import { describe, expect, it } from 'vitest';
import { StateResponseSchema } from './dto.ts';
import { EventSchema } from './events.ts';
import { emptyState, reduce } from './state.ts';

const created = EventSchema.parse({
  seq: 1,
  ts: 1_700_000_000_000,
  type: 'product.created',
  productId: '01PRODUCT',
  entityId: null,
  v: 1,
  data: {
    name: 'Todo',
    idea: 'A todo app',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  },
});

describe('StateResponseSchema', () => {
  it('accepts a reduced state with its lastSeq', () => {
    const state = reduce(emptyState, created);
    const body = JSON.parse(JSON.stringify({ state, lastSeq: 1 })) as unknown;
    expect(StateResponseSchema.parse(body)).toEqual({ state, lastSeq: 1 });
  });

  it('rejects a body without state', () => {
    expect(StateResponseSchema.safeParse({ lastSeq: 0 }).success).toBe(false);
  });

  it('rejects a malformed state', () => {
    const state = { ...emptyState, products: { p: { id: 'p' } } };
    expect(StateResponseSchema.safeParse({ state, lastSeq: 0 }).success).toBe(false);
  });

  it('rejects a negative lastSeq', () => {
    expect(StateResponseSchema.safeParse({ state: emptyState, lastSeq: -1 }).success).toBe(false);
  });
});
