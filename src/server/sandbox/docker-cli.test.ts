import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecError, type ExecOptions, type ExecResult, type StreamOptions } from '../util/exec.ts';
import {
  DOCKER_NOT_RUNNING,
  DockerCliRuntime,
  buildRunArgs,
  fileOpArgv,
  type SandboxSpec,
} from './index.ts';

type Call = { argv: string[]; o: ExecOptions; streamed: boolean };
type Reply = Partial<ExecResult> | Error;

/** Stub for util/exec: records every docker invocation and answers from `respond`. */
function stubDocker(respond: (argv: string[]) => Reply = () => ({})) {
  const calls: Call[] = [];
  const answer = (argv: readonly string[]): ExecResult => {
    const r = respond([...argv]);
    if (r instanceof Error) throw r;
    return {
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      ...r,
    };
  };
  const exec = (cmd: string, argv: readonly string[], o: ExecOptions) => {
    expect(cmd).toBe('docker');
    calls.push({ argv: [...argv], o, streamed: false });
    return Promise.resolve(answer(argv));
  };
  const spawnStream = (cmd: string, argv: readonly string[], o: StreamOptions) => {
    expect(cmd).toBe('docker');
    calls.push({ argv: [...argv], o, streamed: true });
    const r = answer(argv);
    for (const l of r.stdout.split('\n').slice(0, -1)) o.onLine(l, 'stdout');
    for (const l of r.stderr.split('\n').slice(0, -1)) o.onLine(l, 'stderr');
    return Promise.resolve({
      code: r.code,
      signal: r.signal,
      timedOut: r.timedOut,
      aborted: r.aborted,
    });
  };
  return { calls, exec, spawnStream, argvs: () => calls.map((c) => c.argv) };
}

let base: string;
let dataDir: string;
let wt: string;
let realWt: string;
let realData: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibecode-docker-cli-'));
  dataDir = path.join(base, 'data');
  wt = path.join(dataDir, 'worktrees', '01RUN');
  await mkdir(wt, { recursive: true });
  realWt = await realpath(wt);
  realData = await realpath(dataDir);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    runId: '01RUN',
    productId: '01PROD',
    role: 'agent',
    image: 'vibecode/base',
    worktree: wt,
    readOnly: false,
    network: 'none',
    ...over,
  };
}

function runtime(stub = stubDocker(), over: { docker?: string } = {}) {
  return new DockerCliRuntime({
    dataDir,
    uid: 1000,
    gid: 1000,
    exec: stub.exec,
    spawnStream: stub.spawnStream,
    baseImageDir: '/opt/vibecode/docker',
    ...over,
  });
}

const HOST = () => ({ uid: 1000, gid: 1000, dataDir: realData });
const T = { timeoutMs: 5000 };

describe('available', () => {
  it('runs `docker version` and reports whether it succeeded', async () => {
    const ok = stubDocker();
    expect(await runtime(ok).available()).toBe(true);
    expect(ok.argvs()).toEqual([['version', '--format', '{{.Server.Version}}']]);

    const down = stubDocker(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));
    expect(await runtime(down).available()).toBe(false);

    const missing = stubDocker(() => new ExecError('Could not run "docker": ENOENT', 'ENOENT'));
    expect(await runtime(missing).available()).toBe(false);
  });
});

describe('ensureNetworks', () => {
  it('creates missing networks: egress with ICC disabled, and preview', async () => {
    const stub = stubDocker((argv) =>
      argv[1] === 'inspect' ? { code: 1, stderr: 'network not found' } : {},
    );
    await runtime(stub).ensureNetworks();
    expect(stub.argvs()).toEqual([
      ['network', 'inspect', 'vibecode-egress'],
      [
        'network',
        'create',
        '--driver',
        'bridge',
        '--opt',
        'com.docker.network.bridge.enable_icc=false',
        'vibecode-egress',
      ],
      ['network', 'inspect', 'vibecode-preview'],
      ['network', 'create', '--driver', 'bridge', 'vibecode-preview'],
    ]);
  });

  it('leaves existing networks alone', async () => {
    const stub = stubDocker();
    await runtime(stub).ensureNetworks();
    expect(stub.argvs()).toEqual([
      ['network', 'inspect', 'vibecode-egress'],
      ['network', 'inspect', 'vibecode-preview'],
    ]);
  });
});

