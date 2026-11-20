import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanResult } from '../../shared/agent-results.ts';
import type { Event, EventDraft } from '../../shared/events.ts';
import { ProductIdSchema, type ProductId } from '../../shared/ids.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import type { FakeScript, FakeTurn } from '../llm/index.ts';
import { FakeContainerRuntime } from '../sandbox/index.ts';
import type { RunHandle } from '../scheduler/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import {
  createOrchestrator,
  ORCHESTRATOR_BACKOFF_MS,
  orchestratorPrompt,
  type Orchestrator,
  type OrchestratorDeps,
} from './index.ts';

const P = ProductIdSchema.parse('product-1');
const START = 1_700_000_000_000;
const PROJECT = { check: ['npm', 'test'], imageInputs: ['package-lock.json'] };
const DOCKERFILE = 'FROM node:22-bookworm-slim\nWORKDIR /\nCOPY package-lock.json /\n';

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-orch-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const draft = (type: string, entityId: string | null, data: object) =>
  ({ type, productId: P, entityId, v: 1, data }) as EventDraft;

const write = (file: string, content: string) => ({
  name: 'write_file',
  input: { path: file, content },
});
const finish = (plan: PlanResult): FakeTurn => ({ toolCalls: [{ name: 'finish', input: plan }] });

const THREE_ISSUES: PlanResult = {
  issueOps: [
    { op: 'create', key: 'scaffold', title: 'Scaffold', body: 'Set up the app.', dependsOn: [] },
    {
      op: 'create',
      key: 'list',
      title: 'List todos',
      body: 'Show todos.',
      dependsOn: ['scaffold'],
    },
    {
      op: 'create',
      key: 'add',
      title: 'Add a todo',
      body: 'Form to add.',
      dependsOn: ['scaffold', 'list'],
    },
  ],
  questions: [],
  summary: 'Three slices: scaffold, list, add.',
};

/** Agent writes the repo setup files, then returns `plan`. */
const setupScript = (plan: PlanResult = THREE_ISSUES): FakeScript => [
  {
    toolCalls: [
      write('Dockerfile', DOCKERFILE),
      write('.vibecode/project.json', JSON.stringify(PROJECT)),
      write('docs/adr/0001-stack.md', '# 1. Stack\n\nNode 22.\n'),
    ],
  },
  finish(plan),
];

type Harness = {
  store: Store;
  git: Git;
  clock: FakeClock;
  runtime: FakeContainerRuntime;
  orchestrator: Orchestrator;
  /** Runs the orchestrator once with the product's pending triggers, using `script`. */
  run(script: FakeScript): Promise<void>;
  mainFiles(): Promise<string[]>;
  cursor(): number;
};

async function setup(
  o: { runtime?: FakeContainerRuntime; failImageBuild?: () => boolean } = {},
): Promise<Harness> {
  const clock = new FakeClock(START);
  const ids = new FakeIdGen();
  const store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
  const git = createGit({ dataDir });
  await git.initRepo(P);
  store.commit(() => [
    draft('product.created', null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    }),
    draft('prd.applied', null, { version: 1, markdown: '# Todo', summary: null }),
    draft('product.handed_off', null, { prdVersion: 1 }),
  ]);
  const runtime = o.runtime ?? new FakeContainerRuntime({ dataDir });
  const realEnsure = runtime.ensureImage.bind(runtime);
  runtime.ensureImage = (p) =>
    o.failImageBuild?.() === true
      ? Promise.reject(new Error('docker build failed: apk: not found'))
      : realEnsure(p);
  let script: FakeScript = [];
  const deps: OrchestratorDeps = {
    store,
    ids,
    clock,
    redactor: new Redactor(),
    logsDir: path.join(dataDir, 'logs'),
    setTimer: () => () => {},
    git,
    runtime,
    get modelDeps() {
      return { getSecret: () => undefined, fake: { script } };
    },
    withMergeLock: (_p, fn) => fn(),
    demo: true,
  };
  const orchestrator = createOrchestrator(deps);
  return {
    store,
    git,
    clock,
    runtime,
    orchestrator,
    async run(s) {
      script = s;
      await orchestrator.runOrchestrator(P, triggersOf(store, P), handle(ids));
    },
    async mainFiles() {
      const dir = path.join(dataDir, 'worktrees', 'inspect');
      const wt = await git.addWorktree(P, 'inspect', 'main', { detached: true });
      try {
        return await listFiles(wt.dir, dir);
      } finally {
        await git.removeWorktree(wt.dir);
      }
    },
    cursor: () => store.q.product(P)?.orchestratorCursor ?? -1,
  };
}

