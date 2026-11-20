import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAccountSettings } from '../commands/index.ts';
import { createSecrets } from '../security/index.ts';
import { createApp } from './app.ts';
import { setupStore } from './testing.ts';

function setup() {
  const base = setupStore();
  const settings = createAccountSettings({
    store: base.store,
    db: base.db,
    secrets: createSecrets(base),
  });
  return createApp({ ...base, settings });
}

const ROUTES = [
  ['POST', '/api/products'],
  ['PUT', '/api/products/product-1/prd-draft'],
  ['POST', '/api/products/product-1/spar'],
  ['POST', '/api/products/product-1/issues'],
  ['PATCH', '/api/issues/issue-1'],
  ['PUT', '/api/settings'],
] as const;

describe('non-JSON request bodies', () => {
  it.each(ROUTES)('%s %s answers 400 invalid', async (method, path) => {
    const res = await setup().request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'invalid', message: 'The request body must be valid JSON' },
    });
  });

  it('no route reads the body with c.req.json() directly (they use readJson)', () => {
    const dir = join(import.meta.dirname, 'routes');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('req.json('));
    expect(offenders).toEqual([]);
  });
});
