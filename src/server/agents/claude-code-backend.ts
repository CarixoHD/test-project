// ClaudeCodeBackend (ADR 4, docs/ARCHITECTURE.md §4.6): drives the official, unmodified `claude`
// CLI headless inside the agent sandbox under the owner's own subscription login. Vibecode never
// reads, copies or stores the login (the CLI config volume), never sets
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN for these runs and never passes `--bare` (bare mode
// ignores the subscription login). Flag names verified against the docs for the pinned CLI
// (docs/research/how-can-the-platform-drive-the-official-claude-cod.md).
import { z } from 'zod';
import type { Role } from '../../shared/models.ts';
import { AGENT_HOME } from '../sandbox/index.ts';
import { redactor } from '../security/index.ts';
import { newStreamState, parseStreamLine, resultUsage, streamOutcome } from './claude-stream.ts';
import { truncateMiddle } from './tools.ts';
import type { AgentResult, AgentSpec } from './types.ts';

export const CLAUDE_CONFIG_DIR = `${AGENT_HOME}/.claude`;
/** How often `shouldStop()` is polled while the CLI runs (it is also checked on every line). */
export const CLAUDE_STOP_POLL_MS = 250;
const ACTIVITY_LINE_LIMIT = 500;
const FORBIDDEN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const WRITE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;

/** Claude Code built-in tools per role; the CLI's own WebSearch/WebFetch only for the orchestrator. */
const CLAUDE_ROLE_TOOLS: Record<Role, readonly string[]> = {
  implementer: WRITE_TOOLS,
  orchestrator: [...WRITE_TOOLS, 'WebSearch', 'WebFetch'],
  reviewer: READ_ONLY_TOOLS,
  sparring: READ_ONLY_TOOLS,
  utility: READ_ONLY_TOOLS,
};

export type ClaudeInvocation = { argv: string[]; env: Record<string, string> };

type ArgvSpec = Pick<AgentSpec<unknown>, 'role' | 'model' | 'limits'> & { schema: z.ZodType };

/**
 * The `--json-schema` value: draft-07 with no top-level `$schema`. The CLI validates the flag with
 * Ajv's default (draft-07) meta-schema and rejects zod's default draft 2020-12 `$schema` URI.
 */
export function cliJsonSchema(schema: z.ZodType): string {
  const { $schema: _metaSchema, ...json } = z.toJSONSchema(schema, { target: 'draft-07' });
  return JSON.stringify(json);
}

/** The CLI command and environment for one run. Pure; see ADR 4 for the exact flag set. */
export function buildClaudeArgv(spec: ArgvSpec): ClaudeInvocation {
  const inv: ClaudeInvocation = {
    argv: [
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      CLAUDE_ROLE_TOOLS[spec.role].join(','),
      '--permission-prompts',
      'none',
      '--strict-mcp-config',
      '--max-turns',
      String(spec.limits.maxSteps),
      '--json-schema',
      cliJsonSchema(spec.schema),
      '--model',
      spec.model.model,
    ],
    env: { CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER: '1' },
  };
  assertSubscriptionSafe(inv);
  return inv;
}

/**
 * The argv executed in the sandbox: `env` explicitly unsets the API credential variables (they
 * would take precedence over the subscription login), sets the CLI env, then runs the CLI.
 */
export function claudeExecArgv(inv: ClaudeInvocation): string[] {
  assertSubscriptionSafe(inv);
  return [
    'env',
    ...FORBIDDEN_ENV.flatMap((k) => ['-u', k]),
    ...Object.entries(inv.env).map(([k, v]) => `${k}=${v}`),
    ...inv.argv,
  ];
}

/** Programmer-error guard: the subscription backend must never use API credentials or bare mode. */
function assertSubscriptionSafe(inv: ClaudeInvocation): void {
  if (inv.argv.includes('--bare')) {
    throw new Error('Claude Code must not run with --bare: it ignores the subscription login');
  }
  for (const key of Object.keys(inv.env)) {
    if (key.startsWith('ANTHROPIC_')) {
      throw new Error(`Claude Code must not run with ${key}: it overrides the subscription login`);
    }
  }
}

/** Runs one agent through the Claude Code CLI. Never throws for CLI or limit failures. */
export async function runClaudeCodeBackend<T>(spec: AgentSpec<T>): Promise<AgentResult<T>> {
  const sandbox = spec.sandbox;
  if (sandbox === undefined) {
    return {
      kind: 'error',
      message: 'The Claude Code backend needs a sandbox, but none was given',
      transient: false,
    };
  }
  if (spec.shouldStop()) return { kind: 'stopped' };

  const argv = claudeExecArgv(buildClaudeArgv(spec));
  const state = newStreamState();
  const controller = new AbortController();
  const checkStop = (): void => {
    if (!controller.signal.aborted && spec.shouldStop()) controller.abort();
  };
  const activity = (line: string): void => {
    spec.onActivity?.(truncateMiddle(redactor.redact(line), ACTIVITY_LINE_LIMIT));
  };
  const poll = setInterval(checkStop, CLAUDE_STOP_POLL_MS);
  let res;
  try {
    res = await sandbox.exec(argv, {
      stdin: `${spec.instructions}\n\n${spec.prompt}`,
      timeoutMs: spec.limits.wallClockMs,
      signal: controller.signal,
      killSignal: 'SIGINT',
      onLine: (line, stream) => {
        if (stream === 'stdout') for (const a of parseStreamLine(state, line)) activity(a);
        checkStop();
      },
    });
  } finally {
    clearInterval(poll);
  }

  if (state.result !== undefined) {
    const usage = resultUsage(state.result);
    if (usage !== undefined) spec.onUsage?.(usage);
  }
  if (controller.signal.aborted || res.aborted) return { kind: 'stopped' };
  if (res.timedOut) {
    return {
      kind: 'error',
      message: `Agent exceeded its wall clock limit of ${spec.limits.wallClockMs} ms`,
      transient: false,
    };
  }
  return streamOutcome(state, {
    schema: spec.schema,
    now: spec.clock.now(),
    exitCode: res.code,
    stderr: redactor.redact(res.stderr),
  });
}
