import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../../shared/state.ts';
import {
  ApiError,
  getState,
  handoffProduct,
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
  });
});
