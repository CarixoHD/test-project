import type { Event } from './events.ts';
import type { ClientState } from './state-schema.ts';
import { reduceAccountEvent } from './state-account.ts';
import { reduceProductEvent } from './state-product.ts';
import { reduceAgentEvent, reduceAttemptEvent, reduceIssueEvent } from './state-work.ts';

// The single client-state reducer (ARCHITECTURE §4.1), shared by the browser and the server's
// snapshot≡replay invariant. Per-domain reducers live in state-product/-work/-account.ts.

export * from './state-schema.ts';
export { addUsage, EMPTY_USAGE_TOTALS } from './state-account.ts';

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
    case 'issue.created':
    case 'issue.edited':
    case 'issue.status_changed':
    case 'issue.held':
    case 'issue.released':
    case 'issue.cancelled':
    case 'issue.completed':
    case 'issue.failed':
    case 'issue.rewritten':
      return { ...reduceIssueEvent(s, e), lastSeq: e.seq };
    case 'attempt.started':
    case 'attempt.step':
    case 'attempt.ended':
      return { ...reduceAttemptEvent(s, e), lastSeq: e.seq };
    case 'agent.spawned':
    case 'agent.state':
    case 'agent.activity':
    case 'agent.exited':
      return { ...reduceAgentEvent(s, e), lastSeq: e.seq };
    case 'usage.recorded':
    case 'question.asked':
    case 'question.answered':
    case 'inbox.created':
    case 'inbox.read':
    case 'backend.limited':
    case 'backend.cleared':
      return { ...reduceAccountEvent(s, e), lastSeq: e.seq };
    default: {
      // Compile time: every catalogued type has a case above. Runtime: a type from a newer
      // server (forward compat) lands here and is ignored.
      const _unknown: never = e;
      return s;
    }
  }
}
