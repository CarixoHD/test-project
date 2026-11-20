import { readdir, readFile, realpath, rm, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec, type ExecOptions, type ExecResult } from '../util/exec.ts';
import { createGit, GitError, type Git } from './index.ts';

// git.push (ARCHITECTURE §4.9). A local bare "remote" is reached over a file path, which
// GIT_SAFETY_FLAGS block (protocol.file.allow=never); the test-only `allowFileRemotes` option
// re-allows exactly that transport. Everything else uses a recording or fake exec.

const TOKEN = 'ghp_PushTokenSecret1234567890';

type Call = { argv: readonly string[]; env: ExecOptions['env'] };

let dataDir: string;
let calls: Call[];

async function rawGit(args: string[]): Promise<string> {
  const r = await exec('git', args, { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const repoOf = (productId: string): string => join(dataDir, 'repos', `${productId}.git`);

const recordingExec: typeof exec = (cmd, argv, o) => {
  calls.push({ argv: [...argv], env: o.env });
  return exec(cmd, argv, o);
};

async function bareRemote(): Promise<string> {
  const dir = join(dataDir, 'remote.git');
  await rawGit(['init', '--quiet', '--bare', dir]);
  return dir;
}

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'vibecode-push-')));
  calls = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('git.push', () => {
  it('pushes main to a local remote when file remotes are explicitly allowed (tests only)', async () => {
    const git = createGit({ dataDir, exec: recordingExec, allowFileRemotes: true });
    await git.initRepo('p1');
    await git.commitFilesOnMain('p1', { 'a.txt': 'a\n' }, 'add a');
    const remote = await bareRemote();

    await git.push('p1', { url: remote, token: TOKEN });

    expect(await rawGit(['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toBe(
      await git.mainSha('p1'),
    );
    // A second push after another commit fast-forwards the remote.
    await git.commitFilesOnMain('p1', { 'b.txt': 'b\n' }, 'add b');
    await git.push('p1', { url: remote, token: null });
    expect(await rawGit(['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toBe(
      await git.mainSha('p1'),
    );
  });

  it('without the test override a file remote never reaches git', async () => {
    const git = createGit({ dataDir, exec: recordingExec });
    await git.initRepo('p1');
    const remote = await bareRemote();
    calls = [];
    await expect(git.push('p1', { url: remote, token: null })).rejects.toThrow(GitError);
    await expect(git.push('p1', { url: 'ext::sh -c touch% /tmp/x', token: null })).rejects.toThrow(
      GitError,
    );
    expect(calls).toEqual([]);
    expect(await rawGit(['--git-dir', remote, 'for-each-ref'])).toBe('');
  });

  it('blocks ext:: and file transports and ends options with -- before the URL', async () => {
    const git = createGit({ dataDir, exec: recordingExec });
    await git.initRepo('p1');
    calls = [];
    // Unreachable host: the push fails, but its argv is what matters here.
    await expect(
      git.push('p1', { url: 'https://127.0.0.1:1/owner/repo.git', token: TOKEN }),
    ).rejects.toThrow(GitError);
    const push = calls.find((c) => c.argv.includes('push'));
    if (push === undefined) throw new Error('git push was not run');
    const argv = push.argv.join(' ');
    expect(argv).toContain('-c protocol.ext.allow=never');
    expect(argv).toContain('-c protocol.file.allow=never');
    expect(argv).not.toContain('protocol.file.allow=always');
    const sep = push.argv.indexOf('--');
    expect(sep).toBeGreaterThan(push.argv.indexOf('push'));
    expect(push.argv[sep + 1]).toBe('https://127.0.0.1:1/owner/repo.git');
    expect(push.argv.slice(sep + 2)).toEqual(['refs/heads/main:refs/heads/main']);
  });

  it('hands the token to git only through GIT_ASKPASS and an env var', async () => {
    let askpassAnswers: string[] = [];
    let helperDir = '';
    const fakeExec: typeof exec = async (cmd, argv, o): Promise<ExecResult> => {
      calls.push({ argv: [...argv], env: o.env });
      if (!argv.includes('push')) return exec(cmd, argv, o);
      // Play git: ask the helper for a username and a password, as an https remote would.
      const askpass = o.env?.['GIT_ASKPASS'];
      if (askpass === undefined) throw new Error('GIT_ASKPASS not set');
      helperDir = join(askpass, '..');
      // exec redacts captured output, so the helper writes its answer to a file instead.
      const answer = join(dataDir, 'answer.txt');
      const ask = async (prompt: string) => {
        await exec('sh', ['-c', '"$0" "$1" > "$2"', askpass, prompt, answer], {
          env: o.env,
          timeoutMs: 10_000,
        });
        return (await readFile(answer, 'utf8')).trim();
      };
      askpassAnswers = [
        await ask("Username for 'https://example.com': "),
        await ask("Password for 'https://x-access-token@example.com': "),
      ];
      return {
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        truncated: false,
      };
    };
    const git = createGit({ dataDir, exec: fakeExec });
    await git.initRepo('p1');
    calls = [];

    await git.push('p1', { url: 'https://example.com/owner/repo.git', token: TOKEN });

    expect(askpassAnswers).toEqual(['x-access-token', TOKEN]);
    const push = calls.find((c) => c.argv.includes('push'));
    expect(push?.argv.join(' ')).not.toContain(TOKEN);
    expect(Object.values(push?.env ?? {})).toContain(TOKEN);
    expect(push?.env?.['GIT_TERMINAL_PROMPT']).toBe('0');
    // The helper holds no secret and is removed after the push.
    await expect(readdir(helperDir)).rejects.toThrow();
    // Nothing about the token or the remote is written into the repository.
    const config = await readFile(join(repoOf('p1'), 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain('example.com');
  });

  it('writes the askpass helper under the data dir (not os.tmpdir) and removes it after success and failure', async () => {
    const seen: { askpass: string; dirMode: number }[] = [];
    let failNext = false;
    const fakeExec: typeof exec = async (cmd, argv, o): Promise<ExecResult> => {
      if (!argv.includes('push')) return exec(cmd, argv, o);
      const askpass = o.env?.['GIT_ASKPASS'];
      if (askpass === undefined) throw new Error('GIT_ASKPASS not set');
      seen.push({ askpass, dirMode: (await stat(dirname(askpass))).mode & 0o777 });
      return {
        code: failNext ? 128 : 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: failNext ? 'fatal: nope' : '',
        truncated: false,
      };
    };
    const git = createGit({ dataDir, exec: fakeExec });
    await git.initRepo('p1');
    const url = 'https://example.com/owner/repo.git';

    await git.push('p1', { url, token: TOKEN });
    failNext = true;
    await expect(git.push('p1', { url, token: TOKEN })).rejects.toThrow(GitError);

    expect(seen).toHaveLength(2);
    for (const { askpass, dirMode } of seen) {
      expect(askpass.startsWith(dataDir + sep)).toBe(true);
      expect(askpass.startsWith(join(tmpdir(), 'vibecode-askpass-'))).toBe(false);
      expect(dirMode).toBe(0o700);
      await expect(readdir(dirname(askpass))).rejects.toThrow();
    }
  });

  it('redacts the token from a failed push error', async () => {
    const fakeExec: typeof exec = async (cmd, argv, o): Promise<ExecResult> => {
      if (!argv.includes('push')) return exec(cmd, argv, o);
      return {
        code: 128,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: `fatal: Authentication failed for token ${TOKEN}`,
        truncated: false,
      };
    };
    const git: Git = createGit({ dataDir, exec: fakeExec });
    await git.initRepo('p1');
    const err: unknown = await git
      .push('p1', { url: 'https://example.com/owner/repo.git', token: TOKEN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(String((err as Error).message)).toContain('Authentication failed');
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });
});
