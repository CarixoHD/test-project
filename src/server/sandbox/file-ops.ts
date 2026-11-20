// Fixed argv protocol for the agent file tools (read, write via stdin, list, grep).
// The docker runtime runs these argv inside the container; FakeContainerRuntime recognises the same
// argv and applies them to the worktree directly. Paths are always relative to /workspace,
// normalised, free of `..` and never inside `.git` (CODING_STANDARDS §7).
import path from 'node:path';
import { WORKSPACE } from './run-args.ts';

export type FileOp =
  | { op: 'read'; path: string }
  /** Content comes from ExecOpts.stdin; parent directories are created. */
  | { op: 'write'; path: string }
  /** `ls -1Ap`: one entry per line, directories end in `/`, `.git` omitted by the caller. */
  | { op: 'list'; path: string }
  /** Extended regex, recursive, `path:line:text` output, `.git` excluded, binary files skipped. */
  | { op: 'grep'; path: string; pattern: string };

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/** Fixed script: the target path is passed as `$1`, never interpolated. */
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
const WRITE_ARGV0 = 'vibecode-write';
const LS_FLAGS = '-1Ap';
const GREP_FLAGS = '-rnIE';
const GREP_EXCLUDE = '--exclude-dir=.git';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Normalises an agent-supplied path relative to /workspace. `''` and `.` mean the workspace root. */
export function normalizeRelPath(input: string): PathResult {
  if (CONTROL_CHARS.test(input)) return { ok: false, reason: 'path contains NUL or control characters' };
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    return { ok: false, reason: `path must be relative to the workspace, got ${input}` };
  }
  if (input.includes('\\')) return { ok: false, reason: 'use forward slashes in paths' };
  const segments = input.split('/');
  if (segments.includes('..')) return { ok: false, reason: 'path must not contain ..' };
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    return { ok: false, reason: '.git is not accessible' };
  }
  const normal = path.posix.normalize(input === '' ? '.' : input).replace(/\/+$/, '');
  return { ok: true, path: normal === '' ? '.' : normal };
}

/** Absolute in-container path for a normalised relative path. */
export function toWorkspacePath(rel: string): string {
  return rel === '.' ? WORKSPACE : `${WORKSPACE}/${rel}`;
}

export function fileOpArgv(op: FileOp): { ok: true; argv: string[] } | { ok: false; reason: string } {
  const p = normalizeRelPath(op.path);
  if (!p.ok) return p;
  if ((op.op === 'read' || op.op === 'write') && p.path === '.') {
    return { ok: false, reason: `${op.op} needs a file path` };
  }
  const target = toWorkspacePath(p.path);
  switch (op.op) {
    case 'read':
      return { ok: true, argv: ['cat', '--', target] };
    case 'write':
      return { ok: true, argv: ['sh', '-c', WRITE_SCRIPT, WRITE_ARGV0, target] };
    case 'list':
      return { ok: true, argv: ['ls', LS_FLAGS, '--', target] };
    case 'grep':
      if (op.pattern === '') return { ok: false, reason: 'grep needs a pattern' };
      return { ok: true, argv: ['grep', GREP_FLAGS, GREP_EXCLUDE, '-e', op.pattern, '--', target] };
    default:
      return assertNever(op);
  }
}

export type ParsedFileOp =
  | { ok: true; op: FileOp }
  /** argv has a file-op shape but its path is not allowed. */
  | { ok: false; isFileOp: true; reason: string }
  | { ok: false; isFileOp: false };

/** Recognises argv produced by `fileOpArgv`, re-validating the path. Anything else is not a file op. */
export function parseFileOp(argv: readonly string[]): ParsedFileOp {
  const [cmd, ...rest] = argv;
  const last = rest.at(-1) ?? '';
  const build = (op: FileOp): ParsedFileOp => {
    const rel = fromWorkspacePath(last);
    if (!rel.ok) return { ok: false, isFileOp: true, reason: rel.reason };
    const full = { ...op, path: rel.path };
    const again = fileOpArgv(full);
    if (!again.ok) return { ok: false, isFileOp: true, reason: again.reason };
    if (!sameArgv(again.argv, argv)) {
      return { ok: false, isFileOp: true, reason: 'path is not in normalised form' };
    }
    return { ok: true, op: full };
  };
  if (cmd === 'cat' && rest.length === 2 && rest[0] === '--') return build({ op: 'read', path: '' });
  if (
    cmd === 'sh' &&
    rest.length === 4 &&
    rest[0] === '-c' &&
    rest[1] === WRITE_SCRIPT &&
    rest[2] === WRITE_ARGV0
  ) {
    return build({ op: 'write', path: '' });
  }
  if (cmd === 'ls' && rest.length === 3 && rest[0] === LS_FLAGS && rest[1] === '--') {
    return build({ op: 'list', path: '' });
  }
  const pattern = rest[3];
  if (
    cmd === 'grep' &&
    rest.length === 6 &&
    rest[0] === GREP_FLAGS &&
    rest[1] === GREP_EXCLUDE &&
    rest[2] === '-e' &&
    pattern !== undefined &&
    rest[4] === '--'
  ) {
    return build({ op: 'grep', path: '', pattern });
  }
  return { ok: false, isFileOp: false };
}

function fromWorkspacePath(p: string): PathResult {
  if (p === WORKSPACE) return { ok: true, path: '.' };
  if (!p.startsWith(`${WORKSPACE}/`)) return { ok: false, reason: `path is outside ${WORKSPACE}: ${p}` };
  return normalizeRelPath(p.slice(WORKSPACE.length + 1));
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function assertNever(x: never): never {
  throw new Error(`Unexpected file op: ${JSON.stringify(x)}`);
}
