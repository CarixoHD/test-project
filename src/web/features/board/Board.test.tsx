import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueStatus } from '../../../shared/domain.ts';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { ANNOUNCE_DELAY_MS, Board } from './Board.tsx';

// The board against the real store; only the network (fetch + EventSource) is faked at the
// global boundary, so SSE events drive the cards exactly as in the browser.

class FakeEventSource {
  static readonly CLOSED = 2;
  static latest: FakeEventSource | null = null;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
  }
  close(): void {
    this.readyState = 2;
  }
}

const P = ProductIdSchema.parse('p1');
const T0 = 1_700_000_000_000;
let seq = 0;

const event = (type: string, entityId: string | null, data: unknown): Event => {
  seq += 1;
  return EventSchema.parse({ seq, ts: T0 + seq, type, productId: P, entityId, v: 1, data });
};

const productCreated = () =>
  event('product.created', null, {
    name: 'Todo app',
    idea: 'Track todos',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  });

type IssueFixture = {
  n: number;
  title?: string;
  status?: IssueStatus;
  priority?: number;
  attemptCount?: number;
  dependsOn?: number[];
};

const issueCreated = ({ n, title, status, priority, attemptCount, dependsOn }: IssueFixture) =>
  event('issue.created', `i${String(n)}`, {
    issue: {
      id: `i${String(n)}`,
      number: n,
      title: title ?? `Issue ${String(n)}`,
      body: '',
      status: status ?? 'open',
      rev: 1,
      priority: priority ?? 0,
      origin: 'orchestrator',
      prdVersion: 1,
      attemptCount: attemptCount ?? 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: (dependsOn ?? []).map((d) => `i${String(d)}`),
    },
  });

const statusChanged = (n: number, from: IssueStatus, to: IssueStatus, attemptCount = 0) =>
  event('issue.status_changed', `i${String(n)}`, { from, to, attemptCount, runAfter: 0 });

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** One usage row for issue `n`: API spend in USD (null = unpriced) or subscription tokens. */
const usageRecorded = (
  n: number,
  usage: { costUsd: number | null } | { subscriptionTokens: number; calls: number },
) =>
  event('usage.recorded', `u${String(seq + 1)}`, {
    agentId: 'a1',
    role: 'implementer',
    issueId: `i${String(n)}`,
    attemptId: null,
    webSearches: 0,
    estCostUsd: null,
    ...('costUsd' in usage
      ? {
          model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          billing: 'api',
          tokens: { ...ZERO_TOKENS, input: 100 },
          calls: 1,
          costUsd: usage.costUsd,
          unpriced: usage.costUsd === null,
          source: 'computed',
        }
      : {
          model: { provider: 'claude-code', model: 'sonnet' },
          billing: 'subscription',
          tokens: { ...ZERO_TOKENS, output: usage.subscriptionTokens },
          calls: usage.calls,
          costUsd: null,
          unpriced: false,
          source: 'cli',
        }),
  });

const held = (n: number) => event('issue.held', `i${String(n)}`, { questionId: 'q1' });

