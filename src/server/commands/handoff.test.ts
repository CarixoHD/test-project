import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProductId } from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import { createApp } from '../http/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { createProduct, handoff, savePrdDraft, type HandoffDeps } from './index.ts';

const PRD = '# Todo\n\n## Problem\nPeople forget things.\n';

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'vibecode-handoff-')));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function setup(opts: { git?: (git: Git) => Git; draft?: string | null } = {}) {
  const real = createGit({ dataDir });
  const git = opts.git?.(real) ?? real;
  const redactor = new Redactor();
  const store = createStore({
    db: open(':memory:'),
    clock: new FakeClock(1_700_000_000_000),
    redactor,
  });
  const deps = { store, ids: new FakeIdGen(), git } satisfies HandoffDeps;
  const created = await createProduct(deps, { name: 'Todo', idea: 'Track todos' });
  if (!created.ok) throw new Error(created.reason);
  const productId: ProductId = created.id;
  const draft = opts.draft === undefined ? PRD : opts.draft;
  if (draft !== null) {
    const saved = savePrdDraft(deps, productId, { markdown: draft });
    if (!saved.ok) throw new Error(saved.reason);
  }
  const app = createApp({ ...deps, redactor });
  return { ...deps, productId, app };
}

const postHandoff = (app: Awaited<ReturnType<typeof setup>>['app'], id: string) =>
  app.request(`/api/products/${id}/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

describe('handoff', () => {
  it('commits docs/PRD.md to main and emits v1, prd.applied, handed_off and phase building', async () => {
    const h = await setup();
    const before = h.store.snapshot().lastSeq;

    const result = await handoff(h, h.productId);

    expect(result.ok).toBe(true);
    expect(await h.git.readFileAtMain(h.productId, 'docs/PRD.md')).toBe(PRD);
    const events = h.store.eventsSince(before);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['prd.applied', { version: 1, markdown: PRD, summary: null }],
      ['product.handed_off', { prdVersion: 1 }],
      ['product.phase_changed', { phase: 'building' }],
    ]);
    // One store commit: the events share a timestamp and are consecutive.
    expect(new Set(events.map((e) => e.ts)).size).toBe(1);
    expect(h.store.q.product(h.productId)).toMatchObject({ phase: 'building', prdVersion: 1 });
    const { state } = h.store.snapshot();
    expect(state.prdVersions[h.productId]?.map((v) => v.version)).toEqual([1]);
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
    const realCommit = h.store.commit.bind(h.store);
    let failNext = true;
    h.store.commit = (build) => {
      if (failNext) {
        failNext = false;
        throw new Error('database is locked');
      }
      return realCommit(build);
    };

    await expect(handoff(h, h.productId)).rejects.toThrow('database is locked');
    expect(await h.git.readFileAtMain(h.productId, 'docs/PRD.md')).toBe(PRD);
    expect(h.store.q.product(h.productId)?.phase).toBe('sparring');
    const mainAfterGitStep = await h.git.mainSha(h.productId);

    const retry = await handoff(h, h.productId);

    expect(retry.ok).toBe(true);
    expect(gitCommits).toBe(1);
    expect(await h.git.mainSha(h.productId)).toBe(mainAfterGitStep);
    expect(h.store.q.product(h.productId)?.phase).toBe('building');
    expectSnapshotMatchesReplay(h.store);
  });

  it.each([
    ['no draft', null],
    ['a blank draft', '  \n\t\n'],
  ])('refuses %s with a conflict and touches neither git nor the store', async (_l, draft) => {
    const h = await setup({ draft });
    const mainBefore = await h.git.mainSha(h.productId);
    const seqBefore = h.store.snapshot().lastSeq;

    const result = await handoff(h, h.productId);

    expect(result).toMatchObject({
      ok: false,
      code: 'conflict',
      reason: expect.stringMatching(/draft/i),
    });
    expect(await h.git.mainSha(h.productId)).toBe(mainBefore);
    expect(h.store.snapshot().lastSeq).toBe(seqBefore);
  });

  it('refuses a second handoff (wrong phase) with a conflict', async () => {
    const h = await setup();
    expect((await handoff(h, h.productId)).ok).toBe(true);
    const mainBefore = await h.git.mainSha(h.productId);

    const again = await handoff(h, h.productId);

    expect(again).toMatchObject({
      ok: false,
      code: 'conflict',
      reason: expect.stringMatching(/phase|sparring/i),
    });
    expect(await h.git.mainSha(h.productId)).toBe(mainBefore);
    expect(h.store.q.product(h.productId)?.prdVersion).toBe(1);
  });

  it('answers not_found for an unknown product', async () => {
    const h = await setup();
    const result = await handoff(h, 'product-404' as ProductId);
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('lets only one of two concurrent handoffs through', async () => {
    const h = await setup();
    const results = await Promise.all([handoff(h, h.productId), handoff(h, h.productId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'conflict' });
    expect(h.store.eventsSince(0).filter((e) => e.type === 'prd.applied')).toHaveLength(1);
    expectSnapshotMatchesReplay(h.store);
  });
});

describe('POST /api/products/:id/handoff', () => {
  it('answers 200 and main contains docs/PRD.md with the draft', async () => {
    const h = await setup();
    const res = await postHandoff(h.app, h.productId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await h.git.readFileAtMain(h.productId, 'docs/PRD.md')).toBe(PRD);
    expect(h.store.eventsSince(0).map((e) => e.type)).toEqual(
      expect.arrayContaining(['prd.applied', 'product.handed_off']),
    );
    expectSnapshotMatchesReplay(h.store);
  });

  it('answers 409 for an empty draft', async () => {
    const h = await setup({ draft: '' });
    const res = await postHandoff(h.app, h.productId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('answers 409 when the product is not in the sparring phase', async () => {
    const h = await setup();
    expect((await postHandoff(h.app, h.productId)).status).toBe(200);
    const res = await postHandoff(h.app, h.productId);
    expect(res.status).toBe(409);
  });

  it('answers 404 for an unknown product', async () => {
    const h = await setup();
    expect((await postHandoff(h.app, 'product-404')).status).toBe(404);
  });
});
