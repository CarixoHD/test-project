import { useState, type FormEvent } from 'react';
import { ANSWER_MAX, AnswerQuestionRequestSchema } from '../../../shared/dto.ts';
import type { QuestionState } from '../../../shared/state.ts';
import { ApiError, answerQuestion } from '../../state/api.ts';
import { Button, Field } from '../../ui/index.ts';
import { formatInboxTime } from './inbox-model.ts';

export interface QuestionAnswerProps {
  question: QuestionState;
  /** Called after the server accepted the answer (it arrives later as `question.answered`). */
  onAnswered?: () => void;
}

/**
 * An agent's question's answer: the owner's answer once given, a "Withdrawn" status once the
 * question was withdrawn, else a labelled form that posts it (POST /api/questions/:id/answer).
 * Shared by the inbox and the issue page.
 */
export function QuestionAnswer({ question, onAnswered }: QuestionAnswerProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  if (question.answer !== null) {
    return <p className="question-answer__answer">Your answer: {question.answer}</p>;
  }
  if (question.withdrawnAt !== null) {
    // Status in text, not colour. Cancelling the issue is the only path that withdraws today.
    return (
      <p className="question-answer__withdrawn">
        <strong>Withdrawn (issue cancelled)</strong>{' '}
        <time dateTime={new Date(question.withdrawnAt).toISOString()}>
          {formatInboxTime(question.withdrawnAt)}
        </time>
      </p>
    );
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setServerError(null);
    const parsed = AnswerQuestionRequestSchema.safeParse({ text });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid answer');
      return;
    }
    setError(null);
    setSending(true);
    try {
      await answerQuestion(question.id, parsed.data.text);
      setText('');
      setSent(true);
      onAnswered?.();
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Sending the answer failed.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="question-answer" noValidate onSubmit={(ev) => void onSubmit(ev)}>
      <Field label="Your answer" error={error}>
        {(control) => (
          <textarea
            {...control}
            rows={3}
            maxLength={ANSWER_MAX}
            value={text}
            onChange={(ev) => setText(ev.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" disabled={sending}>
        Send answer
      </Button>
      <p role="status" className="question-answer__status">
        {sending ? 'Sending…' : sent ? 'Answer sent.' : ''}
      </p>
      {serverError !== null ? <p role="alert">{serverError}</p> : null}
    </form>
  );
}
