import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { emptyState } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { createAppStore, type AppStore } from '../../state/store.ts';

// The products feature end to end in the browser: real store, router and API client, with
// the network (fetch + EventSource) faked at the global boundary.
//
// Opening a product page mounts the Build tab, whose 3D view lazily imports the real WebGL
// scene (three.js + R3F). That import costs seconds under full-suite load and races the test
// timeouts; these tests are about the products feature, so the scene is a stand-in.
vi.mock('../../scene/Scene3D.tsx', () => ({ default: () => null }));

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
  // Unmount (stopping the store and its stream) while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

async function renderApp(path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const store = createAppStore();
  render(<App store={store} router={router} />);
  // Wait on the store's start itself (snapshot loaded or failed), not on a polling timeout.
  await act(() => settled(store));
  return router;
}

/** Resolves once the store has loaded its snapshot or given up with an error. */
function settled(store: AppStore): Promise<void> {
  const done = () => store.getSnapshot().loaded || store.getSnapshot().error !== null;
  return new Promise((resolve) => {
    if (done()) return resolve();
    const unsubscribe = store.subscribe(() => {
      if (!done()) return;
      unsubscribe();
      resolve();
    });
  });
}

const stream = (): FakeEventSource => {
  if (FakeEventSource.latest === null) throw new Error('no stream');
  return FakeEventSource.latest;
};

describe('ProductsPage', () => {
  it('lists products live as product.created events arrive, with the phase as text', async () => {
    await renderApp();
    expect(screen.getByText('No products yet.')).toBeInTheDocument();

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
    const router = await renderApp();
    screen.getByText('No products yet.');

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
    await renderApp();
    screen.getByText('No products yet.');

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
    await renderApp();
    screen.getByText('No products yet.');
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxlength', '80');
    expect(screen.getByLabelText('Idea')).toHaveAttribute('maxlength', '4000');
  });

  it('shows the server error and keeps the input', async () => {
    const user = userEvent.setup();
    postResponse = () =>
      Response.json({ error: { code: 'invalid', message: 'Name is taken' } }, { status: 400 });
    const router = await renderApp();
    screen.getByText('No products yet.');

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
    await renderApp('/products/p1');
    screen.getByRole('heading', { level: 1, name: 'Product not found' });
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
