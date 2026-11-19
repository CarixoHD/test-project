import type { ProductSettings } from './domain.ts';
import type { Event, EventOf } from './events.ts';
import type { ProductId } from './ids.ts';
import type { ClientState, ProductState } from './state-schema.ts';

export * from './state-schema.ts';

export const emptyState: ClientState = {
  products: {},
  prdDrafts: {},
  prdVersions: {},
  sparMessages: {},
  issues: {},
  attempts: {},
  agents: {},
  questions: {},
  inbox: {},
  usage: { byProduct: {}, byIssue: {} },
  backendLimits: {},
  previews: {},
  lastSeq: 0,
};

// ---- immutable record helpers -------------------------------------------------------------

/** Returns `rec` with `rec[id]` replaced by `fn(rec[id])`; unchanged when `id` is absent. */
function patch<K extends string, V>(
  rec: Record<K, V>,
  id: K,
  fn: (v: V) => V,
): Record<K, V> {
  const cur = rec[id];
  return cur === undefined ? rec : { ...rec, [id]: fn(cur) };
}

function without<K extends string, V>(rec: Record<K, V>, id: K): Record<K, V> {
  if (!(id in rec)) return rec;
  const next = { ...rec };
  delete next[id];
  return next;
}

function updateProduct(
  s: ClientState,
  id: ProductId,
  fn: (p: ProductState) => ProductState,
): ClientState {
  return { ...s, products: patch(s.products, id, fn) };
}

// ---- product-level events -----------------------------------------------------------------

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
    return { ...p, settings, project: d.project ?? p.project };
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

function reduceProductEvent(s: ClientState, e: ProductLevelEvent): ClientState {
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

type ProductLevelEvent = EventOf<
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

// ---- reduce -------------------------------------------------------------------------------

/**
 * Applies one event. Pure: never mutates `s` or `e`. Events of a type this build does not
 * know (forward compat) return `s` unchanged.
 */
export function reduce(s: ClientState, e: Event): ClientState {
  switch (e.type) {
    case 'product.created':
    case 'product.settings_changed':
    case 'product.handed_off':
    case 'product.paused':
    case 'product.resumed':
    case 'product.phase_changed':
    case 'spar.message':
    case 'prd.draft_saved':
    case 'prd.applied':
    case 'orchestrator.cursor_advanced':
    case 'budget.warned':
    case 'preview.started':
    case 'preview.stopped':
      return { ...reduceProductEvent(s, e), lastSeq: e.seq };
    default:
      return s;
  }
}
