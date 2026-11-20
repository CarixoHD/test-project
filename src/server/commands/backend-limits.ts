import type { Event } from '../../shared/events.ts';
import type { ProviderId } from '../../shared/models.ts';
import type { Store } from '../store/index.ts';

// Owner command: clear an account-wide backend limit (ARCHITECTURE §4.3), e.g. after logging
// Claude Code in again ("I've logged in" in Settings). The scheduler resumes that backend.

export type ClearBackendLimitResult = { ok: true; events: Event[] };

/** Emits `backend.cleared` when `backend` has a limit; a no-op otherwise. */
export function clearBackendLimit(
  deps: { store: Store },
  backend: ProviderId,
): ClearBackendLimitResult {
  const events = deps.store.commit(() =>
    deps.store.snapshot().state.backendLimits[backend] === undefined
      ? []
      : [{ type: 'backend.cleared', productId: null, entityId: null, v: 1, data: { backend } }],
  );
  return { ok: true, events };
}
