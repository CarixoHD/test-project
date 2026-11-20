import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanResult } from '../../shared/agent-results.ts';
import type { EventDraft } from '../../shared/events.ts';
import type { IssueId, ProductId } from '../../shared/ids.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import { createApp } from '../http/index.ts';
import type { FakeScript } from '../llm/index.ts';
import { createOrchestrator } from '../pipeline/index.ts';
import { FakeContainerRuntime } from '../sandbox/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { applyPrd, createProduct, handoff, savePrdDraft, type ApplyPrdDeps } from './index.ts';

const PRD_V1 = '# Todo\n\n## Problem\nPeople forget things.\n';
const PRD_V2 = '# Todo\n\n## Problem\nPeople forget things.\n\n## Sharing\nShare a list.\n';
const PROJECT = { check: ['npm', 'test'], imageInputs: ['package-lock.json'] };

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-apply-prd-')));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A handed-off product (PRD v1 on main, phase building). */
async function setup(opts: { git?: (git: Git) => Git } = {}) {
  const real = createGit({ dataDir });
  const git = opts.git?.(real) ?? real;
  const redactor = new Redactor();
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new FakeIdGen();
  const store = createStore({ db: open(':memory:'), clock, redactor });
  const deps = { store, ids, git } satisfies ApplyPrdDeps;
  const created = await createProduct(deps, { name: 'Todo', idea: 'Track todos' });
  if (!created.ok) throw new Error(created.reason);
  const productId: ProductId = created.id;
  saveDraft(deps, productId, PRD_V1);
  const handed = await handoff(deps, productId);
  if (!handed.ok) throw new Error(handed.reason);
  const app = createApp({ ...deps, redactor });
  return { ...deps, clock, redactor, productId, app };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function saveDraft(deps: ApplyPrdDeps, productId: ProductId, markdown: string): void {
  const saved = savePrdDraft(deps, productId, { markdown });
  if (!saved.ok) throw new Error(saved.reason);
}

const postApply = (h: Harness, id: string = h.productId) =>
  h.app.request(`/api/products/${id}/apply-prd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

describe('applyPrd', () => {
  it('commits docs/PRD.md and emits prd.applied for the next version in one store commit', async () => {
    const h = await setup();
    saveDraft(h, h.productId, PRD_V2);
    const before = h.store.snapshot().lastSeq;

    const result = await applyPrd(h, h.productId);

    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(await h.git.readFileAtMain(h.productId, 'docs/PRD.md')).toBe(PRD_V2);
    expect(h.store.eventsSince(before).map((e) => [e.type, e.data])).toEqual([
      ['prd.applied', { version: 2, markdown: PRD_V2, summary: null }],
    ]);
    expect(h.store.q.product(h.productId)).toMatchObject({ phase: 'building', prdVersion: 2 });
    expect(h.store.q.prdVersionMarkdown(h.productId, 1)).toBe(PRD_V1);
    expect(h.store.q.prdVersionMarkdown(h.productId, 2)).toBe(PRD_V2);
    expect(h.store.snapshot().state.prdDrafts[h.productId]).toMatchObject({
      markdown: PRD_V2,
      baseVersion: 2,
    });
    // The applied version is an orchestrator trigger.
    const cursor = h.store.q.product(h.productId)?.orchestratorCursor ?? 0;
    const triggers = pendingTriggers(h.store.eventsSince(cursor), cursor, {
      productId: h.productId,
      questions: {},
    });
    expect(triggers.at(-1)).toMatchObject({ type: 'prd.applied', data: { version: 2 } });
    expectSnapshotMatchesReplay(h.store);
  });

  it('moves a complete product back to building in the same commit', async () => {
    const h = await setup();
    h.store.commit(() => [
      {
        type: 'product.phase_changed',
        productId: h.productId,
        entityId: null,
        v: 1,
        data: { phase: 'complete' },
      },
    ]);
    saveDraft(h, h.productId, PRD_V2);
    const before = h.store.snapshot().lastSeq;

    const result = await applyPrd(h, h.productId);

    expect(result.ok).toBe(true);
    const events = h.store.eventsSince(before);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['prd.applied', { version: 2, markdown: PRD_V2, summary: null }],
      ['product.phase_changed', { phase: 'building' }],
    ]);
    expect(new Set(events.map((e) => e.ts)).size).toBe(1);
    expect(h.store.q.product(h.productId)?.phase).toBe('building');
    expectSnapshotMatchesReplay(h.store);
  });

  it('does not commit the PRD twice when a retry follows a failed store commit', async () => {
    let gitCommits = 0;
    const h = await setup({
      git: (git) => ({
        ...git,
        commitFilesOnMain: (...args) => {
          gitCommits += 1;
          return git.commitFilesOnMain(...args);
        },
      }),
    });
    saveDraft(h, h.productId, PRD_V2);
    gitCommits = 0;
    const realCommit = h.store.commit.bind(h.store);
    let failNext = true;
    h.store.commit = (build) => {
      if (failNext) {
        failNext = false;
        throw new Error('database is locked');
      }
      return realCommit(build);
    };

    await expect(applyPrd(h, h.productId)).rejects.toThrow('database is locked');
    const retry = await applyPrd(h, h.productId);

    expect(retry.ok).toBe(true);
    expect(gitCommits).toBe(1);
    expect(h.store.q.product(h.productId)?.prdVersion).toBe(2);
  });

  it('refuses a draft that equals the latest version with a conflict and touches nothing', async () => {
    const h = await setup();
    const mainBefore = await h.git.mainSha(h.productId);
    const seqBefore = h.store.snapshot().lastSeq;

    const result = await applyPrd(h, h.productId);

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(await h.git.mainSha(h.productId)).toBe(mainBefore);
    expect(h.store.snapshot().lastSeq).toBe(seqBefore);
  });
});

describe('POST /api/products/:id/apply-prd', () => {
  it('answers 200 and applies the draft', async () => {
    const h = await setup();
    saveDraft(h, h.productId, PRD_V2);

    const res = await postApply(h);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.store.q.product(h.productId)?.prdVersion).toBe(2);
  });

  it('answers 409 when the draft has not changed since the latest version', async () => {
    const h = await setup();
    const res = await postApply(h);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/no changes/i);
  });

  it('answers 409 while the product is still sparring and 404 for an unknown product', async () => {
    const h = await setup();
    const sparring = await createProduct(h, { name: 'Other', idea: 'x' });
    if (!sparring.ok) throw new Error(sparring.reason);
    saveDraft(h, sparring.id, '# Other');

    expect((await postApply(h, sparring.id)).status).toBe(409);
    expect((await postApply(h, 'product-unknown')).status).toBe(404);
  });
});

describe('apply → replan', () => {
  const finish = (plan: PlanResult) => ({ toolCalls: [{ name: 'finish', input: plan }] });
  const write = (file: string, content: string) => ({
    name: 'write_file',
    input: { path: file, content },
  });
  const INITIAL: PlanResult = {
    issueOps: [
      { op: 'create', key: 'scaffold', title: 'Scaffold', body: 'Set up.', dependsOn: [] },
      { op: 'create', key: 'list', title: 'List todos', body: 'List.', dependsOn: ['scaffold'] },
      { op: 'create', key: 'export', title: 'Export CSV', body: 'CSV.', dependsOn: ['scaffold'] },
    ],
    questions: [],
    summary: 'Three slices.',
  };

  async function withOrchestrator(h: Harness) {
    let script: FakeScript = [];
    const orchestrator = createOrchestrator({
      store: h.store,
      ids: h.ids,
      clock: h.clock,
      redactor: h.redactor,
      logsDir: path.join(dataDir, 'logs'),
      setTimer: () => () => {},
      git: h.git,
      runtime: new FakeContainerRuntime({ dataDir }),
      get modelDeps() {
        return { getSecret: () => undefined, fake: { script } };
      },
      withMergeLock: (_p, fn) => fn(),
      demo: true,
    });
    return async (s: FakeScript) => {
      script = s;
      const cursor = h.store.q.product(h.productId)?.orchestratorCursor ?? 0;
      const triggers = pendingTriggers(h.store.eventsSince(cursor), cursor, {
        productId: h.productId,
        questions: h.store.snapshot().state.questions,
      });
      await orchestrator.runOrchestrator(h.productId, triggers, {
        runId: h.ids.next('run'),
        signal: new AbortController().signal,
        shouldStop: () => false,
      });
    };
  }

  /** Merges `issueId` through a (scripted) attempt. */
  function merge(h: Harness, issueId: IssueId): void {
    const attemptId = h.ids.next('attempt');
    const sha = 'a'.repeat(40);
    const on = (type: string, entityId: string, data: object) =>
      ({ type, productId: h.productId, entityId, v: 1, data }) as EventDraft;
    h.store.commit(() => [
      on('issue.status_changed', issueId, {
        from: 'open',
        to: 'in_progress',
        attemptCount: 0,
        runAfter: 0,
      }),
      on('attempt.started', attemptId, {
        issueId,
        n: 1,
        issueRev: 1,
        baseSha: sha,
        branch: 'vibecode/a1',
      }),
    ]);
    h.store.commit(() => [
      on('attempt.ended', attemptId, {
        issueId,
        status: 'merged',
        counted: true,
        headSha: sha,
        feedback: null,
        review: { approve: true, findings: [] },
        checkExit: 0,
        interruptReason: null,
      }),
      on('issue.completed', issueId, { attemptId, mergedOrder: 1, mergeSha: sha }),
    ]);
  }

  it('creates v2, replans (create, edit, cancel open issues), leaves merged work alone and posts the summary', async () => {
    const h = await setup();
    const run = await withOrchestrator(h);
    await run([
      {
        toolCalls: [
          write('Dockerfile', 'FROM node:22-bookworm-slim\n'),
          write('.vibecode/project.json', JSON.stringify(PROJECT)),
        ],
      },
      finish(INITIAL),
    ]);
    const [scaffold, list, exportCsv] = h.store.q.issuesByProduct(h.productId);
    if (scaffold === undefined || list === undefined || exportCsv === undefined) {
      throw new Error('initial plan missing');
    }
    merge(h, scaffold.id);

    saveDraft(h, h.productId, PRD_V2);
    const applied = await applyPrd(h, h.productId);
    expect(applied.ok).toBe(true);
    const summary = 'Added sharing, narrowed the list issue and dropped CSV export.';
    await run([
      finish({
        issueOps: [
          {
            op: 'create',
            key: 'share',
            title: 'Share a list',
            body: 'Share link.',
            dependsOn: [scaffold.id],
          },
          { op: 'edit', id: list.id, body: 'List todos, shared ones included.' },
          { op: 'cancel', id: exportCsv.id, reason: 'Not in PRD v2' },
        ],
        questions: [],
        summary,
      }),
    ]);

    const issues = h.store.q.issuesByProduct(h.productId);
    expect(issues.map((i) => [i.number, i.title, i.status, i.rev])).toEqual([
      [1, 'Scaffold', 'completed', 1],
      [2, 'List todos', 'open', 2],
      [3, 'Export CSV', 'cancelled', 1],
      [4, 'Share a list', 'open', 1],
    ]);
    expect(issues[3]?.prdVersion).toBe(2);
    // Merged work is untouched: same body and rev, still merged.
    expect(issues[0]).toMatchObject({ body: scaffold.body, rev: 1, mergedOrder: 1 });
    const { state } = h.store.snapshot();
    expect(Object.values(state.inbox)).toMatchObject([
      { productId: h.productId, kind: 'replan', body: summary },
    ]);
    expect(state.prdVersions[h.productId]?.map((v) => [v.version, v.summary])).toEqual([
      [1, null],
      [2, summary],
    ]);
    expect(h.store.q.product(h.productId)?.orchestratorCursor).toBe(
      h.store.eventsSince(0).findLast((e) => e.type === 'prd.applied')?.seq,
    );
    expectSnapshotMatchesReplay(h.store);
  });

  it('a replan that edits or cancels a merged issue is refused and changes nothing', async () => {
    const h = await setup();
    const run = await withOrchestrator(h);
    await run([
      { toolCalls: [write('.vibecode/project.json', JSON.stringify(PROJECT))] },
      finish(INITIAL),
    ]);
    const [scaffold] = h.store.q.issuesByProduct(h.productId);
    if (scaffold === undefined) throw new Error('initial plan missing');
    merge(h, scaffold.id);
    saveDraft(h, h.productId, PRD_V2);
    await applyPrd(h, h.productId);
    const issuesBefore = h.store.q.issuesByProduct(h.productId);

    for (const op of [
      { op: 'cancel', id: scaffold.id, reason: 'revert' } as const,
      { op: 'edit', id: scaffold.id, body: 'Redo it.' } as const,
    ]) {
      await run([finish({ issueOps: [op], questions: [], summary: 'Reverted.' })]);
    }

    expect(h.store.q.issuesByProduct(h.productId)).toEqual(issuesBefore);
    expect(
      Object.values(h.store.snapshot().state.inbox).filter((i) => i.kind === 'replan'),
    ).toEqual([]);
  });
});
