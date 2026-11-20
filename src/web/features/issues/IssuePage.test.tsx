import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { IssueIdSchema, ProductIdSchema } from '../../../shared/ids.ts';
import { emptyState, reduce, type ClientState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { FakeEventSource } from '../agents/testing.ts';
import { IssuePage } from './IssuePage.tsx';

// The issue detail page against the real store: ClientState comes from a stubbed
// GET /api/state, artifacts from stubbed fetches, agent logs from fake EventSources.

const P = ProductIdSchema.parse('p1');
const T0 = 1_700_000_000_000;
const SHA = 'a'.repeat(40);
let seq = 0;

const event = (type: string, entityId: string | null, data: unknown): Event => {
  seq += 1;
  return EventSchema.parse({ seq, ts: T0 + seq * 1000, type, productId: P, entityId, v: 1, data });
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

const issueCreated = (
  n: number,
  title: string,
  extra: { body?: string; dependsOn?: string[]; priority?: number } = {},
) =>
  event('issue.created', `i${String(n)}`, {
    issue: {
      id: `i${String(n)}`,
      number: n,
      title,
      body: extra.body ?? '',
      status: 'open',
      rev: 1,
      priority: extra.priority ?? 0,
      origin: 'orchestrator',
      prdVersion: 1,
      attemptCount: 0,
      heldQuestionId: null,
      runAfter: 0,
      mergedOrder: null,
      mergeSha: null,
      failureReason: null,
      dependsOn: extra.dependsOn ?? [],
    },
  });

const attemptStarted = (id: string, n: number) =>
  event('attempt.started', id, { issueId: 'i2', n, issueRev: 1, baseSha: SHA, branch: `b/${id}` });

const attemptStep = (id: string, step: string) =>
  event('attempt.step', id, { issueId: 'i2', step });

const attemptEnded = (
  id: string,
  status: string,
  extra: { counted?: boolean; feedback?: string | null; review?: unknown } = {},
) =>
  event('attempt.ended', id, {
    issueId: 'i2',
    status,
    counted: extra.counted ?? true,
    headSha: null,
    feedback: extra.feedback ?? null,
    review: extra.review ?? null,
    checkExit: null,
    interruptReason: null,
  });

const agentSpawned = (id: string, role: string, attemptId: string) =>
  event('agent.spawned', id, {
    role,
    model: { provider: 'openrouter', model: 'qwen/qwen3-coder' },
    issueId: 'i2',
    attemptId,
  });

/** Issue #2 depends on #1 and has two attempts: a1 rejected (counted), a2 still in review. */
const HISTORY = (): Event[] => [
  productCreated(),
  issueCreated(1, 'Login'),
  issueCreated(2, 'Dark mode', {
    body: 'Respect the **OS** setting.\n\n<script>alert(1)</script><img src=x onerror="alert(2)">',
    dependsOn: ['i1'],
    priority: 1,
  }),
  event('issue.status_changed', 'i2', {
    from: 'open',
    to: 'in_progress',
    attemptCount: 0,
    runAfter: 0,
  }),
  attemptStarted('a1', 1),
  agentSpawned('ag1', 'implementer', 'a1'),
  attemptStep('a1', 'check'),
  attemptStep('a1', 'review'),
  agentSpawned('ag2', 'reviewer', 'a1'),
  attemptEnded('a1', 'rejected', {
    feedback: 'Toggle is not keyboard accessible',
    review: { approve: false, findings: ['Toggle is not keyboard accessible'] },
  }),
  attemptStarted('a2', 2),
  attemptStep('a2', 'review'),
];

type Route = () => Response;
let routes: Record<string, Route> = {};
let calls: { url: string; method: string }[] = [];

function stubNetwork(state: ClientState): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/api/state') return Promise.resolve(Response.json({ state, lastSeq: seq }));
      const method = init.method ?? 'GET';
      calls.push({ url, method });
      const route = routes[`${method} ${url}`];
      return Promise.resolve(
        route === undefined
          ? Response.json({ error: { code: 'not_found', message: 'none' } }, { status: 404 })
          : route(),
      );
    }),
  );
}

