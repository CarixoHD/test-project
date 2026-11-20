import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SettingsUpdateRequestSchema,
  type SettingsResponse,
  type SettingsUpdateRequest,
} from '../../../shared/dto.ts';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { KEYED_PROVIDER_IDS, type KeyedProviderId } from '../../../shared/models.ts';
import { emptyState } from '../../../shared/state.ts';
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
        return key === undefined ? [] : [{ provider, last4: key.length < 16 ? null : key.slice(-4) }];
      }),
    };
  }

  update(raw: unknown): Response {
    const parsed = SettingsUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: { code: 'invalid', message: 'Invalid settings' } }, { status: 400 });
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

beforeEach(() => {
  server = new FakeSettingsServer();
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
        return Promise.resolve(Response.json({ state: emptyState, lastSeq: 0 }));
      }
      return Promise.resolve(Response.json({ error: { code: 'not_found', message: url } }, { status: 404 }));
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
  return [...document.querySelectorAll('input, textarea, select')].some(
    (el) => (el as HTMLInputElement).value.includes(secret),
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
    expect(pageContains(KEY)).toBe(false);
    expect(pageContains('SECRETSECRET')).toBe(false);
  });
});
