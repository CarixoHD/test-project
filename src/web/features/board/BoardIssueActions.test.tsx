import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueStatus } from '../../../shared/domain.ts';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { Board } from './Board.tsx';

// Owner issue actions on the board. The real store and dialogs run; only the network is faked
// at the global boundary: fetch answers per route, and SSE events are pushed by hand.

class FakeEventSource {
  static readonly CLOSED = 2;
  static latest: FakeEventSource | null = null;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
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

const issueCreated = (n: number, title: string, status: IssueStatus = 'open', priority = 0) =>
  event('issue.created', `i${String(n)}`, {
    issue: {
      id: `i${String(n)}`,
      number: n,
      title,
      body: `Body of ${title}`,
      status,
      rev: 1,
      priority,
      origin: 'orchestrator',
      prdVersion: 1,
      attemptCount: 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: [],
    },
  });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Route = (call: Call) => Response;

let calls: Call[] = [];
let routes: Record<string, Route> = {};

function stubNetwork(snapshot: { state: ClientState; lastSeq: number }): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/api/state') return Promise.resolve(Response.json(snapshot));
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      const route = routes[`${call.method} ${url}`];
      if (route === undefined) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(route(call));
    }),
  );
}

async function renderBoard(history: (() => Event)[]) {
  let state: ClientState = reduce(emptyState, productCreated());
  for (const make of history) state = reduce(state, make());
  stubNetwork({ state, lastSeq: seq });
  render(
    <MemoryRouter>
      <AppStoreProvider store={createAppStore()}>
        <Board product={state.products[P] as ProductState} />
      </AppStoreProvider>
    </MemoryRouter>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return userEvent.setup({ delay: null });
}

function push(...events: Event[]): void {
  const stream = FakeEventSource.latest;
  if (stream === null) throw new Error('no stream');
  act(() => {
    for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
  });
}

beforeEach(() => {
  seq = 0;
  routes = {};
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

describe('Board: add issue', () => {
  it('adds an issue with title, body, priority and dependencies, by keyboard', async () => {
    const user = await renderBoard([
      () => issueCreated(1, 'Login'),
      () => issueCreated(2, 'Logout'),
    ]);
    routes['POST /api/products/p1/issues'] = () =>
      Response.json({ ok: true, issueId: 'i3', number: 3 });

    screen.getByRole('button', { name: 'Add issue' }).focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Add issue' });
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveFocus();
    await user.keyboard('Dark mode');
    await user.tab();
    expect(within(dialog).getByRole('textbox', { name: /Body/ })).toHaveFocus();
    await user.keyboard('Respect the **OS** setting');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Priority' }), 'High');
    await user.selectOptions(within(dialog).getByRole('listbox', { name: 'Depends on' }), [
      '#1 Login',
      '#2 Logout',
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Create issue' }));

    expect(calls).toEqual([
      {
        url: '/api/products/p1/issues',
        method: 'POST',
        body: {
          title: 'Dark mode',
          body: 'Respect the **OS** setting',
          priority: 1,
          dependsOn: ['i1', 'i2'],
        },
      },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires a title and does not call the server without one', async () => {
    const user = await renderBoard([]);
    await user.click(screen.getByRole('button', { name: 'Add issue' }));
    const dialog = screen.getByRole('dialog', { name: 'Add issue' });
    await user.click(within(dialog).getByRole('button', { name: 'Create issue' }));
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(dialog).getByText('Title is required')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('offers only issues that are not cancelled as dependencies', async () => {
    const user = await renderBoard([
      () => issueCreated(1, 'Login'),
      () => issueCreated(2, 'Dropped', 'cancelled'),
    ]);
    await user.click(screen.getByRole('button', { name: 'Add issue' }));
    const deps = within(screen.getByRole('dialog')).getByRole('listbox', { name: 'Depends on' });
    expect(
      within(deps)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['#1 Login']);
  });

  it('keeps the dialog open and shows the server error when adding fails', async () => {
    const user = await renderBoard([]);
    routes['POST /api/products/p1/issues'] = () =>
      Response.json(
        { error: { code: 'bad_request', message: 'Dependency cycle: #1 → #2' } },
        { status: 400 },
      );
    await user.click(screen.getByRole('button', { name: 'Add issue' }));
    const dialog = screen.getByRole('dialog', { name: 'Add issue' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'X');
    await user.click(within(dialog).getByRole('button', { name: 'Create issue' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Dependency cycle: #1 → #2');
  });
});

describe('Board: edit issue', () => {
  it('has Edit and Cancel buttons named after the issue number', async () => {
    await renderBoard([
      () => issueCreated(4, 'Search'),
      () => issueCreated(5, 'Done', 'completed'),
    ]);
    expect(screen.getByRole('button', { name: 'Edit issue #4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel issue #4' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit issue #5' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel issue #5' })).not.toBeInTheDocument();
  });

  it('edits title and body and sends the rev the edit is based on', async () => {
    const user = await renderBoard([() => issueCreated(1, 'Login')]);
    routes['PATCH /api/issues/i1'] = () => Response.json({ ok: true, rev: 2 });

    screen.getByRole('button', { name: 'Edit issue #1' }).focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Edit issue #1' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Login');
    expect(within(dialog).getByRole('textbox', { name: /Body/ })).toHaveValue('Body of Login');
    await user.clear(title);
    await user.type(title, 'Login with email');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(calls).toEqual([
      {
        url: '/api/issues/i1',
        method: 'PATCH',
        body: { title: 'Login with email', body: 'Body of Login', dependsOn: [], rev: 1 },
      },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the current priority and sends the changed priority', async () => {
    const user = await renderBoard([() => issueCreated(1, 'Login', 'open', 1)]);
    routes['PATCH /api/issues/i1'] = () => Response.json({ ok: true, rev: 2 });

    await user.click(screen.getByRole('button', { name: 'Edit issue #1' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit issue #1' });
    const priority = within(dialog).getByRole('combobox', { name: 'Priority' });
    expect(priority).toHaveDisplayValue('High');
    await user.selectOptions(priority, 'Urgent');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(calls).toEqual([
      {
        url: '/api/issues/i1',
        method: 'PATCH',
        body: { title: 'Login', body: 'Body of Login', dependsOn: [], priority: 2, rev: 1 },
      },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a priority outside the usual choices selectable and unsent when unchanged', async () => {
    const user = await renderBoard([() => issueCreated(1, 'Login', 'open', 5)]);
    routes['PATCH /api/issues/i1'] = () => Response.json({ ok: true, rev: 2 });

    await user.click(screen.getByRole('button', { name: 'Edit issue #1' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit issue #1' });
    expect(within(dialog).getByRole('combobox', { name: 'Priority' })).toHaveValue('5');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(calls.map((c) => c.body)).toEqual([
      { title: 'Login', body: 'Body of Login', dependsOn: [], rev: 1 },
    ]);
  });

  it('on a stale rev shows an actionable message with the fresh values and retries on them', async () => {
    const user = await renderBoard([() => issueCreated(1, 'Login')]);
    routes['PATCH /api/issues/i1'] = (call) =>
      (call.body as { rev: number }).rev === 1
        ? Response.json(
            { error: { code: 'conflict', message: 'Issue i1 is at rev 2, not 1' } },
            { status: 409 },
          )
        : Response.json({ ok: true, rev: 3 });

    await user.click(screen.getByRole('button', { name: 'Edit issue #1' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit issue #1' });
    // Someone else edits the issue while the owner is typing.
    push(event('issue.edited', 'i1', { rev: 2, title: 'Login via SSO', body: 'Use OIDC' }));
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Login');
    await user.clear(title);
    await user.type(title, 'Login with email');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'This issue changed meanwhile — reload and retry',
    );
    const latest = within(dialog).getByRole('region', { name: 'Latest version' });
    expect(latest).toHaveTextContent('Login via SSO');
    expect(latest).toHaveTextContent('Use OIDC');

    await user.click(within(dialog).getByRole('button', { name: 'Reload latest version' }));
    expect(title).toHaveValue('Login via SSO');
    expect(within(dialog).getByRole('textbox', { name: /Body/ })).toHaveValue('Use OIDC');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();

    await user.type(title, ' and email');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(calls.at(-1)?.body).toEqual({
      title: 'Login via SSO and email',
      body: 'Use OIDC',
      dependsOn: [],
      rev: 2,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not offer the issue itself as its own dependency', async () => {
    const user = await renderBoard([
      () => issueCreated(1, 'Login'),
      () => issueCreated(2, 'Logout'),
    ]);
    await user.click(screen.getByRole('button', { name: 'Edit issue #2' }));
    const deps = within(screen.getByRole('dialog')).getByRole('listbox', { name: 'Depends on' });
    expect(
      within(deps)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['#1 Login']);
  });
});

describe('Board: cancel issue', () => {
  it('asks for confirmation and only cancels when confirmed', async () => {
    const user = await renderBoard([() => issueCreated(3, 'Old idea')]);
    routes['POST /api/issues/i3/cancel'] = () => Response.json({ ok: true });
    const opener = screen.getByRole('button', { name: 'Cancel issue #3' });

    await user.click(opener);
    let dialog = screen.getByRole('dialog', { name: 'Cancel issue #3?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep issue' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls).toEqual([]);

    opener.focus();
    await user.keyboard('{Enter}');
    dialog = screen.getByRole('dialog', { name: 'Cancel issue #3?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel issue' }));
    expect(calls).toEqual([{ url: '/api/issues/i3/cancel', method: 'POST', body: undefined }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the server reason when cancelling fails', async () => {
    const user = await renderBoard([() => issueCreated(3, 'Old idea')]);
    routes['POST /api/issues/i3/cancel'] = () =>
      Response.json(
        { error: { code: 'conflict', message: 'Issue #3 is already completed' } },
        { status: 409 },
      );
    await user.click(screen.getByRole('button', { name: 'Cancel issue #3' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel issue #3?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel issue' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Issue #3 is already completed');
  });
});