async function renderPage(
  history: Event[] = HISTORY(),
  tweak: (s: ClientState) => ClientState = (s) => s,
) {
  const state = tweak(history.reduce(reduce, emptyState));
  stubNetwork(state);
  render(
    <MemoryRouter initialEntries={['/products/p1/issues/i2']}>
      <AppStoreProvider store={createAppStore()}>
        <Routes>
          <Route path="/products/:id/issues/:issueId" element={<IssuePage />} />
        </Routes>
      </AppStoreProvider>
    </MemoryRouter>,
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return userEvent.setup();
}

const attemptSection = (n: number) => screen.getByRole('region', { name: `Attempt ${String(n)}` });

beforeEach(() => {
  seq = 0;
  routes = {};
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

describe('IssuePage: issue facts', () => {
  it('shows title, status, priority, dependencies and the sanitised markdown body', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: '#2 Dark mode' })).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#1 Login' })).toHaveAttribute(
      'href',
      '/products/p1/issues/i1',
    );
    expect(screen.getByText('OS').tagName).toBe('STRONG');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the cost text for an issue that has usage', async () => {
    await renderPage(HISTORY(), (s) => ({
      ...s,
      usage: {
        ...s.usage,
        byIssue: {
          [IssueIdSchema.parse('i2')]: {
            apiUsd: 0.42,
            apiUnpriced: false,
            subscriptionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            subscriptionCalls: 0,
          },
        },
      },
    }));
    expect(screen.getByText('US$0.42')).toBeInTheDocument();
  });

  it('shows the held question', async () => {
    await renderPage([
      ...HISTORY(),
      event('question.asked', 'q1', {
        target: 'issue',
        issueId: 'i2',
        agentId: null,
        text: 'Which colour for dark mode?',
      }),
      event('issue.held', 'i2', { questionId: 'q1' }),
    ]);
    expect(screen.getByText('Which colour for dark mode?')).toBeInTheDocument();
  });

  it('shows a withdrawn held question as withdrawn, without an answer form', async () => {
    await renderPage([
      ...HISTORY(),
      event('question.asked', 'q1', {
        target: 'issue',
        issueId: 'i2',
        agentId: null,
        text: 'Which colour for dark mode?',
      }),
      event('issue.held', 'i2', { questionId: 'q1' }),
      event('issue.cancelled', 'i2', { from: 'open', by: 'owner', reason: 'Not needed' }),
      event('question.withdrawn', 'q1', { reason: 'The issue was cancelled.' }),
    ]);
    const section = screen.getByRole('region', { name: 'Question withdrawn' });
    expect(section).toHaveTextContent('Which colour for dark mode?');
    expect(section).toHaveTextContent('Withdrawn (issue cancelled)');
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Send answer' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Waiting for your answer' })).toBeNull();
  });

  it('answers the held question with the shared answer form', async () => {
    const user = await renderPage([
      ...HISTORY(),
      event('question.asked', 'q1', {
        target: 'issue',
        issueId: 'i2',
        agentId: null,
        text: 'Which colour for dark mode?',
      }),
      event('issue.held', 'i2', { questionId: 'q1' }),
    ]);
    routes['POST /api/questions/q1/answer'] = () => Response.json({ ok: true });
    const section = screen.getByRole('region', { name: 'Waiting for your answer' });
    await user.type(within(section).getByRole('textbox', { name: 'Your answer' }), 'Slate grey');
    await user.click(within(section).getByRole('button', { name: 'Send answer' }));
    expect(calls).toContainEqual({ url: '/api/questions/q1/answer', method: 'POST' });
  });

  it('opens the shared Edit and Cancel dialogs and cancels the issue', async () => {
    const user = await renderPage();
    routes['POST /api/issues/i2/cancel'] = () => Response.json({ ok: true });

    await user.click(screen.getByRole('button', { name: 'Edit issue #2' }));
    const edit = screen.getByRole('dialog', { name: /Edit issue #2/ });
    expect(within(edit).getByRole('textbox', { name: 'Title' })).toHaveValue('Dark mode');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Cancel issue #2' }));
    const cancel = screen.getByRole('dialog', { name: 'Cancel issue #2?' });
    await user.click(within(cancel).getByRole('button', { name: 'Cancel issue' }));
    expect(calls).toContainEqual({ url: '/api/issues/i2/cancel', method: 'POST' });
  });

  it('offers no Edit or Cancel on a completed issue', async () => {
    await renderPage([
      ...HISTORY(),
      event('issue.status_changed', 'i2', {
        from: 'in_progress',
        to: 'in_review',
        attemptCount: 1,
        runAfter: 0,
      }),
      event('issue.completed', 'i2', { attemptId: 'a2', mergedOrder: 1, mergeSha: SHA }),
    ]);
    expect(screen.queryByRole('button', { name: 'Edit issue #2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel issue #2' })).not.toBeInTheDocument();
  });
});

