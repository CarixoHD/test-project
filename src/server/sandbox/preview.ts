// Preview of a product's current main (ARCHITECTURE §4.8, PRD Preview): a detached worktree of
// main, mounted read-only into a container on the preview network that runs
// `project.preview.command` and publishes `project.preview.port` on 127.0.0.1 only. The URL is
// committed as preview.started once GET / answers. One preview per product: starting again
// replaces the running one. Every failure removes what was created and returns a reason the
// owner can act on.
import path from 'node:path';
import type { Clock, IdGen, ProductId } from '../../shared/ids.ts';
import type { Git } from '../git/index.ts';
import type { Store } from '../store/index.ts';
import { containerName } from './run-args.ts';
import type { ContainerRuntime } from './types.ts';

export const PREVIEW_TIMEOUT_MS = 60_000;
export const PREVIEW_POLL_MS = 500;
/** One poll request may take at most this long. */
const POLL_REQUEST_TIMEOUT_MS = 2_000;
const CONTAINER_PREFIX = containerName('');

/** The slice of `fetch` the poll uses; tests inject a fake. */
export type PreviewFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ status: number }>;

export interface PreviewDeps {
  store: Store;
  ids: IdGen;
  clock: Clock;
  git: Git;
  runtime: ContainerRuntime;
  redactor: { redact(text: string): string };
  /** The data dir: preview worktrees live in `<dataDir>/worktrees/<runId>`. */
  dataDir: string;
  fetch?: PreviewFetch;
  /** Waits between polls; tests advance a fake clock instead. */
  sleep?: (ms: number) => Promise<void>;
}

type Failure = { ok: false; code: 'not_found' | 'conflict'; reason: string };
export type StartPreviewResult = { ok: true; url: string } | Failure;
export type StopPreviewResult = { ok: true } | Failure;

export interface Previews {
  startPreview(productId: ProductId): Promise<StartPreviewResult>;
  stopPreview(productId: ProductId): Promise<StopPreviewResult>;
  /** Stops every preview this process started (shutdown). */
  stopAll(): Promise<void>;
}

type Running = { container: string; worktree: string };

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createPreviews(deps: PreviewDeps): Previews {
  const fetchFn: PreviewFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? defaultSleep;
  const worktreesDir = path.join(deps.dataDir, 'worktrees');
  const running = new Map<ProductId, Running>();
  /** Per-product chain: start and stop of one product never interleave. */
  const queues = new Map<ProductId, Promise<unknown>>();

  function serially<T>(productId: ProductId, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(productId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(productId, settled);
    void settled.then(() => {
      if (queues.get(productId) === settled) queues.delete(productId);
    });
    return next;
  }

  /** The running preview: in memory, or (after a restart) derived from the store. */
  function current(productId: ProductId): Running | null {
    const known = running.get(productId);
    if (known !== undefined) return known;
    const stored = deps.store.snapshot().state.previews[productId];
    if (stored === undefined) return null;
    const runId = stored.container.startsWith(CONTAINER_PREFIX)
      ? stored.container.slice(CONTAINER_PREFIX.length)
      : null;
    return {
      container: stored.container,
      worktree: runId === null || runId === '' ? '' : path.join(worktreesDir, runId),
    };
  }

  async function teardown(r: Running): Promise<void> {
    try {
      await deps.runtime.remove(r.container);
    } finally {
      if (r.worktree !== '') await deps.git.removeWorktree(r.worktree);
    }
  }

  /** Removes the running preview (if any) and commits preview.stopped when the store had one. */
  async function stopRunning(productId: ProductId): Promise<boolean> {
    const r = current(productId);
    if (r === null) return false;
    running.delete(productId);
    await teardown(r);
    deps.store.commit((tx) =>
      tx.q.product(productId) === null
        ? []
        : [{ type: 'preview.stopped', productId, entityId: null, v: 1, data: {} }],
    );
    return true;
  }

  /** GET / until any HTTP answer below 500, or until the timeout. */
  async function waitUntilServing(url: string): Promise<boolean> {
    const deadline = deps.clock.now() + PREVIEW_TIMEOUT_MS;
    for (;;) {
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS) });
        if (res.status < 500) return true;
      } catch {
        // Not listening yet.
      }
      if (deps.clock.now() >= deadline) return false;
      await sleep(PREVIEW_POLL_MS);
    }
  }

  async function start(productId: ProductId): Promise<StartPreviewResult> {
    const product = deps.store.q.product(productId);
    if (product === null)
      return { ok: false, code: 'not_found', reason: `No product ${productId}` };
    const config = product.project?.preview;
    if (config === undefined) {
      return {
        ok: false,
        code: 'conflict',
        reason:
          'This product has no preview configured: add `preview: {command, port}` to ' +
          '.vibecode/project.json on main.',
      };
    }
    await stopRunning(productId);

    const fail = (reason: string): Failure => ({
      ok: false,
      code: 'conflict',
      reason: deps.redactor.redact(reason),
    });
    const runDetached = deps.runtime.runDetached?.bind(deps.runtime);
    if (runDetached === undefined) {
      return fail('The container runtime cannot run previews; previews need the Docker runtime.');
    }
    const runId = deps.ids.next('run');
    const wt = await deps.git.addWorktree(productId, runId, 'main', { detached: true });
    let container: string | null = null;
    try {
      const image = await deps.runtime.ensureImage({ productId, contextDir: wt.dir });
      const started = await runDetached(
        {
          runId,
          productId,
          role: 'preview',
          image,
          worktree: wt.dir,
          readOnly: true,
          network: 'preview',
          publishPort: config.port,
        },
        config.command,
      );
      container = started.name;
      const url = `http://127.0.0.1:${String(started.hostPort)}/`;
      if (!(await waitUntilServing(url))) {
        await teardown({ container, worktree: wt.dir });
        return fail(
          `The preview did not answer on port ${String(config.port)} within ` +
            `${String(PREVIEW_TIMEOUT_MS / 1000)} s. Check that \`${config.command.join(' ')}\` ` +
            `starts a server listening on 0.0.0.0:${String(config.port)} ` +
            '(.vibecode/project.json → preview).',
        );
      }
      const name = container;
      running.set(productId, { container: name, worktree: wt.dir });
      deps.store.commit(() => [
        {
          type: 'preview.started',
          productId,
          entityId: null,
          v: 1,
          data: { url, container: name },
        },
      ]);
      return { ok: true, url };
    } catch (err) {
      running.delete(productId);
      if (container !== null) await deps.runtime.remove(container).catch(() => undefined);
      await deps.git.removeWorktree(wt.dir);
      return fail(`The preview could not start: ${errorText(err)}`);
    }
  }

  async function stop(productId: ProductId): Promise<StopPreviewResult> {
    if (deps.store.q.product(productId) === null) {
      return { ok: false, code: 'not_found', reason: `No product ${productId}` };
    }
    if (!(await stopRunning(productId))) {
      return { ok: false, code: 'conflict', reason: 'No preview is running for this product' };
    }
    return { ok: true };
  }

  return {
    startPreview: (productId) => serially(productId, () => start(productId)),
    stopPreview: (productId) => serially(productId, () => stop(productId)),
    async stopAll() {
      await Promise.all(
        [...running.keys()].map((productId) =>
          serially(productId, () => stopRunning(productId)).catch(() => false),
        ),
      );
    },
  };
}
