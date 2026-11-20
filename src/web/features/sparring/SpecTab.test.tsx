import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { SpecTab } from './SpecTab.tsx';

// The Spec tab against the real store and API client; only the network (fetch + EventSource)
// is faked at the global boundary, so events drive the UI exactly as in the browser.

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

type Draft = { type: string; entityId?: string | null; data: unknown; ts?: number | undefined };
const event = ({ type, entityId = null, data, ts }: Draft): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: ts ?? T0 + seq * 1000,
    type,
    productId: P,
    entityId,
    v: 1,
    data,
  });
};

const productCreated = (): Event =>
  event({
    type: 'product.created',
    data: {
      name: 'Todo app',
      idea: 'Track my todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    },
  });
const sparMessage = (role: 'owner' | 'agent', text: string, ts?: number): Event =>
  event({ type: 'spar.message', entityId: `m${String(seq + 1)}`, data: { role, text }, ts });
const draftSaved = (markdown: string, ts?: number): Event =>
  event({ type: 'prd.draft_saved', data: { markdown, baseVersion: 0 }, ts });
const sparringSpawned = (agentId: string): Event =>
  event({
    type: 'agent.spawned',
    entityId: agentId,
    data: {
      role: 'sparring',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      issueId: null,
      attemptId: null,
    },
  });
const agentExited = (agentId: string): Event =>
  event({ type: 'agent.exited', entityId: agentId, data: { outcome: 'ok' } });

type Sent = { method: string; url: string; body: unknown };
let sent: Sent[];
let respond: (method: string) => Response;

beforeEach(() => {
  seq = 0;
  sent = [];
  respond = (method) => Response.json({ ok: true }, { status: method === 'POST' ? 202 : 200 });
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders the Spec tab over a snapshot built from `history` (after product.created). */
async function renderSpec(history: (() => Event)[] = []) {
  let state: ClientState = reduce(emptyState, productCreated());
  for (const make of history) state = reduce(state, make());
  const snapshot = { state, lastSeq: seq };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(Response.json(snapshot));
      sent.push({ method, url, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(respond(method));
    }),
  );
  const product = state.products[P] as ProductState;
  render(
    <AppStoreProvider store={createAppStore()}>
      <SpecTab product={product} />
    </AppStoreProvider>,
  );
  // Let the snapshot request resolve and the store apply it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return { user: userEvent.setup() };
}

/** Delivers live events as the server would over SSE. */
function push(...events: Event[]): void {
  const stream = FakeEventSource.latest;
  if (stream === null) throw new Error('no stream');
  act(() => {
    for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
  });
}

const conversation = () => screen.getByRole('list', { name: 'Conversation' });

describe('SpecTab chat', () => {
  it('shows the transcript with who said what, agent markdown rendered without raw HTML', async () => {
    await renderSpec([
      () => sparMessage('owner', 'A todo app for **teams**'),
      () => sparMessage('agent', 'Who are the **users**? <img src=x onerror="alert(1)">'),
    ]);
    const items = await within(conversation()).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('You');
    // Owner text is shown as typed, not as markdown.
    expect(items[0]).toHaveTextContent('A todo app for **teams**');
    expect(items[1]).toHaveTextContent('Sparring agent');
    expect(within(items[1] as HTMLElement).getByText('users').tagName).toBe('STRONG');
    expect(conversation().querySelector('img')).toBeNull();
  });

  it('sends a message and shows the agent reply live, announcing it politely', async () => {
    const { user } = await renderSpec();
    expect(within(conversation()).queryAllByRole('listitem')).toHaveLength(0);

    await user.type(screen.getByLabelText('Your message'), 'A todo app');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(sent).toEqual([
      { method: 'POST', url: `/api/products/${P}/spar`, body: { message: 'A todo app' } },
    ]);
    expect(screen.getByLabelText('Your message')).toHaveValue('');
    expect(await screen.findByText('Agent is thinking…')).toBeInTheDocument();

    push(sparMessage('owner', 'A todo app'), sparringSpawned('a1'));
    expect(within(conversation()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Agent is thinking…')).toBeInTheDocument();

    push(sparMessage('agent', 'Who will use it?'), agentExited('a1'));
    const items = within(conversation()).getAllByRole('listitem');
    expect(items[1]).toHaveTextContent('Who will use it?');
    expect(screen.queryByText('Agent is thinking…')).toBeNull();
    const announcer = screen.getByTestId('spar-announcer');
    expect(announcer).toHaveAttribute('aria-live', 'polite');
    expect(announcer).toHaveTextContent('Sparring agent replied: Who will use it?');
  });

  it('does not announce replies that were already there on load', async () => {
    await renderSpec([() => sparMessage('agent', 'Earlier question')]);
    expect(screen.getByTestId('spar-announcer')).toHaveTextContent('');
  });

  it('shows the thinking indicator while a sparring agent is working', async () => {
    await renderSpec([() => sparMessage('owner', 'Hi'), () => sparringSpawned('a1')]);
    expect(screen.getByText('Agent is thinking…')).toBeInTheDocument();
  });

  it('sends with Ctrl+Enter and Cmd+Enter', async () => {
    const { user } = await renderSpec();
    const box = screen.getByLabelText('Your message');
    await user.type(box, 'First');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.type(box, 'Second');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(sent.map((s) => s.body)).toEqual([{ message: 'First' }, { message: 'Second' }]);
  });

  it('keeps plain Enter as a newline', async () => {
    const { user } = await renderSpec();
    const box = screen.getByLabelText('Your message');
    await user.type(box, 'one{Enter}two');
    expect(box).toHaveValue('one\ntwo');
    expect(sent).toEqual([]);
  });

  it('does not send an empty message and says why', async () => {
    const { user } = await renderSpec();
    await user.type(screen.getByLabelText('Your message'), '   ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual([]);
    expect(screen.getByLabelText('Your message')).toHaveAccessibleDescription(
      expect.stringContaining('Message is required'),
    );
  });

  it('shows the server error and keeps the message', async () => {
    respond = () =>
      Response.json(
        { error: { code: 'conflict', message: 'The agent is still answering' } },
        { status: 409 },
      );
    const { user } = await renderSpec();
    await user.type(screen.getByLabelText('Your message'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The agent is still answering');
    expect(screen.getByLabelText('Your message')).toHaveValue('Hello');
    expect(screen.queryByText('Agent is thinking…')).toBeNull();
  });
});

const prdPanel = () => screen.getByRole('region', { name: 'PRD draft' });

describe('SpecTab PRD draft', () => {
  it('shows the draft rendered, with when and by whom it was last updated', async () => {
    const ts = T0 + 60_000;
    await renderSpec([
      () => sparMessage('agent', 'Here is a first draft.', ts),
      () => draftSaved('# Todo app\n\n## Problem\n\nTeams lose **todos**.', ts),
    ]);
    const panel = prdPanel();
    expect(within(panel).getByRole('heading', { name: 'Todo app' })).toBeInTheDocument();
    expect(within(panel).getByText('todos').tagName).toBe('STRONG');
    expect(panel).toHaveTextContent(/Last updated .* by the sparring agent/);
    expect(
      within(panel)
        .getByText(/Last updated/)
        .querySelector('time'),
    ).toHaveAttribute('datetime', new Date(ts).toISOString());
  });

  it('attributes a draft saved on its own to the owner', async () => {
    await renderSpec([() => draftSaved('# Mine')]);
    expect(prdPanel()).toHaveTextContent(/Last updated .* by you/);
  });

  it('says when there is no draft yet', async () => {
    await renderSpec();
    expect(prdPanel()).toHaveTextContent('No PRD draft yet');
  });

  it('edits the draft and saves it with PUT prd-draft', async () => {
    const { user } = await renderSpec([() => draftSaved('# Draft')]);
    await user.click(within(prdPanel()).getByRole('button', { name: 'Edit' }));
    const editor = within(prdPanel()).getByLabelText('PRD markdown');
    expect(editor).toHaveValue('# Draft');
    expect(editor).toHaveFocus();

    await user.type(editor, '\n\nMore');
    await user.click(within(prdPanel()).getByRole('button', { name: 'Save' }));

    expect(sent).toEqual([
      { method: 'PUT', url: `/api/products/${P}/prd-draft`, body: { markdown: '# Draft\n\nMore' } },
    ]);
    // Back to the preview, which shows the saved text until the event confirms it.
    expect(await within(prdPanel()).findByRole('button', { name: 'Edit' })).toHaveFocus();
    expect(within(prdPanel()).queryByLabelText('PRD markdown')).toBeNull();
    expect(prdPanel()).toHaveTextContent('More');
  });

  it('keeps the editor and the text when saving fails', async () => {
    respond = () =>
      Response.json({ error: { code: 'invalid', message: 'Draft too long' } }, { status: 400 });
    const { user } = await renderSpec([() => draftSaved('# Draft')]);
    await user.click(within(prdPanel()).getByRole('button', { name: 'Edit' }));
    await user.type(within(prdPanel()).getByLabelText('PRD markdown'), ' x');
    await user.click(within(prdPanel()).getByRole('button', { name: 'Save' }));
    expect(await within(prdPanel()).findByRole('alert')).toHaveTextContent('Draft too long');
    expect(within(prdPanel()).getByLabelText('PRD markdown')).toHaveValue('# Draft x');
  });

  it('cancelling the edit returns to the preview without saving', async () => {
    const { user } = await renderSpec([() => draftSaved('# Draft')]);
    await user.click(within(prdPanel()).getByRole('button', { name: 'Edit' }));
    await user.type(within(prdPanel()).getByLabelText('PRD markdown'), ' changed');
    await user.click(within(prdPanel()).getByRole('button', { name: 'Cancel' }));
    expect(sent).toEqual([]);
    expect(within(prdPanel()).getByRole('heading', { name: 'Draft' })).toBeInTheDocument();
  });

  it('updates the preview live when the agent saves a new draft', async () => {
    await renderSpec([() => draftSaved('# Old')]);
    push(sparMessage('agent', 'Updated', T0 + 90_000), draftSaved('# New', T0 + 90_000));
    expect(within(prdPanel()).getByRole('heading', { name: 'New' })).toBeInTheDocument();
  });

  it('does not overwrite unsaved edits when a newer agent draft arrives, and says so', async () => {
    const { user } = await renderSpec([() => draftSaved('# Old')]);
    await user.click(within(prdPanel()).getByRole('button', { name: 'Edit' }));
    const editor = within(prdPanel()).getByLabelText('PRD markdown');
    await user.type(editor, ' with my edits');

    push(sparMessage('agent', 'Revised', T0 + 90_000), draftSaved('# Agent v2', T0 + 90_000));

    expect(editor).toHaveValue('# Old with my edits');
    const notice = within(prdPanel()).getByRole('status');
    expect(notice).toHaveTextContent(/sparring agent saved a newer draft/i);

    // Saving keeps the owner's text.
    await user.click(within(prdPanel()).getByRole('button', { name: 'Save' }));
    expect(sent.map((s) => s.body)).toEqual([{ markdown: '# Old with my edits' }]);
  });

  it('can load the newer draft instead, discarding the unsaved edits', async () => {
    const { user } = await renderSpec([() => draftSaved('# Old')]);
    await user.click(within(prdPanel()).getByRole('button', { name: 'Edit' }));
    const editor = within(prdPanel()).getByLabelText('PRD markdown');
    await user.type(editor, ' mine');
    push(sparMessage('agent', 'Revised', T0 + 90_000), draftSaved('# Agent v2', T0 + 90_000));

    await user.click(within(prdPanel()).getByRole('button', { name: /Load the newer draft/ }));
    expect(editor).toHaveValue('# Agent v2');
    expect(within(prdPanel()).getByRole('status')).toBeEmptyDOMElement();
  });

  it('follows a newer draft silently while editing without changes', async () => {
    const { user } = await renderSpec([() => draftSaved('# Old')]);
    await user.click(within(prdPanel()).getByRole('button', { name: 'Edit' }));
    push(sparMessage('agent', 'Revised', T0 + 90_000), draftSaved('# Agent v2', T0 + 90_000));
    expect(within(prdPanel()).getByLabelText('PRD markdown')).toHaveValue('# Agent v2');
    expect(within(prdPanel()).getByRole('status')).toBeEmptyDOMElement();
  });
});
