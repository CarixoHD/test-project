import type { Clock } from '../util/clock.ts';

/** Schedules `fn` after `ms`; returns a cancel function. Injected so tests control time. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export const ACTIVITY_INTERVAL_MS = 250;
/** How many of the most recent lines one `agent.activity` event carries. */
export const ACTIVITY_TAIL = 5;

export const realSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/**
 * Batches activity lines into at most one `emit` per `ACTIVITY_INTERVAL_MS` of `clock` time
 * (CODING_STANDARDS §9). A line arriving inside the window is held and sent by a timer when
 * the window ends; each emit carries the last `ACTIVITY_TAIL` lines held since the previous one.
 */
export class ActivityBatcher {
  readonly #clock: Clock;
  readonly #setTimer: SetTimer;
  readonly #emit: (lines: string[]) => void;
  #pending: string[] = [];
  #lastEmit: number | undefined;
  #cancelTimer: (() => void) | undefined;
  #closed = false;

  constructor(deps: { clock: Clock; setTimer: SetTimer; emit: (lines: string[]) => void }) {
    this.#clock = deps.clock;
    this.#setTimer = deps.setTimer;
    this.#emit = deps.emit;
  }

  push(line: string): void {
    if (this.#closed) return;
    this.#pending.push(line);
    if (this.#pending.length > ACTIVITY_TAIL) this.#pending.shift();
    this.#flushOrSchedule();
  }

  /**
   * Stops batching. Held lines go out only if the window allows; otherwise they stay in the
   * log file only, so the rate limit holds even at the end of a run.
   */
  close(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    if (this.#waitMs() === 0) this.#flush();
    this.#closed = true;
  }

  #waitMs(): number {
    if (this.#lastEmit === undefined) return 0;
    return Math.max(0, this.#lastEmit + ACTIVITY_INTERVAL_MS - this.#clock.now());
  }

  #flushOrSchedule(): void {
    if (this.#pending.length === 0) return;
    const wait = this.#waitMs();
    if (wait === 0) {
      this.#cancelTimer?.();
      this.#cancelTimer = undefined;
      this.#flush();
      return;
    }
    if (this.#cancelTimer !== undefined) return;
    this.#cancelTimer = this.#setTimer(() => {
      this.#cancelTimer = undefined;
      if (!this.#closed) this.#flushOrSchedule();
    }, wait);
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    const lines = this.#pending;
    this.#pending = [];
    this.#lastEmit = this.#clock.now();
    this.#emit(lines);
  }
}
