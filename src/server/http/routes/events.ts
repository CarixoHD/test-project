import type { Context, Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Event } from '../../../shared/events.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';

/** SSE comment heartbeat interval (ADR 5): keeps proxies and the browser from timing out. */
export const HEARTBEAT_MS = 15_000;
/** Replay page size: bounds memory when a client resumes from far back. */
const REPLAY_PAGE = 500;

/** Parses a non-negative integer seq from Last-Event-ID or ?since=; absent/empty → undefined. */
function parseSeq(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new HttpError('invalid', `${name} must be a non-negative integer event seq`);
  }
  return Number(value);
}

/** The position to resume after: Last-Event-ID (browser reconnect) wins over ?since= (first connect). */
function resumeAfter(c: Context): number {
  return (
    parseSeq(c.req.header('Last-Event-ID'), 'Last-Event-ID') ??
    parseSeq(c.req.query('since'), 'since') ??
    0
  );
}

/**
 * Each event is one UNNAMED message (no `event:` field, so `EventSource.onmessage` gets it):
 * `id: <seq>` and `data: <JSON event>`. The web store (src/web/state/store.ts) relies on this.
 */
function writeEvent(stream: SSEStreamingApi, e: Event): Promise<void> {
  return stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
}

/**
 * GET /api/events (ARCHITECTURE §4.3, ADR 5): replays events with seq > the resume position,
 * then streams every new commit, with `:hb` comment heartbeats.
 */
export function registerEventRoutes(app: Hono, { store, heartbeatMs }: AppDeps): void {
  app.get('/api/events', (c) => {
    const since = resumeAfter(c);
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');

    return streamSSE(c, async (stream) => {
      // Subscribe before reading the log: commits are synchronous, so nothing can slip between
      // the two. Live events that the replay also covers are skipped by seq below.
      const pending: Event[] = [];
      let wake: (() => void) | undefined;
      const signal = () => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      const unsubscribe = store.subscribe((e) => {
        pending.push(e);
        signal();
      });
      let open = true;
      const close = () => {
        open = false;
        signal();
      };
      stream.onAbort(close);
      c.req.raw.signal.addEventListener('abort', close, { once: true });
      const heartbeat = setInterval(() => {
        void stream.write(':hb\n\n');
      }, heartbeatMs ?? HEARTBEAT_MS);

      let last = since;
      const send = async (e: Event) => {
        if (e.seq <= last) return;
        last = e.seq;
        await writeEvent(stream, e);
      };

      try {
        for (;;) {
          const page = store.eventsSince(last, REPLAY_PAGE);
          if (page.length === 0 || !open) break;
          for (const e of page) await send(e);
        }
        while (open) {
          const e = pending.shift();
          if (e !== undefined) {
            await send(e);
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });
}
