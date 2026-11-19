import { describe, expect, it } from 'vitest';
import { FakeClock, systemClock } from './clock.ts';

describe('systemClock', () => {
  it('returns wall-clock epoch milliseconds', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('FakeClock', () => {
  it('starts at the given time and only moves when told to', () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
    clock.set(5_000);
    expect(clock.now()).toBe(5_000);
  });

  it('rejects moving backwards', () => {
    const clock = new FakeClock(1_000);
    expect(() => clock.advance(-1)).toThrow();
    expect(() => clock.set(999)).toThrow();
  });
});
