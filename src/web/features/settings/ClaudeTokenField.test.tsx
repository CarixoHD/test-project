import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTokenField } from './ClaudeTokenField.tsx';

// Loading the Claude subscription token status, against the real API client with fetch faked
// at the boundary.

let gets: number;
let stored: { set: boolean; last4: string | null };
/** Planned answers for the next GETs, in order; once empty, GETs answer `stored`. */
let getPlan: Array<'fail' | 'hang'>;
let lastGetSignal: AbortSignal | undefined;

beforeEach(() => {
  gets = 0;
  stored = { set: false, last4: null };
  getPlan = [];
  lastGetSignal = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        gets += 1;
        lastGetSignal = init?.signal ?? undefined;
        const planned = getPlan.shift();
        if (planned === 'fail')
          return Promise.resolve(
            Response.json(
              { error: { code: 'internal', message: 'Database is locked' } },
              { status: 500 },
            ),
          );
        if (planned === 'hang')
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
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

describe('ClaudeTokenField when loading the token status fails', () => {
  it('shows an alert with Try again, and a successful retry shows the entry form', async () => {
    getPlan = ['fail'];
    const user = userEvent.setup();
    render(<ClaudeTokenField />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the token status: Database is locked',
    );
    expect(screen.queryByLabelText('Subscription token')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Subscription token')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(gets).toBe(2);
  });

  it('shows the masked token after a successful retry', async () => {
    getPlan = ['fail'];
    stored = { set: true, last4: 'abcd' };
    const user = userEvent.setup();
    render(<ClaudeTokenField />);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Token set (…abcd)')).toBeInTheDocument();
  });

  it('keeps the alert and the button when the retry fails too', async () => {
    getPlan = ['fail', 'fail'];
    const user = userEvent.setup();
    render(<ClaudeTokenField />);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Database is locked');
    expect(gets).toBe(2);
  });

  it('shows Loading… during a retry and offers no second retry meanwhile', async () => {
    getPlan = ['fail', 'hang'];
    const user = userEvent.setup();
    render(<ClaudeTokenField />);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(gets).toBe(2);
  });

  it('aborts an in-flight retry on unmount', async () => {
    getPlan = ['fail', 'hang'];
    const user = userEvent.setup();
    const { unmount } = render(<ClaudeTokenField />);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText('Loading…');
    expect(lastGetSignal?.aborted).toBe(false);

    unmount();

    expect(lastGetSignal?.aborted).toBe(true);
  });
});
