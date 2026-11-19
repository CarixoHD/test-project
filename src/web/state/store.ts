import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { parseEvent, type Event } from '../../shared/events.ts';
import { emptyState, reduce, type ClientState } from '../../shared/state.ts';
import { ApiError, getState } from './api.ts';

// The browser's live copy of ClientState (ARCHITECTURE §4.12). It loads GET /api/state,
// follows /api/events (SSE) and applies each event with the shared `reduce`, so the UI and the
// server agree on what an event means. The stream opens before the snapshot is requested and
// events arriving meanwhile are buffered, so nothing committed between the two is lost.

/** Consecutive stream errors (no successful open in between) that trigger a snapshot reload. */
export const MAX_STREAM_FAILURES = 3;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 30_000;
/** EventSource.CLOSED; read from the constant so tests can stub the global. */
const CLOSED = 2;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface AppSnapshot {
  state: ClientState;
  /** Highest event seq applied; events at or below it are duplicates. */
  lastSeq: number;
  status: ConnectionStatus;
  /** A snapshot has been loaded at least once. */
  loaded: boolean;
  /** Why the last snapshot load failed, for the owner; null once it succeeds. */
  error: string | null;
}

export interface AppStore {
  getSnapshot(): AppSnapshot;
  subscribe(listener: () => void): () => void;
  /** Connects; returns the matching stop function. Safe to start again after stopping. */
  start(): () => void;
}

export interface AppStoreOptions {
  eventsUrl?: string;
  /** Base delay before reopening a closed stream or retrying a failed snapshot load. */
  retryDelayMs?: number;
}

export function createAppStore(options: AppStoreOptions = {}): AppStore {
  const eventsUrl = options.eventsUrl ?? '/api/events';
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let snapshot: AppSnapshot = {
    state: emptyState,
    lastSeq: 0,
    status: 'connecting',
    loaded: false,
    error: null,
  };
  const listeners = new Set<() => void>();

  // Connection state. `generation` changes on every (re)connect and stop, so callbacks from a
  // superseded stream or request do nothing.
  let generation = 0;
  let stream: EventSource | null = null;
  let streamOpen = false;
  let failures = 0;
  let synced = false;
  let buffer: Event[] = [];
  let snapshotAbort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let snapshotAttempts = 0;
  /** Was live at some point; later outages read as "reconnecting", not "connecting". */
  let hasBeenLive = false;

  function update(patch: Partial<AppSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    if (snapshot.status === 'live') hasBeenLive = true;
    for (const listener of listeners) listener();
  }

  function liveStatus(): ConnectionStatus {
    if (synced && streamOpen) return 'live';
    return hasBeenLive ? 'reconnecting' : 'connecting';
  }

  function apply(events: readonly Event[]): void {
    let { state, lastSeq } = snapshot;
    for (const e of events) {
      if (e.seq <= lastSeq) continue;
      state = reduce(state, e);
      lastSeq = e.seq;
    }
    if (state !== snapshot.state || lastSeq !== snapshot.lastSeq) update({ state, lastSeq });
  }

  function onMessage(data: unknown): void {
    const e = decode(data);
    if (e === null) return;
    if (synced) apply([e]);
    else buffer.push(e);
  }

  function openStream(gen: number): void {
    const es = new EventSource(eventsUrl);
    stream = es;
    streamOpen = false;
    es.onopen = () => {
      if (gen !== generation) return;
      streamOpen = true;
      failures = 0;
      update({ status: liveStatus() });
    };
    es.onmessage = (msg: MessageEvent) => {
      if (gen === generation) onMessage(msg.data);
    };
    es.onerror = () => {
      if (gen === generation) onStreamError(es, gen);
    };
  }

  function onStreamError(es: EventSource, gen: number): void {
    streamOpen = false;
    failures += 1;
    if (failures >= MAX_STREAM_FAILURES) {
      // Too many failed reconnects: we may have missed events, so rebuild from a fresh snapshot.
      connect();
      return;
    }
    update({ status: snapshot.status === 'offline' ? 'offline' : liveStatus() });
    // The browser retries on its own unless it gave up (e.g. a non-200 answer).
    if (es.readyState === CLOSED) {
      schedule(retryDelayMs * failures, () => {
        if (gen === generation) openStream(gen);
      });
    }
  }

  async function loadSnapshot(gen: number): Promise<void> {
    // Everything buffered so far is already committed, so the snapshot requested now
    // contains it: only events that arrive after this point need replaying.
    buffer = [];
    snapshotAbort = new AbortController();
    try {
      const res = await getState(snapshotAbort.signal);
      if (gen !== generation) return;
      snapshotAttempts = 0;
      synced = true;
      const pending = buffer;
      buffer = [];
      snapshot = { ...snapshot, state: res.state, lastSeq: res.lastSeq, loaded: true, error: null };
      apply(pending);
      update({ status: liveStatus() });
    } catch (err) {
      if (gen !== generation) return;
      snapshotAttempts += 1;
      update({ status: 'offline', error: describeError(err) });
      const delay = Math.min(retryDelayMs * 2 ** (snapshotAttempts - 1), MAX_RETRY_DELAY_MS);
      schedule(delay, () => {
        if (gen === generation) void loadSnapshot(gen);
      });
    }
  }

  function schedule(delayMs: number, fn: () => void): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  }

  function disconnect(): void {
    generation += 1;
    stream?.close();
    stream = null;
    streamOpen = false;
    snapshotAbort?.abort();
    snapshotAbort = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    failures = 0;
    synced = false;
    buffer = [];
  }

  function connect(): void {
    disconnect();
    const gen = generation;
    update({ status: liveStatus() });
    openStream(gen);
    void loadSnapshot(gen);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      connect();
      return disconnect;
    },
  };
}

/** Parses one SSE `data` payload. Unknown types (newer server) and malformed data yield null. */
function decode(data: unknown): Event | null {
  if (typeof data !== 'string') return null;
  try {
    return parseEvent(JSON.parse(data));
  } catch (err) {
    // A malformed event cannot be applied; the next snapshot reload repairs any gap.
    console.error('Ignoring a malformed event from /api/events', err);
    return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Cannot reach the Vibecode server; is it running?';
}

// ---- React binding --------------------------------------------------------------------------

export const AppStoreContext = createContext<AppStore | null>(null);

/**
 * Selects a slice of the live app state and re-renders when it changes. The selector must
 * return a stable value for the same snapshot (pick existing objects; don't build new ones).
 */
export function useApp<T>(selector: (s: AppSnapshot) => T): T {
  const store = useContext(AppStoreContext);
  if (store === null) throw new Error('useApp must be used inside <AppStoreProvider>');
  const getSelected = useCallback(() => selector(store.getSnapshot()), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSelected, getSelected);
}
