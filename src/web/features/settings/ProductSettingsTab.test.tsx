import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSettings } from '../../../shared/domain.ts';
import { EventSchema } from '../../../shared/events.ts';
import { emptyState, reduce, type ProductState } from '../../../shared/state.ts';
import { ProductSettingsTab } from './ProductSettingsTab.tsx';

// The product settings form against the real API client, with fetch faked at the boundary.

function product(settings: Partial<ProductSettings> = {}): ProductState {
  const created = EventSchema.parse({
    seq: 1,
    ts: 1_700_000_000_000,
    type: 'product.created',
    productId: 'p1',
    entityId: null,
    v: 1,
    data: {
      name: 'Todo app',
      idea: 'Todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
      ...settings,
    },
  });
  const p = reduce(emptyState, created).products['p1' as ProductState['id']];
  if (p === undefined) throw new Error('no product');
  return p;
}

type Sent = { url: string; method: string | undefined; body: unknown };
let sent: Sent[];
let response: () => Response;

beforeEach(() => {
  sent = [];
  response = () => Response.json({ ok: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      sent.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(response());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const roleGroup = (name: string) => screen.getByRole('group', { name });

describe('ProductSettingsTab', () => {
  it('shows the current values in labelled controls', () => {
    render(
      <ProductSettingsTab
        product={product({
          budgetUsd: 12.5,
          maxParallel: 4,
          maxAttempts: 2,
          models: { reviewer: { provider: 'openai', model: 'gpt-x' } },
          gitRemote: { url: 'git@example.com:me/todo.git' },
        })}
      />,
    );

    expect(screen.getByRole('form', { name: 'Settings for Todo app' })).toBeInTheDocument();
    expect(screen.getByLabelText('Budget (USD)')).toHaveValue(12.5);
    expect(screen.getByLabelText('Parallel agents')).toHaveValue(4);
    expect(screen.getByLabelText('Attempts per issue')).toHaveValue(2);
    expect(screen.getByLabelText('Git remote URL')).toHaveValue('git@example.com:me/todo.git');
    const reviewer = roleGroup('Reviewer model');
    expect(within(reviewer).getByLabelText('Provider')).toHaveValue('openai');
    expect(within(reviewer).getByLabelText('Model')).toHaveValue('gpt-x');
    const implementer = roleGroup('Implementer model');
    expect(within(implementer).getByLabelText('Provider')).toHaveValue('');
    expect(within(implementer).getByLabelText('Model')).toHaveValue('');
  });

  it('shows the defaults of a new product: 3 parallel agents and 3 attempts, no budget', () => {
    render(<ProductSettingsTab product={product()} />);
    expect(screen.getByLabelText('Parallel agents')).toHaveValue(3);
    expect(screen.getByLabelText('Attempts per issue')).toHaveValue(3);
    expect(screen.getByLabelText('Budget (USD)')).toHaveValue(null);
  });

  it('saves the edited settings with the keyboard and reports success', async () => {
    const user = userEvent.setup();
    render(
      <ProductSettingsTab
        product={product({ models: { reviewer: { provider: 'openai', model: 'gpt-x' } } })}
      />,
    );

    await user.click(screen.getByLabelText('Budget (USD)'));
    await user.keyboard('20');
    await user.tab();
    expect(screen.getByLabelText('Parallel agents')).toHaveFocus();
    await user.keyboard('{Backspace}5');
    const implementer = roleGroup('Implementer model');
    await user.selectOptions(within(implementer).getByLabelText('Provider'), 'anthropic');
    await user.type(within(implementer).getByLabelText('Model'), 'claude-x');
    const reviewer = roleGroup('Reviewer model');
    await user.clear(within(reviewer).getByLabelText('Model'));
    await user.selectOptions(within(reviewer).getByLabelText('Provider'), '');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved.');
    expect(sent).toEqual([
      {
        url: '/api/products/p1/settings',
        method: 'PATCH',
        body: {
          budgetUsd: 20,
          maxParallel: 5,
          maxAttempts: 3,
          gitRemote: null,
          models: {
            sparring: null,
            orchestrator: null,
            implementer: { provider: 'anthropic', model: 'claude-x' },
            reviewer: null,
            utility: null,
          },
        },
      },
    ]);
  });

  it('shows inline validation errors, focuses the first one and does not save', async () => {
    const user = userEvent.setup();
    render(<ProductSettingsTab product={product()} />);

    await user.type(screen.getByLabelText('Budget (USD)'), '0');
    await user.clear(screen.getByLabelText('Parallel agents'));
    await user.type(screen.getByLabelText('Parallel agents'), '11');
    await user.clear(screen.getByLabelText('Attempts per issue'));
    const implementer = roleGroup('Implementer model');
    await user.selectOptions(within(implementer).getByLabelText('Provider'), 'anthropic');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const budget = screen.getByLabelText('Budget (USD)');
    expect(budget).toHaveAttribute('aria-invalid', 'true');
    expect(budget).toHaveAccessibleDescription(expect.stringContaining('more than 0'));
    expect(screen.getByLabelText('Parallel agents')).toHaveAccessibleDescription(
      expect.stringContaining('between 1 and 10'),
    );
    expect(screen.getByLabelText('Attempts per issue')).toHaveAttribute('aria-invalid', 'true');
    expect(within(implementer).getByLabelText('Model')).toHaveAccessibleDescription(
      expect.stringContaining('Enter a model'),
    );
    expect(budget).toHaveFocus();
    expect(sent).toEqual([]);
  });

  it.each([
    'https://user:token@example.com/r.git',
    'ext::sh -c id',
    'file:///etc/passwd',
    '../local/repo',
  ])('shows an inline error for the git remote %s and does not save', async (url) => {
    const user = userEvent.setup();
    render(<ProductSettingsTab product={product()} />);

    await user.type(screen.getByLabelText('Git remote URL'), url);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const remote = screen.getByLabelText('Git remote URL');
    expect(remote).toHaveAttribute('aria-invalid', 'true');
    expect(remote).toHaveAccessibleDescription(
      expect.stringContaining(
        'Use an https:// or SSH URL without credentials. Set the token separately.',
      ),
    );
    expect(remote).toHaveFocus();
    expect(sent).toEqual([]);
  });

  it('saves a valid https git remote', async () => {
    const user = userEvent.setup();
    render(<ProductSettingsTab product={product()} />);

    await user.type(screen.getByLabelText('Git remote URL'), 'https://example.com/r.git');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved.');
    expect(sent[0]?.body).toMatchObject({ gitRemote: { url: 'https://example.com/r.git' } });
  });

  it('shows the server error when saving fails and keeps the input', async () => {
    const user = userEvent.setup();
    response = () =>
      Response.json({ error: { code: 'invalid', message: 'Budget too big' } }, { status: 400 });
    render(<ProductSettingsTab product={product()} />);

    await user.type(screen.getByLabelText('Budget (USD)'), '7');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Budget too big');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Budget (USD)')).toHaveValue(7);
  });
});
