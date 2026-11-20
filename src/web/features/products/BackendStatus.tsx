import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { BackendLimit } from '../../../shared/state-schema.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { backendNotices, nextExpiry, noticeText } from './backend-status-model.ts';

const MAX_TIMER_MS = 2 ** 31 - 1;

const selectLimits = (s: AppSnapshot) => s.state.backendLimits;

/** The current time, refreshed whenever one of the rate limits in `limits` runs out. */
function useNowForLimits(limits: Readonly<Record<string, BackendLimit>>): number {
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
  const notices = backendNotices(limits, useNowForLimits(limits));

  return (
    <div className="backend-status" role="status">
      {notices.length > 0 && (
        <section className="build-tab__slot backend-status__banner" aria-label="Backend status">
          <ul className="backend-status__list">
            {notices.map((n) => (
              <li key={n.backend}>
                {n.kind === 'needs_login' ? (
                  <>
                    {n.label} needs login — see <Link to="/settings">Settings</Link>
                  </>
                ) : (
                  noticeText(n)
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
