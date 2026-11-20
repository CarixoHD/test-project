import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueStatus } from '../../../shared/domain.ts';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore, useApp, type AppSnapshot } from '../../state/store.ts';
import { FakeEventSource } from '../agents/testing.ts';
import { PreviewControls } from './PreviewControls.tsx';

// PreviewControls against the real store; only fetch and EventSource are faked at the boundary.

const P = ProductIdSchema.parse('p1');
let seq = 0;

const event = (type: string, entityId: string | null, data: unknown): Event => {
  seq += 1;
  return EventSchema.parse({
    seq,
    ts: 1_700_000_000_000 + seq,
    type,
    productId: P,
    entityId,
    v: 1,
    data,
  });
};

const productCreated = () =>
  event('product.created', null, {
    name: 'Todo app',
    idea: 'Track todos',
    budgetUsd: null,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  });

const NO_PREVIEW_PROJECT = { check: ['npm', 'test'], imageInputs: [] };
const PREVIEW_PROJECT = {
  ...NO_PREVIEW_PROJECT,
  preview: { command: ['npm', 'start'], port: 3000 },
};

const projectChanged = (project: object) => event('product.settings_changed', null, { project });

const issueCreated = (n: number, title: string, status: IssueStatus = 'open') =>
  event('issue.created', `i${String(n)}`, {
    issue: {
      id: `i${String(n)}`,
      number: n,
      title,
      body: '',
      status,
      rev: 1,
      priority: 1,
      origin: 'owner',
      prdVersion: 1,
      attemptCount: 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: [],
    },
  });

interface Post {
  url: string;
  body: unknown;
}
let posts: Post[];
let respondToAdd: () => Response | Promise<Response>;
let state: ClientState;

beforeEach(() => {
  seq = 0;
  posts = [];
  respondToAdd = () => Response.json({ ok: true, issueId: 'i7', number: 7 });
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/state') {
        return Promise.resolve(Response.json({ state, lastSeq: seq }));
      }
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve(respondToAdd());
      }
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

function Controls() {
  const product = useApp(selectProduct);
  return product === undefined ? null : <PreviewControls product={product} />;
}
const selectProduct = (s: AppSnapshot) => s.state.products[P];

/** Loads `history` as the store snapshot and renders the controls; returns a live `push`. */
async function renderControls(history: Event[]) {
  state = [productCreated(), ...history].reduce(reduce, emptyState);
  render(
    <AppStoreProvider store={createAppStore()}>
      <Controls />
    </AppStoreProvider>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  /** Delivers live events on the app's /api/events stream. */
  const push = (...events: Event[]) => {
    const stream = FakeEventSource.find('/api/events');
    act(() => {
      for (const e of events) stream.onmessage?.({ data: JSON.stringify(e) });
    });
  };
  return { push };
}

const setUpButton = () => screen.queryByRole('button', { name: 'Set up Preview' });

describe('PreviewControls without a preview config', () => {
  it('explains in plain words why Preview is unavailable', async () => {
    await renderControls([projectChanged(NO_PREVIEW_PROJECT)]);

    const preview = screen.getByRole('button', { name: 'Preview' });
    expect(preview).toHaveAttribute('aria-disabled', 'true');
    expect(preview).toHaveAccessibleDescription(
      "Preview isn't set up yet: the agents haven't told the platform how to start this app. " +
        'Only web apps and APIs can be previewed.',
    );
    expect(screen.queryByText(/project\.json/)).not.toBeInTheDocument();
  });

  it('queues exactly one high-priority Configure Preview issue, even on a double click', async () => {
    const user = userEvent.setup();
    let answer: (r: Response) => void = () => undefined;
    respondToAdd = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    const { push } = await renderControls([projectChanged(NO_PREVIEW_PROJECT)]);

    const button = setUpButton();
    expect(button).not.toBeNull();
    await user.dblClick(button as HTMLElement);
    await act(async () => {
      answer(Response.json({ ok: true, issueId: 'i7', number: 7 }));
      await Promise.resolve();
    });

    expect(posts).toHaveLength(1);
    const post = posts[0] as Post;
    expect(post.url).toBe('/api/products/p1/issues');
    const body = post.body as { title: string; body: string; priority: number };
    expect(body.title).toBe('Configure Preview');
    expect(body.priority).toBe(1);
    expect(body.body).toContain('"preview": {"command": [...], "port": N}');
    expect(body.body).toContain('.vibecode/project.json');
    expect(body.body).toContain('0.0.0.0:N');
    expect(body.body).toContain('/workspace');
    expect(body.body).toMatch(/check/);

    expect(await screen.findByText('Queued as #7')).toBeInTheDocument();
    expect(setUpButton()).not.toBeInTheDocument();

    // The card arrives and gets picked up: still no button.
    push(issueCreated(7, 'Configure Preview'));
    expect(setUpButton()).not.toBeInTheDocument();
    push(
      event('issue.status_changed', 'i7', {
        from: 'open',
        to: 'in_progress',
        attemptCount: 1,
        runAfter: 0,
      }),
    );
    expect(setUpButton()).not.toBeInTheDocument();
    expect(posts).toHaveLength(1);

    // Once that issue is final without a config, the owner can try again.
    push(event('issue.cancelled', 'i7', { from: 'in_progress', by: 'owner', reason: 'stuck' }));
    expect(setUpButton()).toBeInTheDocument();
    expect(screen.queryByText(/Queued as/)).not.toBeInTheDocument();
  });

  it('hides the button while an unfinished Configure Preview issue exists', async () => {
    await renderControls([
      projectChanged(NO_PREVIEW_PROJECT),
      issueCreated(4, 'Configure Preview', 'in_progress'),
    ]);

    expect(setUpButton()).not.toBeInTheDocument();
    expect(screen.getByText('Queued as #4')).toBeInTheDocument();
  });

  it('offers the button again when the earlier Configure Preview issue is final', async () => {
    await renderControls([
      projectChanged(NO_PREVIEW_PROJECT),
      issueCreated(4, 'Configure Preview', 'cancelled'),
      issueCreated(5, 'Something else', 'open'),
    ]);

    expect(setUpButton()).toBeInTheDocument();
    expect(screen.queryByText(/Queued as/)).not.toBeInTheDocument();
  });

  it('shows the server reason in the alert when queueing fails', async () => {
    const user = userEvent.setup();
    respondToAdd = () =>
      Response.json(
        { error: { code: 'conflict', message: 'The product is archived' } },
        { status: 409 },
      );
    await renderControls([projectChanged(NO_PREVIEW_PROJECT)]);

    await user.click(setUpButton() as HTMLElement);

    expect(await screen.findByRole('alert')).toHaveTextContent('The product is archived');
    expect(setUpButton()).toBeInTheDocument();
  });

  it('enables Preview and drops the message and button once the config arrives', async () => {
    const { push } = await renderControls([projectChanged(NO_PREVIEW_PROJECT)]);
    expect(setUpButton()).toBeInTheDocument();

    push(projectChanged(PREVIEW_PROJECT));

    expect(setUpButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't set up yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).not.toHaveAttribute('aria-disabled');
  });
});
