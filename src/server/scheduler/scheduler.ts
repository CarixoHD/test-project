import { budgetLevel } from '../../shared/budget.ts';
import type { Event } from '../../shared/events.ts';
import type { Clock, IdGen, IssueId, ProductId, RunId } from '../../shared/ids.ts';
import { isReady } from '../../shared/issues.ts';
import type { Role } from '../../shared/models.ts';
import type { ClientState, IssueState, ProductState } from '../../shared/state.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import type { Store } from '../store/index.ts';
import { allIssuesDone, completeProduct } from './completion.ts';

// The scheduler (ARCHITECTURE §4.4). It decides WHEN runs start; the runners (pipeline) do
// the work and write state through the store. Live runs are in memory only: after a restart
// recovery reaps whatever the previous process left behind.

export const TICK_MS = 2_000;

export type RunKind = 'orchestrator' | 'attempt';

/** What a runner gets for its run: poll `shouldStop()` between steps, or listen to `signal`. */
export interface RunHandle {
  runId: RunId;
  /** Aborted when the scheduler stops (shutdown). */
  signal: AbortSignal;
  /** True when the product is paused, its budget is exhausted, or the server is shutting down. */
  shouldStop(): boolean;
}

export interface Runners {
  runOrchestrator(productId: ProductId, triggers: Event[], run: RunHandle): Promise<void>;
  runAttempt(issueId: IssueId, run: RunHandle): Promise<void>;
}

export interface LiveRun {
  abort: AbortController;
  productId: ProductId;
  kind: RunKind;
  issueId?: IssueId;
}

export interface Timer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SchedulerDeps {
  store: Store;
  clock: Clock;
  runners: Runners;
  /** True when the backend resolved for `role` in this product is rate-limited or needs login. */
  isBackendBlocked?: (productId: ProductId, role: Role) => boolean;
  /** Backoff hook: no orchestrator run starts for the product before this epoch ms. */
  orchestratorNotBefore?: (productId: ProductId) => number;
  ids?: IdGen;
  timer?: Timer;
  tickMs?: number;
  /** A runner rejected (runners report their own failures as events; this is diagnostics). */
  onError?: (err: unknown, run: { runId: RunId; kind: RunKind; productId: ProductId }) => void;
}

export interface Scheduler {
  start(): void;
  /** Signals every live run to stop and resolves once all of them have settled. */
  stop(): Promise<void>;
  /** Runs a tick now (e.g. after an owner command). */
  kick(): void;
  shouldStop(runId: RunId): boolean;
  /** Per-product async mutex: callers for one product run one at a time, in call order. */
  withMergeLock<T>(productId: ProductId, fn: () => Promise<T>): Promise<T>;
  liveRuns(): ReadonlyMap<RunId, LiveRun>;
}

const systemTimer: Timer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

/** Ready-queue order: higher priority first (urgent > high > normal > low), then lower number. */
export function byPriorityThenNumber(a: IssueState, b: IssueState): number {
  return b.priority - a.priority || a.number - b.number;
}

function budgetExhausted(state: ClientState, p: ProductState): boolean {
  const spent = state.usage.byProduct[p.id]?.apiUsd ?? 0;
  return budgetLevel(spent, p.settings.budgetUsd) === 'exhausted';
}

/**
 * Default `isBackendBlocked`: the role's configured provider has an active `backend.limited`
 * entry (needs login, unknown reset, or `until` still in the future). Roles without an explicit
 * model are never blocked here.
 */
export function backendBlockedByLimits(
  store: Store,
  clock: Clock,
): (productId: ProductId, role: Role) => boolean {
  return (productId, role) => {
    const { state } = store.snapshot();
    const backend = state.products[productId]?.settings.models[role]?.provider;
    if (backend === undefined) return false;
    const limit = state.backendLimits[backend];
    if (limit === undefined) return false;
    return limit.needsLogin || limit.until === null || limit.until > clock.now();
  };
}