describe('ensureImage', () => {
  async function product(dir: string, files: Record<string, string>): Promise<string> {
    const ctx = path.join(base, dir);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(ctx, rel)), { recursive: true });
      await writeFile(path.join(ctx, rel), content);
    }
    await mkdir(ctx, { recursive: true });
    return ctx;
  }
  const PROJECT = JSON.stringify({ check: ['npm', 'test'], imageInputs: ['package-lock.json'] });
  const missing = (argv: string[]): Reply =>
    argv[0] === 'image' ? { code: 1, stderr: 'No such image' } : {};

  it('uses vibecode/base without a Dockerfile, building it from docker/base.Dockerfile on first use', async () => {
    const ctx = await product('p', { 'README.md': 'hi' });
    const stub = stubDocker(missing);
    const rt = runtime(stub);
    expect(await rt.ensureImage({ productId: '01PROD', contextDir: ctx })).toBe('vibecode/base');
    expect(stub.argvs()).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', 'vibecode/base'],
      [
        'buildx',
        'build',
        '--load',
        '--tag',
        'vibecode/base',
        '--file',
        '/opt/vibecode/docker/base.Dockerfile',
        '/opt/vibecode/docker',
      ],
    ]);
  });

  it('reuses vibecode/base when it is present', async () => {
    const ctx = await product('p', {});
    const stub = stubDocker();
    expect(await runtime(stub).ensureImage({ productId: '01PROD', contextDir: ctx })).toBe(
      'vibecode/base',
    );
    expect(stub.argvs()).toEqual([['image', 'inspect', '--format', '{{.Id}}', 'vibecode/base']]);
  });

  it('builds the repo Dockerfile with buildx under a content-addressed tag', async () => {
    const ctx = await product('p', {
      Dockerfile: 'FROM debian\n',
      '.vibecode/project.json': PROJECT,
      'package-lock.json': '{"v":1}',
    });
    const stub = stubDocker(missing);
    const tag = await runtime(stub).ensureImage({ productId: '01PROD', contextDir: ctx });
    expect(tag).toMatch(/^vibecode\/p-01prod:[0-9a-f]{64}$/);
    expect(stub.argvs()).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      ['buildx', 'build', '--load', '--tag', tag, '--file', path.join(ctx, 'Dockerfile'), ctx],
    ]);
  });

  it('reuses a product image that already exists', async () => {
    const ctx = await product('p', { Dockerfile: 'FROM debian\n' });
    const stub = stubDocker();
    const tag = await runtime(stub).ensureImage({ productId: '01PROD', contextDir: ctx });
    expect(stub.argvs()).toEqual([['image', 'inspect', '--format', '{{.Id}}', tag]]);
  });

  it('derives the tag from the Dockerfile and imageInputs contents only', async () => {
    const tagOf = async (dir: string, files: Record<string, string>) =>
      runtime().ensureImage({ productId: '01PROD', contextDir: await product(dir, files) });
    const files = {
      Dockerfile: 'FROM debian\n',
      '.vibecode/project.json': PROJECT,
      'package-lock.json': '{"v":1}',
      'src/app.ts': 'one',
    };
    const a = await tagOf('a', files);
    expect(await tagOf('b', { ...files, 'src/app.ts': 'two' })).toBe(a);
    expect(await tagOf('c', { ...files, 'package-lock.json': '{"v":2}' })).not.toBe(a);
    expect(await tagOf('d', { ...files, Dockerfile: 'FROM alpine\n' })).not.toBe(a);
    const noInputs = JSON.stringify({ check: ['x'], imageInputs: [] });
    expect(await tagOf('e', { ...files, '.vibecode/project.json': noInputs })).not.toBe(a);
    // Not just the Dockerfile hash (what FakeContainerRuntime uses).
    const dfOnly = createHash('sha256').update('FROM debian\n').digest('hex');
    expect(a).not.toBe(`vibecode/p-01prod:${dfOnly}`);
  });

  it('refuses an image input that resolves outside the repository', async () => {
    const outside = await product('outside', { 'secret.txt': 'host secret' });
    const ctx = await product('p', {
      Dockerfile: 'FROM debian\n',
      '.vibecode/project.json': JSON.stringify({ check: ['x'], imageInputs: ['lock'] }),
    });
    await symlink(path.join(outside, 'secret.txt'), path.join(ctx, 'lock'));
    const stub = stubDocker();
    await expect(
      runtime(stub).ensureImage({ productId: '01PROD', contextDir: ctx }),
    ).rejects.toThrow(/outside the repository/);
    expect(stub.calls).toEqual([]);
  });

  it('reports a failed build with its output', async () => {
    const ctx = await product('p', { Dockerfile: 'FROM nope\n' });
    const stub = stubDocker((argv) =>
      argv[0] === 'image' ? { code: 1 } : { code: 1, stderr: 'pull access denied for nope\n' },
    );
    await expect(
      runtime(stub).ensureImage({ productId: '01PROD', contextDir: ctx }),
    ).rejects.toThrow(/Image build failed.*pull access denied/s);
  });
});

