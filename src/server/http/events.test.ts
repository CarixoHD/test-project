import { describe, expect, it, vi } from 'vitest';
import { parseEvent } from '../../shared/events.ts';
import type { Store } from '../store/index.ts';
import { createApp, HEARTBEAT_MS } from './index.ts';
import { productCreated, setupStore, sparMessage } from './testing.ts';

interface SseMessage {
  id?: string;
  event?: string;
  data: string[];
}

/** Incremental reader over the raw SSE body text. */
function sseReader(res: Response) {
  if (res.body === null) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  return {
    /** Reads until `done(text)` holds; fails after `timeoutMs`. */
    async until(done: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!done(text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out; stream so far:\n${text}`);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out; stream so far:\n${text}`)),
            remaining,
          );
        });
        try {
          const chunk = await Promise.race([reader.read(), timeout]);
          if (chunk.done) throw new Error(`stream ended; stream so far:\n${text}`);
          text += decoder.decode(chunk.value, { stream: true });
        } finally {
          clearTimeout(timer);
        }
      }
      return text;
    },
    cancel: () => reader.cancel(),
  };
}

/** Splits complete SSE blocks into messages; comment-only blocks (heartbeats) are skipped. */
function parseMessages(text: string): SseMessage[] {
  const blocks = text.split('\n\n').slice(0, -1);
  const out: SseMessage[] = [];
  for (const block of blocks) {
    const msg: SseMessage = { data: [] };
    let isMessage = false;
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      isMessage = true;
      if (field === 'data') msg.data.push(value);
      else if (field === 'id') msg.id = value;
      else if (field === 'event') msg.event = value;
    }
    if (isMessage) out.push(msg);
  }
  return out;
}

const countMessages = (n: number) => (text: string) => parseMessages(text).length >= n;

function seed(store: Store): void {
  store.commit(() => [productCreated()]);
  store.commit(() => [sparMessage('m1', 'one'), sparMessage('m2', 'two')]);
  store.commit(() => [sparMessage('m3', 'three')]);
}

function setup(opts: { heartbeatMs?: number } = {}) {
  const deps = setupStore();
  const unsubscribed = vi.fn();
  // Wrap the public subscribe so the test can see the route clean up after a disconnect.
  const store: Store = {
    ...deps.store,
    subscribe(fn) {
      const off = deps.store.subscribe(fn);
      return () => {
        unsubscribed();
        off();
      };
    },
  };
  const app = createApp({ ...deps, store, heartbeatMs: opts.heartbeatMs });
  return { ...deps, store, app, unsubscribed };
}

