import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ImplResultSchema,
  PlanResultSchema,
  ReviewResultSchema,
  SparResultSchema,
} from '../../shared/agent-results.ts';
import type { ExecOpts, ExecResult, Sandbox } from '../sandbox/index.ts';
import { FakeClock } from '../util/clock.ts';
import {
  buildClaudeArgv,
  claudeExecArgv,
  cliJsonSchema,
  runClaudeCodeBackend,
} from './claude-code-backend.ts';
import { runAgent, type AgentSpec, type StepUsage } from './index.ts';

const START = 1_700_000_000_000;
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const ResultSchema = z.strictObject({ summary: z.string().min(1) });
type Result = z.infer<typeof ResultSchema>;

type ExecCall = { argv: readonly string[]; o: ExecOpts };

/** A Sandbox whose exec plays back NDJSON lines on stdout, as the CLI would stream them. */
function playbackSandbox(
  lines: readonly string[],
  over: Partial<ExecResult> & { stderr?: string } = {},
): { sandbox: Sandbox; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    sandbox: {
      name: 'vibecode-01RUN',
      close: () => Promise.resolve(),
      exec: async (argv, o) => {
        calls.push({ argv, o });
        await Promise.resolve();
        for (const line of lines) o.onLine?.(line, 'stdout');
        const stderr = over.stderr ?? '';
        for (const line of stderr.split('\n').filter((l) => l !== '')) o.onLine?.(line, 'stderr');
        return {
          code: 0,
          stdout: lines.join('\n'),
          stderr,
          timedOut: false,
          aborted: false,
          truncated: false,
          ...over,
        };
      },
    },
  };
}

async function fixture(name: string): Promise<string[]> {
  const text = await readFile(path.join(FIXTURES, name), 'utf8');
  return text.split('\n').filter((l) => l.trim() !== '');
}

type Recorded = { activity: string[]; usage: StepUsage[] };

function spec(
  sandbox: Sandbox | undefined,
  over: Partial<AgentSpec<Result>> = {},
): { spec: AgentSpec<Result>; rec: Recorded } {
  const rec: Recorded = { activity: [], usage: [] };
  return {
    rec,
    spec: {
      ...(sandbox === undefined ? {} : { sandbox }),
      agentId: '01AGENT',
      role: 'implementer',
      model: { provider: 'claude-code', model: 'sonnet' },
      instructions: 'You are a test agent.',
      prompt: 'Do the task.',
      schema: ResultSchema,
      tools: ['read_file', 'write_file', 'run'],
      limits: { maxSteps: 40, wallClockMs: 60_000 },
      shouldStop: () => false,
      modelDeps: { getSecret: () => undefined },
      clock: new FakeClock(START),
      onActivity: (line) => rec.activity.push(line),
      onUsage: (u) => rec.usage.push(u),
      ...over,
    },
  };
}

const SCHEMA_JSON = cliJsonSchema(ResultSchema);

function expectedArgv(tools: string): string[] {
  return [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    tools,
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--max-turns',
    '40',
    '--json-schema',
    SCHEMA_JSON,
    '--model',
    'sonnet',
  ];
}

// Every agent result schema the backend is asked to emit, each with a known-valid sample.
const AGENT_RESULT_SAMPLES: { name: string; schema: z.ZodType; sample: unknown }[] = [
  { name: 'SparResult', schema: SparResultSchema, sample: { reply: 'Hi', prdMarkdown: '# PRD' } },
  {
    name: 'PlanResult',
    schema: PlanResultSchema,
    sample: {
      issueOps: [
        { op: 'create', key: 'a', title: 'T', body: 'B', dependsOn: [], priority: 1 },
        { op: 'edit', id: '01X', title: 'T2' },
        { op: 'cancel', id: '01Y', reason: 'dup' },
        { op: 'rewrite', id: '01Z', body: 'B2' },
      ],
      questions: [],
      summary: 'Planned',
      project: {
        check: ['npm', 'test'],
        imageInputs: ['package-lock.json'],
        preview: { command: ['npm', 'start'], port: 3000 },
      },
    },
  },
  { name: 'ImplResult', schema: ImplResultSchema, sample: { summary: 'Done', question: 'Why?' } },
  { name: 'ReviewResult', schema: ReviewResultSchema, sample: { approve: true, findings: [] } },
];

