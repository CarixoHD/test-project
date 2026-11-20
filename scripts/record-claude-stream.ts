// Records one real Claude Code stream-json run as a test fixture (issue #59 needs real streams):
// `npm run -s claude:record` (see `-- --help`). It runs the pinned CLI in the current content-hashed
// vibecode/claude-code image as the host uid:gid with the vibecode-claude-config login volume
// mounted, using exactly the argv the ClaudeCodeBackend uses, for a tiny structured task. The raw
// NDJSON goes through the Redactor before it is written. The script never reads the volume itself
// (the CLI inside the container does), and never prints the login.
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Role } from '../src/shared/models.ts';
import { buildClaudeArgv, claudeExecArgv } from '../src/server/agents/claude-code-backend.ts';
import type { AgentLimits } from '../src/server/agents/index.ts';
import {
  AGENT_HOME,
  CLAUDE_CONFIG_VOLUME,
  DEFAULT_BASE_IMAGE_DIR,
  baseImageTag,
  claudeImageTag,
} from '../src/server/sandbox/index.ts';
import { redactor, type Redactor } from '../src/server/security/index.ts';
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

export const USAGE = `Usage: npm run -s claude:record -- [--out <file>] [--model <model>]

Runs the pinned Claude Code CLI once in the current vibecode/claude-code image, as your
uid:gid with the ${CLAUDE_CONFIG_VOLUME} login volume mounted, using the same argv as the
Claude Code backend (stream-json + --json-schema) for a tiny task that replies {"ok":true}.
Prints the CLI version and writes the redacted NDJSON stream to a fixture file.

Options:
  --out <file>     Where to write the stream (default: src/server/agents/fixtures/real-success.ndjson)
  --model <model>  Claude model alias or id passed to --model (default: ${DEFAULT_MODEL})
  -h, --help       Show this help

Needs Docker, the built image (npm run -s docker:images | sh) and a login (README, Claude Code).
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
  uid: number;
  gid: number;
  redactor: Redactor;
  exec: typeof defaultExec;
  writeFile: (file: string, text: string) => Promise<void>;
  log: (line: string) => void;
};

/** `docker run` options shared by both calls: never pull, run as the host identity. */
function baseRunArgs(uid: number, gid: number): string[] {
  return ['run', '--rm', '--init', '--pull', 'never', '--user', `${uid}:${gid}`];
}

/** Records one run; returns the process exit code. */
export async function recordClaudeStream(o: RecordOptions, deps: RecordDeps): Promise<number> {
  const { uid, gid } = deps;
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
  const run = await deps.exec(
    'docker',
    [
      ...baseRunArgs(uid, gid),
      '--interactive',
      ...['--cap-drop', 'ALL'],
      ...['--security-opt', 'no-new-privileges:true'],
      ...[
        '--tmpfs',
        `${AGENT_HOME}:rw,nosuid,nodev,exec,size=256m,mode=0700,uid=${uid},gid=${gid}`,
      ],
      ...['--mount', `type=volume,src=${CLAUDE_CONFIG_VOLUME},dst=${AGENT_HOME}/.claude`],
      ...['--env', `HOME=${AGENT_HOME}`],
      ...['--workdir', '/tmp'],
      tag,
      ...cli,
    ],
    { input: RECORD_PROMPT, timeoutMs: RECORD_LIMITS.wallClockMs, killSignal: 'SIGINT' },
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
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && SECRET_ENV_NAME.test(name)) redactor.register(value);
    }
    process.exitCode = await recordClaudeStream(parsed, {
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
      log: (line) => console.log(line),
    });
  }
}
