import { useEffect, useRef, useState } from 'react';
import { PRD_MARKDOWN_MAX } from '../../../shared/dto.ts';
import type { ProductId } from '../../../shared/ids.ts';
import type { PrdDraft, PrdVersionMeta, SparMessage } from '../../../shared/state.ts';
import { ApiError, savePrdDraft } from '../../state/api.ts';
import { useApp, useAppStore, type AppSnapshot } from '../../state/store.ts';
import { Button, Field, Markdown } from '../../ui/index.ts';
import { describeAuthor, draftAuthor } from './draft-author.ts';

const NO_MESSAGES: readonly SparMessage[] = [];
const NO_VERSIONS: readonly PrdVersionMeta[] = [];

/** Identity of a draft revision: every save gets a new timestamp. */
const sameRevision = (a: PrdDraft | null, b: PrdDraft | null): boolean =>
  (a?.updatedAt ?? null) === (b?.updatedAt ?? null);

/** Text saved by this panel, shown until the draft in the store moves past `replaces`. */
type PendingSave = { markdown: string; replaces: PrdDraft | null };

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The live PRD draft: a sanitised preview, and an editor that saves with PUT prd-draft. A
 * draft that arrives while the owner has unsaved edits never replaces them; a notice offers
 * to load it instead.
 */
export function PrdPanel({ productId }: { productId: ProductId }) {
  const draft = useApp((s: AppSnapshot) => s.state.prdDrafts[productId] ?? null);
  const messages = useApp((s: AppSnapshot) => s.state.sparMessages[productId] ?? NO_MESSAGES);
  const versions = useApp((s: AppSnapshot) => s.state.prdVersions[productId] ?? NO_VERSIONS);
  const store = useAppStore();

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  /** The draft the editor text started from. */
  const [base, setBase] = useState<PrdDraft | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  /** Focus moves only after the owner switched modes, never on first render. */
  const focusAfterSwitch = useRef(false);

  const hasNewerDraft = editing && !sameRevision(draft, base);
  // Without unsaved edits there is nothing to protect: follow the newer draft.
  if (hasNewerDraft && text === (base?.markdown ?? '')) {
    setBase(draft);
    setText(draft?.markdown ?? '');
  }
  if (pending !== null && !sameRevision(draft, pending.replaces)) setPending(null);

  useEffect(() => {
    if (!focusAfterSwitch.current) return;
    focusAfterSwitch.current = false;
    (editing ? editorRef : editButtonRef).current?.focus();
  }, [editing]);

  function startEditing() {
    setBase(draft);
    setText(pending?.markdown ?? draft?.markdown ?? '');
    setError(null);
    focusAfterSwitch.current = true;
    setEditing(true);
  }

  function stopEditing() {
    setError(null);
    focusAfterSwitch.current = true;
    setEditing(false);
  }

  function loadNewerDraft() {
    setBase(draft);
    setText(draft?.markdown ?? '');
    editorRef.current?.focus();
  }

  async function save() {
    if (isSaving) return;
    setSaving(true);
    setError(null);
    try {
      await savePrdDraft(productId, text);
      setPending({ markdown: text, replaces: draft });
      stopEditing();
      // The draft's own event can lag over SSE; Hand off must see the saved draft now.
      void store.refresh?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the draft.');
    } finally {
      setSaving(false);
    }
  }

  const shown = pending?.markdown ?? draft?.markdown ?? '';
  const newerBy = draft !== null ? draftAuthor(draft, messages, versions) : null;

  return (
    <section className="spec-prd" aria-labelledby="spec-prd-heading">
      <div className="spec-prd__header">
        <h2 id="spec-prd-heading">PRD draft</h2>
        {editing ? null : (
          <Button ref={editButtonRef} onClick={startEditing}>
            Edit
          </Button>
        )}
      </div>
      {draft !== null ? (
        <p className="spec-prd__meta">
          Last updated{' '}
          <time dateTime={new Date(draft.updatedAt).toISOString()}>
            {formatTime(draft.updatedAt)}
          </time>{' '}
          {describeAuthor(draftAuthor(draft, messages, versions))}
        </p>
      ) : null}
      <div role="status" className="spec-prd__notice">
        {hasNewerDraft ? (
          <>
            <p>
              {newerBy?.kind === 'agent'
                ? 'The sparring agent saved a newer draft'
                : 'A newer draft was saved'}{' '}
              while you were editing. Your text is kept; Save replaces the newer draft with it.
            </p>
            <Button onClick={loadNewerDraft}>Load the newer draft (discards your edits)</Button>
          </>
        ) : null}
      </div>
      {editing ? (
        <form
          className="spec-prd__editor"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="PRD markdown">
            {(control) => (
              <textarea
                {...control}
                ref={editorRef}
                name="markdown"
                rows={20}
                maxLength={PRD_MARKDOWN_MAX}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          {error !== null ? (
            <p role="alert" className="ui-field__error">
              {error}
            </p>
          ) : null}
          <div className="spec-prd__actions">
            <Button type="submit" variant="primary" aria-disabled={isSaving || undefined}>
              Save
            </Button>
            <Button onClick={stopEditing}>Cancel</Button>
          </div>
        </form>
      ) : shown.trim() === '' ? (
        <p className="spec-prd__empty">
          No PRD draft yet. The sparring agent writes one once it knows enough, or you can write it
          yourself with Edit.
        </p>
      ) : (
        <Markdown className="spec-prd__preview">{shown}</Markdown>
      )}
    </section>
  );
}
