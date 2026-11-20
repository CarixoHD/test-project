import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateProductResponseSchema } from '../../shared/dto.ts';
import { ProductIdSchema } from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { createGit, type Git } from '../git/index.ts';
import { createApp } from '../http/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { createProduct, type CreateProductDeps } from './index.ts';

let dataDir: string;

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'vibecode-create-product-')));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function setup(git: Git = createGit({ dataDir })) {
  const db = open(':memory:');
  const redactor = new Redactor();
  const store = createStore({ db, clock: new FakeClock(1_700_000_000_000), redactor });
  const deps: CreateProductDeps = { store, ids: new FakeIdGen(), git };
  const app = createApp({ ...deps, git, redactor });
  return { ...deps, git, app };
}

const post = (app: ReturnType<typeof setup>['app'], body: unknown) =>
  app.request('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('createProduct', () => {
  it('commits product.created with the default settings and returns the new id', async () => {
    const deps = setup();
    const result = await createProduct(deps, { name: 'Todo app', idea: 'Track my todos' });

    expect(result).toEqual({ ok: true, id: 'product-000001' });
    const events = deps.store.eventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'product.created',
      productId: 'product-000001',
      entityId: null,
      data: {
        name: 'Todo app',
        idea: 'Track my todos',
        budgetUsd: null,
        maxParallel: 3,
        maxAttempts: 3,
        models: {},
        gitRemote: null,
      },
    });
    const product = deps.store.q.product(ProductIdSchema.parse('product-000001'));
    expect(product).toMatchObject({ name: 'Todo app', phase: 'sparring', paused: false });
  });

  it('creates the bare repo with an initial commit on main', async () => {
    const deps = setup();
    const result = await createProduct(deps, { name: 'Todo app', idea: 'Track my todos' });
    if (!result.ok) throw new Error(result.reason);

    expect(await deps.git.mainSha(result.id)).toMatch(/^[0-9a-f]{40}$/);
    expect(await deps.git.readFileAtMain(result.id, 'README.md')).toContain(result.id);
  });

  it('trims the name and idea', async () => {
    const deps = setup();
    await createProduct(deps, { name: '  Todo  ', idea: '\n Track todos \n' });
    expect(deps.store.eventsSince(0)[0]?.data).toMatchObject({ name: 'Todo', idea: 'Track todos' });
  });

  it.each([
    [{ name: '', idea: 'x' }, /name/i],
    [{ name: '   ', idea: 'x' }, /name/i],
    [{ name: 'n'.repeat(81), idea: 'x' }, /name/i],
    [{ name: 'Todo', idea: '' }, /idea/i],
    [{ name: 'Todo', idea: 'i'.repeat(4001) }, /idea/i],
  ])('rejects %j without creating anything', async (input, reason) => {
    const deps = setup();
    const result = await createProduct(deps, input);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    expect(deps.store.eventsSince(0)).toEqual([]);
  });

  it('accepts the boundary lengths', async () => {
    const deps = setup();
    const result = await createProduct(deps, { name: 'n'.repeat(80), idea: 'i'.repeat(4000) });
    expect(result.ok).toBe(true);
  });

  it('commits nothing when the repo cannot be created', async () => {
    const git = createGit({ dataDir });
    const failing: Git = {
      ...git,
      initRepo: () => Promise.reject(new Error('disk full')),
    };
    const deps = setup(failing);
    await expect(createProduct(deps, { name: 'Todo', idea: 'x' })).rejects.toThrow('disk full');
    expect(deps.store.eventsSince(0)).toEqual([]);
  });

  it('keeps snapshot and replay equal after several products', async () => {
    const deps = setup();
    await createProduct(deps, { name: 'One', idea: 'First' });
    await createProduct(deps, { name: 'Two', idea: 'Second' });
    expectSnapshotMatchesReplay(deps.store);
  });
});

describe('POST /api/products', () => {
  it('answers 201 {id} and creates the product, its event and its bare repo', async () => {
    const { app, store, git } = setup();
    const res = await post(app, { name: 'Todo app', idea: 'Track my todos' });

    expect(res.status).toBe(201);
    const { id } = CreateProductResponseSchema.parse(await res.json());
    expect(store.eventsSince(0).map((e) => [e.type, e.productId])).toEqual([
      ['product.created', id],
    ]);
    expect(await git.mainSha(id)).toMatch(/^[0-9a-f]{40}$/);
    expectSnapshotMatchesReplay(store);
  });

  it.each([
    ['an empty name', { name: '', idea: 'x' }],
    ['a too long idea', { name: 'Todo', idea: 'i'.repeat(4001) }],
    ['a missing idea', { name: 'Todo' }],
    ['a non-object body', [1, 2]],
    ['invalid JSON', '{"name":'],
  ])('answers 400 {error:{code,message}} for %s', async (_label, body) => {
    const { app, store } = setup();
    const res = await post(app, body);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('invalid');
    expect(json.error.message).not.toBe('');
    expect(store.eventsSince(0)).toEqual([]);
  });
});
