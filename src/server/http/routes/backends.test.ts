import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeTokenViewSchema, ClaudeLoginResponseSchema } from '../../../shared/dto.ts';
import { createClaudeCodeToken } from '../../commands/index.ts';
import { FakeContainerRuntime } from '../../sandbox/index.ts';
import { CLAUDE_CODE_TOKEN_SECRET, createSecrets } from '../../security/index.ts';
import { expectSnapshotMatchesReplay } from '../../store/testing.ts';
import { createApp } from '../app.ts';
import { setupStore } from '../testing.ts';

function setup() {
  const base = setupStore();
  const app = createApp({
    store: base.store,
    ids: base.ids,
    git: base.git,
    redactor: base.redactor,
  });
  const clear = (backend: string) =>
    app.request(`/api/backends/${backend}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  const limited = (needsLogin: boolean) =>
    base.store.commit(() => [
      {
        type: 'backend.limited',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code', until: null, needsLogin, reason: 'Login expired' },
      },
    ]);
  const types = () => base.store.eventsSince(0).map((e) => e.type);
  return { ...base, app, clear, limited, types };
}

describe('POST /api/backends/:backend/clear', () => {
  it("clears needs_login for claude-code (the owner's 'I've logged in')", async () => {
    const h = setup();
    h.limited(true);
    expect(h.store.snapshot().state.backendLimits['claude-code']?.needsLogin).toBe(true);

    const res = await h.clear('claude-code');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.store.snapshot().state.backendLimits).toEqual({});
    const cleared = h.store.eventsSince(0).at(-1);
    expect(cleared).toMatchObject({ type: 'backend.cleared', data: { backend: 'claude-code' } });
    expectSnapshotMatchesReplay(h.store);
  });

  it('is idempotent: no event when the backend has no limit', async () => {
    const h = setup();
    const res = await h.clear('claude-code');
    expect(res.status).toBe(200);
    expect(h.types()).not.toContain('backend.cleared');
  });

  it('rejects an unknown backend with 400', async () => {
    const h = setup();
    h.limited(true);
    const res = await h.clear('not-a-backend');
    expect(res.status).toBe(400);
    expect(h.types()).not.toContain('backend.cleared');
  });
});

describe('GET /api/backends/claude-code/login', () => {
  it("answers the runtime's login commands: host uid:gid and the current Claude image", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'vibecode-login-'));
    try {
      const base = setupStore();
      const runtime = new FakeContainerRuntime({ dataDir, uid: 1501, gid: 20 });
      const app = createApp({
        store: base.store,
        ids: base.ids,
        git: base.git,
        redactor: base.redactor,
        claudeLogin: runtime,
      });

      const res = await app.request('/api/backends/claude-code/login');

      expect(res.status).toBe(200);
      const body = ClaudeLoginResponseSchema.parse(await res.json());
      const image = await runtime.ensureImage({
        productId: 'p1',
        contextDir: dataDir,
        claude: true,
      });
      expect(body).toEqual(await runtime.claudeLoginCommands());
      expect(body.login).toContain('--user 1501:20 ');
      expect(body.login).toContain(` ${image} claude auth login`);
      expect(body.volume).toBe('docker volume create vibecode-claude-config');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('is absent without a runtime', async () => {
    const h = setup();
    expect((await h.app.request('/api/backends/claude-code/login')).status).toBe(404);
  });
});

describe('GET|PUT /api/backends/claude-code/token', () => {
  const TOKEN = 'sk-ant-oat01-SubscriptionSetupToken-Wx9z';

  function tokenSetup() {
    const base = setup();
    const secrets = createSecrets(base);
    const app = createApp({
      store: base.store,
      ids: base.ids,
      git: base.git,
      redactor: base.redactor,
      claudeCodeToken: createClaudeCodeToken({ store: base.store, secrets }),
    });
    const call = async (method: 'GET' | 'PUT', body?: unknown) => {
      const res = await app.request('/api/backends/claude-code/token', {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return { status: res.status, text: await res.text() };
    };
    return { ...base, secrets, call };
  }

  it('is unset at first', async () => {
    const h = tokenSetup();
    const res = await h.call('GET');
    expect(res.status).toBe(200);
    expect(ClaudeCodeTokenViewSchema.parse(JSON.parse(res.text))).toEqual({
      set: false,
      last4: null,
    });
  });

  it('stores the token write-only: responses show {set, last4} and never the value', async () => {
    const h = tokenSetup();
    const put = await h.call('PUT', { token: TOKEN });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text)).toEqual({ set: true, last4: 'Wx9z' });
    expect(put.text).not.toContain(TOKEN);
    const get = await h.call('GET');
    expect(JSON.parse(get.text)).toEqual({ set: true, last4: 'Wx9z' });
    expect(get.text).not.toContain(TOKEN);
    expect(h.secrets.get(CLAUDE_CODE_TOKEN_SECRET)).toBe(TOKEN);
    expect(JSON.stringify(h.store.eventsSince(0))).not.toContain(TOKEN);
    expect(JSON.stringify(h.store.snapshot())).not.toContain(TOKEN);
  });

  it('removes the token with null', async () => {
    const h = tokenSetup();
    await h.call('PUT', { token: TOKEN });
    const res = await h.call('PUT', { token: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ set: false, last4: null });
    expect(h.secrets.get(CLAUDE_CODE_TOKEN_SECRET)).toBeUndefined();
  });

  it('rejects an invalid body with 400 without echoing the submitted value', async () => {
    const h = tokenSetup();
    for (const token of [`${TOKEN} extra`, 'short', '', `${TOKEN}${'Q'.repeat(5000)}`]) {
      const res = await h.call('PUT', { token });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(TOKEN);
      expect(res.text).not.toContain('short');
    }
    expect((await h.call('PUT', {})).status).toBe(400);
    expect(h.secrets.list()).toEqual([]);
  });

  it('saving a token clears an active claude-code needs_login limit', async () => {
    const h = tokenSetup();
    h.limited(true);
    const res = await h.call('PUT', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(h.store.snapshot().state.backendLimits).toEqual({});
    expect(h.store.eventsSince(0).at(-1)).toMatchObject({
      type: 'backend.cleared',
      data: { backend: 'claude-code' },
    });
    expectSnapshotMatchesReplay(h.store);
  });

  it('is absent without the command', async () => {
    const h = setup();
    expect((await h.app.request('/api/backends/claude-code/token')).status).toBe(404);
  });
});
