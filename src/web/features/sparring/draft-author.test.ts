import { describe, expect, it } from 'vitest';
import type { PrdDraft, SparMessage } from '../../../shared/state.ts';
import { describeAuthor, draftAuthor } from './draft-author.ts';

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
