import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../../shared/agent-results.ts';
import { ProductIdSchema } from '../../shared/ids.ts';
import { ensureDataDir } from '../config.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import {
  buildRunArgs,
  FakeContainerRuntime,
  type ContainerRuntime,
  type DetachedContainer,
  type SandboxSpec,
} from './index.ts';
import {
  createPreviews,
  PREVIEW_POLL_MS,
  PREVIEW_TIMEOUT_MS,
  type PreviewDeps,
  type PreviewFetch,
} from './preview.ts';

const P = ProductIdSchema.parse('prod1');
const PROJECT: ProjectConfig = {
  check: ['npm', 'test'],
  imageInputs: [],
  preview: { command: ['npm', 'start'], port: 3000 },
};

/** Records the spec of every detached container so tests can assert the mount and network. */
class RecordingRuntime extends FakeContainerRuntime {
  readonly detached: SandboxSpec[] = [];
  override runDetached(spec: SandboxSpec, argv: readonly string[]): Promise<DetachedContainer> {
    this.detached.push(spec);
    return super.runDetached(spec, argv);
  }
}

let base: string;
let dataDir: string;
let git: Git;
let store: Store;
let clock: FakeClock;
let runtime: RecordingRuntime;
let fetched: string[];
/** How the fake fetch answers each poll: true → 200, false → connection refused. */
let isUp: (url: string) => boolean;

const fakeFetch: PreviewFetch = (url) => {
  fetched.push(url);
  return isUp(url)
    ? Promise.resolve({ status: 200 })
    : Promise.reject(new Error('connect ECONNREFUSED'));
};

function deps(over: Partial<PreviewDeps> = {}): PreviewDeps {
  return {
    store,
    dataDir,
    ids: new FakeIdGen(),
    clock,
    git,
    runtime,
    redactor: new Redactor(),
    fetch: fakeFetch,
    // The fake clock moves only when the poll loop waits.
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    ...over,
  };
}

function createProduct(project: ProjectConfig | null = PROJECT): void {
  store.commit(() => [
    {
      type: 'product.created',
      productId: P,
      entityId: null,
      v: 1,
      data: {
        name: 'Todo',
        idea: 'A todo app',
        budgetUsd: 10,
        maxParallel: 3,
        maxAttempts: 3,
        models: {},
        gitRemote: null,
      },
    },
    ...(project === null
      ? []
      : [
          {
            type: 'product.settings_changed' as const,
            productId: P,
            entityId: null,
            v: 1 as const,
            data: { project },
          },
        ]),
  ]);
}

/** The fake runtime's methods, minus runDetached (a runtime that cannot run previews). */
function withoutRunDetached(rt: FakeContainerRuntime): ContainerRuntime {
  return {
    available: () => rt.available(),
    ensureImage: (p) => rt.ensureImage(p),
    open: (s) => rt.open(s),
    runOnce: (s, a, o) => rt.runOnce(s, a, o),
    listManaged: () => rt.listManaged(),
    remove: (n) => rt.remove(n),
  };
}

const worktrees = () => readdir(path.join(dataDir, 'worktrees'));
const eventTypes = () => store.eventsSince(0).map((e) => e.type);

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibecode-preview-'));
  dataDir = path.join(base, 'data');
  ensureDataDir(dataDir);
  git = createGit({ dataDir });
  await git.initRepo(P);
  clock = new FakeClock();
  store = createStore({ db: open(':memory:'), clock, redactor: new Redactor() });
  runtime = new RecordingRuntime({ dataDir });
  fetched = [];
  isUp = () => true;
});

afterEach(async () => {
  for (const m of await runtime.listManaged()) await runtime.remove(m.name);
  await rm(base, { recursive: true, force: true });
});

