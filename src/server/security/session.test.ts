import { describe, expect, it } from 'vitest';
import { FakeClock } from '../util/clock.ts';
import { createSessions, newSessionKey, SESSION_TTL_MS } from './session.ts';

const DAY = 24 * 60 * 60 * 1000;

function setup(key = newSessionKey()) {
  const clock = new FakeClock();
  return { clock, sessions: createSessions({ key: () => key, clock }) };
}

describe('sessions (HMAC-SHA256 signed tokens)', () => {
  it('lasts 30 days', () => {
    expect(SESSION_TTL_MS).toBe(30 * DAY);
  });

  it('verifies an issued token until it expires', () => {
    const { clock, sessions } = setup();
    const token = sessions.issue();
    expect(sessions.verify(token)).toBe(true);
    clock.advance(SESSION_TTL_MS - 1);
    expect(sessions.verify(token)).toBe(true);
    clock.advance(1);
    expect(sessions.verify(token)).toBe(false);
  });

  it('issues a different token each time', () => {
    const { sessions } = setup();
    expect(sessions.issue()).not.toBe(sessions.issue());
  });

  it('rejects tampered, forged and malformed tokens', () => {
    const { sessions } = setup();
    const token = sessions.issue();
    const [exp, nonce, sig] = token.split('.');
    expect(sessions.verify(`${String(Number(exp) + DAY)}.${nonce ?? ''}.${sig ?? ''}`)).toBe(false);
    expect(sessions.verify(`${exp ?? ''}.${nonce ?? ''}.${(sig ?? '').slice(1)}x`)).toBe(false);
    expect(sessions.verify('')).toBe(false);
    expect(sessions.verify('a.b')).toBe(false);
    expect(sessions.verify('a.b.c.d')).toBe(false);
    expect(sessions.verify(`notanumber.${nonce ?? ''}.${sig ?? ''}`)).toBe(false);
  });

  it('rejects tokens signed with another key (key rotation logs everyone out)', () => {
    let key = newSessionKey();
    const clock = new FakeClock();
    const sessions = createSessions({ key: () => key, clock });
    const token = sessions.issue();
    key = newSessionKey();
    expect(sessions.verify(token)).toBe(false);
    expect(sessions.verify(sessions.issue())).toBe(true);
  });
});
