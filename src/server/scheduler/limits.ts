import type { BackendLimit } from '../../shared/state-schema.ts';
import type { Store } from '../store/index.ts';

// Backend limits that clear themselves (ARCHITECTURE §4.4): a rate limit with a known reset
// time is lifted once that time has passed. needs_login is never cleared here; the owner does
// that from Settings ("I've logged in").

type Limit = Pick<BackendLimit, 'until' | 'needsLogin'>;

/** True when `limit` is a rate limit whose `until` has passed. */
export function limitExpired(limit: Limit, now: number): boolean {
  return !limit.needsLogin && limit.until !== null && limit.until <= now;
}

/**
 * Commits `backend.cleared` for every limit in `limits` that has expired by `now`. Each one is
 * re-checked inside the commit, so a limit clears once even when ticks overlap.
 */
export function clearExpiredLimits(
  store: Store,
  limits: Readonly<Record<string, Limit>>,
  now: number,
): void {
  const expired = Object.keys(limits).filter((b) => limitExpired(limits[b] as Limit, now));
  if (expired.length === 0) return;
  store.commit((tx) =>
    expired.flatMap((backend) => {
      const current = tx.q.backendLimit(backend);
      return current !== null && limitExpired(current, now)
        ? [{ type: 'backend.cleared', productId: null, entityId: null, v: 1, data: { backend } }]
        : [];
    }),
  );
}