function triggersOf(store: Store, productId: ProductId): Event[] {
  const cursor = store.q.product(productId)?.orchestratorCursor ?? 0;
  return pendingTriggers(store.eventsSince(cursor), cursor, {
    productId,
    questions: store.snapshot().state.questions,
  });
}

function handle(ids: FakeIdGen): RunHandle {
  return { runId: ids.next('run'), signal: new AbortController().signal, shouldStop: () => false };
}

async function listFiles(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, root)));
    else out.push(path.relative(root, full));
  }
  return out.sort();
}

const inboxOf = (store: Store) => Object.values(store.snapshot().state.inbox);

describe('runOrchestrator: a successful plan', () => {
  it('creates 3 issues with deps, commits the setup files to main and stores project.json', async () => {
    const h = await setup();
    const mainBefore = await h.git.mainSha(P);
    const handoffSeq = triggersOf(h.store, P).at(-1)?.seq;

    await h.run(setupScript());

    const issues = h.store.q.issuesByProduct(P);
    expect(issues.map((i) => [i.number, i.title, i.status])).toEqual([
      [1, 'Scaffold', 'open'],
      [2, 'List todos', 'open'],
      [3, 'Add a todo', 'open'],
    ]);
    const [scaffold, list] = issues;
    expect(issues[2]?.dependsOn).toEqual([scaffold?.id, list?.id]);
    expect(h.cursor()).toBe(handoffSeq);

    expect(await h.git.mainSha(P)).not.toBe(mainBefore);
    expect(await h.git.readFileAtMain(P, 'Dockerfile')).toBe(DOCKERFILE);
    expect(JSON.parse((await h.git.readFileAtMain(P, '.vibecode/project.json')) ?? '')).toEqual(
      PROJECT,
    );
    expect(await h.git.readFileAtMain(P, 'docs/adr/0001-stack.md')).toContain('Stack');
    expect(h.store.q.product(P)?.project).toEqual(PROJECT);

    // The image is built from the new Dockerfile; the sandbox is closed and the worktree removed.
    const builds = h.runtime.calls.filter((c) => c.kind === 'ensureImage');
    expect(builds.length).toBe(2);
    expect(h.runtime.calls.filter((c) => c.kind === 'open').length).toBe(1);
    expect(h.runtime.calls.at(-1)?.kind).toBe('close');
    expect(await readdir(path.join(dataDir, 'worktrees'))).toEqual([]);

    // Initial handoff is not a replan: no inbox item.
    expect(inboxOf(h.store)).toEqual([]);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(0);
    expectSnapshotMatchesReplay(h.store);
  });

  it('posts the plan summary to the inbox when a PRD version > 1 was applied', async () => {
    const h = await setup();
    await h.run(setupScript());
    h.store.commit(() => [
      draft('prd.applied', null, { version: 2, markdown: '# v2', summary: 'dark mode' }),
    ]);
    const replan: PlanResult = {
      issueOps: [{ op: 'create', key: 'dark', title: 'Dark mode', body: 'Theme.', dependsOn: [] }],
      questions: [],
      summary: 'Added a dark mode issue.',
    };

    await h.run([finish(replan)]);

    expect(h.store.q.issuesByProduct(P).map((i) => i.title)).toContain('Dark mode');
    expect(inboxOf(h.store)).toMatchObject([
      { productId: P, kind: 'replan', body: 'Added a dark mode issue.' },
    ]);
    // project.json did not change in this run: no second settings_changed.
    const settingsEvents = h.store
      .eventsSince(0)
      .filter((e) => e.type === 'product.settings_changed');
    expect(settingsEvents.length).toBe(1);
    expectSnapshotMatchesReplay(h.store);
  });

  it('a plan without file changes leaves main alone and still applies', async () => {
    const h = await setup();
    const mainBefore = await h.git.mainSha(P);
    await h.run([finish(THREE_ISSUES)]);
    expect(await h.git.mainSha(P)).toBe(mainBefore);
    expect(h.store.q.issuesByProduct(P).length).toBe(3);
    expect(h.store.q.product(P)?.project).toBeNull();
  });
});

