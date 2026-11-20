// Real-Docker E2E of the pipeline (ARCHITECTURE §7 "docker E2E"): fake LLM + DockerCliRuntime +
// real git. Fake implementers work inside containers and their work is committed and merged to
// main; the check runs with network none; containers have no Docker socket and see .git masked;
// a tiny web product whose main serves a page is previewed on 127.0.0.1; recovery removes orphan
// vibecode.managed containers.
// Run with `npm run test:docker`. Without a running Docker daemon these tests FAIL, never skip.
// Each test sets up its own state, so any of them runs alone with `-t`.
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventDraft, EventOf } from '../../src/shared/events.ts';
import { ProductIdSchema, type IssueId, type ProductId } from '../../src/shared/ids.ts';
import { addIssue } from '../../src/server/commands/index.ts';
import { open, type Db } from '../../src/server/db/index.ts';
import { createGit, type Git } from '../../src/server/git/index.ts';
import type { FakeScript } from '../../src/server/llm/index.ts';
import { runAttempt, type AttemptDeps } from '../../src/server/pipeline/index.ts';
import { recover } from '../../src/server/recovery/index.ts';
import {
  createPreviews,
  DOCKER_NOT_RUNNING,
  DockerCliRuntime,
  MANAGED_LABEL,
  type ContainerRuntime,
} from '../../src/server/sandbox/index.ts';
import { Redactor } from '../../src/server/security/index.ts';
import { createStore, type Store } from '../../src/server/store/index.ts';
import { systemClock } from '../../src/server/util/clock.ts';
import { createIdGen, type IdGen } from '../../src/server/util/id-gen.ts';
import { EGRESS_PROBE, NO_IFACE_CHECK } from './net-probes.ts';

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const PREVIEW_PORT = 3000;
const PREVIEW_BODY = 'hello from a vibecode preview';

/**
 * The project's check (argv, run with network none). It fails unless the container has no
 * interface but loopback (a structural check that holds without host internet), outbound traffic
 * is blocked, there is no Docker socket and /workspace/.git is an empty file; the markers it
 * prints end up in the attempt's check.log.
 */
const CHECK_SCRIPT = [
  'set -e',
  'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && echo check:no-docker-sock',
  'test -f .git && test ! -s .git && echo check:git-masked',
  NO_IFACE_CHECK,
  `if node -e "${EGRESS_PROBE}"; then echo check:egress-OPEN; exit 1; fi`,
  'echo check:egress-blocked',
].join('\n');

/** What the first implementer records with the `run` tool from inside its container. */
const PROBE_COMMAND = [
  '{',
  'if test -f /.dockerenv; then echo container:yes; else echo container:no; fi;',
  'if test -e /var/run/docker.sock || test -e /run/docker.sock;',
  'then echo docker-sock:present; else echo docker-sock:absent; fi;',
  'echo "git-bytes:$(wc -c < .git)";',
  'echo "workdir:$(pwd)";',
  '} > probe.txt',
].join(' ');
const EXPECTED_PROBE = 'container:yes\ndocker-sock:absent\ngit-bytes:0\nworkdir:/workspace\n';

const SERVER_JS = [
  "require('node:http')",
  `  .createServer((_req, res) => res.end(${JSON.stringify(PREVIEW_BODY)}))`,
  `  .listen(${String(PREVIEW_PORT)}, '0.0.0.0');`,
  '',
].join('\n');

const finish = (input: object) => ({ toolCalls: [{ name: 'finish', input }] });

/** Fake model scripts: issue #1 probes its container, issue #2 writes the web server. */
function scriptFor(role: string, issueNumber: number): FakeScript {
  if (role === 'reviewer') return [finish({ approve: true, findings: [] })];
  const work =
    issueNumber === 1
      ? { name: 'run', input: { command: PROBE_COMMAND } }
      : { name: 'write_file', input: { path: 'server.js', content: SERVER_JS } };
  return [{ toolCalls: [work] }, finish({ summary: `Implemented #${String(issueNumber)}` })];
}

let base: string;
let dataDir: string;
let rt: DockerCliRuntime;
let P: ProductId;
/** Every product this suite created; teardown removes their containers. */
const products: ProductId[] = [];
let db: Db;
let store: Store;
let git: Git;
let ids: IdGen;
let deps: AttemptDeps;

/**
 * The real runtime, but listing only this suite's containers: recovery removes every managed
 * container it lists, and it must not touch the containers of a Vibecode running on this host.
 */
