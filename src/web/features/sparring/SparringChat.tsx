import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SPAR_MESSAGE_MAX, SparRequestSchema } from '../../../shared/dto.ts';
import type { ProductId } from '../../../shared/ids.ts';
import type { SparMessage } from '../../../shared/state.ts';
import { ApiError, sendSparMessage } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button, Field, Markdown } from '../../ui/index.ts';

const NO_MESSAGES: readonly SparMessage[] = [];

const countAgentReplies = (messages: readonly SparMessage[]): number =>
  messages.filter((m) => m.role === 'agent').length;

/** The sparring transcript and the owner's message form, updated live from events. */
export function SparringChat({ productId }: { productId: ProductId }) {
  const selectMessages = (s: AppSnapshot) => s.state.sparMessages[productId] ?? NO_MESSAGES;
  const messages = useApp(selectMessages);
  const agentWorking = useApp((s) =>
    Object.values(s.state.agents).some(
      (a) => a.productId === productId && a.role === 'sparring' && a.state !== 'exited',
    ),
  );
  const loaded = useApp((s) => s.loaded);
  const replies = countAgentReplies(messages);

  // Replies present once the snapshot is in are history; only later ones are announced.
  const [historyReplies, setHistoryReplies] = useState<number | null>(loaded ? replies : null);
  if (historyReplies === null && loaded) setHistoryReplies(replies);
  // After a successful send, the reply count to wait past (the agent may not have spawned yet).
  const [awaitingAfter, setAwaitingAfter] = useState<number | null>(null);
  const thinking = agentWorking || (awaitingAfter !== null && replies <= awaitingAfter);
  const latestReply =
    historyReplies !== null && replies > historyReplies
      ? messages.findLast((m) => m.role === 'agent')
      : undefined;

  return (
    <section className="spec-chat" aria-labelledby="spec-chat-heading">
      <h2 id="spec-chat-heading">Sparring</h2>
      <ol className="spec-chat__transcript" aria-label="Conversation">
        {messages.map((m) => (
          <li key={m.id} className={`spec-chat__message spec-chat__message--${m.role}`}>
            <p className="spec-chat__author">{m.role === 'owner' ? 'You' : 'Sparring agent'}</p>
            {m.role === 'owner' ? (
              <p className="spec-chat__text">{m.text}</p>
            ) : (
              <Markdown>{m.text}</Markdown>
            )}
          </li>
        ))}
      </ol>
      {messages.length === 0 ? (
        <p className="spec-chat__empty">
          Tell the sparring agent about your idea. It asks questions and drafts the PRD.
        </p>
      ) : null}
      <p role="status" className="spec-chat__thinking">
        {thinking ? 'Agent is thinking…' : ''}
      </p>
      <p className="visually-hidden" aria-live="polite" data-testid="spar-announcer">
        {latestReply ? `Sparring agent replied: ${latestReply.text}` : ''}
      </p>
      <MessageForm productId={productId} onSent={() => setAwaitingAfter(replies)} />
    </section>
  );
}

function MessageForm({ productId, onSent }: { productId: ProductId; onSent: () => void }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  async function send() {
    if (isSending) return;
    const parsed = SparRequestSchema.safeParse({ message });
    setServerError(null);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Message is invalid');
      boxRef.current?.focus();
      return;
    }
    setError(null);
    setSending(true);
    try {
      await sendSparMessage(productId, parsed.data.message);
      setMessage('');
      onSent();
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not send the message.');
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <form className="spec-chat__form" noValidate onSubmit={onSubmit}>
      <Field label="Your message" hint="Ctrl+Enter or ⌘+Enter sends." error={error}>
        {(control) => (
          <textarea
            {...control}
            ref={boxRef}
            name="message"
            rows={4}
            maxLength={SPAR_MESSAGE_MAX}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </Field>
      {serverError !== null ? (
        <p role="alert" className="ui-field__error">
          {serverError}
        </p>
      ) : null}
      <Button type="submit" variant="primary" aria-disabled={isSending || undefined}>
        Send
      </Button>
    </form>
  );
}
