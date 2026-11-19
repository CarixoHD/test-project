import type { EventOf } from './events.ts';
import type { TokenCounts, UsageTotals } from './state-schema.ts';

type UsageRecorded = EventOf<'usage.recorded'>['data'];

const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  apiUsd: 0,
  apiUnpriced: false,
  subscriptionTokens: ZERO_TOKENS,
  subscriptionCalls: 0,
};

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/**
 * Adds one usage row to running totals. API usage adds USD (or sets `apiUnpriced` when the
 * price is unknown, never counting it as $0); subscription usage adds tokens and calls only,
 * its `estCostUsd` is informational and never counted.
 */
export function addUsage(t: UsageTotals | undefined, u: UsageRecorded): UsageTotals {
  const cur = t ?? EMPTY_USAGE_TOTALS;
  if (u.billing === 'api') {
    return {
      ...cur,
      apiUsd: cur.apiUsd + (u.costUsd ?? 0),
      apiUnpriced: cur.apiUnpriced || u.unpriced,
    };
  }
  return {
    ...cur,
    subscriptionTokens: addTokens(cur.subscriptionTokens, u.tokens),
    subscriptionCalls: cur.subscriptionCalls + u.calls,
  };
}
