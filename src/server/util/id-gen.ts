import { monotonicFactory } from 'ulid';
import type { Clock, IdByKind, IdGen, IdKind } from '../../shared/ids.ts';

export type { IdGen } from '../../shared/ids.ts';

/**
 * Monotonic ULIDs stamped with `clock` time: ids sort in creation order, also within one
 * millisecond and across kinds.
 */
export function createIdGen(clock: Clock): IdGen {
  const ulid = monotonicFactory();
  return {
    next<K extends IdKind>(_kind: K): IdByKind[K] {
      // The brand is a compile-time tag only; the value is a plain string.
      return ulid(clock.now()) as IdByKind[K];
    },
  };
}

/** Deterministic test ids: `<kind>-000001`, `<kind>-000002`, … with one counter for all kinds. */
export class FakeIdGen implements IdGen {
  #n = 0;

  next<K extends IdKind>(kind: K): IdByKind[K] {
    this.#n += 1;
    return `${kind}-${String(this.#n).padStart(6, '0')}` as IdByKind[K];
  }
}
