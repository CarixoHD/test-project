import { describe, expect, it } from 'vitest';
import {
  resolveModel,
  type ModelDefaults,
  type ModelRef,
  type Role,
  type RoleModels,
} from './models.ts';

const PRODUCT: ModelRef = { provider: 'anthropic', model: 'claude-opus-4-5' };
const ROLE_DEFAULT: ModelRef = { provider: 'openai', model: 'gpt-5' };
const DEFAULT: ModelRef = { provider: 'openrouter', model: 'qwen/qwen3-coder' };

const NONE: ModelDefaults = { roleDefaults: {}, defaultModel: null };

describe('resolveModel', () => {
  it.each<[string, Role, RoleModels, ModelDefaults, ModelRef | undefined]>([
    ['nothing configured', 'implementer', {}, NONE, undefined],
    [
      'only the default model',
      'implementer',
      {},
      { roleDefaults: {}, defaultModel: DEFAULT },
      DEFAULT,
    ],
    [
      'role default before the default model',
      'implementer',
      {},
      { roleDefaults: { implementer: ROLE_DEFAULT }, defaultModel: DEFAULT },
      ROLE_DEFAULT,
    ],
    [
      'another role’s default does not apply',
      'reviewer',
      {},
      { roleDefaults: { implementer: ROLE_DEFAULT }, defaultModel: DEFAULT },
      DEFAULT,
    ],
    [
      'another role’s default and no default model',
      'reviewer',
      {},
      { roleDefaults: { implementer: ROLE_DEFAULT }, defaultModel: null },
      undefined,
    ],
    [
      'product choice wins',
      'implementer',
      { implementer: PRODUCT },
      { roleDefaults: { implementer: ROLE_DEFAULT }, defaultModel: DEFAULT },
      PRODUCT,
    ],
    [
      'product choice for another role falls through',
      'orchestrator',
      { implementer: PRODUCT },
      { roleDefaults: { orchestrator: ROLE_DEFAULT }, defaultModel: DEFAULT },
      ROLE_DEFAULT,
    ],
  ])('%s', (_name, role, productModels, defaults, expected) => {
    expect(resolveModel(role, productModels, defaults)).toEqual(expected);
  });

  it('returns a copy, never the stored object', () => {
    const defaults = { roleDefaults: {}, defaultModel: DEFAULT };
    const got = resolveModel('implementer', {}, defaults);
    expect(got).not.toBe(DEFAULT);
  });
});
