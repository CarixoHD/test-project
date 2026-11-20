import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateResponseSchema } from '../../shared/dto.ts';
import { InboxIdSchema } from '../../shared/ids.ts';
import { createApp } from './index.ts';
import { productCreated, setupStore, sparMessage } from './testing.ts';

function setup(webRoot?: string) {
  const deps = setupStore();
  return { ...deps, app: createApp({ ...deps, webRoot }) };
}

describe('GET /api/health', () => {
  it('returns {ok:true}', async () => {
    const res = await setup().app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('GET /api/state', () => {
  it('returns an empty snapshot with lastSeq 0 on a fresh store', async () => {
    const res = await setup().app.request('/api/state');
    expect(res.status).toBe(200);
    const body = StateResponseSchema.parse(await res.json());
    expect(body.lastSeq).toBe(0);
    expect(body.state).toEqual(setupStore().store.snapshot().state);
  });

  it('returns the store snapshot and the seq it is consistent with', async () => {
    const { app, store } = setup();
    store.commit(() => [productCreated('Todo')]);
    store.commit(() => [sparMessage('m1', 'hello')]);

    const body = StateResponseSchema.parse(await (await app.request('/api/state')).json());
    expect(body.lastSeq).toBe(2);
    expect(body).toEqual(store.snapshot());
    expect(JSON.stringify(body.state)).toContain('Todo');
  });
});

describe('static web root', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeWebRoot(): string {
    dir = mkdtempSync(join(tmpdir(), 'vibecode-web-'));
    writeFileSync(join(dir, 'index.html'), '<h1>Vibecode</h1>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    return dir;
  }

  it('serves built files and falls back to index.html for client routes', async () => {
    const { app } = setup(makeWebRoot());
    expect(await (await app.request('/app.js')).text()).toBe('console.log(1)');
    expect(await (await app.request('/')).text()).toContain('Vibecode');
    expect(await (await app.request('/products/abc')).text()).toContain('Vibecode');
  });

  it('keeps unknown /api paths as JSON 404s and API routes working', async () => {
    const { app } = setup(makeWebRoot());
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'No route for GET /api/nope' },
    });
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true });
    expect((await app.request('/api/state')).status).toBe(200);
  });

  it('serves nothing statically when the web root does not exist', async () => {
    const { app } = setup(join(tmpdir(), 'vibecode-missing-web-root'));
    expect((await app.request('/')).status).toBe(404);
  });
});

describe('POST /api/inbox/:id/read', () => {
  it('is mounted: marks an existing inbox item read and 404s an unknown one', async () => {
    const { app, store } = setup();
    store.commit(() => [
      {
        type: 'inbox.created',
        productId: null,
        entityId: InboxIdSchema.parse('inbox-1'),
        v: 1,
        data: { kind: 'rate_limited', title: 'Rate limited', body: 'slow down', link: null },
      },
    ]);

    const res = await app.request('/api/inbox/inbox-1/read', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.snapshot().state.inbox[InboxIdSchema.parse('inbox-1')]?.read).toBe(true);

    const missing = await app.request('/api/inbox/nope/read', { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
