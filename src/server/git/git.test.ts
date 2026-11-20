import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../util/exec.ts';
import { AGENT_IDENTITY, GIT_SAFETY_FLAGS, createGit, gitVersionOk, type Git } from './index.ts';

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
    await git.cleanWorktree(wt.dir);
    await git.commitFilesOnMain('p1', { 'docs/PRD.md': '# PRD\n' }, 'prd');
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
