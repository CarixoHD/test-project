import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../util/exec.ts';
import {
  AGENT_IDENTITY,
  GIT_SAFETY_FLAGS,
  MainMovedError,
  createGit,
  gitVersionOk,
  type Git,
} from './index.ts';

type Call = { cmd: string; argv: readonly string[] };

let dataDir: string;
let calls: Call[];
let git: Git;

/** Records every process the git module starts, then runs it for real. */
const recordingExec: typeof exec = (cmd, argv, o) => {
  calls.push({ cmd, argv: [...argv] });
  return exec(cmd, argv, o);
};

/** Raw git for assertions, deliberately outside the module under test. */
async function rawGit(args: string[], cwd?: string): Promise<string> {
  const r = await exec('git', args, { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const repoOf = (productId: string): string => join(dataDir, 'repos', `${productId}.git`);
const commitCount = (productId: string): Promise<string> =>
  rawGit(['--git-dir', repoOf(productId), 'rev-list', '--count', 'main']);

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'vibecode-git-')));
  calls = [];
  git = createGit({ dataDir, exec: recordingExec });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('safety flags', () => {
  it('passes the three -c safety flags first on every git invocation', async () => {
    await git.initRepo('p1');
    const wt = await git.addWorktree('p1', 'r1');
    await writeFile(join(wt.dir, 'a.txt'), 'a\n');
    await git.commitAll(wt.dir, 'add a');
    await git.changedPaths(wt.dir, wt.baseSha);
    await git.cleanWorktree(wt.dir);
    if (wt.branch === null) throw new Error('expected a branch');
    const fast = await git.integrate('p1', wt.branch, wt.baseSha, '#1 A');
    await git.commitFilesOnMain('p1', { 'docs/PRD.md': '# PRD\n' }, 'prd');
    const merged = await git.integrate('p1', wt.branch, wt.baseSha, '#1 A');
    if (merged.kind === 'merged') await git.removeWorktree(merged.dir);
    if (fast.kind !== 'fast') throw new Error('expected fast');
    await expect(git.advanceMain('p1', fast.commitSha, wt.baseSha)).rejects.toThrow(MainMovedError);
    await git.readFileAtMain('p1', 'README.md');
    await git.readFileAtMain('p1', 'missing.md');
    await git.mainSha('p1');
    await git.removeWorktree(wt.dir);
    await git.pruneWorktrees('p1');
    await gitVersionOk({ exec: recordingExec });

    expect(GIT_SAFETY_FLAGS).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.file.allow=never',
    ]);
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) {
      expect(call.cmd).toBe('git');
      expect(call.argv.slice(0, GIT_SAFETY_FLAGS.length)).toEqual(GIT_SAFETY_FLAGS);
    }
  });
});

describe('gitVersionOk', () => {
  it('accepts the installed git (>= 2.38)', async () => {
    expect(await gitVersionOk()).toBe(true);
  });

  it('rejects versions older than 2.38 and unparsable output', async () => {
    const fakeVersion =
      (stdout: string): typeof exec =>
      () =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout,
          stderr: '',
          timedOut: false,
          aborted: false,
          truncated: false,
        });
    expect(await gitVersionOk({ exec: fakeVersion('git version 2.37.9\n') })).toBe(false);
    expect(await gitVersionOk({ exec: fakeVersion('git version 1.99.0\n') })).toBe(false);
    expect(await gitVersionOk({ exec: fakeVersion('git version 2.38.0\n') })).toBe(true);
    expect(await gitVersionOk({ exec: fakeVersion('git version 3.0.1.windows.1\n') })).toBe(true);
    expect(await gitVersionOk({ exec: fakeVersion('nonsense') })).toBe(false);
  });
});

