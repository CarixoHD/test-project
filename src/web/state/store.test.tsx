import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../shared/events.ts';
import { ProductIdSchema } from '../../shared/ids.ts';
import { emptyState, reduce, type ClientState } from '../../shared/state.ts';
import { onUnauthorized } from './api.ts';
import { AppStoreProvider } from './AppStoreProvider.tsx';
import { createAppStore, useApp, type AppStore } from './store.ts';

// ---- fakes ----------------------------------------------------------------------------------

/** Stands in for the browser EventSource; tests drive it by hand. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
  }

  send(e: Event): void {
    this.onmessage?.({ data: JSON.stringify(e) });
  }

  /** A dropped connection or failed reconnect; the browser keeps retrying unless `closed`. */
  fail(closed = false): void {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.({});
  }
}

const latestStream = (): FakeEventSource => {
  const es = FakeEventSource.instances.at(-1);
  if (es === undefined) throw new Error('no EventSource was opened');
  return es;
};

const productCreated = (seq: number, id: string, name = id): Event =>
  EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type: 'product.created',
    productId: ProductIdSchema.parse(id),
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

const snapshotWith = (...events: Event[]) => {
  const state = events.reduce(reduce, emptyState);
  return { state, lastSeq: state.lastSeq };
};

type Snapshot = { state: ClientState; lastSeq: number };
let snapshots: (Snapshot | Error)[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Each GET /api/state answers with the next queued snapshot (the last one repeats). */
function queueSnapshots(...items: (Snapshot | Error)[]): void {
  snapshots = items;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  snapshots = [snapshotWith()];
  fetchMock = vi.fn(() => {
    const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
    if (next === undefined) throw new Error('no snapshot queued');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(Response.json(next));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  // Unmount while the fake network and timers are still in place.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let stopStore: (() => void) | undefined;
afterEach(() => {
  stopStore?.();
  stopStore = undefined;
});

async function started(store: AppStore = createAppStore()): Promise<AppStore> {
  stopStore = store.start();
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

const productNames = (store: AppStore) =>
  Object.values(store.getSnapshot().state.products).map((p) => p.name);

// ---- tests ----------------------------------------------------------------------------------

describe('app store', () => {
  it('loads the snapshot, opens /api/events and goes live once the stream is open', async () => {
    queueSnapshots(snapshotWith(productCreated(1, 'p1', 'Alpha')));
    const store = await started();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latestStream().url).toBe('/api/events');
    expect(productNames(store)).toEqual(['Alpha']);
    expect(store.getSnapshot().status).toBe('connecting');

    latestStream().open();
    expect(store.getSnapshot()).toMatchObject({ status: 'live', loaded: true });
  });

  it('applies streamed events through the shared reduce', async () => {
    const store = await started();
    latestStream().open();
    const e = productCreated(1, 'p1', 'Alpha');
    latestStream().send(e);
    expect(store.getSnapshot().state).toEqual(reduce(emptyState, e));
    expect(store.getSnapshot().lastSeq).toBe(1);
  });

  it('ignores events with seq <= lastSeq', async () => {
    queueSnapshots(snapshotWith(productCreated(1, 'p1', 'Alpha'), productCreated(2, 'p2', 'Beta')));
    const store = await started();
    latestStream().open();

    latestStream().send(productCreated(2, 'p-old', 'Replayed'));
    latestStream().send(productCreated(3, 'p3', 'Gamma'));
    latestStream().send(productCreated(3, 'p-dup', 'Duplicate'));

    expect(productNames(store)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(store.getSnapshot().lastSeq).toBe(3);
  });

  it('buffers events that arrive before the snapshot and applies only the newer ones', async () => {
    queueSnapshots(snapshotWith(productCreated(1, 'p1', 'Alpha')));
    const store = createAppStore();
    stopStore = store.start();
    // The stream opens and delivers before GET /api/state resolves.
    latestStream().open();
    latestStream().send(productCreated(1, 'p1', 'Alpha'));
    latestStream().send(productCreated(2, 'p2', 'Beta'));
    await vi.advanceTimersByTimeAsync(0);

    expect(productNames(store)).toEqual(['Alpha', 'Beta']);
    expect(store.getSnapshot().status).toBe('live');
  });

  it('tells live-event listeners about streamed events only, not the snapshot or its buffer', async () => {
    queueSnapshots(snapshotWith(productCreated(1, 'p1', 'Alpha')));
    const store = createAppStore();
    const seen: number[] = [];
    const off = store.onLiveEvent((e) => seen.push(e.seq));
    stopStore = store.start();
    latestStream().open();
    latestStream().send(productCreated(2, 'p2', 'Buffered'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);

    latestStream().send(productCreated(2, 'p-dup', 'Duplicate'));
    latestStream().send(productCreated(3, 'p3', 'Live'));
    expect(seen).toEqual([3]);

    off();
    latestStream().send(productCreated(4, 'p4', 'After unsubscribe'));
    expect(seen).toEqual([3]);
  });

  it('skips event types this build does not know', async () => {
    const store = await started();
    latestStream().open();
    const before = store.getSnapshot();
    latestStream().onmessage?.({
      data: JSON.stringify({
        seq: 1,
        ts: 1,
        type: 'future.thing',
        productId: null,
        entityId: null,
        v: 1,
        data: {},
      }),
    });
    expect(store.getSnapshot().state).toBe(before.state);
  });

  it('shows reconnecting while the browser retries a dropped stream', async () => {
    const store = await started();
    latestStream().open();
    latestStream().fail();
    expect(store.getSnapshot().status).toBe('reconnecting');
    latestStream().open();
    expect(store.getSnapshot().status).toBe('live');
  });

  it('re-fetches the snapshot and opens a fresh stream after 3 failed reconnects', async () => {
    queueSnapshots(snapshotWith(), snapshotWith(productCreated(1, 'p1'), productCreated(2, 'p2')));
    const store = await started();
    const first = latestStream();
    first.open();

    first.fail();
    first.fail();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(productNames(store)).toEqual(['p1', 'p2']);
    expect(store.getSnapshot().lastSeq).toBe(2);

    latestStream().open();
    latestStream().send(productCreated(2, 'p-dup'));
    latestStream().send(productCreated(3, 'p3'));
    expect(productNames(store)).toEqual(['p1', 'p2', 'p3']);
    expect(store.getSnapshot().status).toBe('live');
  });

  it('does not re-fetch when the stream recovers between failures', async () => {
    await started();
    const es = latestStream();
    es.open();
    es.fail();
    es.fail();
    es.open();
    es.fail();
    es.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('reopens the stream itself when the browser gives up on it', async () => {
    const store = await started(createAppStore({ retryDelayMs: 1000 }));
    latestStream().open();
    latestStream().fail(true);
    expect(store.getSnapshot().status).toBe('reconnecting');
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('re-checks the session when the stream fails and stops retrying once it is gone', async () => {
    const store = await started(createAppStore({ retryDelayMs: 1000 }));
    latestStream().open();
    const session = vi.fn(() =>
      Promise.resolve(Response.json({ passwordSet: true, authenticated: false })),
    );
    fetchMock.mockImplementation(session);
    const lost = vi.fn();
    const off = onUnauthorized(lost);
    // EventSource cannot read the 401: the browser just closes the stream.
    latestStream().fail(true);
    await vi.advanceTimersByTimeAsync(0);
    off();

    expect((session.mock.calls[0] as unknown[] | undefined)?.[0]).toBe('/api/session');
    expect(lost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latestStream().readyState).toBe(FakeEventSource.CLOSED);
    expect(session).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).not.toBe('live');
  });

  it('keeps retrying the stream while the session is still valid', async () => {
    await started(createAppStore({ retryDelayMs: 1000 }));
    latestStream().open();
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ passwordSet: true, authenticated: true })),
    );
    latestStream().fail(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/session', expect.anything());
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('reports offline and retries when the snapshot cannot be loaded', async () => {
    queueSnapshots(new TypeError('Failed to fetch'), snapshotWith(productCreated(1, 'p1')));
    const store = await started(createAppStore({ retryDelayMs: 1000 }));
    expect(store.getSnapshot()).toMatchObject({ status: 'offline', loaded: false });
    expect(store.getSnapshot().error).toMatch(/Cannot reach the Vibecode server/);

    await vi.advanceTimersByTimeAsync(1000);
    latestStream().open();
    expect(store.getSnapshot()).toMatchObject({ status: 'live', loaded: true, error: null });
    expect(productNames(store)).toEqual(['p1']);
  });

  it('stop closes the stream and ignores late callbacks', async () => {
    const store = await started();
    const es = latestStream();
    stopStore?.();
    stopStore = undefined;
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    const before = store.getSnapshot();
    es.send(productCreated(1, 'p1'));
    expect(store.getSnapshot()).toBe(before);
  });
});

describe('useApp', () => {
  function ProductCount() {
    const count = useApp((s) => Object.keys(s.state.products).length);
    const status = useApp((s) => s.status);
    return (
      <p>
        {count} products, {status}
      </p>
    );
  }

  it('re-renders the selected slice when events arrive', async () => {
    const store = createAppStore();
    render(
      <AppStoreProvider store={store}>
        <ProductCount />
      </AppStoreProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('0 products, connecting')).toBeInTheDocument();

    act(() => {
      latestStream().open();
      latestStream().send(productCreated(1, 'p1'));
    });
    expect(screen.getByText('1 products, live')).toBeInTheDocument();
  });
});
