import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

/** Env vars through which playwright.config.ts shares its throwaway data dirs. */
export const DATA_DIR_ENV_VARS = [
  'VIBECODE_E2E_DATA_DIR',
  'VIBECODE_E2E_SETTINGS_DATA_DIR',
] as const;

/** Prefix of every data dir playwright.config.ts creates with mkdtemp. */
export const DATA_DIR_PREFIX = 'vibecode-e2e-';

/** Only dirs this suite made (mkdtemp in os.tmpdir() with our prefix) are ever deleted. */
const isSuiteDataDir = (dir: string): boolean =>
  dirname(resolve(dir)) === resolve(tmpdir()) && basename(dir).startsWith(DATA_DIR_PREFIX);

// Playwright runs globalTeardown before it stops the webServers, so deleting here would pull
// the data dirs out from under running servers. The runner process exits only after the
// servers are killed, so the dirs are removed on its exit instead.
export default function globalTeardown(): void {
  const dirs = DATA_DIR_ENV_VARS.map((name) => process.env[name]).filter(
    (dir): dir is string => dir !== undefined && isSuiteDataDir(dir),
  );
  process.once('exit', () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}
