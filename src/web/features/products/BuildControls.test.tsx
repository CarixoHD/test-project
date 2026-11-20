import { render, screen } from '@testing-library/react';
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

function product(pause?: 'owner' | 'budget'): ProductState {
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
  ];
  const p = events.reduce(reduce, emptyState).products[P];
  if (p === undefined) throw new Error('no product');
  return p;
}

let posts: string[];
let respond: () => Response;

beforeEach(() => {
  posts = [];
  respond = () => Response.json({ ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url);
      return Promise.resolve(respond());
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