function scoped(runtime: ContainerRuntime, productId: string): ContainerRuntime {
  return {
    available: () => runtime.available(),
    ensureImage: (p) => runtime.ensureImage(p),
    open: (spec) => runtime.open(spec),
    runOnce: (spec, argv, o) => runtime.runOnce(spec, argv, o),
    runDetached: (spec, argv) => runtime.runDetached(spec, argv),
    publishedPort: (name, port) => runtime.publishedPort(name, port),
    listManaged: async () =>
      (await runtime.listManaged()).filter((c) => c.labels['vibecode.product'] === productId),
    remove: (name) => runtime.remove(name),
  };
}

const draft = (productId: ProductId, type: string, entityId: string | null, data: object) =>
  ({ type, productId, entityId, v: 1, data }) as EventDraft;

/** A product with its own bare repo, the network-none check and a `node server.js` preview. */
async function createProduct(prefix: string, name: string): Promise<ProductId> {
  // Lowercase: the id ends up in container labels and image names.
  const productId = ProductIdSchema.parse(`${prefix}${ids.next('run').toLowerCase()}`);
  products.push(productId);
  await git.initRepo(productId);
  store.commit(() => [
    draft(productId, 'product.created', null, {
      name,
      idea: 'A page that says hello',
      budgetUsd: null,
      maxParallel: 1,
      maxAttempts: 1,
      models: {},
      gitRemote: null,
    }),
    draft(productId, 'product.settings_changed', null, {
      project: {
        check: ['sh', '-c', CHECK_SCRIPT],
        imageInputs: [],
        preview: { command: ['node', 'server.js'], port: PREVIEW_PORT },
      },
    }),
  ]);
  return productId;
}

/** Best-effort teardown step: a failure is logged with context and the teardown continues. */
function warn(what: string): (err: unknown) => void {
  return (err) => {
    console.warn(`tests/docker teardown: ${what} failed:`, err);
  };
}

function lastSpawned(): { role: string; issueNumber: number } {
  const spawned = store
    .eventsSince(0)
    .filter((e): e is EventOf<'agent.spawned'> => e.type === 'agent.spawned')
    .at(-1);
  if (spawned === undefined) throw new Error('no agent spawned');
  const { issueId, role } = spawned.data;
  return { role, issueNumber: issueId === null ? 0 : (store.q.issue(issueId)?.number ?? 0) };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-docker-pipeline-')));
  dataDir = path.join(base, 'data');
  rt = new DockerCliRuntime({ dataDir, uid, gid });
  if (!(await rt.available())) throw new Error(`${DOCKER_NOT_RUNNING} (needed by tests/docker)`);

  ids = createIdGen(systemClock);
  db = open(':memory:');
  const redactor = new Redactor();
  store = createStore({ db, clock: systemClock, redactor });
  git = createGit({ dataDir });
  P = await createProduct('dockerpipe', 'Hello web');
  deps = {
    store,
    ids,
    clock: systemClock,
    redactor,
    logsDir: path.join(dataDir, 'logs'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    setTimer: () => () => {},
    git,
    runtime: rt,
    modelDeps: {
      getSecret: () => undefined,
      // Read once per agent, right after its agent.spawned: the newest agent picks the script.
      get fake() {
        const agent = lastSpawned();
        return { script: scriptFor(agent.role, agent.issueNumber) };
      },
    },
    withMergeLock: (_p, fn) => fn(),
    demo: true,
  };
}, 15 * 60_000);

afterAll(async () => {
  if (rt !== undefined && products.length > 0) {
    const managed = await rt.listManaged().catch((err: unknown) => {
      warn('listing managed containers')(err);
      return [];
    });
    for (const c of managed) {
      const product = c.labels['vibecode.product'];
      if (!products.some((p) => p === product)) continue;
      await rt.remove(c.name).catch(warn(`removing container ${c.name}`));
    }
  }
  if (base !== undefined) {
    await rm(base, { recursive: true, force: true }).catch(warn(`removing ${base}`));
  }
});

function newIssue(title: string): IssueId {
  const r = addIssue({ store, ids }, P, { title, body: `Build ${title}.`, dependsOn: [] });
  if (!r.ok) throw new Error(r.reason);
  return r.issueId;
}

async function attempt(issueId: IssueId): Promise<void> {
  const run = { runId: ids.next('run'), signal: new AbortController().signal };
  await runAttempt(deps, issueId, { ...run, shouldStop: () => false });
}

