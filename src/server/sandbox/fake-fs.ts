// Applies file ops (file-ops.ts protocol) directly to a worktree for FakeContainerRuntime.
// Confinement: every path is resolved with realpath and must stay inside the worktree and outside
// `.git`; symlinks that escape, point into `.git` or dangle are refused. Grep never follows symlinks
// it meets while recursing (like `grep -r`).
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileOp } from './file-ops.ts';
import { toWorkspacePath } from './file-ops.ts';

export type FsResult = { code: number; stdout: string; stderr: string };

type Confined = { ok: true; real: string; exists: boolean } | { ok: false; reason: string };

export async function applyFileOp(
  worktree: string,
  op: FileOp,
  o: { stdin: string | undefined; readOnly: boolean },
): Promise<FsResult> {
  const root = await realpath(worktree);
  const shown = toWorkspacePath(op.path);
  if (op.op === 'write' && o.readOnly) return fail(1, `sh: ${shown}: Read-only file system`);
  const c = await confine(root, op.path);
  if (!c.ok) return fail(2, `vibecode: ${shown}: ${c.reason}`);
  try {
    return await apply(c, op, shown, o.stdin);
  } catch (err) {
    // Filesystem errors (ENOTDIR, EISDIR, EACCES…) become a failed command, as in a container.
    const code = err instanceof Error && 'code' in err ? String(err.code) : undefined;
    if (code === undefined) throw err;
    return fail(1, `${op.op}: ${shown}: ${code}`);
  }
}

async function apply(
  c: Confined & { ok: true },
  op: FileOp,
  shown: string,
  stdin: string | undefined,
): Promise<FsResult> {
  switch (op.op) {
    case 'read':
      return read(c, shown);
    case 'write':
      await mkdir(path.dirname(c.real), { recursive: true });
      await writeFile(c.real, stdin ?? '');
      return ok('');
    case 'list':
      return list(c, shown);
    case 'grep':
      return grep(c, shown, op.pattern);
  }
}

/**
 * Resolves `rel` under `root`: the deepest existing ancestor is realpath'd and must stay inside
 * `root` and outside `.git`; the missing remainder is appended (it cannot contain symlinks).
 */
async function confine(root: string, rel: string): Promise<Confined> {
  const target = path.join(root, rel);
  let existing = target;
  while (!(await exists(existing))) existing = path.dirname(existing);
  let real: string;
  try {
    real = await realpath(existing);
  } catch (err) {
    if (isNotFound(err)) return { ok: false, reason: 'refusing to follow a dangling symlink' };
    throw err;
  }
  const inside = path.relative(root, real);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    return { ok: false, reason: 'refusing to follow a symlink out of the workspace' };
  }
  if (inside.split(path.sep).some((s) => s.toLowerCase() === '.git')) {
    return { ok: false, reason: '.git is not accessible' };
  }
  return {
    ok: true,
    real: path.join(real, path.relative(existing, target)),
    exists: existing === target,
  };
}

async function read(c: Confined & { ok: true }, shown: string): Promise<FsResult> {
  if (!c.exists) return fail(1, `cat: ${shown}: No such file or directory`);
  if ((await stat(c.real)).isDirectory()) return fail(1, `cat: ${shown}: Is a directory`);
  return ok(await readFile(c.real, 'utf8'));
}

async function list(c: Confined & { ok: true }, shown: string): Promise<FsResult> {
  if (!c.exists) return fail(2, `ls: cannot access '${shown}': No such file or directory`);
  if (!(await stat(c.real)).isDirectory()) return ok(`${shown}\n`);
  const entries = (await readdir(c.real, { withFileTypes: true }))
    .filter((e) => e.name.toLowerCase() !== '.git')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  return ok(entries.map((e) => `${e}\n`).join(''));
}

async function grep(c: Confined & { ok: true }, shown: string, pattern: string): Promise<FsResult> {
  if (!c.exists) return fail(2, `grep: ${shown}: No such file or directory`);
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return fail(2, `grep: invalid regular expression: ${pattern}`);
  }
  const out: string[] = [];
  await grepWalk(c.real, shown, re, out);
  return { code: out.length > 0 ? 0 : 1, stdout: out.join(''), stderr: '' };
}

async function grepWalk(real: string, shown: string, re: RegExp, out: string[]): Promise<void> {
  if ((await stat(real)).isDirectory()) {
    const entries = (await readdir(real, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.toLowerCase() === '.git') continue;
      if (e.isDirectory() || e.isFile()) {
        await grepWalk(path.join(real, e.name), `${shown}/${e.name}`, re, out);
      }
    }
    return;
  }
  const buf = await readFile(real);
  if (buf.includes(0)) return; // -I: skip binary files
  const lines = buf.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, i) => {
    if (re.test(line)) out.push(`${shown}:${String(i + 1)}:${line}\n`);
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

function ok(stdout: string): FsResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(code: number, stderr: string): FsResult {
  return { code, stdout: '', stderr: `${stderr}\n` };
}
