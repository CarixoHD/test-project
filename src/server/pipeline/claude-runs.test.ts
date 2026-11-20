import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import { open } from '../db/index.ts';
import { createGit } from '../git/index.ts';
import { FakeContainerRuntime, type FakeRunRule } from '../sandbox/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { P, runHandle, setupAttempt, START, type SpecCall } from './attempt-testing.ts';
import { createOrchestrator, sparTurn, type OrchestratorDeps, type SparringDeps } from './index.ts';

// Pipeline callers that resolve a role to the claude-code backend start their sandbox from the
// derived Claude Code image with the CLI config volume, and run the CLI in it (ADR 4).

const CLAUDE = { provider: 'claude-code', model: 'sonnet' } as const;
const CONFIG_MOUNT = 'type=volume,src=vibecode-claude-config,dst=/home/agent/.claude';

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-claude-runs-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const isClaude = (argv: readonly string[]) => argv[0] === 'env' && argv.includes('claude');

/** One CLI `result` line with `structured_output`, as `claude -p --output-format stream-json` ends. */
function resultLine(structured: object): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'done',
    session_id: 's1',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    structured_output: structured,
  })}\n`;
}

/** Container argv and run args of every claude-code run, in order. */
function claudeRuns(runtime: FakeContainerRuntime) {
  return runtime.calls.flatMap((c) =>
    c.kind === 'exec' && isClaude(c.argv)
      ? [{ name: c.name, argv: c.argv, runArgs: runtime.runArgs(c.name) ?? [] }]
      : [],
  );
}

function expectClaudeContainer(runArgs: readonly string[], image: string): void {
  expect(runArgs.at(-1)).toBe(image);
  expect(runArgs).toContain(CONFIG_MOUNT);
  expect(runArgs[runArgs.indexOf('--network') + 1]).toBe('vibecode-egress');
  expect(runArgs.filter((a) => /ANTHROPIC_/.test(a))).toEqual([]);
}

function expectNoAnthropicEnv(argv: readonly string[]): void {
  // Only unset (`env -u`), never set.
  expect(argv.filter((a) => /^ANTHROPIC_\w*=/.test(a))).toEqual([]);
  expect(argv).toEqual(expect.arrayContaining(['-u', 'ANTHROPIC_API_KEY']));
}

describe('runAttempt with claude-code roles', () => {
  it('runs implementer and reviewer in the derived image with the config volume, then merges', async () => {
    const lastOpen = (specs: readonly SpecCall[]) =>
      specs.filter((s) => s.kind === 'open').at(-1)?.spec;
    const h = await setupAttempt(dataDir, {
      models: { implementer: CLAUDE, reviewer: CLAUDE },
      runtimeScript: (specs) => [
        {
          match: isClaude,
          result: (argv) => {
            if (argv.includes('Read,Glob,Grep')) {
              return { code: 0, stdout: resultLine({ approve: true, findings: [] }) };
            }
            // The CLI edits the worktree itself; stand in for its Write tool.
            const spec = lastOpen(specs);
            if (spec !== undefined) writeFileSync(path.join(spec.worktree, 'hello.txt'), 'hi\n');
            return { code: 0, stdout: resultLine({ summary: 'Added hello.txt' }) };
          },
        },
      ],
    });
    const issueId = h.addIssue('Hello');

    await h.run(issueId);

    expect(h.store.q.issue(issueId)?.status).toBe('completed');
    const builds = h.runtime.calls.filter((c) => c.kind === 'ensureImage');
    expect(builds.filter((b) => b.kind === 'ensureImage' && b.claude === true)).toHaveLength(2);
    const runs = claudeRuns(h.runtime);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expectClaudeContainer(run.runArgs, 'vibecode/claude-code');
      expectNoAnthropicEnv(run.argv);
    }
    // The reviewer stays read-only.
    const reviewer = runs[1];
    expect(reviewer?.runArgs.some((a) => a.includes('dst=/workspace,readonly'))).toBe(true);
    // The check still runs in the plain product image without the config volume.
    const check = h.specs.find((s) => s.kind === 'runOnce');
    expect(check?.spec.image).toBe('vibecode/base');
    expect(check?.spec.claude).toBeUndefined();
  });
});

describe('runOrchestrator with claude-code', () => {
  it('runs the orchestrator in the derived image with the config volume', async () => {
    const clock = new FakeClock(START);
    const ids = new FakeIdGen();
    const store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
    const git = createGit({ dataDir });
    await git.initRepo(P);
    const draft = (type: string, data: object) =>
      ({ type, productId: P, entityId: null, v: 1, data }) as EventDraft;
    store.commit(() => [
      draft('product.created', {
        name: 'Todo',
        idea: 'todos',
        budgetUsd: null,
        maxParallel: 3,
        maxAttempts: 3,
        models: { orchestrator: CLAUDE },
        gitRemote: null,
      }),
      draft('prd.applied', { version: 1, markdown: '# Todo', summary: null }),
      draft('product.handed_off', { prdVersion: 1 }),
    ]);
    const plan = {
      issueOps: [{ op: 'create', key: 'a', title: 'Scaffold', body: 'Set up.', dependsOn: [] }],
      questions: [],
      summary: 'One slice.',
    };
    const rule: FakeRunRule = { match: isClaude, result: { code: 0, stdout: resultLine(plan) } };
    const runtime = new FakeContainerRuntime({ dataDir, script: [rule] });
    const deps: OrchestratorDeps = {
      store,
      ids,
      clock,
      redactor: new Redactor(),
      logsDir: path.join(dataDir, 'logs'),
      setTimer: () => () => {},
      git,
      runtime,
      modelDeps: { getSecret: () => undefined },
      withMergeLock: (_p, fn) => fn(),
    };
    const triggers = store.eventsSince(0).filter((e) => e.type === 'product.handed_off');

    await createOrchestrator(deps).runOrchestrator(P, triggers, runHandle(ids));

    expect(store.q.issuesByProduct(P).map((i) => i.title)).toEqual(['Scaffold']);
    const runs = claudeRuns(runtime);
    expect(runs).toHaveLength(1);
    expectClaudeContainer(runs[0]?.runArgs ?? [], 'vibecode/claude-code');
    expectNoAnthropicEnv(runs[0]?.argv ?? []);
    expect(runs[0]?.argv.join(' ')).toContain('WebSearch');
  });
});

describe('sparTurn with claude-code', () => {
  function sparSetup(runtime: FakeContainerRuntime | undefined) {
    const clock = new FakeClock(START);
    const store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
    store.commit(() => [
      {
        type: 'product.created',
        productId: P,
        entityId: null,
        v: 1,
        data: {
          name: 'Todo',
          idea: 'A todo app',
          budgetUsd: null,
          maxParallel: 3,
          maxAttempts: 3,
          models: { sparring: CLAUDE },
          gitRemote: null,
        },
      },
      {
        type: 'spar.message',
        productId: P,
        entityId: 'owner-msg-1',
        v: 1,
        data: { role: 'owner', text: 'I want a todo app' },
      },
    ]);
    const deps: SparringDeps = {
      store,
      ids: new FakeIdGen(),
      clock,
      redactor: new Redactor(),
      logsDir: path.join(dataDir, 'logs'),
      setTimer: () => () => undefined,
      modelDeps: { getSecret: () => undefined },
      ...(runtime === undefined ? {} : { runtime, dataDir }),
    };
    return { store, deps };
  }

  it('runs in a container on an empty scratch worktree (no repo) and removes it afterwards', async () => {
    const seen: string[][] = [];
    const runtime = new FakeContainerRuntime({
      dataDir,
      script: [
        {
          match: isClaude,
          result: () => {
            const opened = runtime.calls.findLast((c) => c.kind === 'open');
            seen.push(opened?.kind === 'open' ? (runtime.runArgs(opened.name) ?? []) : []);
            return { code: 0, stdout: resultLine({ reply: 'Who is it for?' }) };
          },
        },
      ],
    });
    const { store, deps } = sparSetup(runtime);

    await sparTurn(deps, P, 'I want a todo app');

    const messages = store.q.sparMessages(P);
    expect(messages.at(-1)).toMatchObject({ role: 'agent', text: 'Who is it for?' });
    const runs = claudeRuns(runtime);
    expect(runs).toHaveLength(1);
    expectNoAnthropicEnv(runs[0]?.argv ?? []);
    const runArgs = seen[0] ?? [];
    expectClaudeContainer(runArgs, 'vibecode/claude-code');
    const workspace = runArgs.find((a) => a.endsWith('dst=/workspace,readonly')) ?? '';
    const scratch = /src=([^,]+)/.exec(workspace)?.[1] ?? '';
    expect(path.dirname(scratch)).toBe(path.join(dataDir, 'worktrees'));
    // Empty scratch dir, removed with its container.
    expect(await readdir(path.join(dataDir, 'worktrees'))).toEqual([]);
    expect(runtime.calls.at(-1)?.kind).toBe('close');
  });

  it('reports an actionable failure when no container runtime is available', async () => {
    const { store, deps } = sparSetup(undefined);
    await sparTurn(deps, P, 'I want a todo app');
    expect(store.q.sparMessages(P).at(-1)?.text).toMatch(/container/i);
  });
});
