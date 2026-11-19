import { z } from 'zod';
import { PriceSchema, priceKey, type Price, type PriceOverrides } from '../../shared/budget.ts';
import type { ModelRef, ProviderId } from '../../shared/models.ts';
import PRICES_JSON from './prices.json' with { type: 'json' };

const PriceTableSchema = z.object({
  source: z.url(),
  fetchedAt: z.iso.datetime(),
  /** provider → model id → price; regenerate with `node scripts/update-prices.mjs`. */
  providers: z.record(z.string(), z.record(z.string(), PriceSchema)),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** The checked-in models.dev snapshot, validated at load. */
export const PRICE_TABLE: PriceTable = PriceTableSchema.parse(PRICES_JSON);

/** Scripted fake and local OpenAI-compatible servers (Ollama) cost nothing. */
const FREE_PROVIDERS: ReadonlySet<ProviderId> = new Set(['fake', 'openai-compatible']);
const FREE: Price = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  webSearch: 0,
};

/** Provider-native web search, USD per call (ADR 10). models.dev does not list these. */
const WEB_SEARCH_USD: Partial<Record<ProviderId, number>> = { anthropic: 10 / 1000 };

/**
 * Price for `ref`: owner overrides first, then free providers, then the prices.json snapshot.
 * `undefined` means unknown: the caller records the usage as unpriced, never as $0.
 */
export function price(ref: ModelRef, overrides: PriceOverrides = {}): Price | undefined {
  const base =
    overrides[priceKey(ref)] ??
    (FREE_PROVIDERS.has(ref.provider) ? FREE : PRICE_TABLE.providers[ref.provider]?.[ref.model]);
  if (base === undefined) return undefined;
  const webSearch = base.webSearch ?? WEB_SEARCH_USD[ref.provider];
  return webSearch === undefined ? { ...base } : { ...base, webSearch };
}

const OpenRouterMetadataSchema = z.object({
  openrouter: z.object({ usage: z.object({ cost: z.number().min(0).finite() }) }),
});

/** OpenRouter's own `usage.cost` from AI SDK provider metadata, preferred over our computed cost. */
export function providerReportedCost(metadata: unknown): number | undefined {
  const parsed = OpenRouterMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.openrouter.usage.cost : undefined;
}
