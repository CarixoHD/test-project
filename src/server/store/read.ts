import { and, asc, eq, max } from 'drizzle-orm';
import {
  AgentViewSchema,
  AttemptStateSchema,
  BackendLimitSchema,
  ClientStateSchema,
  EMPTY_USAGE_TOTALS,
  InboxItemSchema,
  IssueStateSchema,
  PrdDraftSchema,
  ProductStateSchema,
  SparMessageSchema,
  type AgentView,
  type AttemptState,
  type BackendLimit,
  type ClientState,
  type InboxItem,
  type IssueState,
  type PrdDraft,
  type ProductState,
  type SparMessage,
  type UsageTotals,
} from '../../shared/state.ts';
import type { AgentId, AttemptId, InboxId, IssueId, ProductId } from '../../shared/ids.ts';
import { type Db, schema } from '../db/index.ts';
import { readSettingsChangedAt, totalsFromRow } from './project-account.ts';

// Reads projection tables back into the shared ClientState shapes. Rows are validated with
// the shared zod schemas, which also gives them their branded id types.

const s = schema;
type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

function productView(r: Row<typeof s.products>) {
  const { budgetUsd, maxParallel, maxAttempts, models, gitRemote, ...rest } = r;
  return { ...rest, settings: { budgetUsd, maxParallel, maxAttempts, models, gitRemote } };
}

function issueView(r: Row<typeof s.issues>, dependsOn: string[]) {
  const { createdAt: _c, updatedAt: _u, cancelReason: _r, ...view } = r;
  return { ...view, dependsOn };
}

function inboxView(r: Row<typeof s.inbox>) {
  const { readAt, ...rest } = r;
  return { ...rest, read: readAt !== null };
}

type DepsFilter = { issueId: string } | { productId: string } | null;

/** dependsOn lists keyed by issue id, in their original order. */
function depsByIssue(db: Db, filter: DepsFilter = null): Map<string, string[]> {
  const where =
    filter === null
      ? undefined
      : 'issueId' in filter
        ? eq(s.issueDeps.issueId, filter.issueId)
        : eq(s.issues.productId, filter.productId);
  const rows = db
    .select({ issueId: s.issueDeps.issueId, dependsOnId: s.issueDeps.dependsOnId })
    .from(s.issueDeps)
    .innerJoin(s.issues, eq(s.issues.id, s.issueDeps.issueId))
    .where(where)
    .orderBy(asc(s.issueDeps.issueId), asc(s.issueDeps.position))
    .all();
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), r.dependsOnId]);
  return out;
}

function groupBy<T, V>(rows: T[], key: (r: T) => string, value: (r: T) => V) {
  const out: Record<string, V[]> = {};
  for (const r of rows) (out[key(r)] ??= []).push(value(r));
  return out;
}

const byId = <T extends { id: string }>(rows: T[]): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [r.id, r]));

function usageSnapshot(db: Db) {
  const byProduct: Record<string, UsageTotals> = {};
  const byIssue: Record<string, UsageTotals> = {};
  for (const r of db.select().from(s.usageTotals).all()) {
    (r.scope === 'product' ? byProduct : byIssue)[r.scopeId] = totalsFromRow(r);
  }
  return { byProduct, byIssue };
}

export function lastSeq(db: Db): number {
  return (
    db
      .select({ seq: max(s.events.seq) })
      .from(s.events)
      .get()?.seq ?? 0
  );
}

/** The full ClientState, built from the projection tables. */
export function readSnapshot(db: Db): { state: ClientState; lastSeq: number } {
  const deps = depsByIssue(db);
  const seq = lastSeq(db);
  const sparRows = db.select().from(s.sparMessages).orderBy(asc(s.sparMessages.seq)).all();
  const versionRows = db
    .select()
    .from(s.prdVersions)
    .orderBy(asc(s.prdVersions.productId), asc(s.prdVersions.version))
    .all();
  const raw = {
    products: byId(db.select().from(s.products).all().map(productView)),
    prdDrafts: Object.fromEntries(
      db
        .select()
        .from(s.prdDrafts)
        .all()
        .map(({ productId, ...draft }) => [productId, draft]),
    ),
    prdVersions: groupBy(
      versionRows,
      (r) => r.productId,
      ({ version, summary, createdAt }) => ({ version, summary, createdAt }),
    ),
    sparMessages: groupBy(
      sparRows,
      (r) => r.productId,
      ({ id, role, text, createdAt }) => ({ id, role, text, createdAt }),
    ),
    issues: byId(
      db
        .select()
        .from(s.issues)
        .all()
        .map((r) => issueView(r, deps.get(r.id) ?? [])),
    ),
    attempts: byId(db.select().from(s.attempts).all()),
    agents: byId(db.select().from(s.agents).all()),
    questions: byId(db.select().from(s.questions).all()),
    inbox: byId(db.select().from(s.inbox).all().map(inboxView)),
    usage: usageSnapshot(db),
    backendLimits: Object.fromEntries(
      db
        .select()
        .from(s.backendLimits)
        .all()
        .map((r) => [r.backend, r]),
    ),
    previews: Object.fromEntries(
      db
        .select()
        .from(s.previews)
        .all()
        .map(({ productId, ...preview }) => [productId, preview]),
    ),
    settingsChangedAt: readSettingsChangedAt(db),
    lastSeq: seq,
  };
  return { state: ClientStateSchema.parse(raw), lastSeq: seq };
}

