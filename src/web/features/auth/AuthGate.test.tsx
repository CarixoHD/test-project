import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../../../shared/state.ts';
import { App } from '../../App.tsx';
import { routes } from '../../routes.tsx';
import { getSettings } from '../../state/api.ts';
import { createAppStore } from '../../state/store.ts';
import { AuthGate } from './index.ts';

// The auth gate end to end: real API client, store, router and layout; only the network is
// faked. The fake server holds one password and one session cookie, like http/auth.ts.

const PASSWORD = 'correct horse battery';

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {
    this.readyState = 2;
  }
}

const unauthorized = () =>
  Response.json({ error: { code: 'unauthorized', message: 'Log in first' } }, { status: 401 });

let server: {
  passwordSet: boolean;
  loggedIn: boolean;
  rateLimited: boolean;
  calls: string[];
};

beforeEach(() => {
  server = { passwordSet: true, loggedIn: false, rateLimited: false, calls: [] };
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      server.calls.push(`${method} ${url}`);
      const authed = !server.passwordSet || server.loggedIn;
      if (url === '/api/session') {
        return Promise.resolve(
          Response.json({ passwordSet: server.passwordSet, authenticated: authed }),
        );
      }
      if (url === '/api/login') {
        if (server.rateLimited) {
          return Promise.resolve(
            Response.json(
              { error: { code: 'rate_limited', message: 'Too many attempts' } },
              { status: 429 },
            ),
          );
        }
        const { password } = JSON.parse(String(init?.body)) as { password: string };
        if (password !== PASSWORD) {
          return Promise.resolve(
            Response.json(
              { error: { code: 'unauthorized', message: 'Wrong password' } },
              { status: 401 },
            ),
          );
        }
        server.loggedIn = true;
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (!authed) return Promise.resolve(unauthorized());
      if (url === '/api/logout') {
        server.loggedIn = false;
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url === '/api/state') {
        return Promise.resolve(Response.json({ state: emptyState, lastSeq: 0 }));
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

function renderApp() {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  render(
    <AuthGate>
      <App store={createAppStore()} router={router} />
    </AuthGate>,
  );
}

const passwordField = () => screen.getByLabelText('Password');

describe('AuthGate', () => {
  it('shows only the Login page when a password is set and there is no session', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Log in to Vibecode' })).toBeVisible();
    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Products' })).toBeNull();
    // The app's store never asked for data it may not see.
    expect(server.calls).toEqual(['GET /api/session']);
  });

  it('shows the app directly when no password is set, without a Logout button', async () => {
    server.passwordSet = false;
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Products' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('logs in: a wrong password shows an error, the right one opens the app', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText('Password'), 'nope{Enter}');
    expect(await screen.findByText('Wrong password. Try again.')).toBeVisible();
    expect(passwordField()).toHaveAttribute('aria-invalid', 'true');
    expect(passwordField()).toHaveFocus();
    expect(passwordField()).toHaveValue('');

    await user.type(passwordField(), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Products' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeVisible();
  });

  it('asks for a password before sending and explains the rate limit', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Log in' }));
    expect(screen.getByText('Enter your password.')).toBeVisible();
    expect(server.calls).not.toContain('POST /api/login');

    server.rateLimited = true;
    await user.type(passwordField(), 'anything{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many login attempts. Wait a minute, then try again.',
    );
  });

  it('returns to Login when any API call answers 401', async () => {
    server.loggedIn = true;
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Products' })).toBeVisible();

    server.loggedIn = false; // the session expired or the password changed elsewhere
    await act(async () => {
      await getSettings().catch(() => undefined);
    });
    expect(await screen.findByRole('heading', { name: 'Log in to Vibecode' })).toBeVisible();
    expect(screen.getByText('Your session has ended. Log in again.')).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('logs out from the header', async () => {
    const user = userEvent.setup();
    server.loggedIn = true;
    renderApp();
    await user.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Log in to Vibecode' })).toBeVisible();
    expect(server.calls).toContain('POST /api/logout');
    expect(server.loggedIn).toBe(false);
  });

  it('offers a retry when the session cannot be checked', async () => {
    const user = userEvent.setup();
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach the Vibecode server/);
    vi.stubGlobal('fetch', realFetch);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Log in to Vibecode' })).toBeVisible();
  });
});