describe('cliJsonSchema', () => {
  it.each(AGENT_RESULT_SAMPLES)(
    'emits $name as draft-07 the CLI validator (Ajv 8 defaults) compiles',
    ({ schema, sample }) => {
      const parsed = JSON.parse(cliJsonSchema(schema)) as Record<string, unknown>;

      expect(parsed).not.toHaveProperty('$schema');
      const validate = new Ajv().compile(parsed);
      expect(validate(sample)).toBe(true);
      expect(validate({})).toBe(false);
    },
  );

  it('fixes the regression: the default 2020-12 output is rejected by Ajv 8 defaults', () => {
    const old = z.toJSONSchema(ImplResultSchema);

    expect(old.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(() => new Ajv().compile(old)).toThrow(/2020-12/);
  });

  it('is what buildClaudeArgv passes to --json-schema', () => {
    const { spec: s } = spec(undefined);
    const argv = buildClaudeArgv(s).argv;

    expect(argv[argv.indexOf('--json-schema') + 1]).toBe(cliJsonSchema(ResultSchema));
    expect(argv.join(' ')).not.toContain('$schema');
  });
});

describe('buildClaudeArgv', () => {
  it('emits the exact flag set for an implementer', () => {
    const { spec: s } = spec(undefined);

    const inv = buildClaudeArgv(s);

    expect(inv.argv).toEqual(expectedArgv('Read,Edit,Write,Glob,Grep,Bash'));
    expect(inv.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/agent/.claude', DISABLE_AUTOUPDATER: '1' });
  });

  it('lets the orchestrator also search and fetch the web', () => {
    const { spec: s } = spec(undefined, { role: 'orchestrator' });

    expect(buildClaudeArgv(s).argv).toEqual(
      expectedArgv('Read,Edit,Write,Glob,Grep,Bash,WebSearch,WebFetch'),
    );
  });

  it('gives the reviewer read-only tools', () => {
    const { spec: s } = spec(undefined, { role: 'reviewer' });

    expect(buildClaudeArgv(s).argv).toEqual(expectedArgv('Read,Glob,Grep'));
  });

  it('never uses --bare and never sets ANTHROPIC_* credentials', () => {
    for (const role of [
      'implementer',
      'orchestrator',
      'reviewer',
      'sparring',
      'utility',
    ] as const) {
      const inv = buildClaudeArgv(spec(undefined, { role }).spec);

      expect(inv.argv).not.toContain('--bare');
      expect(Object.keys(inv.env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    }
  });

  it('wraps the command so ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are unset in the container', () => {
    const inv = buildClaudeArgv(spec(undefined).spec);

    expect(claudeExecArgv(inv)).toEqual([
      'env',
      '-u',
      'ANTHROPIC_API_KEY',
      '-u',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CONFIG_DIR=/home/agent/.claude',
      'DISABLE_AUTOUPDATER=1',
      ...inv.argv,
    ]);
  });

  it('refuses an invocation with --bare or an ANTHROPIC_* variable', () => {
    const inv = buildClaudeArgv(spec(undefined).spec);

    expect(() => claudeExecArgv({ ...inv, argv: [...inv.argv, '--bare'] })).toThrow(/--bare/);
    expect(() =>
      claudeExecArgv({ ...inv, env: { ...inv.env, ANTHROPIC_API_KEY: 'sk-ant-x' } }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(() =>
      claudeExecArgv({ ...inv, env: { ...inv.env, ANTHROPIC_AUTH_TOKEN: 'x' } }),
    ).toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });
});

describe('runClaudeCodeBackend', () => {
  it('runs the CLI through sandbox.exec with the prompt on stdin', async () => {
    const { sandbox, calls } = playbackSandbox(await fixture('success.ndjson'));
    const { spec: s } = spec(sandbox);

    await runClaudeCodeBackend(s);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(claudeExecArgv(buildClaudeArgv(s)));
    expect(calls[0]?.o.stdin).toContain('You are a test agent.');
    expect(calls[0]?.o.stdin).toContain('Do the task.');
    expect(calls[0]?.o.timeoutMs).toBe(60_000);
    expect(calls[0]?.o.killSignal).toBe('SIGINT');
  });

  it('maps a successful stream to ok with the validated structured output', async () => {
    const { sandbox } = playbackSandbox(await fixture('success.ndjson'));
    const { spec: s } = spec(sandbox);

    expect(await runClaudeCodeBackend(s)).toEqual({
      kind: 'ok',
      result: { summary: 'Changed the constant to 2.' },
    });
  });

  it('streams activity lines for assistant text, tool calls and tool errors', async () => {
    const { sandbox } = playbackSandbox(await fixture('success.ndjson'));
    const { spec: s, rec } = spec(sandbox);

    await runClaudeCodeBackend(s);

    expect(rec.activity).toEqual([
      "text: I'll read the file first.",
      'tool Read {"file_path":"/workspace/src/a.ts"}',
      'tool Edit {"file_path":"/workspace/src/a.ts","old_string":"1","new_string":"2"}',
      'tool Bash {"command":"npm test","description":"Run tests"}',
      'tool error Bash: Exit code 1\n1 test failed',
      'api retry 1/10: overloaded',
      'rate limit allowed_warning (85% used)',
      'text: Done: the constant is now 2.',
    ]);
  });

  it('turns modelUsage into one subscription usage with tokens, calls and the CLI cost', async () => {
    const { sandbox } = playbackSandbox(await fixture('success.ndjson'));
    const { spec: s, rec } = spec(sandbox);

    await runClaudeCodeBackend(s);

    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0]).toMatchObject({
      input: 1700,
      output: 600,
      reasoning: 300,
      cacheRead: 40000,
      cacheWrite: 3000,
      webSearches: 1,
      calls: 4,
      step: 1,
      reportedEstCostUsd: 0.1234,
    });
  });

  it('maps a rejected rate_limit_event to rate_limited until resetsAt in epoch ms', async () => {
    const { sandbox } = playbackSandbox(await fixture('rate-limited.ndjson'), { code: 1 });
    const { spec: s } = spec(sandbox);

    expect(await runClaudeCodeBackend(s)).toEqual({
      kind: 'rate_limited',
      until: 1_700_007_200_000,
      backend: 'claude-code',
    });
  });

  it('accepts resetsAt already given in epoch ms', async () => {
    const lines = (await fixture('rate-limited.ndjson')).map((l) =>
      l.replace('"resetsAt": 1700007200', '"resetsAt": 1700007200000'),
    );
    const { sandbox } = playbackSandbox(lines, { code: 1 });

    const r = await runClaudeCodeBackend(spec(sandbox).spec);

    expect(r).toEqual({ kind: 'rate_limited', until: 1_700_007_200_000, backend: 'claude-code' });
  });

  it('falls back to api_retry rate_limit and the "resets …" text', async () => {
    const { sandbox } = playbackSandbox(await fixture('rate-limited-text.ndjson'), { code: 1 });
    const { spec: s } = spec(sandbox);

    const expected = new Date(START);
    expected.setHours(15, 45, 0, 0);
    if (expected.getTime() <= START) expected.setDate(expected.getDate() + 1);

    expect(await runClaudeCodeBackend(s)).toEqual({
      kind: 'rate_limited',
      until: expected.getTime(),
      backend: 'claude-code',
    });
  });

  it('maps "Login expired" / authentication_failed to auth_required', async () => {
    const { sandbox } = playbackSandbox(await fixture('login-expired.ndjson'), { code: 1 });

    expect(await runClaudeCodeBackend(spec(sandbox).spec)).toEqual({
      kind: 'auth_required',
      backend: 'claude-code',
    });
  });

  it('recognises "Login expired" on stderr when the CLI wrote no result', async () => {
    const { sandbox } = playbackSandbox([], {
      code: 1,
      stderr: 'Login expired · Please run /login\n',
    });

    expect(await runClaudeCodeBackend(spec(sandbox).spec)).toEqual({
      kind: 'auth_required',
      backend: 'claude-code',
    });
  });

  it('maps an error result to a non-transient error and still reports usage', async () => {
    const { sandbox } = playbackSandbox(await fixture('error.ndjson'), { code: 1 });
    const { spec: s, rec } = spec(sandbox);

    expect(await runClaudeCodeBackend(s)).toEqual({
      kind: 'error',
      message: 'Claude Code: error_max_turns: Reached maximum number of turns (40)',
      transient: false,
    });
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0]).toMatchObject({ input: 900, calls: 40, reportedEstCostUsd: 0.5 });
  });

  it('treats a server-side API error as transient', async () => {
    const lines = [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 529,
        result: 'API Error: Overloaded',
        num_turns: 1,
        session_id: 's',
      }),
    ];
    const { sandbox } = playbackSandbox(lines, { code: 1 });

    expect(await runClaudeCodeBackend(spec(sandbox).spec)).toEqual({
      kind: 'error',
      message: 'Claude Code: API Error: Overloaded',
      transient: true,
    });
  });

  it('rejects structured output that does not match the schema', async () => {
    const lines = (await fixture('success.ndjson')).map((l) =>
      l.replace(
        '"structured_output": {"summary": "Changed the constant to 2."}',
        '"structured_output": {"summary": ""}',
      ),
    );
    const { sandbox } = playbackSandbox(lines);

    const r = await runClaudeCodeBackend(spec(sandbox).spec);

    expect(r).toMatchObject({ kind: 'error', transient: false });
    expect(r.kind === 'error' && r.message).toMatch(/structured output/);
  });

  it('reports a transient error when the CLI exits without a result', async () => {
    const { sandbox } = playbackSandbox([], { code: 2, stderr: 'boom\n' });

    expect(await runClaudeCodeBackend(spec(sandbox).spec)).toEqual({
      kind: 'error',
      message: 'Claude Code exited with code 2 without a result: boom',
      transient: true,
    });
  });

  it('reports the wall clock limit as a non-transient error', async () => {
    const { sandbox } = playbackSandbox([], { code: null, timedOut: true });

    expect(await runClaudeCodeBackend(spec(sandbox).spec)).toEqual({
      kind: 'error',
      message: 'Agent exceeded its wall clock limit of 60000 ms',
      transient: false,
    });
  });

  it('needs a sandbox', async () => {
    expect(await runClaudeCodeBackend(spec(undefined).spec)).toEqual({
      kind: 'error',
      message: 'The Claude Code backend needs a sandbox, but none was given',
      transient: false,
    });
  });
});

