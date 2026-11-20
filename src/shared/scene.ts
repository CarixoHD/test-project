import type { Event, EventOf, EventType } from './events.ts';
import type { AgentId, IssueId, ProductId, QuestionId } from './ids.ts';
import type { Role } from './models.ts';
import { layoutPiece, type PieceLayout } from './scene-layout.ts';
import type { AgentView, ClientState } from './state-schema.ts';

export * from './scene-layout.ts';

// The 3D construction view's state (ARCHITECTURE §4.1, ADR 8, PRD '3D construction view').
// One scene per product. `sceneReduce` maps events to scene changes; `sceneFromState` builds
// the same value from a client-state snapshot. Pure: no time, no randomness, no I/O.
// Every array is kept in a canonical order (pieces by mergedOrder, the rest by id) so a
// replayed scene and a snapshot-built scene compare equal.

export interface ScenePiece extends PieceLayout {
  issueId: IssueId;
  /**
   * Animation marker: the issue's mergedOrder, increasing per product. The renderer
   * animates pieces whose `placedAt` is above the highest one it has already shown.
   */
  placedAt: number;
}

export type Figure = 'foreman' | 'builder' | 'inspector' | 'drafter';
export type WorkerActivity = 'working' | 'waiting' | 'resting';
/** `site`: at the building; `desk`: the drafter's desk; `bench`: the break bench. */
export type WorkerLocation = 'site' | 'desk' | 'bench';

export interface SceneWorker {
  agentId: AgentId;
  role: Role;
  figure: Figure;
  issueId: IssueId | null;
  activity: WorkerActivity;
  location: WorkerLocation;
  /** Shows the "?" bubble: waiting for the owner, or has an unanswered question. */
  bubble: boolean;
  /** Unanswered questions this agent asked, sorted. */
  questionIds: QuestionId[];
}

export interface SceneDebris {
  issueId: IssueId;
}

export interface SceneState {
  productId: ProductId;
  /** Sorted by placedAt (mergedOrder). */
  pieces: ScenePiece[];
  /** Sorted by agentId. */
  workers: SceneWorker[];
  /** Sorted by issueId. */
  debris: SceneDebris[];
  /** Issues the building is sized for: every issue that is not cancelled. */
  totalIssues: number;
  /** The ids counted in `totalIssues`, sorted; keeps create/cancel idempotent. */
  issueIds: IssueId[];
}

export function emptyScene(productId: ProductId): SceneState {
  return { productId, pieces: [], workers: [], debris: [], totalIssues: 0, issueIds: [] };
}

// ---- mapping helpers ----------------------------------------------------------------------

const FIGURES: Partial<Record<Role, Figure>> = {
  orchestrator: 'foreman',
  implementer: 'builder',
  reviewer: 'inspector',
  sparring: 'drafter',
};

