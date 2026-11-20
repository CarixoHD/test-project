import { describe, expect, it } from 'vitest';
import { SessionResponseSchema } from '../../shared/dto.ts';
import { createAccess, LOGIN_RATE_LIMIT } from '../commands/index.ts';
import { createSecrets, SESSION_COOKIE } from '../security/index.ts';
import { createApp } from './app.ts';
import type { ErrorBody } from './errors.ts';
import { productCreated, setupStore, TEST_PRODUCT } from './testing.ts';

const PW = 'correct horse battery';
const LOCAL = 'http://localhost:4317';
const JSON_HEADERS = { 'content-type': 'application/json' };

function setup() {
  const base = setupStore();
  const secrets = createSecrets(base);
  const access = createAccess({ store: base.store, secrets, clock: base.clock });
  const app = createApp({
    store: base.store,
    ids: base.ids,
    git: base.git,
    redactor: base.redactor,
    access,
    // Tests name their client; production uses the socket's remote address.
    clientKey: (c) => c.req.header('x-test-client') ?? 'test',
  });
  const req = (path: string, init: RequestInit = {}) => app.request(`${LOCAL}${path}`, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    req(path, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(body),
    });
  const login = async (password = PW, headers: Record<string, string> = {}) => {
    const res = await post('/api/login', { password }, headers);
    return { res, cookie: sessionCookie(res) };
  };
  return { ...base, access, app, req, post, login };
}

/** `name=value` of the session cookie a response sets, or undefined. */
function sessionCookie(res: Response): string | undefined {
  const header = res.headers.getSetCookie().find((h) => h.startsWith(`${SESSION_COOKIE}=`));
  return header?.split(';')[0];
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ErrorBody).error.code;
}

async function session(res: Response) {
  return SessionResponseSchema.parse(await res.json());
}

describe('access control without a password (loopback only)', () => {
  it('rejects a non-loopback Host header (DNS rebinding), on /api and the SPA', async () => {
    const { app } = setup();
    for (const path of ['/api/state', '/', '/api/session']) {
      const res = await app.request(path, { headers: { host: 'evil.example:4317' } });
      expect(res.status, path).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    }
  });

  it('serves loopback Host headers', async () => {
    const { app } = setup();
    for (const host of ['localhost:4317', '127.0.0.1:4317', '[::1]:4317']) {
      expect((await app.request('/api/state', { headers: { host } })).status, host).toBe(200);
    }
  });

  it('reports no password and treats loopback clients as authenticated', async () => {
    const { req } = setup();
    expect(await session(await req('/api/session'))).toEqual({
      passwordSet: false,
      authenticated: true,
    });
  });

  it('refuses login while no password is set', async () => {
    const { login } = setup();
    expect((await login()).res.status).toBe(409);
  });

  it('applies the Host check even when no access control is wired', async () => {
    const base = setupStore();
    const app = createApp({
      store: base.store,
      ids: base.ids,
      git: base.git,
      redactor: base.redactor,
    });
    expect((await app.request('/api/state', { headers: { host: 'evil.example' } })).status).toBe(
      403,
    );
  });
});

