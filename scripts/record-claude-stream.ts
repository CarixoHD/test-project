// Records one real Claude Code stream-json run as a test fixture (issue #59 needs real streams):
// `npm run -s claude:record` (see `-- --help`). It runs the pinned CLI in the current content-hashed
// vibecode/claude-code image as the host uid:gid, using exactly the argv the ClaudeCodeBackend
// uses, for a tiny structured task. Auth: CLAUDE_CODE_OAUTH_TOKEN from the environment when set
// (passed by name only, ADR 13), otherwise the vibecode-claude-config login volume. The raw
// NDJSON goes through the Redactor before it is written. The script never reads the volume itself
// (the CLI inside the container does), and never prints the login or the token. Values stored in the app's
// `secrets` table (read-only, only when the DB already exists) are registered with the Redactor too.
import { existsSync } from 'node:fs';
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import type { Role } from '../src/shared/models.ts';
import { buildClaudeArgv, claudeExecArgv, type AgentLimits } from '../src/server/agents/index.ts';
import { parseConfig } from '../src/server/config.ts';
import { schema } from '../src/server/db/index.ts';
import {
  AGENT_HOME,
  CLAUDE_CONFIG_VOLUME,
  DEFAULT_BASE_IMAGE_DIR,
  TMP_TMPFS,
  baseImageTag,
  claudeImageTag,
  limitArgs,
} from '../src/server/sandbox/index.ts';
import { createSecrets, redactor, type Redactor } from '../src/server/security/index.ts';
import { exec as defaultExec } from '../src/server/util/exec.ts';

export const DEFAULT_OUT = path.join(
  import.meta.dirname,
  '..',
  'src',
  'server',
  'agents',
  'fixtures',
  'real-success.ndjson',
);
export const DEFAULT_MODEL = 'sonnet';
/** Read-only tools: the task needs none, and the recording must not change anything. */
export const RECORD_ROLE: Role = 'utility';
export const RECORD_LIMITS: AgentLimits = { maxSteps: 3, wallClockMs: 5 * 60_000 };
export const RecordResultSchema = z.object({ ok: z.boolean() });
const RECORD_PROMPT =
  'This is a test recording. Do not use any tools. Reply with the structured result {"ok":true}.';
const VERSION_TIMEOUT_MS = 60_000;
/** Env vars whose values are registered with the Redactor before recording. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
/** The `claude setup-token` subscription token the CLI reads (ADR 13). */
export const CLAUDE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export const USAGE = `Usage: npm run -s claude:record -- [--out <file>] [--model <model>]

Runs the pinned Claude Code CLI once in the current vibecode/claude-code image, as your
uid:gid, using the same argv as the Claude Code backend (stream-json + --json-schema) for a
tiny task that replies {"ok":true}. Prints the CLI version and writes the redacted NDJSON
stream to a fixture file.

Auth: if ${CLAUDE_OAUTH_TOKEN_ENV} is set (the token \`claude setup-token\` prints), it is
passed to the container by name only and no volume is mounted. Otherwise the
${CLAUDE_CONFIG_VOLUME} login volume is mounted at ~/.claude.

Options:
  --out <file>     Where to write the stream (default: src/server/agents/fixtures/real-success.ndjson)
  --model <model>  Claude model alias or id passed to --model (default: ${DEFAULT_MODEL})
  -h, --help       Show this help

Needs Docker, the built image (npm run -s docker:images | sh) and either the token or a
volume login (README, Claude Code).
`;

export type RecordOptions = { out: string; model: string };
export type ParsedArgs =
  { kind: 'help' } | { kind: 'error'; message: string } | ({ kind: 'run' } & RecordOptions);

export function parseRecordArgs(args: readonly string[]): ParsedArgs {
  const opts: RecordOptions = { out: DEFAULT_OUT, model: DEFAULT_MODEL };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-h' || arg === '--help') return { kind: 'help' };
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (name !== '--out' && name !== '--model') {
      return { kind: 'error', message: `Unknown option: ${arg}` };
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || value === '') {
      return { kind: 'error', message: `${name} needs a value` };
    }
    if (name === '--out') opts.out = value;
    else opts.model = value;
  }
  return { kind: 'run', ...opts };
}

export type RecordDeps = {
  /** The current content-hashed vibecode/claude-code tag (as scripts/build-images.ts computes it). */
  claudeTag: () => Promise<string>;
  /** Every value in the app's `secrets` table (none when there is no DB yet). */
  loadStoredSecrets: () => Promise<string[]>;
  uid: number;
  gid: number;
  redactor: Redactor;
  exec: typeof defaultExec;
  writeFile: (file: string, text: string) => Promise<void>;
  log: (line: string) => void;
  /** CLAUDE_CODE_OAUTH_TOKEN from the environment; when non-empty it replaces the login volume. */
  oauthToken?: string | undefined;
};

/** Registers the value of every env var whose name looks secret (e.g. CLAUDE_CODE_OAUTH_TOKEN). */
export function registerEnvSecrets(
  env: Record<string, string | undefined>,
  target: Pick<Redactor, 'register'>,
): void {
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '' && SECRET_ENV_NAME.test(name)) target.register(value);
  }
}

/**
 * Reads every value of the `secrets` table from the DB at `dbPath`, opened read-only. A missing
 * DB is never created or migrated: logs a note and returns no values.
 */
