import { describe, expect, it } from 'vitest';
import { GitTokenViewSchema } from '../../../shared/dto.ts';
import { createGitTokens } from '../../commands/index.ts';
import { createSecrets, gitTokenSecret } from '../../security/index.ts';
import { createApp } from '../app.ts';
import { productCreated, setupStore, TEST_PRODUCT } from '../testing.ts';

// GET|PUT /api/products/:id/git-token: the product's git remote token, write-only.

const TOKEN = 'ghp_RemoteTokenForPush1234abcd';

function setup() {
  const base = setupStore();
  base.store.commit(() => [productCreated()]);
  const secrets = createSecrets(base);
  const app = createApp({
    store: base.store,
    redactor: base.redactor,
    ids: base.ids,
    git: base.git,
    gitTokens: createGitTokens({ store: base.store, secrets }),
  });
  const call = async (method: 'GET' | 'PUT', body?: unknown, id: string = TEST_PRODUCT) => {
    const res = await app.request(`/api/products/${id}/git-token`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  };
  return { ...base, secrets, call };
}

describe('product git token', () => {
  it('is unset at first', async () => {
    const { call } = setup();
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(GitTokenViewSchema.parse(JSON.parse(res.text))).toEqual({ set: false, last4: null });
  });

  it('stores the token in secrets and only ever shows its last 4 characters', async () => {
    const { call, secrets, store, redactor } = setup();
    const put = await call('PUT', { token: TOKEN });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text)).toEqual({ set: true, last4: 'abcd' });
    expect(put.text).not.toContain(TOKEN);
    expect((await call('GET')).text).not.toContain(TOKEN);
    expect(secrets.get(gitTokenSecret(TEST_PRODUCT))).toBe(TOKEN);
    // Never in events or state; registered with the redactor.
    expect(JSON.stringify(store.eventsSince(0))).not.toContain(TOKEN);
    expect(JSON.stringify(store.snapshot())).not.toContain(TOKEN);
    expect(redactor.redact(`token=${TOKEN}`)).not.toContain(TOKEN);
  });

  it('removes the token with null', async () => {
    const { call, secrets } = setup();
    await call('PUT', { token: TOKEN });
    const res = await call('PUT', { token: null });
    expect(JSON.parse(res.text)).toEqual({ set: false, last4: null });
    expect(secrets.get(gitTokenSecret(TEST_PRODUCT))).toBeUndefined();
  });

  it('rejects invalid tokens with 400 and unknown products with 404', async () => {
    const { call, secrets } = setup();
    expect((await call('PUT', { token: 'short' })).status).toBe(400);
    expect((await call('PUT', { token: 'has white space here' })).status).toBe(400);
    expect((await call('PUT', {})).status).toBe(400);
    expect((await call('PUT', { token: TOKEN }, 'product-unknown')).status).toBe(404);
    expect((await call('GET', undefined, 'product-unknown')).status).toBe(404);
    expect(secrets.list()).toEqual([]);
  });

  it('the 400 for a bad token does not echo it', async () => {
    const { call } = setup();
    const bad = `${TOKEN} x`;
    const res = await call('PUT', { token: bad });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(TOKEN);
  });
});
