import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateResponseSchema } from '../shared/dto.ts';
import { parseEvent, type Event } from '../shared/events.ts';
import { InboxIdSchema } from '../shared/ids.ts';
import { parseConfig } from './config.ts';
import { start, type Running } from './main.ts';

describe('start (composition root)', () => {
  let root: string | undefined;
  let running: Running | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('binds 127.0.0.1 by default, creates the data dir and DB, and serves /api/state', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const dataDir = join(root, 'data');
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: dataDir }), port: 0 };
    expect(config.host).toBe('127.0.0.1');

    running = await start(config, join(root, 'no-web'));
    expect(running.address.host).toBe('127.0.0.1');
    expect(existsSync(join(dataDir, 'vibecode.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'empty'))).toBe(true);

    const res = await fetch(`http://127.0.0.1:${String(running.address.port)}/api/state`);
    expect(res.status).toBe(200);
    expect(StateResponseSchema.parse(await res.json()).lastSeq).toBe(0);
  });

  it('runs the inbox hook: a limiting event yields an inbox item in snapshot, SSE and mark-read', async () => {
    root = mkdtempSync(join(tmpdir(), 'vibecode-main-'));
    const config = { ...parseConfig({ VIBECODE_DATA_DIR: join(root, 'data') }), port: 0 };
    running = await start(config, join(root, 'no-web'));
    const base = `http://127.0.0.1:${String(running.address.port)}`;

    const events = await fetch(`${base}/api/events?since=0`);
    const committed = running.store.commit(() => [
      {
        type: 'backend.limited',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code', until: null, needsLogin: false, reason: 'quota' },
      },
    ]);
    // The hook's inbox.created lands in the same commit as the triggering event.
    expect(committed.map((e) => e.type)).toEqual(['backend.limited', 'inbox.created']);

    const state = StateResponseSchema.parse(await (await fetch(`${base}/api/state`)).json());
    const items = Object.entries(state.state.inbox);
    expect(items).toHaveLength(1);
    const [rawId, item] = items[0] ?? [];
    const inboxId = InboxIdSchema.parse(rawId);
    expect(item).toMatchObject({
      kind: 'rate_limited',
      title: 'Claude Code rate limited',
      read: false,
    });

    const streamed = await readEvents(events, (es) => es.some((e) => e.type === 'inbox.created'));
    expect(streamed.find((e) => e.type === 'inbox.created')).toMatchObject({
      entityId: inboxId,
      data: { kind: 'rate_limited' },
    });

    const read = await fetch(`${base}/api/inbox/${inboxId}/read`, { method: 'POST' });
    expect(read.status).toBe(200);
    const after = StateResponseSchema.parse(await (await fetch(`${base}/api/state`)).json());
    expect(after.state.inbox[inboxId]?.read).toBe(true);
  });
});

/** Reads SSE `data:` lines from `res` until `done(events)` holds, then cancels the stream. */
async function readEvents(
  res: Response,
  done: (events: Event[]) => boolean,
  timeoutMs = 2000,
): Promise<Event[]> {
  if (res.body === null) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = '';
  const parse = () =>
    text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => parseEvent(JSON.parse(line.slice(5))))
      .filter((e): e is Event => e !== null);
  try {
    while (!done(parse())) {
      if (Date.now() > deadline) throw new Error(`timed out; stream so far:\n${text}`);
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`stream ended; stream so far:\n${text}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return parse();
  } finally {
    await reader.cancel();
  }
}
