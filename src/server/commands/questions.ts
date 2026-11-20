import type { Event, EventDraft } from '../../shared/events.ts';
import { QuestionIdSchema } from '../../shared/ids.ts';
import type { CommandDeps } from './apply-plan.ts';

// Owner command: answer an agent's question (ARCHITECTURE §6 flow 8). `question.answered`, and
// for an issue question that still holds its issue also `issue.released`, so the scheduler picks
// the issue up again and the next attempt's prompt carries the Q&A. An answered orchestrator
// question is an orchestrator trigger (shared/triggers.ts).

export type AnswerQuestionResult =
  { ok: true; events: Event[] } | { ok: false; reason: string; code: 'not_found' | 'conflict' };

type Outcome = { ok: true } | { ok: false; reason: string; code: 'not_found' | 'conflict' };

/** `text` is the owner's answer, already validated as non-empty (dto AnswerQuestionRequest). */
export function answerQuestion(
  deps: CommandDeps,
  questionId: string,
  text: string,
): AnswerQuestionResult {
  let outcome: Outcome = { ok: true };
  const id = QuestionIdSchema.parse(questionId);
  const events = deps.store.commit((tx) => {
    const question = tx.q.question(id);
    if (question === null) {
      outcome = { ok: false, code: 'not_found', reason: `No question ${id}` };
      return [];
    }
    if (question.answer !== null) {
      outcome = { ok: false, code: 'conflict', reason: 'The question is already answered' };
      return [];
    }
    const answered: EventDraft = {
      type: 'question.answered',
      productId: question.productId,
      entityId: id,
      v: 1,
      data: { answer: text },
    };
    const issue = question.issueId === null ? null : tx.q.issue(question.issueId);
    if (issue === null || issue.heldQuestionId !== id) return [answered];
    return [
      answered,
      {
        type: 'issue.released',
        productId: issue.productId,
        entityId: issue.id,
        v: 1,
        data: { questionId: id },
      },
    ];
  });
  return outcome.ok ? { ok: true, events } : outcome;
}
