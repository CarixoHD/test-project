import {
  SavePrdDraftRequestSchema,
  SparRequestSchema,
  type SavePrdDraftRequest,
  type SparRequest,
} from '../../shared/dto.ts';
import type { Event } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { CommandDeps } from './apply-plan.ts';
import type { IssueCommandFailure } from './issues.ts';

// Owner sparring commands (ARCHITECTURE §6 flow 1): send a message (starts one sparring turn
// per product at a time) and save an edited PRD draft. Both work in every phase: reopened
// sparring never touches the running build.

/** Runs one sparring turn after the owner's message is committed (pipeline `sparTurn`). */
export type SparTurnRunner = (productId: ProductId, ownerMessage: string) => Promise<void>;

export type SparringCommandDeps = CommandDeps & {
  sparTurn: SparTurnRunner;
  /** A turn that throws (infrastructure fault); the product is freed either way. */
  onError: (error: unknown) => void;
};

export type SendSparMessageResult =
  { ok: true; events: Event[]; done: Promise<void> } | IssueCommandFailure;

export type SavePrdDraftResult = { ok: true; events: Event[] } | IssueCommandFailure;

export interface Sparring {
  /** Commits the owner's `spar.message` and starts the turn; 409 while a turn is running. */
  sendSparMessage(productId: ProductId, input: SparRequest): SendSparMessageResult;
  isTurnRunning(productId: ProductId): boolean;
  /** Resolves when no turn is running (tests, shutdown). */
  idle(): Promise<void>;
}

const failure = (code: IssueCommandFailure['code'], reason: string): IssueCommandFailure => ({
  ok: false,
  code,
  reason,
});

const zodReason = (issues: readonly { message: string }[]) =>
  issues.map((i) => i.message).join('; ');

/** Spar message ids. IdGen has no dedicated kind yet; every kind yields a fresh ULID. */
export const nextSparMessageId = (deps: CommandDeps): string => deps.ids.next('usage');

export function createSparring(deps: SparringCommandDeps): Sparring {
  const running = new Map<ProductId, Promise<void>>();

  const start = (productId: ProductId, message: string): Promise<void> => {
    const done = (async () => {
      try {
        await deps.sparTurn(productId, message);
      } catch (error) {
        deps.onError(error);
      } finally {
        running.delete(productId);
      }
    })();
    running.set(productId, done);
    return done;
  };

  return {
    sendSparMessage(productId, input) {
      const parsed = SparRequestSchema.safeParse(input);
      if (!parsed.success) return failure('invalid', zodReason(parsed.error.issues));
      if (deps.store.q.product(productId) === null) {
        return failure('not_found', `Product ${productId} not found`);
      }
      if (running.has(productId)) {
        return failure('conflict', 'The sparring agent is still answering; wait for its reply');
      }
      const { message } = parsed.data;
      const events = deps.store.commit(() => [
        {
          type: 'spar.message',
          productId,
          entityId: nextSparMessageId(deps),
          v: 1,
          data: { role: 'owner', text: message },
        },
      ]);
      return { ok: true, events, done: start(productId, message) };
    },
    isTurnRunning: (productId) => running.has(productId),
    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}

/** The owner's edit of the PRD draft, based on the product's applied PRD version. */
export function savePrdDraft(
  deps: CommandDeps,
  productId: ProductId,
  input: SavePrdDraftRequest,
): SavePrdDraftResult {
  const parsed = SavePrdDraftRequestSchema.safeParse(input);
  if (!parsed.success) return failure('invalid', zodReason(parsed.error.issues));
  const product = deps.store.q.product(productId);
  if (product === null) return failure('not_found', `Product ${productId} not found`);
  const events = deps.store.commit(() => [
    {
      type: 'prd.draft_saved',
      productId,
      entityId: null,
      v: 1,
      data: { markdown: parsed.data.markdown, baseVersion: product.prdVersion },
    },
  ]);
  return { ok: true, events };
}
