import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsUpdateRequestSchema,
  type ClaudeLoginResponse,
  type SettingsResponse,
  type SettingsUpdateRequest,
} from '../../../shared/dto.ts';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { KEYED_PROVIDER_IDS, type KeyedProviderId } from '../../../shared/models.ts';
import { emptyState, type ClientState } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { createAppStore } from '../../state/store.ts';

// The /settings page end to end in the browser: real store, router and API client. Only the
// network is faked: fetch answers like the real GET|PUT /api/settings (keys write-only, shown
// as last 4 characters), and EventSource delivers settings.changed events.

class FakeEventSource {
  static readonly CLOSED = 2;
  static latest: FakeEventSource | null = null;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
  }
  close(): void {
    this.readyState = 2;
  }
}

const KEY = 'sk-ant-api03-SECRETSECRETSECRET-wxyz';

/** In-memory stand-in for the server's account settings (same rules as commands/settings.ts). */
class FakeSettingsServer {
  keys = new Map<KeyedProviderId, string>();
  stored: Omit<SettingsResponse, 'providers' | 'keys'> = {
    providerConfig: {},
    roleDefaults: {},
    defaultModel: null,
    priceOverrides: {},
  };
  puts: SettingsUpdateRequest[] = [];
  gets = 0;

  view(): SettingsResponse {
    const { openaiCompatible } = this.stored.providerConfig;
    const keyed = (id: 'anthropic' | 'openai' | 'google' | 'openrouter', name: string) => ({
      id,
      name,
      enabled: this.keys.has(id),
      needsKey: true,
      baseURL: null,
    });
    return {
      providers: [
        keyed('anthropic', 'Anthropic'),
        keyed('openai', 'OpenAI'),
        keyed('google', 'Google'),
        keyed('openrouter', 'OpenRouter'),
        {
          id: 'openai-compatible',
          name: 'OpenAI-compatible',
          enabled: openaiCompatible !== undefined,
          needsKey: false,
          baseURL: openaiCompatible?.baseURL ?? null,
        },
        { id: 'claude-code', name: 'Claude Code', enabled: true, needsKey: false, baseURL: null },
      ],
      ...this.stored,
      keys: KEYED_PROVIDER_IDS.flatMap((provider) => {
        const key = this.keys.get(provider);
        return key === undefined
          ? []
          : [{ provider, last4: key.length < 16 ? null : key.slice(-4) }];
      }),
    };
  }

  update(raw: unknown): Response {
    const parsed = SettingsUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'invalid', message: 'Invalid settings' } },
        { status: 400 },
      );
    }
    const u = parsed.data;
    this.puts.push(u);
    for (const [provider, value] of Object.entries(u.keys ?? {})) {
      const id = provider as KeyedProviderId;
      if (value === null) this.keys.delete(id);
      else if (value !== undefined) this.keys.set(id, value);
    }
    if (u.providerConfig !== undefined) this.stored.providerConfig = u.providerConfig;
    if (u.roleDefaults !== undefined) this.stored.roleDefaults = u.roleDefaults;
    if (u.defaultModel !== undefined) this.stored.defaultModel = u.defaultModel;
    if (u.priceOverrides !== undefined) this.stored.priceOverrides = u.priceOverrides;
    return Response.json({ ok: true, ...this.view() });
  }
}

let server: FakeSettingsServer;
/** What GET /api/state answers (backend limits drive the Claude Code status). */
let initialState: ClientState;
/** Backends the page asked to clear (POST /api/backends/:backend/clear). */
let cleared: string[];
/** What GET /api/backends/claude-code/login answers (null: a 500). */
let loginCommands: ClaudeLoginResponse | null;
const CLAUDE_TAG = `vibecode/claude-code:${'ab12'.repeat(16)}`;
const LOGIN_COMMANDS: ClaudeLoginResponse = {
  build: `docker buildx build --load --tag ${CLAUDE_TAG} --file /opt/vibecode/docker/claude-code.Dockerfile /opt/vibecode/docker`,
  volume: 'docker volume create vibecode-claude-config',
  login: `docker run -it --rm --pull never --user 1501:20 -v vibecode-claude-config:/home/agent/.claude ${CLAUDE_TAG} claude auth login`,
};

