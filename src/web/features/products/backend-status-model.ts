import type { BackendLimit } from '../../../shared/state-schema.ts';

// Wording of the Build tab's backend banner (BackendStatus.tsx). Times are formatted in the
// browser's own time zone from the limit's epoch-ms `until`; tests pass a fixed locale and zone.

export type BackendNotice =
  | { backend: string; label: string; kind: 'needs_login' }
  /** `resumesAt` is null when the limit has no known reset time. */
  | { backend: string; label: string; kind: 'rate_limited'; resumesAt: string | null };

export type TimeFormat = { locale?: string; timeZone?: string };

const BACKEND_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible provider',
  fake: 'Fake model',
};

export const backendLabel = (backend: string): string => BACKEND_LABELS[backend] ?? backend;

/** "14:05", or "Sat 09:00" when `ts` falls on another local day than `now`. */
export function resumeTime(ts: number, now: number, fmt: TimeFormat = {}): string {
  const zone = fmt.timeZone === undefined ? {} : { timeZone: fmt.timeZone };
  const day = new Intl.DateTimeFormat(fmt.locale, { ...zone, dateStyle: 'short' });
  const sameDay = day.format(ts) === day.format(now);
  return new Intl.DateTimeFormat(fmt.locale, {
    ...zone,
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}

/** Active limits as banner notices (logins first, then by name); expired limits are left out. */
export function backendNotices(
  limits: Readonly<Record<string, BackendLimit>>,
  now: number,
  fmt: TimeFormat = {},
): BackendNotice[] {
  const notices: BackendNotice[] = [];
  for (const [backend, limit] of Object.entries(limits)) {
    const label = backendLabel(backend);
    if (limit.needsLogin) notices.push({ backend, label, kind: 'needs_login' });
    else if (limit.until === null)
      notices.push({ backend, label, kind: 'rate_limited', resumesAt: null });
    else if (limit.until > now)
      notices.push({
        backend,
        label,
        kind: 'rate_limited',
        resumesAt: resumeTime(limit.until, now, fmt),
      });
  }
  const rank = (n: BackendNotice) => (n.kind === 'needs_login' ? 0 : 1);
  return notices.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The notice as one line of text (the banner links "Settings" in the needs-login one). */
export function noticeText(n: BackendNotice): string {
  if (n.kind === 'needs_login') return `${n.label} needs login — see Settings`;
  return n.resumesAt === null
    ? `${n.label} rate limited — work resumes when the limit resets`
    : `${n.label} rate limited until ${n.resumesAt} — work resumes automatically`;
}

/** The earliest rate-limit `until` after `now`: when the banner must re-render. */
export function nextExpiry(
  limits: Readonly<Record<string, BackendLimit>>,
  now: number,
): number | null {
  const times = Object.values(limits).flatMap((l) =>
    !l.needsLogin && l.until !== null && l.until > now ? [l.until] : [],
  );
  return times.length === 0 ? null : Math.min(...times);
}
