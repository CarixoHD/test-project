import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Redactor } from '../security/index.ts';
import { fail, installErrorHandling } from './errors.ts';

const SECRET = 'sk-ant-api03-abcdefghijklmnop1234';

function setup() {
  const redactor = new Redactor();
  redactor.register(SECRET);
  const app = new Hono();
  installErrorHandling(app, redactor);
  app.get('/api/invalid', () => fail({ ok: false, reason: 'name is required', code: 'invalid' }));
  app.get('/api/default', () => fail({ ok: false, reason: 'cannot start an issue' }));
  app.get('/api/missing', () => fail({ ok: false, reason: 'no such issue', code: 'not_found' }));
  app.get('/api/stale', () => fail({ ok: false, reason: 'stale rev', code: 'conflict' }));
  app.get('/api/leak', () => fail({ ok: false, reason: `bad key ${SECRET}`, code: 'invalid' }));
  app.get('/api/zod', () => {
    z.object({ name: z.string() }).parse({});
    return new Response('unreachable');
  });
  app.get('/api/boom', () => {
    throw new Error(`database exploded near ${SECRET}`);
  });
  return app;
}

async function errorOf(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

describe('HTTP error mapping', () => {
  it('maps domain failures to 400/404/409 with {error:{code,message}}', async () => {
    const app = setup();
    expect(await errorOf(await app.request('/api/invalid'))).toEqual({
      status: 400,
      body: { error: { code: 'invalid', message: 'name is required' } },
    });
    expect(await errorOf(await app.request('/api/default'))).toEqual({
      status: 400,
      body: { error: { code: 'invalid', message: 'cannot start an issue' } },
    });
    expect(await errorOf(await app.request('/api/missing'))).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'no such issue' } },
    });
    expect(await errorOf(await app.request('/api/stale'))).toEqual({
      status: 409,
      body: { error: { code: 'conflict', message: 'stale rev' } },
    });
  });

  it('redacts secrets in error messages', async () => {
    const app = setup();
    const text = await (await app.request('/api/leak')).text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ error: { code: 'invalid', message: 'bad key ***1234' } });
  });

  it('maps zod validation errors to 400 invalid', async () => {
    const { status, body } = await errorOf(await setup().request('/api/zod'));
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 'invalid', message: expect.stringContaining('name') },
    });
  });

  it('maps unexpected errors to 500 internal without leaking secrets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await setup().request('/api/boom');
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text)).toEqual({
        error: { code: 'internal', message: 'Internal error: database exploded near ***1234' },
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    } finally {
      log.mockRestore();
    }
  });

  it('answers unknown routes with a 404 error body', async () => {
    expect(await errorOf(await setup().request('/api/nope'))).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'No route for GET /api/nope' } },
    });
  });
});
