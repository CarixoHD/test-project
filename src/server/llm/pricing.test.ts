import { describe, expect, it } from 'vitest';
import { priceKey, priceUsage, type Price, type PriceOverrides } from '../../shared/budget.ts';
import type { ModelRef } from '../../shared/models.ts';
import { price, PRICE_TABLE, providerReportedCost } from './index.ts';
import SNAPSHOT from './prices.json' with { type: 'json' };

const SONNET: ModelRef = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const GPT: ModelRef = { provider: 'openai', model: 'gpt-4o' };
const OVERRIDE: Price = { input: 1, output: 2 };
const FREE: Price = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  webSearch: 0,
};
const ANTHROPIC_SEARCH_USD = 10 / 1000;

function snapshotPrice(ref: ModelRef): unknown {
  const providers: Record<string, Record<string, unknown>> = SNAPSHOT.providers;
  return providers[ref.provider]?.[ref.model];
}

describe('prices.json snapshot', () => {
  it('records where and when it was fetched', () => {
    expect(PRICE_TABLE.source).toBe('https://models.dev/api.json');
    expect(Number.isNaN(Date.parse(PRICE_TABLE.fetchedAt))).toBe(false);
  });

  it.each(['anthropic', 'openai', 'google', 'openrouter'] as const)('has %s models', (p) => {
    expect(Object.keys(PRICE_TABLE.providers[p] ?? {}).length).toBeGreaterThan(0);
  });

  it('contains the models the table-driven cases rely on', () => {
    expect(snapshotPrice(SONNET)).toBeDefined();
    expect(snapshotPrice(GPT)).toBeDefined();
  });
});

describe('price(ref, overrides)', () => {
  const cases: [name: string, ref: ModelRef, overrides: PriceOverrides, expected: unknown][] = [
    [
      'anthropic from prices.json, with web search at $10/1k',
      SONNET,
      {},
      { ...(snapshotPrice(SONNET) as object), webSearch: ANTHROPIC_SEARCH_USD },
    ],
    ['openai from prices.json, no search price', GPT, {}, snapshotPrice(GPT)],
    [
      'override beats prices.json (anthropic keeps its search default)',
      SONNET,
      { [priceKey(SONNET)]: OVERRIDE },
      { ...OVERRIDE, webSearch: ANTHROPIC_SEARCH_USD },
    ],
    [
      'override with its own web search price wins completely',
      SONNET,
      { [priceKey(SONNET)]: { ...OVERRIDE, webSearch: 0.005 } },
      { ...OVERRIDE, webSearch: 0.005 },
    ],
    ['override beats prices.json (openai)', GPT, { [priceKey(GPT)]: OVERRIDE }, OVERRIDE],
    [
      'override prices a model missing from prices.json',
      { provider: 'openai', model: 'my-finetune' },
      { 'openai/my-finetune': OVERRIDE },
      OVERRIDE,
    ],
    [
      'override for another model does not apply',
      { provider: 'openai', model: 'no-such-model' },
      { [priceKey(GPT)]: OVERRIDE },
      undefined,
    ],
    ['unknown openai model', { provider: 'openai', model: 'no-such-model' }, {}, undefined],
    ['unknown google model', { provider: 'google', model: 'gemini-0' }, {}, undefined],
    [
      'unknown openrouter model',
      { provider: 'openrouter', model: 'nobody/nothing' },
      {},
      undefined,
    ],
    [
      'model id is looked up only under its own provider',
      { provider: 'openai', model: SONNET.model },
      {},
      undefined,
    ],
    [
      'claude-code subscription has no API price',
      { ...SONNET, provider: 'claude-code' },
      {},
      undefined,
    ],
    ['fake provider is free', { provider: 'fake', model: 'script' }, {}, FREE],
    [
      'local openai-compatible (ollama) is free',
      { provider: 'openai-compatible', model: 'llama3' },
      {},
      FREE,
    ],
    [
      'override can price an openai-compatible endpoint',
      { provider: 'openai-compatible', model: 'hosted' },
      { 'openai-compatible/hosted': OVERRIDE },
      OVERRIDE,
    ],
  ];
  it.each(cases)('%s', (_name, ref, overrides, expected) => {
    expect(price(ref, overrides)).toEqual(expected);
  });

  it('defaults to no overrides', () => {
    expect(price(GPT)).toEqual(snapshotPrice(GPT));
  });

  it('returns a copy callers cannot use to corrupt the table', () => {
    const first = price(GPT);
    if (first === undefined) throw new Error('expected a price');
    first.input = 999;
    expect(price(GPT)).toEqual(snapshotPrice(GPT));
  });
});

describe('price + priceUsage', () => {
  const NONE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, webSearches: 0 };

  it('unknown model → unpriced with usd null, never 0', () => {
    const r = priceUsage({ ...NONE, input: 10 }, price({ provider: 'openai', model: 'nope' }));
    expect(r).toEqual({ usd: null, unpriced: true });
  });

  it('1000 anthropic web searches cost $10', () => {
    const r = priceUsage({ ...NONE, webSearches: 1000 }, price(SONNET));
    expect(r.usd).toBeCloseTo(10, 10);
  });

  it('web searches on a model without a search price are unpriced', () => {
    expect(priceUsage({ ...NONE, webSearches: 1 }, price(GPT)).unpriced).toBe(true);
  });

  it('cache tokens are priced from the override', () => {
    const overrides = { [priceKey(GPT)]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } };
    const r = priceUsage({ ...NONE, cacheRead: 2e6, cacheWrite: 1e6 }, price(GPT, overrides));
    expect(r.usd).toBeCloseTo(0.2 + 1.5, 10);
  });
});

describe('providerReportedCost(metadata)', () => {
  const cases: [name: string, metadata: unknown, expected: number | undefined][] = [
    ['OpenRouter usage.cost', { openrouter: { usage: { cost: 0.0123, totalTokens: 9 } } }, 0.0123],
    ['zero cost is a real cost', { openrouter: { usage: { cost: 0 } } }, 0],
    ['no metadata', undefined, undefined],
    ['null metadata', null, undefined],
    ['other provider metadata', { anthropic: { cacheCreationInputTokens: 10 } }, undefined],
    ['OpenRouter without usage', { openrouter: { reasoningDetails: [] } }, undefined],
    ['OpenRouter usage without cost', { openrouter: { usage: { totalTokens: 9 } } }, undefined],
    ['non-numeric cost', { openrouter: { usage: { cost: '0.01' } } }, undefined],
    ['negative cost', { openrouter: { usage: { cost: -1 } } }, undefined],
    ['NaN cost', { openrouter: { usage: { cost: Number.NaN } } }, undefined],
  ];
  it.each(cases)('%s', (_name, metadata, expected) => {
    expect(providerReportedCost(metadata)).toBe(expected);
  });
});
