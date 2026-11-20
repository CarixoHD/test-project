import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onUnauthorized } from '../../state/api.ts';
import { FakeEventSource } from './testing.ts';
import { useAgentLog } from './use-agent-log.ts';

const LOG_URL = '/api/agents/a1/log?follow=1';

function stubSession(authenticated: boolean) {
  const fetchFn = vi.fn(() => Promise.resolve(Response.json({ passwordSet: true, authenticated })));
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAgentLog and the session', () => {
  it('re-checks the session on a stream error and stops following once it is gone', async () => {
    const fetchFn = stubSession(false);
    const lost = vi.fn();
    const off = onUnauthorized(lost);
    const { result } = renderHook(() => useAgentLog('a1'));
    const stream = FakeEventSource.find(LOG_URL);
    act(() => stream.open());

    // The browser is retrying; the retry gets a 401, which EventSource cannot read.
    await act(async () => {
      stream.fail();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    off();

    expect(fetchFn).toHaveBeenCalledWith('/api/session', expect.anything());
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    expect(result.current.status).toBe('lost');
  });

  it('keeps following while the session is valid', async () => {
    const fetchFn = stubSession(true);
    const { result } = renderHook(() => useAgentLog('a1'));
    const stream = FakeEventSource.find(LOG_URL);
    act(() => stream.open());
    act(() => stream.fail());
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await act(() => Promise.resolve());

    expect(stream.readyState).not.toBe(FakeEventSource.CLOSED);
    expect(result.current.status).toBe('live');
  });
});
