import { generateText, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ModelRef } from '../../shared/models.ts';
import {
  API_KEY_SECRETS,
  MissingProviderSetupError,
  model,
  providerReportedCost,
  type ModelDeps,
} from './index.ts';

const SECRET = 'sk-test-0123456789abcdef';

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

/** A fetch stand-in that records requests and answers with `respond`. */
function recordingFetch(respond: (req: Captured) => Response) {
  const requests: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req: Captured = {
      url: String(input),
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    requests.push(req);
    return respond(req);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: { message: 'bad key', type: 'auth' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });

function chatCompletion(cost: number) {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model: 'anthropic/claude-sonnet-4.5',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost },
  };
}

function sse(chunks: unknown[]): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(
    '',
  );
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function deps(secrets: Record<string, string>, extra: Partial<ModelDeps> = {}): ModelDeps {
  return { getSecret: (key) => secrets[key], ...extra };
}

async function failure(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('model registry', () => {
  it.each([
    ['anthropic', 'Add an Anthropic API key in Settings'],
    ['openai', 'Add an OpenAI API key in Settings'],
    ['google', 'Add a Google Gemini API key in Settings'],
    ['openrouter', 'Add an OpenRouter API key in Settings'],
  ] as const)('missing %s key → actionable error', async (provider, message) => {
    const other = Object.fromEntries(
      Object.entries(API_KEY_SECRETS)
        .filter(([p]) => p !== provider)
        .map(([, key]) => [key, SECRET]),
    );

    const error = await failure(() => model({ provider, model: 'm' }, deps(other)));

    expect(error).toBeInstanceOf(MissingProviderSetupError);
    expect((error as Error).message).toBe(message);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String((error as Error).stack)).not.toContain(SECRET);
  });

  it('treats a blank key as missing', async () => {
    const error = await failure(() =>
      model({ provider: 'anthropic', model: 'm' }, deps({ [API_KEY_SECRETS.anthropic]: '  ' })),
    );
    expect((error as Error).message).toBe('Add an Anthropic API key in Settings');
  });

  it('needs a base URL for openai-compatible, but no key', async () => {
    const error = await failure(() =>
      model({ provider: 'openai-compatible', model: 'm' }, deps({})),
    );
    expect((error as Error).message).toBe('Set the OpenAI-compatible base URL in Settings');

    const { fetch, requests } = recordingFetch(() => sse([]));
    const m = model(
      { provider: 'openai-compatible', model: 'llama3.2' },
      deps(
        {},
        { providerConfig: { openaiCompatible: { baseURL: 'http://localhost:11434/v1' } }, fetch },
      ),
    );
    await failure(() => generateText({ model: m, prompt: 'hi', maxRetries: 0 }));

    expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(requests[0]?.body.model).toBe('llama3.2');
    expect(requests[0]?.headers.get('authorization')).toBeNull();
  });

  it('sends the optional openai-compatible key when set', async () => {
    const { fetch, requests } = recordingFetch(unauthorized);
    const m = model(
      { provider: 'openai-compatible', model: 'x' },
      deps(
        { [API_KEY_SECRETS['openai-compatible']]: SECRET },
        { providerConfig: { openaiCompatible: { baseURL: 'http://gpu.local/v1' } }, fetch },
      ),
    );
    await failure(() => generateText({ model: m, prompt: 'hi', maxRetries: 0 }));
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
  });

  it.each([
    ['anthropic', 'x-api-key', SECRET, 'https://api.anthropic.com/'],
    ['openai', 'authorization', `Bearer ${SECRET}`, 'https://api.openai.com/'],
    ['google', 'x-goog-api-key', SECRET, 'https://generativelanguage.googleapis.com/'],
    ['openrouter', 'authorization', `Bearer ${SECRET}`, 'https://openrouter.ai/api/v1/'],
  ] as const)(
    '%s sends the stored key and keeps it out of the API error',
    async (provider, header, value, urlPrefix) => {
      const { fetch, requests } = recordingFetch(unauthorized);
      const m = model(
        { provider, model: 'm' },
        deps({ [API_KEY_SECRETS[provider]]: SECRET }, { fetch }),
      );

      const error = await failure(() => generateText({ model: m, prompt: 'hi', maxRetries: 0 }));

      expect(requests[0]?.url.startsWith(urlPrefix)).toBe(true);
      expect(requests[0]?.headers.get(header)).toBe(value);
      expect(String(error)).not.toContain(SECRET);
      expect(JSON.stringify(error)).not.toContain(SECRET);
    },
  );

  it('reads the key at call time, not once', async () => {
    const secrets: Record<string, string> = { [API_KEY_SECRETS.anthropic]: 'sk-ant-first-key' };
    const { fetch, requests } = recordingFetch(unauthorized);
    const ref: ModelRef = { provider: 'anthropic', model: 'claude-sonnet-4-5' };

    await failure(() =>
      generateText({ model: model(ref, deps(secrets, { fetch })), prompt: 'a', maxRetries: 0 }),
    );
    secrets[API_KEY_SECRETS.anthropic] = 'sk-ant-second-key';
    await failure(() =>
      generateText({ model: model(ref, deps(secrets, { fetch })), prompt: 'b', maxRetries: 0 }),
    );

    expect(requests.map((r) => r.headers.get('x-api-key'))).toEqual([
      'sk-ant-first-key',
      'sk-ant-second-key',
    ]);
  });

  it('openrouter: asks for usage accounting and exposes usage.cost (generate)', async () => {
    const { fetch, requests } = recordingFetch(() => Response.json(chatCompletion(0.0123)));
    const m = model(
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
      deps({ [API_KEY_SECRETS.openrouter]: SECRET }, { fetch }),
    );

    const result = await generateText({ model: m, prompt: 'hi' });

    expect(result.text).toBe('hi');
    expect(requests[0]?.body.usage).toEqual({ include: true });
    expect(providerReportedCost(result.providerMetadata)).toBe(0.0123);
  });

  it('openrouter: exposes usage.cost when streaming', async () => {
    const base = { id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'm' };
    const { fetch } = recordingFetch(() =>
      sse([
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.5 },
        },
      ]),
    );
    const m = model(
      { provider: 'openrouter', model: 'openai/gpt-5' },
      deps({ [API_KEY_SECRETS.openrouter]: SECRET }, { fetch }),
    );

    const result = streamText({ model: m, prompt: 'hi' });

    expect(await result.text).toBe('hi');
    expect(providerReportedCost(await result.providerMetadata)).toBe(0.5);
  });

  it('openrouter: webSearch selects the :online model variant', async () => {
    const { fetch, requests } = recordingFetch(() => Response.json(chatCompletion(0)));
    const m = model(
      { provider: 'openrouter', model: 'openai/gpt-5' },
      deps({ [API_KEY_SECRETS.openrouter]: SECRET }, { fetch, webSearch: true }),
    );

    await generateText({ model: m, prompt: 'hi' });

    expect(requests[0]?.body.model).toBe('openai/gpt-5:online');
  });

  it('fake: replays the given script and needs no key', async () => {
    const m = model(
      { provider: 'fake', model: 'demo' },
      deps({}, { fake: { script: [{ text: 'issue {{n}}' }], vars: { n: 3 } } }),
    );
    expect((await generateText({ model: m, prompt: 'go' })).text).toBe('issue 3');
  });

  it('fake: without a script is a setup error', async () => {
    const error = await failure(() => model({ provider: 'fake', model: 'demo' }, deps({})));
    expect(error).toBeInstanceOf(MissingProviderSetupError);
  });

  it('claude-code is not an API model', async () => {
    const error = await failure(() =>
      model({ provider: 'claude-code', model: 'sonnet' }, deps({})),
    );
    expect((error as Error).message).toMatch(/Claude Code backend/);
  });
});
