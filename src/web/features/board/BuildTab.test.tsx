import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ProductState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { BuildTab } from './BuildTab.tsx';

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
  vi.unstubAllGlobals();
});

describe('BuildTab', () => {
  it('lays out the board next to the controls, costs, agents and 3D view', async () => {
    render(
      <MemoryRouter>
        <AppStoreProvider store={createAppStore()}>
          <BuildTab product={state.products[P] as ProductState} />
        </AppStoreProvider>
      </MemoryRouter>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    for (const name of ['Build controls', 'Costs', 'Issues', 'Agents', '3D view']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    // The backend banner only appears while a backend is limited (BackendStatus.test.tsx).
    expect(screen.queryByRole('region', { name: 'Backend status' })).toBeNull();
  });
});
