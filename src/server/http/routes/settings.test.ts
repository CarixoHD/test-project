import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountSettings, SETTING_KEYS } from '../../commands/index.ts';
import {
  API_KEY_MIN_LENGTH,
  SettingsResponseSchema,
  SettingsUpdateResponseSchema,
} from '../../../shared/dto.ts';
import { resolveModel, type Role, type RoleModels } from '../../../shared/models.ts';
import { readSetting } from '../../store/index.ts';
import { API_KEY_SECRETS, model, price, MissingProviderSetupError } from '../../llm/index.ts';
import { createSecrets, MIN_SECRET_LENGTH } from '../../security/index.ts';
import { expectSnapshotMatchesReplay } from '../../store/testing.ts';
import { FakeIdGen } from '../../util/id-gen.ts';
import { createApp } from '../app.ts';
import { productCreated, setupStore, sparMessage } from '../testing.ts';

const ANTHROPIC_KEY = 'sk-ant-api03-SECRETSECRETSECRET-wxyz';
const OPENAI_KEY = 'sk-proj-ANOTHERSECRETVALUE-9876';
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;

function setup() {
  const base = setupStore();
  const secrets = createSecrets(base);
  const settings = createAccountSettings({ store: base.store, db: base.db, secrets });
  const app = createApp({
    store: base.store,
    redactor: base.redactor,
    ids: new FakeIdGen(),
    settings,
  });
  const get = async () => {
    const res = await app.request('/api/settings');
    return { status: res.status, text: await res.text() };
  };
  const put = async (body: unknown) => {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  return { ...base, secrets, settings, app, get, put };
}

/** A fetch stand-in recording each request and answering 401 (no network in tests). */
function recordingFetch() {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    await Promise.resolve();
    requests.push(new Request(input, init));
    return Response.json({ error: { message: 'no' } }, { status: 401 });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/** One model call through the AI SDK provider (the test cannot import `ai` itself). */
async function callOnce(m: ReturnType<typeof model>): Promise<void> {
  if (typeof m === 'string') throw new Error('expected a model object');
  try {
    await m.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  } catch {
    // The fake fetch answers 401; only the request matters here.
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/settings', () => {
  it('returns defaults when nothing is configured', async () => {
    const { get } = setup();
    const res = await get();
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body).toMatchObject({
      providerConfig: {},
      keys: [],
      roleDefaults: {},
      defaultModel: null,
      priceOverrides: {},
    });
    expect(body.providers).toEqual(
      expect.arrayContaining([
        { id: 'anthropic', name: 'Anthropic', enabled: false, needsKey: true, baseURL: null },
        {
          id: 'openai-compatible',
          name: 'OpenAI-compatible (Ollama, vLLM, …)',
          enabled: false,
          needsKey: false,
          baseURL: null,
        },
      ]),
    );
  });

  it('never returns a full API key, only the provider and its last 4 characters', async () => {
    const { get, put } = setup();
    const saved = await put({ keys: { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY } });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(ANTHROPIC_KEY);
    expect(SettingsUpdateResponseSchema.parse(JSON.parse(saved.text)).keys).toHaveLength(2);
    const res = await get();
    expect(res.text).not.toContain(ANTHROPIC_KEY);
    expect(res.text).not.toContain(OPENAI_KEY);
    const body = SettingsResponseSchema.parse(JSON.parse(res.text));
    expect(body.keys).toEqual([
      { provider: 'anthropic', last4: 'wxyz' },
      { provider: 'openai', last4: '9876' },
    ]);
    expect(body.providers.find((p) => p.id === 'anthropic')).toMatchObject({ enabled: true });
  });

  it('does not list non-API-key secrets', async () => {
    const { get, secrets } = setup();
    secrets.set('session.hmacKey', 'a-session-key-that-is-long');
    const body = JSON.parse((await get()).text) as { keys: unknown };
    expect(body.keys).toEqual([]);
  });
});

describe('PUT /api/settings: API keys', () => {
  it('stores keys under the API_KEY_SECRETS names and clears them with null', async () => {
    const { put, secrets } = setup();
    await put({ keys: { anthropic: ANTHROPIC_KEY } });
    expect(secrets.get(API_KEY_SECRETS.anthropic)).toBe(ANTHROPIC_KEY);
    await put({ keys: { anthropic: null } });
    expect(secrets.get(API_KEY_SECRETS.anthropic)).toBeUndefined();
  });

  it('emits settings.changed without the key, and redacts it from later events', async () => {
    const { put, store } = setup();
    store.commit(() => [productCreated()]);
    await put({ keys: { anthropic: ANTHROPIC_KEY }, roleDefaults: { implementer: SONNET } });
    await put({ keys: { anthropic: null } });
    store.commit(() => [sparMessage('m1', `my key is ${ANTHROPIC_KEY}`)]);

    const events = store.eventsSince(0);
    expect(JSON.stringify(events)).not.toContain(ANTHROPIC_KEY);
    const changed = events.filter((e) => e.type === 'settings.changed');
    expect(changed.map((e) => [e.productId, e.data])).toEqual([
      [null, { sections: ['keys', 'roleDefaults'], keys: [{ provider: 'anthropic', set: true }] }],
      [null, { sections: ['keys'], keys: [{ provider: 'anthropic', set: false }] }],
    ]);
    expect(events.at(-1)?.data).toEqual({ role: 'owner', text: 'my key is ***wxyz' });
    expectSnapshotMatchesReplay(store);
  });

  it('keeps a stored key out of error responses and logs', async () => {
    const { put, app } = setup();
    app.get('/api/test-boom', () => {
      throw new Error(`provider rejected ${ANTHROPIC_KEY}`);
    });
    await put({ keys: { anthropic: ANTHROPIC_KEY } });
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
    const res = await app.request('/api/test-boom');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(ANTHROPIC_KEY);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(ANTHROPIC_KEY);
  });

  it('the registry uses a key set via PUT, read again on every model() call', async () => {
    const { put, settings } = setup();
    const { fetch, requests } = recordingFetch();
    await expect(async () => {
      await callOnce(model(SONNET, { ...settings.modelDeps(), fetch }));
    }).rejects.toThrow(MissingProviderSetupError);

    await put({ keys: { anthropic: ANTHROPIC_KEY } });
    const deps = { ...settings.modelDeps(), fetch };
    await callOnce(model(SONNET, deps));
    await put({ keys: { anthropic: `${ANTHROPIC_KEY}-rotated` } });
    await callOnce(model(SONNET, deps));

    expect(requests.map((r) => r.headers.get('x-api-key'))).toEqual([
      ANTHROPIC_KEY,
      `${ANTHROPIC_KEY}-rotated`,
    ]);
  });
});

describe('PUT /api/settings: provider config', () => {
  it('stores the OpenAI-compatible base URL and the registry sends requests there', async () => {
    const { get, put, settings } = setup();
    const res = await put({
      providerConfig: { openaiCompatible: { baseURL: 'http://localhost:11434/v1' } },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse((await get()).text) as { providers: { id: string }[] };
    expect(body.providers.find((p) => p.id === 'openai-compatible')).toMatchObject({
      enabled: true,
      baseURL: 'http://localhost:11434/v1',
    });

    const { fetch, requests } = recordingFetch();
    const ref = { provider: 'openai-compatible', model: 'llama3' } as const;
    await callOnce(model(ref, { ...settings.modelDeps(), fetch }));
    expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('rejects an invalid base URL with 400 and changes nothing', async () => {
    const { put, get, store } = setup();
    const res = await put({ providerConfig: { openaiCompatible: { baseURL: 'not a url' } } });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: 'invalid' } });
    expect(JSON.parse((await get()).text)).toMatchObject({ providerConfig: {} });
    expect(store.eventsSince(0)).toEqual([]);
  });

  it.each([
    ['an unknown field', { theme: 'dark' }],
    ['an empty update', {}],
    ['an unknown provider key', { keys: { mistral: 'abcdefghijkl' } }],
    ['a key shorter than 8 characters', { keys: { openai: 'short' } }],
    ['a key with whitespace', { keys: { openai: 'sk-abc def-ghij' } }],
    ['a key for claude-code', { keys: { 'claude-code': 'abcdefghijkl' } }],
    [
      'an invalid role default',
      { roleDefaults: { implementer: { provider: 'acme', model: 'x' } } },
    ],
    ['an unknown role', { roleDefaults: { janitor: SONNET } }],
    ['a negative price', { priceOverrides: { 'anthropic/x': { input: -1, output: 1 } } }],
    ['an invalid OpenRouter URL', { providerConfig: { openrouter: { baseURL: 'nope' } } }],
  ])('rejects %s with 400', async (_name, body) => {
    const { put, store } = setup();
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(store.eventsSince(0)).toEqual([]);
  });

  it('accepts only keys the redactor can mask', () => {
    expect(API_KEY_MIN_LENGTH).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { app } = setup();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/settings: models and prices', () => {
  it('role defaults and the default model set via PUT drive resolveModel', async () => {
    const { put, get, settings, db } = setup();
    const gpt = { provider: 'openai', model: 'gpt-5' } as const;
    const resolve = (role: Role, productModels: RoleModels = {}) =>
      resolveModel(role, productModels, settings.read());
    expect(resolve('implementer')).toBeUndefined();

    await put({ roleDefaults: { implementer: SONNET }, defaultModel: gpt });
    expect(resolve('implementer')).toEqual(SONNET);
    expect(resolve('reviewer')).toEqual(gpt);
    // The product's own choice still wins over the account defaults.
    expect(resolve('implementer', { implementer: gpt })).toEqual(gpt);
    expect(readSetting(db, SETTING_KEYS.roleDefaults)).toEqual({ implementer: SONNET });

    await put({ defaultModel: null });
    expect(resolve('reviewer')).toBeUndefined();
    expect(resolve('implementer')).toEqual(SONNET);
    expect(readSetting(db, SETTING_KEYS.defaultModel)).toBeUndefined();
    expect(SettingsResponseSchema.parse(JSON.parse((await get()).text))).toMatchObject({
      roleDefaults: { implementer: SONNET },
      defaultModel: null,
    });
  });

  it('price overrides replace the built-in price and price unknown models', async () => {
    const { put, settings, db } = setup();
    const custom = { provider: 'openrouter', model: 'acme/unlisted-1' } as const;
    expect(price(custom, settings.read().priceOverrides)).toBeUndefined();
    const override = { input: 1, output: 2 };
    const res = await put({
      priceOverrides: {
        'openrouter/acme/unlisted-1': override,
        'anthropic/claude-sonnet-4-5': override,
      },
    });
    expect(res.status).toBe(200);
    const overrides = settings.read().priceOverrides;
    expect(price(custom, overrides)).toEqual(override);
    expect(price(SONNET, overrides)).toMatchObject(override);
    expect(readSetting(db, SETTING_KEYS.priceOverrides)).toEqual(overrides);
  });

  it('leaves sections that are not in the update unchanged', async () => {
    const { put, get } = setup();
    await put({ roleDefaults: { implementer: SONNET }, keys: { openai: OPENAI_KEY } });
    await put({ priceOverrides: {} });
    expect(JSON.parse((await get()).text)).toMatchObject({
      roleDefaults: { implementer: SONNET },
      keys: [{ provider: 'openai', last4: '9876' }],
    });
  });
});
