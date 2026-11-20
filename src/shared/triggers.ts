import type { QUESTION_TARGETS } from './domain.ts';
import type { Event, EventType } from './events.ts';
import type { ProductId, QuestionId } from './ids.ts';

// Orchestrator trigger selection (ARCHITECTURE §4.1, ADR 7). The orchestrator runs when a
// product has trigger events newer than its `orchestratorCursor`; a successful run commits
// `orchestrator.cursor_advanced` to the highest seq it consumed, so each trigger fires once.

/**
 * Event types that wake the orchestrator (`question.answered` only for orchestrator questions,
 * `issue.cancelled` only when it stranded dependents).
 */
export const TRIGGER_TYPES = [
  'product.handed_off',
  'prd.applied',
  'issue.failed',
  'question.answered',
  'issue.cancelled',
] as const satisfies readonly EventType[];

type QuestionTarget = (typeof QUESTION_TARGETS)[number];

/**
 * Question targets by id, e.g. `ClientState.questions`. Used when the `question.asked` event
 * is not in the list passed to `pendingTriggers` (it usually precedes the cursor).
 */
export type QuestionTargets =
  | ReadonlyMap<QuestionId, { target: QuestionTarget }>
  | Readonly<Partial<Record<QuestionId, { target: QuestionTarget }>>>;

export type PendingTriggerOptions = {
  /** Only consider events of this product. */
  productId?: ProductId;
  questions?: QuestionTargets;
};

const TRIGGERS: ReadonlySet<string> = new Set(TRIGGER_TYPES);

function lookupTarget(
  questions: QuestionTargets | undefined,
  id: QuestionId,
): QuestionTarget | undefined {
  if (questions === undefined) return undefined;
  return questions instanceof Map
    ? (questions as ReadonlyMap<QuestionId, { target: QuestionTarget }>).get(id)?.target
    : (questions as Readonly<Partial<Record<QuestionId, { target: QuestionTarget }>>>)[id]?.target;
}

/**
 * Trigger events with `seq > cursor`, in seq order. A cancellation counts only when it stranded
 * unfinished dependents (`data.stranded`, set by owner cancels). An answered question counts only when its
 * target is the orchestrator; the target comes from a `question.asked` in `events` (any seq)
 * or else from `opts.questions`. Answers to questions of unknown target are skipped.
 */
export function pendingTriggers(
  events: readonly Event[],
  cursor: number,
  opts: PendingTriggerOptions = {},
): Event[] {
  const { productId } = opts;
  const scoped = productId === undefined ? events : events.filter((e) => e.productId === productId);
  const askedTargets = new Map<string, QuestionTarget>();
  for (const e of scoped) {
    if (e.type === 'question.asked') askedTargets.set(e.entityId, e.data.target);
  }
  const isTrigger = (e: Event): boolean => {
    if (e.seq <= cursor || !TRIGGERS.has(e.type)) return false;
    if (e.type === 'issue.cancelled') return (e.data.stranded?.length ?? 0) > 0;
    if (e.type !== 'question.answered') return true;
    const target = askedTargets.get(e.entityId) ?? lookupTarget(opts.questions, e.entityId);
    return target === 'orchestrator';
  };
  return scoped.filter(isTrigger).sort((a, b) => a.seq - b.seq);
}