describe('ensureImage with claude (derived Claude Code image)', () => {
  const CLAUDE_DF = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN install claude\n';
  let dockerDir: string;
  beforeEach(async () => {
    dockerDir = path.join(base, 'docker');
    await mkdir(dockerDir, { recursive: true });
    await writeFile(path.join(dockerDir, 'base.Dockerfile'), 'FROM debian\n');
    await writeFile(path.join(dockerDir, 'claude-code.Dockerfile'), CLAUDE_DF);
  });
  const missing = (argv: string[]): Reply =>
    argv[0] === 'image' ? { code: 1, stderr: 'No such image' } : {};
  const rt = (stub: ReturnType<typeof stubDocker>) =>
    new DockerCliRuntime({
      dataDir,
      uid: 1000,
      gid: 1000,
      exec: stub.exec,
      spawnStream: stub.spawnStream,
      baseImageDir: dockerDir,
    });

  it('builds vibecode/claude-code FROM vibecode/base when the product has no Dockerfile', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const stub = stubDocker(missing);
    expect(await rt(stub).ensureImage({ productId: '01PROD', contextDir: ctx, claude: true })).toBe(
      'vibecode/claude-code',
    );
    expect(stub.argvs().slice(2)).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', 'vibecode/claude-code'],
      [
        'buildx',
        'build',
        '--load',
        '--tag',
        'vibecode/claude-code',
        '--build-arg',
        'BASE_IMAGE=vibecode/base',
        '--file',
        path.join(dockerDir, 'claude-code.Dockerfile'),
        dockerDir,
      ],
    ]);
  });

  it('derives an image FROM the product image, tagged by product tag and Claude Dockerfile', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    await writeFile(path.join(ctx, 'Dockerfile'), 'FROM debian\n');
    const stub = stubDocker(missing);
    const productTag = await rt(stubDocker()).ensureImage({ productId: '01PROD', contextDir: ctx });
    const tag = await rt(stub).ensureImage({ productId: '01PROD', contextDir: ctx, claude: true });
    const hash = createHash('sha256').update(`${productTag}\0${CLAUDE_DF}`).digest('hex');
    expect(tag).toBe(`vibecode/p-01prod-claude:${hash}`);
    expect(stub.argvs()).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', productTag],
      [
        'buildx',
        'build',
        '--load',
        '--tag',
        productTag,
        '--file',
        path.join(ctx, 'Dockerfile'),
        ctx,
      ],
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      [
        'buildx',
        'build',
        '--load',
        '--tag',
        tag,
        '--build-arg',
        `BASE_IMAGE=${productTag}`,
        '--file',
        path.join(dockerDir, 'claude-code.Dockerfile'),
        dockerDir,
      ],
    ]);
  });

  it('reuses a derived image that already exists', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const stub = stubDocker();
    await rt(stub).ensureImage({ productId: '01PROD', contextDir: ctx, claude: true });
    expect(stub.argvs().map((a) => a[0])).toEqual(['image', 'image']);
  });
});

