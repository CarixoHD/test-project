import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { EventSchema } from '../shared/events.ts';
import { emptyState, reduce } from '../shared/state.ts';
import { App } from './App.tsx';
import { routes } from './routes.tsx';
import type { AppSnapshot, AppStore, ConnectionStatus } from './state/store.ts';

// The product page keeps the Build tab mounted, whose 3D view lazily imports the real WebGL
// scene (three.js + R3F, via a deprecated CJS require). That import costs seconds under
// full-suite load and these tests are about the shell and routes, so the scene is a stand-in.
vi.mock('./scene/Scene3D.tsx', () => ({ default: () => null }));

const productCreated = EventSchema.parse({
  seq: 1,
  ts: 1_700_000_000_000,
  type: 'product.created',
  productId: 'p1',
  entityId: null,
  v: 1,
  data: {
    name: 'Todo app',
    idea: 'Track todos',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  },
});

const issueCreated = EventSchema.parse({
  seq: 2,
  ts: 1_700_000_000_001,
  type: 'issue.created',
  productId: 'p1',
  entityId: 'i1',
  v: 1,
  data: {
    issue: {
      id: 'i1',
      number: 1,
      title: 'Add a todo',
      body: 'As an owner I can add a todo.',
      status: 'in_review',
      rev: 1,
      priority: 0,
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
  },
});

/** A store that never connects: it serves one fixed snapshot. */
function fixedStore(status: ConnectionStatus = 'live'): AppStore {
  const state = [productCreated, issueCreated].reduce(reduce, emptyState);
  const snapshot: AppSnapshot = { state, lastSeq: 2, status, loaded: true, error: null };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: () => () => {},
    onLiveEvent: () => () => {},
  };
}

function renderAt(path: string, store = fixedStore()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App store={store} router={router} />);
}

describe('App routes', () => {
  it.each([
    ['/', 'Products'],
    ['/products/p1', 'Todo app'],
    ['/products/p1/spec', 'Todo app'],
    ['/products/unknown', 'Product not found'],
    ['/products/p1/issues/i1', '#1 Add a todo'],
    ['/products/p1/issues/nope', 'Issue not found'],
    ['/products/p2/issues/i1', 'Issue not found'],
    ['/inbox', 'Inbox'],
    ['/settings', 'Settings'],
    ['/no/such/page', 'Page not found'],
  ])('%s renders the "%s" heading inside main', (path, heading) => {
    renderAt(path);
    const h1 = screen.getByRole('heading', { level: 1, name: heading });
    expect(screen.getByRole('main')).toContainElement(h1);
  });
});

describe('pages', () => {
  it('lists products as links', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Todo app' })).toHaveAttribute('href', '/products/p1');
  });

  it('shows the issue status as text', () => {
    renderAt('/products/p1/issues/i1');
    expect(screen.getByText('In review')).toHaveClass('ui-badge');
  });

  it('selects the product tab from the path', () => {
    renderAt('/products/p1/spec');
    expect(screen.getByRole('tab', { name: 'Spec' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Layout', () => {
  it('starts with a skip link to main', () => {
    renderAt('/');
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    const main = screen.getByRole('main');
    expect(skip).toHaveAttribute('href', `#${main.id}`);
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(document.body.querySelector('a')).toBe(skip);
  });

  it('has a labelled nav with Products, Inbox and Settings, marking the current page', () => {
    renderAt('/inbox');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Products', 'Inbox', 'Settings']);
    expect(within(nav).getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Products' })).not.toHaveAttribute('aria-current');
  });

  it.each([
    ['connecting', 'Connecting…'],
    ['live', 'Live'],
    ['reconnecting', 'Reconnecting…'],
    ['offline', 'Offline, retrying…'],
  ] as const)('shows the %s connection status as text', (status, text) => {
    renderAt('/', fixedStore(status));
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });
});
