import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type Auth } from '../auth/index.ts';
import { PasswordSection } from './PasswordSection.tsx';

// The password form against a fake POST /api/settings/password with the server's rules:
// 12+ characters, `current` required and checked once a password is set, 5 tries per minute.

const OLD = 'old password 123';
const NEXT = 'new password 456';

let server: { password: string | null; posts: unknown[]; rateLimited: boolean };

const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

beforeEach(() => {
  server = { password: null, posts: [], rateLimited: false };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/session') {
        return Promise.resolve(
          Response.json({ passwordSet: server.password !== null, authenticated: true }),
        );
      }
      if (url === '/api/settings/password' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { current?: string; next: string };
        server.posts.push(body);
        if (server.rateLimited) return Promise.resolve(error(429, 'rate_limited', 'Slow down'));
        if (server.password !== null && body.current !== server.password) {
          return Promise.resolve(error(400, 'invalid', 'The current password is wrong'));
        }
        server.password = body.next;
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(error(404, 'not_found', url));
    }),
  );
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection() {
  const auth: Auth = { passwordSet: false, logout: vi.fn(), passwordChanged: vi.fn() };
  render(
    <AuthContext value={auth}>
      <PasswordSection />
    </AuthContext>,
  );
  return auth;
}

describe('PasswordSection', () => {
  it('explains why a password matters and recommends Tailscale or TLS', async () => {
    renderSection();
    const section = await screen.findByRole('region', { name: 'Password' });
    expect(section).toHaveTextContent(/requires a password/i);
    expect(section).toHaveTextContent(/Tailscale/);
    expect(section).toHaveTextContent(/TLS/);
  });

  it('sets the first password: new and confirm, no current password', async () => {
    const user = userEvent.setup({ delay: null });
    const auth = renderSection();
    await user.type(await screen.findByLabelText('New password'), NEXT);
    expect(screen.queryByLabelText('Current password')).toBeNull();
    await user.type(screen.getByLabelText('Confirm new password'), NEXT);
    await user.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText(/Password set\./)).toBeVisible();
    expect(server.posts).toEqual([{ next: NEXT }]);
    expect(auth.passwordChanged).toHaveBeenCalledTimes(1);
    // Now a change form: the current password is asked for.
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('validates before sending: length and matching confirmation', async () => {
    const user = userEvent.setup({ delay: null });
    renderSection();
    await user.type(await screen.findByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(screen.getByText('Use at least 12 characters.')).toBeVisible();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('New password')).toHaveFocus();

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), NEXT);
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), `${NEXT}x`);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(screen.getByText('The passwords do not match.')).toBeVisible();
    expect(screen.getByLabelText('Confirm new password')).toHaveFocus();
    expect(server.posts).toEqual([]);
  });

  it('changes the password: requires the current one and shows a wrong one on its field', async () => {
    const user = userEvent.setup({ delay: null });
    server.password = OLD;
    const auth = renderSection();
    const current = await screen.findByLabelText('Current password');
    await user.type(screen.getByLabelText('New password'), NEXT);
    await user.type(screen.getByLabelText('Confirm new password'), NEXT);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('Enter your current password.')).toBeVisible();
    expect(current).toHaveFocus();
    expect(server.posts).toEqual([]);

    await user.type(current, 'not it at all');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is wrong')).toBeVisible();
    expect(current).toHaveAttribute('aria-invalid', 'true');
    expect(server.password).toBe(OLD);

    await user.clear(current);
    await user.type(current, OLD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Password changed\./)).toBeVisible();
    expect(server.password).toBe(NEXT);
    expect(server.posts.at(-1)).toEqual({ current: OLD, next: NEXT });
    expect(auth.passwordChanged).toHaveBeenCalledTimes(1);
  });

  it('explains the rate limit', async () => {
    const user = userEvent.setup({ delay: null });
    server.password = OLD;
    server.rateLimited = true;
    renderSection();
    await user.type(await screen.findByLabelText('Current password'), OLD);
    await user.type(screen.getByLabelText('New password'), NEXT);
    await user.type(screen.getByLabelText('Confirm new password'), NEXT);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait a minute, then try again.',
    );
  });
});
