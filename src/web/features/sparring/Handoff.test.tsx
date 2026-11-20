import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { emptyState, reduce, type ClientState } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { createAppStore } from '../../state/store.ts';

// Handoff from the Spec tab, end to end in the browser: real store, router and API client;
// only the network (fetch + EventSource) is faked at the global boundary.

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

const P = 'p1';
const PRD = '# Todo\n\nTrack todos.\n';
let seq = 0;

const event = (type: string, data: unknown): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    productId: P,
    entityId: null,
    v: 1,
    data,
  });
};

const productCreated = () =>
  event('product.created', {
    name: 'Todo app',
    idea: 'Track my todos',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  });
const draftSaved = (markdown: string) => event('prd.draft_saved', { markdown, baseVersion: 0 });

/** What the server emits on a successful handoff. */
const handoffEvents = (): Event[] => [
  event('prd.applied', { version: 1, markdown: PRD, summary: null }),
  event('product.handed_off', { prdVersion: 1 }),
  event('product.phase_changed', { phase: 'building' }),
];

type Sent = { method: string; url: string };
let sent: Sent[];
let respond: () => Response;

beforeEach(() => {
  seq = 0;
  sent = [];
  respond = () => Response.json({ ok: true });
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSpec(history: (() => Event | Event[])[]) {
  let state: ClientState = emptyState;
  for (const make of history) state = [make()].flat().reduce(reduce, state);
  const snapshot = { state, lastSeq: seq };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(Response.json(snapshot));
      sent.push({ method, url });
      return Promise.resolve(respond());
    }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [`/products/${P}/spec`] });
  render(<App store={createAppStore()} router={router} />);
  await screen.findByRole('heading', { level: 1, name: 'Todo app' });
  return { user: userEvent.setup() };
}

function push(...events: Event[]): void {
  const stream = FakeEventSource.latest;
  if (stream === null) throw new Error('no stream');
  act(() => {
    for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
  });
}

/** The product page header: its name and phase. */
const productHeader = () =>
  screen.getByRole('heading', { level: 1, name: 'Todo app' }).closest('header') as HTMLElement;

const handoffButton = () => screen.getByRole('button', { name: 'Hand off to orchestrator' });

describe('Hand off to orchestrator', () => {
  it('confirms by keyboard, posts the handoff and the header then shows Building', async () => {
    const { user } = await renderSpec([productCreated, () => draftSaved(PRD)]);
    expect(productHeader()).toHaveTextContent('Sparring');

    handoffButton().focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Hand off to orchestrator?' });
    expect(dialog).toHaveTextContent(/orchestrator/i);
    // Focus starts inside the dialog; Tab reaches the confirm button.
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const confirm = screen.getByRole('button', { name: 'Hand off' });
    while (document.activeElement !== confirm) await user.tab();
    await user.keyboard('{Enter}');

    expect(sent).toEqual([{ method: 'POST', url: `/api/products/${P}/handoff` }]);
    expect(screen.queryByRole('dialog')).toBeNull();

    push(...handoffEvents());
    expect(productHeader()).toHaveTextContent('Building');
    expect(screen.queryByRole('button', { name: 'Hand off to orchestrator' })).toBeNull();
  });

  it('cancels with Escape without posting, and focus returns to the button', async () => {
    const { user } = await renderSpec([productCreated, () => draftSaved(PRD)]);
    handoffButton().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent).toEqual([]);
    expect(handoffButton()).toHaveFocus();
  });

  it.each([
    ['no draft', [productCreated]],
    ['a blank draft', [productCreated, () => draftSaved('  \n')]],
  ])('is disabled with an explanation when there is %s', async (_label, history) => {
    const { user } = await renderSpec(history);
    const button = handoffButton();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(/draft is empty/i);

    await user.click(button);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('keeps the dialog open and shows the server error when the handoff is refused', async () => {
    respond = () =>
      Response.json(
        { error: { code: 'conflict', message: 'The PRD draft is empty' } },
        { status: 409 },
      );
    const { user } = await renderSpec([productCreated, () => draftSaved(PRD)]);
    await user.click(handoffButton());
    await user.click(screen.getByRole('button', { name: 'Hand off' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The PRD draft is empty');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is not offered once the product is building', async () => {
    await renderSpec([productCreated, () => draftSaved(PRD), handoffEvents]);
    expect(productHeader()).toHaveTextContent('Building');
    expect(screen.queryByRole('button', { name: 'Hand off to orchestrator' })).toBeNull();
  });
});
