import { describe, expect, it } from 'vitest';
import type { IssueStatus, IssueView } from './domain.ts';
import { EVENT_TYPES, EventSchema, type Event, type EventDraft } from './events.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
  type AgentId,
  type IssueId,
  type ProductId,
} from './ids.ts';
import type { Role } from './models.ts';
import {
  NO_OP_SCENE_EVENTS,
  SCENE_EVENTS,
  emptyScene,
  layoutPiece,
  sceneFromState,
  sceneReduce,
  type SceneState,
} from './scene.ts';
import { emptyState, reduce } from './state.ts';

// ---- fixtures ---------------------------------------------------------------------------

const P = ProductIdSchema.parse('01PRODUCT');
const OTHER = ProductIdSchema.parse('01OTHER');
const issueId = (n: number): IssueId => IssueIdSchema.parse(`01ISSUE${n}`);
const agentId = (n: number): AgentId => AgentIdSchema.parse(`01AGENT${n}`);
const AT = AttemptIdSchema.parse('01ATTEMPT');
const Q = QuestionIdSchema.parse('01QUESTION');
const Q2 = QuestionIdSchema.parse('01QUESTION2');
const SHA = 'a'.repeat(40);
const T0 = 1_700_000_000_000;
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' } as const;

let seq = 1;
function ev(draft: EventDraft): Event {
  const n = seq++;
  return EventSchema.parse({ ...draft, seq: n, ts: T0 + n });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Replays with frozen inputs, so any mutation throws. */
function replay(events: readonly Event[], scene: SceneState = emptyScene(P)): SceneState {
  return events.reduce((s, e) => sceneReduce(deepFreeze(s), deepFreeze(e)), scene);
}

function issueView(n: number, status: IssueStatus = 'open'): IssueView {
  return {
    id: issueId(n),
    number: n,
    title: `Issue ${n}`,
    body: '',
    status,
    rev: 1,
    priority: 0,
    origin: 'orchestrator',
    prdVersion: 1,
    attemptCount: 0,
    heldQuestionId: null,
    runAfter: 0,
    mergedOrder: null,
    mergeSha: null,
    failureReason: null,
    dependsOn: [],
  };
}

const productCreated = (pid: ProductId = P) =>
  ev({
    type: 'product.created',
    productId: pid,
    entityId: null,
    v: 1,
    data: {
      name: 'Todo',
      idea: 'A todo app',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 3,
      models: {},
      gitRemote: null,
    },
  });
const created = (n: number, pid: ProductId = P) =>
  ev({
    type: 'issue.created',
    productId: pid,
    entityId: issueId(n),
    v: 1,
    data: { issue: issueView(n) },
  });
const completed = (n: number, mergedOrder: number, pid: ProductId = P) =>
  ev({
    type: 'issue.completed',
    productId: pid,
    entityId: issueId(n),
    v: 1,
    data: { attemptId: AT, mergedOrder, mergeSha: SHA },
  });
const cancelled = (n: number) =>
  ev({
    type: 'issue.cancelled',
    productId: P,
    entityId: issueId(n),
    v: 1,
    data: { from: 'open', by: 'owner', reason: 'no longer needed' },
  });
const failed = (n: number) =>
  ev({
    type: 'issue.failed',
    productId: P,
    entityId: issueId(n),
    v: 1,
    data: { from: 'in_review', attemptCount: 3, reason: 'checks keep failing' },
  });
const rewritten = (n: number) =>
  ev({
    type: 'issue.rewritten',
    productId: P,
    entityId: issueId(n),
    v: 1,
    data: { rev: 2, body: 'smaller scope' },
  });
const statusChanged = (n: number, from: IssueStatus, to: IssueStatus) =>
  ev({
    type: 'issue.status_changed',
    productId: P,
    entityId: issueId(n),
    v: 1,
    data: { from, to, attemptCount: 0, runAfter: 0 },
  });
const spawned = (n: number, role: Role, pid: ProductId = P) =>
  ev({
    type: 'agent.spawned',
    productId: pid,
    entityId: agentId(n),
    v: 1,
    data: { role, model: MODEL, issueId: issueId(n), attemptId: null },
  });
const agentState = (n: number, state: 'working' | 'waiting_owner' | 'rate_limited') =>
  ev({
    type: 'agent.state',
    productId: P,
    entityId: agentId(n),
    v: 1,
    data: { state, until: state === 'rate_limited' ? T0 + 60_000 : null },
  });
const exited = (n: number) =>
  ev({
    type: 'agent.exited',
    productId: P,
    entityId: agentId(n),
    v: 1,
    data: { outcome: 'ok' },
  });
const asked = (n: number | null, q = Q) =>
  ev({
    type: 'question.asked',
    productId: P,
    entityId: q,
    v: 1,
    data: {
      target: 'orchestrator',
      issueId: null,
      agentId: n === null ? null : agentId(n),
      text: 'Which database?',
    },
  });
const answered = (q = Q) =>
  ev({ type: 'question.answered', productId: P, entityId: q, v: 1, data: { answer: 'SQLite' } });

const worker = (s: SceneState, n: number) => s.workers.find((w) => w.agentId === agentId(n));

// ---- catalogue coverage -----------------------------------------------------------------

describe('scene event coverage', () => {
  it('makes an explicit scene decision for every catalogued event type', () => {
    const decided = new Set<string>([...SCENE_EVENTS, ...NO_OP_SCENE_EVENTS]);
    for (const type of EVENT_TYPES) expect(decided, type).toContain(type);
  });

  it('never lists a type as both visible and no-op', () => {
    const noOp = new Set<string>(NO_OP_SCENE_EVENTS);
    for (const type of SCENE_EVENTS) expect(noOp.has(type), type).toBe(false);
  });

  it('returns the same scene for no-op events', () => {
    const base = replay([created(1), spawned(1, 'implementer')]);
    const noOps: Event[] = [
      productCreated(),
      ev({
        type: 'agent.activity',
        productId: P,
        entityId: agentId(1),
        v: 1,
        data: { lines: ['npm test'] },
      }),
      ev({
        type: 'issue.edited',
        productId: P,
        entityId: issueId(1),
        v: 1,
        data: { rev: 2, title: 'Renamed' },
      }),
      ev({
        type: 'backend.limited',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code', until: null, needsLogin: false, reason: 'limit' },
      }),
      ev({
        type: 'inbox.created',
        productId: P,
        entityId: InboxIdSchema.parse('01INBOX'),
        v: 1,
        data: { kind: 'failed', title: 't', body: '', link: null },
      }),
    ];
    for (const e of noOps) expect(sceneReduce(base, e), e.type).toBe(base);
  });

  it('ignores events of other products', () => {
    const base = replay([created(1)]);
    for (const e of [created(2, OTHER), completed(1, 1, OTHER), spawned(3, 'reviewer', OTHER)]) {
      expect(sceneReduce(base, e), e.type).toBe(base);
    }
  });

  it('ignores event types this build does not know (forward compat)', () => {
    const base = replay([created(1)]);
    const unknown = { ...created(2), type: 'future.thing' } as unknown as Event;
    expect(sceneReduce(base, unknown)).toBe(base);
  });
});

// ---- event mapping (PRD '3D construction view') -----------------------------------------

describe('sceneReduce: issues → building', () => {
  it('issue.created and issue.cancelled adjust totalIssues', () => {
    const table: { name: string; events: () => Event[]; total: number }[] = [
      { name: 'created ×3', events: () => [created(1), created(2), created(3)], total: 3 },
      {
        name: 'cancelled removes one',
        events: () => [created(1), created(2), cancelled(2)],
        total: 1,
      },
      {
        name: 'status_changed to cancelled removes one (idempotent with issue.cancelled)',
        events: () => [created(1), statusChanged(1, 'open', 'cancelled'), cancelled(1)],
        total: 0,
      },
      { name: 'duplicate created counts once', events: () => [created(1), created(1)], total: 1 },
    ];
    for (const row of table) expect(replay(row.events()).totalIssues, row.name).toBe(row.total);
  });

  it('issue.completed adds a piece laid out by layoutPiece with a placedAt marker', () => {
    const s = replay([created(1), created(2), created(3), completed(2, 1)]);
    expect(s.pieces).toEqual([{ issueId: issueId(2), placedAt: 1, ...layoutPiece(0, 3) }]);
  });

  it('pieces are ordered by mergedOrder and relaid out when totalIssues changes', () => {
    const s = replay([created(1), created(2), completed(2, 1), completed(1, 2), created(3)]);
    expect(s.pieces.map((p) => p.issueId)).toEqual([issueId(2), issueId(1)]);
    expect(s.pieces[1]).toMatchObject(layoutPiece(1, 3));
  });

  it('the building is complete (roof placed last) when all issues are done', () => {
    const n = 7;
    const events = [...Array.from({ length: n }, (_, i) => created(i + 1))];
    for (let i = 1; i <= n; i++) events.push(completed(i, i));
    const s = replay(events);
    expect(s.pieces).toHaveLength(n);
    expect(s.pieces.at(-1)?.type).toBe('roof');
    expect(s.pieces.filter((p) => p.type === 'roof')).toHaveLength(1);
  });

  it('issue.failed adds debris; it is removed when the issue is retried or cancelled', () => {
    const table: { name: string; events: () => Event[]; debris: IssueId[] }[] = [
      { name: 'failed', events: () => [created(1), failed(1)], debris: [issueId(1)] },
      {
        name: 'failed → rewritten',
        events: () => [created(1), failed(1), rewritten(1)],
        debris: [],
      },
      {
        name: 'failed → cancelled',
        events: () => [created(1), failed(1), cancelled(1)],
        debris: [],
      },
      {
        name: 'failed → back to open',
        events: () => [created(1), failed(1), statusChanged(1, 'failed', 'open')],
        debris: [],
      },
      {
        name: 'status_changed to failed',
        events: () => [created(1), statusChanged(1, 'in_review', 'failed')],
        debris: [issueId(1)],
      },
      {
        name: 'two failures, one retried',
        events: () => [created(1), created(2), failed(2), failed(1), rewritten(2)],
        debris: [issueId(1)],
      },
    ];
    for (const row of table) {
      expect(
        replay(row.events()).debris.map((d) => d.issueId),
        row.name,
      ).toEqual(row.debris);
    }
  });
});

describe('sceneReduce: agents → workers', () => {
  it('agent.spawned adds a worker whose figure depends on the role', () => {
    const table = [
      { role: 'orchestrator', figure: 'foreman', location: 'site' },
      { role: 'implementer', figure: 'builder', location: 'site' },
      { role: 'reviewer', figure: 'inspector', location: 'site' },
      { role: 'sparring', figure: 'drafter', location: 'desk' },
    ] as const;
    for (const row of table) {
      const s = replay([spawned(1, row.role)]);
      expect(s.workers, row.role).toEqual([
        {
          agentId: agentId(1),
          role: row.role,
          figure: row.figure,
          issueId: issueId(1),
          activity: 'working',
          location: row.location,
          bubble: false,
          questionIds: [],
        },
      ]);
    }
  });

  it('utility agents have no figure', () => {
    expect(replay([spawned(1, 'utility')]).workers).toEqual([]);
  });

  it('agent.state maps to working, "?" bubble and bench', () => {
    const table = [
      { state: 'working', activity: 'working', location: 'site', bubble: false },
      { state: 'waiting_owner', activity: 'waiting', location: 'site', bubble: true },
      { state: 'rate_limited', activity: 'resting', location: 'bench', bubble: false },
    ] as const;
    for (const row of table) {
      const s = replay([spawned(1, 'implementer'), agentState(1, row.state)]);
      expect(worker(s, 1), row.state).toMatchObject({
        activity: row.activity,
        location: row.location,
        bubble: row.bubble,
      });
    }
  });

  it('a rate-limited drafter goes to the bench and back to the desk', () => {
    const s1 = replay([spawned(1, 'sparring'), agentState(1, 'rate_limited')]);
    expect(worker(s1, 1)?.location).toBe('bench');
    const s2 = replay([agentState(1, 'working')], s1);
    expect(worker(s2, 1)?.location).toBe('desk');
  });

  it('question.asked for the agent shows a bubble until it is answered', () => {
    const table: { name: string; events: () => Event[]; bubble: boolean }[] = [
      { name: 'asked', events: () => [spawned(1, 'orchestrator'), asked(1)], bubble: true },
      {
        name: 'asked → answered',
        events: () => [spawned(1, 'orchestrator'), asked(1), answered()],
        bubble: false,
      },
      {
        name: 'two asked, one answered',
        events: () => [spawned(1, 'orchestrator'), asked(1), asked(1, Q2), answered()],
        bubble: true,
      },
      {
        name: 'asked by someone else',
        events: () => [spawned(1, 'orchestrator'), asked(2)],
        bubble: false,
      },
      {
        name: 'asked without an agent',
        events: () => [spawned(1, 'orchestrator'), asked(null)],
        bubble: false,
      },
    ];
    for (const row of table) {
      expect(worker(replay(row.events()), 1)?.bubble, row.name).toBe(row.bubble);
    }
  });

  it('agent.exited makes the worker leave', () => {
    const s = replay([spawned(1, 'implementer'), spawned(2, 'reviewer'), exited(1)]);
    expect(s.workers.map((w) => w.agentId)).toEqual([agentId(2)]);
  });
});

// ---- layoutPiece ------------------------------------------------------------------------

describe('layoutPiece', () => {
  const key = (pos: readonly number[]) => pos.join(',');

  it('is deterministic', () => {
    for (let total = 1; total <= 40; total++) {
      for (let i = 0; i < total; i++) expect(layoutPiece(i, total)).toEqual(layoutPiece(i, total));
    }
  });

  it('places the roof at the final piece, and only there', () => {
    for (let total = 1; total <= 120; total++) {
      for (let i = 0; i < total; i++) {
        expect(layoutPiece(i, total).type === 'roof', `${i}/${total}`).toBe(i === total - 1);
      }
    }
  });

  it('never places two pieces of one building at the same position', () => {
    for (let total = 1; total <= 120; total++) {
      const seen = new Set<string>();
      for (let i = 0; i < total; i++) seen.add(key(layoutPiece(i, total).pos));
      expect(seen.size, `total ${total}`).toBe(total);
    }
  });

  it('uses floors, walls and windows below the roof', () => {
    const types = new Set(Array.from({ length: 30 }, (_, i) => layoutPiece(i, 31).type));
    expect([...types].sort()).toEqual(['floor', 'wall', 'window']);
  });

  it('builds bottom-up: the roof is the highest piece', () => {
    for (const total of [2, 10, 50, 100]) {
      const roofY = layoutPiece(total - 1, total).pos[1];
      for (let i = 0; i < total - 1; i++) {
        expect(layoutPiece(i, total).pos[1]).toBeLessThan(roofY);
      }
    }
  });

  it('treats an index beyond totalIssues as the last piece', () => {
    expect(layoutPiece(4, 2)).toEqual(layoutPiece(4, 5));
  });
});

// ---- snapshot ≡ replay ------------------------------------------------------------------

describe('sceneFromState', () => {
  it('equals the scene replayed from the same events', () => {
    seq = 1;
    const events: Event[] = [
      productCreated(),
      productCreated(OTHER),
      ...[1, 2, 3, 4, 5, 6].map((n) => created(n)),
      created(9, OTHER),
      spawned(1, 'implementer'),
      spawned(2, 'reviewer'),
      spawned(3, 'orchestrator'),
      spawned(4, 'sparring'),
      spawned(5, 'implementer'),
      spawned(8, 'implementer', OTHER),
      completed(9, 1, OTHER),
      completed(3, 1),
      completed(1, 2),
      statusChanged(2, 'open', 'in_progress'),
      failed(2),
      failed(5),
      rewritten(5),
      cancelled(6),
      agentState(1, 'rate_limited'),
      agentState(2, 'waiting_owner'),
      asked(3),
      asked(3, Q2),
      answered(Q2),
      exited(5),
      completed(4, 3),
    ];
    const state = events.reduce(reduce, emptyState);
    const replayed = replay(events);
    expect(sceneFromState(state, P)).toEqual(replayed);
    // Sanity: the fixture exercises every part of the scene.
    expect(replayed.pieces).toHaveLength(3);
    expect(replayed.debris).toHaveLength(1);
    expect(replayed.workers).toHaveLength(4);
    expect(replayed.totalIssues).toBe(5);
    expect(worker(replayed, 3)?.bubble).toBe(true);
  });

  it('of an empty state is the empty scene', () => {
    expect(sceneFromState(emptyState, P)).toEqual(emptyScene(P));
  });
});
