import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildClaudeArgv, claudeExecArgv } from '../src/server/agents/index.ts';
import { open } from '../src/server/db/index.ts';
import {
  AGENT_HOME,
  CLAUDE_CONFIG_VOLUME,
  CONTAINER_LIMITS,
  TMP_TMPFS,
} from '../src/server/sandbox/index.ts';
import { Redactor, createSecrets } from '../src/server/security/index.ts';
import type { ExecResult } from '../src/server/util/exec.ts';
import {
  DEFAULT_OUT,
  RECORD_LIMITS,
  RECORD_ROLE,
  RecordResultSchema,
  USAGE,
  loadStoredSecrets,
  registerEnvSecrets,
  parseRecordArgs,
  recordClaudeStream,
  type RecordDeps,
} from './record-claude-stream.ts';

const TAG = `vibecode/claude-code:${'c'.repeat(64)}`;
const SECRET = 'sk-ant-supersecretvalue-0123456789';
const STREAM =
  `{"type":"system","subtype":"init","claude_code_version":"2.1.329","note":"${SECRET}"}\n` +
  `{"type":"result","subtype":"success","structured_output":{"ok":true}}\n`;

type Call = {
  cmd: string;
  argv: readonly string[];
  input: unknown;
  env: Record<string, string | undefined> | undefined;
};

function ok(stdout: string, code = 0): ExecResult {
  return {
    code,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout,
    stderr: '',
    truncated: false,
  };
}

function setup(overrides: Partial<RecordDeps> = {}) {
  const calls: Call[] = [];
  const writes: { path: string; text: string }[] = [];
  const logs: string[] = [];
  const redactor = new Redactor();
  redactor.register(SECRET);
  const deps: RecordDeps = {
    claudeTag: async () => TAG,
    loadStoredSecrets: async () => [],
    uid: 1501,
    gid: 20,
    redactor,
    exec: async (cmd, argv, o) => {
      calls.push({ cmd, argv, input: o.input, env: o.env });
      return argv.includes('--version') ? ok('2.1.329 (Claude Code)\n') : ok(STREAM);
    },
    writeFile: async (path, text) => {
      writes.push({ path, text });
    },
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, calls, writes, logs };
}

const options = { out: '/tmp/out.ndjson', model: 'sonnet' };

describe('claude:record npm script', () => {
  it('runs the Node preflight before the .ts script', () => {
    const pkg = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(
        JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')),
      );
    expect(pkg.scripts['claude:record']).toBe(
      'node scripts/preflight.mjs && node scripts/record-claude-stream.ts',
    );
  });
});

