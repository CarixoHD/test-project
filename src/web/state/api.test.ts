import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../../shared/state.ts';
import { IssueIdSchema } from '../../shared/ids.ts';
import {
  addIssue,
  applyPrdChanges,
  ApiError,
  cancelIssue,
  changePassword,
  editIssue,
  getSession,
  getState,
  handoffProduct,
  login,
  logout,
  onUnauthorized,
  recheckSession,
  request,
  savePrdDraft,
  sendSparMessage,
} from './api.ts';
import { z } from 'zod';

type FetchArgs = [input: string, init: RequestInit];

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn((..._args: FetchArgs) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('getState fetches /api/state and returns the validated snapshot', async () => {
    const fetchFn = stubFetch(json({ state: emptyState, lastSeq: 0 }));
    await expect(getState()).resolves.toEqual({ state: emptyState, lastSeq: 0 });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/state');
    expect(init.method).toBe('GET');
  });

  it('sends JSON bodies with a JSON content type', async () => {
    const fetchFn = stubFetch(json({ ok: true }));
    await request('/api/products', {
      method: 'POST',
      body: { name: 'Demo', idea: 'x' },
      schema: z.object({ ok: z.literal(true) }),
    });
    const [, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(init.body).toBe(JSON.stringify({ name: 'Demo', idea: 'x' }));
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('maps an {error:{code,message}} body to a typed ApiError', async () => {
    stubFetch(json({ error: { code: 'stale_rev', message: 'Issue changed; reload it' } }, 409));
    const err: unknown = await getState().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'stale_rev',
      message: 'Issue changed; reload it',
      status: 409,
    });
  });

  it('maps an error status without the error body to an http_<status> ApiError', async () => {
    stubFetch(new Response('Bad gateway', { status: 502, statusText: 'Bad Gateway' }));
    await expect(getState()).rejects.toMatchObject({ code: 'http_502', status: 502 });
  });

  it('maps a network failure to a network ApiError that keeps the cause', async () => {
    const cause = new TypeError('Failed to fetch');
    stubFetch(cause);
    const err: unknown = await getState().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'network', status: 0, cause });
  });

  it('rejects a response that does not match the DTO with bad_response', async () => {
    stubFetch(json({ state: 'nope', lastSeq: -1 }));
    await expect(getState()).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('sendSparMessage POSTs the message to the product spar endpoint', async () => {
    const fetchFn = stubFetch(json({ ok: true }, 202));
    await expect(sendSparMessage('p1', 'Who uses it?')).resolves.toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/products/p1/spar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ message: 'Who uses it?' });
  });

  it('savePrdDraft PUTs the markdown to the product prd-draft endpoint', async () => {
    const fetchFn = stubFetch(json({ ok: true }));
    await expect(savePrdDraft('p 1', '# PRD')).resolves.toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/products/p%201/prd-draft');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ markdown: '# PRD' });
  });

  it('handoffProduct POSTs without a body to the product handoff endpoint', async () => {
    const fetchFn = stubFetch(json({ ok: true }));
    await expect(handoffProduct('p 1')).resolves.toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/products/p%201/handoff');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    // The server rejects non-JSON mutations (ADR 9), bodyless ones included.
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('sends no Content-Type on GET', async () => {
    const fetchFn = stubFetch(json({ state: emptyState, lastSeq: 0 }));
    await getState();
    const [, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });

  it('applyPrdChanges POSTs without a body to the product apply-prd endpoint', async () => {
    const fetchFn = stubFetch(json({ ok: true }));
    await expect(applyPrdChanges('p 1')).resolves.toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/products/p%201/apply-prd');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('addIssue POSTs the new issue to the product issues endpoint', async () => {
    const fetchFn = stubFetch(json({ ok: true, issueId: 'i9', number: 9 }));
    const body = { title: 'Dark mode', body: 'Please', dependsOn: [], priority: 1 };
    await expect(addIssue('p 1', body)).resolves.toEqual({ ok: true, issueId: 'i9', number: 9 });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/products/p%201/issues');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(body));
  });

  it('editIssue PATCHes the issue with its base rev', async () => {
    const fetchFn = stubFetch(json({ ok: true, rev: 3 }));
    await expect(editIssue('i1', { title: 'New', rev: 2 })).resolves.toEqual({ ok: true, rev: 3 });
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/issues/i1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ title: 'New', rev: 2 }));
  });

  it('cancelIssue POSTs to the issue cancel endpoint', async () => {
    const fetchFn = stubFetch(json({ ok: true }));
    await cancelIssue(IssueIdSchema.parse('i1'));
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/issues/i1/cancel');
    expect(init.method).toBe('POST');
  });
});

describe('session and 401 handling', () => {
  it('tells onUnauthorized listeners about a 401 from any API call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(json({ error: { code: 'unauthorized', message: 'Log in first' } }, 401)),
      ),
    );
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await expect(getState()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await expect(getState()).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not treat a wrong password at login as a lost session', async () => {
    const fetchFn = stubFetch(
      json({ error: { code: 'unauthorized', message: 'Wrong password' } }, 401),
    );
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await expect(login('nope')).rejects.toMatchObject({ status: 401, message: 'Wrong password' });
    off();
    expect(listener).not.toHaveBeenCalled();
    const [url, init] = fetchFn.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/login');
    expect(init.body).toBe(JSON.stringify({ password: 'nope' }));
  });

  it('getSession, logout and changePassword call their endpoints', async () => {
    const fetchFn = stubFetch(json({ passwordSet: true, authenticated: false }));
    await expect(getSession()).resolves.toEqual({ passwordSet: true, authenticated: false });
    fetchFn.mockImplementation(() => Promise.resolve(json({ ok: true })));
    await logout();
    await changePassword({ current: 'old password!', next: 'new password!!' });
    const calls = fetchFn.mock.calls as FetchArgs[];
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET /api/session',
      'POST /api/logout',
      'POST /api/settings/password',
    ]);
    expect(calls[2]?.[1].body).toBe(
      JSON.stringify({ current: 'old password!', next: 'new password!!' }),
    );
  });

  it('recheckSession reports a missing session to the listeners', async () => {
    stubFetch(json({ passwordSet: true, authenticated: false }));
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await expect(recheckSession()).resolves.toBe('unauthenticated');
    expect(listener).toHaveBeenCalledTimes(1);

    stubFetch(json({ passwordSet: true, authenticated: true }));
    await expect(recheckSession()).resolves.toBe('authenticated');
    stubFetch(new TypeError('Failed to fetch'));
    await expect(recheckSession()).resolves.toBe('unknown');
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
