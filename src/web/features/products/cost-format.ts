import { budgetLevel, type BudgetLevel } from '../../../shared/budget.ts';
import type { TokenCounts, UsageTotals } from '../../../shared/state.ts';

// Wording for spend and usage. Every number comes from the ClientState usage totals the server
// computed; nothing here prices usage, it only formats and compares against the budget.

const USD = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `US$4.10`; positive spend that would round to zero reads `<US$0.01`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<US$0.01';
  return `US$${USD.format(usd)}`;
}

/** Usage buckets are disjoint, so the total is their sum. */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

const plural = (n: number, word: string) => `${COUNT.format(n)} ${word}${n === 1 ? '' : 's'}`;

export const formatTokens = (n: number): string => plural(n, 'token');

export interface BudgetSummary {
  /** `US$4.10 of US$10.00`, or `US$4.10 spent, no budget set`. */
  text: string;
  /** Whole percent of the budget spent (may exceed 100); null without a budget. */
  percent: number | null;
  level: BudgetLevel;
}

export function budgetSummary(spentUsd: number, budgetUsd: number | null): BudgetSummary {
  const level = budgetLevel(spentUsd, budgetUsd);
  if (budgetUsd === null) {
    return { text: `${formatUsd(spentUsd)} spent, no budget set`, percent: null, level };
  }
  return {
    text: `${formatUsd(spentUsd)} of ${formatUsd(budgetUsd)}`,
    percent: Math.round((spentUsd / budgetUsd) * 100),
    level,
  };
}

/** `1,234 tokens in 3 calls`; null when there was no subscription usage. */
export function subscriptionText(t: UsageTotals, tokenWord = 'token'): string | null {
  if (t.subscriptionCalls === 0) return null;
  const tokens = plural(totalTokens(t.subscriptionTokens), tokenWord);
  return `${tokens} in ${plural(t.subscriptionCalls, 'call')}`;
}

/** One line for an issue card, e.g. `US$0.42 + unpriced usage · 500 subscription tokens in 1 call`. */
export function issueCostText(t: UsageTotals | undefined): string | null {
  if (t === undefined) return null;
  const parts: string[] = [];
  if (t.apiUsd > 0 || t.apiUnpriced) {
    const usd = formatUsd(t.apiUsd);
    parts.push(t.apiUnpriced ? `${usd} + unpriced usage` : usd);
  }
  const sub = subscriptionText(t, 'subscription token');
  if (sub !== null) parts.push(sub);
  return parts.length === 0 ? null : parts.join(' · ');
}