describe('parseRecordArgs', () => {
  it('recognises --help and -h', () => {
    expect(parseRecordArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseRecordArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('defaults the output to the real-success fixture and the model to sonnet', () => {
    expect(parseRecordArgs([])).toEqual({ kind: 'run', out: DEFAULT_OUT, model: 'sonnet' });
    expect(DEFAULT_OUT).toMatch(/src\/server\/agents\/fixtures\/real-success\.ndjson$/);
  });

  it('accepts --out and --model in both forms', () => {
    expect(parseRecordArgs(['--out', 'a.ndjson', '--model=opus'])).toEqual({
      kind: 'run',
      out: 'a.ndjson',
      model: 'opus',
    });
    expect(parseRecordArgs(['--out=b.ndjson'])).toMatchObject({ out: 'b.ndjson' });
  });

  it('rejects unknown flags and missing values', () => {
    expect(parseRecordArgs(['--nope'])).toMatchObject({ kind: 'error' });
    expect(parseRecordArgs(['--out'])).toMatchObject({ kind: 'error' });
  });
});

describe('recordClaudeStream', () => {
  it('runs exactly the claudeExecArgv(buildClaudeArgv()) command in the current claude image', async () => {
    const { deps, calls } = setup();
    expect(await recordClaudeStream(options, deps)).toBe(0);

    const expected = claudeExecArgv(
      buildClaudeArgv({
        role: RECORD_ROLE,
        model: { provider: 'claude-code', model: 'sonnet' },
        limits: RECORD_LIMITS,
        schema: RecordResultSchema,
      }),
    );
    const run = calls.find((c) => !c.argv.includes('--version'));
    expect(run?.cmd).toBe('docker');
    const argv = run?.argv ?? [];
    const tagAt = argv.indexOf(TAG);
    expect(tagAt).toBeGreaterThan(0);
    expect(argv.slice(tagAt + 1)).toEqual(expected);
    expect(expected).toContain('stream-json');
    expect(expected).toContain('--json-schema');
    expect(argv.slice(0, tagAt)).toContain('never'); // --pull never
    expect(String(run?.input)).toContain('{"ok":true}');
  });

  it('mounts the vibecode-claude-config volume at ~/.claude and runs as the given uid:gid', async () => {
    const { deps, calls } = setup();
    await recordClaudeStream(options, deps);
    for (const c of calls) {
      expect(c.argv.join(' ')).toContain('--user 1501:20');
    }
    const run = calls.find((c) => !c.argv.includes('--version'))?.argv ?? [];
    const mountAt = run.indexOf('--mount');
    expect(run[mountAt + 1]).toBe(
      `type=volume,src=${CLAUDE_CONFIG_VOLUME},dst=${AGENT_HOME}/.claude`,
    );
    expect(CLAUDE_CONFIG_VOLUME).toBe('vibecode-claude-config');
  });

  it('prints the CLI version without mounting the login volume', async () => {
    const { deps, calls, logs } = setup();
    await recordClaudeStream(options, deps);
    const version = calls.find((c) => c.argv.includes('--version'));
    expect(version?.argv.join(' ')).not.toContain(CLAUDE_CONFIG_VOLUME);
    expect(version?.argv.slice(-2)).toEqual(['claude', '--version']);
    expect(logs.join('\n')).toContain('2.1.329 (Claude Code)');
  });

  it('writes the NDJSON through the Redactor to --out', async () => {
    const { deps, writes, logs } = setup();
    await recordClaudeStream(options, deps);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/tmp/out.ndjson');
    expect(writes[0]?.text).not.toContain(SECRET);
    expect(writes[0]?.text).toBe(deps.redactor.redact(STREAM));
    expect(writes[0]?.text).toContain('"structured_output":{"ok":true}');
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('redacts stderr and still writes the stream when the CLI fails, returning 1', async () => {
    const { deps, writes, logs } = setup({
      exec: async (_cmd, argv) =>
        argv.includes('--version')
          ? ok('2.1.329\n')
          : { ...ok('{"type":"result","is_error":true}\n', 1), stderr: `bad ${SECRET}` },
    });
    expect(await recordClaudeStream(options, deps)).toBe(1);
    expect(writes).toHaveLength(1);
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('writes nothing when the CLI produced no output', async () => {
    const { deps, writes } = setup({
      exec: async (_cmd, argv) => (argv.includes('--version') ? ok('2.1.329\n') : ok('', 125)),
    });
    expect(await recordClaudeStream(options, deps)).toBe(1);
    expect(writes).toEqual([]);
  });

  it('accepts the structured result schema used for the task', () => {
    expect(RecordResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(z.toJSONSchema(RecordResultSchema)).toMatchObject({ type: 'object' });
  });

  it('registers stored secrets before the CLI runs, so they are redacted in the fixture', async () => {
    const stored = 'ghp_storedgittoken_abcdefghij0123456789';
    const order: string[] = [];
    const { deps, writes } = setup({
      loadStoredSecrets: async () => {
        order.push('load');
        return [stored];
      },
      exec: async (_cmd, argv) => {
        order.push('exec');
        return argv.includes('--version')
          ? ok('2.1.329\n')
          : ok(`{"type":"result","structured_output":{"ok":true},"leak":"${stored}"}\n`);
      },
    });
    expect(await recordClaudeStream(options, deps)).toBe(0);
    expect(order[0]).toBe('load');
    expect(writes[0]?.text).not.toContain(stored);
    expect(writes[0]?.text).toContain(`"leak":"***${stored.slice(-4)}"`);
  });

  it('hardens both docker runs with sandbox policy flags and limits', async () => {
    const { deps, calls } = setup();
    await recordClaudeStream(options, deps);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const argv = c.argv.slice(0, c.argv.indexOf(TAG));
      const after = (flag: string) => argv[argv.indexOf(flag) + 1];
      expect(argv).toContain('--read-only');
      expect(argv.join(' ')).toContain(`--tmpfs ${TMP_TMPFS}`);
      expect(TMP_TMPFS.startsWith('/tmp:')).toBe(true);
      expect(after('--memory')).toBe(CONTAINER_LIMITS.memory);
      expect(after('--memory-swap')).toBe(CONTAINER_LIMITS.memory);
      expect(after('--cpus')).toBe(CONTAINER_LIMITS.cpus);
      expect(after('--pids-limit')).toBe(CONTAINER_LIMITS.pids);
      expect(after('--cap-drop')).toBe('ALL');
      expect(after('--security-opt')).toBe('no-new-privileges:true');
    }
    const run = calls.find((c) => !c.argv.includes('--version'))?.argv ?? [];
    expect(run.join(' ')).toContain(`--tmpfs ${AGENT_HOME}:rw`);
    expect(run[run.indexOf('--workdir') + 1]).toBe('/tmp');
  });
});

describe('recordClaudeStream with CLAUDE_CODE_OAUTH_TOKEN', () => {
  const TOKEN = 'sk-ant-oat01-subscriptiontoken-abcdefghij0123456789';
  const runOf = (calls: Call[]) => calls.find((c) => !c.argv.includes('--version'));

  it('passes the token by name only and does not mount the login volume', async () => {
    const { deps, calls } = setup({ oauthToken: TOKEN });
    expect(await recordClaudeStream(options, deps)).toBe(0);
    const run = runOf(calls);
    const argv = run?.argv ?? [];
    expect(argv[argv.indexOf('CLAUDE_CODE_OAUTH_TOKEN') - 1]).toBe('--env');
    expect(argv.join(' ')).not.toContain(TOKEN);
    expect(argv).not.toContain('--mount');
    expect(argv.join(' ')).not.toContain(CLAUDE_CONFIG_VOLUME);
    expect(run?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    for (const c of calls) expect(c.argv.join(' ')).not.toContain(TOKEN);
  });

  it('keeps the volume mount and passes no env without a token', async () => {
    const { deps, calls } = setup();
    await recordClaudeStream(options, deps);
    const run = runOf(calls);
    expect(run?.argv).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(run?.argv).toContain('--mount');
    expect(run?.env).toBeUndefined();
  });

  it('treats an empty token as unset', async () => {
    const { deps, calls } = setup({ oauthToken: '' });
    await recordClaudeStream(options, deps);
    expect(runOf(calls)?.argv).toContain('--mount');
    expect(runOf(calls)?.argv).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('logs which auth source was used, never the value', async () => {
    const withToken = setup({ oauthToken: TOKEN });
    await recordClaudeStream(options, withToken.deps);
    expect(withToken.logs.join('\n')).toContain('token from environment');
    expect(withToken.logs.join('\n')).not.toContain(TOKEN);
    const withVolume = setup();
    await recordClaudeStream(options, withVolume.deps);
    expect(withVolume.logs.join('\n')).toContain('login volume');
  });

  it('redacts the env token from the written fixture and the logged stderr', async () => {
    const redactor = new Redactor();
    registerEnvSecrets({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, PATH: '/usr/bin' }, redactor);
    const { deps, writes, logs } = setup({
      redactor,
      oauthToken: TOKEN,
      exec: async (_cmd, argv) =>
        argv.includes('--version')
          ? ok('2.1.329\n')
          : {
              ...ok(`{"type":"result","structured_output":{"ok":true},"leak":"${TOKEN}"}\n`, 1),
              stderr: `auth failed for ${TOKEN}`,
            },
    });
    expect(await recordClaudeStream(options, deps)).toBe(1);
    expect(writes[0]?.text).not.toContain(TOKEN);
    expect(writes[0]?.text).toContain(`"leak":"***${TOKEN.slice(-4)}"`);
    const logged = logs.join('\n');
    expect(logged).toContain('auth failed for ***');
    expect(logged).not.toContain(TOKEN);
  });

  it('registerEnvSecrets registers only secret-looking names', () => {
    const redactor = new Redactor();
    registerEnvSecrets(
      { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HOME_DIR_PATH: '/home/someone-long' },
      redactor,
    );
    expect(redactor.redact(TOKEN)).not.toContain(TOKEN);
    expect(redactor.redact('/home/someone-long')).toBe('/home/someone-long');
  });

  it('USAGE describes both auth sources', () => {
    expect(USAGE).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(USAGE).toContain(CLAUDE_CONFIG_VOLUME);
  });
});

describe('loadStoredSecrets', () => {
  let dir = '';
  const fresh = () => (dir = mkdtempSync(path.join(tmpdir(), 'record-secrets-')));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it('reads every value of the secrets table from an existing DB', async () => {
    fresh();
    try {
      const dbPath = path.join(dir, 'vibecode.db');
      const db = open(dbPath);
      const secrets = createSecrets({ db, clock: { now: () => 1 }, redactor: new Redactor() });
      secrets.set('anthropic-api-key', 'sk-ant-stored-0123456789abcdef');
      secrets.set('git-token:p1', 'ghp_storedtoken0123456789');
      db.$client.close();
      const logs: string[] = [];
      const values = await loadStoredSecrets(dbPath, (l) => logs.push(l));
      expect(values.sort()).toEqual(
        ['ghp_storedtoken0123456789', 'sk-ant-stored-0123456789abcdef'].sort(),
      );
      expect(logs.join('\n')).not.toContain('sk-ant-stored');
    } finally {
      cleanup();
    }
  });

  it('does not create a missing DB, logs a note and returns nothing', async () => {
    fresh();
    try {
      const dbPath = path.join(dir, 'vibecode.db');
      const logs: string[] = [];
      expect(await loadStoredSecrets(dbPath, (l) => logs.push(l))).toEqual([]);
      expect(existsSync(dbPath)).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(dbPath);
    } finally {
      cleanup();
    }
  });

  it('still records when no stored secrets were found', async () => {
    fresh();
    try {
      const dbPath = path.join(dir, 'vibecode.db');
      const { deps, writes, logs } = setup();
      deps.loadStoredSecrets = () => loadStoredSecrets(dbPath, deps.log);
      expect(await recordClaudeStream(options, deps)).toBe(0);
      expect(writes).toHaveLength(1);
      expect(existsSync(dbPath)).toBe(false);
      expect(logs[0]).toContain('no stored secrets');
    } finally {
      cleanup();
    }
  });
});