describe('startPreview', () => {
  it('runs main read-only on the preview network, polls GET / and commits preview.started', async () => {
    createProduct();
    const previews = createPreviews(deps());

    const r = await previews.startPreview(P);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(fetched).toEqual([r.url]);

    const [spec] = runtime.detached;
    if (spec === undefined) throw new Error('no detached container');
    expect(spec).toMatchObject({
      productId: P,
      role: 'preview',
      readOnly: true,
      network: 'preview',
      publishPort: 3000,
    });
    // A detached worktree of current main, mounted read-only and published on loopback only.
    expect(spec.worktree.startsWith(path.join(dataDir, 'worktrees') + path.sep)).toBe(true);
    const args = buildRunArgs(spec, { uid: 1000, gid: 1000, dataDir });
    expect(args).toContain(`type=bind,src=${spec.worktree},dst=/workspace,readonly`);
    expect(args.join(' ')).toContain('--publish 127.0.0.1::3000');
    expect(args.filter((a) => a.includes('::'))).toEqual(['127.0.0.1::3000']);
    expect(runtime.calls).toContainEqual(
      expect.objectContaining({ kind: 'runDetached', argv: ['npm', 'start'] }),
    );
    expect(runtime.calls).toContainEqual({
      kind: 'ensureImage',
      productId: P,
      contextDir: spec.worktree,
    });

    const started = store.eventsSince(0).find((e) => e.type === 'preview.started');
    expect(started?.data).toEqual({ url: r.url, container: `vibecode-${spec.runId}` });
    expect(store.snapshot().state.previews[P]?.url).toBe(r.url);
    expectSnapshotMatchesReplay(store);
  });

  it('keeps polling until the app answers', async () => {
    createProduct();
    let polls = 0;
    isUp = () => ++polls >= 3;
    const t0 = clock.now();

    const r = await createPreviews(deps()).startPreview(P);

    expect(r.ok).toBe(true);
    expect(fetched).toHaveLength(3);
    expect(clock.now() - t0).toBe(2 * PREVIEW_POLL_MS);
  });

  it('gives up after 60 s, cleans up and reports an actionable error', async () => {
    createProduct();
    isUp = () => false;
    const t0 = clock.now();

    const r = await createPreviews(deps()).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (r.ok) return;
    expect(r.reason).toMatch(/did not answer.*60 s/);
    expect(r.reason).toContain('port 3000');
    expect(r.reason).toContain('npm start');
    expect(PREVIEW_TIMEOUT_MS).toBe(60_000);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(PREVIEW_TIMEOUT_MS);
    expect(clock.now() - t0).toBeLessThan(PREVIEW_TIMEOUT_MS + 2 * PREVIEW_POLL_MS);
    expect(await runtime.listManaged()).toEqual([]);
    expect(await worktrees()).toEqual([]);
    expect(eventTypes()).not.toContain('preview.started');
  });

  it('replaces the running preview when started again', async () => {
    createProduct();
    const previews = createPreviews(deps());

    const first = await previews.startPreview(P);
    const second = await previews.startPreview(P);

    expect(first.ok && second.ok).toBe(true);
    const [a, b] = runtime.detached;
    if (a === undefined || b === undefined) throw new Error('expected two containers');
    expect(runtime.calls).toContainEqual({ kind: 'remove', name: `vibecode-${a.runId}` });
    expect((await runtime.listManaged()).map((m) => m.name)).toEqual([`vibecode-${b.runId}`]);
    expect(existsSync(a.worktree)).toBe(false);
    expect(await worktrees()).toEqual([path.basename(b.worktree)]);
    if (second.ok) expect(store.snapshot().state.previews[P]?.url).toBe(second.url);
    expect(eventTypes().filter((t) => t.startsWith('preview.'))).toEqual([
      'preview.started',
      'preview.stopped',
      'preview.started',
    ]);
    expectSnapshotMatchesReplay(store);
  });

  it('refuses a product without a preview config (409) and unknown products (404)', async () => {
    createProduct({ check: ['npm', 'test'], imageInputs: [] });
    const previews = createPreviews(deps());

    const r = await previews.startPreview(P);
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toMatch(/preview/);
    expect(await previews.startPreview(ProductIdSchema.parse('nope'))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(runtime.calls).toEqual([]);
    expect(await worktrees()).toEqual([]);
  });

  it('cleans up the worktree and reports the error when the container fails to start', async () => {
    createProduct();
    const failing: ContainerRuntime = {
      ...withoutRunDetached(runtime),
      runDetached: () => Promise.reject(new Error('image build failed: npm ERR!')),
    };

    const r = await createPreviews(deps({ runtime: failing })).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toContain('image build failed');
    expect(await worktrees()).toEqual([]);
    expect(eventTypes()).not.toContain('preview.started');
  });

  it('reports an actionable error when the runtime cannot run previews', async () => {
    createProduct();

    const r = await createPreviews(deps({ runtime: withoutRunDetached(runtime) })).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toMatch(/container runtime/i);
    expect(await worktrees()).toEqual([]);
  });
});

describe('stopPreview', () => {
  it('removes the container and worktree and commits preview.stopped', async () => {
    createProduct();
    const previews = createPreviews(deps());
    await previews.startPreview(P);
    const [spec] = runtime.detached;
    if (spec === undefined) throw new Error('no container');

    expect(await previews.stopPreview(P)).toEqual({ ok: true });

    expect(await runtime.listManaged()).toEqual([]);
    expect(existsSync(spec.worktree)).toBe(false);
    expect(eventTypes().at(-1)).toBe('preview.stopped');
    expect(store.snapshot().state.previews).toEqual({});
    expectSnapshotMatchesReplay(store);
  });

  it('answers 409 when no preview is running and 404 for unknown products', async () => {
    createProduct();
    const previews = createPreviews(deps());
    expect(await previews.stopPreview(P)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await previews.stopPreview(ProductIdSchema.parse('nope'))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('stops a preview recorded in the store but not known in memory (after a restart)', async () => {
    createProduct();
    await createPreviews(deps()).startPreview(P);

    const fresh = createPreviews(deps());
    expect(await fresh.stopPreview(P)).toEqual({ ok: true });

    expect(await runtime.listManaged()).toEqual([]);
    expect(await worktrees()).toEqual([]);
    expect(store.snapshot().state.previews).toEqual({});
  });
});