describe('runOrchestrator: rejected runs leave main and the cursor unchanged', () => {
  async function expectRejected(h: Harness, script: FakeScript) {
    const mainBefore = await h.git.mainSha(P);
    const filesBefore = await h.mainFiles();
    await h.run(script);
    expect(await h.git.mainSha(P)).toBe(mainBefore);
    expect(await h.mainFiles()).toEqual(filesBefore);
    expect(h.cursor()).toBe(0);
    expect(h.store.q.issuesByProduct(P)).toEqual([]);
    expect(h.store.q.product(P)?.project).toBeNull();
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(START + ORCHESTRATOR_BACKOFF_MS[0]);
    expect(await readdir(path.join(dataDir, 'worktrees'))).toEqual([]);
    expectSnapshotMatchesReplay(h.store);
  }

  it('rejects a change outside Dockerfile, .dockerignore, .vibecode/** and docs/**', async () => {
    const h = await setup();
    await expectRejected(h, [
      { toolCalls: [write('docs/notes.md', 'ok'), write('src/index.ts', 'console.log(1);\n')] },
      finish(THREE_ISSUES),
    ]);
  });

  it('rejects an invalid plan (unknown dependency)', async () => {
    const h = await setup();
    const bad: PlanResult = {
      issueOps: [{ op: 'create', key: 'a', title: 'A', body: 'a', dependsOn: ['missing'] }],
      questions: [],
      summary: 'bad',
    };
    const mainBefore = await h.git.mainSha(P);
    await h.run([finish(bad)]);
    expect(await h.git.mainSha(P)).toBe(mainBefore);
    expect(h.cursor()).toBe(0);
    expect(h.store.q.issuesByProduct(P)).toEqual([]);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(START + ORCHESTRATOR_BACKOFF_MS[0]);
  });

  it('rejects an invalid .vibecode/project.json', async () => {
    const h = await setup();
    await expectRejected(h, [
      { toolCalls: [write('.vibecode/project.json', '{"check": "npm test"}')] },
      finish(THREE_ISSUES),
    ]);
  });

  it('rejects the run when the image does not build from the new Dockerfile', async () => {
    let builds = 0;
    const h = await setup({ failImageBuild: () => ++builds > 1 });
    await expectRejected(h, setupScript());
  });

  it('rejects the run when the agent errors', async () => {
    const h = await setup();
    await expectRejected(h, [{ error: { status: 401 } }]);
  });
});

describe('runOrchestrator: backoff and the error inbox', () => {
  const disallowed: FakeScript = [
    { toolCalls: [write('package.json', '{}')] },
    finish(THREE_ISSUES),
  ];

  it('backs off 30 s, 2 min, then stops after 3 failures with one error inbox item', async () => {
    const h = await setup();

    await h.run(disallowed);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(START + 30_000);
    expect(inboxOf(h.store)).toEqual([]);

    h.clock.advance(30_000);
    await h.run(disallowed);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(START + 30_000 + 120_000);
    expect(inboxOf(h.store)).toEqual([]);

    h.clock.advance(120_000);
    await h.run(disallowed);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(Number.POSITIVE_INFINITY);
    const inbox = inboxOf(h.store);
    expect(inbox).toMatchObject([{ productId: P, kind: 'error', link: `/products/${P}` }]);
    expect(inbox[0]?.body).toMatch(/package\.json/);
    expect(h.cursor()).toBe(0);
    expectSnapshotMatchesReplay(h.store);
  });

  it('a new trigger after giving up allows the next run, and success clears the backoff', async () => {
    const h = await setup();
    for (const ms of [0, 30_000, 120_000]) {
      h.clock.advance(ms);
      await h.run(disallowed);
    }
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(Number.POSITIVE_INFINITY);

    const [applied] = h.store.commit(() => [
      draft('prd.applied', null, { version: 2, markdown: '# v2', summary: null }),
    ]);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(0);

    await h.run(setupScript());
    expect(h.store.q.issuesByProduct(P).length).toBe(3);
    expect(h.orchestrator.orchestratorNotBefore(P)).toBe(0);
    expect(h.cursor()).toBe(applied?.seq);
  });
});

