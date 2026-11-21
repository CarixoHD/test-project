import { describe, expect, it } from 'vitest';
import { setupStore } from '../http/testing.ts';
import { createSecrets, SESSION_KEY_SECRET, verifyPassword } from '../security/index.ts';
import { fastPasswordHasher } from '../security/password.testing.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { createAccess, LOGIN_RATE_LIMIT, PASSWORD_HASH_SETTING } from './access.ts';

const PW = 'correct horse battery';
const PW2 = 'staple battery horse';

function setup() {
  const base = setupStore();
  const secrets = createSecrets(base);
  const access = createAccess({
    store: base.store,
    secrets,
    clock: base.clock,
    passwords: fastPasswordHasher,
  });
  return { ...base, secrets, access };
}

describe('access (owner password and sessions)', () => {
  it('starts without a password; the first password needs no current one', async () => {
    const { access, store } = setup();
    expect(access.hasPassword()).toBe(false);
    expect(await access.checkPassword(PW)).toBe(false);

    expect(await access.changePassword({ next: PW }, 'c')).toEqual({ ok: true });
    expect(access.hasPassword()).toBe(true);
    expect(await access.checkPassword(PW)).toBe(true);
    expect(await access.checkPassword(PW2)).toBe(false);
    expect(String(store.q.setting(PASSWORD_HASH_SETTING))).toMatch(/^scrypt\$/);
  });

  it('requires the right current password to change an existing one', async () => {
    const { access } = setup();
    await access.changePassword({ next: PW }, 'c');

    expect(await access.changePassword({ next: PW2 }, 'c')).toMatchObject({ ok: false });
    expect(await access.changePassword({ current: PW2, next: PW2 }, 'c')).toMatchObject({
      ok: false,
    });
    expect(await access.checkPassword(PW)).toBe(true);

    expect(await access.changePassword({ current: PW, next: PW2 }, 'c')).toEqual({ ok: true });
    expect(await access.checkPassword(PW2)).toBe(true);
  });

  it('logs in with the right password, rate-limited per client with the injected clock', async () => {
    const { access, clock } = setup();
    expect(await access.login(PW, 'a')).toMatchObject({ ok: false, code: 'conflict' });
    await access.resetPassword(PW);

    const ok = await access.login(PW, 'a');
    expect(ok.ok && access.sessions.verify(ok.token)).toBe(true);
    for (let i = 0; i < LOGIN_RATE_LIMIT.limit - 1; i++) {
      expect(await access.login(PW2, 'a')).toMatchObject({ ok: false, code: 'unauthorized' });
    }
    expect(await access.login(PW, 'a')).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await access.login(PW, 'b')).toMatchObject({ ok: true });
    clock.advance(LOGIN_RATE_LIMIT.windowMs);
    expect(await access.login(PW, 'a')).toMatchObject({ ok: true });
  });

  it('rate-limits current-password guesses on change', async () => {
    const { access } = setup();
    await access.resetPassword(PW);
    for (let i = 0; i < LOGIN_RATE_LIMIT.limit; i++) {
      await access.changePassword({ current: PW2, next: PW2 }, 'a');
    }
    expect(await access.changePassword({ current: PW, next: PW2 }, 'a')).toMatchObject({
      ok: false,
      code: 'rate_limited',
    });
  });

  it('hashes and checks with the injected hasher', async () => {
    const { access, store } = setup();
    await access.resetPassword(PW);
    const hash = String(store.q.setting(PASSWORD_HASH_SETTING));
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await fastPasswordHasher.verify(PW, hash)).toBe(true);
    expect(await access.checkPassword(PW)).toBe(true);
  });

  it('defaults to the production hasher (N=2^15) when none is injected', async () => {
    const base = setupStore();
    const access = createAccess({
      store: base.store,
      secrets: createSecrets(base),
      clock: base.clock,
    });
    await access.resetPassword(PW);
    const hash = String(base.store.q.setting(PASSWORD_HASH_SETTING));
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PW, hash)).toBe(true);
    expect(await access.checkPassword(PW)).toBe(true);
  });

  it('rejects a short password', async () => {
    const { access } = setup();
    expect(await access.changePassword({ next: 'short' }, 'c')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/12 characters/) as unknown,
    });
    expect(access.hasPassword()).toBe(false);
  });

  it('keeps the session key in secrets and rotates it on a password change', async () => {
    const { access, secrets } = setup();
    const before = access.sessions.issue();
    expect(access.sessions.verify(before)).toBe(true);
    expect(secrets.get(SESSION_KEY_SECRET)).toBeDefined();

    await access.resetPassword(PW);
    expect(access.sessions.verify(before)).toBe(false);
    expect(access.sessions.verify(access.sessions.issue())).toBe(true);
  });

  it('keeps logged-out sessions revoked in secrets, across a restart', () => {
    const base = setupStore();
    const start = () =>
      createAccess({
        store: base.store,
        secrets: createSecrets(base),
        clock: base.clock,
        passwords: fastPasswordHasher,
      });
    const first = start();
    const loggedOut = first.sessions.issue();
    const kept = first.sessions.issue();
    first.sessions.revoke(loggedOut);

    const restarted = start();
    expect(restarted.sessions.verify(loggedOut)).toBe(false);
    expect(restarted.sessions.verify(kept)).toBe(true);
  });

  it('removes the password with the right current one and ends every session', async () => {
    const { access, store, secrets } = setup();
    // Nothing to remove: 409 (the route answers 409 too).
    expect(await access.removePassword({ current: PW }, 'c')).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    await access.resetPassword(PW);
    const session = access.sessions.issue();
    expect(access.sessions.verify(session)).toBe(true);

    expect(await access.removePassword({ current: PW2 }, 'c')).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
    expect(access.hasPassword()).toBe(true);

    expect(await access.removePassword({ current: PW }, 'c')).toEqual({ ok: true });
    expect(access.hasPassword()).toBe(false);
    expect(store.q.setting(PASSWORD_HASH_SETTING)).toBeUndefined();
    expect(access.sessions.verify(session)).toBe(false);
    expect(secrets.get(SESSION_KEY_SECRET)).toBeDefined();
    const events = store.eventsSince(0);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['settings.changed', { sections: ['password'], keys: [] }],
      ['settings.changed', { sections: ['password'], keys: [] }],
    ]);
    expect(JSON.stringify(events)).not.toContain('scrypt');
    expectSnapshotMatchesReplay(store);
  });

  it('rate-limits current-password guesses on removal, like a change', async () => {
    const { access } = setup();
    await access.resetPassword(PW);
    for (let i = 0; i < LOGIN_RATE_LIMIT.limit; i++) {
      expect(await access.removePassword({ current: PW2 }, 'a')).toMatchObject({
        ok: false,
        code: 'unauthorized',
      });
    }
    expect(await access.removePassword({ current: PW }, 'a')).toMatchObject({
      ok: false,
      code: 'rate_limited',
    });
    expect(access.hasPassword()).toBe(true);
  });

  it('refuses removal while bound to a non-loopback host (boot would then fail)', async () => {
    const base = setupStore();
    const access = createAccess({
      store: base.store,
      secrets: createSecrets(base),
      clock: base.clock,
      passwords: fastPasswordHasher,
      bindHost: '0.0.0.0',
    });
    await access.resetPassword(PW);
    expect(await access.removePassword({ current: PW }, 'c')).toMatchObject({
      ok: false,
      code: 'conflict',
      reason: expect.stringMatching(/VIBECODE_HOST=0\.0\.0\.0/) as unknown,
    });
    expect(access.hasPassword()).toBe(true);
  });

  it('clears the password for the CLI without the current one', async () => {
    const { access, store } = setup();
    await access.resetPassword(PW);
    const session = access.sessions.issue();
    access.clearPassword();
    expect(access.hasPassword()).toBe(false);
    expect(access.sessions.verify(session)).toBe(false);
    expect(store.q.setting(PASSWORD_HASH_SETTING)).toBeUndefined();
  });

  it('records settings.changed{password} without the hash, and snapshot ≡ replay', async () => {
    const { access, store } = setup();
    await access.changePassword({ next: PW }, 'c');
    const events = store.eventsSince(0);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['settings.changed', { sections: ['password'], keys: [] }],
    ]);
    expect(JSON.stringify(events)).not.toContain('scrypt');
    expectSnapshotMatchesReplay(store);
  });
});
