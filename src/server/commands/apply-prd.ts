import type { Event, EventDraft } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { Git } from '../git/index.ts';
import type { Store } from '../store/index.ts';
import type { CommandDeps } from './apply-plan.ts';
import { PRD_PATH } from './handoff.ts';
import type { IssueCommandFailure } from './issues.ts';

// Owner command: apply the edited PRD draft after handoff (ARCHITECTURE §6 flow 6). Git first,
// then one store commit with prd.applied{N+1} (an orchestrator trigger) and, for a complete
// product, the phase back to building. A retry after a failed store commit finds the draft
// already on main and does not commit it again.

export type ApplyPrdDeps = CommandDeps & {
  git: Pick<Git, 'commitFilesOnMain' | 'readFileAtMain'>;
  /** Serialises the main-branch commit with merges; runs `fn` directly when absent. */
  withMergeLock?: (<T>(productId: ProductId, fn: () => Promise<T>) => Promise<T>) | undefined;
};

export type ApplyPrdResult = { ok: true; version: number; events: Event[] } | IssueCommandFailure;

const conflict = (reason: string): IssueCommandFailure => ({ ok: false, code: 'conflict', reason });

const WRONG_PHASE = 'Apply changes works only after handoff; hand off the PRD first';
const UNCHANGED = 'No changes to apply: the draft equals the latest PRD version';

/** Products with an apply in progress (between the checks and the store commit). */
const inFlight = new Set<ProductId>();

type Checked = { markdown: string; version: number; complete: boolean };

/** Product exists, was handed off, and the draft differs from the latest applied version. */
function check(q: Store['q'], productId: ProductId): IssueCommandFailure | Checked {
  const product = q.product(productId);
  if (product === null)
    return { ok: false, code: 'not_found', reason: `Product ${productId} not found` };
  if (product.phase !== 'building' && product.phase !== 'complete') return conflict(WRONG_PHASE);
  const markdown = q.prdDraft(productId)?.markdown ?? '';
  if (markdown.trim() === '') return conflict('The PRD draft is empty');
  if (markdown === q.prdVersionMarkdown(productId, product.prdVersion)) return conflict(UNCHANGED);
  return { markdown, version: product.prdVersion + 1, complete: product.phase === 'complete' };
}

export async function applyPrd(deps: ApplyPrdDeps, productId: ProductId): Promise<ApplyPrdResult> {
  if (inFlight.has(productId)) return conflict('Applying changes to this product is in progress');
  const checked = check(deps.store.q, productId);
  if ('ok' in checked) return checked;
  const { markdown, version } = checked;
  const withLock = deps.withMergeLock ?? ((_p, fn) => fn());
  inFlight.add(productId);
  try {
    await withLock(productId, async () => {
      if ((await deps.git.readFileAtMain(productId, PRD_PATH)) !== markdown) {
        await deps.git.commitFilesOnMain(
          productId,
          { [PRD_PATH]: markdown },
          `Update PRD to v${String(version)}`,
        );
      }
    });
    let failure: IssueCommandFailure | null = null;
    const events = deps.store.commit((tx) => {
      // The draft or phase may have changed while git ran; commit only what is on main.
      const now = check(tx.q, productId);
      if ('ok' in now) {
        failure = now;
        return [];
      }
      if (now.markdown !== markdown || now.version !== version) {
        failure = conflict('The draft changed while applying; try again');
        return [];
      }
      const drafts: EventDraft[] = [
        {
          type: 'prd.applied',
          productId,
          entityId: null,
          v: 1,
          data: { version, markdown, summary: null },
        },
      ];
      if (now.complete) {
        drafts.push({
          type: 'product.phase_changed',
          productId,
          entityId: null,
          v: 1,
          data: { phase: 'building' },
        });
      }
      return drafts;
    });
    return failure ?? { ok: true, version, events };
  } finally {
    inFlight.delete(productId);
  }
}