describe('stopping a Claude Code run', () => {
  it('sends SIGINT when shouldStop turns true and yields stopped', async () => {
    let signalled: string | undefined;
    const sandbox: Sandbox = {
      name: 'vibecode-01RUN',
      close: () => Promise.resolve(),
      exec: (_argv, o) =>
        new Promise((resolve) => {
          o.signal?.addEventListener('abort', () => {
            signalled = o.killSignal ?? 'SIGTERM';
            resolve({
              code: null,
              stdout: '',
              stderr: '',
              timedOut: false,
              aborted: true,
              truncated: false,
            });
          });
          o.onLine?.(
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
            'stdout',
          );
        }),
    };
    let stop = false;
    const { spec: s } = spec(sandbox, {
      shouldStop: () => stop,
      onActivity: () => undefined,
    });
    const started = runClaudeCodeBackend(s);
    stop = true;

    expect(await started).toEqual({ kind: 'stopped' });
    expect(signalled).toBe('SIGINT');
  });

  it('does not start the CLI when already stopped', async () => {
    const { sandbox, calls } = playbackSandbox([]);

    expect(await runClaudeCodeBackend(spec(sandbox, { shouldStop: () => true }).spec)).toEqual({
      kind: 'stopped',
    });
    expect(calls).toEqual([]);
  });
});

describe('runAgent', () => {
  it('dispatches provider claude-code to the Claude Code backend', async () => {
    const { sandbox, calls } = playbackSandbox(await fixture('success.ndjson'));

    expect(await runAgent(spec(sandbox).spec)).toEqual({
      kind: 'ok',
      result: { summary: 'Changed the constant to 2.' },
    });
    expect(calls[0]?.argv).toContain('claude');
  });
});

describe('subscription credentials', () => {
  it('no server code reads the vibecode-claude-config volume or the CLI credentials', async () => {
    const root = path.join(import.meta.dirname, '..');
    const offenders: string[] = [];
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const text = await readFile(file, 'utf8');
      // Only the sandbox may name the volume, and only to mount it for the CLI.
      const inSandbox = /[/\\]sandbox[/\\]/.test(file);
      if (!inSandbox && /vibecode-claude-config|CLAUDE_CONFIG_VOLUME/.test(text)) {
        offenders.push(file);
      }
      if (/\.credentials\.json['"`]/.test(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
