import type { ProductSettings } from './domain.ts';
import type { Event, EventOf } from './events.ts';
import type { ProductId } from './ids.ts';
import type {
  AgentView,
  AttemptState,
  ClientState,
  InboxItem,
  IssueState,
  ProductState,
  QuestionState,
} from './state-schema.ts';
import { addUsage } from './state-usage.ts';

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

// ---- issue events -------------------------------------------------------------------------

type IssueEvent = EventOf<
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

function reduceIssueEvent(s: ClientState, e: IssueEvent): ClientState {
  if (e.type === 'issue.created') {
    const created: IssueState = { ...e.data.issue, productId: e.productId };
    return { ...s, issues: { ...s.issues, [e.entityId]: created } };
  }
  return { ...s, issues: patch(s.issues, e.entityId, (i) => nextIssue(i, e)) };
}

// ---- attempt and agent events -------------------------------------------------------------

type AttemptEvent = EventOf<'attempt.started' | 'attempt.step' | 'attempt.ended'>;

function reduceAttemptEvent(s: ClientState, e: AttemptEvent): ClientState {
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

type AgentEvent = EventOf<'agent.spawned' | 'agent.state' | 'agent.activity' | 'agent.exited'>;

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

function reduceAgentEvent(s: ClientState, e: AgentEvent): ClientState {
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

// ---- usage, questions, inbox, backends ----------------------------------------------------

function usageRecorded(s: ClientState, e: EventOf<'usage.recorded'>): ClientState {
  const { byProduct, byIssue } = s.usage;
  const issueId = e.data.issueId;
  return {
    ...s,
    usage: {
      byProduct: { ...byProduct, [e.productId]: addUsage(byProduct[e.productId], e.data) },
      byIssue:
        issueId === null ? byIssue : { ...byIssue, [issueId]: addUsage(byIssue[issueId], e.data) },
    },
  };
}

type AccountEvent = EventOf<
  | 'usage.recorded'
  | 'question.asked'
  | 'question.answered'
  | 'inbox.created'
  | 'inbox.read'
  | 'backend.limited'
  | 'backend.cleared'
>;

function reduceAccountEvent(s: ClientState, e: AccountEvent): ClientState {
  switch (e.type) {
    case 'usage.recorded':
      return usageRecorded(s, e);
    case 'question.asked': {
      const asked: QuestionState = {
        id: e.entityId,
        productId: e.productId,
        ...e.data,
        answer: null,
        createdAt: e.ts,
        answeredAt: null,
      };
      return { ...s, questions: { ...s.questions, [e.entityId]: asked } };
    }
    case 'question.answered':
      return {
        ...s,
        questions: patch(s.questions, e.entityId, (q) => ({
          ...q,
          answer: e.data.answer,
          answeredAt: e.ts,
        })),
      };
    case 'inbox.created': {
      const item: InboxItem = {
        id: e.entityId,
        productId: e.productId,
        ...e.data,
        read: false,
        createdAt: e.ts,
      };
      return { ...s, inbox: { ...s.inbox, [e.entityId]: item } };
    }
    case 'inbox.read':
      return { ...s, inbox: patch(s.inbox, e.entityId, (i) => ({ ...i, read: true })) };
    case 'backend.limited':
      return { ...s, backendLimits: { ...s.backendLimits, [e.data.backend]: { ...e.data } } };
    case 'backend.cleared':
      return { ...s, backendLimits: without(s.backendLimits, e.data.backend) };
  }
}

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
    default:
      return s;
  }
}
