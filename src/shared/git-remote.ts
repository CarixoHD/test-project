// Validation of a product's git remote URL. The server runs `git push` on the host with this
// URL, so only network transports without embedded credentials are allowed: `ext::`/`fd::`
// run commands or reach file descriptors, `file://` and paths reach the host filesystem,
// userinfo in an https URL leaks a token into events, and a leading `-` is option injection.

export const GIT_REMOTE_URL_MAX_LENGTH = 2048;

export const GIT_REMOTE_URL_ERROR =
  'Use an https:// or SSH URL without credentials. Set the token separately.';

export type GitRemoteUrlCheck = { ok: true } | { ok: false; reason: string };

/** Whitespace, C0/C1 control characters and DEL. */
const UNSAFE_CHAR = /[\s\u0000-\u001f\u007f-\u009f]/u;

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
/** DNS name / IPv4 (labels never start with `-`) or a bracketed IPv6 literal. */
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]+\\])`;
/** A login name: no `:` (that would carry a password) and no leading `-`. */
const USER = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const PORT = '(?::[0-9]{1,5})?';
/** Path after the authority: a `/` followed by at least one character. */
const PATH = '/[^/].*';

const ALLOWED = [
  // https://host[:port]/path (no userinfo at all: a lone user part is usually a token)
  new RegExp(`^https://${HOST}${PORT}${PATH}$`, 'u'),
  // ssh://[user@]host[:port]/path
  new RegExp(`^ssh://(?:${USER}@)?${HOST}${PORT}${PATH}$`, 'u'),
  // scp-like user@host:path
  new RegExp(`^${USER}@${HOST}:.+$`, 'u'),
];

/** Pure check of a git remote URL (no reachability check). */
export function validateGitRemoteUrl(url: string): GitRemoteUrlCheck {
  const bad: GitRemoteUrlCheck = { ok: false, reason: GIT_REMOTE_URL_ERROR };
  if (url.length === 0 || url.length > GIT_REMOTE_URL_MAX_LENGTH) return bad;
  if (UNSAFE_CHAR.test(url) || url.startsWith('-')) return bad;
  return ALLOWED.some((re) => re.test(url)) ? { ok: true } : bad;
}
