// All git operations on product repositories (ARCHITECTURE §4.9). The ONLY module that runs `git`.
// Every invocation goes through util/exec with GIT_SAFETY_FLAGS first, a timeout, and an
// environment that ignores the host's global/system git config and any inherited GIT_* repo vars.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { validateGitRemoteUrl } from '../../shared/git-remote.ts';
import { redactor } from '../security/index.ts';
import { exec as defaultExec, ExecError, type ExecResult } from '../util/exec.ts';

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
/** Shown to the owner when gitVersionOk() is false. */
export const GIT_VERSION_REQUIRED_MESSAGE = `Vibecode needs git >= ${MIN_GIT_VERSION.join('.')} on the host: install or upgrade git`;
const MAIN_REF = 'refs/heads/main';
const BRANCH_PREFIX = 'vibecode/';
const INTEGRATION_PREFIX = 'integrate-';
const ZERO_OID = '0'.repeat(40);
const DEFAULT_TIMEOUT_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const README = (productId: string): string =>
  `# ${productId}\n\nThis repository is managed by Vibecode.\n`;
const PRD_PLACEHOLDER = '# Product requirements\n\nThe PRD is written in the Spec view.\n';

/** Extra `-c` flags of `git push`: no command-running or local-path transports (defence in depth). */
export const PUSH_TRANSPORT_FLAGS = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'credential.helper=',
] as const;
/** Env var the askpass helper reads the token from; the token is never in argv, URL or config. */
const TOKEN_ENV = 'VIBECODE_GIT_TOKEN';
/** Username the askpass helper answers (GitHub/GitLab accept any user name with a token). */
const TOKEN_USERNAME = 'x-access-token';
/** The askpass helper: holds no secret, prints the env var's token for password prompts. */
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' '${TOKEN_USERNAME}' ;;
  *) printf '%s\\n' "$${TOKEN_ENV}" ;;
