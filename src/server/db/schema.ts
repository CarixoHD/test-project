import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { ProjectConfig, ReviewResult } from '../../shared/agent-results.ts';
import {
  AGENT_STATES,
  ATTEMPT_STATUSES,
  ATTEMPT_STEPS,
  BILLINGS,
  INBOX_KINDS,
  INTERRUPT_REASONS,
  ISSUE_ACTORS,
  ISSUE_STATUSES,
  PAUSE_REASONS,
  PRODUCT_PHASES,
  QUESTION_TARGETS,
  USAGE_SOURCES,
  type GitRemote,
} from '../../shared/domain.ts';
import { ROLES, PROVIDER_IDS, type RoleModels } from '../../shared/models.ts';

// The SQLite data model (ARCHITECTURE §5). `events` is the append-only log; every other
// table except `settings`/`secrets` is a projection of it, written only by the store's
// projector inside store.commit(). Columns are snake_case; Drizzle maps them to camelCase.
// Times are epoch ms; booleans are 0/1 integers.

const bool = (name: string) => integer(name, { mode: 'boolean' });
const productRef = () => text('product_id').references((): AnySQLiteColumn => products.id);

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    type: text('type').notNull(),
    productId: text('product_id'),
    entityId: text('entity_id'),
    v: integer('v').notNull(),
    /** JSON, redacted before insert. */
    data: text('data').notNull(),
  },
  (t) => [
    index('events_product_seq').on(t.productId, t.seq),
    index('events_entity_seq').on(t.entityId, t.seq),
  ],
);

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  idea: text('idea').notNull(),
  phase: text('phase', { enum: PRODUCT_PHASES }).notNull(),
  paused: bool('paused').notNull().default(false),
  pauseReason: text('pause_reason', { enum: PAUSE_REASONS }),
  budgetUsd: real('budget_usd'),
  budgetWarned: bool('budget_warned').notNull().default(false),
  maxParallel: integer('max_parallel').notNull().default(3),
  maxAttempts: integer('max_attempts').notNull().default(3),
  models: text('models', { mode: 'json' }).$type<RoleModels>().notNull(),
  gitRemote: text('git_remote', { mode: 'json' }).$type<GitRemote>(),
  prdVersion: integer('prd_version').notNull().default(0),
  orchestratorCursor: integer('orchestrator_cursor').notNull().default(0),
  /** Last valid `.vibecode/project.json`. */
  project: text('project', { mode: 'json' }).$type<ProjectConfig>(),
  createdAt: integer('created_at').notNull(),
});

export const prdVersions = sqliteTable(
  'prd_versions',
  {
    productId: productRef().notNull(),
    version: integer('version').notNull(),
    markdown: text('markdown').notNull(),
    summary: text('summary'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.version] })],
);

export const prdDrafts = sqliteTable('prd_drafts', {
  productId: productRef().primaryKey(),
  markdown: text('markdown').notNull(),
  baseVersion: integer('base_version').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sparMessages = sqliteTable(
  'spar_messages',
  {
    id: text('id').primaryKey(),
    productId: productRef().notNull(),
    role: text('role', { enum: ['owner', 'agent'] }).notNull(),
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull(),
    /** Seq of the `spar.message` event: arrival order, also within one millisecond. */
    seq: integer('seq').notNull(),
  },
  (t) => [index('spar_messages_product_seq').on(t.productId, t.seq)],
);

export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey(),
    productId: productRef().notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ISSUE_STATUSES }).notNull(),
    rev: integer('rev').notNull(),
    priority: integer('priority').notNull(),
    origin: text('origin', { enum: ISSUE_ACTORS }).notNull(),
    prdVersion: integer('prd_version').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    heldQuestionId: text('held_question_id'),
    runAfter: integer('run_after').notNull(),
    mergedOrder: integer('merged_order'),
    mergeSha: text('merge_sha'),
    failureReason: text('failure_reason'),
    /** Server-only: why the issue was cancelled (not part of ClientState). */
    cancelReason: text('cancel_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('issues_product').on(t.productId, t.number)],
);

