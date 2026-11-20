import { describe, expect, it } from 'vitest';
import { GIT_REMOTE_URL_ERROR } from '../../shared/git-remote.ts';
import { ProductIdSchema } from '../../shared/ids.ts';
import { createApp } from '../http/index.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../http/testing.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { DEFAULT_PRODUCT_SETTINGS, updateProductSettings } from './index.ts';

function setup() {
  const deps = setupStore();
  deps.store.commit(() => [productCreated()]);
  const app = createApp(deps);
  return { ...deps, app };
}

const settingsEvents = (store: ReturnType<typeof setup>['store']) =>
  store.eventsSince(0).filter((e) => e.type === 'product.settings_changed');

const patch = (app: ReturnType<typeof setup>['app'], body: unknown, id: string = TEST_PRODUCT) =>
  app.request(`/api/products/${id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('default product settings', () => {
  it('runs 3 agents in parallel and allows 3 attempts', () => {
    expect(DEFAULT_PRODUCT_SETTINGS.maxParallel).toBe(3);
    expect(DEFAULT_PRODUCT_SETTINGS.maxAttempts).toBe(3);
  });
});

describe('updateProductSettings', () => {
  it('emits product.settings_changed with only the given fields', () => {
    const { store, ids } = setup();
    const result = updateProductSettings({ store, ids }, TEST_PRODUCT, {
      budgetUsd: 25,
      maxParallel: 5,
    });

    expect(result.ok).toBe(true);
    const events = settingsEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      productId: TEST_PRODUCT,
      entityId: null,
      data: { budgetUsd: 25, maxParallel: 5 },
    });
    expect(Object.keys(events[0]?.data ?? {}).sort()).toEqual(['budgetUsd', 'maxParallel']);
    expect(store.q.product(TEST_PRODUCT)?.settings).toMatchObject({
      budgetUsd: 25,
      maxParallel: 5,
      maxAttempts: 3,
    });
    expectSnapshotMatchesReplay(store);
  });

  it('merges model overrides per role; null removes a role override', () => {
    const { store, ids } = setup();
    const deps = { store, ids };
    updateProductSettings(deps, TEST_PRODUCT, {
      models: {
        implementer: { provider: 'anthropic', model: 'claude-x' },
        reviewer: { provider: 'openai', model: 'gpt-x' },
      },
    });
    updateProductSettings(deps, TEST_PRODUCT, {
      models: { reviewer: null, sparring: { provider: 'google', model: 'gem' } },
    });

    expect(store.q.product(TEST_PRODUCT)?.settings.models).toEqual({
      implementer: { provider: 'anthropic', model: 'claude-x' },
      sparring: { provider: 'google', model: 'gem' },
    });
    expectSnapshotMatchesReplay(store);
  });

  it('sets and clears the budget and the git remote', () => {
    const { store, ids } = setup();
    const deps = { store, ids };
    updateProductSettings(deps, TEST_PRODUCT, { gitRemote: { url: 'git@example.com:me/a.git' } });
    expect(store.q.product(TEST_PRODUCT)?.settings.gitRemote).toEqual({
      url: 'git@example.com:me/a.git',
    });
    updateProductSettings(deps, TEST_PRODUCT, { budgetUsd: null, gitRemote: null });
    expect(store.q.product(TEST_PRODUCT)?.settings).toMatchObject({
      budgetUsd: null,
      gitRemote: null,
    });
    expectSnapshotMatchesReplay(store);
  });

  it('refuses an unknown product with not_found', () => {
    const { store, ids } = setup();
    const result = updateProductSettings({ store, ids }, ProductIdSchema.parse('nope'), {
      maxParallel: 2,
    });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    expect(settingsEvents(store)).toEqual([]);
  });

  it.each([
    [{}],
    [{ budgetUsd: 0 }],
    [{ budgetUsd: -1 }],
    [{ maxParallel: 0 }],
    [{ maxParallel: 11 }],
    [{ maxParallel: 2.5 }],
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 11 }],
    [{ models: { implementer: { provider: 'nope', model: 'x' } } }],
    [{ models: { implementer: { provider: 'openai', model: '' } } }],
    [{ models: { janitor: { provider: 'openai', model: 'x' } } }],
    [{ gitRemote: { url: '' } }],
    [{ gitRemote: { url: 'ext::sh -c touch% /tmp/x' } }],
    [{ gitRemote: { url: 'https://user:token@example.com/r.git' } }],
    [{ color: 'red' }],
  ])('refuses %j as invalid without emitting', (input) => {
    const { store, ids } = setup();
    const result = updateProductSettings({ store, ids }, TEST_PRODUCT, input as never);
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(settingsEvents(store)).toEqual([]);
  });

  it('accepts the range boundaries', () => {
    const { store, ids } = setup();
    const deps = { store, ids };
    expect(updateProductSettings(deps, TEST_PRODUCT, { maxParallel: 1, maxAttempts: 10 }).ok).toBe(
      true,
    );
    expect(updateProductSettings(deps, TEST_PRODUCT, { maxParallel: 10, maxAttempts: 1 }).ok).toBe(
      true,
    );
    expect(updateProductSettings(deps, TEST_PRODUCT, { budgetUsd: 0.01 }).ok).toBe(true);
  });
});

describe('PATCH /api/products/:id/settings', () => {
  it('answers {ok:true} and emits product.settings_changed', async () => {
    const { app, store } = setup();
    const res = await patch(app, {
      maxAttempts: 4,
      models: { reviewer: { provider: 'anthropic', model: 'claude-y' } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(settingsEvents(store).map((e) => e.data)).toEqual([
      { maxAttempts: 4, models: { reviewer: { provider: 'anthropic', model: 'claude-y' } } },
    ]);
    expectSnapshotMatchesReplay(store);
  });

  it.each([
    ['an empty body', {}],
    ['maxParallel above 10', { maxParallel: 11 }],
    ['maxAttempts below 1', { maxAttempts: 0 }],
    ['a zero budget', { budgetUsd: 0 }],
    ['a string budget', { budgetUsd: '5' }],
    ['an unknown field', { foo: 1 }],
    ['a non-object body', [1]],
    ['invalid JSON', '{"maxParallel":'],
  ])('answers 400 invalid for %s', async (_label, body) => {
    const { app, store } = setup();
    const res = await patch(app, body);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('invalid');
    expect(json.error.message).not.toBe('');
    expect(settingsEvents(store)).toEqual([]);
  });

  it.each([
    ['ext::', 'ext::sh -c id'],
    ['file://', 'file:///etc/passwd'],
    ['http://', 'http://example.com/r.git'],
    ['a local path', '/srv/repos/a.git'],
    ['a token in userinfo', 'https://token@example.com/r.git'],
    ['a password in userinfo', 'https://user:pw@example.com/r.git'],
    ['a leading -', '--upload-pack=x'],
    ['a newline', 'https://example.com/r.git\nx'],
  ])('answers 400 with a gitRemote.url field error for %s and stores nothing', async (_l, url) => {
    const { app, store } = setup();
    const res = await patch(app, { gitRemote: { url } });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error).toEqual({
      code: 'invalid',
      message: `gitRemote.url: ${GIT_REMOTE_URL_ERROR}`,
    });
    expect(settingsEvents(store)).toEqual([]);
    expect(store.q.product(TEST_PRODUCT)?.settings.gitRemote).toBeNull();
  });

  it.each(['git@example.com:me/a.git', 'https://example.com/r.git', 'ssh://git@h.io:22/a.git'])(
    'stores the valid remote %s',
    async (url) => {
      const { app, store } = setup();
      const res = await patch(app, { gitRemote: { url } });
      expect(res.status).toBe(200);
      expect(store.q.product(TEST_PRODUCT)?.settings.gitRemote).toEqual({ url });
    },
  );

  it('replays a git remote stored before the URL rule and lets the owner replace it', async () => {
    const { app, store } = setup();
    const legacy = 'https://user:token@example.com/r.git';
    store.commit(() => [
      {
        type: 'product.settings_changed',
        productId: TEST_PRODUCT,
        entityId: null,
        v: 1,
        data: { gitRemote: { url: legacy } },
      },
    ]);
    expect(settingsEvents(store).map((e) => e.data)).toEqual([{ gitRemote: { url: legacy } }]);
    expect(store.q.product(TEST_PRODUCT)?.settings.gitRemote).toEqual({ url: legacy });
    expectSnapshotMatchesReplay(store);
    expect((await app.request('/api/state')).status).toBe(200);

    const res = await patch(app, { gitRemote: { url: 'https://example.com/r.git' } });
    expect(res.status).toBe(200);
    expect(store.q.product(TEST_PRODUCT)?.settings.gitRemote).toEqual({
      url: 'https://example.com/r.git',
    });
  });

  it('answers 404 for an unknown product', async () => {
    const { app } = setup();
    const res = await patch(app, { maxParallel: 2 }, 'product-unknown');
    expect(res.status).toBe(404);
  });
});
