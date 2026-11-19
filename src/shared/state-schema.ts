import { z } from 'zod';
import { ProjectConfigSchema, ReviewResultSchema } from './agent-results.ts';
import {
  AgentStateSchema,
  AttemptStatusSchema,
  AttemptStepSchema,
  EpochMsSchema,
  GitShaSchema,
  InboxKindSchema,
  InterruptReasonSchema,
  IssueViewSchema,
  PAUSE_REASONS,
  ProductPhaseSchema,
  ProductSettingsSchema,
  QUESTION_TARGETS,
  UsdSchema,
} from './domain.ts';
import {
  AgentIdSchema,
  AttemptIdSchema,
  InboxIdSchema,
  IssueIdSchema,
  ProductIdSchema,
  QuestionIdSchema,
} from './ids.ts';
import { ProviderIdSchema, RoleSchema } from './models.ts';

// The client-side projection of the event log (ARCHITECTURE §4.1). The browser builds it by
// replaying events through `reduce`; the server builds the same value from projection tables
// for `GET /api/state`. Collections are plain records keyed by id so the value is JSON-safe.

const Count = z.int().min(0);
const EpochMs = EpochMsSchema;

export const ProductStateSchema = z.object({
  id: ProductIdSchema,
  name: z.string(),
  idea: z.string(),
  createdAt: EpochMs,
  settings: ProductSettingsSchema,
  phase: ProductPhaseSchema,
  paused: z.boolean(),
  pauseReason: z.enum(PAUSE_REASONS).nullable(),
  /** The 80% budget warning has been sent. */
  budgetWarned: z.boolean(),
  /** Latest applied PRD version; 0 before handoff. */
  prdVersion: Count,
  /** Last valid `.vibecode/project.json`. */
  project: ProjectConfigSchema.nullable(),
  orchestratorCursor: Count,
});

export const PrdDraftSchema = z.object({
  markdown: z.string(),
  baseVersion: Count,
  updatedAt: EpochMs,
});

/** Applied PRD version metadata; the markdown itself is fetched on demand. */
export const PrdVersionMetaSchema = z.object({
  version: z.int().min(1),
  summary: z.string().nullable(),
  createdAt: EpochMs,
});

export const SparMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['owner', 'agent']),
  text: z.string(),
  createdAt: EpochMs,
});

export const IssueStateSchema = IssueViewSchema.extend({ productId: ProductIdSchema });

export const AttemptStateSchema = z.object({
  id: AttemptIdSchema,
  productId: ProductIdSchema,
  issueId: IssueIdSchema,
  n: z.int().min(1),
  issueRev: z.int().min(1),
  baseSha: GitShaSchema,
  branch: z.string(),
  headSha: GitShaSchema.nullable(),
  status: AttemptStatusSchema,
  step: AttemptStepSchema,
  counted: z.boolean(),
  feedback: z.string().nullable(),
  review: ReviewResultSchema.nullable(),
  checkExit: z.int().nullable(),
  interruptReason: InterruptReasonSchema.nullable(),
  startedAt: EpochMs,
  endedAt: EpochMs.nullable(),
});

export const AgentViewSchema = z.object({
  id: AgentIdSchema,
  productId: ProductIdSchema,
  role: RoleSchema,
  provider: ProviderIdSchema,
  model: z.string(),
  issueId: IssueIdSchema.nullable(),
  attemptId: AttemptIdSchema.nullable(),
  state: AgentStateSchema,
  /** Rate-limited until (epoch ms), when known. */
  until: EpochMs.nullable(),
  /** Only the most recent activity line; the full log is fetched per agent. */
  lastActivity: z.string().nullable(),
  startedAt: EpochMs,
  endedAt: EpochMs.nullable(),
});

export const QuestionStateSchema = z.object({
  id: QuestionIdSchema,
  productId: ProductIdSchema,
  issueId: IssueIdSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  target: z.enum(QUESTION_TARGETS),
  text: z.string(),
  answer: z.string().nullable(),
  createdAt: EpochMs,
  answeredAt: EpochMs.nullable(),
});

export const InboxItemSchema = z.object({
  id: InboxIdSchema,
  productId: ProductIdSchema.nullable(),
  kind: InboxKindSchema,
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: EpochMs,
});

export const TokenCountsSchema = z.object({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  reasoning: Count,
});

/**
 * API spend (USD) and subscription usage (tokens and calls) are kept apart: subscription
 * usage never counts as spend. `apiUnpriced` is set once any API usage had no known price.
 */
export const UsageTotalsSchema = z.object({
  apiUsd: UsdSchema,
  apiUnpriced: z.boolean(),
  subscriptionTokens: TokenCountsSchema,
  subscriptionCalls: Count,
});

export const BackendLimitSchema = z.object({
  backend: z.string().min(1),
  until: EpochMs.nullable(),
  needsLogin: z.boolean(),
  reason: z.string(),
});

export const PreviewStateSchema = z.object({
  url: z.string(),
  container: z.string(),
  startedAt: EpochMs,
});

export const ClientStateSchema = z.object({
  products: z.record(ProductIdSchema, ProductStateSchema),
  prdDrafts: z.record(ProductIdSchema, PrdDraftSchema),
  /** Ascending by version. */
  prdVersions: z.record(ProductIdSchema, z.array(PrdVersionMetaSchema)),
  /** In arrival order. */
  sparMessages: z.record(ProductIdSchema, z.array(SparMessageSchema)),
  issues: z.record(IssueIdSchema, IssueStateSchema),
  attempts: z.record(AttemptIdSchema, AttemptStateSchema),
  agents: z.record(AgentIdSchema, AgentViewSchema),
  questions: z.record(QuestionIdSchema, QuestionStateSchema),
  inbox: z.record(InboxIdSchema, InboxItemSchema),
  usage: z.object({
    byProduct: z.record(ProductIdSchema, UsageTotalsSchema),
    byIssue: z.record(IssueIdSchema, UsageTotalsSchema),
  }),
  /** Keyed by backend name (e.g. 'claude-code'); cleared limits are removed. */
  backendLimits: z.record(z.string(), BackendLimitSchema),
  previews: z.record(ProductIdSchema, PreviewStateSchema),
  lastSeq: Count,
});

export type ProductState = z.infer<typeof ProductStateSchema>;
export type PrdDraft = z.infer<typeof PrdDraftSchema>;
export type PrdVersionMeta = z.infer<typeof PrdVersionMetaSchema>;
export type SparMessage = z.infer<typeof SparMessageSchema>;
export type IssueState = z.infer<typeof IssueStateSchema>;
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export type AgentView = z.infer<typeof AgentViewSchema>;
export type QuestionState = z.infer<typeof QuestionStateSchema>;
export type InboxItem = z.infer<typeof InboxItemSchema>;
export type TokenCounts = z.infer<typeof TokenCountsSchema>;
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;
export type BackendLimit = z.infer<typeof BackendLimitSchema>;
export type PreviewState = z.infer<typeof PreviewStateSchema>;
export type ClientState = z.infer<typeof ClientStateSchema>;
