import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseProjectConfig, PROJECT_FILE, readProjectConfig } from './project-config.ts';

const VALID = { check: ['npm', 'test'], imageInputs: ['package-lock.json'] };

describe('parseProjectConfig', () => {
  it('returns the validated config', () => {
    const withPreview = { ...VALID, preview: { command: ['npm', 'start'], port: 3000 } };
    expect(parseProjectConfig(JSON.stringify(withPreview))).toEqual({
      ok: true,
      value: withPreview,
    });
  });

  it('rejects text that is not JSON', () => {
    expect(parseProjectConfig('{nope')).toEqual({
      ok: false,
      reason: `${PROJECT_FILE} is not valid JSON`,
    });
  });

  it('rejects JSON that does not match the schema', () => {
    const r = parseProjectConfig(JSON.stringify({ check: 'npm test' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^invalid \.vibecode\/project\.json: /);
  });
});

describe('readProjectConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vibecode-project-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is null when the file does not exist', async () => {
    expect(await readProjectConfig(dir)).toEqual({ ok: true, value: null });
  });

  it('reads and validates the worktree file', async () => {
    await mkdir(path.join(dir, '.vibecode'));
    await writeFile(path.join(dir, PROJECT_FILE), JSON.stringify(VALID));
    expect(await readProjectConfig(dir)).toEqual({ ok: true, value: VALID });
  });

  it('fails on an invalid file', async () => {
    await mkdir(path.join(dir, '.vibecode'));
    await writeFile(path.join(dir, PROJECT_FILE), '[]');
    expect((await readProjectConfig(dir)).ok).toBe(false);
  });
});