describe('mask file <dataDir>/empty', () => {
  it('is created as an empty regular file before the first docker run, idempotently', async () => {
    const mask = path.join(dataDir, 'empty');
    const seen: boolean[] = [];
    const stub = stubDocker((argv) => {
      if (argv[0] === 'run') seen.push(existsSync(mask));
      return {};
    });
    const rt = runtime(stub);
    await rt.runOnce(spec({ role: 'check' }), ['true'], T);
    await rt.open(spec({ runId: '01RUN2' }));
    expect(seen).toEqual([true, true]);
    const st = await lstat(mask);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(0);
  });

  it('empties a mask file that has content and refuses one that is not a regular file', async () => {
    const mask = path.join(dataDir, 'empty');
    await writeFile(mask, 'leftover');
    await runtime().open(spec());
    expect(await readFile(mask, 'utf8')).toBe('');

    await rm(mask);
    await mkdir(mask);
    const stub = stubDocker();
    await expect(runtime(stub).open(spec())).rejects.toThrow(/empty regular file/);
    expect(stub.calls).toEqual([]);
  });
});

describe('worktree confinement (realpath)', () => {
  it('refuses a symlink under data/worktrees that points outside, without calling docker', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'vibecode-outside-'));
    try {
      const link = path.join(dataDir, 'worktrees', 'evil');
      await symlink(outside, link);
      const stub = stubDocker();
      const rt = runtime(stub);
      await expect(rt.open(spec({ worktree: link }))).rejects.toThrow(
        /Refusing to mount .*evil.*outside/,
      );
      await expect(
        rt.runOnce(spec({ worktree: link, role: 'check' }), ['true'], T),
      ).rejects.toThrow(/Refusing to mount/);
      expect(stub.calls).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a worktree that does not exist', async () => {
    const stub = stubDocker();
    await expect(
      runtime(stub).open(spec({ worktree: path.join(dataDir, 'worktrees', 'gone') })),
    ).rejects.toThrow(/Refusing to mount .*does not exist/);
    expect(stub.calls).toEqual([]);
  });

  it('mounts the resolved real path', async () => {
    const link = path.join(dataDir, 'worktrees', 'alias');
    await symlink(wt, link);
    const stub = stubDocker();
    await runtime(stub).open(spec({ worktree: link }));
    expect(stub.argvs()[0]).toEqual([
      'run',
      '--detach',
      ...buildRunArgs(spec({ worktree: realWt }), HOST()),
      'sleep',
      'infinity',
    ]);
  });
});

