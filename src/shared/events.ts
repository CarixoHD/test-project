import { z } from 'zod';
import { ProjectConfigSchema, ReviewResultSchema } from './agent-results.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
} from './ids.ts';
import {
  AGENT_EXIT_OUTCOMES,
  AgentStateSchema,
  AttemptStatusSchema,
  AttemptStepSchema,
  BILLINGS,
  EpochMsSchema,
  GitShaSchema,
  InboxKindSchema,
  InterruptReasonSchema,
  IssueActorSchema,
  IssueStatusSchema,
  IssueViewSchema,
  PAUSE_REASONS,
  ProductPhaseSchema,
  ProductSettingsSchema,
  QUESTION_TARGETS,
  USAGE_SOURCES,
  UsdSchema,
} from './domain.ts';
import { ModelRefSchema, ProviderIdSchema, RoleSchema } from './models.ts';

// The event catalogue (ARCHITECTURE §5). Every state change is one of these events, and
// payloads carry everything `reduce` needs. Event time comes from the envelope `ts`.
// Envelope: {seq, ts, type, productId|null, entityId|null, v, data}. `entityId` is the id of
// the entity the event is about (issue, attempt, agent, …), or null for product-level events.

export const EVENT_VERSION = 1;

/** Parts of the account-wide settings a `settings.changed` event can name. */
export const SETTINGS_SECTIONS = [
  'providerConfig',
  'keys',
  'roleDefaults',
  'defaultModel',
  'priceOverrides',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const Text = z.string().min(1);
const Count = z.int().min(0);
const Positive = z.int().min(1);
const EpochMs = EpochMsSchema;
const Usd = UsdSchema;
const GitSha = GitShaSchema;

// ---- envelope ---------------------------------------------------------------------------

type Scope = { productId: z.ZodType; entityId: z.ZodType };

/** Product-level event: no sub-entity. */
const PRODUCT = { productId: ProductIdSchema, entityId: z.null() };
/** Account-wide event (e.g. backend rate limits): no product. */
const GLOBAL = { productId: z.null(), entityId: z.null() };
const entityOf = <E extends z.ZodType>(entityId: E) => ({ productId: ProductIdSchema, entityId });

// `P`/`E` are separate type parameters so the envelope ids keep their concrete schema types
// (a single `S extends Scope` widens `scope.productId` to `z.ZodType`, i.e. `unknown`).
function defineEvent<
  const T extends string,
  P extends Scope['productId'],
  E extends Scope['entityId'],
  D extends z.ZodType,
>(type: T, scope: { productId: P; entityId: E }, data: D) {
  return z.object({
    seq: Positive,
    ts: EpochMs,
    type: z.literal(type),
    productId: scope.productId,
    entityId: scope.entityId,
    v: z.literal(EVENT_VERSION),
    data,
  });
}

const ISSUE = entityOf(IssueIdSchema);
const ATTEMPT = entityOf(AttemptIdSchema);
const AGENT = entityOf(AgentIdSchema);
const QUESTION = entityOf(QuestionIdSchema);

// ---- catalogue --------------------------------------------------------------------------

const productEvents = [
  defineEvent(
    'product.created',
    PRODUCT,
    ProductSettingsSchema.extend({ name: Text, idea: z.string() }),
  ),
  defineEvent(
    'product.settings_changed',
    PRODUCT,
    ProductSettingsSchema.partial()
      .extend({
        project: ProjectConfigSchema.optional(),
        // Set when a settings change takes API spend back under 80 % of the budget: the next
        // crossing warns again.
        budgetWarned: z.literal(false).optional(),
      })
      .refine((d) => Object.keys(d).length > 0, 'settings_changed must change something'),
  ),
  defineEvent('product.handed_off', PRODUCT, z.object({ prdVersion: Positive })),
  defineEvent('product.paused', PRODUCT, z.object({ reason: z.enum(PAUSE_REASONS) })),
  defineEvent('product.resumed', PRODUCT, z.object({})),
  defineEvent('product.phase_changed', PRODUCT, z.object({ phase: ProductPhaseSchema })),
  defineEvent(
    'spar.message',
    entityOf(Text),
    z.object({ role: z.enum(['owner', 'agent']), text: Text }),
  ),
  defineEvent('prd.draft_saved', PRODUCT, z.object({ markdown: z.string(), baseVersion: Count })),
  defineEvent(
    'prd.applied',
    PRODUCT,
    z.object({ version: Positive, markdown: z.string(), summary: z.string().nullable() }),
  ),
  defineEvent('orchestrator.cursor_advanced', PRODUCT, z.object({ cursor: Count })),
] as const;

const issueEvents = [
  defineEvent('issue.created', ISSUE, z.object({ issue: IssueViewSchema })),
  defineEvent(
    'issue.edited',
    ISSUE,
    z.object({
      rev: Positive,
      title: Text.optional(),
      body: z.string().optional(),
      dependsOn: z.array(IssueIdSchema).optional(),
    }),
  ),
  defineEvent(
    'issue.status_changed',
    ISSUE,
    z
      .object({
        from: IssueStatusSchema,
        to: IssueStatusSchema,
        attemptCount: Count,
        runAfter: EpochMs,
      })
      .refine((d) => d.from !== d.to, 'status must change'),
  ),
  defineEvent('issue.held', ISSUE, z.object({ questionId: QuestionIdSchema })),
  defineEvent('issue.released', ISSUE, z.object({ questionId: QuestionIdSchema })),
  defineEvent(
    'issue.cancelled',
    ISSUE,
    z.object({
      from: IssueStatusSchema.exclude(['completed', 'cancelled']),
      by: IssueActorSchema,
      reason: z.string(),
    }),
  ),
  defineEvent(
    'issue.completed',
    ISSUE,
    z.object({ attemptId: AttemptIdSchema, mergedOrder: Positive, mergeSha: GitSha }),
  ),
  defineEvent(
    'issue.failed',
    ISSUE,
    z.object({
      from: IssueStatusSchema.extract(['in_progress', 'in_review']),
      attemptCount: Count,
      reason: Text,
    }),
  ),
  /** failed → open with a new body; the attempt count resets to 0. */
  defineEvent('issue.rewritten', ISSUE, z.object({ rev: Positive, body: Text })),
] as const;

const attemptEvents = [
  defineEvent(
    'attempt.started',
    ATTEMPT,
    z.object({
      issueId: IssueIdSchema,
      n: Positive,
      issueRev: Positive,
      baseSha: GitSha,
      branch: Text,
    }),
  ),
  defineEvent(
    'attempt.step',
    ATTEMPT,
    z.object({ issueId: IssueIdSchema, step: AttemptStepSchema }),
  ),
  defineEvent(
    'attempt.ended',
    ATTEMPT,
    z
      .object({
        issueId: IssueIdSchema,
        status: AttemptStatusSchema.exclude(['running']),
        counted: z.boolean(),
        headSha: GitSha.nullable(),
        feedback: z.string().nullable(),
        review: ReviewResultSchema.nullable(),
        checkExit: z.int().nullable(),
        interruptReason: InterruptReasonSchema.nullable(),
      })
      .refine(
        (d) => (d.status === 'interrupted') === (d.interruptReason !== null),
        'interruptReason is required exactly when status is interrupted',
      ),
  ),
] as const;

const agentEvents = [
  defineEvent(
    'agent.spawned',
    AGENT,
    z.object({
      role: RoleSchema,
      model: ModelRefSchema,
      issueId: IssueIdSchema.nullable(),
      attemptId: AttemptIdSchema.nullable(),
    }),
  ),
  defineEvent(
    'agent.state',
    AGENT,
    z.object({ state: AgentStateSchema.exclude(['exited']), until: EpochMs.nullable() }),
  ),
  /** Batched (≤ 1 per 250 ms); carries the last few log lines. */
  defineEvent('agent.activity', AGENT, z.object({ lines: z.array(z.string()).min(1) })),
  defineEvent('agent.exited', AGENT, z.object({ outcome: z.enum(AGENT_EXIT_OUTCOMES) })),
] as const;

const UsageRecordedSchema = z
  .object({
    agentId: AgentIdSchema,
    role: RoleSchema,
    model: ModelRefSchema,
    issueId: IssueIdSchema.nullable(),
    attemptId: AttemptIdSchema.nullable(),
    billing: z.enum(BILLINGS),
    tokens: z.object({
      input: Count,
      output: Count,
      cacheRead: Count,
      cacheWrite: Count,
      reasoning: Count,
    }),
    webSearches: Count,
    calls: Count,
    /** API spend; null when unpriced or subscription-billed. */
    costUsd: Usd.nullable(),
    /** Unknown price: never counted as $0. */
    unpriced: z.boolean(),
    /** Informational estimate (e.g. Claude Code's costUSD); never counted as spend. */
    estCostUsd: Usd.nullable(),
    source: z.enum(USAGE_SOURCES),
  })
  .refine((d) => d.billing === 'api' || d.costUsd === null, 'subscription usage has no costUsd')
  .refine(
    (d) => d.billing !== 'api' || d.unpriced === (d.costUsd === null),
    'API usage is unpriced exactly when costUsd is null',
  );

const accountingEvents = [
  defineEvent('usage.recorded', entityOf(Text), UsageRecordedSchema),
  defineEvent('budget.warned', PRODUCT, z.object({ spentUsd: Usd, budgetUsd: Usd })),
  defineEvent(
    'question.asked',
    QUESTION,
    z
      .object({
        target: z.enum(QUESTION_TARGETS),
        issueId: IssueIdSchema.nullable(),
        agentId: AgentIdSchema.nullable(),
        text: Text,
      })
      .refine(
        (d) => (d.target === 'issue') === (d.issueId !== null),
        'issueId is required exactly for issue questions',
      ),
  ),
  defineEvent('question.answered', QUESTION, z.object({ answer: Text })),
  defineEvent(
    'inbox.created',
    { productId: ProductIdSchema.nullable(), entityId: InboxIdSchema },
    z.object({ kind: InboxKindSchema, title: Text, body: z.string(), link: Text.nullable() }),
  ),
  defineEvent(
    'inbox.read',
    { productId: ProductIdSchema.nullable(), entityId: InboxIdSchema },
    z.object({}),
  ),
  /** Account-wide: applies to every product using `backend` (e.g. 'claude-code'). */
  defineEvent(
    'backend.limited',
    GLOBAL,
    z.object({
      backend: Text,
      until: EpochMs.nullable(),
      needsLogin: z.boolean(),
      reason: z.string(),
    }),
  ),
  defineEvent('backend.cleared', GLOBAL, z.object({ backend: Text })),
  /**
   * Account-wide settings changed (GET|PUT /api/settings). Says what changed, never values:
   * API keys are write-only and must not reach events (ADR 9).
   */
  defineEvent(
    'settings.changed',
    GLOBAL,
    z.object({
      sections: z.array(z.enum(SETTINGS_SECTIONS)).min(1),
      /** Providers whose API key was set (`set: true`) or cleared. */
      keys: z.array(z.object({ provider: ProviderIdSchema, set: z.boolean() })),
    }),
  ),
  defineEvent('preview.started', PRODUCT, z.object({ url: z.url(), container: Text })),
  defineEvent('preview.stopped', PRODUCT, z.object({})),
] as const;

const EVENT_SCHEMAS = [
  ...productEvents,
  ...issueEvents,
  ...attemptEvents,
  ...agentEvents,
  ...accountingEvents,
] as const;

export const EventSchema = z.discriminatedUnion('type', EVENT_SCHEMAS);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event['type'];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/** What a command hands to `store.commit()`; the store assigns `seq` and `ts`. */
export type EventDraft = Event extends infer E
  ? E extends Event
    ? Omit<E, 'seq' | 'ts'>
    : never
  : never;

export const EVENT_TYPES: readonly EventType[] = EVENT_SCHEMAS.map((s) => s.shape.type.value);
const KNOWN_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Parses a stored or streamed event.
 * Returns null for a well-formed envelope whose `type` this build does not know (forward
 * compat), and throws (ZodError) for anything malformed, including known types with bad data.
 */
export function parseEvent(raw: unknown): Event | null {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'type' in raw &&
    typeof raw.type === 'string' &&
    !KNOWN_TYPES.has(raw.type)
  ) {
    return null;
  }
  return EventSchema.parse(raw);
}
