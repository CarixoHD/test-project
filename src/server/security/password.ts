import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Owner password hashing (ADR 9): scrypt from node:crypto, N=2^15, 16-byte salt, compared with
// timingSafeEqual. Stored as `scrypt$N$r$p$<salt b64url>$<hash b64url>`.

const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** scrypt needs 128·N·r bytes; the default maxmem (32 MiB) is exactly that, so leave headroom. */
const MAXMEM = 256 * N * R;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  const options: ScryptOptions = { N, r: R, p: P, maxmem: MAXMEM };
  return new Promise((done, fail) => {
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, options, (err, key) => {
      if (err) fail(err);
      else done(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** False for a wrong password and for any hash not in the format `hashPassword` writes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [alg, n, r, p, saltText = '', keyText = ''] = parts;
  if (alg !== 'scrypt' || n !== String(N) || r !== String(R) || p !== String(P)) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(keyText, 'base64url');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