/** Typed read helpers over the projections (ARCHITECTURE §4.2 `store.q`). */
export interface Queries {
  product(id: ProductId): ProductState | null;
  /** Ordered by issue number. */
  issuesByProduct(productId: ProductId): IssueState[];
  issue(id: IssueId): IssueState | null;
  /** Ordered by attempt number. */
  attemptsByIssue(issueId: IssueId): AttemptState[];
  attempt(id: AttemptId): AttemptState | null;
  /** Running totals; zero when nothing was recorded. */
  productUsage(productId: ProductId): UsageTotals;
  issueUsage(issueId: IssueId): UsageTotals;
  inboxItem(id: InboxId): InboxItem | null;
  /** The projected agent (also after it exited), null when unknown. */
  agent(id: AgentId): AgentView | null;
  /** The sparring transcript in arrival (event seq) order. */
  sparMessages(productId: ProductId): SparMessage[];
  /** The current PRD draft, null before the first save. */
  prdDraft(productId: ProductId): PrdDraft | null;
  /** Markdown of an applied PRD version, null when that version does not exist. */
  prdVersionMarkdown(productId: ProductId, version: number): string | null;
  /** Raw JSON value of a `settings` row (unvalidated; callers parse it), undefined when unset. */
  setting(key: string): unknown;
  /** The account-wide limit on `backend` (backend.limited), null when it is not limited. */
  backendLimit(backend: string): BackendLimit | null;
}

export function createQueries(db: Db): Queries {
  const usageTotals = (scope: 'product' | 'issue', id: string): UsageTotals => {
    const where = and(eq(s.usageTotals.scope, scope), eq(s.usageTotals.scopeId, id));
    const row = db.select().from(s.usageTotals).where(where).get();
    return row === undefined ? EMPTY_USAGE_TOTALS : totalsFromRow(row);
  };
  const toIssue = (r: Row<typeof s.issues>, deps: Map<string, string[]>) =>
    IssueStateSchema.parse(issueView(r, deps.get(r.id) ?? []));
  return {
    product(id) {
      const r = db.select().from(s.products).where(eq(s.products.id, id)).get();
      return r === undefined ? null : ProductStateSchema.parse(productView(r));
    },
    issuesByProduct(productId) {
      const rows = db
        .select()
        .from(s.issues)
        .where(eq(s.issues.productId, productId))
        .orderBy(asc(s.issues.number))
        .all();
      const deps = depsByIssue(db, { productId });
      return rows.map((r) => toIssue(r, deps));
    },
    issue(id) {
      const r = db.select().from(s.issues).where(eq(s.issues.id, id)).get();
      return r === undefined ? null : toIssue(r, depsByIssue(db, { issueId: id }));
    },
    attemptsByIssue(issueId) {
      return db
        .select()
        .from(s.attempts)
        .where(eq(s.attempts.issueId, issueId))
        .orderBy(asc(s.attempts.n))
        .all()
        .map((r) => AttemptStateSchema.parse(r));
    },
    attempt(id) {
      const r = db.select().from(s.attempts).where(eq(s.attempts.id, id)).get();
      return r === undefined ? null : AttemptStateSchema.parse(r);
    },
    productUsage: (productId) => usageTotals('product', productId),
    issueUsage: (issueId) => usageTotals('issue', issueId),
    inboxItem(id) {
      const r = db.select().from(s.inbox).where(eq(s.inbox.id, id)).get();
      return r === undefined ? null : InboxItemSchema.parse(inboxView(r));
    },
    agent(id) {
      const r = db.select().from(s.agents).where(eq(s.agents.id, id)).get();
      return r === undefined ? null : AgentViewSchema.parse(r);
    },
    sparMessages(productId) {
      return db
        .select()
        .from(s.sparMessages)
        .where(eq(s.sparMessages.productId, productId))
        .orderBy(asc(s.sparMessages.seq))
        .all()
        .map(({ id, role, text, createdAt }) =>
          SparMessageSchema.parse({ id, role, text, createdAt }),
        );
    },
    prdDraft(productId) {
      const r = db.select().from(s.prdDrafts).where(eq(s.prdDrafts.productId, productId)).get();
      if (r === undefined) return null;
      const { productId: _p, ...draft } = r;
      return PrdDraftSchema.parse(draft);
    },
    prdVersionMarkdown(productId, version) {
      const r = db
        .select({ markdown: s.prdVersions.markdown })
        .from(s.prdVersions)
        .where(and(eq(s.prdVersions.productId, productId), eq(s.prdVersions.version, version)))
        .get();
      return r?.markdown ?? null;
    },
    setting(key) {
      return db.select().from(s.settings).where(eq(s.settings.key, key)).get()?.value;
    },
    backendLimit(backend) {
      const r = db
        .select()
        .from(s.backendLimits)
        .where(eq(s.backendLimits.backend, backend))
        .get();
      return r === undefined ? null : BackendLimitSchema.parse(r);
    },
  };
}
