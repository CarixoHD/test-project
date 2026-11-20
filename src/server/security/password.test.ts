import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('stores scrypt with N=2^15 and a fresh 16-byte salt, never the password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse');
    const [alg, n, r, p, salt] = a.split('$');
    expect([alg, n, r, p]).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(salt ?? '', 'base64url')).toHaveLength(16);
  });

  it('rejects malformed or tampered hashes instead of throwing', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', 'garbage')).toBe(false);
    expect(await verifyPassword('correct horse battery', hash.slice(0, -4))).toBe(false);
    expect(await verifyPassword('x', hash.replace('$32768$', '$2$'))).toBe(false);
  });
});
