import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, readListenConfig } from './main.ts';

describe('GET /api/health', () => {
  it('returns {ok:true}', async () => {
    const res = await createApp().request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
    const app = createApp({ webRoot: makeWebRoot() });
    expect(await (await app.request('/app.js')).text()).toBe('console.log(1)');
    expect(await (await app.request('/')).text()).toContain('Vibecode');
    expect(await (await app.request('/products/abc')).text()).toContain('Vibecode');
  });

  it('keeps unknown /api paths as 404 and health working', async () => {
    const app = createApp({ webRoot: makeWebRoot() });
    expect((await app.request('/api/nope')).status).toBe(404);
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true });
  });

  it('serves nothing statically when the web root does not exist', async () => {
    const app = createApp({ webRoot: join(tmpdir(), 'vibecode-missing-web-root') });
    expect((await app.request('/')).status).toBe(404);
  });
});

describe('readListenConfig', () => {
  it('defaults to 127.0.0.1:4317', () => {
    expect(readListenConfig({})).toEqual({ host: '127.0.0.1', port: 4317 });
  });

  it('reads VIBECODE_HOST and VIBECODE_PORT', () => {
    expect(readListenConfig({ VIBECODE_HOST: '::1', VIBECODE_PORT: '5174' })).toEqual({
      host: '::1',
      port: 5174,
    });
  });

  it.each(['0', '70000', 'abc', '1.5'])('rejects VIBECODE_PORT=%s', (port) => {
    expect(() => readListenConfig({ VIBECODE_PORT: port })).toThrow();
  });
});