export const issueDeps = sqliteTable(
  'issue_deps',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    // No FK: a plan may create an issue before the issue it depends on, in the same commit.
    dependsOnId: text('depends_on_id').notNull(),
    /** Index in the issue's `dependsOn` list, which keeps its order. */
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.dependsOnId] })],
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id),
    productId: productRef().notNull(),
    n: integer('n').notNull(),
    issueRev: integer('issue_rev').notNull(),
    baseSha: text('base_sha').notNull(),
    branch: text('branch').notNull(),
    headSha: text('head_sha'),
    status: text('status', { enum: ATTEMPT_STATUSES }).notNull(),
    counted: bool('counted').notNull(),
    step: text('step', { enum: ATTEMPT_STEPS }).notNull(),
    feedback: text('feedback'),
    review: text('review', { mode: 'json' }).$type<ReviewResult>(),
    checkExit: integer('check_exit'),
    interruptReason: text('interrupt_reason', { enum: INTERRUPT_REASONS }),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [index('attempts_issue').on(t.issueId, t.n)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    productId: productRef().notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    provider: text('provider', { enum: PROVIDER_IDS }).notNull(),
    model: text('model').notNull(),
    issueId: text('issue_id'),
    attemptId: text('attempt_id'),
    state: text('state', { enum: AGENT_STATES }).notNull(),
    until: integer('until'),
    /** Last activity line; kept after the agent exits. */
    lastActivity: text('last_activity'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [index('agents_product').on(t.productId)],
);

export const usage = sqliteTable(
  'usage',
  {
    id: text('id').primaryKey(),
    productId: productRef().notNull(),
    issueId: text('issue_id'),
    attemptId: text('attempt_id'),
    agentId: text('agent_id').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    provider: text('provider', { enum: PROVIDER_IDS }).notNull(),
    model: text('model').notNull(),
    billing: text('billing', { enum: BILLINGS }).notNull(),
    input: integer('input').notNull(),
    output: integer('output').notNull(),
    cacheRead: integer('cache_read').notNull(),
    cacheWrite: integer('cache_write').notNull(),
    reasoning: integer('reasoning').notNull(),
    webSearches: integer('web_searches').notNull(),
    calls: integer('calls').notNull(),
    costUsd: real('cost_usd'),
    unpriced: bool('unpriced').notNull(),
    estCostUsd: real('est_cost_usd'),
    source: text('source', { enum: USAGE_SOURCES }).notNull(),
    ts: integer('ts').notNull(),
  },
  (t) => [index('usage_product').on(t.productId), index('usage_issue').on(t.issueId)],
);

/**
 * Running usage totals per product and per issue, added up in commit order with the shared
 * reducer's arithmetic (never SQL SUM(): float addition order would differ from replay).
 */
export const usageTotals = sqliteTable(
  'usage_totals',
  {
    scope: text('scope', { enum: ['product', 'issue'] }).notNull(),
    scopeId: text('scope_id').notNull(),
    apiUsd: real('api_usd').notNull(),
    apiUnpriced: bool('api_unpriced').notNull(),
    subInput: integer('sub_input').notNull(),
    subOutput: integer('sub_output').notNull(),
    subCacheRead: integer('sub_cache_read').notNull(),
    subCacheWrite: integer('sub_cache_write').notNull(),
    subReasoning: integer('sub_reasoning').notNull(),
    subCalls: integer('sub_calls').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.scopeId] })],
);

export const questions = sqliteTable('questions', {
  id: text('id').primaryKey(),
  productId: productRef().notNull(),
  issueId: text('issue_id'),
  agentId: text('agent_id'),
  target: text('target', { enum: QUESTION_TARGETS }).notNull(),
  text: text('text').notNull(),
  answer: text('answer'),
  createdAt: integer('created_at').notNull(),
  answeredAt: integer('answered_at'),
});

export const inbox = sqliteTable('inbox', {
  id: text('id').primaryKey(),
  productId: productRef(),
  kind: text('kind', { enum: INBOX_KINDS }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  link: text('link'),
  readAt: integer('read_at'),
  createdAt: integer('created_at').notNull(),
});

export const backendLimits = sqliteTable('backend_limits', {
  /** e.g. 'claude-code', 'anthropic'. */
  backend: text('backend').primaryKey(),
  until: integer('until'),
  needsLogin: bool('needs_login').notNull(),
  reason: text('reason').notNull(),
});

export const previews = sqliteTable('previews', {
  productId: productRef().primaryKey(),
  container: text('container').notNull(),
  url: text('url').notNull(),
  startedAt: integer('started_at').notNull(),
});

/** Host-independent prefs, role defaults, provider configs (no secrets), price overrides, password_hash. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});

/** API keys, git tokens, the session HMAC key. Never in events, never sent to the client in full. */
export const secrets = sqliteTable('secrets', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
