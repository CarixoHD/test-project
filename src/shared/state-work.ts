import type { EventOf } from './events.ts';
import type { AgentView, AttemptState, ClientState, IssueState } from './state-schema.ts';
import { patch } from './state-records.ts';

// Reducers for the build work: issues, their attempts and the agents running them.

export type IssueEvent = EventOf<
  | 'issue.created'
  | 'issue.edited'
  | 'issue.status_changed'
  | 'issue.held'
  | 'issue.released'
  | 'issue.cancelled'
  | 'issue.completed'
  | 'issue.failed'
  | 'issue.rewritten'
>;

function issueEdited(i: IssueState, d: EventOf<'issue.edited'>['data']): IssueState {
  const next: IssueState = { ...i, rev: d.rev };
  if (d.title !== undefined) next.title = d.title;
  if (d.body !== undefined) next.body = d.body;
  if (d.dependsOn !== undefined) next.dependsOn = d.dependsOn;
  return next;
}

/** Next view of an existing issue. */
function nextIssue(i: IssueState, e: Exclude<IssueEvent, EventOf<'issue.created'>>): IssueState {
  switch (e.type) {
    case 'issue.edited':
      return issueEdited(i, e.data);
    case 'issue.status_changed':
      return {
        ...i,
        status: e.data.to,
        attemptCount: e.data.attemptCount,
        runAfter: e.data.runAfter,
      };
    case 'issue.held':
      return { ...i, heldQuestionId: e.data.questionId };
    case 'issue.released':
      return { ...i, heldQuestionId: null };
    case 'issue.cancelled':
      return { ...i, status: 'cancelled' };
    case 'issue.completed':
      return {
        ...i,
        status: 'completed',
        mergedOrder: e.data.mergedOrder,
        mergeSha: e.data.mergeSha,
      };
    case 'issue.failed':
      return {
        ...i,
        status: 'failed',
        attemptCount: e.data.attemptCount,
        failureReason: e.data.reason,
      };
    case 'issue.rewritten':
      return {
        ...i,
        status: 'open',
        rev: e.data.rev,
        body: e.data.body,
        attemptCount: 0,
        failureReason: null,
      };
  }
}

export function reduceIssueEvent(s: ClientState, e: IssueEvent): ClientState {
  if (e.type === 'issue.created') {
    const created: IssueState = { ...e.data.issue, productId: e.productId };
    return { ...s, issues: { ...s.issues, [e.entityId]: created } };
  }
  return { ...s, issues: patch(s.issues, e.entityId, (i) => nextIssue(i, e)) };
}

// ---- attempt and agent events -------------------------------------------------------------

export type AttemptEvent = EventOf<'attempt.started' | 'attempt.step' | 'attempt.ended'>;

export function reduceAttemptEvent(s: ClientState, e: AttemptEvent): ClientState {
  switch (e.type) {
    case 'attempt.started': {
      const started: AttemptState = {
        id: e.entityId,
        productId: e.productId,
        ...e.data,
        headSha: null,
        status: 'running',
        step: 'implement',
        counted: false,
        feedback: null,
        review: null,
        checkExit: null,
        interruptReason: null,
        startedAt: e.ts,
        endedAt: null,
      };
      return { ...s, attempts: { ...s.attempts, [e.entityId]: started } };
    }
    case 'attempt.step':
      return {
        ...s,
        attempts: patch(s.attempts, e.entityId, (a) => ({ ...a, step: e.data.step })),
      };
    case 'attempt.ended': {
      const { issueId: _issueId, ...outcome } = e.data;
      return {
        ...s,
        attempts: patch(s.attempts, e.entityId, (a) => ({ ...a, ...outcome, endedAt: e.ts })),
      };
    }
  }
}

export type AgentEvent = EventOf<
  'agent.spawned' | 'agent.state' | 'agent.activity' | 'agent.exited'
>;

/** Next view of an existing agent. */
function nextAgent(a: AgentView, e: Exclude<AgentEvent, EventOf<'agent.spawned'>>): AgentView {
  switch (e.type) {
    case 'agent.state':
      return { ...a, state: e.data.state, until: e.data.until };
    case 'agent.activity':
      // Only the last line is kept; the full log is served per agent.
      return { ...a, lastActivity: e.data.lines.at(-1) ?? a.lastActivity };
    case 'agent.exited':
      return { ...a, state: 'exited', until: null, endedAt: e.ts };
  }
}

export function reduceAgentEvent(s: ClientState, e: AgentEvent): ClientState {
  if (e.type === 'agent.spawned') {
    const spawned: AgentView = {
      id: e.entityId,
      productId: e.productId,
      role: e.data.role,
      provider: e.data.model.provider,
      model: e.data.model.model,
      issueId: e.data.issueId,
      attemptId: e.data.attemptId,
      state: 'working',
      until: null,
      lastActivity: null,
      startedAt: e.ts,
      endedAt: null,
    };
    return { ...s, agents: { ...s.agents, [e.entityId]: spawned } };
  }
  return { ...s, agents: patch(s.agents, e.entityId, (a) => nextAgent(a, e)) };
}
