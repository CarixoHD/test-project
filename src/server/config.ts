import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/** Subdirectories of the data dir (ARCHITECTURE §5 on-disk layout). */
export const DATA_SUBDIRS = ['repos', 'worktrees', 'logs', 'artifacts'] as const;
/** The empty file mounted read-only over `/workspace/.git` in containers. */
export const EMPTY_MASK_FILE = 'empty';
export const DB_FILE = 'vibecode.db';

const Flag = z
  .enum(['', '0', '1', 'false', 'true'])
  .default('')
  .transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  VIBECODE_DATA_DIR: z.string().min(1).optional(),
  VIBECODE_HOST: z.string().min(1).default('127.0.0.1'),
  VIBECODE_PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  VIBECODE_DEMO: Flag,
  VIBECODE_FAKE_DOCKER: Flag,
});

export interface Config {
  /** Absolute path of the data dir. */
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  /** Demo mode: fake LLM. */
  demo: boolean;
  /** Use the in-memory FakeContainerRuntime instead of Docker. */
  fakeDocker: boolean;
}

/** Parses the VIBECODE_* env vars; throws an error naming the bad variable. */
export function parseConfig(env: Record<string, string | undefined>, home = homedir()): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.VIBECODE_DATA_DIR ?? join(home, '.local', 'share', 'vibecode'));
  return {
    dataDir,
    dbPath: join(dataDir, DB_FILE),
    host: e.VIBECODE_HOST,
    port: e.VIBECODE_PORT,
    demo: e.VIBECODE_DEMO,
    fakeDocker: e.VIBECODE_FAKE_DOCKER,
  };
}

/** Creates (or tightens) the data dir 0700, its subdirs and the empty `.git` mask file. */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  for (const sub of DATA_SUBDIRS) {
    mkdirSync(join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  // 'a' creates the file when missing and never truncates or rewrites an existing one.
  closeSync(openSync(join(dataDir, EMPTY_MASK_FILE), 'a', 0o644));
}
