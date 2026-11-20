// All git operations on product repositories (ARCHITECTURE §4.9). The ONLY module that runs `git`.
// Every invocation goes through util/exec with GIT_SAFETY_FLAGS first, a timeout, and an
// environment that ignores the host's global/system git config and any inherited GIT_* repo vars.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { exec as defaultExec, type ExecResult } from '../util/exec.ts';

export const GIT_SAFETY_FLAGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.file.allow=never',
] as const;

/** Author and committer of every commit the platform makes. */
export const AGENT_IDENTITY = { name: 'Vibecode Agent', email: 'agent@vibecode.local' } as const;

export const MIN_GIT_VERSION = [2, 38] as const;
const MAIN_REF = 'refs/heads/main';
const BRANCH_PREFIX = 'vibecode/';
const ZERO_OID = '0'.repeat(40);
const DEFAULT_TIMEOUT_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const README = (productId: string): string =>
  `# ${productId}\n\nThis repository is managed by Vibecode.\n`;
const PRD_PLACEHOLDER = '# Product requirements\n\nThe PRD is written in the Spec view.\n';

export type GitDeps = {
  /** Process runner; defaults to util/exec. Injected so tests can observe every invocation. */
  exec?: typeof defaultExec;
  timeoutMs?: number;
};
export type GitOptions = GitDeps & { dataDir: string };

export type Worktree = { dir: string; branch: string | null; baseSha: string };
export type AddWorktreeOptions = { detached?: boolean };
export type CommitResult = { sha: string | null; diff: string };

export interface Git {
  initRepo(productId: string): Promise<void>;
  addWorktree(
    productId: string,
    runId: string,
    ref?: string,
    o?: AddWorktreeOptions,
  ): Promise<Worktree>;
  commitAll(dir: string, message: string): Promise<CommitResult>;
  cleanWorktree(dir: string): Promise<void>;
  removeWorktree(dir: string): Promise<void>;
  pruneWorktrees(productId: string): Promise<void>;
  commitFilesOnMain(productId: string, files: Record<string, string>, msg: string): Promise<string>;
  mainSha(productId: string): Promise<string>;
  readFileAtMain(productId: string, path: string): Promise<string | null>;
}

/** Infrastructure failure of a git command. The message carries redacted stderr. */
export class GitError extends Error {
  constructor(args: readonly string[], r: ExecResult) {
    const what = r.timedOut ? 'timed out' : `failed (exit ${String(r.code ?? r.signal)})`;
    super(`git ${args.join(' ').slice(0, 300)} ${what}: ${r.stderr.trim().slice(0, 2000)}`);
    this.name = 'GitError';
  }
}

type RunOpts = { cwd?: string; input?: string; env?: Record<string, string> };
type Runner = {
  raw(args: readonly string[], o?: RunOpts): Promise<ExecResult>;
  run(args: readonly string[], o?: RunOpts): Promise<string>;
};

function runner(deps: GitDeps): Runner {
  const execFn = deps.exec ?? defaultExec;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const raw = (args: readonly string[], o: RunOpts = {}): Promise<ExecResult> =>
    execFn('git', [...GIT_SAFETY_FLAGS, ...args], {
      cwd: o.cwd,
      input: o.input,
      env: { ...gitEnv(), ...o.env },
      timeoutMs,
    });
  const run = async (args: readonly string[], o: RunOpts = {}): Promise<string> => {
    const r = await raw(args, o);
    if (r.code !== 0 || r.timedOut || r.aborted) throw new GitError(args, r);
    return r.stdout;
  };
  return { raw, run };
}

/** Isolates git from host config and from GIT_* variables inherited from a parent git process. */
function gitEnv(): Record<string, string | undefined> {
  return {
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_CONFIG: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: AGENT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: AGENT_IDENTITY.email,
    GIT_COMMITTER_NAME: AGENT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: AGENT_IDENTITY.email,
    LC_ALL: 'C',
  };
}

/** True when the host git is at least 2.38 (needed for `merge-tree --write-tree`). */
export async function gitVersionOk(deps: GitDeps = {}): Promise<boolean> {
  const r = await runner(deps).raw(['--version']);
  const m = /git version (\d+)\.(\d+)/.exec(r.stdout);
  if (r.code !== 0 || !m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return (
    major > MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor >= MIN_GIT_VERSION[1])
  );
}

function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${kind}: ${JSON.stringify(id.slice(0, 64))}`);
}

/** Repo-relative path: normalised, no `..`/`.`/empty segments, never inside `.git`. */
function assertRepoPath(path: string): void {
  const segments = path.split('/');
  const isBad =
    path === '' ||
    /[\0\n\r\\]/.test(path) ||
    segments.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git');
  if (isBad) throw new Error(`Invalid repository path: ${JSON.stringify(path.slice(0, 200))}`);
}

function assertRef(ref: string): void {
  if (ref === '' || ref.startsWith('-') || /[\0\s]/.test(ref)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(ref.slice(0, 200))}`);
  }
}

