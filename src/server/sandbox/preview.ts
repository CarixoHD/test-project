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
  /** Waits between polls (resolving early when `signal` aborts); tests advance a fake clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Warnings (cleanup failures), already redacted; default console.warn. */
  log?: (line: string) => void;
}

type Failure = { ok: false; code: 'not_found' | 'conflict'; reason: string };
export type StartPreviewResult = { ok: true; url: string } | Failure;
export type StopPreviewResult = { ok: true } | Failure;

export interface Previews {
  startPreview(productId: ProductId): Promise<StartPreviewResult>;
  stopPreview(productId: ProductId): Promise<StopPreviewResult>;
  /**
   * Shutdown: aborts in-flight starts (their containers and worktrees are removed and nothing is
   * committed), waits for queued starts and stops, then stops every preview this process
   * started. Starts requested from then on are refused.
   */
  stopAll(): Promise<void>;
}

type Running = { container: string; worktree: string };

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

const SHUTTING_DOWN = 'Vibecode is shutting down; start the preview again after the restart.';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createPreviews(deps: PreviewDeps): Previews {
  const fetchFn: PreviewFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line: string) => console.warn(line));
  let closing = false;
  /** Aborted by stopAll: in-flight starts stop polling and clean up. */
  const shutdown = new AbortController();
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

  /**
   * Failure cleanup: never throws, so the original outcome is what gets reported. A container or
   * worktree that cannot be removed is logged (the startup recovery sweep removes it later).
   */
  async function cleanUp(productId: ProductId, r: Running): Promise<void> {
    try {
      await deps.runtime.remove(r.container);
    } catch (err) {
      log(
        deps.redactor.redact(
          `Could not remove preview container ${r.container} of product ${productId}: ` +
            errorText(err),
        ),
      );
    }
    if (r.worktree === '') return;
    try {
      await deps.git.removeWorktree(r.worktree);
    } catch (err) {
      log(
        deps.redactor.redact(
          `Could not remove preview worktree ${r.worktree} of product ${productId}: ` +
            errorText(err),
        ),
      );
    }
  }

  async function teardown(r: Running): Promise<void> {
    try {
      await deps.runtime.remove(r.container);
    } finally {
      if (r.worktree !== '') await deps.git.removeWorktree(r.worktree);
    }
  }

  /**
   * Removes the running preview (if any) and commits preview.stopped when the store had one.
   * `remove` is `teardown` (failures propagate) or, on shutdown, `cleanUp` (failures logged).
   */
  async function stopRunning(
    productId: ProductId,
    remove: (productId: ProductId, r: Running) => Promise<void> = (_, r) => teardown(r),
  ): Promise<boolean> {
    const r = current(productId);
    if (r === null) return false;
    running.delete(productId);
    await remove(productId, r);
    deps.store.commit((tx) =>
      tx.q.product(productId) === null
        ? []
        : [{ type: 'preview.stopped', productId, entityId: null, v: 1, data: {} }],
    );
    return true;
  }

  /** GET / until any HTTP answer below 500, the timeout, or shutdown. */
  async function waitUntilServing(url: string): Promise<'up' | 'timeout' | 'aborted'> {
    const deadline = deps.clock.now() + PREVIEW_TIMEOUT_MS;
    for (;;) {
      if (shutdown.signal.aborted) return 'aborted';
      try {
        const signal = AbortSignal.any([
          AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
          shutdown.signal,
        ]);
        const res = await fetchFn(url, { signal });
        if (shutdown.signal.aborted) return 'aborted';
        if (res.status < 500) return 'up';
      } catch {
        // Not listening yet (or aborted: checked at the top of the loop).
      }
      if (shutdown.signal.aborted) return 'aborted';
      if (deps.clock.now() >= deadline) return 'timeout';
      await sleep(PREVIEW_POLL_MS, shutdown.signal);
    }
  }

  async function start(productId: ProductId): Promise<StartPreviewResult> {
    // start() runs when the per-product queue lets it, so this also catches starts that were
    // queued before stopAll: they create no worktree, image or container.
    if (shutdown.signal.aborted) return { ok: false, code: 'conflict', reason: SHUTTING_DOWN };
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
    if (shutdown.signal.aborted) return { ok: false, code: 'conflict', reason: SHUTTING_DOWN };

    const fail = (reason: string): Failure => ({
      ok: false,
      code: 'conflict',
      reason: deps.redactor.redact(reason),
    });
    const runId = deps.ids.next('run');
    const wt = await deps.git.addWorktree(productId, runId, 'main', { detached: true });
    // Docker may create the container even when `run` fails, so cleanup always removes it.
    const created: Running = { container: containerName(runId), worktree: wt.dir };
    let outcome: 'up' | 'timeout' | 'aborted';
    try {
      const image = await deps.runtime.ensureImage({ productId, contextDir: wt.dir });
      const started = await deps.runtime.runDetached(
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
      created.container = started.name;
      const hostPort = await deps.runtime.publishedPort(started.name, config.port);
      const url = `http://127.0.0.1:${String(hostPort)}/`;
      outcome = await waitUntilServing(url);
      if (outcome === 'up') {
        running.set(productId, created);
        deps.store.commit(() => [
          {
            type: 'preview.started',
            productId,
            entityId: null,
            v: 1,
            data: { url, container: created.container },
          },
        ]);
        return { ok: true, url };
      }
    } catch (err) {
      running.delete(productId);
      await cleanUp(productId, created);
      return fail(`The preview could not start: ${errorText(err)}`);
    }
    await cleanUp(productId, created);
    if (outcome === 'aborted') return fail(SHUTTING_DOWN);
    return fail(
      `The preview did not answer on port ${String(config.port)} within ` +
        `${String(PREVIEW_TIMEOUT_MS / 1000)} s. Check that \`${config.command.join(' ')}\` ` +
        `starts a server listening on 0.0.0.0:${String(config.port)} ` +
        '(.vibecode/project.json → preview).',
    );
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
    startPreview: (productId) =>
      closing
        ? Promise.resolve({
            ok: false,
            code: 'conflict',
            reason: SHUTTING_DOWN,
          })
        : serially(productId, () => start(productId)),
    stopPreview: (productId) => serially(productId, () => stop(productId)),
    async stopAll() {
      closing = true;
      // In-flight starts stop polling and clean up; queued work settles before the stop below.
      shutdown.abort();
      const products = new Set([...queues.keys(), ...running.keys()]);
      await Promise.all(
        [...products].map((productId) =>
          serially(productId, async () => {
            if (!running.has(productId)) return;
            try {
              await stopRunning(productId, cleanUp);
            } catch (err) {
              log(
                deps.redactor.redact(
                  `Could not stop the preview of ${productId}: ${errorText(err)}`,
                ),
              );
            }
          }),
        ),
      );
    },
  };
}
