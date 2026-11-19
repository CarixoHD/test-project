import { describe, expect, it } from 'vitest';
import {
  budgetLevel,
  PriceOverridesSchema,
  PriceSchema,
  priceKey,
  priceUsage,
  type BudgetLevel,
  type Price,
  type Usage,
} from './budget.ts';

const NONE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  webSearches: 0,
};
const usage = (u: Partial<Usage>): Usage => ({ ...NONE, ...u });

/** Sonnet-like price: USD per 1M tokens, web search per call. */
const FULL: Price = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  reasoning: 20,
  webSearch: 0.01,
};
/** Only the two mandatory fields. */
const BARE: Price = { input: 2, output: 8 };
const FREE: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, webSearch: 0 };

describe('priceUsage', () => {
  const priced: [name: string, u: Usage, p: Price, usd: number][] = [
    ['nothing used costs $0', NONE, FULL, 0],
    ['input tokens', usage({ input: 1_000_000 }), FULL, 3],
    ['output tokens', usage({ output: 2_000_000 }), FULL, 30],
    ['cache read tokens at the cache read price', usage({ cacheRead: 1_000_000 }), FULL, 0.3],
    ['cache write tokens at the cache write price', usage({ cacheWrite: 1_000_000 }), FULL, 3.75],
    ['reasoning tokens at the reasoning price', usage({ reasoning: 1_000_000 }), FULL, 20],
    ['web searches per call', usage({ webSearches: 3 }), FULL, 0.03],
    [
      'all buckets add up',
      usage({
        input: 10_000,
        output: 2_000,
        cacheRead: 50_000,
        cacheWrite: 4_000,
        reasoning: 1_000,
        webSearches: 2,
      }),
      FULL,
      0.03 + 0.03 + 0.015 + 0.015 + 0.02 + 0.02,
    ],
    ['cache read falls back to the input price', usage({ cacheRead: 1_000_000 }), BARE, 2],
    ['cache write falls back to the input price', usage({ cacheWrite: 1_000_000 }), BARE, 2],
    ['reasoning falls back to the output price', usage({ reasoning: 1_000_000 }), BARE, 8],
    ['no searches needs no search price', usage({ input: 500_000 }), BARE, 1],
    [
      'a free model (fake, ollama) is priced at $0',
      usage({ input: 9e6, output: 9e6, webSearches: 9 }),
      FREE,
      0,
    ],
  ];
  it.each(priced)('%s', (_name, u, p, usd) => {
    const r = priceUsage(u, p);
    expect(r.unpriced).toBe(false);
    expect(r.usd).not.toBeNull();
    expect(r.usd).toBeCloseTo(usd, 10);
  });

  const unpriced: [name: string, u: Usage, p: Price | undefined][] = [
    ['unknown model (no price)', usage({ input: 1000, output: 1000 }), undefined],
    ['unknown model with no usage is still unpriced, not $0', NONE, undefined],
    ['web searches without a search price', usage({ input: 1000, webSearches: 1 }), BARE],
  ];
  it.each(unpriced)('%s → unpriced, usd null (never 0)', (_name, u, p) => {
    expect(priceUsage(u, p)).toEqual({ usd: null, unpriced: true });
  });

  const invalid: [name: string, u: Usage][] = [
    ['negative tokens', usage({ input: -1 })],
    ['NaN tokens', usage({ output: Number.NaN })],
    ['infinite searches', usage({ webSearches: Number.POSITIVE_INFINITY })],
  ];
  it.each(invalid)('throws on %s (programmer error)', (_name, u) => {
    expect(() => priceUsage(u, FULL)).toThrow(/usage/i);
  });
});

describe('budgetLevel', () => {
  const cases: [spentUsd: number, budgetUsd: number | null, level: BudgetLevel][] = [
    [0, null, 'ok'],
    [1_000_000, null, 'ok'],
    [0, 20, 'ok'],
    [15.99, 20, 'ok'],
    [16, 20, 'warn'], // exactly 80 %
    [19.99, 20, 'warn'],
    [20, 20, 'exhausted'], // exactly 100 %
    [25, 20, 'exhausted'],
    [0.07999, 0.1, 'ok'],
    [0.08, 0.1, 'warn'], // exactly 80 % where 0.8 * 0.1 !== 0.08 in floating point
    [0.1, 0.1, 'exhausted'],
    [0.72, 0.9, 'warn'], // exactly 80 %, float rounding
    [2.4, 3, 'warn'], // exactly 80 %, float rounding
    [0.1 + 0.2, 0.3, 'exhausted'], // accumulated float sum just above the budget
    [0.3, 0.1 + 0.2, 'exhausted'], // accumulated float sum just below the budget
    [0.8, 1, 'warn'],
    [1, 1, 'exhausted'],
    [0, 0, 'exhausted'], // a $0 budget allows no spend
  ];
  it.each(cases)('spent %d of budget %s → %s', (spent, budget, level) => {
    expect(budgetLevel(spent, budget)).toBe(level);
  });
});

describe('PriceSchema / PriceOverridesSchema', () => {
  it('accepts a full and a minimal price', () => {
    expect(PriceSchema.parse(FULL)).toEqual(FULL);
    expect(PriceSchema.parse(BARE)).toEqual(BARE);
  });

  const invalid: [name: string, value: unknown][] = [
    ['missing output', { input: 1 }],
    ['negative input', { input: -1, output: 1 }],
    ['string price', { input: '1', output: 1 }],
    ['infinite price', { input: Number.POSITIVE_INFINITY, output: 1 }],
    ['unknown field', { input: 1, output: 1, extra: 1 }],
  ];
  it.each(invalid)('rejects %s', (_name, value) => {
    expect(PriceSchema.safeParse(value).success).toBe(false);
  });

  it('keys overrides by provider/model', () => {
    const overrides = PriceOverridesSchema.parse({
      [priceKey({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' })]: BARE,
    });
    expect(Object.keys(overrides)).toEqual(['openrouter/anthropic/claude-sonnet-4.5']);
  });
});
