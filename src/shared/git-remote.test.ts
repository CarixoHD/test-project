import { describe, expect, it } from 'vitest';
import { GitRemoteSchema } from './domain.ts';
import {
  GIT_REMOTE_URL_ERROR,
  GIT_REMOTE_URL_MAX_LENGTH,
  validateGitRemoteUrl,
} from './git-remote.ts';

describe('validateGitRemoteUrl', () => {
  it.each([
    ['https host/path', 'https://example.com/r.git'],
    ['https with port', 'https://example.com:8443/team/r.git'],
    ['https IPv6 host', 'https://[::1]/r.git'],
    ['ssh without user', 'ssh://example.com/me/r.git'],
    ['ssh with user', 'ssh://git@example.com/me/r.git'],
    ['ssh with user and port', 'ssh://git@example.com:2222/me/r.git'],
    ['scp-like', 'git@github.com:me/repo.git'],
    ['scp-like fixture', 'git@example.com:me/a.git'],
    ['scp-like absolute path', 'deploy@git.internal:/srv/repos/a.git'],
    ['exactly the max length', `https://example.com/${'a'.repeat(GIT_REMOTE_URL_MAX_LENGTH - 20)}`],
  ])('accepts %s', (_label, url) => {
    expect(validateGitRemoteUrl(url)).toEqual({ ok: true });
  });

  it.each([
    ['empty', ''],
    ['ext:: transport', 'ext::sh -c touch% /tmp/pwned'],
    ['ext:: without spaces', 'ext::evil'],
    ['file://', 'file:///etc/passwd'],
    ['fd::', 'fd::3'],
    ['other <transport>::', 'foo::https://example.com/r.git'],
    ['plain http', 'http://example.com/r.git'],
    ['absolute local path', '/srv/repos/a.git'],
    ['relative path', '../a.git'],
    ['dot path', './a'],
    ['bare word', 'repo'],
    ['https with user and password', 'https://user:pw@example.com/r.git'],
    ['https with token as user', 'https://token@example.com/r.git'],
    ['https with empty userinfo', 'https://@example.com/r.git'],
    ['ssh with password', 'ssh://git:secret@example.com/r.git'],
    ['ssh user starting with -', 'ssh://-oProxyCommand=x@example.com/r.git'],
    ['ssh host starting with -', 'ssh://-oProxyCommand=x/r.git'],
    ['scp-like user starting with -', '-oProxyCommand=x@host:r.git'],
    ['scp-like host starting with -', 'git@-oProxyCommand=x:r.git'],
    ['leading -', '--upload-pack=touch /tmp/x'],
    ['leading - single word', '-x'],
    ['space', 'https://example.com/my repo.git'],
    ['leading whitespace', ' https://example.com/r.git'],
    ['tab', 'https://example.com/r\t.git'],
    ['newline', 'https://example.com/r.git\nhttps://evil.com/x'],
    ['NUL', 'https://example.com/r\u0000.git'],
    ['DEL', 'https://example.com/r\u007f.git'],
    ['C1 control', 'https://example.com/r\u0085.git'],
    ['over the max length', `https://example.com/${'a'.repeat(GIT_REMOTE_URL_MAX_LENGTH - 19)}`],
    ['https without path', 'https://example.com'],
    ['https with bare slash', 'https://example.com/'],
    ['ssh without path', 'ssh://example.com'],
    ['scp-like without user', 'github.com:me/repo.git'],
    ['scp-like without path', 'git@github.com:'],
    ['https bad port', 'https://example.com:abc/r.git'],
    ['https empty host', 'https:///r.git'],
  ])('rejects %s', (_label, url) => {
    expect(validateGitRemoteUrl(url)).toEqual({ ok: false, reason: GIT_REMOTE_URL_ERROR });
  });

  it('has a clear error message that mentions the allowed forms and the token', () => {
    expect(GIT_REMOTE_URL_ERROR).toBe(
      'Use an https:// or SSH URL without credentials. Set the token separately.',
    );
  });
});

describe('GitRemoteSchema', () => {
  it('accepts the existing fixtures', () => {
    expect(GitRemoteSchema.parse({ url: 'git@example.com:me/a.git' })).toEqual({
      url: 'git@example.com:me/a.git',
    });
    expect(GitRemoteSchema.safeParse({ url: 'https://example.com/r.git' }).success).toBe(true);
  });

  it('reports a rejected URL on the url field with the clear message', () => {
    const r = GitRemoteSchema.safeParse({ url: 'https://user:pw@example.com/r.git' });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({ path: ['url'], message: GIT_REMOTE_URL_ERROR }),
    ]);
  });
});
