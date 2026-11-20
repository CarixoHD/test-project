import type { Event } from '../../shared/events.ts';
import type { Db } from '../db/index.ts';
import { projectAccountEvent, projectSettingsChanged } from './project-account.ts';
import { projectProductEvent } from './project-product.ts';
import { projectAgentEvent, projectAttemptEvent, projectIssueEvent } from './project-work.ts';

/**
 * Applies one committed event to the projection tables, inside the commit transaction.
 * The server-side twin of the shared `reduce`: snapshot() of the result must equal the
 * replayed state (tested by expectSnapshotMatchesReplay).
 */
export function projectEvent(db: Db, e: Event): void {
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
    case 'prd.summarized':
    case 'orchestrator.cursor_advanced':
    case 'budget.warned':
    case 'preview.started':
    case 'preview.stopped':
      return projectProductEvent(db, e);
    case 'issue.created':
    case 'issue.edited':
    case 'issue.status_changed':
    case 'issue.held':
    case 'issue.released':
    case 'issue.cancelled':
    case 'issue.completed':
    case 'issue.failed':
    case 'issue.rewritten':
      return projectIssueEvent(db, e);
    case 'attempt.started':
    case 'attempt.step':
    case 'attempt.ended':
      return projectAttemptEvent(db, e);
    case 'agent.spawned':
    case 'agent.state':
    case 'agent.activity':
    case 'agent.exited':
      return projectAgentEvent(db, e);
    case 'usage.recorded':
    case 'question.asked':
    case 'question.answered':
    case 'inbox.created':
    case 'inbox.read':
    case 'backend.limited':
    case 'backend.cleared':
      return projectAccountEvent(db, e);
    case 'settings.changed':
      return projectSettingsChanged(db, e.ts);
    default: {
      // A new event type without a projection fails typecheck here.
      const unhandled: never = e;
      throw new Error(`No projection for event ${JSON.stringify(unhandled)}`);
    }
  }
}
