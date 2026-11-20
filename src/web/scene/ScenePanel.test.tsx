import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../shared/events.ts';
import { ProductIdSchema } from '../../shared/ids.ts';
import { emptyState, reduce, type ClientState, type ProductState } from '../../shared/state.ts';
import { AppStoreContext, type AppSnapshot, type AppStore } from '../state/store.ts';
import type { Scene3DProps } from './scene-model.ts';
import { COLLAPSED_STORAGE_KEY, LazyScene3D, ScenePanel } from './ScenePanel.tsx';

// ScenePanel against a real AppStore-shaped store fed by real events. The WebGL Scene3D is
// swapped for a recording stand-in (jsdom has no WebGL); everything else is the real panel.

const P = ProductIdSchema.parse('p1');
let seq = 0;
const event = (type: string, entityId: string | null, data: unknown): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    productId: P,
    entityId,
    v: 1,
    data,
  });
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

const issueCreated = (n: number, status: 'open' | 'completed', mergedOrder: number | null) =>
  event('issue.created', `i${String(n)}`, {
    issue: {
      id: `i${String(n)}`,
      number: n,
      title: `Issue ${String(n)}`,
      body: '',
      status,
      rev: 1,
      priority: 0,
      origin: 'orchestrator',
      prdVersion: 1,
      attemptCount: 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder,
      mergeSha: mergedOrder === null ? null : 'a'.repeat(40),
      failureReason: null,
      dependsOn: [],
    },
  });

const agentSpawned = (id: string) =>
  event('agent.spawned', id, {
    role: 'implementer',
    model: { provider: 'fake', model: 'fake' },
    issueId: null,
    attemptId: null,
  });

/** A minimal AppStore holding a state that tests advance with real events. */
function storeFrom(events: Event[]) {
  let snapshot: AppSnapshot = {
    state: events.reduce<ClientState>(reduce, emptyState),
    lastSeq: seq,
    status: 'live',
    loaded: true,
    error: null,
  };
  const listeners = new Set<() => void>();
  const store: AppStore = {
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start: () => () => undefined,
    onLiveEvent: () => () => undefined,
  };
  const apply = (e: Event) => {
    snapshot = { ...snapshot, state: reduce(snapshot.state, e), lastSeq: e.seq };
    for (const l of listeners) l();
  };
  return { store, apply };
}

/** Records every render's props and every mount of the stand-in scene. */
function recordingScene() {
  const renders: Scene3DProps[] = [];
  let mounts = 0;
  function Scene(props: Scene3DProps) {
    renders.push(props);
    useEffect(() => {
      mounts += 1;
    }, []);
    return <canvas data-testid="scene-canvas" />;
  }
  return { Scene, renders, last: () => renders.at(-1), mounts: () => mounts };
}

function renderPanel(store: AppStore, Scene: (p: Scene3DProps) => React.ReactNode) {
  const product = store.getSnapshot().state.products[P] as ProductState;
  return render(
    <AppStoreContext value={store}>
      <ScenePanel product={product} Scene={Scene} />
    </AppStoreContext>,
  );
}

beforeEach(() => {
  seq = 0;
  localStorage.clear();
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScenePanel', () => {
  it('collapses without unmounting the scene and stops its frameloop', async () => {
    const user = userEvent.setup();
    const { store } = storeFrom([productCreated()]);
    const scene = recordingScene();
    renderPanel(store, scene.Scene);

    const toggle = screen.getByRole('button', { name: /3D view/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(scene.last()?.frameloop).toBe('always');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(scene.last()?.frameloop).toBe('never');
    expect(screen.getByTestId('scene-canvas')).toBeInTheDocument();
    expect(scene.mounts()).toBe(1);

    await user.click(toggle);
    expect(scene.last()?.frameloop).toBe('always');
    expect(scene.mounts()).toBe(1);
  });

  it('remembers the collapsed state in localStorage', async () => {
    const user = userEvent.setup();
    const { store } = storeFrom([productCreated()]);
    const first = renderPanel(store, recordingScene().Scene);
    await user.click(screen.getByRole('button', { name: /3D view/i }));
    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe('true');
    first.unmount();

    const scene = recordingScene();
    renderPanel(store, scene.Scene);
    expect(screen.getByRole('button', { name: /3D view/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Starting collapsed does not load the 3D scene at all until it is first expanded.
    expect(scene.mounts()).toBe(0);
    await user.click(screen.getByRole('button', { name: /3D view/i }));
    expect(scene.last()?.frameloop).toBe('always');
  });

  it('stops rendering while the panel is scrolled off-screen', () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          notify = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { store } = storeFrom([productCreated()]);
    const scene = recordingScene();
    renderPanel(store, scene.Scene);

    act(() => notify?.([{ isIntersecting: false }]));
    expect(scene.last()?.frameloop).toBe('never');
    act(() => notify?.([{ isIntersecting: true }]));
    expect(scene.last()?.frameloop).toBe('always');
    expect(scene.mounts()).toBe(1);
  });

  it('disables animation when the user prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { store } = storeFrom([productCreated()]);
    const scene = recordingScene();
    renderPanel(store, scene.Scene);
    expect(scene.last()?.reducedMotion).toBe(true);
    expect(scene.last()?.frameloop).toBe('demand');
  });

  it('hides the canvas from assistive tech and points to the board and agent list', () => {
    const { store } = storeFrom([productCreated()]);
    renderPanel(store, recordingScene().Scene);
    expect(screen.getByTestId('scene-canvas').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText(/board and the agent list/i)).toBeInTheDocument();
  });

  it('passes the live scene of this product: pieces and workers follow events', () => {
    const { store, apply } = storeFrom([
      productCreated(),
      issueCreated(1, 'completed', 1),
      issueCreated(2, 'open', null),
      agentSpawned('a1'),
    ]);
    const scene = recordingScene();
    renderPanel(store, scene.Scene);
    expect(scene.last()?.scene.pieces).toHaveLength(1);
    expect(scene.last()?.scene.workers).toHaveLength(1);

    act(() => apply(agentSpawned('a2')));
    expect(scene.last()?.scene.workers).toHaveLength(2);
    act(() => apply(event('agent.exited', 'a1', { outcome: 'ok' })));
    expect(scene.last()?.scene.workers.map((w) => w.agentId)).toEqual(['a2']);
  });
});

describe('LazyScene3D', () => {
  it('is code-split with React.lazy', () => {
    expect((LazyScene3D as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.lazy'),
    );
  });
});
