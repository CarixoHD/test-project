import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore, type AppStore } from '../../state/store.ts';
import { BuildTab } from './BuildTab.tsx';

// The 3D view region is the real ScenePanel; only the lazily imported WebGL scene (three.js +
// R3F) is a stand-in. Importing it costs seconds under full-suite load, and this test is
// about the layout, not the scene.
vi.mock('../../scene/Scene3D.tsx', () => ({ default: () => null }));

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  close(): void {
    this.readyState = 2;
  }
}

const P = ProductIdSchema.parse('p1');
const state = reduce(
  emptyState,
  EventSchema.parse({
    seq: 1,
    ts: 1_700_000_000_000,
    type: 'product.created',
    productId: P,
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
  }),
);

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ state, lastSeq: 1 }))),
  );
});

afterEach(() => {
  // Unmount (stopping the store and its stream) while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

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

describe('BuildTab', () => {
  it('lays out the board next to the controls, costs, agents and 3D view', async () => {
    const store = createAppStore();
    render(
      <MemoryRouter>
        <AppStoreProvider store={store}>
          <BuildTab product={state.products[P] as ProductState} />
        </AppStoreProvider>
      </MemoryRouter>,
    );
    // Wait on the store's start itself (snapshot loaded or failed), not on one macrotask.
    await act(() => settled(store));
    expect(store.getSnapshot().loaded).toBe(true);
    for (const name of ['Build controls', 'Costs', 'Issues', 'Agents', '3D view']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    // The backend banner only appears while a backend is limited (BackendStatus.test.tsx).
    expect(screen.queryByRole('region', { name: 'Backend status' })).toBeNull();
  });
});
