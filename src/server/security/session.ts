import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../shared/ids.ts';

// Owner sessions (ADR 9): stateless tokens `<expiresAt>.<nonce>.<HMAC-SHA256>` in a cookie.
// The key lives in `secrets` (SESSION_KEY_SECRET); replacing it ends every session.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'vibecode_session';
/** `secrets` key of the HMAC key. */
export const SESSION_KEY_SECRET = 'sessionKey';

/** A fresh random HMAC key (32 bytes, base64url). */
export const newSessionKey = (): string => randomBytes(32).toString('base64url');

export interface Sessions {
  /** A new signed token valid for SESSION_TTL_MS. */
  issue(): string;
  /** True for an unexpired token signed with the current key. */
  verify(token: string): boolean;
}

export interface SessionsDeps {
  /** Read on every call, so a rotated key takes effect at once. */
  key: () => string;
  clock: Clock;
}

export function createSessions({ key, clock }: SessionsDeps): Sessions {
  const sign = (payload: string) => createHmac('sha256', key()).update(payload).digest();

  return {
    issue() {
      const payload = `${String(clock.now() + SESSION_TTL_MS)}.${randomBytes(16).toString('base64url')}`;
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const [exp = '', nonce = '', sig = ''] = parts;
      if (!/^\d{1,16}$/.test(exp) || nonce === '') return false;
      const expected = sign(`${exp}.${nonce}`);
      const actual = Buffer.from(sig, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      return Number(exp) > clock.now();
    },
  };
}

/** Cookie attributes of the session cookie: HttpOnly, SameSite=Strict, Secure over HTTPS. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'Strict',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  } as const;
}
