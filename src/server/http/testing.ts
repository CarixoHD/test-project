import type { EventDraft } from '../../shared/events.ts';
import { ProductIdSchema } from '../../shared/ids.ts';
import { open } from '../db/index.ts';
import { createGit } from '../git/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';

// Test fixtures for the http module's tests (not imported by production code).

export const TEST_PRODUCT = ProductIdSchema.parse('product-1');

export function setupStore() {
  const db = open(':memory:');
  const clock = new FakeClock(1_700_000_000_000);
  const redactor = new Redactor();
  const store = createStore({ db, clock, redactor });
  // Routes under test here never touch git; tests that do create their own with a temp dir.
  const git = createGit({ dataDir: '/nonexistent/vibecode-http-tests' });
  return { db, clock, redactor, store, ids: new FakeIdGen(), git };
}

export const productCreated = (name = 'Todo'): EventDraft => ({
  type: 'product.created',
  productId: TEST_PRODUCT,
  entityId: null,
  v: 1,
  data: {
    name,
    idea: 'A todo app',
    budgetUsd: 10,
    maxParallel: 3,
    maxAttempts: 3,
    models: {},
    gitRemote: null,
  },
});

export const sparMessage = (id: string, text: string): EventDraft => ({
  type: 'spar.message',
  productId: TEST_PRODUCT,
  entityId: id,
  v: 1,
  data: { role: 'owner', text },
});
