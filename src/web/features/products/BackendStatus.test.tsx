import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSchema, type Event } from '../../../shared/events.ts';
import { emptyState, reduce, type ClientState } from '../../../shared/state.ts';
import { AppStoreProvider } from '../../state/AppStoreProvider.tsx';
import { createAppStore } from '../../state/store.ts';
import { BackendStatus } from './BackendStatus.tsx';

// The Build tab banner against the real store. State fixtures are built by reducing real
// backend events; live changes arrive over the (fake) event stream.

class FakeEventSource {
  static readonly CLOSED = 2;
  static latest: FakeEventSource | null = null;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeEventSource.latest = this;
  }
  close(): void {
    this.readyState = 2;
  }
}

// Local noon, so "until" is later the same local day wherever the test runs.
const NOW = new Date(2026, 10, 20, 12, 0).getTime();
const AT_1405 = new Date(2026, 10, 20, 14, 5).getTime();
const localTime = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

let seq = 0;
const ev = (type: string, data: object): Event => {
  seq += 1;
  return EventSchema.parse({ seq, ts: NOW, type, productId: null, entityId: null, v: 1, data });
};
const limited = (until: number | null, needsLogin = false) =>
  ev('backend.limited', { backend: 'claude-code', until, needsLogin, reason: 'test' });
const fixture = (...events: Event[]): ClientState => events.reduce(reduce, emptyState);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderBanner(state: ClientState) {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ state, lastSeq: state.lastSeq }))),
  );
  render(
    <MemoryRouter>
      <AppStoreProvider store={createAppStore()}>
        <BackendStatus />
      </AppStoreProvider>
    </MemoryRouter>,
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
}

const banner = () => screen.queryByRole('region', { name: 'Backend status' });

function push(e: Event) {
  const stream = FakeEventSource.latest;
  if (stream === null) throw new Error('no stream');
  act(() => stream.onmessage?.({ data: JSON.stringify(e) }));
}

describe('BackendStatus', () => {
  it('is hidden while every backend is OK', async () => {
    await renderBanner(fixture());
    expect(banner()).toBeNull();
  });

  it('shows the backend and the local time work resumes, as text', async () => {
    await renderBanner(fixture(limited(AT_1405)));
    expect(banner()).toHaveTextContent(
      `Claude Code rate limited until ${localTime(AT_1405)} — work resumes automatically`,
    );
  });

  it('says a login is needed, with a link to Settings', async () => {
    await renderBanner(fixture(limited(null, true)));
    const region = banner();
    if (region === null) throw new Error('no banner');
    expect(region).toHaveTextContent('Claude Code needs login — see Settings');
    expect(within(region).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('hides itself once the limit time passes, before the clear event arrives', async () => {
    await renderBanner(fixture(limited(AT_1405)));
    expect(banner()).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(AT_1405 - NOW));
    expect(banner()).toBeNull();
  });

  it('follows live backend.limited and backend.cleared events', async () => {
    await renderBanner(fixture());
    push(limited(AT_1405));
    expect(banner()).toHaveTextContent(`rate limited until ${localTime(AT_1405)}`);
    push(ev('backend.cleared', { backend: 'claude-code' }));
    expect(banner()).toBeNull();
  });
});