esac
`;
const PUSH_TIMEOUT_MS = 120_000;

export type GitDeps = {
  /** Process runner; defaults to util/exec. Injected so tests can observe every invocation. */
  exec?: typeof defaultExec;
  timeoutMs?: number;
  /** Warnings (e.g. a skipped non-repo in data/repos); default console.warn. */
  log?: (line: string) => void;
};
export type GitOptions = GitDeps & {
  dataDir: string;
  /**
   * TESTS ONLY: lets `push` reach a local path remote (skips validateGitRemoteUrl and re-allows
   * protocol.file). Never set in production; main.ts does not.
   */
  allowFileRemotes?: boolean;
};

/** Where `push` sends main: a validated URL (no credentials) and the token kept in `secrets`. */
export type PushRemote = { url: string; token: string | null };

/** Trailing options of every Git method: aborting rejects the call with a GitError. */
export type GitCallOptions = { signal?: AbortSignal | undefined };
export type Worktree = { dir: string; branch: string | null; baseSha: string };
export type AddWorktreeOptions = GitCallOptions & { detached?: boolean };
export type CommitResult = { sha: string | null; diff: string };
export type IntegrateResult =
  | { kind: 'fast'; tree: string; commitSha: string }
  | { kind: 'merged'; commitSha: string; dir: string }
  | { kind: 'conflict'; paths: string[] };

export interface Git {
  initRepo(productId: string, o?: GitCallOptions): Promise<void>;
  addWorktree(
    productId: string,
    runId: string,
    ref?: string,
    o?: AddWorktreeOptions,
  ): Promise<Worktree>;
  commitAll(dir: string, message: string, o?: GitCallOptions): Promise<CommitResult>;
  /** Paths changed between `fromRef` and HEAD of the worktree (renames as delete + add), sorted. */
  changedPaths(dir: string, fromRef: string, o?: GitCallOptions): Promise<string[]>;
  cleanWorktree(dir: string, o?: GitCallOptions): Promise<void>;
  removeWorktree(dir: string, o?: GitCallOptions): Promise<void>;
  pruneWorktrees(productId: string, o?: GitCallOptions): Promise<void>;
  /**
   * Recovery: removes every directory under data/worktrees (registered worktrees through
   * `worktree remove`, anything else from disk), prunes stale admin entries in every repo and
   * deletes leftover vibecode/* branches. main and other branches are never touched. A `<id>.git`
   * directory that is not a git repository is skipped with a logged warning.
   */
  clearWorktrees(o?: GitCallOptions): Promise<void>;
  /** Ids of the bare repos in data/repos (`<id>.git` directories with a safe id), sorted. */
  listRepos(o?: GitCallOptions): Promise<string[]>;
  /** Deletes data/repos/<productId>.git; no-op if it is gone. */
  removeRepo(productId: string, o?: GitCallOptions): Promise<void>;
  commitFilesOnMain(
    productId: string,
    files: Record<string, string>,
    msg: string,
    o?: GitCallOptions,
  ): Promise<string>;
  /**
   * Prepares ONE squash commit (parent: current main) for `branch`. Never moves main; the caller
   * re-checks `merged` results in `dir` and then calls advanceMain under the merge lock.
   */
  integrate(
    productId: string,
    branch: string,
    baseSha: string,
    message: string,
    o?: GitCallOptions,
  ): Promise<IntegrateResult>;
  /** Moves main to `commitSha` only if it still points at `expectedOld`; else MainMovedError. */
  advanceMain(
    productId: string,
    commitSha: string,
    expectedOld: string,
    o?: GitCallOptions,
  ): Promise<void>;
  mainSha(productId: string, o?: GitCallOptions): Promise<string>;
  /**
   * `path` at main, or null when main exists but has no such path. Throws GitError when the repo
   * is missing or main cannot be resolved.
   */
  readFileAtMain(productId: string, path: string, o?: GitCallOptions): Promise<string | null>;
  /**
   * `git push -- <url> refs/heads/main:refs/heads/main` (no force). The URL must pass
   * validateGitRemoteUrl (else GitError before git runs); the token reaches git only through a
   * GIT_ASKPASS helper reading an env var, and is redacted from every error.
   */
  push(productId: string, remote: PushRemote, o?: GitCallOptions): Promise<void>;
}

/** Infrastructure failure of git (failed, aborted, timed out or truncated command; missing repo). */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** A GitError for a command result; its message carries the (already redacted) stderr. */
function commandError(args: readonly string[], r: ExecResult): GitError {
  const what = r.aborted
    ? 'was aborted'
    : r.timedOut
      ? 'timed out'
      : r.truncated
        ? 'output was truncated (over the 10 MiB exec buffer)'
        : `failed (exit ${String(r.code ?? r.signal)})`;
  return new GitError(
    `git ${args.join(' ').slice(0, 300)} ${what}: ${r.stderr.trim().slice(0, 2000)}`,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GitError('git operation was aborted');
}

/** main no longer points at the commit the caller expected; integrate again on the new main. */
export class MainMovedError extends Error {
  readonly expected: string;
  readonly actual: string | null;
  constructor(productId: string, expected: string, actual: string | null) {
    super(`main of ${productId} moved: expected ${expected}, found ${String(actual)}`);
    this.name = 'MainMovedError';
    this.expected = expected;
    this.actual = actual;
  }
}

type RunOpts = {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string>;
  signal?: AbortSignal | undefined;
};
type Runner = {
  /** Any exit code; throws GitError when the command was aborted, timed out or truncated. */
  raw(args: readonly string[], o?: RunOpts): Promise<ExecResult>;
  /** stdout of a successful (exit 0) command; throws GitError otherwise. */
  run(args: readonly string[], o?: RunOpts): Promise<string>;
};

function runner(deps: GitDeps): Runner {
  const execFn = deps.exec ?? defaultExec;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const raw = async (args: readonly string[], o: RunOpts = {}): Promise<ExecResult> => {
    const r = await execFn('git', [...GIT_SAFETY_FLAGS, ...args], {
      cwd: o.cwd,
      input: o.input,
      env: { ...gitEnv(), ...o.env },
      timeoutMs: o.timeoutMs ?? timeoutMs,
      signal: o.signal,
    });
    // Never hand back partial output: an aborted, timed-out or cut-off command is a failure.
    if (r.aborted || r.timedOut || r.truncated) throw commandError(args, r);
    return r;
  };
  const run = async (args: readonly string[], o: RunOpts = {}): Promise<string> => {
    const r = await raw(args, o);
    if (r.code !== 0) throw commandError(args, r);
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

/**
 * True when the host git is at least 2.38 (needed for `merge-tree --write-tree`); false when it is
 * older, unparsable or cannot be started at all. Show GIT_VERSION_REQUIRED_MESSAGE when false.
 */
export async function gitVersionOk(deps: GitDeps = {}): Promise<boolean> {
  let r: ExecResult;
  try {
    r = await runner(deps).raw(['--version']);
  } catch (err) {
    if (err instanceof ExecError || err instanceof GitError) return false;
    throw err;
  }
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
  const log = o.log ?? ((line: string) => console.warn(line));
  const reposDir = resolve(o.dataDir, 'repos');
  const worktreesDir = resolve(o.dataDir, 'worktrees');
  // Scratch space for executables (the askpass helper): under the data dir, because hosts may
  // mount os.tmpdir() noexec.
  const scratchDir = resolve(o.dataDir, 'tmp');
  const repoDir = (productId: string): string => {
    assertSafeId('product id', productId);
    return join(reposDir, `${productId}.git`);
  };
  const inRepo = (productId: string, args: readonly string[]): readonly string[] => [
    '--git-dir',
    repoDir(productId),
    ...args,
  ];

  const resolveCommit = async (
    gitDir: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const r = await git.raw(
      ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { signal },
    );
    return r.code === 0 ? r.stdout.trim() : null;
  };

  /** Writes `files` on top of `parent` (null: empty tree) with a throwaway index; no checkout is touched. */
  const commitFiles = async (
    gitDir: string,
    parent: string | null,
    files: Record<string, string>,
    msg: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const paths = Object.keys(files);
    paths.forEach(assertRepoPath);
    throwIfAborted(signal);
    const tmp = await mkdtemp(join(tmpdir(), 'vibecode-index-'));
    try {
      const env = { GIT_INDEX_FILE: join(tmp, 'index') };
      const g = (args: readonly string[], input?: string): Promise<string> =>
        git.run(
          ['--git-dir', gitDir, ...args],
          input === undefined ? { env, signal } : { env, input, signal },
        );
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

  const requireCommit = async (
    gitDir: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    assertRef(ref);
    const sha = await resolveCommit(gitDir, ref, signal);
    if (!sha) throw new Error(`Unknown commit: ${JSON.stringify(ref.slice(0, 200))}`);
    return sha;
  };

  /** Deletes whatever is at a managed worktree path: a registered worktree (and its branch) or plain files. */
  const discardDir = async (dir: string, signal?: AbortSignal): Promise<void> => {
    if (!existsSync(dir)) return;
    try {
      await api.removeWorktree(dir, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      // Not a working git worktree (half-created, or its repo is gone): delete it from disk;
      // `worktree prune` drops any admin entry it left in the repo.
    }
    await rm(dir, { recursive: true, force: true });
  };

  const isRepo = async (gitDir: string, signal?: AbortSignal): Promise<boolean> => {
    const r = await git.raw(['--git-dir', gitDir, 'rev-parse', '--is-bare-repository'], {
      signal,
    });
    return r.code === 0;
  };

  const api: Git = {
    async initRepo(productId, opts = {}) {
      const { signal } = opts;
      const gitDir = repoDir(productId);
      if (existsSync(gitDir) && (await resolveCommit(gitDir, MAIN_REF, signal))) return;
      throwIfAborted(signal);
      await mkdir(reposDir, { recursive: true });
      await git.run(['init', '--quiet', '--bare', '--initial-branch=main', gitDir], { signal });
      await commitFiles(
        gitDir,
        null,
        { 'README.md': README(productId), 'docs/PRD.md': PRD_PLACEHOLDER },
        'Initial commit',
        signal,
      );
    },

    async addWorktree(productId, runId, ref = 'main', opts = {}) {
      const { signal } = opts;
      assertSafeId('run id', runId);
      assertRef(ref);
      const gitDir = repoDir(productId);
      const dir = join(worktreesDir, runId);
      const branch = opts.detached ? null : `${BRANCH_PREFIX}${runId}`;
      throwIfAborted(signal);
      await mkdir(worktreesDir, { recursive: true });
      // Idempotent: a worktree or branch left behind by a crashed run is discarded first.
      await discardDir(dir, signal);
      await git.run(['--git-dir', gitDir, 'worktree', 'prune'], { signal });
      if (branch !== null && (await resolveCommit(gitDir, `refs/heads/${branch}`, signal))) {
        await git.run(['--git-dir', gitDir, 'branch', '--quiet', '-D', branch], { signal });
      }
      const mode = branch === null ? ['--detach'] : ['-b', branch];
      await git.run(['--git-dir', gitDir, 'worktree', 'add', '--quiet', ...mode, dir, ref], {
        signal,
      });
      const baseSha = (
        await git.run(['rev-parse', '--verify', 'HEAD'], { cwd: dir, signal })
      ).trim();
      return { dir, branch, baseSha };
    },

    async commitAll(dir, message, opts = {}) {
      const run = { cwd: dir, signal: opts.signal };
      await git.run(['add', '--all'], run);
      const unchangedArgs = ['diff', '--cached', '--quiet', 'HEAD'];
      const unchanged = await git.raw(unchangedArgs, run);
      if (unchanged.code === 0) return { sha: null, diff: '' };
      if (unchanged.code !== 1) throw commandError(unchangedArgs, unchanged);
      const diff = await git.run(['diff', '--cached', '--no-color', '--no-ext-diff', 'HEAD'], run);
      await git.run(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', message], run);
      const sha = (await git.run(['rev-parse', '--verify', 'HEAD'], run)).trim();
      return { sha, diff };
    },

    async changedPaths(dir, fromRef, opts = {}) {
      assertRef(fromRef);
      const out = await git.run(
        ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', fromRef, 'HEAD', '--'],
        { cwd: dir, signal: opts.signal },
      );
      return [...new Set(out.split('\0').filter((p) => p !== ''))].sort();
    },

    async cleanWorktree(dir, opts = {}) {
      const run = { cwd: dir, signal: opts.signal };
      await git.run(['reset', '--hard', '--quiet'], run);
      await git.run(['clean', '-ffdxq'], run);
    },

    async removeWorktree(dir, opts = {}) {
      const { signal } = opts;
      const abs = worktreeDirOf(dir);
      throwIfAborted(signal);
      if (!existsSync(abs)) return;
      const commonDir = (
        await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
          cwd: abs,
          signal,
        })
      ).trim();
      const head = await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: abs,
        signal,
      });
      const branch = head.code === 0 ? head.stdout.trim() : null;
      await git.run(['--git-dir', commonDir, 'worktree', 'remove', '--force', '--force', abs], {
        signal,
      });
      // Only branches this module created; never main or an owner's branch.
      if (branch?.startsWith(BRANCH_PREFIX)) {
        await git.run(['--git-dir', commonDir, 'branch', '--quiet', '-D', branch], { signal });
      }
    },

    async pruneWorktrees(productId, opts = {}) {
      await git.run(inRepo(productId, ['worktree', 'prune']), { signal: opts.signal });
    },

    async clearWorktrees(opts = {}) {
      const { signal } = opts;
      throwIfAborted(signal);
      const entries = existsSync(worktreesDir) ? await readdir(worktreesDir) : [];
      for (const name of entries) await discardDir(join(worktreesDir, name), signal);
      for (const productId of await api.listRepos({ signal })) {
        if (!(await isRepo(repoDir(productId), signal))) {
          log(`git: skipping ${repoDir(productId)}: not a git repository`);
          continue;
        }
        await api.pruneWorktrees(productId, { signal });
        const refs = await git.run(
          inRepo(productId, [
            'for-each-ref',
            '--format=%(refname:short)',
            `refs/heads/${BRANCH_PREFIX}`,
          ]),
          { signal },
        );
        for (const branch of refs.split('\n').filter((b) => b.startsWith(BRANCH_PREFIX))) {
          await git.run(inRepo(productId, ['branch', '--quiet', '-D', branch]), { signal });
        }
      }
    },

    async listRepos(opts = {}) {
      throwIfAborted(opts.signal);
      if (!existsSync(reposDir)) return [];
      const entries = await readdir(reposDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && e.name.endsWith('.git'))
        .map((e) => e.name.slice(0, -'.git'.length))
        .filter((id) => SAFE_ID.test(id))
        .sort();
    },

    async removeRepo(productId, opts = {}) {
      const gitDir = repoDir(productId);
      throwIfAborted(opts.signal);
      await rm(gitDir, { recursive: true, force: true });
    },

    async commitFilesOnMain(productId, files, msg, opts = {}) {
      const gitDir = repoDir(productId);
      Object.keys(files).forEach(assertRepoPath);
      const parent = await resolveCommit(gitDir, MAIN_REF, opts.signal);
      if (!parent) throw new Error(`Product ${productId} has no main branch`);
      return commitFiles(gitDir, parent, files, msg, opts.signal);
    },

    async mainSha(productId, opts = {}) {
      const sha = await resolveCommit(repoDir(productId), MAIN_REF, opts.signal);
      if (!sha) throw new Error(`Product ${productId} has no main branch`);
      return sha;
    },

    async readFileAtMain(productId, path, opts = {}) {
      const { signal } = opts;
      assertRepoPath(path);
      const gitDir = repoDir(productId);
      if (!existsSync(gitDir)) throw new GitError(`Product ${productId} has no repository`);
      const main = await resolveCommit(gitDir, MAIN_REF, signal);
      if (!main) throw new GitError(`Product ${productId}: main cannot be resolved`);
      const spec = `${main}:${path}`;
      const r = await git.raw(['--git-dir', gitDir, 'cat-file', 'blob', spec], { signal });
      if (r.code === 0) return r.stdout;
      const exists = await git.raw(['--git-dir', gitDir, 'cat-file', '-e', spec], { signal });
      if (exists.code !== 0) return null;
      throw commandError(['cat-file', 'blob', spec], r);
    },

    async integrate(productId, branch, baseSha, message, opts = {}) {
      const { signal } = opts;
      const gitDir = repoDir(productId);
      const main = await api.mainSha(productId, { signal });
      const head = await requireCommit(gitDir, branch, signal);
      const base = await requireCommit(gitDir, baseSha, signal);
      const squash = (tree: string): Promise<string> =>
        git
          .run(['--git-dir', gitDir, 'commit-tree', tree, '-p', main, '-m', message], { signal })
          .then((out) => out.trim());

      if (main === base) {
        const tree = (
          await git.run(['--git-dir', gitDir, 'rev-parse', `${head}^{tree}`], { signal })
        ).trim();
        return { kind: 'fast', tree, commitSha: await squash(tree) };
      }

      // Squash commits keep the attempt's base in main's ancestry, so the natural merge base is baseSha.
      const args = ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', main, head];
      const r = await git.raw(['--git-dir', gitDir, ...args], { signal });
      if (r.code !== 0 && r.code !== 1) throw commandError(args, r);
      const [tree = '', ...rest] = r.stdout.split('\0');
      if (r.code === 1) {
        const paths = [...new Set(rest.filter((p) => p !== ''))].sort();
        return { kind: 'conflict', paths };
      }
      const commitSha = await squash(tree);
      // addWorktree discards a leftover integration worktree for the same commit.
      const wt = await api.addWorktree(productId, `${INTEGRATION_PREFIX}${commitSha}`, commitSha, {
        detached: true,
        signal,
      });
      return { kind: 'merged', commitSha, dir: wt.dir };
    },

    async push(productId, remote, opts = {}) {
      const { signal } = opts;
      const gitDir = repoDir(productId);
      if (!o.allowFileRemotes) {
        const valid = validateGitRemoteUrl(remote.url);
        if (!valid.ok) throw new GitError(`Refusing to push to the remote: ${valid.reason}`);
      }
      if (remote.token !== null) redactor.register(remote.token);
      throwIfAborted(signal);
      await mkdir(scratchDir, { recursive: true, mode: 0o700 });
      const tmp = await mkdtemp(join(scratchDir, 'askpass-')); // mkdtemp creates it 0o700
      try {
        const askpass = join(tmp, 'askpass.sh');
        await writeFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
        const args = [
          ...PUSH_TRANSPORT_FLAGS,
          ...(o.allowFileRemotes ? ['-c', 'protocol.file.allow=always'] : []),
          '--git-dir',
          gitDir,
          'push',
          '--porcelain',
          '--',
          remote.url,
          `${MAIN_REF}:${MAIN_REF}`,
        ];
        const env: Record<string, string> = {
          GIT_ASKPASS: askpass,
          [TOKEN_ENV]: remote.token ?? '',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        };
        let r: ExecResult;
        try {
          r = await git.raw(args, { env, signal, timeoutMs: PUSH_TIMEOUT_MS });
        } catch (err) {
          throw new GitError(redactor.redact(err instanceof Error ? err.message : String(err)));
        }
        if (r.code !== 0) throw new GitError(redactor.redact(commandError(args, r).message));
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },

    async advanceMain(productId, commitSha, expectedOld, opts = {}) {
      const { signal } = opts;
      const gitDir = repoDir(productId);
      const sha = await requireCommit(gitDir, commitSha, signal);
      assertRef(expectedOld);
      const args = ['update-ref', '-m', `advance main to ${sha}`, MAIN_REF, sha, expectedOld];
      const r = await git.raw(['--git-dir', gitDir, ...args], { signal });
      if (r.code === 0) return;
      const actual = await resolveCommit(gitDir, MAIN_REF, signal);
      if (actual !== expectedOld) throw new MainMovedError(productId, expectedOld, actual);
      throw commandError(args, r);
    },
  };
  return api;
}
