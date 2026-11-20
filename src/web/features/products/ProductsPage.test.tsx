import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { emptyState } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { createAppStore } from '../../state/store.ts';

// The products feature end to end in the browser: real store, router and API client, with
// the network (fetch + EventSource) faked at the global boundary.

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
  send(e: Event): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

const productCreated = (seq: number, id: string, name: string): Event =>
  EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type: 'product.created',
    productId: id,
    entityId: null,
    v: 1,
    data: {
      name,
      idea: 'An idea',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    },
  });

type Posted = { url: string; body: unknown };
let posts: Posted[];
let postResponse: () => Response;

beforeEach(() => {
  posts = [];
  postResponse = () => Response.json({ id: 'p-new' }, { status: 201 });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve(postResponse());
      }
      return Promise.resolve(Response.json({ state: emptyState, lastSeq: 0 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderApp(path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App store={createAppStore()} router={router} />);
  return router;
}

const stream = (): FakeEventSource => {
  if (FakeEventSource.latest === null) throw new Error('no stream');
  return FakeEventSource.latest;
};

describe('ProductsPage', () => {
  it('lists products live as product.created events arrive, with the phase as text', async () => {
    renderApp();
    expect(await screen.findByText('No products yet.')).toBeInTheDocument();

    act(() => stream().send(productCreated(1, 'p1', 'Todo app')));

    const list = screen.getByRole('list', { name: 'Products' });
    const item = within(list).getByRole('listitem');
    expect(within(item).getByRole('link', { name: 'Todo app' })).toHaveAttribute(
      'href',
      '/products/p1',
    );
    expect(item).toHaveTextContent('Sparring');
  });

  it('creates a product with the keyboard and opens its page once it arrives', async () => {
    const user = userEvent.setup();
    const router = renderApp();
    await screen.findByText('No products yet.');

    await user.click(screen.getByLabelText('Name'));
    await user.keyboard('Todo app');
    await user.tab();
    expect(screen.getByLabelText('Idea')).toHaveFocus();
    await user.keyboard('Track my todos');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Create product' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(posts).toEqual([
      { url: '/api/products', body: { name: 'Todo app', idea: 'Track my todos' } },
    ]);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/products/p-new'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Opening product…' }),
    ).toBeInTheDocument();

    act(() => stream().send(productCreated(1, 'p-new', 'Todo app')));
    // The re-render can land after the router's navigation transition settles.
    expect(await screen.findByRole('heading', { level: 1, name: 'Todo app' })).toBeInTheDocument();
  });

  it('shows validation messages next to the fields and does not submit', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('No products yet.');

    await user.type(screen.getByLabelText('Name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    const name = screen.getByLabelText('Name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(expect.stringContaining('Name is required'));
    expect(screen.getByLabelText('Idea')).toHaveAccessibleDescription(
      expect.stringContaining('Idea is required'),
    );
    expect(name).toHaveFocus();
    expect(posts).toEqual([]);
  });

  it('limits the field lengths', async () => {
    renderApp();
    await screen.findByText('No products yet.');
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxlength', '80');
    expect(screen.getByLabelText('Idea')).toHaveAttribute('maxlength', '4000');
  });

  it('shows the server error and keeps the input', async () => {
    const user = userEvent.setup();
    postResponse = () =>
      Response.json({ error: { code: 'invalid', message: 'Name is taken' } }, { status: 400 });
    const router = renderApp();
    await screen.findByText('No products yet.');

    await user.type(screen.getByLabelText('Name'), 'Todo');
    await user.type(screen.getByLabelText('Idea'), 'Todos');
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name is taken');
    expect(screen.getByLabelText('Name')).toHaveValue('Todo');
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('ProductPage', () => {
  it('shows the product name and the Build, Spec and Settings tabs', async () => {
    renderApp('/products/p1');
    await screen.findByRole('heading', { level: 1, name: 'Product not found' });
    act(() => stream().send(productCreated(1, 'p1', 'Todo app')));

    expect(screen.getByRole('heading', { level: 1, name: 'Todo app' })).toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Build', 'Spec', 'Settings']);
    const panelOf = (tab: string) => {
      const controls = screen.getByRole('tab', { name: tab }).getAttribute('aria-controls');
      const panel = document.getElementById(controls ?? '');
      if (panel === null) throw new Error(`no panel for ${tab}`);
      return panel;
    };
    expect(panelOf('Build')).toBeVisible();
    expect(within(panelOf('Build')).getByRole('region', { name: 'Issues' })).toBeInTheDocument();
    expect(panelOf('Spec')).toHaveTextContent(/PRD draft/);
    expect(panelOf('Settings')).toHaveTextContent('Settings for Todo app');
  });
});