describe('initRepo', () => {
  it('creates a bare repo whose main has README.md and docs/PRD.md in one commit', async () => {
    await git.initRepo('p1');

    expect(await rawGit(['--git-dir', repoOf('p1'), 'rev-parse', '--is-bare-repository'])).toBe(
      'true',
    );
    const files = await rawGit(['--git-dir', repoOf('p1'), 'ls-tree', '-r', '--name-only', 'main']);
    expect(files.split('\n').sort()).toEqual(['README.md', 'docs/PRD.md']);
    expect(await commitCount('p1')).toBe('1');
    expect(await git.readFileAtMain('p1', 'README.md')).toContain('#');
    expect(await git.readFileAtMain('p1', 'docs/PRD.md')).not.toBeNull();
  });

  it('commits with the fixed agent identity', async () => {
    await git.initRepo('p1');
    const author = await rawGit(['--git-dir', repoOf('p1'), 'log', '-1', '--format=%an <%ae>']);
    expect(author).toBe(`${AGENT_IDENTITY.name} <${AGENT_IDENTITY.email}>`);
  });

  it('is a no-op when the repo already exists', async () => {
    await git.initRepo('p1');
    const sha = await git.mainSha('p1');
    await git.initRepo('p1');
    expect(await git.mainSha('p1')).toBe(sha);
  });

  it('rejects product ids that are not safe path segments', async () => {
    await expect(git.initRepo('../evil')).rejects.toThrow(/invalid/i);
    await expect(git.initRepo('')).rejects.toThrow(/invalid/i);
  });
});