describe('GET /api/events', () => {
  it('sets SSE headers including X-Accel-Buffering: no', async () => {
    const { app } = setup();
    const res = await app.request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    await res.body?.cancel();
  });

  it('replays only events with seq > Last-Event-ID, then streams new commits', async () => {
    const { app, store } = setup();
    seed(store); // seqs 1..4
    const res = await app.request('/api/events', { headers: { 'Last-Event-ID': '2' } });
    const sse = sseReader(res);

    const replayed = parseMessages(await sse.until(countMessages(2)));
    expect(replayed.map((m) => m.id)).toEqual(['3', '4']);

    store.commit(() => [sparMessage('m4', 'live')]);
    const all = parseMessages(await sse.until(countMessages(3)));
    expect(all.map((m) => m.id)).toEqual(['3', '4', '5']);
    const live = parseEvent(JSON.parse(all[2]?.data.join('\n') ?? ''));
    expect(live).toMatchObject({ seq: 5, type: 'spar.message', data: { text: 'live' } });
    await sse.cancel();
  });

  it('accepts ?since= when there is no Last-Event-ID, and the header wins over it', async () => {
    const { app, store } = setup();
    seed(store);
    const bySince = sseReader(await app.request('/api/events?since=3'));
    expect(parseMessages(await bySince.until(countMessages(1))).map((m) => m.id)).toEqual(['4']);
    await bySince.cancel();

    const both = sseReader(
      await app.request('/api/events?since=0', { headers: { 'Last-Event-ID': '3' } }),
    );
    expect(parseMessages(await both.until(countMessages(1))).map((m) => m.id)).toEqual(['4']);
    await both.cancel();
  });

  it('replays everything when no position is given', async () => {
    const { app, store } = setup();
    seed(store);
    const sse = sseReader(await app.request('/api/events'));
    const msgs = parseMessages(await sse.until(countMessages(4)));
    expect(msgs.map((m) => m.id)).toEqual(['1', '2', '3', '4']);
    await sse.cancel();
  });

  it('writes unnamed messages: id = seq, no event field, data parses with parseEvent()', async () => {
    const { app, store } = setup();
    seed(store);
    const sse = sseReader(await app.request('/api/events?since=0'));
    store.commit(() => [sparMessage('m9', 'multi\nline text')]);
    const text = await sse.until(countMessages(5));

    expect(text).not.toMatch(/^event:/m);
    const msgs = parseMessages(text);
    expect(msgs).toHaveLength(5);
    for (const msg of msgs) {
      expect(msg.event).toBeUndefined();
      expect(msg.data).toHaveLength(1);
      const event = parseEvent(JSON.parse(msg.data[0] ?? ''));
      expect(event).not.toBeNull();
      expect(String(event?.seq)).toBe(msg.id);
    }
    expect(msgs.map((m) => m.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(store.eventsSince(0).map((e) => JSON.stringify(e))).toEqual(msgs.map((m) => m.data[0]));
    await sse.cancel();
  });

  it('does not duplicate or drop events committed while the replay is being written', async () => {
    const { app, store } = setup();
    seed(store);
    const sse = sseReader(await app.request('/api/events?since=0'));
    // Commit before anything has been read: the replay is still pending on backpressure.
    store.commit(() => [sparMessage('m5', 'during replay')]);
    store.commit(() => [sparMessage('m6', 'also during replay')]);
    const msgs = parseMessages(await sse.until(countMessages(6)));
    expect(msgs.map((m) => m.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    store.commit(() => [sparMessage('m7', 'after')]);
    const after = parseMessages(await sse.until(countMessages(7)));
    expect(after.map((m) => m.id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    await sse.cancel();
  });

  it('sends :hb comment heartbeats', async () => {
    expect(HEARTBEAT_MS).toBe(15_000);
    const { app } = setup({ heartbeatMs: 10 });
    const sse = sseReader(await app.request('/api/events'));
    const text = await sse.until((t) => t.includes(':hb\n\n'));
    expect(parseMessages(text)).toEqual([]);
    await sse.cancel();
  });

  it('unsubscribes from the store when the client disconnects', async () => {
    const { app, store, unsubscribed } = setup();
    seed(store);
    const sse = sseReader(await app.request('/api/events?since=3'));
    await sse.until(countMessages(1));
    expect(unsubscribed).not.toHaveBeenCalled();
    await sse.cancel();
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(1));
    // Commits after the disconnect still succeed.
    expect(store.commit(() => [sparMessage('m8', 'later')])).toHaveLength(1);
  });

  it.each(['abc', '-1', '1.5', '1e3'])('rejects an invalid position %j with 400', async (v) => {
    const { app } = setup();
    for (const res of [
      await app.request('/api/events', { headers: { 'Last-Event-ID': v } }),
      await app.request(`/api/events?since=${encodeURIComponent(v)}`),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid' } });
    }
  });

  it('treats an empty Last-Event-ID as absent and falls back to ?since=', async () => {
    const { app, store } = setup();
    seed(store);
    const sse = sseReader(
      await app.request('/api/events?since=3', { headers: { 'Last-Event-ID': '' } }),
    );
    expect(parseMessages(await sse.until(countMessages(1))).map((m) => m.id)).toEqual(['4']);
    await sse.cancel();
  });
});
