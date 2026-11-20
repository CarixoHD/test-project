import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { emptyState, reduce } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { createAppStore } from '../../state/store.ts';
import { FakeEventSource } from '../agents/testing.ts';

// The inbox against the real store and router: the snapshot comes from a stubbed
// GET /api/state, live events are pushed through a fake EventSource, and the browser
// Notification API is a fake that records what was shown.

const T0 = 1_700_000_000_000;
let seq = 0;

const event = (
  type: string,
  productId: string | null,
  entityId: string | null,
  data: unknown,
  ts?: number,
): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: ts ?? T0 + seq * 60_000,
    type,
    productId,
    entityId,
    v: 1,
    data,
  });
};

const productCreated = () =>
  event('product.created', 'p1', null, {
    name: 'Todo app',
    idea: 'Track todos',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  });

const inboxCreated = (
  id: string,
  kind: string,
  title: string,
  extra: { body?: string; link?: string | null; productId?: string | null; ts?: number } = {},
) =>
  event(
    'inbox.created',
    extra.productId === undefined ? 'p1' : extra.productId,
    id,
    {
      kind,
      title,
      body: extra.body ?? '',
      link: extra.link === undefined ? '/products/p1' : extra.link,
    },
    extra.ts,
  );

/** An orchestrator question plus the inbox item the server's rule creates with it. */
const questionWithItem = (qid: string, itemId: string, text: string) => {
  const asked = event('question.asked', 'p1', qid, {
    target: 'orchestrator',
    issueId: null,
    agentId: null,
    text,
  });
  const item = inboxCreated(itemId, 'question', 'Question about Todo app', {
    body: text,
    ts: asked.ts,
  });
  return [asked, item];
};

const HISTORY = (): Event[] => [
  productCreated(),
  inboxCreated('n1', 'failed', 'Issue #1 Login failed', {
    body: 'Failed after 3 attempts: tests fail',
    link: '/products/p1/issues/i1',
  }),
  inboxCreated('n2', 'budget_warn', 'Todo app reached 80% of its budget'),
  event('inbox.read', 'p1', 'n2', {}),
  inboxCreated('n3', 'rate_limited', 'Claude Code rate limited', { productId: null, link: null }),
];

// ---- fakes --------------------------------------------------------------------------------

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static answer: NotificationPermission = 'granted';
  static shown: FakeNotification[] = [];
  static requestPermission = vi.fn(() => {
    FakeNotification.permission = FakeNotification.answer;
    return Promise.resolve(FakeNotification.answer);
  });

  readonly title: string;
  readonly options: NotificationOptions | undefined;
  onclick: ((ev: unknown) => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.shown.push(this);
  }
}

type Route = () => Response;
let routeTable: Record<string, Route> = {};
let calls: { url: string; method: string; body: unknown }[] = [];

function stubNetwork(history: Event[]): void {
  const state = history.reduce(reduce, emptyState);
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/api/state') return Promise.resolve(Response.json({ state, lastSeq: seq }));
      const method = init.method ?? 'GET';
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      const route = routeTable[`${method} ${url}`];
      return Promise.resolve(
        route === undefined
          ? Response.json({ error: { code: 'not_found', message: 'none' } }, { status: 404 })
          : route(),
      );
    }),
  );
}

const ok = () => Response.json({ ok: true });

