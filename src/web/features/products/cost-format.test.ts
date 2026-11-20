import { describe, expect, it } from 'vitest';
import type { UsageTotals } from '../../../shared/state.ts';
import {
  budgetSummary,
  formatTokens,
  formatUsd,
  issueCostText,
  subscriptionText,
  totalTokens,
} from './cost-format.ts';

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  apiUsd: 0,
  apiUnpriced: false,
  subscriptionTokens: ZERO_TOKENS,
  subscriptionCalls: 0,
  ...over,
});

describe('formatUsd', () => {
  it('writes dollars with the US$ prefix and two decimals', () => {
    expect(formatUsd(4.1)).toBe('US$4.10');
    expect(formatUsd(0)).toBe('US$0.00');
    expect(formatUsd(1234.5)).toBe('US$1,234.50');
  });

  it('shows spend below one cent as less than a cent instead of zero', () => {
    expect(formatUsd(0.0004)).toBe('<US$0.01');
  });
});

describe('token counts', () => {
  it('sums the disjoint buckets', () => {
    expect(
      totalTokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5 }),
    ).toBe(105);
  });

  it('groups thousands', () => {
    expect(formatTokens(12345)).toBe('12,345 tokens');
    expect(formatTokens(1)).toBe('1 token');
  });
});

describe('budgetSummary', () => {
  it('gives spend, budget and percentage as text', () => {
    const s = budgetSummary(4.1, 10);
    expect(s.text).toBe('US$4.10 of US$10.00');
    expect(s.percent).toBe(41);
    expect(s.level).toBe('ok');
  });

  it('warns from 80 % and reports exhaustion at 100 %', () => {
    expect(budgetSummary(8, 10).level).toBe('warn');
    expect(budgetSummary(7.99, 10).level).toBe('ok');
    expect(budgetSummary(10, 10).level).toBe('exhausted');
  });

  it('keeps the true percentage above 100 %', () => {
    expect(budgetSummary(12, 10).percent).toBe(120);
  });

  it('has no percentage without a budget', () => {
    const s = budgetSummary(4.1, null);
    expect(s.text).toBe('US$4.10 spent, no budget set');
    expect(s.percent).toBeNull();
    expect(s.level).toBe('ok');
  });
});

describe('subscriptionText', () => {
  it('is null without subscription calls', () => {
    expect(subscriptionText(totals())).toBeNull();
  });

  it('gives tokens and calls', () => {
    expect(
      subscriptionText(
        totals({
          subscriptionTokens: { ...ZERO_TOKENS, input: 1000, output: 234 },
          subscriptionCalls: 3,
        }),
      ),
    ).toBe('1,234 tokens in 3 calls');
  });
});

describe('issueCostText', () => {
  it('is null when the issue has no usage', () => {
    expect(issueCostText(undefined)).toBeNull();
  });

  it('shows API spend', () => {
    expect(issueCostText(totals({ apiUsd: 0.42 }))).toBe('US$0.42');
  });

  it('marks unpriced usage', () => {
    expect(issueCostText(totals({ apiUsd: 0.42, apiUnpriced: true }))).toBe(
      'US$0.42 + unpriced usage',
    );
  });

  it('shows subscription usage as tokens and calls only', () => {
    expect(
      issueCostText(
        totals({ subscriptionTokens: { ...ZERO_TOKENS, output: 500 }, subscriptionCalls: 1 }),
      ),
    ).toBe('500 subscription tokens in 1 call');
  });

  it('joins API and subscription usage', () => {
    expect(
      issueCostText(
        totals({
          apiUsd: 1,
          subscriptionTokens: { ...ZERO_TOKENS, input: 2000 },
          subscriptionCalls: 2,
        }),
      ),
    ).toBe('US$1.00 · 2,000 subscription tokens in 2 calls');
  });
});
