import { describe, expect, it } from 'vitest';
import { findDependencyCycle, nextIssueNumber, resolveDependsOn } from './index.ts';

describe('nextIssueNumber', () => {
  it.each([
    { numbers: [], want: 1 },
    { numbers: [1], want: 2 },
    { numbers: [1, 2, 3], want: 4 },
    { numbers: [3, 1], want: 4 },
    { numbers: [1, 5], want: 6 },
  ])('$numbers → $want', ({ numbers, want }) => {
    expect(nextIssueNumber(numbers.map((number) => ({ number })))).toBe(want);
  });
});

describe('findDependencyCycle', () => {
  const g = (o: Record<string, string[]>) => new Map(Object.entries(o));

  it.each([
    { name: 'empty graph', graph: g({}), want: null },
    { name: 'chain', graph: g({ a: [], b: ['a'], c: ['b', 'a'] }), want: null },
    { name: 'diamond', graph: g({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] }), want: null },
    { name: 'edge to a node outside the graph', graph: g({ a: ['zz'] }), want: null },
    { name: 'self loop', graph: g({ a: ['a'] }), want: ['a', 'a'] },
    { name: 'two-cycle', graph: g({ a: ['b'], b: ['a'] }), want: ['a', 'b', 'a'] },
    {
      name: 'cycle behind an acyclic prefix',
      graph: g({ x: ['a'], a: ['b'], b: ['c'], c: ['a'] }),
      want: ['a', 'b', 'c', 'a'],
    },
  ])('$name', ({ graph, want }) => {
    expect(findDependencyCycle(graph)).toEqual(want);
  });
});

describe('resolveDependsOn', () => {
  const ctx = {
    keys: new Map([['k', 'id-k']]),
    existingIds: new Set(['id-1', 'id-2', 'id-x']),
    cancelledIds: new Set(['id-x']),
  };

  it.each([
    { refs: [], want: { ok: true, ids: [] } },
    { refs: ['k', 'id-2'], want: { ok: true, ids: ['id-k', 'id-2'] } },
    { refs: ['id-1', 'k', 'id-1'], want: { ok: true, ids: ['id-1', 'id-k'] } },
    { refs: ['id-1', 'nope'], want: { ok: false, reason: 'unknown dependency "nope"' } },
    {
      refs: ['id-1', 'id-x'],
      want: { ok: false, reason: 'dependency "id-x" is cancelled and can never complete' },
    },
  ])('$refs', ({ refs, want }) => {
    expect(resolveDependsOn(refs, ctx)).toEqual(want);
  });
});
