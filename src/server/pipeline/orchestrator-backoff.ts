import type { ProductId } from '../../shared/ids.ts';

// Retry policy for failed orchestrator runs (ARCHITECTURE §6 flow 3). Kept in memory: after a
// restart the orchestrator simply tries again. The scheduler reads `notBefore` through its
// `orchestratorNotBefore` hook.

/** Delay before retry n (1-based) after n consecutive failures. */
export const ORCHESTRATOR_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
/** After this many consecutive failures the owner is told and retries stop until a new trigger. */
export const ORCHESTRATOR_MAX_FAILURES = 3;

type FailureState = {
  failures: number;
  notBefore: number;
  /** Set once retries stopped: only triggers with a higher seq start a new run. */
  gaveUpAtSeq: number | null;
};

export type FailureOutcome = { failures: number; gaveUp: boolean };

export class OrchestratorBackoff {
  readonly #byProduct = new Map<ProductId, FailureState>();
  readonly #delays: readonly number[];
  readonly #maxFailures: number;

  constructor(o: { delaysMs?: readonly number[]; maxFailures?: number } = {}) {
    this.#delays = o.delaysMs ?? ORCHESTRATOR_BACKOFF_MS;
    this.#maxFailures = o.maxFailures ?? ORCHESTRATOR_MAX_FAILURES;
  }

  /** Records a failed run that consumed triggers up to `triggerSeq`. */
  recordFailure(productId: ProductId, now: number, triggerSeq: number): FailureOutcome {
    const failures = (this.#byProduct.get(productId)?.failures ?? 0) + 1;
    const gaveUp = failures >= this.#maxFailures;
    const delay = this.#delays[Math.min(failures, this.#delays.length) - 1] ?? 0;
    this.#byProduct.set(productId, {
      failures,
      notBefore: gaveUp ? Number.POSITIVE_INFINITY : now + delay,
      gaveUpAtSeq: gaveUp ? triggerSeq : null,
    });
    return { failures, gaveUp };
  }

  recordSuccess(productId: ProductId): void {
    this.#byProduct.delete(productId);
  }

  /**
   * Earliest start of the next run. When retries have stopped, `latestTriggerSeq` (the highest
   * pending trigger seq) decides: a newer trigger resets the failure count.
   */
  notBefore(productId: ProductId, latestTriggerSeq: () => number): number {
    const s = this.#byProduct.get(productId);
    if (s === undefined) return 0;
    if (s.gaveUpAtSeq !== null && latestTriggerSeq() > s.gaveUpAtSeq) {
      this.#byProduct.delete(productId);
      return 0;
    }
    return s.notBefore;
  }
}
