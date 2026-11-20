import { eq } from 'drizzle-orm';
import type { EventOf } from '../../shared/events.ts';
import type { IssueId } from '../../shared/ids.ts';
import type { AgentEvent, AttemptEvent, IssueEvent } from '../../shared/state-work.ts';
import { type Db, schema } from '../db/index.ts';

// Projects issue, attempt and agent events. Mirrors src/shared/state-work.ts.

const { issues, issueDeps, attempts, agents } = schema;

type IssueRow = Partial<typeof issues.$inferInsert>;

function replaceDeps(db: Db, issueId: IssueId, dependsOn: readonly IssueId[]): void {
  db.delete(issueDeps).where(eq(issueDeps.issueId, issueId)).run();
  if (dependsOn.length === 0) return;
  db.insert(issueDeps)
    .values(dependsOn.map((dependsOnId, position) => ({ issueId, dependsOnId, position })))
    .run();
}

function issueCreated(db: Db, e: EventOf<'issue.created'>): void {
  const { dependsOn, ...view } = e.data.issue;
  if (view.id !== e.entityId) {
    throw new Error(`issue.created: entityId ${e.entityId} differs from issue id ${view.id}`);
  }
  db.insert(issues)
    .values({ ...view, productId: e.productId, createdAt: e.ts, updatedAt: e.ts })
    .run();
  replaceDeps(db, view.id, dependsOn);
}

function issueEdited(db: Db, e: EventOf<'issue.edited'>): void {
  const { rev, title, body, dependsOn, priority } = e.data;
  const set: IssueRow = { rev, updatedAt: e.ts };
  if (title !== undefined) set.title = title;
  if (body !== undefined) set.body = body;
  if (priority !== undefined) set.priority = priority;
  const changed = db.update(issues).set(set).where(eq(issues.id, e.entityId)).run().changes;
  if (changed > 0 && dependsOn !== undefined) replaceDeps(db, e.entityId, dependsOn);
}

/** Column changes for an update event on an existing issue. */
function issueUpdate(e: Exclude<IssueEvent, EventOf<'issue.created' | 'issue.edited'>>): IssueRow {
  switch (e.type) {
    case 'issue.status_changed': {
      const { to, attemptCount, runAfter } = e.data;
      return { status: to, attemptCount, runAfter };
    }
    case 'issue.held':
      return { heldQuestionId: e.data.questionId };
    case 'issue.released':
      return { heldQuestionId: null };
    case 'issue.cancelled':
      return { status: 'cancelled', cancelReason: e.data.reason };
    case 'issue.completed':
      return { status: 'completed', mergedOrder: e.data.mergedOrder, mergeSha: e.data.mergeSha };
    case 'issue.failed':
      return { status: 'failed', attemptCount: e.data.attemptCount, failureReason: e.data.reason };
    case 'issue.rewritten':
      return {
        status: 'open',
        rev: e.data.rev,
        body: e.data.body,
        attemptCount: 0,
        failureReason: null,
      };
  }
}

export function projectIssueEvent(db: Db, e: IssueEvent): void {
  if (e.type === 'issue.created') return issueCreated(db, e);
  if (e.type === 'issue.edited') return issueEdited(db, e);
  db.update(issues)
    .set({ ...issueUpdate(e), updatedAt: e.ts })
    .where(eq(issues.id, e.entityId))
    .run();
}

export function projectAttemptEvent(db: Db, e: AttemptEvent): void {
  switch (e.type) {
    case 'attempt.started':
      db.insert(attempts)
        .values({
          id: e.entityId,
          productId: e.productId,
          ...e.data,
          status: 'running',
          step: 'implement',
          counted: false,
          startedAt: e.ts,
        })
        .run();
      return;
    case 'attempt.step':
      db.update(attempts).set({ step: e.data.step }).where(eq(attempts.id, e.entityId)).run();
      return;
    case 'attempt.ended': {
      const { issueId: _issueId, ...outcome } = e.data;
      db.update(attempts)
        .set({ ...outcome, endedAt: e.ts })
        .where(eq(attempts.id, e.entityId))
        .run();
      return;
    }
  }
}

export function projectAgentEvent(db: Db, e: AgentEvent): void {
  const update = (set: Partial<typeof agents.$inferInsert>) =>
    db.update(agents).set(set).where(eq(agents.id, e.entityId)).run();
  switch (e.type) {
    case 'agent.spawned':
      db.insert(agents)
        .values({
          id: e.entityId,
          productId: e.productId,
          role: e.data.role,
          provider: e.data.model.provider,
          model: e.data.model.model,
          issueId: e.data.issueId,
          attemptId: e.data.attemptId,
          state: 'working',
          startedAt: e.ts,
        })
        .run();
      return;
    case 'agent.state':
      update({ state: e.data.state, until: e.data.until });
      return;
    case 'agent.activity': {
      // Only the last line is kept; `lines` is never empty.
      const last = e.data.lines.at(-1);
      if (last !== undefined) update({ lastActivity: last });
      return;
    }
    case 'agent.exited':
      update({ state: 'exited', until: null, endedAt: e.ts });
      return;
  }
}