export async function loadStoredSecrets(
  dbPath: string,
  log: (line: string) => void,
): Promise<string[]> {
  if (!existsSync(dbPath)) {
    log(`No database at ${dbPath}: no stored secrets to redact.`);
    return [];
  }
  const client = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const values: string[] = [];
    // createSecrets registers every stored value at boot; collect them instead of redacting here.
    createSecrets({
      db: drizzle({ client, schema }),
      clock: { now: () => 0 },
      redactor: { register: (value) => values.push(value) },
    });
    return values;
  } finally {
    client.close();
  }
}

/**
 * `docker run` options shared by both calls: never pull, run as the host identity, with the
 * sandbox hardening (CODING_STANDARDS §7: no capabilities, no-new-privileges, read-only rootfs
 * with a tmpfs /tmp, CPU/memory/pids limits from src/server/sandbox so they cannot drift).
 * This owner-only tool deliberately does not use buildRunArgs (and calls docker from scripts/,
 * cf. ARCHITECTURE §4 / AGENTS.md rule 8): buildRunArgs needs a worktree under the data dir to
 * mount, and this one-off recording has none.
 */
function baseRunArgs(uid: number, gid: number): string[] {
  return [
    ...['run', '--rm', '--init', '--pull', 'never', '--user', `${uid}:${gid}`],
    ...['--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges:true'],
    '--read-only',
    ...['--tmpfs', TMP_TMPFS],
    ...limitArgs(),
  ];
}

/** Records one run; returns the process exit code. */
export async function recordClaudeStream(o: RecordOptions, deps: RecordDeps): Promise<number> {
  const { uid, gid } = deps;
  for (const value of await deps.loadStoredSecrets()) deps.redactor.register(value);
  const token = deps.oauthToken === '' ? undefined : deps.oauthToken;
  if (token !== undefined) deps.redactor.register(token);
  const tag = await deps.claudeTag();
  const clean = (text: string) => deps.redactor.redact(text).trim();

  const version = await deps.exec(
    'docker',
    [...baseRunArgs(uid, gid), tag, 'claude', '--version'],
    { timeoutMs: VERSION_TIMEOUT_MS },
  );
  if (version.code !== 0) {
    deps.log(`claude --version failed in ${tag}: ${clean(version.stderr)}`);
    return 1;
  }
  deps.log(`Claude Code CLI version: ${clean(version.stdout)} (${tag})`);

  const cli = claudeExecArgv(
    buildClaudeArgv({
      role: RECORD_ROLE,
      model: { provider: 'claude-code', model: o.model },
      limits: RECORD_LIMITS,
      schema: RecordResultSchema,
    }),
  );
  deps.log(`Claude Code auth: ${token === undefined ? 'login volume' : 'token from environment'}`);
  // With a token, `--env NAME` makes docker copy the value from the exec env: never in argv.
  const auth =
    token === undefined
      ? ['--mount', `type=volume,src=${CLAUDE_CONFIG_VOLUME},dst=${AGENT_HOME}/.claude`]
      : ['--env', CLAUDE_OAUTH_TOKEN_ENV];
  const run = await deps.exec(
    'docker',
    [
      ...baseRunArgs(uid, gid),
      '--interactive',
      ...[
        '--tmpfs',
        `${AGENT_HOME}:rw,nosuid,nodev,exec,size=256m,mode=0700,uid=${uid},gid=${gid}`,
      ],
      ...auth,
      ...['--env', `HOME=${AGENT_HOME}`],
      ...['--workdir', '/tmp'],
      tag,
      ...cli,
    ],
    {
      input: RECORD_PROMPT,
      timeoutMs: RECORD_LIMITS.wallClockMs,
      killSignal: 'SIGINT',
      ...(token === undefined ? {} : { env: { [CLAUDE_OAUTH_TOKEN_ENV]: token } }),
    },
  );

  const ndjson = deps.redactor.redact(run.stdout);
  if (ndjson.trim() === '') {
    deps.log(`The CLI produced no output (exit ${String(run.code)}): ${clean(run.stderr)}`);
    return 1;
  }
  await deps.writeFile(o.out, ndjson.endsWith('\n') ? ndjson : `${ndjson}\n`);
  const lines = ndjson.split('\n').filter((l) => l.trim() !== '').length;
  deps.log(`Wrote ${lines} redacted lines to ${o.out}`);
  if (run.code !== 0 || run.timedOut) {
    deps.log(
      `The CLI exited with ${run.timedOut ? 'a timeout' : String(run.code)}: ${clean(run.stderr)}`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const parsed = parseRecordArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
  } else if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    registerEnvSecrets(process.env, redactor);
    const log = (line: string) => console.log(line);
    const { dbPath } = parseConfig(process.env);
    process.exitCode = await recordClaudeStream(parsed, {
      loadStoredSecrets: () => loadStoredSecrets(dbPath, log),
      claudeTag: async () =>
        claudeImageTag(DEFAULT_BASE_IMAGE_DIR, '', await baseImageTag(DEFAULT_BASE_IMAGE_DIR)),
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      redactor,
      exec: defaultExec,
      writeFile: async (file, text) => {
        await mkdir(path.dirname(file), { recursive: true });
        await fsWriteFile(file, text);
      },
      log,
      oauthToken: process.env[CLAUDE_OAUTH_TOKEN_ENV],
    });
  }
}
