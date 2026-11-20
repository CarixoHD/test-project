import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ProductState } from '../../../shared/state.ts';
import { BuildControls } from './BuildControls.tsx';

const P = ProductIdSchema.parse('p1');

const ev = (seq: number, type: string, data: object): Event =>
  EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    productId: P,
    entityId: null,
    v: 1,
    data,
  });

const PREVIEW_PROJECT = {
  check: ['npm', 'test'],
  imageInputs: [],
  preview: { command: ['npm', 'start'], port: 3000 },
};

function product(pause?: 'owner' | 'budget', project?: object): ProductState {
  const events = [
    ev(1, 'product.created', {
      name: 'Todo app',
      idea: 'Track todos',
      budgetUsd: 10,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    }),
    ...(pause === undefined ? [] : [ev(2, 'product.paused', { reason: pause })]),
    ...(project === undefined ? [] : [ev(3, 'product.settings_changed', { project })]),
  ];
  const p = events.reduce(reduce, emptyState).products[P];
  if (p === undefined) throw new Error('no product');
  return p;
}

let posts: string[];
let deletes: string[];
let respond: (url: string, method: string) => Response | Promise<Response>;

beforeEach(() => {
  posts = [];
  deletes = [];
  respond = () => Response.json({ ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url);
      if (init?.method === 'DELETE') deletes.push(url);
      return Promise.resolve(respond(url, init?.method ?? 'GET'));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BuildControls', () => {
  it('shows Running and pauses from the keyboard', async () => {
    const user = userEvent.setup();
    render(<BuildControls product={product()} />);
    expect(screen.getByText('Running')).toBeInTheDocument();

    await user.tab();
    const button = screen.getByRole('button', { name: 'Pause build' });
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(posts).toEqual(['/api/products/p1/pause']);
  });

  it('toggles to Resume when the product is paused by the owner', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BuildControls product={product()} />);
    rerender(<BuildControls product={product('owner')} />);

    expect(screen.getByText('Paused by you')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume build' }));
    expect(posts).toEqual(['/api/products/p1/resume']);
  });

  it('shows a budget pause and the server reason when resuming is refused', async () => {
    const user = userEvent.setup();
    respond = () =>
      Response.json(
        { error: { code: 'conflict', message: 'The budget is exhausted' } },
        { status: 409 },
      );
    render(<BuildControls product={product('budget')} />);

    expect(screen.getByText('Paused: budget reached')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume build' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The budget is exhausted');
  });
});

const PREVIEW = { url: 'http://127.0.0.1:49152/', container: 'vibecode-run1', startedAt: 1 };

describe('BuildControls preview', () => {
  it('disables Preview with a reason when the product has no preview config', async () => {
    const user = userEvent.setup();
    render(<BuildControls product={product(undefined, { check: ['x'], imageInputs: [] })} />);

    const button = screen.getByRole('button', { name: 'Preview' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(/no preview configured/i);
    await user.click(button);
    expect(posts).toEqual([]);
  });

  it('starts the preview, shows progress while starting, then Open and Stop', async () => {
    const user = userEvent.setup();
    let answer: (r: Response) => void = () => undefined;
    respond = (url, method) =>
      method === 'POST' && url.endsWith('/preview')
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : Response.json({ ok: true });
    const withPreview = product(undefined, PREVIEW_PROJECT);
    const { rerender } = render(<BuildControls product={withPreview} />);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(posts).toEqual(['/api/products/p1/preview']);
    expect(await screen.findByText(/starting the preview/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open preview/i })).not.toBeInTheDocument();

    answer(Response.json({ url: PREVIEW.url }));
    // The preview.started event reaches the store and the page passes it down.
    rerender(<BuildControls product={withPreview} preview={PREVIEW} />);
    await waitFor(() => {
      expect(screen.queryByText(/starting the preview/i)).not.toBeInTheDocument();
    });
    const open = screen.getByRole('link', { name: /open preview/i });
    expect(open).toHaveAttribute('href', PREVIEW.url);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'));

    await user.click(screen.getByRole('button', { name: 'Stop preview' }));
    expect(deletes).toEqual(['/api/products/p1/preview']);
  });

  it('shows the server reason when the preview fails to start', async () => {
    const user = userEvent.setup();
    respond = () =>
      Response.json(
        { error: { code: 'conflict', message: 'The preview did not answer on port 3000' } },
        { status: 409 },
      );
    render(<BuildControls product={product(undefined, PREVIEW_PROJECT)} />);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer on port 3000');
    expect(screen.getByRole('button', { name: 'Preview' })).not.toHaveAttribute('aria-disabled');
  });
});
