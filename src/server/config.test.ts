import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_SUBDIRS, ensureDataDir, parseConfig } from './config.ts';

const HOME = '/home/owner';

describe('parseConfig', () => {
  it('defaults to 127.0.0.1:4317 and ~/.local/share/vibecode, demo and fake docker off', () => {
    expect(parseConfig({}, HOME)).toEqual({
      dataDir: '/home/owner/.local/share/vibecode',
      dbPath: '/home/owner/.local/share/vibecode/vibecode.db',
      host: '127.0.0.1',
      port: 4317,
      demo: false,
      fakeDocker: false,
    });
  });

  it('reads every variable and resolves a relative data dir', () => {
    const cfg = parseConfig(
      {
        VIBECODE_DATA_DIR: '.data/dev',
        VIBECODE_HOST: '::1',
        VIBECODE_PORT: '5174',
        VIBECODE_DEMO: '1',
        VIBECODE_FAKE_DOCKER: 'true',
      },
      HOME,
    );
    expect(cfg).toMatchObject({ host: '::1', port: 5174, demo: true, fakeDocker: true });
    expect(cfg.dataDir).toBe(join(process.cwd(), '.data/dev'));
    expect(cfg.dbPath).toBe(join(process.cwd(), '.data/dev', 'vibecode.db'));
  });

  it('treats 0, false and empty flags as off', () => {
    const cfg = parseConfig({ VIBECODE_DEMO: '0', VIBECODE_FAKE_DOCKER: '' }, HOME);
    expect(cfg).toMatchObject({ demo: false, fakeDocker: false });
    expect(parseConfig({ VIBECODE_DEMO: 'false' }, HOME).demo).toBe(false);
  });

  it.each(['0', '70000', 'abc', '1.5'])('rejects VIBECODE_PORT=%s', (port) => {
    expect(() => parseConfig({ VIBECODE_PORT: port }, HOME)).toThrow(/VIBECODE_PORT/);
  });

  it('rejects an unknown flag value', () => {
    expect(() => parseConfig({ VIBECODE_DEMO: 'yes please' }, HOME)).toThrow(/VIBECODE_DEMO/);
  });
});

describe('ensureDataDir', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const mode = (p: string) => statSync(p).mode & 0o777;

  it('creates the data dir 0700 with its subdirs and the empty mask file', () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-cfg-'));
    const dataDir = join(root, 'nested', 'data');
    ensureDataDir(dataDir);

    expect(mode(dataDir)).toBe(0o700);
    expect(DATA_SUBDIRS).toEqual(['repos', 'worktrees', 'logs', 'artifacts']);
    for (const sub of DATA_SUBDIRS) {
      expect(statSync(join(dataDir, sub)).isDirectory()).toBe(true);
      expect(mode(join(dataDir, sub))).toBe(0o700);
    }
    expect(statSync(join(dataDir, 'empty')).isFile()).toBe(true);
    expect(readFileSync(join(dataDir, 'empty'), 'utf8')).toBe('');
  });

  it('is idempotent and tightens an existing data dir to 0700', () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-cfg-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    ensureDataDir(dataDir);
    ensureDataDir(dataDir);
    expect(mode(dataDir)).toBe(0o700);
    expect(existsSync(join(dataDir, 'empty'))).toBe(true);
  });
});
