import type { Event } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { Git } from '../git/index.ts';
import type { Store } from '../store/index.ts';
import type { CommandDeps } from './apply-plan.ts';
import type { IssueCommandFailure } from './issues.ts';

// Owner command: hand the PRD draft to the orchestrator (ARCHITECTURE §6 flow 2). Git first,
// then one store commit. If the store commit fails after the git step, a retry finds the draft
// already on main and does not commit it again.

export const PRD_PATH = 'docs/PRD.md';

export type HandoffDeps = CommandDeps & {
  git: Pick<Git, 'commitFilesOnMain' | 'readFileAtMain'>;
};

export type HandoffResult = { ok: true; events: Event[] } | IssueCommandFailure;

const conflict = (reason: string): IssueCommandFailure => ({ ok: false, code: 'conflict', reason });

const WRONG_PHASE = 'The product was already handed off; handoff works only while sparring';
const EMPTY_DRAFT = 'The PRD draft is empty; write or spar a draft before handing off';

/** Products with a handoff in progress (between the checks and the store commit). */
const inFlight = new Set<ProductId>();

/** Checks that the product exists, is still sparring and has a non-empty draft. */
function check(q: Store['q'], productId: ProductId): IssueCommandFailure | string {
  const product = q.product(productId);
  if (product === null)
    return { ok: false, code: 'not_found', reason: `Product ${productId} not found` };
  if (product.phase !== 'sparring') return conflict(WRONG_PHASE);
  const markdown = q.prdDraft(productId)?.markdown ?? '';
  if (markdown.trim() === '') return conflict(EMPTY_DRAFT);
  return markdown;
}

export async function handoff(deps: HandoffDeps, productId: ProductId): Promise<HandoffResult> {
  if (inFlight.has(productId)) return conflict('A handoff of this product is already running');
  const checked = check(deps.store.q, productId);
  if (typeof checked !== 'string') return checked;
  const markdown = checked;
  inFlight.add(productId);
  try {
    if ((await deps.git.readFileAtMain(productId, PRD_PATH)) !== markdown) {
      await deps.git.commitFilesOnMain(productId, { [PRD_PATH]: markdown }, 'Add PRD v1');
    }
    let failure: IssueCommandFailure | null = null;
    const events = deps.store.commit((tx) => {
      // The draft or phase may have changed while git ran; commit only what is on main.
      const now = check(tx.q, productId);
      if (now !== markdown) {
        failure =
          typeof now === 'string' ? conflict('The draft changed during handoff; try again') : now;
        return [];
      }
      return [
        {
          type: 'prd.applied',
          productId,
          entityId: null,
          v: 1,
          data: { version: 1, markdown, summary: null },
        },
        { type: 'product.handed_off', productId, entityId: null, v: 1, data: { prdVersion: 1 } },
        {
          type: 'product.phase_changed',
          productId,
          entityId: null,
          v: 1,
          data: { phase: 'building' },
        },
      ];
    });
    return failure ?? { ok: true, events };
  } finally {
    inFlight.delete(productId);
  }
}
