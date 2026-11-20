import { z } from 'zod';
import { PasswordChangeRequestSchema, type PasswordChangeRequest } from '../../shared/dto.ts';
import type { Clock } from '../../shared/ids.ts';
import {
  createRateLimiter,
  createSessions,
  hashPassword,
  newSessionKey,
  SESSION_KEY_SECRET,
  verifyPassword,
  type Secrets,
  type Sessions,
} from '../security/index.ts';
import type { PasswordHasher } from '../security/password.ts';
import { writeSetting, type Store } from '../store/index.ts';

// Owner access (ADR 9, ARCHITECTURE §4.10): the scrypt password hash in `settings`
// (PASSWORD_HASH_SETTING) and the session HMAC key in `secrets` (SESSION_KEY_SECRET).
// Setting or changing the password rotates the key, which ends every existing session.

export const PASSWORD_HASH_SETTING = 'passwordHash';
/** Password guesses (login, current password on change) allowed per client per window. */
export const LOGIN_RATE_LIMIT = { limit: 5, windowMs: 60_000 } as const;

const RATE_LIMITED = 'Too many attempts; try again in a minute';

export type PasswordChangeResult =
  { ok: true } | { ok: false; code: 'invalid' | 'rate_limited'; reason: string };

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; code: 'conflict' | 'unauthorized' | 'rate_limited'; reason: string };

export interface Access {
  /** Read from the DB on every call: a password set by the CLI applies to a running server. */
  hasPassword(): boolean;
  /** False when no password is set. */
  checkPassword(password: string): Promise<boolean>;
  /** Checks the password (rate-limited per `client`) and issues a session token. */
  login(password: string, client: string): Promise<LoginResult>;
  /** HTTP: `current` must match once a password is set (rate-limited per `client`). */
  changePassword(input: PasswordChangeRequest, client: string): Promise<PasswordChangeResult>;
  /** The owner on the host (scripts/set-password.ts): sets the password without the old one. */
  resetPassword(next: string): Promise<PasswordChangeResult>;
  sessions: Sessions;
}

export interface AccessDeps {
  store: Store;
  secrets: Secrets;
  clock: Clock;
  /** Defaults to the production scrypt hasher (N=2^15). Tests inject a cheap one (ADR 11). */
  passwords?: PasswordHasher;
}

const PRODUCTION_PASSWORDS: PasswordHasher = { hash: hashPassword, verify: verifyPassword };

export function createAccess({
  store,
  secrets,
  clock,
  passwords = PRODUCTION_PASSWORDS,
}: AccessDeps): Access {
  const limiter = createRateLimiter({ ...LOGIN_RATE_LIMIT, clock });
  const storedHash = (): string | undefined => {
    const raw = store.q.setting(PASSWORD_HASH_SETTING);
    if (raw === undefined) return undefined;
    const parsed = z.string().min(1).safeParse(raw);
    if (!parsed.success) throw new Error(`Setting ${PASSWORD_HASH_SETTING} is malformed`);
    return parsed.data;
  };

  const sessionKey = (): string => {
    const existing = secrets.get(SESSION_KEY_SECRET);
    if (existing !== undefined) return existing;
    const key = newSessionKey();
    secrets.set(SESSION_KEY_SECRET, key);
    return key;
  };

  const checkPassword = async (password: string): Promise<boolean> => {
    const hash = storedHash();
    return hash !== undefined && (await passwords.verify(password, hash));
  };

  const setPassword = async (next: string): Promise<PasswordChangeResult> => {
    const parsed = PasswordChangeRequestSchema.shape.next.safeParse(next);
    if (!parsed.success) {
      return { ok: false, code: 'invalid', reason: parsed.error.issues[0]?.message ?? 'Invalid' };
    }
    const hash = await passwords.hash(parsed.data);
    store.commit((tx) => {
      writeSetting(tx.db, PASSWORD_HASH_SETTING, hash);
      // Same connection as the commit: the new key joins this transaction.
      secrets.set(SESSION_KEY_SECRET, newSessionKey());
      return [
        {
          type: 'settings.changed',
          productId: null,
          entityId: null,
          v: 1,
          data: { sections: ['password'], keys: [] },
        },
      ];
    });
    return { ok: true };
  };

  const sessions = createSessions({ key: sessionKey, clock });

  return {
    hasPassword: () => storedHash() !== undefined,
    checkPassword,
    async login(password, client) {
      if (storedHash() === undefined) {
        return { ok: false, code: 'conflict', reason: 'No password is set' };
      }
      if (!limiter.attempt(client))
        return { ok: false, code: 'rate_limited', reason: RATE_LIMITED };
      if (!(await checkPassword(password))) {
        return { ok: false, code: 'unauthorized', reason: 'Wrong password' };
      }
      return { ok: true, token: sessions.issue() };
    },
    async changePassword({ current, next }, client) {
      if (storedHash() !== undefined) {
        if (current === undefined) {
          return { ok: false, code: 'invalid', reason: 'The current password is required' };
        }
        if (!limiter.attempt(client)) {
          return { ok: false, code: 'rate_limited', reason: RATE_LIMITED };
        }
        if (!(await checkPassword(current))) {
          return { ok: false, code: 'invalid', reason: 'The current password is wrong' };
        }
      }
      return setPassword(next);
    },
    resetPassword: setPassword,
    sessions,
  };
}
