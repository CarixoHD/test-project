import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type Auth } from '../auth/index.ts';
import { PasswordSection } from './PasswordSection.tsx';

// The password form against a fake POST/DELETE /api/settings/password with the server's rules:
// 12+ characters, `current` required and checked once a password is set, 5 tries per minute.

const OLD = 'old password 123';
const NEXT = 'new password 456';

let state: {
  password: string | null;
  posts: unknown[];
  deletes: unknown[];
  rateLimited: boolean;
};

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });

const server = setupServer(
  http.get('/api/session', () =>
    HttpResponse.json({ passwordSet: state.password !== null, authenticated: true }),
  ),
  http.post('/api/settings/password', async ({ request }) => {
    const body = (await request.json()) as { current?: string; next: string };
    state.posts.push(body);
    if (state.rateLimited) return error(429, 'rate_limited', 'Slow down');
    if (state.password !== null && body.current !== state.password) {
      return error(400, 'invalid', 'The current password is wrong');
    }
    state.password = body.next;
    return HttpResponse.json({ ok: true });
  }),
  http.delete('/api/settings/password', async ({ request }) => {
    const body = (await request.json()) as { current?: string };
    state.deletes.push(body);
    if (state.rateLimited) return error(429, 'rate_limited', 'Slow down');
    if (state.password === null) return error(409, 'conflict', 'No password is set');
    if (body.current !== state.password) {
      return error(401, 'unauthorized', 'The current password is wrong');
    }
    state.password = null;
    return HttpResponse.json({ ok: true });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  state = { password: null, posts: [], deletes: [], rateLimited: false };
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  server.close();
});

function renderSection() {
  const auth: Auth = {
    passwordSet: false,
    logout: vi.fn(),
    passwordChanged: vi.fn<(passwordSet: boolean) => void>(),
  };
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
    expect(state.posts).toEqual([{ next: NEXT }]);
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
    expect(state.posts).toEqual([]);
  });

  it('changes the password: requires the current one and shows a wrong one on its field', async () => {
    const user = userEvent.setup({ delay: null });
    state.password = OLD;
    const auth = renderSection();
    const current = await screen.findByLabelText('Current password');
    await user.type(screen.getByLabelText('New password'), NEXT);
    await user.type(screen.getByLabelText('Confirm new password'), NEXT);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText('Enter your current password.')).toBeVisible();
    expect(current).toHaveFocus();
    expect(state.posts).toEqual([]);

    await user.type(current, 'not it at all');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The current password is wrong')).toBeVisible();
    expect(current).toHaveAttribute('aria-invalid', 'true');
    expect(state.password).toBe(OLD);

    await user.clear(current);
    await user.type(current, OLD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Password changed\./)).toBeVisible();
    expect(state.password).toBe(NEXT);
    expect(state.posts.at(-1)).toEqual({ current: OLD, next: NEXT });
    expect(auth.passwordChanged).toHaveBeenCalledTimes(1);
  });

  it('removes the password with the current one and switches back to setting one', async () => {
    const user = userEvent.setup({ delay: null });
    state.password = OLD;
    const auth = renderSection();
    const current = await screen.findByLabelText('Current password');
    expect(
      screen.getByText('Without a password Vibecode only answers on this machine (localhost).'),
    ).toBeVisible();

    // An empty current password is caught before sending.
    await user.click(screen.getByRole('button', { name: 'Remove password' }));
    expect(screen.getByText('Enter your current password.')).toBeVisible();
    expect(current).toHaveFocus();
    expect(state.deletes).toEqual([]);

    await user.type(current, 'not it at all');
    await user.click(screen.getByRole('button', { name: 'Remove password' }));
    expect(await screen.findByText('The current password is wrong')).toBeVisible();
    expect(current).toHaveAttribute('aria-invalid', 'true');
    expect(state.password).toBe(OLD);

    await user.clear(current);
    await user.type(current, OLD);
    await user.click(screen.getByRole('button', { name: 'Remove password' }));
    expect(await screen.findByText(/Password removed\./)).toBeVisible();
    expect(state.password).toBeNull();
    expect(state.deletes.at(-1)).toEqual({ current: OLD });
    expect(auth.passwordChanged).toHaveBeenLastCalledWith(false);
    // Still in the app: the section now sets the first password again.
    expect(await screen.findByRole('button', { name: 'Set password' })).toBeVisible();
    expect(screen.getByText('No password is set.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove password' })).toBeNull();
  });

  it('explains the rate limit', async () => {
    const user = userEvent.setup({ delay: null });
    state.password = OLD;
    state.rateLimited = true;
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