async function renderApp(history: Event[] = HISTORY(), path = '/inbox') {
  stubNetwork(history);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App store={createAppStore()} router={router} />);
  await act(async () => {
    FakeEventSource.find('/api/events').open();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { user: userEvent.setup(), router };
}

/** Delivers events on the live stream, as the server would after a commit. */
function push(...events: Event[]): void {
  const stream = FakeEventSource.find('/api/events');
  act(() => {
    for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
  });
}

const items = () =>
  within(screen.getByRole('list', { name: 'Inbox items' })).getAllByRole('listitem');
/** The n-th inbox item (0 = newest). */
const item = (n: number): HTMLElement => {
  const el = items()[n];
  if (el === undefined) throw new Error(`no inbox item ${String(n)}`);
  return el;
};
const inboxNav = () => within(screen.getByRole('navigation', { name: 'Main' }));

beforeEach(() => {
  seq = 0;
  routeTable = {};
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  FakeNotification.permission = 'default';
  FakeNotification.answer = 'granted';
  FakeNotification.shown = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- tests --------------------------------------------------------------------------------

describe('Inbox: nav badge', () => {
  it('shows the unread count and updates it live', async () => {
    await renderApp(HISTORY(), '/');
    expect(inboxNav().getByRole('link', { name: 'Inbox, 2 unread' })).toBeInTheDocument();

    push(inboxCreated('n4', 'complete', 'Todo app is complete'));
    expect(inboxNav().getByRole('link', { name: 'Inbox, 3 unread' })).toBeInTheDocument();

    push(event('inbox.read', 'p1', 'n1', {}), event('inbox.read', null, 'n3', {}));
    expect(inboxNav().getByRole('link', { name: 'Inbox, 1 unread' })).toBeInTheDocument();

    push(event('inbox.read', 'p1', 'n4', {}));
    expect(inboxNav().getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
  });
});

describe('Inbox: list', () => {
  it('lists items newest first with kind, title, body, time and read state as text', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Inbox' })).toBeInTheDocument();
    const [first, second, third] = items();
    expect(first).toHaveTextContent('Rate limited');
    expect(first).toHaveTextContent('Claude Code rate limited');
    expect(first).toHaveTextContent('Unread');
    expect(second).toHaveTextContent('Budget warning');
    expect(second).not.toHaveTextContent('Unread');
    expect(third).toHaveTextContent('Issue failed');
    expect(third).toHaveTextContent('Failed after 3 attempts: tests fail');
    expect(third?.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(T0 + 2 * 60_000).toISOString(),
    );
  });

  it('links items to their issue or product', async () => {
    await renderApp();
    expect(within(item(2)).getByRole('link', { name: 'Issue #1 Login failed' })).toHaveAttribute(
      'href',
      '/products/p1/issues/i1',
    );
    expect(
      within(item(1)).getByRole('link', { name: 'Todo app reached 80% of its budget' }),
    ).toHaveAttribute('href', '/products/p1');
  });

  it('says when the inbox is empty', async () => {
    await renderApp([productCreated()]);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });
});

describe('Inbox: marking read', () => {
  it('marks an item read when its link is opened', async () => {
    routeTable['POST /api/inbox/n1/read'] = ok;
    const { user, router } = await renderApp();
    await user.click(screen.getByRole('link', { name: 'Issue #1 Login failed' }));
    expect(calls).toContainEqual({ url: '/api/inbox/n1/read', method: 'POST', body: undefined });
    expect(router.state.location.pathname).toBe('/products/p1/issues/i1');
  });

  it('marks a single unread item read with its button', async () => {
    routeTable['POST /api/inbox/n3/read'] = ok;
    const { user } = await renderApp();
    await user.click(
      within(item(0)).getByRole('button', { name: 'Mark read: Claude Code rate limited' }),
    );
    expect(calls.map((c) => c.url)).toEqual(['/api/inbox/n3/read']);
    // Read items have no mark-read button.
    expect(within(item(1)).queryByRole('button', { name: /Mark read/ })).toBeNull();
  });

  it('marks every unread item read with "Mark all read"', async () => {
    routeTable['POST /api/inbox/n1/read'] = ok;
    routeTable['POST /api/inbox/n3/read'] = ok;
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => {
      expect(calls.map((c) => c.url).sort()).toEqual(['/api/inbox/n1/read', '/api/inbox/n3/read']);
    });
  });

  it('shows an error when marking read fails', async () => {
    routeTable['POST /api/inbox/n3/read'] = () =>
      Response.json({ error: { code: 'internal', message: 'Database is busy' } }, { status: 500 });
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is busy');
  });
});

describe('Inbox: questions', () => {
  it('answers a question inline and then shows the answer', async () => {
    routeTable['POST /api/questions/q1/answer'] = ok;
    routeTable['POST /api/inbox/n9/read'] = ok;
    const { user } = await renderApp([
      productCreated(),
      ...questionWithItem('q1', 'n9', 'Should todos sync across devices?'),
    ]);
    const entry = item(0);
    expect(entry).toHaveTextContent('Question');
    expect(entry).toHaveTextContent('Should todos sync across devices?');

    await user.click(within(entry).getByRole('button', { name: 'Send answer' }));
    expect(within(entry).getByRole('textbox', { name: 'Your answer' })).toHaveAccessibleDescription(
      'An answer is required',
    );
    expect(calls).toEqual([]);

    await user.type(
      within(entry).getByRole('textbox', { name: 'Your answer' }),
      '  No, local only ',
    );
    await user.click(within(entry).getByRole('button', { name: 'Send answer' }));
    expect(calls).toContainEqual({
      url: '/api/questions/q1/answer',
      method: 'POST',
      body: { text: 'No, local only' },
    });
    // Answering also marks the item read.
    await waitFor(() => {
      expect(calls.map((c) => c.url)).toContain('/api/inbox/n9/read');
    });

    push(event('question.answered', 'p1', 'q1', { answer: 'No, local only' }));
    expect(within(entry).queryByRole('textbox')).toBeNull();
    expect(entry).toHaveTextContent('Your answer: No, local only');
  });

  it('shows the server error when the answer is refused', async () => {
    routeTable['POST /api/questions/q1/answer'] = () =>
      Response.json(
        { error: { code: 'conflict', message: 'The question was already answered' } },
        { status: 409 },
      );
    const { user } = await renderApp([productCreated(), ...questionWithItem('q1', 'n9', 'Sync?')]);
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'Yes');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The question was already answered');
  });
});

describe('Inbox: browser notifications', () => {
  it('asks for permission, then notifies only for live inbox.created events', async () => {
    const { user, router } = await renderApp();
    // Items from the snapshot are history: no notification.
    expect(FakeNotification.shown).toEqual([]);

    // Before permission is granted, live items do not notify either.
    push(inboxCreated('n4', 'complete', 'Todo app is complete'));
    expect(FakeNotification.shown).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Browser notifications are on.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();

    push(
      inboxCreated('n5', 'failed', 'Issue #2 Sync failed', {
        body: 'Failed after 3 attempts',
        link: '/products/p1/issues/i2',
      }),
    );
    expect(FakeNotification.shown).toHaveLength(1);
    const [shown] = FakeNotification.shown;
    if (shown === undefined) throw new Error('no notification shown');
    expect(shown.title).toBe('Issue #2 Sync failed');
    expect(shown.options).toEqual({ body: 'Failed after 3 attempts' });

    // Other live events do not notify.
    push(event('inbox.read', 'p1', 'n5', {}));
    expect(FakeNotification.shown).toHaveLength(1);

    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    act(() => shown.onclick?.({}));
    expect(focus).toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/products/p1/issues/i2');
    expect(shown.close).toHaveBeenCalled();
  });

  it('says so when permission is denied', async () => {
    FakeNotification.answer = 'denied';
    const { user } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(screen.getByText(/Notifications are blocked/)).toBeInTheDocument();
    push(inboxCreated('n4', 'complete', 'Todo app is complete'));
    expect(FakeNotification.shown).toEqual([]);
  });

  it('notifies when permission was granted earlier, on any page', async () => {
    FakeNotification.permission = 'granted';
    await renderApp(HISTORY(), '/');
    push(inboxCreated('n4', 'complete', 'Todo app is complete', { body: 'All issues merged' }));
    expect(FakeNotification.shown.map((n) => n.title)).toEqual(['Todo app is complete']);
  });

  it('explains when the browser has no notifications', async () => {
    vi.stubGlobal('Notification', undefined);
    await renderApp();
    expect(screen.getByText('This browser does not support notifications.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
  });
});

describe('Inbox: announcements', () => {
  it('announces new live items politely, but not the items loaded with the snapshot', async () => {
    await renderApp(HISTORY(), '/');
    const region = screen.getByTestId('inbox-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
    push(inboxCreated('n4', 'complete', 'Todo app is complete'));
    expect(region).toHaveTextContent('New in your inbox: Todo app is complete');
  });
});
