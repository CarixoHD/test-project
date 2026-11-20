import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { CostBar } from './CostBar.tsx';

// CostBar against the real store; state fixtures are built by reducing real events, so the
// totals shown are exactly the ones the shared reducer computes.

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  close(): void {
    this.readyState = 2;
  }
}

const P = ProductIdSchema.parse('p1');
let seq = 0;
const event = (type: string, entityId: string | null, data: unknown): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    productId: P,
    entityId,
    v: 1,
    data,
  });
};

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

const created = (budgetUsd: number | null) =>
  event('product.created', null, {
    name: 'Todo app',
    idea: 'Track todos',
    budgetUsd,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  });

const apiUsage = (costUsd: number | null) =>
  event('usage.recorded', `u${String(seq + 1)}`, {
    agentId: 'a1',
    role: 'implementer',
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    issueId: null,
    attemptId: null,
    billing: 'api',
    tokens: { ...ZERO_TOKENS, input: 1000, output: 200 },
    webSearches: 0,
    calls: 1,
    costUsd,
    unpriced: costUsd === null,
    estCostUsd: null,
    source: 'computed',
  });

const subscriptionUsage = (calls: number, tokens: typeof ZERO_TOKENS) =>
  event('usage.recorded', `u${String(seq + 1)}`, {
    agentId: 'a1',
    role: 'implementer',
    model: { provider: 'claude-code', model: 'sonnet' },
    issueId: null,
    attemptId: null,
    billing: 'subscription',
    tokens,
    webSearches: 0,
    calls,
    costUsd: null,
    unpriced: false,
    // Informational only: must never show up as spend.
    estCostUsd: 3.33,
    source: 'cli',
  });

const fixture = (...events: Event[]): ClientState => events.reduce(reduce, emptyState);

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

async function renderCostBar(state: ClientState) {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ state, lastSeq: state.lastSeq }))),
  );
  render(
    <AppStoreProvider store={createAppStore()}>
      <CostBar product={state.products[P] as ProductState} />
    </AppStoreProvider>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return screen.getByRole('region', { name: 'Costs' });
}

describe('CostBar', () => {
  it('shows spend, budget and percentage as text with a progressbar', async () => {
    const region = await renderCostBar(fixture(created(10), apiUsage(2.6), apiUsage(1.5)));
    const bar = within(region).getByRole('progressbar', { name: 'API spend' });
    expect(bar).toHaveAttribute('aria-valuenow', '41');
    expect(bar).toHaveAttribute('aria-valuetext', 'US$4.10 of US$10.00 (41%)');
    expect(region).toHaveTextContent('US$4.10 of US$10.00');
    expect(region).toHaveTextContent('41%');
    expect(within(region).queryByText(/warning/i)).not.toBeInTheDocument();
  });

  it('warns at 80 % of the budget', async () => {
    const region = await renderCostBar(fixture(created(10), apiUsage(8)));
    expect(region).toHaveTextContent('80%');
    expect(within(region).getByText(/Warning: 80% of the budget is spent/)).toBeInTheDocument();
  });

  it('says the build pauses once the budget is reached, capping the bar at 100', async () => {
    const region = await renderCostBar(fixture(created(10), apiUsage(12)));
    expect(region).toHaveTextContent('US$12.00 of US$10.00');
    expect(region).toHaveTextContent('120%');
    expect(within(region).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(within(region).getByText(/Budget reached/)).toBeInTheDocument();
  });

  it('shows spend without a percentage when no budget is set', async () => {
    const region = await renderCostBar(fixture(created(null), apiUsage(4.1)));
    expect(region).toHaveTextContent('US$4.10 spent, no budget set');
    expect(within(region).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('notes unpriced usage separately from the dollar figure', async () => {
    const region = await renderCostBar(fixture(created(10), apiUsage(1), apiUsage(null)));
    expect(region).toHaveTextContent('US$1.00 of US$10.00');
    const notice = within(region).getByText(/includes unpriced usage/i);
    expect(notice).not.toHaveTextContent('US$');
  });

  it('shows subscription-only usage as tokens and calls, never as spend', async () => {
    const region = await renderCostBar(
      fixture(
        created(null),
        subscriptionUsage(2, { ...ZERO_TOKENS, input: 1000, output: 500 }),
        subscriptionUsage(1, { ...ZERO_TOKENS, cacheRead: 734 }),
      ),
    );
    expect(region).toHaveTextContent('US$0.00 spent, no budget set');
    expect(
      within(region).getByText('Subscription usage: 2,234 tokens in 3 calls'),
    ).toBeInTheDocument();
    expect(region).not.toHaveTextContent('3.33');
    expect(within(region).queryByText(/unpriced/i)).not.toBeInTheDocument();
  });

  it('shows no spend before any usage is recorded', async () => {
    const region = await renderCostBar(fixture(created(10)));
    expect(region).toHaveTextContent('US$0.00 of US$10.00');
    expect(region).toHaveTextContent('0%');
    expect(within(region).queryByText(/Subscription usage/)).not.toBeInTheDocument();
  });
});
