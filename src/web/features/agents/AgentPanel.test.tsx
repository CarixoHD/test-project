import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentViewSchema, IssueStateSchema, type AgentView } from '../../../shared/state.ts';
import { AgentPanel } from './index.ts';
import { FakeEventSource } from './testing.ts';

const LOG_URL = '/api/agents/a1/log?follow=1';

const agent: AgentView = AgentViewSchema.parse({
  id: 'a1',
  productId: 'p1',
  role: 'reviewer',
  provider: 'openrouter',
  model: 'qwen/qwen3-coder',
  issueId: 'i7',
  attemptId: null,
  state: 'working',
  until: null,
  lastActivity: null,
  startedAt: 1,
  endedAt: null,
});

const issue = IssueStateSchema.parse({
  id: 'i7',
  productId: 'p1',
  number: 7,
  title: 'Dark mode',
  body: '',
  status: 'in_review',
  rev: 1,
  priority: 0,
  origin: 'orchestrator',
  prdVersion: 1,
  attemptCount: 1,
  heldQuestionId: null,
  runAfter: 0,
  mergedOrder: null,
  mergeSha: null,
  failureReason: null,
  dependsOn: [],
});

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  // Unmount while the fake network is still in place.
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel(open = true) {
  const onClose = vi.fn();
  const view = render(
    <MemoryRouter>
      <AgentPanel agent={agent} issue={issue} open={open} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onClose, ...view };
}

function sendLines(...lines: string[]): void {
  const stream = FakeEventSource.find(LOG_URL);
  act(() => {
    for (const [i, line] of lines.entries()) {
      stream.onmessage?.({ data: JSON.stringify({ ts: i, line }) });
    }
  });
}

const log = () => screen.getByRole('log', { name: 'Live log' });

/** jsdom has no layout: give the log box a fixed viewport and content height. */
function layout(el: HTMLElement, scrollHeight: number, clientHeight = 100) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('AgentPanel', () => {
  it('shows role, provider/model and the current issue', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog', { name: 'Inspector (reviewer)' });
    expect(dialog).toHaveTextContent('openrouter / qwen/qwen3-coder');
    expect(screen.getByRole('link', { name: '#7 Dark mode' })).toHaveAttribute(
      'href',
      '/products/p1/issues/i7',
    );
    expect(dialog).toHaveTextContent('Working');
  });

  it('streams the live log as plain text and closes the stream at the end', () => {
    const { unmount } = renderPanel();
    sendLines('reading diff', '<b>not html</b>');
    expect(log()).toHaveTextContent('reading diff');
    expect(log()).toHaveTextContent('<b>not html</b>');
    expect(log().querySelector('b')).toBeNull();

    const stream = FakeEventSource.find(LOG_URL);
    act(() => stream.emit('end', '{}'));
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    expect(screen.getByText('The agent has finished; this is its full log.')).toBeVisible();
    unmount();
  });

  it('starts over when the stream reconnects, since the server resends the whole log', () => {
    renderPanel();
    sendLines('one', 'two');
    act(() => FakeEventSource.find(LOG_URL).open());
    sendLines('one');
    expect(log().textContent).toBe('one');
  });

  it('does not open a stream while closed, and closes it when the panel closes', () => {
    const { rerender } = renderPanel(false);
    expect(FakeEventSource.all).toHaveLength(0);
    const tree = (open: boolean) => (
      <MemoryRouter>
        <AgentPanel agent={agent} issue={issue} open={open} onClose={() => undefined} />
      </MemoryRouter>
    );
    rerender(tree(true));
    const stream = FakeEventSource.find(LOG_URL);
    rerender(tree(false));
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('auto-scrolls to new lines, pausing while the owner has scrolled up', () => {
    renderPanel();
    const box = log();
    layout(box, 500);
    sendLines('a');
    expect(box.scrollTop).toBe(500 - 100);

    // The owner scrolls up: new lines no longer move the view.
    box.scrollTop = 100;
    fireEvent.scroll(box);
    layout(box, 600);
    sendLines('b');
    expect(box.scrollTop).toBe(100);
    expect(screen.getByText('Auto-scroll paused')).toBeVisible();

    // Jumping back to the end resumes it.
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(box.scrollTop).toBe(600 - 100);
    layout(box, 700);
    sendLines('c');
    expect(box.scrollTop).toBe(700 - 100);
    expect(screen.queryByText('Auto-scroll paused')).not.toBeInTheDocument();
  });
});