beforeEach(() => {
  seq = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the board over a snapshot built from product.created plus `history`. */
async function renderBoard(history: (() => Event)[] = []) {
  let state: ClientState = reduce(emptyState, productCreated());
  for (const make of history) state = reduce(state, make());
  const snapshot = { state, lastSeq: seq };
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(snapshot))),
  );
  const product = state.products[P] as ProductState;
  render(
    <MemoryRouter>
      <AppStoreProvider store={createAppStore()}>
        <Board product={product} />
      </AppStoreProvider>
    </MemoryRouter>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Delivers live events as the server would over SSE. */
function push(...events: Event[]): void {
  const stream = FakeEventSource.latest;
  if (stream === null) throw new Error('no stream');
  act(() => {
    for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
  });
}

const column = (name: string) => screen.getByRole('list', { name });
const cardTitles = (name: string) =>
  within(column(name))
    .queryAllByRole('link')
    .map((a) => a.textContent);
const card = (title: string) =>
  screen.getByRole('link', { name: title }).closest('li') as HTMLElement;
const announcer = () => screen.getByTestId('board-announcer');

describe('Board', () => {
  it('renders the six columns with each issue in the column of its status', async () => {
    await renderBoard([
      () => issueCreated({ n: 1, title: 'Set up repo', status: 'completed' }),
      () => issueCreated({ n: 2, title: 'Login form', status: 'in_progress' }),
      () => issueCreated({ n: 3, title: 'Logout' }),
      () => issueCreated({ n: 4, title: 'Urgent fix', priority: 5 }),
      () => issueCreated({ n: 5, title: 'Old idea', status: 'cancelled' }),
    ]);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Open (2)',
      'In progress (1)',
      'In review (0)',
      'Completed (1)',
      'Failed (0)',
      'Cancelled (1)',
    ]);
    expect(cardTitles('Open')).toEqual(['#4 Urgent fix', '#3 Logout']);
    expect(cardTitles('In progress')).toEqual(['#2 Login form']);
    expect(cardTitles('In review')).toEqual([]);
    expect(cardTitles('Completed')).toEqual(['#1 Set up repo']);
    expect(cardTitles('Cancelled')).toEqual(['#5 Old idea']);
  });

  it('collapses the cancelled column by default', async () => {
    await renderBoard([() => issueCreated({ n: 1, status: 'cancelled' })]);
    const details = column('Cancelled').closest('details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(column('Open').closest('details')).toBeNull();
  });

  it('shows status as text, priority, attempts and a link to the issue detail', async () => {
    await renderBoard([
      () =>
        issueCreated({ n: 7, title: 'Search', status: 'in_review', priority: 2, attemptCount: 1 }),
    ]);
    const c = card('#7 Search');
    expect(within(c).getByText('In review')).toBeInTheDocument();
    expect(c).toHaveTextContent('Priority 2');
    expect(c).toHaveTextContent('Attempt 1 of 3');
    expect(screen.getByRole('link', { name: '#7 Search' })).toHaveAttribute(
      'href',
      `/products/${P}/issues/i7`,
    );
  });

  it('shows "blocked by" only for dependencies that are not completed', async () => {
    await renderBoard([
      () => issueCreated({ n: 1, status: 'completed' }),
      () => issueCreated({ n: 2, status: 'in_progress' }),
      () => issueCreated({ n: 3, title: 'Needs both', dependsOn: [1, 2] }),
    ]);
    const c = card('#3 Needs both');
    expect(c).toHaveTextContent('Blocked by #2');
    expect(c).not.toHaveTextContent('#1');
  });

  it('marks held issues as waiting for the owner, live', async () => {
    await renderBoard([() => issueCreated({ n: 1, title: 'Pick a colour' })]);
    expect(card('#1 Pick a colour')).not.toHaveTextContent('Waiting for owner');
    push(held(1));
    expect(card('#1 Pick a colour')).toHaveTextContent('Waiting for owner');
  });

  it('shows each issue its own cost from the usage totals, live', async () => {
    await renderBoard([
      () => issueCreated({ n: 1, title: 'Paid' }),
      () => issueCreated({ n: 2, title: 'Subscription' }),
      () => issueCreated({ n: 3, title: 'Untouched' }),
      () => usageRecorded(1, { costUsd: 0.3 }),
      () => usageRecorded(2, { subscriptionTokens: 1500, calls: 2 }),
    ]);
    expect(card('#1 Paid')).toHaveTextContent('Cost: US$0.30');
    expect(card('#2 Subscription')).toHaveTextContent('Cost: 1,500 subscription tokens in 2 calls');
    expect(card('#2 Subscription')).not.toHaveTextContent('US$');
    expect(card('#3 Untouched')).not.toHaveTextContent('Cost:');

    push(usageRecorded(1, { costUsd: 0.12 }), usageRecorded(1, { costUsd: null }));
    expect(card('#1 Paid')).toHaveTextContent('Cost: US$0.42 + unpriced usage');
  });

  it('moves a card when issue.status_changed arrives', async () => {
    await renderBoard([() => issueCreated({ n: 1, title: 'Login form' })]);
    expect(cardTitles('Open')).toEqual(['#1 Login form']);

    push(statusChanged(1, 'open', 'in_progress', 1));

    expect(cardTitles('Open')).toEqual([]);
    expect(cardTitles('In progress')).toEqual(['#1 Login form']);
    expect(within(card('#1 Login form')).getByText('In progress')).toBeInTheDocument();
    expect(card('#1 Login form')).toHaveTextContent('Attempt 1 of 3');
  });

  it('shows new issues as they are created', async () => {
    await renderBoard();
    push(issueCreated({ n: 1, title: 'Fresh' }));
    expect(cardTitles('Open')).toEqual(['#1 Fresh']);
  });

  it('puts cards in DOM order as links, so Tab walks the board column by column', async () => {
    await renderBoard([
      () => issueCreated({ n: 1, title: 'A', status: 'in_progress' }),
      () => issueCreated({ n: 2, title: 'B' }),
    ]);
    const user = userEvent.setup();
    const order = [
      screen.getByRole('button', { name: 'Add issue' }),
      screen.getByRole('link', { name: '#2 B' }),
      screen.getByRole('button', { name: 'Edit issue #2' }),
      screen.getByRole('button', { name: 'Cancel issue #2' }),
      screen.getByRole('link', { name: '#1 A' }),
      screen.getByRole('button', { name: 'Edit issue #1' }),
      screen.getByRole('button', { name: 'Cancel issue #1' }),
    ];
    for (const el of order) {
      await user.tab();
      expect(el).toHaveFocus();
    }
  });
});

