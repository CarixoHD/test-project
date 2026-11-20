// Restart recovery (ARCHITECTURE §4.11, §6 flow 10). Runs once at boot, before the scheduler:
// nothing from the previous process is live any more, so every container, worktree, running
// attempt, live agent and preview it left behind is reconciled here.
import type { EventDraft } from '../../shared/events.ts';
import { ProductIdSchema, type Clock } from '../../shared/ids.ts';
import { transition } from '../../shared/issues.ts';
import type { ClientState } from '../../shared/state.ts';
import type { Db } from '../db/index.ts';
import type { Git } from '../git/index.ts';
import { DOCKER_NOT_RUNNING, type ContainerRuntime } from '../sandbox/index.ts';
import { pruneActivity, type Store } from '../store/index.ts';

/** ADR 5: agent.activity events are kept for 7 days. */
export const ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Product ids are ULIDs (util/id-gen): 26 Crockford base32 characters. */
const PRODUCT_ID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface RecoverDeps {
  store: Store;
  /** For pruning old activity events (store/pruneActivity). */
  db: Db;
  git: Git;
  runtime: ContainerRuntime;
  clock: Clock;
  /** Warnings (already redaction-free text); defaults to console.warn. */
  log?: (line: string) => void;
}

export interface RecoveryReport {
  /** null: container cleanup was skipped because Docker is unavailable. */
  containersRemoved: number | null;
  orphanReposRemoved: string[];
  /** Events committed by the reconciliation (attempts, issues, agents, previews). */
  eventsCommitted: number;
  activityPruned: number;
}

export async function recover(deps: RecoverDeps): Promise<RecoveryReport> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const containersRemoved = await removeContainers(deps.runtime, log);
  await deps.git.clearWorktrees();
  const orphanReposRemoved = await removeOrphanRepos(deps);
  const committed = deps.store.commit(() => reconcileDrafts(deps.store.snapshot().state));
  const activityPruned = pruneActivity(deps.db, deps.clock.now() - ACTIVITY_RETENTION_MS);
  return {
    containersRemoved,
    orphanReposRemoved,
    eventsCommitted: committed.length,
    activityPruned,
  };
}

async function removeContainers(
  runtime: ContainerRuntime,
  log: (line: string) => void,
): Promise<number | null> {
  let managed;
  try {
    managed = await runtime.listManaged();
  } catch (err) {
    if (err instanceof Error && err.message === DOCKER_NOT_RUNNING) {
      log(`recovery: skipped container cleanup (${DOCKER_NOT_RUNNING})`);
      return null;
    }
    throw new Error(`recovery: listing managed containers failed: ${String(err)}`, { cause: err });
  }
  for (const c of managed) await runtime.remove(c.name);
  return managed.length;
}

/**
 * Repos left by a crash between repo creation and product.created: `<ULID>.git` with no such
 * product. Anything not shaped like a product id is never touched.
 */
async function removeOrphanRepos({ git, store }: RecoverDeps): Promise<string[]> {
  const orphans = (await git.listRepos()).filter(
    (id) => PRODUCT_ID_SHAPE.test(id) && store.q.product(ProductIdSchema.parse(id)) === null,
  );
  for (const id of orphans) await git.removeRepo(id);
  return orphans;
}

/** One commit's worth of events that ends everything the previous process left running. */
function reconcileDrafts(state: ClientState): EventDraft[] {
  const drafts: EventDraft[] = [];
  for (const a of Object.values(state.attempts)) {
    if (a.status !== 'running') continue;
    drafts.push({
      type: 'attempt.ended',
      productId: a.productId,
      entityId: a.id,
      v: 1,
      data: {
        issueId: a.issueId,
        status: 'interrupted',
        counted: false,
        headSha: a.headSha,
        feedback: null,
        review: a.review,
        checkExit: a.checkExit,
        interruptReason: 'restart',
      },
    });
  }
  for (const issue of Object.values(state.issues)) {
    const maxAttempts = state.products[issue.productId]?.settings.maxAttempts ?? 1;
    const r = transition(issue, { type: 'interrupted', reason: 'restart' }, { maxAttempts });
    if (!r.ok) continue; // only in_progress / in_review issues can be interrupted
    drafts.push({
      type: 'issue.status_changed',
      productId: issue.productId,
      entityId: issue.id,
      v: 1,
      data: {
        from: issue.status,
        to: r.next.status,
        attemptCount: r.next.attemptCount,
        runAfter: r.next.runAfter,
      },
    });
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.state === 'exited') continue;
    drafts.push({
      type: 'agent.exited',
      productId: agent.productId,
      entityId: agent.id,
      v: 1,
      data: { outcome: 'restart' },
    });
  }
  for (const productId of Object.keys(state.previews).map((id) => ProductIdSchema.parse(id))) {
    drafts.push({ type: 'preview.stopped', productId, entityId: null, v: 1, data: {} });
  }
  return drafts;
}
