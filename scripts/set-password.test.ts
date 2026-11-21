import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../src/server/commands/index.ts';
import { open } from '../src/server/db/index.ts';
import { createSecrets, Redactor } from '../src/server/security/index.ts';
import { createStore } from '../src/server/store/index.ts';
import { FakeClock } from '../src/server/util/clock.ts';
import { modeFromArgs, removePassword, setPassword } from './set-password.ts';

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function accessFor(dataDir: string) {
  const db = open(join(dataDir, 'vibecode.db'));
  const clock = new FakeClock();
  const redactor = new Redactor();
  const store = createStore({ db, clock, redactor });
  const access = createAccess({ store, secrets: createSecrets({ db, clock, redactor }), clock });
  return { access, close: () => db.$client.close() };
}

describe('set-password CLI', () => {
  it('sets the password in the data dir without needing the old one', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-setpw-'));
    const dataDir = join(root, 'data');
    const env = { VIBECODE_DATA_DIR: dataDir };
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    expect(await setPassword({ env, password: 'correct horse battery', log })).toBe(0);
    expect(await setPassword({ env, password: 'staple battery horse', log })).toBe(0);
    expect(lines.join('\n')).not.toContain('battery');

    const { access, close } = accessFor(dataDir);
    try {
      expect(await access.checkPassword('staple battery horse')).toBe(true);
    } finally {
      close();
    }
  });

  it('removes the password without asking for the old one, with a confirmation', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-setpw-'));
    const dataDir = join(root, 'data');
    const env = { VIBECODE_DATA_DIR: dataDir };
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await setPassword({ env, password: 'correct horse battery', log });

    expect(await removePassword({ env, log })).toBe(0);
    expect(lines.at(-1)).toMatch(/Password removed/);

    const { access, close } = accessFor(dataDir);
    try {
      expect(access.hasPassword()).toBe(false);
    } finally {
      close();
    }
  });

  it('says no password is set and exits 0', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-setpw-'));
    const lines: string[] = [];
    const code = await removePassword({
      env: { VIBECODE_DATA_DIR: join(root, 'data') },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/No password is set/);
  });

  it('reads the --remove flag', () => {
    expect(modeFromArgs(['--remove'])).toBe('remove');
    expect(modeFromArgs(['--other'])).toBe('set');
    expect(modeFromArgs([])).toBe('set');
  });

  it('refuses a short password with exit code 1 and the reason', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-setpw-'));
    const dataDir = join(root, 'data');
    const lines: string[] = [];
    const code = await setPassword({
      env: { VIBECODE_DATA_DIR: dataDir },
      password: 'short',
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/12 characters/);
    const { access, close } = accessFor(dataDir);
    try {
      expect(access.hasPassword()).toBe(false);
    } finally {
      close();
    }
  });
});
