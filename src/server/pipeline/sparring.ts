import { SparResultSchema, type SparResult } from '../../shared/agent-results.ts';
import type { EventDraft } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { SparMessage } from '../../shared/state.ts';
import type { AgentResult } from '../agents/index.ts';
import type { ModelDeps } from '../llm/index.ts';
import { renderPrompt } from './prompts.ts';
import { resolveModel } from './resolve-model.ts';
import { runRecordedAgent, type RecordedRunContext } from './run-recorded.ts';

// One sparring turn (ARCHITECTURE §6 flow 1): the interview agent answers the owner's latest
// message with its next question and, once it knows enough, a full PRD draft.

export interface SparringDeps extends RecordedRunContext {
  modelDeps: ModelDeps;
  /** Demo mode falls back to the fake model when no model is configured. */
  demo?: boolean;
  /** Server shutdown; the turn is recorded as stopped. */
  shouldStop?: () => boolean;
}

/** A sparring turn has no tools: one or two steps to call `finish` are plenty. */
export const SPAR_LIMITS = { maxSteps: 4, wallClockMs: 5 * 60_000 } as const;

const AGAIN = 'Then send your message again.';

/**
 * Runs the sparring agent for `productId`. The owner's message is already committed. Commits
 * the agent's `spar.message` (and `prd.draft_saved` when it returns a PRD) in one commit; any
 * failure becomes an actionable agent message plus an `error` inbox item instead.
 */
export async function sparTurn(
  deps: SparringDeps,
  productId: ProductId,
  ownerMessage: string,
): Promise<void> {
  const product = deps.store.q.product(productId);
  if (product === null) throw new Error(`sparTurn: unknown product ${productId}`);

  const resolved = resolveModel(deps.store, productId, 'sparring', { demo: deps.demo === true });
  if (!resolved.ok) {
    recordFailure(deps, productId, `${resolved.reason} for the sparring role. ${AGAIN}`);
    return;
  }

  const draft = deps.store.q.prdDraft(productId);
  const instructions = renderPrompt('sparring', {
    idea: product.idea,
    transcript: formatTranscript(deps.store.q.sparMessages(productId), ownerMessage),
    draft: draft === null || draft.markdown.trim() === '' ? '(no draft yet)' : draft.markdown,
  });

  let result: AgentResult<SparResult>;
  try {
    ({ result } = await runRecordedAgent(deps, {
      productId,
      role: 'sparring',
      model: resolved.model,
      instructions,
      prompt: ownerMessage,
      schema: SparResultSchema,
      tools: [],
      limits: SPAR_LIMITS,
      shouldStop: deps.shouldStop ?? (() => false),
      modelDeps: deps.modelDeps,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(deps, productId, `The sparring agent crashed: ${sentence(message)} ${AGAIN}`);
    return;
  }

  if (result.kind !== 'ok') {
    recordFailure(deps, productId, failureText(deps, result));
    return;
  }
  const { reply, prdMarkdown } = result.result;
  deps.store.commit(() => [
    agentMessage(deps, productId, reply),
    ...(prdMarkdown === undefined
      ? []
      : [
          {
            type: 'prd.draft_saved',
            productId,
            entityId: null,
            v: 1,
            data: { markdown: prdMarkdown, baseVersion: product.prdVersion },
          } satisfies EventDraft,
        ]),
  ]);
}

/** The transcript without the latest owner message (that one is the agent's prompt). */
function formatTranscript(messages: SparMessage[], ownerMessage: string): string {
  const last = messages.at(-1);
  const earlier =
    last?.role === 'owner' && last.text === ownerMessage ? messages.slice(0, -1) : messages;
  if (earlier.length === 0) return '(this is the first message)';
  return earlier.map((m) => `${m.role === 'owner' ? 'Owner' : 'You'}: ${m.text}`).join('\n\n');
}

/** `text` as one sentence ending in a single period. */
const sentence = (text: string): string => `${text.trim().replace(/[.\s]+$/, '')}.`;

function failureText(
  deps: SparringDeps,
  result: Exclude<AgentResult<SparResult>, { kind: 'ok' }>,
): string {
  switch (result.kind) {
    case 'error':
      return `The sparring agent failed: ${sentence(result.message)} Check the sparring model in Settings. ${AGAIN}`;
    case 'rate_limited': {
      const minutes = Math.max(1, Math.ceil((result.until - deps.clock.now()) / 60_000));
      const unit = minutes === 1 ? 'minute' : 'minutes';
      return `The ${result.backend} model is rate limited. Wait about ${String(minutes)} ${unit}. ${AGAIN}`;
    }
    case 'auth_required':
      return `${result.backend} needs you to log in again. Log in from Settings. ${AGAIN}`;
    case 'stopped':
      return `The sparring turn was stopped before the agent answered. ${AGAIN}`;
  }
}

/** Sparring message ids. IdGen has no dedicated kind yet; any kind yields a fresh ULID. */
const sparMessageId = (deps: SparringDeps): string => deps.ids.next('usage');

function agentMessage(deps: SparringDeps, productId: ProductId, text: string): EventDraft {
  return {
    type: 'spar.message',
    productId,
    entityId: sparMessageId(deps),
    v: 1,
    data: { role: 'agent', text },
  };
}

function recordFailure(deps: SparringDeps, productId: ProductId, text: string): void {
  const name = deps.store.q.product(productId)?.name ?? 'the product';
  deps.store.commit(() => [
    agentMessage(deps, productId, text),
    {
      type: 'inbox.created',
      productId,
      entityId: deps.ids.next('inbox'),
      v: 1,
      data: {
        kind: 'error',
        title: `Sparring on ${name} failed`,
        body: text,
        link: `/products/${productId}`,
      },
    },
  ]);
}