describe('mutations must be same-origin JSON', () => {
  it('rejects a non-JSON mutation with 415, with or without a password', async () => {
    const { req, access } = setup();
    const send = (headers: Record<string, string>) =>
      req('/api/products', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'x', idea: 'y' }),
      });
    for (const round of ['no password', 'password']) {
      if (round === 'password') await access.resetPassword(PW);
      expect((await send({})).status, round).toBe(415);
      expect((await send({ 'content-type': 'text/plain' })).status, round).toBe(415);
      expect((await send({ 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(
        415,
      );
      expect(await errorCode(await send({ 'content-type': 'multipart/form-data' }))).toBe(
        'unsupported_media_type',
      );
    }
  });

  it('rejects a cross-origin mutation with 403 and accepts same-origin or no Origin', async () => {
    const { post, store } = setup();
    store.commit(() => [productCreated()]);
    const pause = (headers: Record<string, string>) =>
      post(`/api/products/${TEST_PRODUCT}/pause`, {}, headers);

    const cross = await pause({ origin: 'http://evil.example' });
    expect(cross.status).toBe(403);
    expect(await errorCode(cross)).toBe('forbidden');
    expect((await pause({ origin: 'null' })).status).toBe(403);
    expect((await pause({ origin: 'http://localhost:9999' })).status).toBe(403);

    expect((await pause({ origin: LOCAL })).status).toBe(200);
    expect((await post(`/api/products/${TEST_PRODUCT}/resume`, {})).status).toBe(200);
  });

  it('accepts JSON with a charset parameter', async () => {
    const { post, store } = setup();
    store.commit(() => [productCreated()]);
    const res = await post(
      `/api/products/${TEST_PRODUCT}/pause`,
      {},
      {
        'content-type': 'Application/JSON; charset=utf-8',
      },
    );
    expect(res.status).toBe(200);
  });
});

describe('access control with a password', () => {
  async function withPassword() {
    const s = setup();
    await s.access.resetPassword(PW);
    return s;
  }

  it('requires a session on every /api route except login and session (SSE included)', async () => {
    const { req, post } = await withPassword();
    for (const path of ['/api/state', '/api/events', '/api/health', '/api/nope']) {
      const res = await req(path);
      expect(res.status, path).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
    expect((await post('/api/products', { name: 'x', idea: 'y' })).status).toBe(401);
    expect((await post('/api/logout', {})).status).toBe(401);
    expect(await session(await req('/api/session'))).toEqual({
      passwordSet: true,
      authenticated: false,
    });
  });

  it('allows a non-loopback Host once a password is set (it still needs a session)', async () => {
    const { app } = await withPassword();
    const res = await app.request('http://vibe.example/api/state');
    expect(res.status).toBe(401);
  });

  it('logs in with a signed HttpOnly SameSite=Strict 30-day cookie that opens /api', async () => {
    const { req, login } = await withPassword();
    const { res, cookie } = await login();
    expect(res.status).toBe(200);
    expect(cookie).toBeDefined();
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).toMatch(/Max-Age=2592000/);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Secure/);

    const headers = { cookie: cookie ?? '' };
    expect((await req('/api/state', { headers })).status).toBe(200);
    expect(await session(await req('/api/session', { headers }))).toEqual({
      passwordSet: true,
      authenticated: true,
    });
  });

  it('sets Secure on the cookie over HTTPS (directly or behind a TLS proxy)', async () => {
    const { app } = await withPassword();
    const body = JSON.stringify({ password: PW });
    const direct = await app.request('https://vibe.example/api/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
    });
    expect(direct.headers.get('set-cookie')).toMatch(/Secure/);
    const proxied = await app.request(`${LOCAL}/api/login`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-forwarded-proto': 'https', 'x-test-client': 'other' },
      body,
    });
    expect(proxied.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('rejects a wrong password and a forged or tampered cookie', async () => {
    const { req, login } = await withPassword();
    const wrong = await login('wrong password!!');
    expect(wrong.res.status).toBe(401);
    expect(wrong.cookie).toBeUndefined();

    const { cookie = '' } = await login();
    for (const bad of [`${cookie}x`, `${SESSION_COOKIE}=1.2.3`, `${SESSION_COOKIE}=`]) {
      expect((await req('/api/state', { headers: { cookie: bad } })).status, bad).toBe(401);
    }
  });

  it('expires the session after 30 days', async () => {
    const { req, login, clock } = await withPassword();
    const { cookie = '' } = await login();
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect((await req('/api/state', { headers: { cookie } })).status).toBe(401);
  });

  it('rate-limits login per client (429), with the injected clock', async () => {
    const { login, clock } = await withPassword();
    const a = { 'x-test-client': 'a' };
    for (let i = 0; i < LOGIN_RATE_LIMIT.limit; i++) {
      expect((await login('wrong password!!', a)).res.status).toBe(401);
    }
    const limited = await login(PW, a);
    expect(limited.res.status).toBe(429);
    expect(await errorCode(limited.res)).toBe('rate_limited');
    expect((await login(PW, { 'x-test-client': 'b' })).res.status).toBe(200);

    clock.advance(LOGIN_RATE_LIMIT.windowMs);
    expect((await login(PW, a)).res.status).toBe(200);
  });

  it('logout clears the cookie', async () => {
    const { post, login } = await withPassword();
    const { cookie = '' } = await login();
    const res = await post('/api/logout', {}, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
  });
});

describe('POST /api/settings/password', () => {
  const NEXT = 'staple battery horse';

  it('sets the first password without `current` and keeps the caller logged in', async () => {
    const { post, req, access } = setup();
    const res = await post('/api/settings/password', { next: PW });
    expect(res.status).toBe(200);
    expect(access.hasPassword()).toBe(true);
    const cookie = sessionCookie(res) ?? '';
    expect((await req('/api/state', { headers: { cookie } })).status).toBe(200);
  });

  it('rejects a password under 12 characters', async () => {
    const { post, access } = setup();
    const res = await post('/api/settings/password', { next: 'elevenchars' });
    expect(res.status).toBe(400);
    expect(access.hasPassword()).toBe(false);
  });

  it('needs a session and the current password once one is set; ends other sessions', async () => {
    const { post, req, login, access } = setup();
    await access.resetPassword(PW);
    expect((await post('/api/settings/password', { current: PW, next: NEXT })).status).toBe(401);

    const { cookie = '' } = await login();
    const headers = { cookie };
    expect((await post('/api/settings/password', { next: NEXT }, headers)).status).toBe(400);
    expect(
      (await post('/api/settings/password', { current: 'wrong password!!', next: NEXT }, headers))
        .status,
    ).toBe(400);

    const ok = await post('/api/settings/password', { current: PW, next: NEXT }, headers);
    expect(ok.status).toBe(200);
    expect(await access.checkPassword(NEXT)).toBe(true);
    expect((await req('/api/state', { headers })).status).toBe(401);
    const fresh = sessionCookie(ok) ?? '';
    expect((await req('/api/state', { headers: { cookie: fresh } })).status).toBe(200);
  });
});
