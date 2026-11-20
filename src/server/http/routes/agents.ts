import { open } from 'node:fs/promises';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AgentIdSchema, type AgentId } from '../../../shared/ids.ts';
import { agentLogPath } from '../../pipeline/index.ts';
import type { Store } from '../../store/index.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import { HEARTBEAT_MS } from './events.ts';

/** How often a followed log file is checked for new lines (events of the agent also wake it). */
export const LOG_POLL_MS = 500;
const NEWLINE = 0x0a;

const LogEntrySchema = z.object({ ts: z.number(), line: z.string() });

type Redactor = AppDeps['redactor'];

/**
 * One stored NDJSON line, redacted again on the way out (a secret may have been registered
 * after it was written). Malformed lines are dropped rather than passed through unchecked.
 */
function redactEntry(raw: string, redactor: Redactor): string | null {
  if (raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = LogEntrySchema.safeParse(parsed);
  if (!entry.success) return null;
  return JSON.stringify({ ts: entry.data.ts, line: redactor.redact(entry.data.line) });
}

/**
 * Reads complete lines of a growing file from a byte offset. A trailing line without its
 * newline stays unread until it is complete, so a line being written is never split.
 */
class LogTail {
  #offset = 0;
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async read(): Promise<string[]> {
    let handle;
    try {
      handle = await open(this.#file, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (size <= this.#offset) return [];
      const buf = Buffer.alloc(size - this.#offset);
      const { bytesRead } = await handle.read(buf, 0, buf.length, this.#offset);
      const end = buf.subarray(0, bytesRead).lastIndexOf(NEWLINE);
      if (end === -1) return [];
      this.#offset += end + 1;
      return buf.subarray(0, end).toString('utf8').split('\n');
    } finally {
      await handle.close();
    }
  }
}

function knownAgent(store: Store, raw: string): { id: AgentId; exited: () => boolean } {
  const id = AgentIdSchema.parse(raw);
  if (store.q.agent(id) === null) throw new HttpError('not_found', `No agent ${raw}`);
  return { id, exited: () => store.q.agent(id)?.endedAt != null };
}

/**
 * GET /api/agents/:id/log → the agent's full log as redacted JSON lines `{ts, line}`
 * (`application/x-ndjson`; empty before the first line). `?follow=1` → SSE: one unnamed
 * message per line (existing lines first), then new lines as they are written, and a final
 * `event: end` once the agent has exited and its log is fully sent. Unknown agent → 404.
 */
export function registerAgentRoutes(
  app: Hono,
  { store, redactor, heartbeatMs, logPollMs }: AppDeps,
  logsDir: string,
): void {
  app.get('/api/agents/:id/log', async (c) => {
    const agent = knownAgent(store, c.req.param('id'));
    const tail = new LogTail(agentLogPath(logsDir, agent.id));
    const redacted = (lines: string[]) =>
      lines.map((l) => redactEntry(l, redactor)).filter((l) => l !== null);

    if (c.req.query('follow') !== '1') {
      const lines = redacted(await tail.read());
      const body = lines.map((l) => `${l}\n`).join('');
      return c.body(body, 200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    }

    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      // `dirty` keeps a wake-up that arrives while lines are being read or written.
      let dirty = false;
      let wake: (() => void) | undefined;
      const signal = () => {
        dirty = true;
        const w = wake;
        wake = undefined;
        w?.();
      };
      let open = true;
      const close = () => {
        open = false;
        signal();
      };
      stream.onAbort(close);
      c.req.raw.signal.addEventListener('abort', close, { once: true });
      // Lines reach the file before the agent's batched activity / exit events are committed.
      const unsubscribe = store.subscribe((e) => {
        if (e.entityId === agent.id) signal();
      });
      const poll = setInterval(signal, logPollMs ?? LOG_POLL_MS);
      const heartbeat = setInterval(() => {
        void stream.write(':hb\n\n');
      }, heartbeatMs ?? HEARTBEAT_MS);

      try {
        while (open) {
          dirty = false;
          // Checked before reading: the exit line is written before `agent.exited` commits.
          const exited = agent.exited();
          for (const data of redacted(await tail.read())) await stream.writeSSE({ data });
          if (exited) {
            await stream.writeSSE({ event: 'end', data: '{}' });
            break;
          }
          if (!dirty) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      } finally {
        clearInterval(poll);
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });
}
