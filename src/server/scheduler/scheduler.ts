import { budgetLevel } from '../../shared/budget.ts';
import type { Event } from '../../shared/events.ts';
import type { Clock, IdGen, IssueId, ProductId, RunId } from '../../shared/ids.ts';
import { isReady } from '../../shared/issues.ts';
import type { Role } from '../../shared/models.ts';
import type { ClientState, IssueState, ProductState } from '../../shared/state.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import { redactor as sharedRedactor } from '../security/index.ts';
import type { Store } from '../store/index.ts';
import { allIssuesDone, completeProduct } from './completion.ts';
import { clearExpiredLimits } from './limits.ts';

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
  /**
   * A tick threw (e.g. a DB fault). The scheduler contains it and ticks again on the next kick or
   * interval. Default: one `console.error` line, passed through `redactor`.
   */
  onTickError?: (err: unknown) => void;
  /** Redacts the default tick-error log line. Default: the server's shared redactor. */
  redactor?: { redact(text: string): string };
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
    const backend = store.q.product(productId)?.settings.models[role]?.provider;
    if (backend === undefined) return false;
    const limit = store.q.backendLimit(backend);
    if (limit === null) return false;
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
  const onTickError =
    deps.onTickError ??
    ((err: unknown) => {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const line = `scheduler tick failed (retrying on the next tick): ${text}`;
      console.error((deps.redactor ?? sharedRedactor).redact(line));
    });

  const live = new Map<RunId, LiveRun>();
  const settled = new Map<RunId, Promise<void>>();
  const mergeTails = new Map<ProductId, Promise<unknown>>();
  let running = false;
  let stopping = false;
  let handle: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let ticking = false;
  let again = false;
  /** The store's lastSeq as read by the latest tick: events up to it were already scheduled on. */
  let seenSeq = -1;
  /**
   * Pending-trigger checks for products whose backlog is not loaded this tick, keyed by product:
   * reused while neither its cursor nor the store's lastSeq moved.
   */
  const pendingCache = new Map<ProductId, { cursor: number; seq: number; pending: boolean }>();

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

  /** Whether the product can start an orchestrator run this tick (bar its pending triggers). */
  function orchestratorEligible(state: ClientState, p: ProductState): boolean {
    if (p.paused || budgetExhausted(state, p)) return false;
    return (deps.orchestratorNotBefore?.(p.id) ?? 0) <= clock.now();
  }

  /** For a product outside this tick's event window: reads its backlog once per change. */
  function hasPendingTriggers(p: ProductState, triggersFrom: (all: Event[]) => Event[]): boolean {
    const hit = pendingCache.get(p.id);
    if (hit?.cursor === p.orchestratorCursor && hit.seq === seenSeq) return hit.pending;
    const pending = triggersFrom(store.eventsSince(p.orchestratorCursor)).length > 0;
    pendingCache.set(p.id, { cursor: p.orchestratorCursor, seq: seenSeq, pending });
    return pending;
  }

  /**
   * `events`: every event after the minimum cursor of the orchestrator-eligible products, or null
   * when this product is not eligible (its own backlog is then read only when it matters).
   */
  function scheduleProduct(state: ClientState, p: ProductState, events: Event[] | null): void {
    if (p.phase !== 'building') return;
    const mine = [...live.values()].filter((r) => r.productId === p.id);
    const triggersFrom = (all: Event[]) =>
      pendingTriggers(
        all.filter((e) => e.productId === p.id && e.seq > p.orchestratorCursor),
        p.orchestratorCursor,
        { productId: p.id, questions: state.questions },
      );
    const triggers = events === null ? [] : triggersFrom(events);
    const issues = Object.values(state.issues).filter((i) => i.productId === p.id);
    // Flow 9: nothing left to run or plan. The commit re-enters kick(), which coalesces.
    if (mine.length === 0 && allIssuesDone(issues)) {
      // Paused or not (§4.4). Outside the event window the backlog is read once per change.
      const pending = events === null ? hasPendingTriggers(p, triggersFrom) : triggers.length > 0;
      if (!pending && completeProduct(store, p.id)) return;
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
    const { state, lastSeq } = store.snapshot();
    seenSeq = Math.max(seenSeq, lastSeq);
    // An expired rate limit clears first; the commit re-enters kick(), which then schedules on
    // the cleared state (the interrupted issues' runAfter is the same `until`).
    clearExpiredLimits(store, state.backendLimits, clock.now());
    const products = Object.values(state.products).filter((p) => p.phase === 'building');
    if (products.length === 0) return;
    // Only products that can get an orchestrator run now need their trigger backlog: a paused
    // or backed-off product with an old cursor must not make every tick re-read its history.
    const eligible = products.filter((p) => orchestratorEligible(state, p));
    const events =
      eligible.length === 0
        ? []
        : store.eventsSince(Math.min(...eligible.map((p) => p.orchestratorCursor)));
    for (const p of products) {
      if (!running || stopping) return;
      scheduleProduct(state, p, eligible.includes(p) ? events : null);
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
        try {
          tickOnce();
        } catch (err) {
          // Contained: never into a committing caller (bus) or out of the interval callback.
          try {
            onTickError(err);
          } catch {
            // A broken sink must not break scheduling either.
          }
        }
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
      unsubscribe = store.subscribe((e) => {
        // A commit notifies once per event, after all of them are durable: the first event's
        // tick already read the whole batch, so the rest of it must not tick again.
        if (e.seq <= seenSeq) return;
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