describe('worktrees', () => {
  beforeEach(async () => {
    await git.initRepo('p1');
  });

  it('adds a worktree on a new branch at main under data/worktrees/<runId>', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    expect(wt.dir).toBe(join(dataDir, 'worktrees', 'r1'));
    expect(wt.baseSha).toBe(await git.mainSha('p1'));
    expect(wt.branch).toBeTypeOf('string');
    expect(await rawGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.dir)).toBe(wt.branch);
    expect(await readFile(join(wt.dir, 'README.md'), 'utf8')).toContain('#');
  });

  it('adds a detached worktree without a branch for previews', async () => {
    const wt = await git.addWorktree('p1', 'r2', 'main', { detached: true });
    expect(wt.branch).toBeNull();
    expect(await rawGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.dir)).toBe('HEAD');
    expect(wt.baseSha).toBe(await git.mainSha('p1'));
  });

  it('rejects unsafe run ids', async () => {
    await expect(git.addWorktree('p1', '../x')).rejects.toThrow(/invalid/i);
  });

  it('commitAll returns sha=null and an empty diff for an unchanged worktree', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    expect(await git.commitAll(wt.dir, 'nothing')).toEqual({ sha: null, diff: '' });
  });

  it('commitAll commits every change (incl. untracked and deletions) and returns the diff', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    await writeFile(join(wt.dir, 'new.txt'), 'hello\n');
    await rm(join(wt.dir, 'README.md'));

    const { sha, diff } = await git.commitAll(wt.dir, 'work');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await rawGit(['rev-parse', 'HEAD'], wt.dir)).toBe(sha);
    expect(await rawGit(['status', '--porcelain'], wt.dir)).toBe('');
    expect(diff).toContain('+++ b/new.txt');
    expect(diff).toContain('+hello');
    expect(diff).toContain('--- a/README.md');
    expect(await rawGit(['log', '-1', '--format=%an <%ae>|%cn|%s'], wt.dir)).toBe(
      `${AGENT_IDENTITY.name} <${AGENT_IDENTITY.email}>|${AGENT_IDENTITY.name}|work`,
    );
    // main is untouched by worktree commits
    expect(await git.mainSha('p1')).toBe(wt.baseSha);
  });

  it('changedPaths lists every path changed since a commit, both sides of renames, sorted', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    await mkdir(join(wt.dir, 'a dir'), { recursive: true });
    await writeFile(join(wt.dir, 'a dir', 'new file.txt'), 'hello\n');
    await rawGit(['mv', 'docs/PRD.md', 'docs/SPEC.md'], wt.dir);
    await rm(join(wt.dir, 'README.md'));
    await git.commitAll(wt.dir, 'one');
    await writeFile(join(wt.dir, 'Dockerfile'), 'FROM debian\n');
    await git.commitAll(wt.dir, 'two');

    expect(await git.changedPaths(wt.dir, wt.baseSha)).toEqual([
      'Dockerfile',
      'README.md',
      'a dir/new file.txt',
      'docs/PRD.md',
      'docs/SPEC.md',
    ]);
    expect(await git.changedPaths(wt.dir, 'HEAD')).toEqual([]);
  });

  it('cleanWorktree resets tracked changes and removes untracked and ignored files', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    await writeFile(join(wt.dir, '.gitignore'), 'build/\n');
    await git.commitAll(wt.dir, 'ignore build');
    await writeFile(join(wt.dir, 'README.md'), 'changed\n');
    await writeFile(join(wt.dir, 'junk.txt'), 'x');
    await writeFile(join(wt.dir, 'ignored.log'), 'x');
    await rm(join(wt.dir, 'docs'), { recursive: true });

    await git.cleanWorktree(wt.dir);

    expect(await rawGit(['status', '--porcelain', '--ignored'], wt.dir)).toBe('');
    expect(existsSync(join(wt.dir, 'docs', 'PRD.md'))).toBe(true);
  });

  it('removeWorktree deletes the directory and its branch', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    await writeFile(join(wt.dir, 'x.txt'), 'x');
    await git.commitAll(wt.dir, 'x');

    await git.removeWorktree(wt.dir);

    expect(existsSync(wt.dir)).toBe(false);
    const branches = await rawGit(['--git-dir', repoOf('p1'), 'branch', '--list']);
    expect(branches).not.toContain(wt.branch);
    expect(await rawGit(['--git-dir', repoOf('p1'), 'worktree', 'list'])).not.toContain(wt.dir);
  });

  it('removeWorktree handles detached worktrees and missing directories', async () => {
    const wt = await git.addWorktree('p1', 'r1', 'main', { detached: true });
    await git.removeWorktree(wt.dir);
    expect(existsSync(wt.dir)).toBe(false);
    await expect(git.removeWorktree(wt.dir)).resolves.toBeUndefined();
  });

  it('pruneWorktrees forgets worktrees whose directory was deleted', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    await rm(wt.dir, { recursive: true, force: true });
    expect(await rawGit(['--git-dir', repoOf('p1'), 'worktree', 'list'])).toContain('r1');

    await git.pruneWorktrees('p1');

    expect(await rawGit(['--git-dir', repoOf('p1'), 'worktree', 'list'])).not.toContain('r1');
  });
});

describe('commitFilesOnMain', () => {
  beforeEach(async () => {
    await git.initRepo('p1');
  });

  it('advances main by exactly one commit containing the files', async () => {
    const before = await git.mainSha('p1');

    const sha = await git.commitFilesOnMain(
      'p1',
      { 'docs/PRD.md': '# Real PRD\n', 'notes/a/b.md': 'deep\n' },
      'Apply PRD',
    );

    expect(await git.mainSha('p1')).toBe(sha);
    expect(await commitCount('p1')).toBe('2');
    expect(await rawGit(['--git-dir', repoOf('p1'), 'rev-parse', `${sha}^`])).toBe(before);
    expect(await rawGit(['--git-dir', repoOf('p1'), 'log', '-1', '--format=%s', sha])).toBe(
      'Apply PRD',
    );
    expect(await git.readFileAtMain('p1', 'docs/PRD.md')).toBe('# Real PRD\n');
    expect(await git.readFileAtMain('p1', 'notes/a/b.md')).toBe('deep\n');
    expect(await git.readFileAtMain('p1', 'README.md')).not.toBeNull();
  });

  it('does not touch an existing worktree checkout', async () => {
    const wt = await git.addWorktree('p1', 'r1');
    await writeFile(join(wt.dir, 'local.txt'), 'uncommitted');

    await git.commitFilesOnMain('p1', { 'docs/PRD.md': 'new\n' }, 'prd');

    expect(await readFile(join(wt.dir, 'docs', 'PRD.md'), 'utf8')).not.toBe('new\n');
    expect(await rawGit(['status', '--porcelain'], wt.dir)).toBe('?? local.txt');
    expect(await rawGit(['rev-parse', 'HEAD'], wt.dir)).toBe(wt.baseSha);
  });

  it('rejects paths that escape the repo or touch .git', async () => {
    for (const bad of ['../x', '/abs', 'a/../../x', '.git/config', 'a/.git/x', '', 'a//b']) {
      await expect(git.commitFilesOnMain('p1', { [bad]: 'x' }, 'm')).rejects.toThrow(/path/i);
    }
    expect(await commitCount('p1')).toBe('1');
  });
});