describe('Board status announcements', () => {
  it('is a polite live region that stays quiet for the initial snapshot', async () => {
    await renderBoard([() => issueCreated({ n: 1, status: 'completed' })]);
    expect(announcer()).toHaveAttribute('aria-live', 'polite');
    expect(announcer()).toHaveTextContent('');
  });

  it('announces a status change once the burst settles', async () => {
    await renderBoard([() => issueCreated({ n: 1, title: 'Login form' })]);
    vi.useFakeTimers();
    push(statusChanged(1, 'open', 'in_progress', 1));
    expect(announcer()).toHaveTextContent('');
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announcer()).toHaveTextContent('#1 Login form is now In progress.');
  });

  it('coalesces a burst into one message with the latest status of each issue', async () => {
    await renderBoard([
      () => issueCreated({ n: 1, title: 'Login form' }),
      () => issueCreated({ n: 2, title: 'Logout', status: 'in_progress' }),
    ]);
    vi.useFakeTimers();
    push(statusChanged(1, 'open', 'in_progress', 1));
    push(statusChanged(1, 'in_progress', 'in_review', 1));
    push(statusChanged(2, 'in_progress', 'open', 1));
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announcer().textContent).toBe('#1 Login form is now In review. #2 Logout is now Open.');
  });

  it('summarises a large burst as a count instead of flooding', async () => {
    await renderBoard([1, 2, 3, 4, 5].map((n) => () => issueCreated({ n })));
    vi.useFakeTimers();
    for (const n of [1, 2, 3, 4, 5]) push(statusChanged(n, 'open', 'in_progress', 1));
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announcer().textContent).toBe('5 issues changed status.');
  });

  it('starts a new message for changes after the previous one was announced', async () => {
    await renderBoard([() => issueCreated({ n: 1, title: 'Login form' })]);
    vi.useFakeTimers();
    push(statusChanged(1, 'open', 'in_progress', 1));
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    push(statusChanged(1, 'in_progress', 'in_review', 1));
    act(() => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
    expect(announcer().textContent).toBe('#1 Login form is now In review.');
  });
});