describe('open and Sandbox', () => {
  it('starts a warm container with buildRunArgs and `sleep infinity`', async () => {
    const stub = stubDocker();
    const sb = await runtime(stub).open(spec());
    expect(sb.name).toBe('vibecode-01RUN');
    expect(stub.argvs()).toEqual([
      ['run', '--detach', ...buildRunArgs(spec({ worktree: realWt }), HOST()), 'sleep', 'infinity'],
    ]);
  });

  it('ensures the networks before starting a container on one', async () => {
    const stub = stubDocker();
    await runtime(stub).open(spec({ network: 'egress' }));
    expect(stub.argvs().map((a) => a.slice(0, 2))).toEqual([
      ['network', 'inspect'],
      ['network', 'inspect'],
      ['run', '--detach'],
    ]);
  });

  it('throws with docker output when the container cannot start', async () => {
    const stub = stubDocker(() => ({
      code: 125,
      stderr: 'Conflict. The container name is in use',
    }));
    await expect(runtime(stub).open(spec())).rejects.toThrow(/name is in use/);
  });

  it('execs in /workspace with stdin, timeout, abort signal and SIGINT', async () => {
    const stub = stubDocker((argv) =>
      argv[0] === 'exec' ? { code: 0, stdout: 'hello\n', stderr: '' } : {},
    );
    const sb = await runtime(stub).open(spec());
    const ac = new AbortController();
    const r = await sb.exec(['cat'], { stdin: 'hello\n', timeoutMs: 1234, signal: ac.signal });
    expect(r).toEqual({
      code: 0,
      stdout: 'hello\n',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
    });
    const call = stub.calls[1];
    expect(call?.argv).toEqual(['exec', '-i', '-w', '/workspace', 'vibecode-01RUN', 'cat']);
    expect(call?.o).toMatchObject({
      input: 'hello\n',
      timeoutMs: 1234,
      signal: ac.signal,
      killSignal: 'SIGINT',
    });
  });

  it('runs file ops through the shared fileOpArgv protocol', async () => {
    const stub = stubDocker();
    const sb = await runtime(stub).open(spec());
    const op = fileOpArgv({ op: 'write', path: 'src/a.ts' });
    if (!op.ok) throw new Error(op.reason);
    await sb.exec(op.argv, { stdin: 'x', timeoutMs: 1000 });
    expect(stub.calls[1]?.argv).toEqual([
      'exec',
      '-i',
      '-w',
      '/workspace',
      'vibecode-01RUN',
      ...op.argv,
    ]);
  });

  it('streams output lines when onLine is given and still returns the output', async () => {
    const stub = stubDocker((argv) =>
      argv[0] === 'exec' ? { code: 3, stdout: 'a\nb\n', stderr: 'oops\n' } : {},
    );
    const sb = await runtime(stub).open(spec());
    const lines: string[] = [];
    const r = await sb.exec(['make'], {
      timeoutMs: 1000,
      onLine: (l, s) => lines.push(`${s}:${l}`),
    });
    expect(stub.calls[1]?.streamed).toBe(true);
    expect(stub.calls[1]?.o).toMatchObject({ killSignal: 'SIGINT', timeoutMs: 1000 });
    expect(lines).toEqual(['stdout:a', 'stdout:b', 'stderr:oops']);
    expect(r).toMatchObject({ code: 3, stdout: 'a\nb\n', stderr: 'oops\n' });
  });

  describe('killSignal: delivered inside the container', () => {
    /**
     * A docker stub whose `docker exec -i` (the agent process) keeps running until either an
     * in-container `kill -s INT` arrives (the process ends its turn) or the client is aborted.
     */
    function hangingDocker(o: { endsOnSignal: boolean }) {
      const calls: Call[] = [];
      const done = (aborted: boolean) =>
        ({ code: aborted ? null : 0, signal: null, timedOut: false, aborted }) as const;
      let finish: ((aborted: boolean) => void) | undefined;
      const exec = (_cmd: string, argv: readonly string[], opts: ExecOptions) => {
        calls.push({ argv: [...argv], o: opts, streamed: false });
        if (argv[0] === 'exec' && argv[1] === '-i') {
          return new Promise<ExecResult>((resolve) => {
            finish = (aborted) => {
              resolve({ ...done(aborted), stdout: 'partial\n', stderr: '', truncated: false });
            };
            opts.signal?.addEventListener('abort', () => finish?.(true), { once: true });
          });
        }
        if (argv[0] === 'exec' && argv.includes('INT') && o.endsOnSignal) finish?.(false);
        return Promise.resolve({ ...done(false), stdout: '', stderr: '', truncated: false });
      };
      const spawnStream = () => Promise.reject(new Error('not used'));
      return { calls, exec, spawnStream, argvs: () => calls.map((c) => c.argv) };
    }

    const signalled = (stub: { killGraceMs?: number; docker: ReturnType<typeof hangingDocker> }) =>
      new DockerCliRuntime({
        dataDir,
        uid: 1000,
        gid: 1000,
        exec: stub.docker.exec,
        spawnStream: stub.docker.spawnStream,
        killGraceMs: stub.killGraceMs ?? 60_000,
      });

    it('records the pid in the container and sends SIGINT there on abort', async () => {
      const docker = hangingDocker({ endsOnSignal: true });
      const sb = await signalled({ docker }).open(spec());
      const ac = new AbortController();
      const running = sb.exec(['claude', '-p'], {
        timeoutMs: 60_000,
        signal: ac.signal,
        killSignal: 'SIGINT',
      });
      await Promise.resolve();
      const [, main] = docker.argvs();
      expect(main?.slice(0, 7)).toEqual([
        'exec',
        '-i',
        '-w',
        '/workspace',
        'vibecode-01RUN',
        'sh',
        '-c',
      ]);
      const pidFile = main?.[9] ?? '';
      expect(pidFile).toMatch(/^\/tmp\/vibecode-exec-[0-9a-f-]{36}\.pid$/);
      expect(main?.slice(8)).toEqual(['sh', pidFile, 'claude', '-p']);
      // The wrapper records its pid, then execs the argv (same pid, so the signal reaches it).
      expect(main?.[7]).toContain('$$');
      expect(main?.[7]).toContain('exec "$@"');

      ac.abort();
      const r = await running;

      expect(docker.argvs()[2]).toEqual([
        'exec',
        'vibecode-01RUN',
        'sh',
        '-c',
        expect.stringContaining('kill -s'),
        'sh',
        'INT',
        pidFile,
      ]);
      expect(docker.argvs()).toHaveLength(3); // ended on SIGINT: no SIGKILL fallback
      expect(r).toMatchObject({ aborted: true, stdout: 'partial\n' });
    });

    it('falls back to SIGKILL in the container and kills the client after the grace period', async () => {
      const docker = hangingDocker({ endsOnSignal: false });
      const sb = await signalled({ docker, killGraceMs: 10 }).open(spec());
      const ac = new AbortController();
      const running = sb.exec(['claude'], {
        timeoutMs: 60_000,
        signal: ac.signal,
        killSignal: 'SIGINT',
      });
      await Promise.resolve();
      ac.abort();
      const r = await running;

      const pidFile = docker.argvs()[1]?.[9];
      const kills = docker
        .argvs()
        .slice(2)
        .map((a) => a.slice(-2));
      expect(kills).toEqual([
        ['INT', pidFile],
        ['KILL', pidFile],
      ]);
      expect(docker.calls[1]?.o.killSignal).toBe('SIGKILL');
      expect(r.aborted).toBe(true);
    });

    it('does not start the process when the signal is already aborted', async () => {
      const docker = hangingDocker({ endsOnSignal: true });
      const sb = await signalled({ docker }).open(spec());
      const ac = new AbortController();
      ac.abort();
      const r = await sb.exec(['claude'], {
        timeoutMs: 1000,
        signal: ac.signal,
        killSignal: 'SIGINT',
      });
      expect(r).toMatchObject({ code: null, aborted: true });
      expect(docker.argvs()).toHaveLength(1);
    });
  });

  it('reports timeouts and aborts', async () => {
    const stub = stubDocker((argv) =>
      argv[0] === 'exec'
        ? { code: null, timedOut: argv.includes('slow'), aborted: argv.includes('stop') }
        : {},
    );
    const sb = await runtime(stub).open(spec());
    expect(await sb.exec(['slow'], T)).toMatchObject({ code: null, timedOut: true });
    expect(await sb.exec(['stop'], T)).toMatchObject({ code: null, aborted: true });
  });

  it('close force-removes the container', async () => {
    const stub = stubDocker();
    const sb = await runtime(stub).open(spec());
    await sb.close();
    expect(stub.argvs()[1]).toEqual(['rm', '--force', 'vibecode-01RUN']);
  });
});

