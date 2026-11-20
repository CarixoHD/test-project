import { useCallback, useId } from 'react';
import { EMPTY_USAGE_TOTALS, type ProductState } from '../../../shared/state.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { budgetSummary, subscriptionText } from './cost-format.ts';

/**
 * API spend against the product budget, plus subscription usage in tokens and calls. All
 * figures are the server-computed usage totals in ClientState; nothing is priced here.
 */
export function CostBar({ product }: { product: ProductState }) {
  const select = useCallback((s: AppSnapshot) => s.state.usage.byProduct[product.id], [product.id]);
  const totals = useApp(select) ?? EMPTY_USAGE_TOTALS;
  const labelId = useId();
  const summary = budgetSummary(totals.apiUsd, product.settings.budgetUsd);
  const subscription = subscriptionText(totals);
  const percentText = summary.percent === null ? '' : `${String(summary.percent)}%`;
  const barValue = summary.percent === null ? 0 : Math.min(summary.percent, 100);

  return (
    <section className="build-tab__slot cost-bar" aria-label="Costs">
      <p className="cost-bar__line">
        <span id={labelId}>API spend</span> <span className="cost-bar__amount">{summary.text}</span>
        {summary.percent !== null && <span> ({percentText})</span>}
      </p>
      {summary.percent !== null && (
        <div
          className={`cost-bar__track cost-bar__track--${summary.level}`}
          role="progressbar"
          aria-labelledby={labelId}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={barValue}
          aria-valuetext={`${summary.text} (${percentText})`}
        >
          <div className="cost-bar__fill" style={{ width: `${String(barValue)}%` }} />
        </div>
      )}
      {summary.level === 'warn' && (
        <p className="cost-bar__alert">
          Warning: 80% of the budget is spent. The build pauses at 100%.
        </p>
      )}
      {summary.level === 'exhausted' && (
        <p className="cost-bar__alert">
          Budget reached: the build pauses once running agents finish their step.
        </p>
      )}
      {totals.apiUnpriced && (
        <p className="cost-bar__note">
          Includes unpriced usage: some calls used a model without a known price, so actual spend is
          higher.
        </p>
      )}
      {subscription !== null && (
        <p className="cost-bar__note">Subscription usage: {subscription}</p>
      )}
    </section>
  );
}
