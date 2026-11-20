import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateResponseSchema } from '../shared/dto.ts';
import { parseConfig } from './config.ts';
import { start, type Running } from './main.ts';

describe('start (composition root)', () => {
  let root: string | undefined;
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('binds 127.0.0.1 by default, creates the data dir and DB, and serves /api/state', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const dataDir = join(root, 'data');
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: dataDir }), port: 0 };
    expect(config.host).toBe('127.0.0.1');

    running = await start(config, join(root, 'no-web'));
    expect(running.address.host).toBe('127.0.0.1');
    expect(existsSync(join(dataDir, 'vibecode.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'empty'))).toBe(true);

    const res = await fetch(`http://127.0.0.1:${String(running.address.port)}/api/state`);
    expect(res.status).toBe(200);
    expect(StateResponseSchema.parse(await res.json()).lastSeq).toBe(0);
  });

  it('serves /api/settings and keeps a stored key masked across a restart', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
    const key = 'sk-ant-api03-boot-test-secret-5678';
    running = await start(config, join(root, 'no-web'));
    const url = () => `http://127.0.0.1:${String(running?.address.port)}/api/settings`;
    const put = await fetch(url(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: { anthropic: key } }),
    });
    expect(put.status).toBe(200);
    await running.close();

    running = await start(config, join(root, 'no-web'));
    const text = await (await fetch(url())).text();
    expect(text).not.toContain(key);
    expect(JSON.parse(text)).toMatchObject({ keys: [{ provider: 'anthropic', last4: '5678' }] });
  });
});
