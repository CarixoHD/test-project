import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import type { EventDraft, EventOf } from '../../shared/events.ts';
import { ProductIdSchema, type IssueId } from '../../shared/ids.ts';
import type { Role } from '../../shared/models.ts';
import { addIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { FakeContainerRuntime, type FakeRunRule, type SandboxSpec } from '../sandbox/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { exec } from '../util/exec.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { runAttempt, type AttemptDeps } from './attempt.ts';

// Test-only harness for runAttempt: real git in `dataDir`, FakeContainerRuntime, fake model
// whose script is chosen per spawned agent, and a record of every prompt the model received.

export const P = ProductIdSchema.parse('product-1');
export const START = 1_700_000_000_000;
export const PROJECT = { check: ['npm', 'test'], imageInputs: [] };

/** The agent the fake model is about to serve. */
export type SpawnedAgent = { role: Role; issueId: IssueId | null; issueNumber: number };

/** One model call: the agent's role and issue, and the prompt (system + messages) as JSON. */
export type ModelCall = SpawnedAgent & { prompt: string };

export type SpecCall = { kind: 'open' | 'runOnce'; spec: SandboxSpec; argv?: readonly string[] };

export type CheckResult = { code: number; stdout: string };

export type HarnessOptions = {
  project?: object | null;
  withMergeLock?: AttemptDeps['withMergeLock'];
  maxAttempts?: number;
  /** Script for the agent just spawned; undefined falls back to `defaultScript`. */
  script?: (agent: SpawnedAgent) => FakeScript | undefined;
  /** Result of the n-th (0-based) check run; default: passes. */
  check?: (n: number) => CheckResult;
};

export type Harness = {
  dataDir: string;
  store: Store;
  git: Git;
  clock: FakeClock;
  ids: FakeIdGen;
  runtime: FakeContainerRuntime;
  specs: SpecCall[];
  modelCalls: ModelCall[];
  deps: AttemptDeps;
  addIssue(title: string): IssueId;
  run(issueId: IssueId): Promise<void>;
  mainLog(): Promise<string[]>;
  rawGit(args: string[]): Promise<string>;
  expectNoLeftovers(): Promise<void>;
};

export const PASSING_CHECK: CheckResult = { code: 0, stdout: 'all 3 tests passed\n' };

const draft = (type: string, entityId: string | null, data: object) =>
  ({ type, productId: P, entityId, v: 1, data }) as EventDraft;

/** Implementer writes `issue-<n>.txt`; reviewer approves. */
export function defaultScript(agent: SpawnedAgent): FakeScript {
  if (agent.role === 'reviewer') {
    return [{ toolCalls: [{ name: 'finish', input: { approve: true, findings: [] } }] }];
  }
  const n = agent.issueNumber;
  return [
    {
      toolCalls: [
        { name: 'write_file', input: { path: `issue-${n}.txt`, content: `work for #${n}\n` } },
      ],
    },
    { toolCalls: [{ name: 'finish', input: { summary: `Implemented #${n}` } }] },
  ];
}

function spawnedAgent(store: Store): SpawnedAgent {
  const spawned = store
    .eventsSince(0)
    .filter((e): e is EventOf<'agent.spawned'> => e.type === 'agent.spawned')
    .at(-1);
  if (spawned === undefined) throw new Error('no agent spawned');
  const { issueId, role } = spawned.data;
  const issueNumber = issueId === null ? 0 : (store.q.issue(issueId)?.number ?? 0);
  return { role, issueId, issueNumber };
}

export function runHandle(ids: FakeIdGen): RunHandle {
  return { runId: ids.next('run'), signal: new AbortController().signal, shouldStop: () => false };
}

export async function setupAttempt(dataDir: string, o: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock(START);
  const ids = new FakeIdGen();
  const store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
  const git = createGit({ dataDir });
  await git.initRepo(P);
  const project = o.project === undefined ? PROJECT : o.project;
  store.commit(() => [
    draft('product.created', null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: o.maxAttempts ?? 3,
      models: {},
      gitRemote: null,
    }),
    ...(project === null ? [] : [draft('product.settings_changed', null, { project })]),
  ]);
  let checks = 0;
  const checkRule: FakeRunRule = {
    match: ['npm', 'test'],
    result: () => {
      const n = checks;
      checks += 1;
      return o.check?.(n) ?? PASSING_CHECK;
    },
  };
  const runtime = new FakeContainerRuntime({ dataDir, script: [checkRule] });
  const specs: SpecCall[] = [];
  const realOpen = runtime.open.bind(runtime);
  const realRunOnce = runtime.runOnce.bind(runtime);
  runtime.open = (spec) => {
    specs.push({ kind: 'open', spec });
    return realOpen(spec);
  };
  runtime.runOnce = (spec, argv, opts) => {
    specs.push({ kind: 'runOnce', spec, argv });
    return realRunOnce(spec, argv, opts);
  };
  const modelCalls: ModelCall[] = [];
  const deps: AttemptDeps = {
    store,
    ids,
    clock,
    redactor: new Redactor(),
    logsDir: path.join(dataDir, 'logs'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    setTimer: () => () => {},
    git,
    runtime,
    modelDeps: {
      getSecret: () => undefined,
      // Read once per agent, when its model is created (right after agent.spawned).
      get fake() {
        const agent = spawnedAgent(store);
        return {
          script: o.script?.(agent) ?? defaultScript(agent),
          onCall: (prompt: unknown) =>
            modelCalls.push({ ...agent, prompt: JSON.stringify(prompt) }),
        };
      },
    },
    withMergeLock: o.withMergeLock ?? ((_p, fn) => fn()),
    demo: true,
  };
  const rawGit = async (args: string[]): Promise<string> => {
    const repo = path.join(dataDir, 'repos', `${P}.git`);
    const r = await exec('git', ['--git-dir', repo, ...args], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  return {
    dataDir,
    store,
    git,
    clock,
    ids,
    runtime,
    specs,
    modelCalls,
    deps,
    addIssue(title) {
      const r = addIssue({ store, ids }, P, { title, body: `Build ${title}.`, dependsOn: [] });
      if (!r.ok) throw new Error(r.reason);
      return r.issueId;
    },
    run: (issueId) => runAttempt(deps, issueId, runHandle(ids)),
    mainLog: async () => (await rawGit(['log', '--format=%s', 'main'])).split('\n'),
    rawGit,
    async expectNoLeftovers() {
      const worktrees = path.join(dataDir, 'worktrees');
      expect(existsSync(worktrees) ? await readdir(worktrees) : []).toEqual([]);
      expect(await rawGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(
        'refs/heads/main',
      );
    },
  };
}
