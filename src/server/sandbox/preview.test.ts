import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ExecError, type ExecResult as UtilExecResult } from '../util/exec.ts';
import {
  buildRunArgs,
  DockerCliRuntime,
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

/** A runtime delegating to the fake; tests override single methods. */
function delegating(rt: FakeContainerRuntime): ContainerRuntime {
  return {
    available: () => rt.available(),
    ensureImage: (p) => rt.ensureImage(p),
    open: (s) => rt.open(s),
    runOnce: (s, a, o) => rt.runOnce(s, a, o),
    runDetached: (s, a) => rt.runDetached(s, a),
    publishedPort: (n, p) => rt.publishedPort(n, p),
    listManaged: () => rt.listManaged(),
    remove: (n) => rt.remove(n),
  };
}

/** A promise plus its resolver, for holding a start in its poll loop. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
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
      ...delegating(runtime),
      runDetached: () => Promise.reject(new Error('image build failed: npm ERR!')),
    };

    const r = await createPreviews(deps({ runtime: failing })).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toContain('image build failed');
    expect(await worktrees()).toEqual([]);
    expect(eventTypes()).not.toContain('preview.started');
  });

  it('builds the URL from the host port the runtime published, not the container port', async () => {
    createProduct();
    const asked: [string, number][] = [];
    const rt: ContainerRuntime = {
      ...delegating(runtime),
      publishedPort: (name, port) => {
        asked.push([name, port]);
        return Promise.resolve(45678);
      },
    };

    const r = await createPreviews(deps({ runtime: rt })).startPreview(P);

    expect(r).toEqual({ ok: true, url: 'http://127.0.0.1:45678/' });
    const [call] = runtime.calls.filter((c) => c.kind === 'runDetached');
    expect(asked).toEqual([[call?.name, 3000]]);
    expect(fetched).toEqual(['http://127.0.0.1:45678/']);
    const started = store.eventsSince(0).find((e) => e.type === 'preview.started');
    expect(started?.data).toMatchObject({ url: 'http://127.0.0.1:45678/' });
  });

  it('logs a redacted warning, and still cleans up, when the container cannot be removed', async () => {
    createProduct();
    isUp = () => false;
    const secret = 'sk-ant-api03-' + 'x'.repeat(40);
    const redactor = new Redactor();
    redactor.register(secret);
    const logged: string[] = [];
    const rt: ContainerRuntime = {
      ...delegating(runtime),
      remove: () => Promise.reject(new Error(`daemon hiccup ${secret}`)),
    };

    const r = await createPreviews(
      deps({ runtime: rt, redactor, log: (l) => logged.push(l) }),
    ).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toMatch(/did not answer/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Could not remove preview container vibecode-.*daemon hiccup/);
    expect(logged[0]).not.toContain(secret);
    expect(await worktrees()).toEqual([]);
  });

  it('logs a removal failure after the container failed to start', async () => {
    createProduct();
    const logged: string[] = [];
    const rt: ContainerRuntime = {
      ...delegating(runtime),
      runDetached: () => Promise.reject(new Error('port is already allocated')),
      remove: () => Promise.reject(new Error('daemon hiccup')),
    };

    const r = await createPreviews(deps({ runtime: rt, log: (l) => logged.push(l) })).startPreview(
      P,
    );

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toContain('port is already allocated');
    expect(logged).toEqual([
      expect.stringMatching(/Could not remove preview container.*daemon hiccup/),
    ]);
    expect(await worktrees()).toEqual([]);
  });
});

describe('startPreview cleanup failures', () => {
  it('logs a removal failure with product id and container, and still reports the start error', async () => {
    createProduct();
    const logged: string[] = [];
    const rt: ContainerRuntime = {
      ...delegating(runtime),
      publishedPort: () => Promise.reject(new Error('no such port mapping')),
      remove: () => Promise.reject(new Error('daemon hiccup')),
    };

    const r = await createPreviews(deps({ runtime: rt, log: (l) => logged.push(l) })).startPreview(
      P,
    );

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toContain('no such port mapping');
    const [spec] = runtime.detached;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(P);
    expect(logged[0]).toContain(`vibecode-${spec?.runId ?? '?'}`);
    expect(logged[0]).toContain('daemon hiccup');
  });

  it('a readiness timeout whose worktree removal fails still resolves with the timeout reason', async () => {
    createProduct();
    isUp = () => false;
    const logged: string[] = [];
    const brokenGit: Git = {
      ...git,
      addWorktree: (...a) => git.addWorktree(...a),
      removeWorktree: () => Promise.reject(new Error('worktree is locked')),
    };

    const r = await createPreviews(
      deps({ git: brokenGit, log: (l) => logged.push(l) }),
    ).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toMatch(/did not answer/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(P);
    expect(logged[0]).toMatch(/worktree.*worktree is locked/);
    expect(await runtime.listManaged()).toEqual([]);
  });

  it('a start error whose worktree removal fails still reports the start error', async () => {
    createProduct();
    const logged: string[] = [];
    const brokenGit: Git = {
      ...git,
      addWorktree: (...a) => git.addWorktree(...a),
      removeWorktree: () => Promise.reject(new Error('worktree is locked')),
    };
    const rt: ContainerRuntime = {
      ...delegating(runtime),
      runDetached: () => Promise.reject(new Error('port is already allocated')),
    };

    const r = await createPreviews(
      deps({ git: brokenGit, runtime: rt, log: (l) => logged.push(l) }),
    ).startPreview(P);

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toContain('port is already allocated');
    expect(logged).toEqual([expect.stringMatching(/worktree is locked/)]);
  });
});

describe('startPreview on the docker CLI runtime (stubbed docker binary)', () => {
  it('starts the container detached and uses the host port from `docker port`', async () => {
    createProduct();
    const argvs: string[][] = [];
    const exec = (cmd: string, argv: readonly string[]): Promise<UtilExecResult> => {
      expect(cmd).toBe('docker');
      argvs.push([...argv]);
      // A healthy daemon: ensureNetworks finds vibecode-egress with ICC off.
      const stdout =
        argv[0] === 'port'
          ? '127.0.0.1:49153\n'
          : argv.includes('{{json .Options}}')
            ? '{"com.docker.network.bridge.enable_icc":"false"}\n'
            : '';
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        timedOut: false,
        aborted: false,
        truncated: false,
      });
    };
    const docker = new DockerCliRuntime({
      dataDir,
      uid: 1000,
      gid: 1000,
      exec,
      spawnStream: () => Promise.reject(new ExecError('not used', 'ENOENT')),
    });

    const r = await createPreviews(deps({ runtime: docker })).startPreview(P);

    expect(r).toEqual({ ok: true, url: 'http://127.0.0.1:49153/' });
    expect(fetched).toEqual(['http://127.0.0.1:49153/']);
    const run = argvs.find((a) => a[0] === 'run');
    if (run === undefined) throw new Error('no docker run');
    expect(run.slice(0, 2)).toEqual(['run', '--detach']);
    expect(run.slice(-2)).toEqual(['npm', 'start']);
    const name = run[run.indexOf('--name') + 1];
    expect(argvs).toContainEqual(['port', name, '3000/tcp']);
    const started = store.eventsSince(0).find((e) => e.type === 'preview.started');
    expect(started?.data).toEqual({ url: 'http://127.0.0.1:49153/', container: name });
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

describe('stopAll', () => {
  it('aborts a start that is still polling, removes its container and commits nothing', async () => {
    vi.useFakeTimers();
    try {
      createProduct();
      const polling = gate();
      // Never ready: every poll hangs until its signal aborts, like a real fetch would.
      const neverReady: PreviewFetch = (url, { signal }) => {
        fetched.push(url);
        polling.open();
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      };
      // The real sleep, so the poll waits on (fake) timers between attempts.
      const { sleep: _fakeSleep, ...withRealSleep } = deps({ fetch: neverReady, log: () => {} });
      const previews = createPreviews(withRealSleep);

      const starting = previews.startPreview(P);
      await polling.promise;
      expect(runtime.detached).toHaveLength(1);
      const eventsBefore = store.eventsSince(0).length;

      let stopped = false;
      const stopping = previews.stopAll().then(() => {
        stopped = true;
      });
      // The start is caught inside fetch (it hangs until aborted), not in the sleep between
      // polls: stopAll's abort rejects the pending fetch, so no timer needs to fire.
      await stopping;

      expect(stopped).toBe(true);
      const r = await starting;
      expect(r).toMatchObject({ ok: false, code: 'conflict' });
      if (!r.ok) expect(r.reason).toMatch(/shutting down/);
      expect(await runtime.listManaged()).toEqual([]);
      expect(await worktrees()).toEqual([]);
      expect(store.eventsSince(0)).toHaveLength(eventsBefore);
      // Nothing is left pending: advancing past the timeout commits nothing and polls no more.
      const polls = fetched.length;
      await vi.advanceTimersByTimeAsync(2 * PREVIEW_TIMEOUT_MS);
      expect(fetched).toHaveLength(polls);
      expect(store.eventsSince(0)).toHaveLength(eventsBefore);
      expect(store.snapshot().state.previews).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a start whose in-flight poll answers after shutdown began', async () => {
    createProduct();
    const hold = gate();
    const polling = gate();
    const previews = createPreviews(
      deps({
        fetch: async (url) => {
          fetched.push(url);
          polling.open();
          await hold.promise;
          return { status: 200 };
        },
      }),
    );

    const starting = previews.startPreview(P);
    await polling.promise;
    const stopping = previews.stopAll();
    hold.open();

    expect(await starting).toMatchObject({ ok: false, code: 'conflict' });
    await stopping;
    expect(await runtime.listManaged()).toEqual([]);
    expect(await worktrees()).toEqual([]);
    expect(eventTypes().filter((t) => t.startsWith('preview.'))).toEqual([]);
    expect(store.snapshot().state.previews).toEqual({});
  });

  it('aborts a start that is sleeping between polls without waiting for the poll interval', async () => {
    vi.useFakeTimers();
    try {
      createProduct();
      // Never ready, and quick about it: each poll is refused at once, so the start spends its
      // time in the (real, fake-timed) sleep between polls.
      isUp = () => false;
      const { sleep: _fakeSleep, ...withRealSleep } = deps({ log: () => {} });
      const previews = createPreviews(withRealSleep);

      const starting = previews.startPreview(P);
      let settled = false;
      void starting.then(() => {
        settled = true;
      });
      // vi.waitFor polls on real timers, so the fake clock does not move while we wait.
      // Wait for the first poll too: the real git work before it may hold timers of its own.
      await vi.waitFor(() => {
        expect(fetched).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
      });
      // One poll done and the sleep timer pending: the start is waiting between polls.
      expect(fetched).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      expect(runtime.detached).toHaveLength(1);
      const eventsBefore = store.eventsSince(0).length;

      // No timer is advanced: only the abort can wake the sleep.
      await previews.stopAll();
      const r = await starting;

      expect(settled).toBe(true);
      expect(fetched).toHaveLength(1);
      expect(r).toMatchObject({ ok: false, code: 'conflict' });
      if (!r.ok) expect(r.reason).toMatch(/shutting down/);
      const [spec] = runtime.detached;
      expect(runtime.calls).toContainEqual({
        kind: 'remove',
        name: `vibecode-${spec?.runId ?? '?'}`,
      });
      expect(await runtime.listManaged()).toEqual([]);
      expect(await worktrees()).toEqual([]);
      expect(store.eventsSince(0)).toHaveLength(eventsBefore);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a start queued behind an in-flight one creates nothing once shutdown began', async () => {
    createProduct();
    const hold = gate();
    const polling = gate();
    const added: string[] = [];
    const spyGit: Git = {
      ...git,
      addWorktree: (...a) => {
        added.push(a[1]);
        return git.addWorktree(...a);
      },
    };
    const previews = createPreviews(
      deps({
        git: spyGit,
        fetch: async (url) => {
          fetched.push(url);
          polling.open();
          await hold.promise;
          return { status: 200 };
        },
      }),
    );

    const first = previews.startPreview(P);
    await polling.promise;
    const queued = previews.startPreview(P);
    const stopping = previews.stopAll();
    hold.open();

    expect(await first).toMatchObject({ ok: false, code: 'conflict' });
    const r = await queued;
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    if (!r.ok) expect(r.reason).toMatch(/shutting down/);
    await stopping;
    // Only the in-flight start created anything.
    expect(added).toHaveLength(1);
    expect(runtime.calls.filter((c) => c.kind === 'ensureImage')).toHaveLength(1);
    expect(runtime.calls.filter((c) => c.kind === 'runDetached')).toHaveLength(1);
    expect(await runtime.listManaged()).toEqual([]);
    expect(await worktrees()).toEqual([]);
    expect(store.snapshot().state.previews).toEqual({});
  });

  it('a start dequeued after shutdown began creates nothing; starts requested later are refused', async () => {
    createProduct();
    const added: string[] = [];
    const spyGit: Git = {
      ...git,
      addWorktree: (...a) => {
        added.push(a[1]);
        return git.addWorktree(...a);
      },
    };
    const previews = createPreviews(deps({ git: spyGit }));

    // Both starts are queued but have not run yet when stopAll aborts.
    const first = previews.startPreview(P);
    const second = previews.startPreview(P);
    const stopping = previews.stopAll();
    const late = previews.startPreview(P);

    for (const r of await Promise.all([first, second, late])) {
      expect(r).toMatchObject({ ok: false, code: 'conflict' });
      if (!r.ok) expect(r.reason).toMatch(/shutting down/);
    }
    await stopping;
    expect(added).toEqual([]);
    expect(runtime.calls).toEqual([]);
    expect(await worktrees()).toEqual([]);
    expect(store.snapshot().state.previews).toEqual({});
  });

  it('logs, instead of swallowing, a container that cannot be removed', async () => {
    createProduct();
    const logged: string[] = [];
    const rt: ContainerRuntime = { ...delegating(runtime) };
    const previews = createPreviews(deps({ runtime: rt, log: (l) => logged.push(l) }));
    expect((await previews.startPreview(P)).ok).toBe(true);
    rt.remove = () => Promise.reject(new Error('daemon hiccup'));

    await previews.stopAll();

    expect(logged).toEqual([expect.stringMatching(/vibecode-.*daemon hiccup/)]);
    expect(await worktrees()).toEqual([]);
  });
});