describe('readFileAtMain', () => {
  it('returns null for a missing file', async () => {
    await git.initRepo('p1');
    expect(await git.readFileAtMain('p1', 'nope.txt')).toBeNull();
  });
});

describe('integrate and advanceMain', () => {
  beforeEach(async () => {
    await git.initRepo('p1');
  });

  /** Simulates an attempt: a worktree on its own branch with `files` written and committed. */
  async function attempt(
    runId: string,
    files: Record<string, string>,
  ): Promise<{ branch: string; baseSha: string; dir: string }> {
    const wt = await git.addWorktree('p1', runId);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(wt.dir, path)), { recursive: true });
      await writeFile(join(wt.dir, path), content);
    }
    await git.commitAll(wt.dir, `work ${runId}`);
    if (wt.branch === null) throw new Error('expected a branch');
    return { branch: wt.branch, baseSha: wt.baseSha, dir: wt.dir };
  }
  const subjects = async (): Promise<string[]> =>
    (await rawGit(['--git-dir', repoOf('p1'), 'log', '--format=%s', 'main'])).split('\n');

  it('fast path: main == baseSha gives one commit with the attempt tree on top of main', async () => {
    const a = await attempt('r1', { 'a.txt': 'a\n' });
    await writeFile(join(a.dir, 'b.txt'), 'b\n');
    await git.commitAll(a.dir, 'second commit on the branch');

    const r = await git.integrate('p1', a.branch, a.baseSha, '#1 Add a');

    expect(r.kind).toBe('fast');
    if (r.kind !== 'fast') return;
    expect(r.tree).toBe(
      await rawGit(['--git-dir', repoOf('p1'), 'rev-parse', `${a.branch}^{tree}`]),
    );
    expect(await rawGit(['--git-dir', repoOf('p1'), 'rev-parse', `${r.commitSha}^{tree}`])).toBe(
      r.tree,
    );
    expect(await rawGit(['--git-dir', repoOf('p1'), 'rev-parse', `${r.commitSha}^`])).toBe(
      a.baseSha,
    );
    // integrate never moves main by itself
    expect(await git.mainSha('p1')).toBe(a.baseSha);

    await git.advanceMain('p1', r.commitSha, a.baseSha);
    expect(await git.mainSha('p1')).toBe(r.commitSha);
    expect(await subjects()).toEqual(['#1 Add a', 'Initial commit']);
    expect(await git.readFileAtMain('p1', 'b.txt')).toBe('b\n');
  });

  it('clean concurrent merge: returns a merged commit on main and a worktree checked out at it', async () => {
    const a = await attempt('r1', { 'a.txt': 'a\n' });
    const b = await attempt('r2', { 'src/b.txt': 'b\n' });
    const ra = await git.integrate('p1', a.branch, a.baseSha, '#1 Add a');
    if (ra.kind !== 'fast') throw new Error(`expected fast, got ${ra.kind}`);
    await git.advanceMain('p1', ra.commitSha, a.baseSha);
    const mainBefore = await git.mainSha('p1');

    const rb = await git.integrate('p1', b.branch, b.baseSha, '#2 Add b');

    expect(rb.kind).toBe('merged');
    if (rb.kind !== 'merged') return;
    expect(await rawGit(['--git-dir', repoOf('p1'), 'rev-parse', `${rb.commitSha}^`])).toBe(
      mainBefore,
    );
    expect(await rawGit(['rev-parse', 'HEAD'], rb.dir)).toBe(rb.commitSha);
    expect(await readFile(join(rb.dir, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(join(rb.dir, 'src', 'b.txt'), 'utf8')).toBe('b\n');
    expect(rb.dir.startsWith(join(dataDir, 'worktrees'))).toBe(true);
    expect(await git.mainSha('p1')).toBe(mainBefore);

    await git.advanceMain('p1', rb.commitSha, mainBefore);
    await git.removeWorktree(rb.dir);
    expect(existsSync(rb.dir)).toBe(false);
    expect(await git.readFileAtMain('p1', 'src/b.txt')).toBe('b\n');
  });

  it('conflict: reports the conflicting paths and leaves main alone', async () => {
    const a = await attempt('r1', { 'README.md': 'from a\n', 'same.txt': 'x\n' });
    const b = await attempt('r2', { 'README.md': 'from b\n', 'docs/PRD.md': 'b prd\n' });
    const ra = await git.integrate('p1', a.branch, a.baseSha, '#1 A');
    if (ra.kind !== 'fast') throw new Error(`expected fast, got ${ra.kind}`);
    await git.advanceMain('p1', ra.commitSha, a.baseSha);

    const rb = await git.integrate('p1', b.branch, b.baseSha, '#2 B');

    expect(rb).toEqual({ kind: 'conflict', paths: ['README.md'] });
    expect(await git.mainSha('p1')).toBe(ra.commitSha);
  });

  it('advanceMain refuses with MainMovedError when main moved since expectedOld', async () => {
    const a = await attempt('r1', { 'a.txt': 'a\n' });
    const r = await git.integrate('p1', a.branch, a.baseSha, '#1 A');
    if (r.kind !== 'fast') throw new Error(`expected fast, got ${r.kind}`);
    const moved = await git.commitFilesOnMain('p1', { 'docs/PRD.md': 'new\n' }, 'prd');

    const err = await git.advanceMain('p1', r.commitSha, a.baseSha).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MainMovedError);
    expect(await git.mainSha('p1')).toBe(moved);
  });

  it('history has exactly one commit per merged issue with message "#<n> <title>"', async () => {
    const attempts = [
      await attempt('r1', { 'one.txt': '1\n' }),
      await attempt('r2', { 'two.txt': '2\n' }),
      await attempt('r3', { 'three.txt': '3\n' }),
    ];
    for (const [i, a] of attempts.entries()) {
      await writeFile(join(a.dir, `extra-${String(i)}.txt`), 'more\n');
      await git.commitAll(a.dir, 'another branch commit');
    }
    const titles = ['One', 'Two', 'Three'];
    for (const [i, a] of attempts.entries()) {
      const old = await git.mainSha('p1');
      const r = await git.integrate('p1', a.branch, a.baseSha, `#${String(i + 1)} ${titles[i]}`);
      if (r.kind === 'conflict') throw new Error('unexpected conflict');
      await git.advanceMain('p1', r.commitSha, old);
      if (r.kind === 'merged') await git.removeWorktree(r.dir);
    }

    expect(await subjects()).toEqual(['#3 Three', '#2 Two', '#1 One', 'Initial commit']);
    expect(await commitCount('p1')).toBe('4');
    const merges = await rawGit(['--git-dir', repoOf('p1'), 'rev-list', '--merges', 'main']);
    expect(merges).toBe('');
    for (const f of ['one.txt', 'two.txt', 'three.txt', 'extra-0.txt', 'extra-2.txt']) {
      expect(await git.readFileAtMain('p1', f)).not.toBeNull();
    }
  });
});