async function checkLog(issueId: IssueId): Promise<string> {
  const [a] = store.q.attemptsByIssue(issueId);
  if (a === undefined) throw new Error('no attempt recorded');
  return readFile(path.join(dataDir, 'artifacts', a.id, 'check.log'), 'utf8');
}

describe('pipeline against a real Docker daemon', () => {
  it(
    'commits work done in containers, checks it with network none and merges it to main',
    async () => {
      const probe = newIssue('Probe the sandbox');
      await attempt(probe);
      const web = newIssue('Hello page');
      await attempt(web);

      for (const id of [probe, web]) {
        const issue = store.q.issue(id);
        const ended = store.q.attemptsByIssue(id).at(-1);
        const outcome = { status: ended?.status, feedback: ended?.feedback };
        expect(outcome, `attempt for ${issue?.title ?? id}`).toEqual({
          status: 'merged',
          feedback: null,
        });
        expect(issue?.status).toBe('completed');
      }

      // Commit-in-container: the file was written by a shell in the implementer's container
      // (Docker marker present, /workspace cwd, no socket, .git masked) and merged to main.
      expect(await git.readFileAtMain(P, 'probe.txt')).toBe(EXPECTED_PROBE);
      expect(await git.readFileAtMain(P, 'server.js')).toBe(SERVER_JS);
      expect(store.q.issue(web)?.mergeSha).toBe(await git.mainSha(P));
      expect(store.q.issue(probe)?.mergedOrder).toBe(1);
      expect(store.q.issue(web)?.mergedOrder).toBe(2);

      // The check ran with network none: only loopback, outbound failed, no socket, .git masked.
      // The interface check is the evidence that holds even on a host without internet.
      for (const id of [probe, web]) {
        const log = await checkLog(id);
        expect(log).toContain('check:no-iface');
        expect(log).not.toContain('check:iface-OPEN');
        expect(log).toContain('check:egress-blocked');
        expect(log).not.toContain('check:egress-OPEN');
        expect(log).toContain('check:no-docker-sock');
        expect(log).toContain('check:git-masked');
      }

      // Every attempt container was removed again.
      const left = await scoped(rt, P).listManaged();
      expect(left).toEqual([]);
    },
    15 * 60_000,
  );

  it(
    'previews current main of the web product on 127.0.0.1 and removes it on stop',
    async () => {
      // Its own product, whose main already holds the web server: no other test's merge needed.
      const W = await createProduct('dockerprev', 'Hello preview');
      await git.commitFilesOnMain(W, { 'server.js': SERVER_JS }, 'Add hello web server');
      expect(await git.readFileAtMain(W, 'server.js')).toBe(SERVER_JS);
      const previews = createPreviews({
        store,
        ids,
        clock: systemClock,
        git,
        runtime: rt,
        redactor: new Redactor(),
        dataDir,
      });
      try {
        const started = await previews.startPreview(W);
        if (!started.ok) throw new Error(`preview failed: ${started.reason}`);
        expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const res = await fetch(started.url);
        expect(await res.text()).toBe(PREVIEW_BODY);
        const running = await scoped(rt, W).listManaged();
        expect(running.map((c) => c.labels['vibecode.role'])).toEqual(['preview']);

        const stopped = await previews.stopPreview(W);
        expect(stopped).toEqual({ ok: true });
        expect(await scoped(rt, W).listManaged()).toEqual([]);
      } finally {
        await previews.stopAll();
      }
    },
    15 * 60_000,
  );

  it(
    'recovery removes orphan vibecode.managed containers',
    async () => {
      const wt = await git.addWorktree(P, ids.next('run'));
      const image = await rt.ensureImage({ productId: P, contextDir: wt.dir });
      // A container left behind by a process that died: opened, never closed.
      const orphan = await rt.open({
        runId: ids.next('run'),
        productId: P,
        role: 'agent',
        image,
        worktree: wt.dir,
        readOnly: false,
        network: 'none',
      });
      const before = await scoped(rt, P).listManaged();
      expect(before.map((c) => c.name)).toEqual([orphan.name]);
      expect(before[0]?.labels[MANAGED_LABEL]).toBe('1');

      const report = await recover({
        store,
        db,
        git,
        runtime: scoped(rt, P),
        clock: systemClock,
        log: () => {},
      });

      expect(report.containersRemoved).toBe(1);
      const all = await rt.listManaged();
      expect(all.map((c) => c.name)).not.toContain(orphan.name);
    },
    15 * 60_000,
  );
});