export function createGit(o: GitOptions): Git {
  const git = runner(o);
  const reposDir = resolve(o.dataDir, 'repos');
  const worktreesDir = resolve(o.dataDir, 'worktrees');
  const repoDir = (productId: string): string => {
    assertSafeId('product id', productId);
    return join(reposDir, `${productId}.git`);
  };
  const inRepo = (productId: string, args: readonly string[]): readonly string[] => [
    '--git-dir',
    repoDir(productId),
    ...args,
  ];

  const resolveCommit = async (gitDir: string, ref: string): Promise<string | null> => {
    const r = await git.raw([
      '--git-dir',
      gitDir,
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);
    return r.code === 0 ? r.stdout.trim() : null;
  };

  /** Writes `files` on top of `parent` (null: empty tree) with a throwaway index; no checkout is touched. */
  const commitFiles = async (
    gitDir: string,
    parent: string | null,
    files: Record<string, string>,
    msg: string,
  ): Promise<string> => {
    const paths = Object.keys(files);
    paths.forEach(assertRepoPath);
    const tmp = await mkdtemp(join(tmpdir(), 'vibecode-index-'));
    try {
      const env = { GIT_INDEX_FILE: join(tmp, 'index') };
      const g = (args: readonly string[], input?: string): Promise<string> =>
        git.run(['--git-dir', gitDir, ...args], input === undefined ? { env } : { env, input });
      await g(parent ? ['read-tree', parent] : ['read-tree', '--empty']);
      for (const path of paths) {
        const blob = (
          await g(['hash-object', '-w', '--no-filters', '--stdin'], files[path])
        ).trim();
        await g(['update-index', '--add', '--replace', '--cacheinfo', `100644,${blob},${path}`]);
      }
      const tree = (await g(['write-tree'])).trim();
      const sha = (
        await g(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg])
      ).trim();
      await g(['update-ref', '-m', msg, MAIN_REF, sha, parent ?? ZERO_OID]);
      return sha;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };

  const worktreeDirOf = (dir: string): string => {
    const abs = resolve(dir);
    const rel = relative(worktreesDir, abs);
    if (rel === '' || rel.startsWith('..') || rel.includes(sep)) {
      throw new Error(`Not a managed worktree directory: ${abs}`);
    }
    return abs;
  };

  return {
    async initRepo(productId) {
      const gitDir = repoDir(productId);
      if (existsSync(gitDir) && (await resolveCommit(gitDir, MAIN_REF))) return;
      await mkdir(reposDir, { recursive: true });
      await git.run(['init', '--quiet', '--bare', '--initial-branch=main', gitDir]);
      await commitFiles(
        gitDir,
        null,
        { 'README.md': README(productId), 'docs/PRD.md': PRD_PLACEHOLDER },
        'Initial commit',
      );
    },

    async addWorktree(productId, runId, ref = 'main', opts = {}) {
      assertSafeId('run id', runId);
      assertRef(ref);
      const dir = join(worktreesDir, runId);
      await mkdir(worktreesDir, { recursive: true });
      const branch = opts.detached ? null : `${BRANCH_PREFIX}${runId}`;
      const mode = branch === null ? ['--detach'] : ['-b', branch];
      await git.run(inRepo(productId, ['worktree', 'add', '--quiet', ...mode, dir, ref]));
      const baseSha = (await git.run(['rev-parse', '--verify', 'HEAD'], { cwd: dir })).trim();
      return { dir, branch, baseSha };
    },

    async commitAll(dir, message) {
      await git.run(['add', '--all'], { cwd: dir });
      const unchanged = await git.raw(['diff', '--cached', '--quiet', 'HEAD'], { cwd: dir });
      if (unchanged.code === 0) return { sha: null, diff: '' };
      if (unchanged.code !== 1) throw new GitError(['diff', '--cached', '--quiet'], unchanged);
      const diff = await git.run(['diff', '--cached', '--no-color', '--no-ext-diff', 'HEAD'], {
        cwd: dir,
      });
      await git.run(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', message], {
        cwd: dir,
      });
      const sha = (await git.run(['rev-parse', '--verify', 'HEAD'], { cwd: dir })).trim();
      return { sha, diff };
    },

    async cleanWorktree(dir) {
      await git.run(['reset', '--hard', '--quiet'], { cwd: dir });
      await git.run(['clean', '-ffdxq'], { cwd: dir });
    },

    async removeWorktree(dir) {
      const abs = worktreeDirOf(dir);
      if (!existsSync(abs)) return;
      const commonDir = (
        await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: abs })
      ).trim();
      const head = await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: abs });
      const branch = head.code === 0 ? head.stdout.trim() : null;
      await git.run(['--git-dir', commonDir, 'worktree', 'remove', '--force', '--force', abs]);
      // Only branches this module created; never main or an owner's branch.
      if (branch?.startsWith(BRANCH_PREFIX)) {
        await git.run(['--git-dir', commonDir, 'branch', '--quiet', '-D', branch]);
      }
    },

    async pruneWorktrees(productId) {
      await git.run(inRepo(productId, ['worktree', 'prune']));
    },

    async commitFilesOnMain(productId, files, msg) {
      const gitDir = repoDir(productId);
      Object.keys(files).forEach(assertRepoPath);
      const parent = await resolveCommit(gitDir, MAIN_REF);
      if (!parent) throw new Error(`Product ${productId} has no main branch`);
      return commitFiles(gitDir, parent, files, msg);
    },

    async mainSha(productId) {
      const sha = await resolveCommit(repoDir(productId), MAIN_REF);
      if (!sha) throw new Error(`Product ${productId} has no main branch`);
      return sha;
    },

    async readFileAtMain(productId, path) {
      assertRepoPath(path);
      const spec = `${MAIN_REF}:${path}`;
      const r = await git.raw(inRepo(productId, ['cat-file', 'blob', spec]));
      if (r.code === 0) return r.stdout;
      const exists = await git.raw(inRepo(productId, ['cat-file', '-e', spec]));
      if (exists.code !== 0) return null;
      throw new GitError(['cat-file', 'blob', spec], r);
    },
  };
}
