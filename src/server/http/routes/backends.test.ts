import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeLoginResponseSchema } from '../../../shared/dto.ts';
import { FakeContainerRuntime } from '../../sandbox/index.ts';
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