const byKey =
  <T>(key: (v: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const byAgent = byKey<SceneWorker>((w) => w.agentId);
const byIssue = byKey<SceneDebris>((d) => d.issueId);

function insertSorted<T extends string>(list: readonly T[], id: T): T[] {
  return list.includes(id) ? [...list] : [...list, id].sort();
}

type AgentStateValue = EventOf<'agent.state'>['data']['state'];

function workerFor(
  agent: Pick<AgentView, 'id' | 'role' | 'issueId'>,
  state: AgentStateValue,
  questionIds: QuestionId[],
): SceneWorker | null {
  const figure = FIGURES[agent.role];
  if (figure === undefined) return null;
  const home: WorkerLocation = figure === 'drafter' ? 'desk' : 'site';
  const waiting = state === 'waiting_owner';
  return {
    agentId: agent.id,
    role: agent.role,
    figure,
    issueId: agent.issueId,
    activity: waiting ? 'waiting' : state === 'rate_limited' ? 'resting' : 'working',
    location: state === 'rate_limited' ? 'bench' : home,
    bubble: waiting || questionIds.length > 0,
    questionIds,
  };
}

function stateOf(w: SceneWorker): AgentStateValue {
  if (w.activity === 'waiting') return 'waiting_owner';
  return w.activity === 'resting' ? 'rate_limited' : 'working';
}

/** Rebuilds a worker from its own fields, so derived fields stay consistent. */
function rebuild(w: SceneWorker, state: AgentStateValue, questionIds: QuestionId[]): SceneWorker {
  const next = workerFor({ id: w.agentId, role: w.role, issueId: w.issueId }, state, questionIds);
  return next ?? w;
}

/** A completed issue before layout. */
type Placement = Pick<ScenePiece, 'issueId' | 'placedAt'>;

/** Sorts placements by mergedOrder and lays them out for the scene's current size. */
function withPieces(s: SceneState, pieces: readonly Placement[]): SceneState {
  const sorted = [...pieces].sort((a, b) => a.placedAt - b.placedAt);
  const total = Math.max(s.totalIssues, sorted.length);
  return {
    ...s,
    pieces: sorted.map((p, i) => ({
      issueId: p.issueId,
      placedAt: p.placedAt,
      ...layoutPiece(i, total),
    })),
  };
}

function withIssueIds(s: SceneState, issueIds: IssueId[]): SceneState {
  return withPieces({ ...s, issueIds, totalIssues: issueIds.length }, s.pieces);
}

function withoutDebris(s: SceneState, id: IssueId): SceneState {
  return s.debris.some((d) => d.issueId === id)
    ? { ...s, debris: s.debris.filter((d) => d.issueId !== id) }
    : s;
}

function withDebris(s: SceneState, id: IssueId): SceneState {
  if (s.debris.some((d) => d.issueId === id)) return s;
  return { ...s, debris: [...s.debris, { issueId: id }].sort(byIssue) };
}

function cancelIssue(s: SceneState, id: IssueId): SceneState {
  const cleared = withoutDebris(s, id);
  if (!cleared.issueIds.includes(id)) return cleared;
  return withIssueIds(
    cleared,
    cleared.issueIds.filter((i) => i !== id),
  );
}

function mapWorkers(s: SceneState, fn: (w: SceneWorker) => SceneWorker): SceneState {
  return { ...s, workers: s.workers.map(fn) };
}

// ---- reducer ------------------------------------------------------------------------------

/** Event types that change the scene. */
export const SCENE_EVENTS = [
  'issue.created',
  'issue.cancelled',
  'issue.status_changed',
  'issue.completed',
  'issue.failed',
  'issue.rewritten',
  'agent.spawned',
  'agent.state',
  'agent.exited',
  'question.asked',
  'question.answered',
] as const satisfies readonly EventType[];

/**
 * Event types with no scene effect. `backend.limited` is covered by the `agent.state
 * rate_limited` the server emits for each affected agent.
 */
export const NO_OP_SCENE_EVENTS = [
  'product.created',
  'product.settings_changed',
  'product.handed_off',
  'product.paused',
  'product.resumed',
  'product.phase_changed',
  'spar.message',
  'prd.draft_saved',
  'prd.applied',
  'orchestrator.cursor_advanced',
  'issue.edited',
  'issue.held',
  'issue.released',
  'attempt.started',
  'attempt.step',
  'attempt.ended',
  'agent.activity',
  'usage.recorded',
  'budget.warned',
  'inbox.created',
  'inbox.read',
  'backend.limited',
  'backend.cleared',
  'settings.changed',
  'preview.started',
  'preview.stopped',
] as const satisfies readonly EventType[];

type SceneEvent = EventOf<(typeof SCENE_EVENTS)[number]>;

function reduceSceneEvent(s: SceneState, e: SceneEvent): SceneState {
  switch (e.type) {
    case 'issue.created':
      return e.data.issue.status === 'cancelled' || s.issueIds.includes(e.entityId)
        ? s
        : withIssueIds(s, insertSorted(s.issueIds, e.entityId));
    case 'issue.cancelled':
      return cancelIssue(s, e.entityId);
    case 'issue.status_changed':
      if (e.data.to === 'cancelled') return cancelIssue(s, e.entityId);
      return e.data.to === 'failed' ? withDebris(s, e.entityId) : withoutDebris(s, e.entityId);
    case 'issue.completed': {
      const others = s.pieces.filter((p) => p.issueId !== e.entityId);
      const piece: Placement = { issueId: e.entityId, placedAt: e.data.mergedOrder };
      return withPieces(withoutDebris(s, e.entityId), [...others, piece]);
    }
    case 'issue.failed':
      return withDebris(s, e.entityId);
    case 'issue.rewritten':
      return withoutDebris(s, e.entityId);
    case 'agent.spawned': {
      const agent = { id: e.entityId, role: e.data.role, issueId: e.data.issueId };
      const w = workerFor(agent, 'working', []);
      if (w === null) return s;
      const others = s.workers.filter((o) => o.agentId !== e.entityId);
      return { ...s, workers: [...others, w].sort(byAgent) };
    }
    case 'agent.state':
      return mapWorkers(s, (w) =>
        w.agentId === e.entityId ? rebuild(w, e.data.state, w.questionIds) : w,
      );
    case 'agent.exited':
      return { ...s, workers: s.workers.filter((w) => w.agentId !== e.entityId) };
    case 'question.asked': {
      const asker = e.data.agentId;
      if (asker === null || !s.workers.some((w) => w.agentId === asker)) return s;
      return mapWorkers(s, (w) =>
        w.agentId === asker ? rebuild(w, stateOf(w), insertSorted(w.questionIds, e.entityId)) : w,
      );
    }
    case 'question.answered':
      if (!s.workers.some((w) => w.questionIds.includes(e.entityId))) return s;
      return mapWorkers(s, (w) =>
        w.questionIds.includes(e.entityId)
          ? rebuild(
              w,
              stateOf(w),
              w.questionIds.filter((q) => q !== e.entityId),
            )
          : w,
      );
  }
}

/**
 * Applies one event to a product's scene. Pure: never mutates `s` or `e`. Events of other
 * products, events without a scene effect and unknown types (forward compat) return `s`.
 */
export function sceneReduce(s: SceneState, e: Event): SceneState {
  switch (e.type) {
    case 'issue.created':
    case 'issue.cancelled':
    case 'issue.status_changed':
    case 'issue.completed':
    case 'issue.failed':
    case 'issue.rewritten':
    case 'agent.spawned':
    case 'agent.state':
    case 'agent.exited':
    case 'question.asked':
    case 'question.answered':
      return e.productId === s.productId ? reduceSceneEvent(s, e) : s;
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
    case 'issue.edited':
    case 'issue.held':
    case 'issue.released':
    case 'attempt.started':
    case 'attempt.step':
    case 'attempt.ended':
    case 'agent.activity':
    case 'usage.recorded':
    case 'budget.warned':
    case 'inbox.created':
    case 'inbox.read':
    case 'backend.limited':
    case 'backend.cleared':
    case 'settings.changed':
    case 'preview.started':
    case 'preview.stopped':
      return s;
    default: {
      // Compile time: every catalogued type is decided above. Runtime: unknown types pass.
      const _unknown: never = e;
      return s;
    }
  }
}

// ---- snapshot -----------------------------------------------------------------------------

/** Builds a product's scene from a client-state snapshot; equals replaying its events. */
export function sceneFromState(state: ClientState, productId: ProductId): SceneState {
  const issues = Object.values(state.issues).filter((i) => i.productId === productId);
  const issueIds = issues
    .filter((i) => i.status !== 'cancelled')
    .map((i) => i.id)
    .sort();
  const pieces: Placement[] = issues.flatMap((i) =>
    i.status === 'completed' && i.mergedOrder !== null
      ? [{ issueId: i.id, placedAt: i.mergedOrder }]
      : [],
  );
  const debris = issues
    .filter((i) => i.status === 'failed')
    .map((i) => ({ issueId: i.id }))
    .sort(byIssue);

  const openQuestions = Object.values(state.questions).filter((q) => q.answer === null);
  const workers = Object.values(state.agents)
    .filter((a) => a.productId === productId)
    .flatMap((a) => {
      if (a.state === 'exited') return [];
      const asked = openQuestions
        .filter((q) => q.agentId === a.id)
        .map((q) => q.id)
        .sort();
      const w = workerFor(a, a.state, asked);
      return w === null ? [] : [w];
    })
    .sort(byAgent);

  const base: SceneState = {
    productId,
    pieces: [],
    workers,
    debris,
    totalIssues: issueIds.length,
    issueIds,
  };
  return withPieces(base, pieces);
}
