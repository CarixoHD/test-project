import { expect } from 'vitest';
import { emptyState, reduce } from '../../shared/state.ts';
import type { Store } from './store.ts';

/**
 * The store invariant (ARCHITECTURE §4.2): replaying every stored event through the shared
 * `reduce` gives exactly (deep-equal, no tolerance) the snapshot built from the projections.
 * Test-only helper; later issues call it after their command sequences.
 */
export function expectSnapshotMatchesReplay(store: Store): void {
  const replayed = store.eventsSince(0).reduce(reduce, emptyState);
  const { state, lastSeq } = store.snapshot();
  expect(state).toStrictEqual(replayed);
  expect(lastSeq).toBe(replayed.lastSeq);
}
