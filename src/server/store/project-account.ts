import { and, eq } from 'drizzle-orm';
import type { EventOf } from '../../shared/events.ts';
import { addUsage, type UsageTotals } from '../../shared/state.ts';
import { type Db, schema } from '../db/index.ts';
import { readSetting, writeSetting } from './settings.ts';

// Projects accounting and account-wide events. Mirrors src/shared/state-account.ts.

const { usage, usageTotals, questions, inbox, backendLimits } = schema;

type TotalsRow = typeof usageTotals.$inferSelect;
type Scope = TotalsRow['scope'];

export function totalsFromRow(r: TotalsRow): UsageTotals {
  return {
    apiUsd: r.apiUsd,
    apiUnpriced: r.apiUnpriced,
    subscriptionTokens: {
      input: r.subInput,
      output: r.subOutput,
      cacheRead: r.subCacheRead,
      cacheWrite: r.subCacheWrite,
      reasoning: r.subReasoning,
    },
    subscriptionCalls: r.subCalls,
  };
}

function totalsToRow(scope: Scope, scopeId: string, t: UsageTotals): TotalsRow {
  const tok = t.subscriptionTokens;
  return {
    scope,
    scopeId,
    apiUsd: t.apiUsd,
    apiUnpriced: t.apiUnpriced,
    subInput: tok.input,
    subOutput: tok.output,
    subCacheRead: tok.cacheRead,
    subCacheWrite: tok.cacheWrite,
    subReasoning: tok.reasoning,
    subCalls: t.subscriptionCalls,
  };
}

/** Adds one usage event to the running totals with the shared reducer's arithmetic. */
function addToTotals(db: Db, scope: Scope, scopeId: string, d: EventOf<'usage.recorded'>['data']) {
  const where = and(eq(usageTotals.scope, scope), eq(usageTotals.scopeId, scopeId));
  const cur = db.select().from(usageTotals).where(where).get();
  const row = totalsToRow(scope, scopeId, addUsage(cur && totalsFromRow(cur), d));
  db.insert(usageTotals)
    .values(row)
    .onConflictDoUpdate({ target: [usageTotals.scope, usageTotals.scopeId], set: row })
    .run();
}

function usageRecorded(db: Db, e: EventOf<'usage.recorded'>): void {
  const { tokens, model, ...d } = e.data;
  db.insert(usage)
    .values({
      id: e.entityId,
      productId: e.productId,
      ...d,
      provider: model.provider,
      model: model.model,
      ...tokens,
      ts: e.ts,
    })
    .run();
  addToTotals(db, 'product', e.productId, e.data);
  if (e.data.issueId !== null) addToTotals(db, 'issue', e.data.issueId, e.data);
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

export function projectAccountEvent(db: Db, e: AccountEvent): void {
  switch (e.type) {
    case 'usage.recorded':
      return usageRecorded(db, e);
    case 'question.asked':
      db.insert(questions)
        .values({ id: e.entityId, productId: e.productId, ...e.data, createdAt: e.ts })
        .run();
      return;
    case 'question.answered':
      db.update(questions)
        .set({ answer: e.data.answer, answeredAt: e.ts })
        .where(eq(questions.id, e.entityId))
        .run();
      return;
    case 'inbox.created':
      db.insert(inbox)
        .values({ id: e.entityId, productId: e.productId, ...e.data, createdAt: e.ts })
        .run();
      return;
    case 'inbox.read':
      db.update(inbox).set({ readAt: e.ts }).where(eq(inbox.id, e.entityId)).run();
      return;
    case 'backend.limited': {
      const { backend, ...limit } = e.data;
      db.insert(backendLimits)
        .values({ backend, ...limit })
        .onConflictDoUpdate({ target: backendLimits.backend, set: limit })
        .run();
      return;
    }
    case 'backend.cleared':
      db.delete(backendLimits).where(eq(backendLimits.backend, e.data.backend)).run();
      return;
  }
}

/** `settings` row holding ClientState.settingsChangedAt (written only by this projection). */
export const SETTINGS_CHANGED_AT_KEY = 'settingsChangedAt';

/** `settings.changed`: the settings rows themselves are written by the command; this keeps the marker. */
export function projectSettingsChanged(db: Db, ts: number): void {
  writeSetting(db, SETTINGS_CHANGED_AT_KEY, ts);
}

export function readSettingsChangedAt(db: Db): number | null {
  const value = readSetting(db, SETTINGS_CHANGED_AT_KEY);
  return typeof value === 'number' ? value : null;
}