function idCounter(): IdGen {
  let n = 0;
  return {
    next: (kind) => {
      n += 1;
      return `${kind}-${String(n)}` as never;
    },
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, clock, runners } = deps;
  const isBackendBlocked = deps.isBackendBlocked ?? backendBlockedByLimits(store, clock);
  const timer = deps.timer ?? systemTimer;
  const ids = deps.ids ?? idCounter();
  const onError = deps.onError ?? (() => {});

  const live = new Map<RunId, LiveRun>();
  const settled = new Map<RunId, Promise<void>>();
  const mergeTails = new Map<ProductId, Promise<unknown>>();
  let running = false;
  let stopping = false;
  let handle: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let ticking = false;
  let again = false;

  function productBlocked(productId: ProductId): boolean {
    const p = store.q.product(productId);
    if (p === null || p.paused) return true;
    const spent = store.q.productUsage(productId).apiUsd;
    return budgetLevel(spent, p.settings.budgetUsd) === 'exhausted';
  }

  function shouldStop(runId: RunId): boolean {
    const run = live.get(runId);
    if (stopping || run === undefined) return true;
    return productBlocked(run.productId);
  }

  function launch(
    productId: ProductId,
    kind: RunKind,
    issueId: IssueId | undefined,
    body: (run: RunHandle) => Promise<void>,
  ): void {
    const runId = ids.next('run');
    const abort = new AbortController();
    live.set(runId, { abort, productId, kind, ...(issueId === undefined ? {} : { issueId }) });
    const run: RunHandle = { runId, signal: abort.signal, shouldStop: () => shouldStop(runId) };
    let started: Promise<void>;
    try {
      // Called synchronously; a runner that commits right away re-enters kick(), which coalesces.
      started = body(run);
    } catch (err) {
      started = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const done = started
      .catch((err: unknown) => {
        onError(err, { runId, kind, productId });
      })
      .finally(() => {
        // No immediate re-tick: a run that ends without committing anything (e.g. a failing
        // orchestrator) would otherwise restart in a hot loop. Its end events or the timer tick.
        live.delete(runId);
        settled.delete(runId);
      });
    settled.set(runId, done);
  }

  function scheduleProduct(state: ClientState, p: ProductState, events: Event[]): void {
    if (p.phase !== 'building') return;
    const mine = [...live.values()].filter((r) => r.productId === p.id);
    const scoped = events.filter((e) => e.productId === p.id && e.seq > p.orchestratorCursor);
    const triggers = pendingTriggers(scoped, p.orchestratorCursor, {
      productId: p.id,
      questions: state.questions,
    });
    const issues = Object.values(state.issues).filter((i) => i.productId === p.id);
    // Flow 9: nothing left to run or plan. The commit re-enters kick(), which coalesces.
    if (mine.length === 0 && triggers.length === 0 && allIssuesDone(issues)) {
      if (completeProduct(store, p.id)) return;
    }
    if (p.paused || budgetExhausted(state, p)) return;
    let liveCount = mine.length;
    const max = p.settings.maxParallel;

    const orchestratorLive = mine.some((r) => r.kind === 'orchestrator');
    if (!orchestratorLive && liveCount < max) {
      const notBefore = deps.orchestratorNotBefore?.(p.id) ?? 0;
      if (
        triggers.length > 0 &&
        notBefore <= clock.now() &&
        !isBackendBlocked(p.id, 'orchestrator')
      ) {
        launch(p.id, 'orchestrator', undefined, (run) =>
          runners.runOrchestrator(p.id, triggers, run),
        );
        liveCount += 1;
      }
    }

    if (liveCount >= max) return;
    if (isBackendBlocked(p.id, 'implementer')) return;
    const busy = new Set(mine.flatMap((r) => (r.issueId === undefined ? [] : [r.issueId])));
    const now = clock.now();
    const ready = issues
      .filter((i) => !busy.has(i.id) && isReady(i, state.issues, now))
      .sort(byPriorityThenNumber);
    for (const issue of ready) {
      if (liveCount >= max) break;
      launch(p.id, 'attempt', issue.id, (run) => runners.runAttempt(issue.id, run));
      liveCount += 1;
    }
  }

  function tickOnce(): void {
    const { state } = store.snapshot();
    const products = Object.values(state.products).filter((p) => p.phase === 'building');
    if (products.length === 0) return;
    const minCursor = Math.min(...products.map((p) => p.orchestratorCursor));
    const events = store.eventsSince(minCursor);
    for (const p of products) {
      if (!running || stopping) return;
      scheduleProduct(state, p, events);
    }
  }

  function kick(): void {
    if (!running || stopping) return;
    // Runners may commit synchronously, which re-enters through the bus: coalesce into a loop.
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        tickOnce();
      } while (again && running && !stopping);
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopping = false;
      unsubscribe = store.subscribe(() => {
        kick();
      });
      handle = timer.setInterval(kick, deps.tickMs ?? TICK_MS);
      kick();
    },
    async stop() {
      stopping = true;
      if (handle !== null) timer.clearInterval(handle);
      handle = null;
      unsubscribe?.();
      unsubscribe = null;
      for (const run of live.values()) run.abort.abort();
      await Promise.all([...settled.values()]);
      running = false;
    },
    kick,
    shouldStop,
    withMergeLock<T>(productId: ProductId, fn: () => Promise<T>): Promise<T> {
      const prev = mergeTails.get(productId) ?? Promise.resolve();
      // `prev` never rejects (the tail swallows), so fn always runs after the previous holder.
      const result = prev.then(() => fn());
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      mergeTails.set(productId, tail);
      void tail.then(() => {
        if (mergeTails.get(productId) === tail) mergeTails.delete(productId);
      });
      return result;
    },
    liveRuns: () => live,
  };
}
