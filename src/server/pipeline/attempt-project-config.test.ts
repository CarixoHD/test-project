import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../llm/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import {
  defaultScript,
  P,
  PROJECT,
  setupAttempt,
  type HarnessOptions,
  type SpawnedAgent,
} from './attempt-testing.ts';

// After an attempt advances main, product.project follows main's .vibecode/project.json.

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-attempt-project-')));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const PREVIEW = { command: ['npm', 'start'], port: 3000 };

/** The implementer writes `.vibecode/project.json` with `content`; the reviewer approves. */
const writesProjectJson =
  (content: string) =>
  (agent: SpawnedAgent): FakeScript | undefined =>
    agent.role === 'implementer'
      ? [
          {
            toolCalls: [{ name: 'write_file', input: { path: '.vibecode/project.json', content } }],
          },
          { toolCalls: [{ name: 'finish', input: { summary: 'Configured preview' } }] },
        ]
      : defaultScript(agent);

async function setup(o: HarnessOptions = {}) {
  const h = await setupAttempt(dataDir, o);
  const logged: string[] = [];
  h.deps.log = (line) => logged.push(line);
  return { ...h, logged };
}

const typesOf = (h: Awaited<ReturnType<typeof setup>>) => h.store.eventsSince(0).map((e) => e.type);

describe('runAttempt: project.json merged by an implementer', () => {
  it('sets product.project from main right after the merge', async () => {
    const config = { ...PROJECT, preview: PREVIEW };
    const h = await setup({ script: writesProjectJson(JSON.stringify(config)) });
    const id = h.addIssue('Preview');

    await h.run(id);

    expect(h.store.q.issue(id)?.status).toBe('completed');
    expect(h.store.q.product(P)?.project).toEqual(config);
    const types = typesOf(h);
    const completed = types.indexOf('issue.completed');
    expect(completed).toBeGreaterThan(-1);
    expect(types.lastIndexOf('product.settings_changed')).toBeGreaterThan(completed);
    const last = h.store
      .eventsSince(0)
      .filter((e) => e.type === 'product.settings_changed')
      .at(-1);
    expect(last?.data).toEqual({ project: config });
    expect(h.logged).toEqual([]);
    expectSnapshotMatchesReplay(h.store);
  });

  it('emits no product.settings_changed when main has the same config', async () => {
    const h = await setup({ script: writesProjectJson(JSON.stringify(PROJECT)) });
    const id = h.addIssue('Same');
    const before = typesOf(h).filter((t) => t === 'product.settings_changed').length;

    await h.run(id);

    expect(h.store.q.issue(id)?.status).toBe('completed');
    expect(typesOf(h).filter((t) => t === 'product.settings_changed')).toHaveLength(before);
    expect(h.store.q.product(P)?.project).toEqual(PROJECT);
  });

  it('emits no product.settings_changed when the attempt does not touch project.json', async () => {
    const h = await setup();
    const id = h.addIssue('Unrelated');
    const before = typesOf(h).filter((t) => t === 'product.settings_changed').length;

    await h.run(id);

    expect(h.store.q.issue(id)?.status).toBe('completed');
    expect(typesOf(h).filter((t) => t === 'product.settings_changed')).toHaveLength(before);
    expect(h.store.q.product(P)?.project).toEqual(PROJECT);
    // The harness repo has no project.json on main: the config is kept, with a warning.
    expect(h.logged).toEqual([expect.stringMatching(/project\.json is missing on main/)]);
  });

  it.each([
    ['not JSON', '{ "check": '],
    ['not a ProjectConfig', JSON.stringify({ check: 'npm test', preview: PREVIEW })],
  ])('keeps the config and still merges when project.json is %s', async (_what, content) => {
    const h = await setup({ script: writesProjectJson(content) });
    const id = h.addIssue('Broken');
    const before = typesOf(h).filter((t) => t === 'product.settings_changed').length;

    await h.run(id);

    expect(h.store.q.issue(id)?.status).toBe('completed');
    expect(h.store.q.attemptsByIssue(id)[0]?.status).toBe('merged');
    expect(await h.git.readFileAtMain(P, '.vibecode/project.json')).toBe(content);
    expect(h.store.q.product(P)?.project).toEqual(PROJECT);
    expect(typesOf(h).filter((t) => t === 'product.settings_changed')).toHaveLength(before);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatch(/project\.json/);
  });
});
