import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { AgentList } from './AgentList.tsx';
import { FakeEventSource } from './testing.ts';

// The list against the real store; only fetch and EventSource are faked at the global boundary.

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

const issueCreated = (n: number, title: string) =>
  event('issue.created', `i${String(n)}`, {
    issue: {
      id: `i${String(n)}`,
      number: n,
      title,
      body: '',
      status: 'in_progress',
      rev: 1,
      priority: 0,
      origin: 'orchestrator',
      prdVersion: 1,
      attemptCount: 1,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: [],
    },
  });

const spawned = (id: string, role: string, model: string, issueId: string | null = null) =>
  event('agent.spawned', id, {
    role,
    model: { provider: 'anthropic', model },
    issueId,
    attemptId: null,
  });

beforeEach(() => {
  seq = 0;
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

async function renderList(history: (() => Event)[]) {
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
        <AgentList product={product} />
      </AppStoreProvider>
    </MemoryRouter>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Delivers live events on the app's /api/events stream. */
function push(...events: Event[]): void {
  const stream = FakeEventSource.find('/api/events');
  act(() => {
    for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
  });
}

const items = () =>
  within(screen.getByRole('list', { name: 'Running agents' })).queryAllByRole('listitem');

describe('AgentList', () => {
  it('shows role, model, state, issue and last activity of each live agent', async () => {
    await renderList([
      () => issueCreated(3, 'Login form'),
      () => spawned('a1', 'orchestrator', 'gpt-5'),
      () => spawned('a2', 'implementer', 'claude-sonnet-4-5', 'i3'),
      () => event('agent.activity', 'a2', { lines: ['old line', 'editing src/login.ts'] }),
      () => spawned('a3', 'reviewer', 'claude-opus-4'),
      () => event('agent.exited', 'a3', { outcome: 'ok' }),
    ]);

    expect(items()).toHaveLength(2);
    const [foreman, builder] = items() as [HTMLElement, HTMLElement];
    expect(within(foreman).getByRole('heading', { name: 'Foreman (orchestrator)' })).toBeVisible();
    expect(foreman).toHaveTextContent('anthropic / gpt-5');
    expect(foreman).toHaveTextContent('Working');
    expect(foreman).toHaveTextContent('No issue');

    expect(within(builder).getByRole('heading', { name: 'Builder (implementer)' })).toBeVisible();
    expect(builder).toHaveTextContent('claude-sonnet-4-5');
    expect(within(builder).getByRole('link', { name: '#3 Login form' })).toHaveAttribute(
      'href',
      '/products/p1/issues/i3',
    );
    expect(builder).toHaveTextContent('editing src/login.ts');
    expect(screen.queryByText(/Inspector/)).not.toBeInTheDocument();
  });

  it('follows live events: new agents, state changes and exits', async () => {
    await renderList([]);
    expect(screen.getByText('No agents are running.')).toBeVisible();

    push(spawned('a1', 'implementer', 'claude-sonnet-4-5'));
    expect(items()).toHaveLength(1);

    push(event('agent.state', 'a1', { state: 'rate_limited', until: T0 + 3_600_000 }));
    expect(items()[0]).toHaveTextContent(/Rate limited until \S+/);

    push(event('agent.state', 'a1', { state: 'waiting_owner', until: null }));
    expect(items()[0]).toHaveTextContent('Waiting for owner');

    push(event('agent.exited', 'a1', { outcome: 'ok' }));
    expect(screen.getByText('No agents are running.')).toBeVisible();
  });

  it('opens the agent panel from the keyboard', async () => {
    await renderList([() => spawned('a1', 'implementer', 'claude-sonnet-4-5')]);
    const user = userEvent.setup();

    const button = screen.getByRole('button', { name: 'Show log of Builder (implementer)' });
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');

    const dialog = screen.getByRole('dialog', { name: 'Builder (implementer)' });
    expect(dialog).toHaveTextContent('anthropic / claude-sonnet-4-5');
    expect(FakeEventSource.find('/api/agents/a1/log?follow=1')).toBeDefined();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});
