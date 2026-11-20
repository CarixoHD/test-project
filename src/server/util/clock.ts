import type { Clock } from '../../shared/ids.ts';

export type { Clock } from '../../shared/ids.ts';

/** The wall clock (epoch ms). Only the composition root should use it; everything else gets a Clock injected. */
export const systemClock: Clock = { now: () => Date.now() };

/** A test clock: time only moves when the test says so, and never backwards. */
export class FakeClock implements Clock {
  #now: number;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error(`FakeClock cannot move backwards (advance ${ms})`);
    this.#now += ms;
  }

  set(epochMs: number): void {
    if (epochMs < this.#now) throw new Error(`FakeClock cannot move backwards (${epochMs})`);
    this.#now = epochMs;
  }
}
