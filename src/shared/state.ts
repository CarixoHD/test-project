import type { Event, EventOf } from './events.ts';
import type { ClientState } from './state-schema.ts';

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

function productCreated(s: ClientState, e: EventOf<'product.created'>): ClientState {
  const { name, idea, ...settings } = e.data;
  return {
    ...s,
    products: {
      ...s.products,
      [e.productId]: {
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
      },
    },
  };
}

/**
 * Applies one event. Pure: never mutates `s` or `e`. Events of a type this build does not
 * know (forward compat) return `s` unchanged.
 */
export function reduce(s: ClientState, e: Event): ClientState {
  switch (e.type) {
    case 'product.created':
      return { ...productCreated(s, e), lastSeq: e.seq };
    default:
      return s;
  }
}
