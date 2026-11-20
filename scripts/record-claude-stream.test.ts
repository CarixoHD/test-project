import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildClaudeArgv, claudeExecArgv } from '../src/server/agents/claude-code-backend.ts';
import { AGENT_HOME, CLAUDE_CONFIG_VOLUME } from '../src/server/sandbox/index.ts';
import { Redactor } from '../src/server/security/index.ts';
import type { ExecResult } from '../src/server/util/exec.ts';
import {
  DEFAULT_OUT,
  RECORD_LIMITS,
  RECORD_ROLE,
  RecordResultSchema,
  parseRecordArgs,
  recordClaudeStream,
  type RecordDeps,
} from './record-claude-stream.ts';

const TAG = `vibecode/claude-code:${'c'.repeat(64)}`;
const SECRET = 'sk-ant-supersecretvalue-0123456789';
const STREAM =
  `{"type":"system","subtype":"init","claude_code_version":"2.1.329","note":"${SECRET}"}\n` +
  `{"type":"result","subtype":"success","structured_output":{"ok":true}}\n`;

type Call = { cmd: string; argv: readonly string[]; input: unknown };

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
    uid: 1501,
    gid: 20,
    redactor,
    exec: async (cmd, argv, o) => {
      calls.push({ cmd, argv, input: o.input });
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
});
