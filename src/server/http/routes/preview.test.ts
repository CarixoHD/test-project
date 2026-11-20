import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartPreviewResponseSchema } from '../../../shared/dto.ts';
import { ensureDataDir } from '../../config.ts';
import { createGit } from '../../git/index.ts';
import { createPreviews, FakeContainerRuntime } from '../../sandbox/index.ts';
import { createApp } from '../app.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../testing.ts';

let dataDir: string | undefined;

afterEach(() => {
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

/** Real git and the fake runtime, whose preview page really serves on 127.0.0.1 (demo mode). */
async function setup(preview: boolean) {
  const base = setupStore();
  dataDir = mkdtempSync(join(tmpdir(), 'vibecode-preview-routes-'));
  ensureDataDir(dataDir);
  const git = createGit({ dataDir });
  await git.initRepo(TEST_PRODUCT);
  const runtime = new FakeContainerRuntime({ dataDir });
  const previews = createPreviews({ ...base, git, runtime, dataDir });
  base.store.commit(() => [productCreated()]);
  if (preview) {
    base.store.commit(() => [
      {
        type: 'product.settings_changed',
        productId: TEST_PRODUCT,
        entityId: null,
        v: 1,
        data: {
          project: { check: ['true'], imageInputs: [], preview: { command: ['x'], port: 3000 } },
        },
      },
    ]);
  }
  const app = createApp({ ...base, git, previews });
  return { ...base, app, runtime };
}

describe('POST|DELETE /api/products/:id/preview', () => {
  it('starts a preview that serves on 127.0.0.1, then stops it', async () => {
    const { app, store, runtime } = await setup(true);

    const res = await app.request('/api/products/product-1/preview', { method: 'POST' });
    expect(res.status).toBe(200);
    const { url } = StartPreviewResponseSchema.parse(await res.json());
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect((await fetch(url)).status).toBe(200);
    expect(store.snapshot().state.previews[TEST_PRODUCT]?.url).toBe(url);

    const del = await app.request('/api/products/product-1/preview', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await runtime.listManaged()).toEqual([]);
    expect(store.snapshot().state.previews).toEqual({});
  });

  it('answers 409 without a preview config, and 404 for an unknown product', async () => {
    const { app } = await setup(false);

    const res = await app.request('/api/products/product-1/preview', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict' } });
    const stop = await app.request('/api/products/product-1/preview', { method: 'DELETE' });
    expect(stop.status).toBe(409);
    const missing = await app.request('/api/products/nope/preview', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});