describe('runOnce', () => {
  it('runs a one-shot container with buildRunArgs and the argv', async () => {
    const stub = stubDocker(() => ({ code: 0, stdout: 'ok\n' }));
    const lines: string[] = [];
    const r = await runtime(stub).runOnce(spec({ role: 'check' }), ['npm', 'test'], {
      timeoutMs: 999,
      onLine: (l) => lines.push(l),
    });
    expect(stub.argvs()).toEqual([
      [
        'run',
        '--rm',
        '-i',
        ...buildRunArgs(spec({ role: 'check', worktree: realWt }), HOST()),
        'npm',
        'test',
      ],
    ]);
    expect(stub.calls[0]?.o).toMatchObject({ timeoutMs: 999, killSignal: 'SIGINT' });
    expect(lines).toEqual(['ok']);
    expect(r).toMatchObject({ code: 0, stdout: 'ok\n' });
  });

  it('force-removes the container after a timeout or abort', async () => {
    const stub = stubDocker((argv) => (argv[0] === 'run' ? { code: null, timedOut: true } : {}));
    const r = await runtime(stub).runOnce(spec({ role: 'check' }), ['sleep', '99'], T);
    expect(r.timedOut).toBe(true);
    expect(stub.argvs().at(-1)).toEqual(['rm', '--force', 'vibecode-01RUN']);
  });
});

