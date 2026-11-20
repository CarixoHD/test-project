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
