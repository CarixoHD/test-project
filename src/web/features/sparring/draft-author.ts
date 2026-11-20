import type { PrdDraft, PrdVersionMeta, SparMessage } from '../../../shared/state.ts';

export type DraftAuthor =
  { kind: 'agent' } | { kind: 'owner' } | { kind: 'applied'; version: number };

/**
 * Who last wrote the draft. The draft carries no author, so it is derived from how drafts are
 * committed: the sparring agent's draft shares its commit (and timestamp) with its reply,
 * `prd.applied` resets the draft to the applied version at that version's time, and the
 * owner's save is committed on its own.
 */
export function draftAuthor(
  draft: PrdDraft,
  messages: readonly SparMessage[],
  versions: readonly PrdVersionMeta[],
): DraftAuthor {
  const applied = versions.find(
    (v) => v.version === draft.baseVersion && v.createdAt === draft.updatedAt,
  );
  if (applied !== undefined) return { kind: 'applied', version: applied.version };
  if (messages.some((m) => m.role === 'agent' && m.createdAt === draft.updatedAt)) {
    return { kind: 'agent' };
  }
  return { kind: 'owner' };
}

export function describeAuthor(author: DraftAuthor): string {
  switch (author.kind) {
    case 'agent':
      return 'by the sparring agent';
    case 'owner':
      return 'by you';
    case 'applied':
      return `when PRD v${String(author.version)} was applied`;
  }
}

/**
 * Whether the draft differs from the latest applied PRD version. `prd.applied` resets the draft
 * to that version at that version's time; any later save counts as a change (the server
 * refuses an apply whose text is unchanged).
 */
export function hasUnappliedChanges(
  draft: PrdDraft | null,
  versions: readonly PrdVersionMeta[],
): boolean {
  const latest = versions.at(-1);
  if (draft === null || latest === undefined) return false;
  return !(draft.baseVersion === latest.version && draft.updatedAt === latest.createdAt);
}