beforeEach(() => {
  server = new FakeSettingsServer();
  loginCommands = LOGIN_COMMANDS;
  initialState = emptyState;
  cleared = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') {
        server.gets += 1;
        return Promise.resolve(Response.json(server.view()));
      }
      if (url === '/api/settings' && method === 'PUT') {
        return Promise.resolve(server.update(JSON.parse(String(init?.body))));
      }
      if (url === '/api/state') {
        return Promise.resolve(Response.json({ state: initialState, lastSeq: 0 }));
      }
      if (url === '/api/backends/claude-code/login' && method === 'GET') {
        return Promise.resolve(
          loginCommands === null
            ? Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 })
            : Response.json(loginCommands),
        );
      }
      const clear = /^\/api\/backends\/([^/]+)\/clear$/.exec(url);
      if (clear?.[1] !== undefined && method === 'POST') {
        cleared.push(clear[1]);
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(
        Response.json({ error: { code: 'not_found', message: url } }, { status: 404 }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSettings() {
  const router = createMemoryRouter(routes, { initialEntries: ['/settings'] });
  render(<App store={createAppStore()} router={router} />);
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  await screen.findByRole('region', { name: 'Providers' });
  return { user: userEvent.setup() };
}

const providerGroup = (name: string) => screen.getByRole('group', { name });

/** Every place a value could leak into the page: text and the values of all form controls. */
function pageContains(secret: string): boolean {
  if (document.body.innerHTML.includes(secret)) return true;
  return [...document.querySelectorAll('input, textarea, select')].some((el) =>
    (el as HTMLInputElement).value.includes(secret),
  );
}

describe('Settings: provider keys', () => {
  it('saves an entered key and then shows only its last 4 characters', async () => {
    const { user } = await renderSettings();
    const anthropic = providerGroup('Anthropic');
    const input = within(anthropic).getByLabelText('Anthropic API key');
    expect(input).toHaveAttribute('type', 'password');

    await user.type(input, KEY);
    await user.click(within(anthropic).getByRole('button', { name: 'Save Anthropic key' }));

    expect(await within(providerGroup('Anthropic')).findByText('Key ending in wxyz')).toBeVisible();
    expect(server.puts).toContainEqual({ keys: { anthropic: KEY } });
    expect(
      within(providerGroup('Anthropic')).getByRole('button', { name: 'Replace Anthropic key' }),
    ).toHaveFocus();
    expect(pageContains(KEY)).toBe(false);
    expect(pageContains('SECRETSECRET')).toBe(false);
  });
});

describe('Settings: stored keys', () => {
  it('shows a stored key masked and replaces it without echoing either key', async () => {
    server.keys.set('openai', 'sk-proj-OLDOLDOLDOLDOLD-ab12');
    const { user } = await renderSettings();
    const openai = providerGroup('OpenAI');
    expect(within(openai).getByText('Key ending in ab12')).toBeVisible();
    expect(within(openai).queryByLabelText('OpenAI API key')).toBeNull();

    await user.click(within(openai).getByRole('button', { name: 'Replace OpenAI key' }));
    const input = within(openai).getByLabelText('OpenAI API key');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    await user.keyboard('sk-proj-NEWNEWNEWNEWNEW-cd34{Enter}');

    expect(await within(providerGroup('OpenAI')).findByText('Key ending in cd34')).toBeVisible();
    expect(server.keys.get('openai')).toBe('sk-proj-NEWNEWNEWNEWNEW-cd34');
    expect(pageContains('OLDOLDOLD')).toBe(false);
    expect(pageContains('NEWNEWNEW')).toBe(false);
  });

  it('removes a key after confirmation and offers key entry again', async () => {
    server.keys.set('google', 'AIzaSyGOOGLEGOOGLEGOOGLE-9876');
    const { user } = await renderSettings();
    await user.click(
      within(providerGroup('Google')).getByRole('button', { name: 'Remove Google key' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Remove the Google key?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));

    expect(await within(providerGroup('Google')).findByLabelText('Google API key')).toHaveFocus();
    expect(server.puts).toContainEqual({ keys: { google: null } });
    expect(within(providerGroup('Google')).queryByText(/Key ending in/)).toBeNull();
  });

  it('says "Key saved" for keys too short to show an ending', async () => {
    server.keys.set('openrouter', 'shortkey12');
    await renderSettings();
    expect(within(providerGroup('OpenRouter')).getByText('Key saved')).toBeVisible();
    expect(pageContains('shortkey12')).toBe(false);
  });

  it('rejects a key that is too short or has spaces without sending it', async () => {
    const { user } = await renderSettings();
    const input = within(providerGroup('Anthropic')).getByLabelText('Anthropic API key');
    await user.type(input, 'abc def{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    expect(server.puts).toEqual([]);
  });
});

describe('Settings: OpenAI-compatible base URL', () => {
  it('saves a base URL for a local endpoint such as Ollama', async () => {
    const { user } = await renderSettings();
    const group = providerGroup('OpenAI-compatible');
    await user.type(
      within(group).getByLabelText('OpenAI-compatible base URL'),
      'http://localhost:11434/v1',
    );
    await user.click(
      within(group).getByRole('button', { name: 'Save OpenAI-compatible base URL' }),
    );

    expect(await within(group).findByText('OpenAI-compatible base URL saved.')).toBeVisible();
    expect(server.puts).toContainEqual({
      providerConfig: { openaiCompatible: { baseURL: 'http://localhost:11434/v1' } },
    });
  });

  it('rejects something that is not a URL', async () => {
    const { user } = await renderSettings();
    const input = within(providerGroup('OpenAI-compatible')).getByLabelText(
      'OpenAI-compatible base URL',
    );
    await user.type(input, 'localhost{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(server.puts).toEqual([]);
  });
});

let seq = 0;
const settingsChanged = (): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type: 'settings.changed',
    productId: null,
    entityId: null,
    v: 1,
    data: { sections: ['keys'], keys: [{ provider: 'anthropic', set: true }] },
  });
};

describe('Settings: live updates', () => {
  it('refetches when another tab or the server changes the settings', async () => {
    await renderSettings();
    expect(within(providerGroup('Anthropic')).getByLabelText('Anthropic API key')).toBeVisible();
    const getsBefore = server.gets;

    server.keys.set('anthropic', KEY);
    const stream = FakeEventSource.latest;
    if (stream === null) throw new Error('no stream');
    act(() => stream.onmessage?.({ data: JSON.stringify(settingsChanged()) }));

    expect(await within(providerGroup('Anthropic')).findByText('Key ending in wxyz')).toBeVisible();
    expect(server.gets).toBe(getsBefore + 1);
    expect(pageContains(KEY)).toBe(false);
  });
});

describe('Settings: models per role', () => {
  const modelsRegion = () => screen.getByRole('region', { name: 'Models' });
  const roleGroup = (name: string) => within(modelsRegion()).getByRole('group', { name });

  it('saves a role default and the global default model', async () => {
    const { user } = await renderSettings();
    const implementer = roleGroup('Implementer');
    await user.selectOptions(within(implementer).getByLabelText('Provider'), 'anthropic');
    await user.type(within(implementer).getByLabelText('Model'), 'claude-sonnet-4-5');
    const fallback = roleGroup('Default for all roles');
    await user.selectOptions(within(fallback).getByLabelText('Provider'), 'openai-compatible');
    await user.type(within(fallback).getByLabelText('Model'), 'llama3.1');
    await user.click(within(modelsRegion()).getByRole('button', { name: 'Save models' }));

    expect(await within(modelsRegion()).findByText('Models saved.')).toBeVisible();
    expect(server.puts).toContainEqual({
      roleDefaults: { implementer: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      defaultModel: { provider: 'openai-compatible', model: 'llama3.1' },
    });
  });

  it('shows saved role defaults and clears one when its provider is unset', async () => {
    server.stored.roleDefaults = {
      reviewer: { provider: 'openai', model: 'gpt-5' },
      utility: { provider: 'google', model: 'gemini-2.5-flash' },
    };
    const { user } = await renderSettings();
    expect(within(roleGroup('Reviewer')).getByLabelText('Provider')).toHaveValue('openai');
    expect(within(roleGroup('Reviewer')).getByLabelText('Model')).toHaveValue('gpt-5');

    await user.selectOptions(within(roleGroup('Utility')).getByLabelText('Provider'), '');
    await user.click(within(modelsRegion()).getByRole('button', { name: 'Save models' }));

    expect(await within(modelsRegion()).findByText('Models saved.')).toBeVisible();
    expect(server.stored.roleDefaults).toEqual({
      reviewer: { provider: 'openai', model: 'gpt-5' },
    });
    expect(server.stored.defaultModel).toBeNull();
  });

  it('asks for a model name when a provider is chosen without one', async () => {
    const { user } = await renderSettings();
    await user.selectOptions(within(roleGroup('Sparring')).getByLabelText('Provider'), 'anthropic');
    await user.click(within(modelsRegion()).getByRole('button', { name: 'Save models' }));

    const model = within(roleGroup('Sparring')).getByLabelText('Model');
    expect(model).toHaveAttribute('aria-invalid', 'true');
    expect(model).toHaveFocus();
    expect(server.puts).toEqual([]);
  });
});

describe('Settings: price overrides', () => {
  const pricesRegion = () => screen.getByRole('region', { name: 'Price overrides' });

  it('adds an override for a model with input and output $ per 1M tokens', async () => {
    const { user } = await renderSettings();
    await user.click(within(pricesRegion()).getByRole('button', { name: 'Add price override' }));
    await user.type(
      within(pricesRegion()).getByLabelText('Model, row 1'),
      'openrouter/qwen3-coder',
    );
    await user.type(within(pricesRegion()).getByLabelText('Input $ per 1M tokens, row 1'), '0.4');
    await user.type(within(pricesRegion()).getByLabelText('Output $ per 1M tokens, row 1'), '1.6');
    await user.click(within(pricesRegion()).getByRole('button', { name: 'Save price overrides' }));

    expect(await within(pricesRegion()).findByText('Price overrides saved.')).toBeVisible();
    expect(server.stored.priceOverrides).toEqual({
      'openrouter/qwen3-coder': { input: 0.4, output: 1.6 },
    });
  });

  it('edits and removes saved overrides, keeping their other prices', async () => {
    server.stored.priceOverrides = {
      'anthropic/claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
      'openai/gpt-5': { input: 1.25, output: 10 },
    };
    const { user } = await renderSettings();
    const output = within(pricesRegion()).getByLabelText('Output $ per 1M tokens, row 1');
    expect(within(pricesRegion()).getByLabelText('Model, row 1')).toHaveValue(
      'anthropic/claude-sonnet-4-5',
    );
    await user.clear(output);
    await user.type(output, '12');
    await user.click(
      within(pricesRegion()).getByRole('button', { name: 'Remove price override, row 2' }),
    );
    await user.click(within(pricesRegion()).getByRole('button', { name: 'Save price overrides' }));

    expect(await within(pricesRegion()).findByText('Price overrides saved.')).toBeVisible();
    expect(server.stored.priceOverrides).toEqual({
      'anthropic/claude-sonnet-4-5': { input: 3, output: 12, cacheRead: 0.3 },
    });
  });

  it('rejects a negative price and a model without its provider', async () => {
    const { user } = await renderSettings();
    await user.click(within(pricesRegion()).getByRole('button', { name: 'Add price override' }));
    await user.type(within(pricesRegion()).getByLabelText('Model, row 1'), 'gpt-5');
    await user.type(within(pricesRegion()).getByLabelText('Input $ per 1M tokens, row 1'), '-1');
    await user.type(within(pricesRegion()).getByLabelText('Output $ per 1M tokens, row 1'), '2');
    await user.click(within(pricesRegion()).getByRole('button', { name: 'Save price overrides' }));

    const model = within(pricesRegion()).getByLabelText('Model, row 1');
    expect(model).toHaveAttribute('aria-invalid', 'true');
    expect(model).toHaveFocus();
    expect(within(pricesRegion()).getByLabelText('Input $ per 1M tokens, row 1')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(server.puts).toEqual([]);
  });
});

const NOW = Date.now();
const limit = (over: { until?: number | null; needsLogin?: boolean }) => ({
  backend: 'claude-code',
  until: over.until ?? null,
  needsLogin: over.needsLogin ?? false,
  reason: 'test',
});
const withLimit = (l: ReturnType<typeof limit>): ClientState => ({
  ...emptyState,
  backendLimits: { 'claude-code': l },
});

describe('Settings: Claude Code', () => {
  const region = () => screen.getByRole('region', { name: 'Claude Code' });

  it("shows the server's setup commands (host uid:gid, current image tag) with copy buttons", async () => {
    const { user } = await renderSettings();
    const r = region();
    const login = await within(r).findByText(LOGIN_COMMANDS.login);
    expect(login).toBeVisible();
    expect(login.textContent).toContain('--user 1501:20 ');
    expect(within(r).getByText(LOGIN_COMMANDS.build)).toBeVisible();
    expect(within(r).getByText('docker volume create vibecode-claude-config')).toBeVisible();

    await user.click(within(r).getByRole('button', { name: 'Copy the login command' }));
    expect(await navigator.clipboard.readText()).toBe(LOGIN_COMMANDS.login);
    expect(within(r).getByText('Copied the login command.')).toBeVisible();
    await user.click(within(r).getByRole('button', { name: 'Copy the volume command' }));
    expect(await navigator.clipboard.readText()).toBe(
      'docker volume create vibecode-claude-config',
    );
    await user.click(within(r).getByRole('button', { name: 'Copy the build command' }));
    expect(await navigator.clipboard.readText()).toBe(LOGIN_COMMANDS.build);
  });

  it('says so when the setup commands cannot be loaded', async () => {
    loginCommands = null;
    await renderSettings();
    expect(await within(region()).findByRole('alert')).toHaveTextContent(
      'Could not load the setup commands',
    );
    expect(within(region()).queryByText(/claude auth login/)).toBeNull();
  });

  it('says OK when no limit is recorded', async () => {
    await renderSettings();
    expect(within(region()).getByText('OK')).toBeVisible();
    expect(within(region()).queryByRole('button', { name: "I've logged in" })).toBeNull();
  });

  it('shows "rate limited until" from the backend limits', async () => {
    const until = NOW + 60 * 60_000;
    initialState = withLimit(limit({ until }));
    await renderSettings();
    const time = new Date(until).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(within(region()).getByText(`Rate limited until ${time}`)).toBeVisible();
  });

  it('goes back to OK once the rate limit has reset', async () => {
    initialState = withLimit(limit({ until: NOW - 1000 }));
    await renderSettings();
    expect(await within(region()).findByText('OK')).toBeVisible();
  });

  it('reflects live backend.limited events (until, then needsLogin) like the Build tab', async () => {
    await renderSettings();
    const stream = FakeEventSource.latest;
    if (stream === null) throw new Error('no stream');
    const push = (data: object) => {
      seq += 1;
      const event = EventSchema.parse({
        seq,
        ts: NOW,
        type: 'backend.limited',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code', reason: 'test', ...data },
      });
      act(() => stream.onmessage?.({ data: JSON.stringify(event) }));
    };
    const until = NOW + 2 * 60 * 60_000;
    push({ until, needsLogin: false });
    const time = new Date(until).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(await within(region()).findByText(`Rate limited until ${time}`)).toBeVisible();

    push({ until: null, needsLogin: true });
    expect(await within(region()).findByText('Needs login')).toBeVisible();
    expect(within(region()).getByRole('button', { name: "I've logged in" })).toBeVisible();
  });

  it("needs login: 'I've logged in' clears it, and the status goes back to OK live", async () => {
    initialState = withLimit(limit({ needsLogin: true }));
    const { user } = await renderSettings();
    expect(within(region()).getByText('Needs login')).toBeVisible();

    await user.click(within(region()).getByRole('button', { name: "I've logged in" }));
    expect(cleared).toEqual(['claude-code']);

    seq += 1;
    const event = EventSchema.parse({
      seq,
      ts: NOW,
      type: 'backend.cleared',
      productId: null,
      entityId: null,
      v: 1,
      data: { backend: 'claude-code' },
    });
    const stream = FakeEventSource.latest;
    if (stream === null) throw new Error('no stream');
    act(() => stream.onmessage?.({ data: JSON.stringify(event) }));

    expect(await within(region()).findByText('OK')).toBeVisible();
    expect(within(region()).queryByText('Needs login')).toBeNull();
  });
});
