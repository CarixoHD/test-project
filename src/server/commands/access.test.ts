import { describe, expect, it } from 'vitest';
import { setupStore } from '../http/testing.ts';
import { createSecrets, SESSION_KEY_SECRET } from '../security/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { createAccess, LOGIN_RATE_LIMIT, PASSWORD_HASH_SETTING } from './access.ts';

const PW = 'correct horse battery';
const PW2 = 'staple battery horse';

function setup() {
  const base = setupStore();
  const secrets = createSecrets(base);
  const access = createAccess({ store: base.store, secrets, clock: base.clock });
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
