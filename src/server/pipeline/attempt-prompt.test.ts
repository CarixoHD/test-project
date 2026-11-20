import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import { ProductIdSchema, type IssueId } from '../../shared/ids.ts';
import { addIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { implementerPrompt, reviewerPrompt, tailLines } from './index.ts';

const P = ProductIdSchema.parse('product-1');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vibecode-attempt-prompt-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (type: string, entityId: string | null, data: object) =>
  ({ type, productId: P, entityId, v: 1, data }) as EventDraft;

function setup(): { store: Store; issueId: IssueId } {
  const ids = new FakeIdGen();
  const store = createStore({
    db: open(':memory:'),
    clock: new FakeClock(1),
    redactor: new Redactor(),
  });
  store.commit(() => [
    draft('product.created', null, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 1,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    }),
  ]);
  const r = addIssue({ store, ids }, P, {
    title: 'List todos',
    body: 'Show todos.',
    dependsOn: [],
  });
  if (!r.ok) throw new Error(r.reason);
  return { store, issueId: r.issueId };
}

const sha = 'a'.repeat(40);

describe('implementerPrompt', () => {
  it('includes the issue, the PRD, AGENTS.md and the previous attempt feedback', async () => {
    const { store, issueId } = setup();
    store.commit(() => [
      draft('attempt.started', 'att-1', { issueId, n: 1, issueRev: 1, baseSha: sha, branch: 'b' }),
      draft('attempt.ended', 'att-1', {
        issueId,
        status: 'error',
        counted: false,
        headSha: null,
        feedback: 'check failed: expected 2 todos',
        review: null,
        checkExit: 1,
        interruptReason: null,
      }),
    ]);
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'docs', 'PRD.md'), '# Todo PRD\n');
    await writeFile(path.join(dir, 'AGENTS.md'), 'Run npm test.\n');
    const issue = store.q.issue(issueId);
    if (issue === null) throw new Error('no issue');

    const { instructions, prompt } = await implementerPrompt({
      store,
      issue,
      productName: 'Todo',
      worktree: dir,
      checkCommand: ['npm', 'test'],
    });

    expect(instructions).toContain('Issue #1: List todos');
    expect(instructions).toContain('Show todos.');
    expect(instructions).toContain('# Todo PRD');
    expect(instructions).toContain('Run npm test.');
    expect(instructions).toContain('check failed: expected 2 todos');
    expect(instructions).toContain('`npm test`');
    expect(prompt).toMatch(/test-first/);
  });

  it('says so when AGENTS.md, the PRD and feedback are missing', async () => {
    const { store, issueId } = setup();
    const issue = store.q.issue(issueId);
    if (issue === null) throw new Error('no issue');
    const { instructions } = await implementerPrompt({
      store,
      issue,
      productName: 'Todo',
      worktree: dir,
      checkCommand: ['npm', 'test'],
    });
    expect(instructions).toContain('(the repository has no AGENTS.md)');
    expect(instructions).toContain('(docs/PRD.md is missing)');
    expect(instructions).toMatch(/previous attempt\n\n\(none\)/);
  });
});

describe('reviewerPrompt', () => {
  it('includes the issue, the check output and the diff', () => {
    const { store, issueId } = setup();
    const issue = store.q.issue(issueId);
    if (issue === null) throw new Error('no issue');
    const { instructions } = reviewerPrompt({
      issue,
      productName: 'Todo',
      checkCommand: ['npm', 'test'],
      checkExit: 0,
      checkOutput: 'all 3 tests passed',
      diff: '+++ b/todo.ts\n+export const todos = [];',
    });
    expect(instructions).toContain('Issue #1: List todos');
    expect(instructions).toContain('exit code 0');
    expect(instructions).toContain('all 3 tests passed');
    expect(instructions).toContain('+export const todos = [];');
  });
});

describe('tailLines', () => {
  it('keeps the last n lines', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
    expect(tailLines('a\nb', 5)).toBe('a\nb');
  });
});
