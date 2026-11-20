import { z } from 'zod';
import { PasswordChangeRequestSchema, type PasswordChangeRequest } from '../../shared/dto.ts';
import type { Clock } from '../../shared/ids.ts';
import {
  createSessions,
  hashPassword,
  newSessionKey,
  SESSION_KEY_SECRET,
  verifyPassword,
  type Secrets,
  type Sessions,
} from '../security/index.ts';
import { writeSetting, type Store } from '../store/index.ts';

// Owner access (ADR 9, ARCHITECTURE §4.10): the scrypt password hash in `settings`
// (PASSWORD_HASH_SETTING) and the session HMAC key in `secrets` (SESSION_KEY_SECRET).
// Setting or changing the password rotates the key, which ends every existing session.

export const PASSWORD_HASH_SETTING = 'passwordHash';

export type PasswordChangeResult = { ok: true } | { ok: false; code: 'invalid'; reason: string };

export interface Access {
  /** Read from the DB on every call: a password set by the CLI applies to a running server. */
  hasPassword(): boolean;
  /** False when no password is set. */
  checkPassword(password: string): Promise<boolean>;
  /** HTTP: `current` must match once a password is set. */
  changePassword(input: PasswordChangeRequest): Promise<PasswordChangeResult>;
  /** The owner on the host (scripts/set-password.ts): sets the password without the old one. */
  resetPassword(next: string): Promise<PasswordChangeResult>;
  sessions: Sessions;
}

export interface AccessDeps {
  store: Store;
  secrets: Secrets;
  clock: Clock;
}

export function createAccess({ store, secrets, clock }: AccessDeps): Access {
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
    return hash !== undefined && (await verifyPassword(password, hash));
  };

  const setPassword = async (next: string): Promise<PasswordChangeResult> => {
    const parsed = PasswordChangeRequestSchema.shape.next.safeParse(next);
    if (!parsed.success) {
      return { ok: false, code: 'invalid', reason: parsed.error.issues[0]?.message ?? 'Invalid' };
    }
    const hash = await hashPassword(parsed.data);
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

  return {
    hasPassword: () => storedHash() !== undefined,
    checkPassword,
    async changePassword({ current, next }) {
      if (storedHash() !== undefined) {
        if (current === undefined) {
          return { ok: false, code: 'invalid', reason: 'The current password is required' };
        }
        if (!(await checkPassword(current))) {
          return { ok: false, code: 'invalid', reason: 'The current password is wrong' };
        }
      }
      return setPassword(next);
    },
    resetPassword: setPassword,
    sessions: createSessions({ key: sessionKey, clock }),
  };
}
