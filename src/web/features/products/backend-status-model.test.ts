import { describe, expect, it } from 'vitest';
import { emptyState, reduce } from '../../../shared/state.ts';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { backendNotices, noticeText } from './backend-status-model.ts';

// Notices come from ClientState built by reducing real backend events.
const NOW = Date.UTC(2026, 10, 20, 13, 30); // Fri 20 Nov 2026 13:30 UTC
const FMT = { locale: 'en-GB', timeZone: 'UTC' };

let seq = 0;
const ev = (type: string, data: object): Event => {
  seq += 1;
  return EventSchema.parse({ seq, ts: NOW, type, productId: null, entityId: null, v: 1, data });
};
const limited = (backend: string, until: number | null, needsLogin = false) =>
  ev('backend.limited', { backend, until, needsLogin, reason: 'test' });
const limitsOf = (...events: Event[]) => events.reduce(reduce, emptyState).backendLimits;

const texts = (...events: Event[]) =>
  backendNotices(limitsOf(...events), NOW, FMT).map((n) => noticeText(n));

describe('backendNotices', () => {
  it('is empty when no backend is limited', () => {
    expect(texts()).toEqual([]);
  });

  it('says until when (local time) a rate limit resets and that work resumes on its own', () => {
    expect(texts(limited('claude-code', Date.UTC(2026, 10, 20, 14, 5)))).toEqual([
      'Claude Code rate limited until 14:05 — work resumes automatically',
    ]);
  });

  it("formats the time in the given time zone, not the server's", () => {
    const n = backendNotices(limitsOf(limited('claude-code', Date.UTC(2026, 10, 20, 14, 5))), NOW, {
      locale: 'en-GB',
      timeZone: 'Europe/Berlin',
    });
    expect(n.map((x) => noticeText(x))).toEqual([
      'Claude Code rate limited until 15:05 — work resumes automatically',
    ]);
  });

  it('adds the weekday when the limit resets on another day', () => {
    expect(texts(limited('anthropic', Date.UTC(2026, 10, 21, 9, 0)))).toEqual([
      'Anthropic rate limited until Sat 09:00 — work resumes automatically',
    ]);
  });

  it('points to Settings when a login is needed', () => {
    const [n] = backendNotices(limitsOf(limited('claude-code', null, true)), NOW, FMT);
    expect(n).toMatchObject({ kind: 'needs_login', label: 'Claude Code' });
    expect(n && noticeText(n)).toBe('Claude Code needs login — see Settings. Pasting a new token in Settings fixes it.');
  });

  it('hides a rate limit whose time has passed, and a cleared one', () => {
    expect(texts(limited('claude-code', NOW))).toEqual([]);
    expect(
      texts(
        limited('claude-code', NOW + 60_000),
        ev('backend.cleared', { backend: 'claude-code' }),
      ),
    ).toEqual([]);
  });

  it('lists logins first, then rate limits, with a limit of unknown length', () => {
    expect(
      texts(
        limited('openai', null),
        limited('claude-code', null, true),
        limited('anthropic', NOW + 60_000),
      ),
    ).toEqual([
      'Claude Code needs login — see Settings. Pasting a new token in Settings fixes it.',
      'Anthropic rate limited until 13:31 — work resumes automatically',
      'OpenAI rate limited — work resumes when the limit resets',
    ]);
  });
});
