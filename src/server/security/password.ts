import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Owner password hashing (ADR 9): scrypt from node:crypto, N=2^15, 16-byte salt, compared with
// timingSafeEqual. Stored as `scrypt$N$r$p$<salt b64url>$<hash b64url>`.
// ADR 11: N is a parameter so tests can inject a cheap hasher; production stays at 2^15.

const PRODUCTION_N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** False for a wrong password and for any hash not in the format this hasher's `hash` writes. */
  verify(password: string, stored: string): Promise<boolean>;
}

/** `verify` only accepts hashes with this hasher's own N, r and p. */
export function createPasswordHasher({ N }: { N: number }): PasswordHasher {
  // scrypt needs 128·N·r bytes; the default maxmem (32 MiB) is exactly that at N=2^15, so leave headroom.
  const options: ScryptOptions = { N, r: R, p: P, maxmem: 256 * N * R };

  const derive = (password: string, salt: Buffer): Promise<Buffer> =>
    new Promise((done, fail) => {
      scrypt(password.normalize('NFC'), salt, KEY_BYTES, options, (err, key) => {
        if (err) fail(err);
        else done(key);
      });
    });

  return {
    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      const key = await derive(password, salt);
      return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
    },
    async verify(password, stored) {
      const parts = stored.split('$');
      if (parts.length !== 6) return false;
      const [alg, n, r, p, saltText = '', keyText = ''] = parts;
      if (alg !== 'scrypt' || n !== String(N) || r !== String(R) || p !== String(P)) return false;
      const salt = Buffer.from(saltText, 'base64url');
      const expected = Buffer.from(keyText, 'base64url');
      if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
      const actual = await derive(password, salt);
      return timingSafeEqual(actual, expected);
    },
  };
}

/** The production hasher (N=2^15); `createAccess` uses it unless a test injects another. */
export const productionPasswordHasher: PasswordHasher = createPasswordHasher({ N: PRODUCTION_N });

export function hashPassword(password: string): Promise<string> {
  return productionPasswordHasher.hash(password);
}

/** False for a wrong password and for any hash not in the format `hashPassword` writes. */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return productionPasswordHasher.verify(password, stored);
}
