import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { ModelRef, ProviderId } from '../../shared/models.ts';
import { fakeModel, type FakeModelOptions, type FakeScript } from './fake.ts';

type KeyedProvider = Exclude<ProviderId, 'fake' | 'claude-code'>;

/** `secrets` table keys of the provider API keys (written by Settings). */
export const API_KEY_SECRETS = {
  anthropic: 'llm.anthropic.apiKey',
  openai: 'llm.openai.apiKey',
  google: 'llm.google.apiKey',
  openrouter: 'llm.openrouter.apiKey',
  'openai-compatible': 'llm.openai-compatible.apiKey',
} as const satisfies Record<KeyedProvider, string>;

const KEY_LABELS: Record<Exclude<KeyedProvider, 'openai-compatible'>, string> = {
  anthropic: 'an Anthropic',
  openai: 'an OpenAI',
  google: 'a Google Gemini',
  openrouter: 'an OpenRouter',
};

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Non-secret provider settings (stored in `settings`). */
export const ProviderConfigSchema = z.strictObject({
  openaiCompatible: z.strictObject({ baseURL: z.url() }).optional(),
  openrouter: z.strictObject({ baseURL: z.url() }).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export type ModelDeps = {
  /** Reads a secret at call time; the registry never stores or logs it. */
  getSecret: (key: string) => string | undefined;
  providerConfig?: ProviderConfig;
  /** OpenRouter: use the `:online` (web search) variant of the model (ADR 10). */
  webSearch?: boolean;
  /** Script for the `fake` provider (tests and demo mode). */
  fake?: { script: FakeScript } & FakeModelOptions;
  /** Replaces global fetch, for tests and proxies. */
  fetch?: typeof globalThis.fetch;
};

/** The provider cannot be used until the owner changes Settings; the message says how. */
export class MissingProviderSetupError extends Error {
  readonly provider: ProviderId;
  constructor(provider: ProviderId, message: string) {
    super(message);
    this.name = 'MissingProviderSetupError';
    this.provider = provider;
  }
}

function requireKey(provider: Exclude<KeyedProvider, 'openai-compatible'>, deps: ModelDeps) {
  const key = deps.getSecret(API_KEY_SECRETS[provider])?.trim();
  if (!key) {
    throw new MissingProviderSetupError(
      provider,
      `Add ${KEY_LABELS[provider]} API key in Settings`,
    );
  }
  return key;
}

const CostSchema = z.object({ usage: z.object({ cost: z.number().min(0).finite() }) });

function openRouterCost(body: unknown): number | undefined {
  const parsed = CostSchema.safeParse(body);
  return parsed.success ? parsed.data.usage.cost : undefined;
}

/** Copies OpenRouter's `usage.cost` into providerMetadata.openrouter.usage.cost (see pricing.ts). */
const openRouterCostExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => {
    const cost = openRouterCost(parsedBody);
    return cost === undefined ? undefined : { openrouter: { usage: { cost } } };
  },
  createStreamExtractor: () => {
    let cost: number | undefined;
    return {
      processChunk: (chunk) => {
        cost = openRouterCost(chunk) ?? cost;
      },
      buildMetadata: () => (cost === undefined ? undefined : { openrouter: { usage: { cost } } }),
    };
  },
};

/**
 * The AI SDK model for `ref`. API keys are read from `deps.getSecret` on every call.
 * Throws MissingProviderSetupError (actionable, secret-free) when a key or base URL is missing.
 */
export function model(ref: ModelRef, deps: ModelDeps): LanguageModel {
  const config = ProviderConfigSchema.parse(deps.providerConfig ?? {});
  const fetch = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  switch (ref.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: requireKey('anthropic', deps), ...fetch })(ref.model);
    case 'openai':
      return createOpenAI({ apiKey: requireKey('openai', deps), ...fetch })(ref.model);
    case 'google':
      return createGoogle({ apiKey: requireKey('google', deps), ...fetch })(ref.model);
    case 'openrouter': {
      const provider = createOpenAICompatible({
        name: 'openrouter',
        baseURL: config.openrouter?.baseURL ?? OPENROUTER_BASE_URL,
        apiKey: requireKey('openrouter', deps),
        includeUsage: true,
        metadataExtractor: openRouterCostExtractor,
        // OpenRouter usage accounting: adds `usage.cost` (USD) to the response.
        transformRequestBody: (body) => ({ ...body, usage: { include: true } }),
        ...fetch,
      });
      return provider(deps.webSearch ? `${ref.model}:online` : ref.model);
    }
    case 'openai-compatible': {
      const baseURL = config.openaiCompatible?.baseURL;
      if (baseURL === undefined) {
        throw new MissingProviderSetupError(
          ref.provider,
          'Set the OpenAI-compatible base URL in Settings',
        );
      }
      const apiKey = deps.getSecret(API_KEY_SECRETS['openai-compatible'])?.trim();
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL,
        includeUsage: true,
        ...(apiKey ? { apiKey } : {}),
        ...fetch,
      })(ref.model);
    }
    case 'fake': {
      if (deps.fake === undefined) {
        throw new MissingProviderSetupError(ref.provider, 'The fake provider needs a script');
      }
      const { script, ...options } = deps.fake;
      return fakeModel(script, options);
    }
    case 'claude-code':
      throw new Error('claude-code models run through the Claude Code backend, not model()');
  }
}
