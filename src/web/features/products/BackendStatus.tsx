import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { BackendLimit } from '../../../shared/state-schema.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { NEEDS_LOGIN_FIX, backendNotices, nextExpiry, noticeText } from './backend-status-model.ts';

const MAX_TIMER_MS = 2 ** 31 - 1;

type Limits = Readonly<Record<string, BackendLimit>>;

const selectLimits = (s: AppSnapshot) => s.state.backendLimits;

/**
 * The current time, taken at mount and refreshed whenever one of the rate limits in `limits`
 * runs out. Callers remount (via `key`) when `limits` changes, so new limits are judged against
 * the time they arrived rather than a stale earlier time.
 */
function useNowForLimits(limits: Limits): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    const next = nextExpiry(limits, current);
    if (next === null) return undefined;
    const t = setTimeout(() => setNow(Date.now()), Math.min(MAX_TIMER_MS, next - current));
    return () => clearTimeout(t);
  }, [limits, now]);
  return now;
}

/**
 * Build tab banner for account-wide backend limits: "Claude Code rate limited until 14:05 —
 * work resumes automatically" (in the browser's time zone) or "… needs login — see Settings".
 * Hidden while every backend is OK; a rate limit drops out on its own once its time has passed.
 */
export function BackendStatus() {
  const limits = useApp(selectLimits);
  // The live region stays mounted; the notices remount whenever the limits change so their
  // clock restarts at the current time (an already-past limit never counts as active).
  return (
    <div className="backend-status" role="status">
      <BackendNotices key={JSON.stringify(limits)} limits={limits} />
    </div>
  );
}

function BackendNotices({ limits }: { limits: Limits }) {
  const notices = backendNotices(limits, useNowForLimits(limits));
  if (notices.length === 0) return null;
  return (
    <section className="build-tab__slot backend-status__banner" aria-label="Backend status">
      <ul className="backend-status__list">
        {notices.map((n) => (
          <li key={n.backend}>
            {n.kind === 'needs_login' ? (
              <>
                {n.label} needs login — see <Link to="/settings">Settings</Link>. {NEEDS_LOGIN_FIX}
              </>
            ) : (
              noticeText(n)
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