describe('runDetached', () => {
  const previewSpec = (over: Partial<SandboxSpec> = {}) =>
    spec({ role: 'preview', network: 'preview', readOnly: true, publishPort: 3000, ...over });

  it('runs the preview command detached, read-only, on vibecode-preview, published on 127.0.0.1 only', async () => {
    const stub = stubDocker();
    const c = await runtime(stub).runDetached(previewSpec(), ['npm', 'start']);
    expect(c).toEqual({ name: 'vibecode-01RUN' });
    const run = stub.argvs().find((a) => a[0] === 'run');
    expect(run).toEqual([
      'run',
      '--detach',
      ...buildRunArgs(previewSpec({ worktree: realWt }), HOST()),
      'npm',
      'start',
    ]);
    if (run === undefined) throw new Error('no docker run');
    expect(run).toContain('--read-only');
    expect(run).toContain(`type=bind,src=${realWt},dst=/workspace,readonly`);
    expect(run.join(' ')).toContain('--network vibecode-preview');
    const publish = run.filter((_a, i) => run[i - 1] === '--publish' || run[i - 1] === '-p');
    expect(publish).toEqual(['127.0.0.1::3000']);
  });

  it('mounts the worktree read-only even when the spec says otherwise', async () => {
    const stub = stubDocker();
    await runtime(stub).runDetached(previewSpec({ readOnly: false }), ['npm', 'start']);
    expect(stub.argvs().find((a) => a[0] === 'run')).toContain(
      `type=bind,src=${realWt},dst=/workspace,readonly`,
    );
  });

  it('ensures the preview network before starting the container', async () => {
    const stub = stubDocker();
    await runtime(stub).runDetached(previewSpec(), ['npm', 'start']);
    expect(stub.argvs().map((a) => a.slice(0, 2))).toEqual([
      ['network', 'inspect'],
      ['network', 'inspect'],
      ['run', '--detach'],
    ]);
  });

  it('throws with docker output when the container cannot start', async () => {
    const stub = stubDocker((argv) =>
      argv[0] === 'run' ? { code: 125, stderr: 'port is already allocated' } : {},
    );
    await expect(runtime(stub).runDetached(previewSpec(), ['npm', 'start'])).rejects.toThrow(
      /already allocated/,
    );
  });

  it('refuses a non-preview spec (publishing is preview-only)', async () => {
    const stub = stubDocker();
    await expect(
      runtime(stub).runDetached(spec({ publishPort: 3000 }), ['npm', 'start']),
    ).rejects.toThrow(/Only preview sandboxes/);
    expect(stub.argvs().filter((a) => a[0] === 'run')).toEqual([]);
  });
});

