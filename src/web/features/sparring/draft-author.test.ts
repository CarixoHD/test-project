import { describe, expect, it } from 'vitest';
import type { PrdDraft, SparMessage } from '../../../shared/state.ts';
import { describeAuthor, draftAuthor, hasUnappliedChanges } from './draft-author.ts';

const T = 1_700_000_000_000;
const draft = (updatedAt: number, baseVersion = 0): PrdDraft => ({
  markdown: '# PRD',
  baseVersion,
  updatedAt,
});
const msg = (role: SparMessage['role'], createdAt: number): SparMessage => ({
  id: `m${String(createdAt)}`,
  role,
  text: 'x',
  createdAt,
});

describe('draftAuthor', () => {
  it('is the agent when an agent reply was committed with the draft', () => {
    expect(draftAuthor(draft(T), [msg('owner', T - 5), msg('agent', T)], [])).toEqual({
      kind: 'agent',
    });
  });

  it('is the owner when the draft was saved on its own', () => {
    expect(draftAuthor(draft(T), [msg('agent', T - 5), msg('owner', T)], [])).toEqual({
      kind: 'owner',
    });
  });

  it('is the applied version when prd.applied reset the draft', () => {
    const versions = [{ version: 2, summary: null, createdAt: T }];
    expect(draftAuthor(draft(T, 2), [], versions)).toEqual({ kind: 'applied', version: 2 });
  });

  it('describes each author', () => {
    expect(describeAuthor({ kind: 'agent' })).toBe('by the sparring agent');
    expect(describeAuthor({ kind: 'owner' })).toBe('by you');
    expect(describeAuthor({ kind: 'applied', version: 3 })).toBe('when PRD v3 was applied');
  });
});

describe('hasUnappliedChanges', () => {
  const versions = [
    { version: 1, summary: null, createdAt: T },
    { version: 2, summary: null, createdAt: T + 10 },
  ];

  it('is false before handoff and while the draft is the latest applied version', () => {
    expect(hasUnappliedChanges(draft(T), [])).toBe(false);
    expect(hasUnappliedChanges(null, versions)).toBe(false);
    expect(hasUnappliedChanges(draft(T + 10, 2), versions)).toBe(false);
  });

  it('is true once the draft was saved after the latest version was applied', () => {
    expect(hasUnappliedChanges(draft(T + 20, 2), versions)).toBe(true);
    // Still based on v1 while v2 was applied by someone else: also unapplied.
    expect(hasUnappliedChanges(draft(T, 1), versions)).toBe(true);
  });
});
