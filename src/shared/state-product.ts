import type { ProductSettings } from './domain.ts';
import type { EventOf } from './events.ts';
import type { ProductId } from './ids.ts';
import type { ClientState, ProductState } from './state-schema.ts';
import { patch, without } from './state-records.ts';

// Reducers for product-level events: product lifecycle, sparring, PRD, orchestrator cursor,
// budget warning and preview.

function updateProduct(
  s: ClientState,
  id: ProductId,
  fn: (p: ProductState) => ProductState,
): ClientState {
  return { ...s, products: patch(s.products, id, fn) };
}

function productCreated(s: ClientState, e: EventOf<'product.created'>): ClientState {
  const { name, idea, ...settings } = e.data;
  const created: ProductState = {
    id: e.productId,
    name,
    idea,
    createdAt: e.ts,
    settings,
    phase: 'sparring',
    paused: false,
    pauseReason: null,
    budgetWarned: false,
    prdVersion: 0,
    project: null,
    orchestratorCursor: 0,
  };
  return { ...s, products: { ...s.products, [e.productId]: created } };
}

function settingsChanged(s: ClientState, e: EventOf<'product.settings_changed'>): ClientState {
  const d = e.data;
  return updateProduct(s, e.productId, (p) => {
    const settings: ProductSettings = { ...p.settings };
    if (d.budgetUsd !== undefined) settings.budgetUsd = d.budgetUsd;
    if (d.maxParallel !== undefined) settings.maxParallel = d.maxParallel;
    if (d.maxAttempts !== undefined) settings.maxAttempts = d.maxAttempts;
    if (d.models !== undefined) settings.models = d.models;
    if (d.gitRemote !== undefined) settings.gitRemote = d.gitRemote;
    return {
      ...p,
      settings,
      project: d.project ?? p.project,
      budgetWarned: d.budgetWarned === false ? false : p.budgetWarned,
    };
  });
}

function sparMessage(s: ClientState, e: EventOf<'spar.message'>): ClientState {
  const message = { id: e.entityId, role: e.data.role, text: e.data.text, createdAt: e.ts };
  const prev = s.sparMessages[e.productId] ?? [];
  return { ...s, sparMessages: { ...s.sparMessages, [e.productId]: [...prev, message] } };
}

function prdApplied(s: ClientState, e: EventOf<'prd.applied'>): ClientState {
  const { version, markdown, summary } = e.data;
  const prev = s.prdVersions[e.productId] ?? [];
  const next = updateProduct(s, e.productId, (p) => ({ ...p, prdVersion: version }));
  return {
    ...next,
    prdVersions: {
      ...s.prdVersions,
      [e.productId]: [...prev, { version, summary, createdAt: e.ts }],
    },
    // The applied markdown is the draft's new base.
    prdDrafts: {
      ...s.prdDrafts,
      [e.productId]: { markdown, baseVersion: version, updatedAt: e.ts },
    },
  };
}

export function reduceProductEvent(s: ClientState, e: ProductLevelEvent): ClientState {
  switch (e.type) {
    case 'product.created':
      return productCreated(s, e);
    case 'product.settings_changed':
      return settingsChanged(s, e);
    case 'product.handed_off':
      return updateProduct(s, e.productId, (p) => ({
        ...p,
        phase: 'building',
        prdVersion: e.data.prdVersion,
      }));
    case 'product.paused':
      return updateProduct(s, e.productId, (p) => ({
        ...p,
        paused: true,
        pauseReason: e.data.reason,
      }));
    case 'product.resumed':
      return updateProduct(s, e.productId, (p) => ({ ...p, paused: false, pauseReason: null }));
    case 'product.phase_changed':
      return updateProduct(s, e.productId, (p) => ({ ...p, phase: e.data.phase }));
    case 'spar.message':
      return sparMessage(s, e);
    case 'prd.draft_saved': {
      const draft = { markdown: e.data.markdown, baseVersion: e.data.baseVersion, updatedAt: e.ts };
      return { ...s, prdDrafts: { ...s.prdDrafts, [e.productId]: draft } };
    }
    case 'prd.applied':
      return prdApplied(s, e);
    case 'orchestrator.cursor_advanced':
      return updateProduct(s, e.productId, (p) => ({ ...p, orchestratorCursor: e.data.cursor }));
    case 'budget.warned':
      return updateProduct(s, e.productId, (p) => ({ ...p, budgetWarned: true }));
    case 'preview.started': {
      const preview = { url: e.data.url, container: e.data.container, startedAt: e.ts };
      return { ...s, previews: { ...s.previews, [e.productId]: preview } };
    }
    case 'preview.stopped':
      return { ...s, previews: without(s.previews, e.productId) };
  }
}

export type ProductLevelEvent = EventOf<
  | 'product.created'
  | 'product.settings_changed'
  | 'product.handed_off'
  | 'product.paused'
  | 'product.resumed'
  | 'product.phase_changed'
  | 'spar.message'
  | 'prd.draft_saved'
  | 'prd.applied'
  | 'orchestrator.cursor_advanced'
  | 'budget.warned'
  | 'preview.started'
  | 'preview.stopped'
>;
