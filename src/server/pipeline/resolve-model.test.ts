import { describe, expect, it } from 'vitest';
import { ProductIdSchema } from '../../shared/ids.ts';
import type { ModelRef, RoleModels } from '../../shared/models.ts';
import { open, schema } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore, type Store } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { resolveModel, SETTING_KEYS } from './index.ts';

const P = ProductIdSchema.parse('product-1');
const PRODUCT_MODEL: ModelRef = { provider: 'anthropic', model: 'claude-product' };
const ROLE_DEFAULT: ModelRef = { provider: 'openai', model: 'gpt-role' };
const DEFAULT_MODEL: ModelRef = { provider: 'google', model: 'gemini-default' };

function setup(opts: { productModels?: RoleModels; settings?: Record<string, unknown> } = {}) {
  const store = createStore({
    db: open(':memory:'),
    clock: new FakeClock(),
    redactor: new Redactor(),
  });
  store.commit((tx) => {
    for (const [key, value] of Object.entries(opts.settings ?? {})) {
      tx.db.insert(schema.settings).values({ key, value }).run();
    }
    return [
      {
        type: 'product.created',
        productId: P,
        entityId: null,
        v: 1,
        data: {
          name: 'Todo',
          idea: '',
          budgetUsd: null,
          maxParallel: 1,
          maxAttempts: 1,
          models: opts.productModels ?? {},
          gitRemote: null,
        },
      },
    ];
  });
  return store;
}

const roleDefaults = (m: RoleModels) => ({ [SETTING_KEYS.roleDefaults]: m });
const defaultModel = (m: ModelRef) => ({ [SETTING_KEYS.defaultModel]: m });
const CHOOSE = { ok: false, reason: 'Choose a model in Settings' } as const;

describe('resolveModel precedence', () => {
  const cases: {
    name: string;
    store: () => Store;
    demo?: boolean;
    expected: ReturnType<typeof resolveModel>;
  }[] = [
    {
      name: 'product model for the role wins over everything',
      store: () =>
        setup({
          productModels: { implementer: PRODUCT_MODEL },
          settings: {
            ...roleDefaults({ implementer: ROLE_DEFAULT }),
            ...defaultModel(DEFAULT_MODEL),
          },
        }),
      demo: true,
      expected: { ok: true, model: PRODUCT_MODEL },
    },
    {
      name: 'role default when the product has no model for the role',
      store: () =>
        setup({
          productModels: { reviewer: PRODUCT_MODEL },
          settings: {
            ...roleDefaults({ implementer: ROLE_DEFAULT }),
            ...defaultModel(DEFAULT_MODEL),
          },
        }),
      expected: { ok: true, model: ROLE_DEFAULT },
    },
    {
      name: 'default model when neither product nor role default covers the role',
      store: () =>
        setup({
          settings: { ...roleDefaults({ reviewer: ROLE_DEFAULT }), ...defaultModel(DEFAULT_MODEL) },
        }),
      demo: true,
      expected: { ok: true, model: DEFAULT_MODEL },
    },
    {
      name: 'fake model in demo mode when nothing is configured',
      store: () => setup(),
      demo: true,
      expected: { ok: true, model: { provider: 'fake', model: 'fake' } },
    },
    {
      name: 'actionable error outside demo mode when nothing is configured',
      store: () => setup(),
      expected: CHOOSE,
    },
  ];

  it.each(cases)('$name', ({ store, demo, expected }) => {
    expect(resolveModel(store(), P, 'implementer', { demo: demo ?? false })).toEqual(expected);
  });

  it('falls back to settings for an unknown product', () => {
    const store = setup({ settings: defaultModel(DEFAULT_MODEL) });
    expect(resolveModel(store, ProductIdSchema.parse('nope'), 'implementer')).toEqual({
      ok: true,
      model: DEFAULT_MODEL,
    });
  });

  it('throws with the key name when a stored setting is malformed', () => {
    const store = setup({ settings: { [SETTING_KEYS.defaultModel]: { provider: 'nope' } } });
    expect(() => resolveModel(store, P, 'implementer')).toThrow(SETTING_KEYS.defaultModel);
  });
});
