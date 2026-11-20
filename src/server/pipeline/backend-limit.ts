import type { EventDraft } from '../../shared/events.ts';
import type { Tx } from '../store/index.ts';

// Account-wide backend limits (backend.limited) recorded by attempts and orchestrator runs.

/** Delay before retrying a run that stopped because its backend needs a login. */
export const LOGIN_RETRY_DELAY_MS = 60_000;

export type BackendLimitDraft = {
  backend: string;
  until: number | null;
  needsLogin: boolean;
  reason: string;
};

/** The limit an agent `rate_limited` / `auth_required` result records. */
export function limitOf(
  result:
    | { kind: 'rate_limited'; backend: string; until: number }
    | { kind: 'auth_required'; backend: string },
  reason: string,
): BackendLimitDraft {
  return result.kind === 'rate_limited'
    ? { backend: result.backend, until: result.until, needsLogin: false, reason }
    : { backend: result.backend, until: null, needsLogin: true, reason };
}

/**
 * backend.limited for `limit`, but only when it changes the backend's projected limit, so runs
 * hitting the same limit in parallel record it (and its inbox item) once.
 */
export function limitDrafts(tx: Tx, limit: BackendLimitDraft): EventDraft[] {
  const current = tx.q.backendLimit(limit.backend);
  const changed =
    current === null || current.until !== limit.until || current.needsLogin !== limit.needsLogin;
  return changed
    ? [{ type: 'backend.limited', productId: null, entityId: null, v: 1, data: limit }]
    : [];
}
