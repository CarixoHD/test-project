import { eq } from 'drizzle-orm';
import type { EventOf } from '../../shared/events.ts';
import type { ProductLevelEvent } from '../../shared/state-product.ts';
import { type Db, schema } from '../db/index.ts';

// Projects product-level events into the tables. Mirrors src/shared/state-product.ts: after
// every commit the tables, read back by snapshot(), must equal the replayed ClientState.

const { products, prdDrafts, prdVersions, sparMessages, previews } = schema;

function settingsChanged(db: Db, e: EventOf<'product.settings_changed'>): void {
  const d = e.data;
  const set: Partial<typeof products.$inferInsert> = {};
  if (d.budgetUsd !== undefined) set.budgetUsd = d.budgetUsd;
  if (d.maxParallel !== undefined) set.maxParallel = d.maxParallel;
  if (d.maxAttempts !== undefined) set.maxAttempts = d.maxAttempts;
  if (d.models !== undefined) set.models = d.models;
  if (d.gitRemote !== undefined) set.gitRemote = d.gitRemote;
  if (d.project !== undefined) set.project = d.project;
  db.update(products).set(set).where(eq(products.id, e.productId)).run();
}

function prdApplied(db: Db, e: EventOf<'prd.applied'>): void {
  const { version, markdown, summary } = e.data;
  db.insert(prdVersions)
    .values({ productId: e.productId, version, markdown, summary, createdAt: e.ts })
    .run();
  db.update(products).set({ prdVersion: version }).where(eq(products.id, e.productId)).run();
  // The applied markdown is the draft's new base.
  const draft = { markdown, baseVersion: version, updatedAt: e.ts };
  db.insert(prdDrafts)
    .values({ productId: e.productId, ...draft })
    .onConflictDoUpdate({ target: prdDrafts.productId, set: draft })
    .run();
}

function updateProduct(db: Db, e: ProductLevelEvent, set: Partial<typeof products.$inferInsert>) {
  db.update(products).set(set).where(eq(products.id, e.productId)).run();
}

export function projectProductEvent(db: Db, e: ProductLevelEvent): void {
  switch (e.type) {
    case 'product.created': {
      const { name, idea, ...settings } = e.data;
      db.insert(products)
        .values({ id: e.productId, name, idea, ...settings, phase: 'sparring', createdAt: e.ts })
        .run();
      return;
    }
    case 'product.settings_changed':
      return settingsChanged(db, e);
    case 'product.handed_off':
      return updateProduct(db, e, { phase: 'building', prdVersion: e.data.prdVersion });
    case 'product.paused':
      return updateProduct(db, e, { paused: true, pauseReason: e.data.reason });
    case 'product.resumed':
      return updateProduct(db, e, { paused: false, pauseReason: null });
    case 'product.phase_changed':
      return updateProduct(db, e, { phase: e.data.phase });
    case 'spar.message':
      db.insert(sparMessages)
        .values({ id: e.entityId, productId: e.productId, ...e.data, createdAt: e.ts, seq: e.seq })
        .run();
      return;
    case 'prd.draft_saved': {
      const draft = { markdown: e.data.markdown, baseVersion: e.data.baseVersion, updatedAt: e.ts };
      db.insert(prdDrafts)
        .values({ productId: e.productId, ...draft })
        .onConflictDoUpdate({ target: prdDrafts.productId, set: draft })
        .run();
      return;
    }
    case 'prd.applied':
      return prdApplied(db, e);
    case 'orchestrator.cursor_advanced':
      return updateProduct(db, e, { orchestratorCursor: e.data.cursor });
    case 'budget.warned':
      return updateProduct(db, e, { budgetWarned: true });
    case 'preview.started': {
      const preview = { url: e.data.url, container: e.data.container, startedAt: e.ts };
      db.insert(previews)
        .values({ productId: e.productId, ...preview })
        .onConflictDoUpdate({ target: previews.productId, set: preview })
        .run();
      return;
    }
    case 'preview.stopped':
      db.delete(previews).where(eq(previews.productId, e.productId)).run();
      return;
  }
}
