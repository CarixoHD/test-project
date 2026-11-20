import type { Clock } from '../../shared/ids.ts';

/** In-memory sliding-window limiter (login attempts). Resets on restart. */
export interface RateLimiter {
  /** Records an attempt for `client`; false (not recorded) when it is over the limit. */
  attempt(client: string): boolean;
}

export function createRateLimiter({
  limit,
  windowMs,
  clock,
}: {
  limit: number;
  windowMs: number;
  clock: Clock;
}): RateLimiter {
  const attempts = new Map<string, number[]>();
  return {
    attempt(client) {
      const now = clock.now();
      // Drop expired entries everywhere so the map cannot grow without bound.
      for (const [key, times] of attempts) {
        const live = times.filter((t) => now - t < windowMs);
        if (live.length === 0) attempts.delete(key);
        else attempts.set(key, live);
      }
      const times = attempts.get(client) ?? [];
      if (times.length >= limit) return false;
      attempts.set(client, [...times, now]);
      return true;
    },
  };
}
