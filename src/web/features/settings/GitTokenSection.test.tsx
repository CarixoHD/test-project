import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitTokenSection } from './GitTokenSection.tsx';

// The write-only git remote token on the product Settings tab, against the real API client
// with fetch faked at the boundary.

const TOKEN = 'ghp_SecretTokenValue1234wxyz';

type Sent = { url: string; method: string; body: unknown };
let sent: Sent[];
let stored: { set: boolean; last4: string | null };
let failPut: boolean;

beforeEach(() => {
  sent = [];
  stored = { set: false, last4: null };
  failPut = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      sent.push({ url, method, body });
      if (method === 'PUT') {
        if (failPut)
          return Promise.resolve(
            Response.json(
              { error: { code: 'invalid', message: 'A token must not contain whitespace' } },
              { status: 400 },
            ),
          );
        const token = (body as { token: string | null }).token;
        stored =
          token === null ? { set: false, last4: null } : { set: true, last4: token.slice(-4) };
      }
      return Promise.resolve(Response.json(stored));
    }),
  );
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

describe('GitTokenSection', () => {
  it('saves a token with the keyboard and then shows only its last 4 characters', async () => {
    const user = userEvent.setup();
    render(<GitTokenSection productId="p1" />);
    const input = await screen.findByLabelText('Git remote access token');
    expect(input).toHaveAttribute('type', 'password');

    await user.click(input);
    await user.keyboard(`${TOKEN}{Enter}`);

    expect(await screen.findByText('Token ending in wxyz')).toBeInTheDocument();
    expect(sent.at(-1)).toEqual({
      url: '/api/products/p1/git-token',
      method: 'PUT',
      body: { token: TOKEN },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Token saved.');
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
  });

  it('shows a stored token masked and removes it', async () => {
    stored = { set: true, last4: 'abcd' };
    const user = userEvent.setup();
    render(<GitTokenSection productId="p1" />);
    expect(await screen.findByText('Token ending in abcd')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove token' }));

    expect(await screen.findByLabelText('Git remote access token')).toBeInTheDocument();
    expect(sent.at(-1)).toMatchObject({ method: 'PUT', body: { token: null } });
    expect(screen.getByRole('status')).toHaveTextContent('Token removed.');
  });

  it('shows the server error next to the field', async () => {
    failPut = true;
    const user = userEvent.setup();
    render(<GitTokenSection productId="p1" />);
    await user.type(await screen.findByLabelText('Git remote access token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Save token' }));

    const input = screen.getByLabelText('Git remote access token');
    expect(await screen.findByText('A token must not contain whitespace')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('asks for a token before saving an empty one', async () => {
    const user = userEvent.setup();
    render(<GitTokenSection productId="p1" />);
    await user.click(await screen.findByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('Enter a token.')).toBeInTheDocument();
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([]);
  });
});