describe('orchestrator prompt', () => {
  const SHA = 'a'.repeat(40);

  it('lists issues with status and feedback, cancelled dependencies, triggers and the research note', async () => {
    const h = await setup();
    await h.run(setupScript());
    const [scaffold, list] = h.store.q.issuesByProduct(P);
    if (scaffold === undefined || list === undefined) throw new Error('plan not applied');
    h.store.commit(() => [
      draft('issue.cancelled', scaffold.id, { from: 'open', by: 'owner', reason: 'not needed' }),
      draft('issue.status_changed', list.id, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      draft('attempt.started', 'attempt-1', {
        issueId: list.id,
        n: 1,
        issueRev: 1,
        baseSha: SHA,
        branch: 'attempt/1',
      }),
      draft('attempt.ended', 'attempt-1', {
        issueId: list.id,
        status: 'check_failed',
        counted: true,
        headSha: null,
        feedback: 'FAIL list.test.ts: expected 2 todos',
        review: null,
        checkExit: 1,
        interruptReason: null,
      }),
      draft('issue.failed', list.id, {
        from: 'in_progress',
        attemptCount: 3,
        reason: 'check failed',
      }),
      draft('question.asked', 'question-q', {
        target: 'orchestrator',
        issueId: null,
        agentId: null,
        text: 'Which database?',
      }),
      draft('question.answered', 'question-q', { answer: 'SQLite' }),
    ]);

    const { instructions, prompt } = orchestratorPrompt({
      store: h.store,
      productId: P,
      triggers: triggersOf(h.store, P),
      prd: '# Todo PRD',
      webSearch: false,
    });

    expect(instructions).toContain('# Todo PRD');
    expect(instructions).toMatch(/#2 \[failed\] List todos/);
    expect(instructions).toContain('Last attempt feedback: FAIL list.test.ts: expected 2 todos');
    expect(instructions).toMatch(/#3 Add a todo .*depends on cancelled #1/);
    expect(instructions).toMatch(/Issue #2 List todos failed after 3 attempts: check failed/);
    expect(instructions).toContain('The owner answered your question "Which database?": SQLite');
    expect(instructions).toMatch(/Web search is NOT available/);
    expect(instructions).toMatch(/Debian\/glibc/);
    expect(instructions).toContain('.vibecode/project.json');
    expect(instructions).toMatch(/thin vertical slice/);
    expect(prompt).toMatch(/finish/);

    const withSearch = orchestratorPrompt({
      store: h.store,
      productId: P,
      triggers: [],
      prd: null,
      webSearch: true,
    }).instructions;
    expect(withSearch).toMatch(/Web search is available/);
  });

  it('on a replan shows the previous and the new PRD version, all issues and the replan rules', async () => {
    const h = await setup();
    await h.run(setupScript());
    const [scaffold] = h.store.q.issuesByProduct(P);
    if (scaffold === undefined) throw new Error('no issues planned');
    h.store.commit(() => [
      draft('issue.completed', scaffold.id, {
        attemptId: 'attempt-1',
        mergedOrder: 1,
        mergeSha: 'a'.repeat(40),
      }),
    ]);
    h.store.commit(() => [
      draft('prd.applied', null, { version: 2, markdown: '# Todo v2 with sharing', summary: null }),
    ]);

    const { instructions } = orchestratorPrompt({
      store: h.store,
      productId: P,
      triggers: triggersOf(h.store, P),
      prd: '# Todo v2 with sharing',
      webSearch: false,
    });

    expect(instructions).toMatch(
      /Previous PRD \(version 1\)[\s\S]*# Todo\n[\s\S]*New PRD \(version 2\)[\s\S]*# Todo v2 with sharing/,
    );
    expect(instructions).toMatch(/#1 \[completed\] Scaffold/);
    expect(instructions).toMatch(/#3 \[open\] Add a todo/);
    expect(instructions).toMatch(/follow-up/);
    expect(instructions).toMatch(/never revert/i);
  });
});
