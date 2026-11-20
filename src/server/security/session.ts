import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../../shared/ids.ts';

// Owner sessions (ADR 9): signed tokens `<expiresAt>.<nonce>.<HMAC-SHA256>` in a cookie.
// The key lives in `secrets` (SESSION_KEY_SECRET); replacing it ends every session.
// Logging out revokes one token: its nonce is kept (until the token would expire) in a
// revocation list, stored as JSON `{nonce: expiresAt}` (SESSION_REVOKED_SECRET in `secrets`).

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'vibecode_session';
/** `secrets` key of the HMAC key. */
export const SESSION_KEY_SECRET = 'sessionKey';
/** `secrets` key of the revocation list of logged-out tokens. */
export const SESSION_REVOKED_SECRET = 'sessionRevoked';

const RevokedSchema = z.record(z.string(), z.number());

/** A fresh random HMAC key (32 bytes, base64url). */
export const newSessionKey = (): string => randomBytes(32).toString('base64url');

export interface Sessions {
  /** A new signed token valid for SESSION_TTL_MS. */
  issue(): string;
  /** True for an unexpired token signed with the current key. */
  verify(token: string): boolean;
  /** Ends the session of a valid token (logout); `verify` rejects it from then on. */
  revoke(token: string): void;
}

/** Where the revocation list is kept; read on every `verify`. */
export interface RevocationStorage {
  get(): string | undefined;
  set(value: string): void;
}

export interface SessionsDeps {
  /** Read on every call, so a rotated key takes effect at once. */
  key: () => string;
  clock: Clock;
  /** Defaults to memory (lost on restart); production keeps it in `secrets`. */
  revoked?: RevocationStorage;
}

function memoryStorage(): RevocationStorage {
  let value: string | undefined;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

export function createSessions({ key, clock, revoked = memoryStorage() }: SessionsDeps): Sessions {
  const sign = (payload: string) => createHmac('sha256', key()).update(payload).digest();

  const readRevoked = (): Record<string, number> => {
    const raw = revoked.get();
    if (raw === undefined) return {};
    const parsed = RevokedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`Secret ${SESSION_REVOKED_SECRET} is malformed`);
    return parsed.data;
  };

  /** `{exp, nonce}` of a token with a valid signature that has not expired. */
  const parse = (token: string): { exp: number; nonce: string } | undefined => {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [exp = '', nonce = '', sig = ''] = parts;
    if (!/^\d{1,16}$/.test(exp) || nonce === '') return undefined;
    const expected = sign(`${exp}.${nonce}`);
    const actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    if (Number(exp) <= clock.now()) return undefined;
    return { exp: Number(exp), nonce };
  };

  return {
    issue() {
      const payload = `${String(clock.now() + SESSION_TTL_MS)}.${randomBytes(16).toString('base64url')}`;
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    verify(token) {
      const session = parse(token);
      return session !== undefined && !Object.hasOwn(readRevoked(), session.nonce);
    },
    revoke(token) {
      const session = parse(token);
      if (session === undefined) return;
      const now = clock.now();
      // Expired tokens fail `verify` anyway: drop them so the list stays small.
      const live = Object.entries(readRevoked()).filter(([, exp]) => exp > now);
      revoked.set(JSON.stringify(Object.fromEntries([...live, [session.nonce, session.exp]])));
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
