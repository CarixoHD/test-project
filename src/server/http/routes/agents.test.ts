import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '../../../shared/events.ts';
import { AgentIdSchema } from '../../../shared/ids.ts';
import { agentLogPath } from '../../pipeline/index.ts';
import { createApp } from '../app.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../testing.ts';

const AGENT = AgentIdSchema.parse('agent-1');
const SECRET = 'sk-test-secret-0123456789abcdef';

let logsDir: string | undefined;

afterEach(() => {
  if (logsDir !== undefined) rmSync(logsDir, { recursive: true, force: true });
  logsDir = undefined;
});

const agentEvent = (type: 'agent.spawned' | 'agent.exited'): EventDraft =>
  type === 'agent.spawned'
    ? {
        type,
        productId: TEST_PRODUCT,
        entityId: AGENT,
        v: 1,
        data: {
          role: 'implementer',
          model: { provider: 'fake', model: 'fake' },
          issueId: null,
          attemptId: null,
        },
      }
    : { type, productId: TEST_PRODUCT, entityId: AGENT, v: 1, data: { outcome: 'ok' } };

function setup() {
  const base = setupStore();
  logsDir = mkdtempSync(join(tmpdir(), 'vibecode-agent-log-'));
  base.store.commit(() => [productCreated(), agentEvent('agent.spawned')]);
  const app = createApp({ ...base, logsDir, logPollMs: 20 });
  const dir = logsDir;
  const append = (ts: number, line: string) => {
    appendFileSync(agentLogPath(dir, AGENT), `${JSON.stringify({ ts, line })}\n`);
  };
  return { ...base, app, append };
}

/** Reads an SSE body until `done(text)` holds; fails after `timeoutMs`. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { text: string },
  done: (text: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (!done(state.text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out; stream so far:\n${state.text}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out:\n${state.text}`)), remaining);
    });
    try {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) return state.text;
      state.text += decoder.decode(chunk.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return state.text;
}

/** The `{ts, line}` payloads of the unnamed SSE messages. */
const dataLines = (text: string) =>
  text
    .split('\n\n')
    .filter((block) => !block.split('\n').some((l) => l.startsWith('event:')))
    .flatMap((block) => block.split('\n').filter((l) => l.startsWith('data:')))
    .map((l) => (JSON.parse(l.slice(5).trim()) as { line: string }).line);

describe('GET /api/agents/:id/log', () => {
  it('returns the redacted log as JSON lines', async () => {
    const { app, append, redactor } = setup();
    append(1, 'reading files');
    append(2, `using key ${SECRET}`);
    // Registered after the line was written: the route still masks it.
    redactor.register(SECRET);

    const res = await app.request('/api/agents/agent-1/log');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { ts: number; line: string });
    expect(lines.map((l) => l.ts)).toEqual([1, 2]);
    expect(lines[0]?.line).toBe('reading files');
    expect(lines[1]?.line).toMatch(/^using key /);
  });

  it('returns an empty body for a known agent without a log yet', async () => {
    const { app } = setup();
    const res = await app.request('/api/agents/agent-1/log');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('answers 404 for an unknown agent, also with follow', async () => {
    const { app } = setup();
    const res = await app.request('/api/agents/nope/log');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
    const follow = await app.request('/api/agents/..%2Fsecrets/log?follow=1');
    expect(follow.status).toBe(404);
  });

  it('follow=1 streams existing then new lines, redacted, and ends when the agent exits', async () => {
    const { app, append, redactor, store } = setup();
    redactor.register(SECRET);
    append(1, 'first');

    const res = await app.request('/api/agents/agent-1/log?follow=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (res.body === null) throw new Error('no body');
    const reader = res.body.getReader();
    const state = { text: '' };

    await readUntil(reader, state, (t) => dataLines(t).length >= 1);
    expect(dataLines(state.text)).toEqual(['first']);

    append(2, `second ${SECRET}`);
    await readUntil(reader, state, (t) => dataLines(t).length >= 2);
    expect(state.text).not.toContain(SECRET);
    expect(dataLines(state.text)[1]).toMatch(/^second /);

    append(3, 'exited ok');
    store.commit(() => [agentEvent('agent.exited')]);
    const text = await readUntil(reader, state, (t) => t.includes('event: end'));
    expect(dataLines(text)).toHaveLength(3);
    expect(dataLines(text)[2]).toBe('exited ok');
    // The stream closes after the end message.
    expect((await reader.read()).done).toBe(true);
  });

  it('holds back a line that is still being written until its newline arrives', async () => {
    const { app } = setup();
    const file = agentLogPath(logsDir as string, AGENT);
    appendFileSync(file, `${JSON.stringify({ ts: 1, line: 'whole' })}\n{"ts":2,"li`);

    expect(await (await app.request('/api/agents/agent-1/log')).text()).toBe(
      `${JSON.stringify({ ts: 1, line: 'whole' })}\n`,
    );
    appendFileSync(file, 'ne":"later"}\n');
    const text = await (await app.request('/api/agents/agent-1/log')).text();
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).toContain('"later"');
  });

  it('follow=1 on an agent that already exited sends the whole log and ends', async () => {
    const { app, append, store } = setup();
    append(1, 'only line');
    store.commit(() => [agentEvent('agent.exited')]);

    const res = await app.request('/api/agents/agent-1/log?follow=1');
    const text = await res.text();
    expect(dataLines(text)).toEqual(['only line']);
    expect(text).toContain('event: end');
  });
});
