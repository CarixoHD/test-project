import { z } from 'zod';
import type { ModelRef } from './models.ts';

const UsdRate = z.number().min(0).finite();

/**
 * Model price. Token prices are USD per 1M tokens (models.dev convention); `webSearch` is USD
 * per search call. Missing cache prices fall back to `input`, a missing reasoning price to
 * `output`. A missing `webSearch` price leaves usage with searches unpriced.
 */
export const PriceSchema = z.strictObject({
  input: UsdRate,
  output: UsdRate,
  cacheRead: UsdRate.optional(),
  cacheWrite: UsdRate.optional(),
  reasoning: UsdRate.optional(),
  webSearch: UsdRate.optional(),
});
export type Price = z.infer<typeof PriceSchema>;

/** Owner price overrides from settings, keyed by `priceKey(ref)`. */
export const PriceOverridesSchema = z.record(z.string().min(1), PriceSchema);
export type PriceOverrides = z.infer<typeof PriceOverridesSchema>;

/** `provider/model`; unambiguous because provider ids contain no `/`. */
export function priceKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * Usage counts in disjoint buckets: `input` excludes cache reads/writes and `output` excludes
 * reasoning tokens. Callers split provider totals before pricing.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  webSearches: number;
}

export type PricedUsage = { usd: number; unpriced: false } | { usd: null; unpriced: true };

const UNPRICED: PricedUsage = { usd: null, unpriced: true };
const PER_MTOK = 1_000_000;

/** USD cost of `u` at price `p`. No price → unpriced (usd null), never $0. */
export function priceUsage(u: Usage, p: Price | undefined): PricedUsage {
  for (const [bucket, count] of Object.entries(u)) {
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`invalid usage count ${bucket}=${String(count)}`);
    }
  }
  if (p === undefined) return UNPRICED;
  if (u.webSearches > 0 && p.webSearch === undefined) return UNPRICED;
  const tokenUsd =
    u.input * p.input +
    u.output * p.output +
    u.cacheRead * (p.cacheRead ?? p.input) +
    u.cacheWrite * (p.cacheWrite ?? p.input) +
    u.reasoning * (p.reasoning ?? p.output);
  const searchUsd = u.webSearches * (p.webSearch ?? 0);
  return { usd: tokenUsd / PER_MTOK + searchUsd, unpriced: false };
}

export const BUDGET_LEVELS = ['ok', 'warn', 'exhausted'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/** Fraction of the budget at which the owner is warned (inclusive). */
export const BUDGET_WARN_RATIO = 0.8;
/** Absorbs float rounding in accumulated spend (a nano-dollar), so thresholds stay inclusive. */
const USD_EPSILON = 1e-9;

/** ok below 80 %, warn from 80 %, exhausted from 100 % (both inclusive). No budget → ok. */
export function budgetLevel(spentUsd: number, budgetUsd: number | null): BudgetLevel {
  if (budgetUsd === null) return 'ok';
  if (spentUsd >= budgetUsd - USD_EPSILON) return 'exhausted';
  if (spentUsd >= budgetUsd * BUDGET_WARN_RATIO - USD_EPSILON) return 'warn';
  return 'ok';
}