describe('IssuePage: attempts', () => {
  it('lists every attempt with status, counting, step, times and feedback', async () => {
    await renderPage();
    const a1 = attemptSection(1);
    expect(within(a1).getByText('Rejected by review')).toBeInTheDocument();
    expect(within(a1).getByText('Counted toward the attempt limit')).toBeInTheDocument();
    expect(within(a1).getByText('Review', { selector: 'dd' })).toBeInTheDocument();
    expect(within(a1).getAllByText('Toggle is not keyboard accessible').length).toBeGreaterThan(0);
    expect(a1.querySelectorAll('time')).toHaveLength(2);

    const a2 = attemptSection(2);
    expect(within(a2).getByText('Running')).toBeInTheDocument();
    expect(within(a2).getByText('Not counted')).toBeInTheDocument();
    expect(within(a2).getByText('Still running')).toBeInTheDocument();
  });

  it("shows each of the attempt's agent logs in the Log tab", async () => {
    await renderPage();
    const a1 = attemptSection(1);
    expect(within(a1).getByRole('tab', { name: 'Log' })).toHaveAttribute('aria-selected', 'true');
    act(() => {
      const stream = FakeEventSource.find('/api/agents/ag1/log?follow=1');
      stream.open();
      stream.onmessage?.({ data: JSON.stringify({ ts: 1, line: 'editing src/theme.ts' }) });
    });
    expect(within(a1).getByRole('log', { name: 'Builder (implementer) log' })).toHaveTextContent(
      'editing src/theme.ts',
    );
    expect(within(a1).getByRole('log', { name: 'Inspector (reviewer) log' })).toBeInTheDocument();
  });

  it('shows the diff with +/- line styling and text markers', async () => {
    routes['GET /api/attempts/a1/diff'] = () =>
      new Response('diff --git a/t b/t\n@@ -1 +1 @@\n-light\n+dark\n same\n');
    const user = await renderPage();
    const a1 = attemptSection(1);
    await user.click(within(a1).getByRole('tab', { name: 'Diff' }));
    const added = await within(a1).findByText('+dark');
    expect(added.closest('.diff-line')).toHaveClass('diff-line--add');
    expect(added.closest('.diff-line')).toHaveTextContent('Added: +dark');
    const removed = within(a1).getByText('-light');
    expect(removed.closest('.diff-line')).toHaveClass('diff-line--del');
    expect(removed.closest('.diff-line')).toHaveTextContent('Removed: -light');
    expect(within(a1).getByText('@@ -1 +1 @@').closest('.diff-line')).toHaveClass(
      'diff-line--hunk',
    );
  });

  it('shows the check output, or says there is none', async () => {
    routes['GET /api/attempts/a1/check'] = () => new Response('FAIL theme.test.ts\n');
    const user = await renderPage();
    await user.click(within(attemptSection(1)).getByRole('tab', { name: 'Check output' }));
    expect(await within(attemptSection(1)).findByText(/FAIL theme\.test\.ts/)).toBeInTheDocument();

    await user.click(within(attemptSection(2)).getByRole('tab', { name: 'Check output' }));
    expect(await within(attemptSection(2)).findByText('No check output yet.')).toBeInTheDocument();
    expect(calls).toContainEqual({ url: '/api/attempts/a2/check', method: 'GET' });
  });

  it('shows the review verdict and findings', async () => {
    const user = await renderPage([
      ...HISTORY(),
      attemptEnded('a2', 'merged', { counted: false, review: { approve: true, findings: [] } }),
    ]);
    const a1 = attemptSection(1);
    await user.click(within(a1).getByRole('tab', { name: 'Review' }));
    expect(within(a1).getByText('Changes requested')).toBeInTheDocument();
    expect(within(a1).getByRole('listitem')).toHaveTextContent('Toggle is not keyboard accessible');

    const a2 = attemptSection(2);
    await user.click(within(a2).getByRole('tab', { name: 'Review' }));
    expect(within(a2).getByText('Approved')).toBeInTheDocument();
  });

  it('switches tabs by keyboard and loads the artifact of the selected tab', async () => {
    routes['GET /api/attempts/a1/diff'] = () => new Response('+dark\n');
    const user = await renderPage();
    const a1 = attemptSection(1);
    within(a1).getByRole('tab', { name: 'Log' }).focus();
    await user.keyboard('{ArrowRight}');
    const diffTab = within(a1).getByRole('tab', { name: 'Diff' });
    expect(diffTab).toHaveFocus();
    expect(diffTab).toHaveAttribute('aria-selected', 'true');
    expect(await within(a1).findByText('+dark')).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(within(a1).getByRole('tab', { name: 'Review' })).toHaveFocus();
    await waitFor(() => {
      expect(within(a1).getByText('Changes requested')).toBeVisible();
    });
  });

  it('fetches no artifact before its tab is opened', async () => {
    await renderPage();
    expect(calls.filter((c) => c.url.startsWith('/api/attempts/'))).toEqual([]);
  });
});
