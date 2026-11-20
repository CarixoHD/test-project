import { and, eq, lt, max, notInArray } from 'drizzle-orm';
import { type Db, schema } from '../db/index.ts';

const { events } = schema;

/**
 * Deletes `agent.activity` events with `ts < before` (ADR 5: activity is pruned after 7 days),
 * except the newest activity event of each agent. Projections keep only an agent's last line,
 * so keeping that event preserves snapshot ≡ replay. Returns the number of events deleted.
 * Activity is not state: no event is appended for the deletion.
 */
export function pruneActivity(db: Db, before: number): number {
  const latestPerAgent = db
    .select({ seq: max(events.seq) })
    .from(events)
    .where(eq(events.type, 'agent.activity'))
    .groupBy(events.entityId);
  const result = db
    .delete(events)
    .where(
      and(
        eq(events.type, 'agent.activity'),
        lt(events.ts, before),
        notInArray(events.seq, latestPerAgent),
      ),
    )
    .run();
  return result.changes;
}
