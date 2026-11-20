import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '../../../shared/events.ts';
import { AttemptIdSchema, IssueIdSchema } from '../../../shared/ids.ts';
import { createApp } from '../app.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../testing.ts';

const ISSUE = IssueIdSchema.parse('issue-1');
const ATTEMPT = AttemptIdSchema.parse('attempt-1');
const SECRET = 'sk-test-secret-0123456789abcdef';

let artifactsDir: string | undefined;

afterEach(() => {
  if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
  artifactsDir = undefined;
});

const issueCreated = (): EventDraft => ({
  type: 'issue.created',
  productId: TEST_PRODUCT,
  entityId: ISSUE,
  v: 1,
  data: {
    issue: {
      id: ISSUE,
      number: 1,
      title: 'Login',
      body: '',
      status: 'open',
      rev: 1,
      priority: 0,
      origin: 'owner',
      prdVersion: 1,
      attemptCount: 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: [],
    },
  },
});

const attemptStarted = (): EventDraft => ({
  type: 'attempt.started',
  productId: TEST_PRODUCT,
  entityId: ATTEMPT,
  v: 1,
  data: { issueId: ISSUE, n: 1, issueRev: 1, baseSha: 'a'.repeat(40), branch: 'vibecode/a1' },
});

function setup() {
  const base = setupStore();
  artifactsDir = mkdtempSync(join(tmpdir(), 'vibecode-artifacts-'));
  base.store.commit(() => [productCreated(), issueCreated(), attemptStarted()]);
  const app = createApp({ ...base, artifactsDir });
  const dir = join(artifactsDir, ATTEMPT);
  const write = (name: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  return { ...base, app, write };
}

describe('GET /api/attempts/:id/diff', () => {
  it('returns the attempt diff as plain text', async () => {
    const { app, write } = setup();
    write('diff.patch', 'diff --git a/x b/x\n+added\n-removed\n');
    const res = await app.request(`/api/attempts/${ATTEMPT}/diff`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('diff --git a/x b/x\n+added\n-removed\n');
  });

  it('redacts registered secrets on the way out', async () => {
    const { app, write, redactor } = setup();
    write('diff.patch', `+const key = '${SECRET}';\n`);
    redactor.register(SECRET);
    const text = await (await app.request(`/api/attempts/${ATTEMPT}/diff`)).text();
    expect(text).not.toContain(SECRET);
  });

  it('is 404 for an unknown attempt', async () => {
    const { app } = setup();
    const res = await app.request('/api/attempts/nope/diff');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('is 404 when the attempt has no diff yet', async () => {
    const { app } = setup();
    const res = await app.request(`/api/attempts/${ATTEMPT}/diff`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('GET /api/attempts/:id/check', () => {
  it('returns the check output as plain text', async () => {
    const { app, write } = setup();
    write('check.log', 'ok 1 tests\n');
    const res = await app.request(`/api/attempts/${ATTEMPT}/check`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('ok 1 tests\n');
  });

  it('appends the re-check on the merge with main under its own heading', async () => {
    const { app, write } = setup();
    write('check.log', 'ok 1 tests\n');
    write('integration-check.log', 'FAIL merged\n');
    const text = await (await app.request(`/api/attempts/${ATTEMPT}/check`)).text();
    expect(text).toBe('ok 1 tests\n\n--- Check on the merge with main ---\nFAIL merged\n');
  });

  it('redacts registered secrets on the way out', async () => {
    const { app, write, redactor } = setup();
    write('check.log', `token ${SECRET}\n`);
    redactor.register(SECRET);
    const text = await (await app.request(`/api/attempts/${ATTEMPT}/check`)).text();
    expect(text).not.toContain(SECRET);
  });

  it('is 404 for an unknown attempt', async () => {
    const { app } = setup();
    expect((await app.request('/api/attempts/nope/check')).status).toBe(404);
  });

  it('is 404 when the check has not run', async () => {
    const { app } = setup();
    expect((await app.request(`/api/attempts/${ATTEMPT}/check`)).status).toBe(404);
  });

  it('does not read outside the artifacts directory', async () => {
    const { app } = setup();
    expect((await app.request('/api/attempts/..%2F..%2Fetc/check')).status).toBe(404);
  });
});
