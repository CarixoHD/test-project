import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { emptyState, reduce, type ClientState } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { createAppStore } from '../../state/store.ts';

// Apply changes from the Spec tab after handoff, end to end in the browser: real store, router
// and API client; only the network (fetch + EventSource) is faked at the global boundary.

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
const PRD_V2 = '# Todo\n\nTrack and share todos.\n';
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
const draftSaved = (markdown: string, baseVersion = 1) =>
  event('prd.draft_saved', { markdown, baseVersion });

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

const applyButton = () => screen.getByRole('button', { name: 'Apply changes' });
const history = () => screen.getByRole('list', { name: 'PRD versions' });

describe('Apply changes after handoff', () => {
  it('keeps sparring available and offers no apply while the draft equals the latest version', async () => {
    await renderSpec([productCreated, () => draftSaved(PRD, 0), handoffEvents]);

    expect(screen.getByRole('textbox', { name: 'Your message' })).toBeEnabled();
    expect(screen.queryByText(/Unapplied changes/)).toBeNull();
    expect(applyButton()).toHaveAttribute('aria-disabled', 'true');
    expect(applyButton()).toHaveAccessibleDescription(/no unapplied changes/i);
    expect(within(history()).getAllByRole('listitem')).toHaveLength(1);
    expect(history()).toHaveTextContent('v1');
  });

  it('shows unapplied changes, confirms, posts apply-prd and lists the new version with its summary', async () => {
    const { user } = await renderSpec([
      productCreated,
      () => draftSaved(PRD, 0),
      handoffEvents,
      () => draftSaved(PRD_V2),
    ]);
    expect(screen.getByText('Unapplied changes since v1')).toBeInTheDocument();
    expect(applyButton()).not.toHaveAttribute('aria-disabled');

    applyButton().focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Apply changes?' });
    expect(dialog).toHaveTextContent(/version 2/);
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    expect(sent).toEqual([{ method: 'POST', url: `/api/products/${P}/apply-prd` }]);
    expect(screen.queryByRole('dialog')).toBeNull();

    push(event('prd.applied', { version: 2, markdown: PRD_V2, summary: null }));
    expect(screen.queryByText(/Unapplied changes/)).toBeNull();
    expect(within(history()).getAllByRole('listitem')).toHaveLength(2);
    expect(history()).toHaveTextContent(/v2.*replanning/i);

    push(event('prd.summarized', { version: 2, summary: 'Added a sharing issue.' }));
    expect(history()).toHaveTextContent('Added a sharing issue.');
  });

  it('keeps the dialog open and shows the server error when apply is refused', async () => {
    respond = () =>
      Response.json(
        { error: { code: 'conflict', message: 'No changes to apply' } },
        { status: 409 },
      );
    const { user } = await renderSpec([
      productCreated,
      () => draftSaved(PRD, 0),
      handoffEvents,
      () => draftSaved(PRD_V2),
    ]);
    await user.click(applyButton());
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No changes to apply');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is not offered while sparring', async () => {
    await renderSpec([productCreated, () => draftSaved(PRD, 0)]);
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  });
});
