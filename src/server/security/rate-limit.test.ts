import { describe, expect, it } from 'vitest';
import { FakeClock } from '../util/clock.ts';
import { createRateLimiter } from './rate-limit.ts';

describe('rate limiter (sliding window per client)', () => {
  it('allows `limit` attempts per window per client, then refuses until the window slides', () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, clock });
    expect([1, 2, 3].map(() => limiter.attempt('a'))).toEqual([true, true, true]);
    expect(limiter.attempt('a')).toBe(false);
    expect(limiter.attempt('b')).toBe(true);
    clock.advance(59_999);
    expect(limiter.attempt('a')).toBe(false);
    clock.advance(1);
    // All three earlier attempts left the window together.
    expect([1, 2, 3].map(() => limiter.attempt('a'))).toEqual([true, true, true]);
    expect(limiter.attempt('a')).toBe(false);
  });

  it('refused attempts do not extend the lockout', () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, clock });
    expect(limiter.attempt('a')).toBe(true);
    clock.advance(500);
    expect(limiter.attempt('a')).toBe(false);
    clock.advance(500);
    expect(limiter.attempt('a')).toBe(true);
  });
});