describe('listManaged, remove, publishedPort', () => {
  it('lists containers by the managed label', async () => {
    const stub = stubDocker(() => ({
      stdout:
        'vibecode-01A\tvibecode.managed=1,vibecode.product=01P,vibecode.run=01A,vibecode.role=agent\n' +
        'vibecode-01B\tvibecode.managed=1,vibecode.role=check\n',
    }));
    expect(await runtime(stub).listManaged()).toEqual([
      {
        name: 'vibecode-01A',
        labels: {
          'vibecode.managed': '1',
          'vibecode.product': '01P',
          'vibecode.run': '01A',
          'vibecode.role': 'agent',
        },
      },
      { name: 'vibecode-01B', labels: { 'vibecode.managed': '1', 'vibecode.role': 'check' } },
    ]);
    expect(stub.argvs()).toEqual([
      [
        'ps',
        '--all',
        '--no-trunc',
        '--filter',
        'label=vibecode.managed=1',
        '--format',
        '{{.Names}}\t{{.Labels}}',
      ],
    ]);
  });

  it('remove forces and tolerates a container that is already gone', async () => {
    const stub = stubDocker(() => ({ code: 1, stderr: 'Error: No such container: vibecode-x' }));
    await runtime(stub).remove('vibecode-x');
    expect(stub.argvs()).toEqual([['rm', '--force', 'vibecode-x']]);
  });

  it('remove refuses a name that docker would read as a flag', async () => {
    const stub = stubDocker();
    await expect(runtime(stub).remove('--all')).rejects.toThrow(/Invalid container name/);
    expect(stub.calls).toEqual([]);
  });

  it('publishedPort returns the loopback host port of a preview', async () => {
    const stub = stubDocker(() => ({ stdout: '127.0.0.1:49153\n' }));
    expect(await runtime(stub).publishedPort('vibecode-01RUN', 3000)).toBe(49153);
    expect(stub.argvs()).toEqual([['port', 'vibecode-01RUN', '3000/tcp']]);
  });

  it('publishedPort throws when the port is not published', async () => {
    const stub = stubDocker(() => ({ code: 1, stderr: 'Error: No public port' }));
    await expect(runtime(stub).publishedPort('vibecode-01RUN', 3000)).rejects.toThrow(
      /not published/,
    );
  });
});

describe('Docker unavailable', () => {
  it('turns a missing CLI or a stopped daemon into an actionable error', async () => {
    expect(DOCKER_NOT_RUNNING).toBe(
      'Docker is not running: start Docker Desktop or the docker service',
    );
    const missing = stubDocker(() => new ExecError('Could not run "docker": ENOENT', 'ENOENT'));
    await expect(runtime(missing).listManaged()).rejects.toThrow(DOCKER_NOT_RUNNING);
    await expect(runtime(missing).open(spec())).rejects.toThrow(DOCKER_NOT_RUNNING);
    const down = stubDocker(() => ({
      code: 1,
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    }));
    await expect(runtime(down).open(spec())).rejects.toThrow(DOCKER_NOT_RUNNING);
    await expect(runtime(down).ensureNetworks()).rejects.toThrow(DOCKER_NOT_RUNNING);
    await expect(runtime(down).remove('vibecode-x')).rejects.toThrow(DOCKER_NOT_RUNNING);
  });
});
