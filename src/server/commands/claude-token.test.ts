import { describe, expect, it } from 'vitest';
import { setupStore } from '../http/testing.ts';
import { CLAUDE_CODE_TOKEN_SECRET, createSecrets } from '../security/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { createClaudeCodeToken } from './index.ts';

const TOKEN = 'sk-ant-oat01-SetupTokenForTests-9xYz';

function setup() {
  const base = setupStore();
  const secrets = createSecrets(base);
  const token = createClaudeCodeToken({ store: base.store, secrets });
  const needsLogin = () =>
    base.store.commit(() => [
      {
        type: 'backend.limited',
        productId: null,
        entityId: null,
        v: 1,
        data: { backend: 'claude-code', until: null, needsLogin: true, reason: 'Login expired' },
      },
    ]);
  return { ...base, secrets, token, needsLogin };
}

describe('createClaudeCodeToken', () => {
  it('is unset at first', () => {
    expect(setup().token.view()).toEqual({ set: false, last4: null });
  });

  it('stores a token write-only: the view shows only its last 4 characters', () => {
    const h = setup();
    const r = h.token.update({ token: TOKEN });
    expect(r).toEqual({ ok: true, view: { set: true, last4: '9xYz' } });
    expect(h.token.view()).toEqual({ set: true, last4: '9xYz' });
    expect(h.secrets.get(CLAUDE_CODE_TOKEN_SECRET)).toBe(TOKEN);
    expect(h.redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
    expect(JSON.stringify(h.store.eventsSince(0))).not.toContain(TOKEN);
  });

  it('trims surrounding whitespace from a pasted token', () => {
    const h = setup();
    h.token.update({ token: `  ${TOKEN}\n` });
    expect(h.secrets.get(CLAUDE_CODE_TOKEN_SECRET)).toBe(TOKEN);
  });

  it('removes the token with null', () => {
    const h = setup();
    h.token.update({ token: TOKEN });
    expect(h.token.update({ token: null })).toEqual({
      ok: true,
      view: { set: false, last4: null },
    });
    expect(h.secrets.get(CLAUDE_CODE_TOKEN_SECRET)).toBeUndefined();
  });

  it.each([
    ['empty', { token: '' }],
    ['whitespace only', { token: '   ' }],
    ['inner whitespace', { token: 'sk-ant-oat01-abc def-123456' }],
    ['too long', { token: `sk-ant-oat01-${'a'.repeat(5000)}` }],
    ['not a string', { token: 42 }],
    ['extra fields', { token: TOKEN, other: 1 }],
    ['missing token', {}],
  ])('rejects %s without echoing the value', (_name, input) => {
    const h = setup();
    const r = h.token.update(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid');
    expect(r.reason).not.toContain('abc def');
    expect(r.reason).not.toContain('aaaaaaaa');
    expect(r.reason).not.toContain(TOKEN);
    expect(h.secrets.get(CLAUDE_CODE_TOKEN_SECRET)).toBeUndefined();
  });

  it('clears an active claude-code needs_login limit when a token is saved', () => {
    const h = setup();
    h.needsLogin();
    h.token.update({ token: TOKEN });
    expect(h.store.snapshot().state.backendLimits).toEqual({});
    expect(h.store.eventsSince(0).at(-1)).toMatchObject({
      type: 'backend.cleared',
      data: { backend: 'claude-code' },
    });
    expectSnapshotMatchesReplay(h.store);
  });

  it('does not clear the limit when the token is removed', () => {
    const h = setup();
    h.needsLogin();
    h.token.update({ token: null });
    expect(h.store.snapshot().state.backendLimits['claude-code']?.needsLogin).toBe(true);
  });
});
