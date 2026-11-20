import { priceUsage, type PriceOverrides, type Usage } from '../../shared/budget.ts';
import type { EventOf } from '../../shared/events.ts';
import type { ModelRef } from '../../shared/models.ts';
import type { StepUsage } from '../agents/index.ts';
import { capabilities, price, providerReportedCost } from '../llm/index.ts';

type UsageData = EventOf<'usage.recorded'>['data'];
/** The billing and cost part of a `usage.recorded` payload. */
export type UsageCost = Pick<
  UsageData,
  'billing' | 'tokens' | 'webSearches' | 'calls' | 'costUsd' | 'unpriced' | 'estCostUsd' | 'source'
>;

/**
 * Turns one step's usage into the cost fields of `usage.recorded` (ARCHITECTURE §4.7, §5).
 * API billing: the provider-reported cost (OpenRouter `usage.cost`) when present, else priced
 * from overrides / the price table; unknown prices are unpriced (costUsd null), never $0.
 * Subscription billing (Claude Code): no spend, only tokens, calls and an informational
 * estimate at API prices (null when the model has no known price).
 */
export function usageCost(model: ModelRef, u: StepUsage, overrides: PriceOverrides): UsageCost {
  const counts: Usage = {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    reasoning: u.reasoning,
    webSearches: u.webSearches,
  };
  const { webSearches, ...tokens } = counts;
  const base = { tokens, webSearches, calls: 1 };
  const priced = priceUsage(counts, price(model, overrides));
  if (capabilities(model).subscription) {
    return {
      ...base,
      billing: 'subscription',
      costUsd: null,
      unpriced: false,
      estCostUsd: priced.usd,
      source: 'cli',
    };
  }
  const reported = providerReportedCost(u.providerMetadata);
  if (reported !== undefined) {
    return {
      ...base,
      billing: 'api',
      costUsd: reported,
      unpriced: false,
      estCostUsd: null,
      source: 'provider',
    };
  }
  return {
    ...base,
    billing: 'api',
    costUsd: priced.usd,
    unpriced: priced.unpriced,
    estCostUsd: null,
    source: 'computed',
  };
}
