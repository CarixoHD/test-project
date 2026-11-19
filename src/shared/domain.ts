import { z } from 'zod';
import { IssueIdSchema, QuestionIdSchema } from './ids.ts';
import { RoleModelsSchema } from './models.ts';

// Domain vocabulary shared by events, reducers and DTOs (ARCHITECTURE §5 data model).
// Field names are the camelCase form of the projection columns.

export const PRODUCT_PHASES = ['sparring', 'building', 'complete'] as const;
export const PAUSE_REASONS = ['owner', 'budget'] as const;
export const ISSUE_STATUSES = [
  'open',
  'in_progress',
  'in_review',
  'completed',
  'failed',
  'cancelled',
] as const;
/** Who created (or acts on) an issue. */
export const ISSUE_ACTORS = ['orchestrator', 'owner'] as const;
export const ATTEMPT_STATUSES = [
  'running',
  'merged',
  'check_failed',
  'rejected',
  'conflict',
  'error',
  'interrupted',
  'discarded',
] as const;
export const ATTEMPT_STEPS = ['implement', 'check', 'review', 'merge'] as const;
/** Why an attempt was interrupted; interruptions never count against maxAttempts. */
export const INTERRUPT_REASONS = [
  'paused',
  'budget',
  'rate_limited',
  'auth_required',
  'shutdown',
  'restart',
  'question',
  'issue_changed',
] as const;
export const AGENT_STATES = ['working', 'waiting_owner', 'rate_limited', 'exited'] as const;
/** Mirrors the runAgent result kinds, plus `restart` for agents reaped by recovery. */
export const AGENT_EXIT_OUTCOMES = [
  'ok',
  'stopped',
  'rate_limited',
  'auth_required',
  'error',
  'restart',
] as const;
export const BILLINGS = ['api', 'subscription'] as const;
export const USAGE_SOURCES = ['computed', 'provider', 'cli'] as const;
export const QUESTION_TARGETS = ['orchestrator', 'issue'] as const;
export const INBOX_KINDS = [
  'question',
  'failed',
  'budget_warn',
  'budget_paused',
  'rate_limited',
  'auth_required',
  'replan',
  'complete',
  'error',
] as const;

export const ProductPhaseSchema = z.enum(PRODUCT_PHASES);
export const IssueStatusSchema = z.enum(ISSUE_STATUSES);
export const IssueActorSchema = z.enum(ISSUE_ACTORS);
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export const AttemptStepSchema = z.enum(ATTEMPT_STEPS);
export const InterruptReasonSchema = z.enum(INTERRUPT_REASONS);
export const AgentStateSchema = z.enum(AGENT_STATES);
export const InboxKindSchema = z.enum(INBOX_KINDS);

export type ProductPhase = z.infer<typeof ProductPhaseSchema>;
export type IssueStatus = z.infer<typeof IssueStatusSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type AttemptStep = z.infer<typeof AttemptStepSchema>;
export type InterruptReason = z.infer<typeof InterruptReasonSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
export type InboxKind = z.infer<typeof InboxKindSchema>;

const Text = z.string().min(1);
const Count = z.int().min(0);
const Positive = z.int().min(1);
/** Epoch milliseconds. */
export const EpochMsSchema = z.int().min(0);
export const UsdSchema = z.number().min(0);
/** Full git object id (SHA-1 or SHA-256). */
export const GitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, 'expected a full git sha');

export const GitRemoteSchema = z.object({ url: Text });
export type GitRemote = z.infer<typeof GitRemoteSchema>;

export const ProductSettingsSchema = z.object({
  budgetUsd: UsdSchema.nullable(),
  maxParallel: Positive,
  maxAttempts: Positive,
  models: RoleModelsSchema,
  gitRemote: GitRemoteSchema.nullable(),
});
export type ProductSettings = z.infer<typeof ProductSettingsSchema>;

export const IssueViewSchema = z.object({
  id: IssueIdSchema,
  number: Positive,
  title: Text,
  body: z.string(),
  status: IssueStatusSchema,
  rev: Positive,
  priority: z.int(),
  origin: IssueActorSchema,
  prdVersion: Count,
  attemptCount: Count,
  heldQuestionId: QuestionIdSchema.nullable(),
  runAfter: EpochMsSchema,
  mergedOrder: Positive.nullable(),
  mergeSha: GitShaSchema.nullable(),
  failureReason: z.string().nullable(),
  dependsOn: z.array(IssueIdSchema),
});
export type IssueView = z.infer<typeof IssueViewSchema>;
