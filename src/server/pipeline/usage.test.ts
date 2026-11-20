import { describe, expect, it } from 'vitest';
import type { StepUsage } from '../agents/index.ts';
import { usageCost } from './usage.ts';

const CLAUDE = { provider: 'claude-code', model: 'sonnet' } as const;
const PRICES = { 'claude-code/sonnet': { input: 3, output: 15 } };

const step: StepUsage = {
  input: 1_000_000,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  webSearches: 0,
  step: 1,
  providerMetadata: undefined,
};

describe('usageCost for the Claude Code subscription', () => {
  it('prefers the CLI-reported cost over the price table as the estimate', () => {
    const cost = usageCost(CLAUDE, { ...step, reportedEstCostUsd: 0.42 }, PRICES);

    expect(cost.estCostUsd).toBe(0.42);
    expect(cost.costUsd).toBeNull();
    expect(cost.billing).toBe('subscription');
    expect(cost.source).toBe('cli');
    expect(cost.unpriced).toBe(false);
  });

  it('uses the CLI-reported cost even when the model has no known price', () => {
    const cost = usageCost(CLAUDE, { ...step, reportedEstCostUsd: 1.5 }, {});

    expect(cost.estCostUsd).toBe(1.5);
    expect(cost.costUsd).toBeNull();
  });

  it('falls back to the price-table estimate when the CLI reported no cost', () => {
    expect(usageCost(CLAUDE, step, PRICES).estCostUsd).toBe(3);
  });

  it('counts the calls the step reports, defaulting to one', () => {
    expect(usageCost(CLAUDE, { ...step, calls: 7 }, PRICES).calls).toBe(7);
    expect(usageCost(CLAUDE, step, PRICES).calls).toBe(1);
  });

  it('never turns a reported estimate into API spend', () => {
    const cost = usageCost(
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { ...step, reportedEstCostUsd: 9 },
      { 'anthropic/claude-sonnet-4-5': { input: 3, output: 15 } },
    );

    expect(cost.billing).toBe('api');
    expect(cost.estCostUsd).toBeNull();
    expect(cost.costUsd).toBe(3);
  });
});
