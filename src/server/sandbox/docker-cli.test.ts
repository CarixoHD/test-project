import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecError,
  exec as realExec,
  type ExecOptions,
  type ExecResult,
  type StreamOptions,
} from '../util/exec.ts';
import {
  DOCKER_NOT_RUNNING,
  DockerCliRuntime,
  baseImageTag,
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

/**
 * The user argv of a Sandbox.exec, after checking the `docker exec` + pid wrapper prefix
 * (`sh -c <wrapper> sh <pidFile> ...argv`).
 */
function wrapped(argv: string[] | undefined): string[] {
  expect(argv?.slice(0, 7)).toEqual([
    'exec',
    '-i',
    '-w',
    '/workspace',
    'vibecode-01RUN',
    'sh',
    '-c',
  ]);
  expect(argv?.[8]).toBe('sh');
  expect(argv?.[9]).toMatch(/^\/tmp\/vibecode-exec-[0-9a-f-]{36}\.pid$/);
  return argv?.slice(10) ?? [];
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

function runtime(stub = stubDocker(), over: { docker?: string; baseImageDir?: string } = {}) {
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

  /** docker/ with a base.Dockerfile; the no-Dockerfile path tags the base by its content. */
  async function baseDir(content = 'FROM debian\n'): Promise<string> {
    const dir = path.join(base, 'docker');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'base.Dockerfile'), content);
    return dir;
  }
  const BASE_TAG = /^vibecode\/base:[0-9a-f]{12}$/;

  it('uses vibecode/base:<hash> without a Dockerfile, building it from docker/base.Dockerfile on first use', async () => {
    const dir = await baseDir();
    const ctx = await product('p', { 'README.md': 'hi' });
    const stub = stubDocker(missing);
    const tag = await runtime(stub, { baseImageDir: dir }).ensureImage({
      productId: '01PROD',
      contextDir: ctx,
    });
    expect(tag).toMatch(BASE_TAG);
    expect(tag).toBe(await baseImageTag(dir));
    expect(stub.argvs()).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      ['buildx', 'build', '--load', '--tag', tag, '--file', path.join(dir, 'base.Dockerfile'), dir],
    ]);
  });

  it('reuses vibecode/base:<hash> when it is present', async () => {
    const dir = await baseDir();
    const ctx = await product('p', {});
    const stub = stubDocker();
    const tag = await runtime(stub, { baseImageDir: dir }).ensureImage({
      productId: '01PROD',
      contextDir: ctx,
    });
    expect(stub.argvs()).toEqual([['image', 'inspect', '--format', '{{.Id}}', tag]]);
  });

  it('builds a new base tag when base.Dockerfile changes, instead of reusing the stale image', async () => {
    const dir = await baseDir('FROM debian:bookworm\n');
    const ctx = await product('p', {});
    const images = new Set<string>();
    const stub = stubDocker((argv) => {
      if (argv[0] === 'image') {
        return images.has(argv.at(-1) ?? '') ? {} : { code: 1, stderr: 'No such image' };
      }
      if (argv[0] === 'buildx') images.add(argv[argv.indexOf('--tag') + 1] ?? '');
      return {};
    });
    const p = { productId: '01PROD', contextDir: ctx };
    const before = await runtime(stub, { baseImageDir: dir }).ensureImage(p);
    await writeFile(path.join(dir, 'base.Dockerfile'), 'FROM debian:trixie\n');
    const after = await runtime(stub, { baseImageDir: dir }).ensureImage(p);
    expect(after).toMatch(BASE_TAG);
    expect(after).not.toBe(before);
    const built = stub.argvs().filter((a) => a[0] === 'buildx');
    expect(built.map((a) => a[4])).toEqual([before, after]);
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

describe('baseImageTag', () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(base, 'docker');
    await mkdir(path.join(dir, 'conf'), { recursive: true });
  });

  it('is vibecode/base:<12 hex of sha256> over base.Dockerfile', async () => {
    await writeFile(path.join(dir, 'base.Dockerfile'), 'FROM debian\n');
    const tag = await baseImageTag(dir);
    expect(tag).toMatch(/^vibecode\/base:[0-9a-f]{12}$/);
    expect(await baseImageTag(dir)).toBe(tag);
    await writeFile(path.join(dir, 'base.Dockerfile'), 'FROM debian\nRUN true\n');
    expect(await baseImageTag(dir)).not.toBe(tag);
  });

  it('covers the build-context files base.Dockerfile COPYs or ADDs, not other files', async () => {
    await writeFile(
      path.join(dir, 'base.Dockerfile'),
      'FROM debian\nCOPY --chown=0:0 entry.sh /usr/local/bin/\nADD conf /etc/conf\n' +
        'COPY --from=other /x /x\n',
    );
    await writeFile(path.join(dir, 'entry.sh'), 'echo 1\n');
    await writeFile(path.join(dir, 'conf', 'a.ini'), 'a=1\n');
    await writeFile(path.join(dir, 'claude-code.Dockerfile'), 'FROM x\n');
    const tag = await baseImageTag(dir);
    await writeFile(path.join(dir, 'claude-code.Dockerfile'), 'FROM y\n');
    expect(await baseImageTag(dir)).toBe(tag);
    await writeFile(path.join(dir, 'entry.sh'), 'echo 2\n');
    const copied = await baseImageTag(dir);
    expect(copied).not.toBe(tag);
    await writeFile(path.join(dir, 'conf', 'a.ini'), 'a=2\n');
    expect(await baseImageTag(dir)).not.toBe(copied);
  });

  it('refuses a COPY source outside the image directory', async () => {
    await writeFile(path.join(dir, 'base.Dockerfile'), 'FROM debian\nCOPY ../secret /s\n');
    await expect(baseImageTag(dir)).rejects.toThrow(/outside/);
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

  /** A docker stub with an image store: inspect finds what an earlier build loaded. */
  function imageStore() {
    const images = new Set<string>();
    const stub = stubDocker((argv) => {
      if (argv[0] === 'image') {
        return images.has(argv.at(-1) ?? '') ? {} : { code: 1, stderr: 'No such image' };
      }
      if (argv[0] === 'buildx') images.add(argv[argv.indexOf('--tag') + 1] ?? '');
      return {};
    });
    return { stub, images };
  }
  const builds = (stub: ReturnType<typeof stubDocker>) =>
    stub.argvs().filter((a) => a[0] === 'buildx');
  const CLAUDE_TAG = /^vibecode\/claude-code:[0-9a-f]{64}$/;

  it('builds vibecode/claude-code:<hash> FROM the hashed vibecode/base tag when the product has no Dockerfile', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const stub = stubDocker(missing);
    const tag = await rt(stub).ensureImage({ productId: '01PROD', contextDir: ctx, claude: true });
    expect(tag).toMatch(CLAUDE_TAG);
    expect(stub.argvs().slice(2)).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', tag],
      [
        'buildx',
        'build',
        '--load',
        '--tag',
        tag,
        '--build-arg',
        `BASE_IMAGE=${await baseImageTag(dockerDir)}`,
        '--file',
        path.join(dockerDir, 'claude-code.Dockerfile'),
        dockerDir,
      ],
    ]);
  });

  it('rebuilds the Claude image under a new tag when claude-code.Dockerfile changes (CLI pin bump)', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const { stub } = imageStore();
    const p = { productId: '01PROD', contextDir: ctx, claude: true };
    const before = await rt(stub).ensureImage(p);
    await writeFile(
      path.join(dockerDir, 'claude-code.Dockerfile'),
      CLAUDE_DF.replace('install claude', 'install claude@2'),
    );
    const after = await rt(stub).ensureImage(p);

    expect(after).toMatch(CLAUDE_TAG);
    expect(after).not.toBe(before);
    const baseTag = await baseImageTag(dockerDir);
    expect(builds(stub).map((a) => a[4])).toEqual([baseTag, before, after]);
  });

  it('changes the Claude tag and builds it FROM the new base tag when base.Dockerfile changes', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const p = { productId: '01PROD', contextDir: ctx, claude: true };
    const before = await rt(stubDocker()).ensureImage(p);
    await writeFile(path.join(dockerDir, 'base.Dockerfile'), 'FROM debian:trixie\n');
    const stub = stubDocker(missing);
    const after = await rt(stub).ensureImage(p);
    expect(after).not.toBe(before);
    const newBase = await baseImageTag(dockerDir);
    expect(builds(stub).map((a) => [a[4], a[6]])).toEqual([
      [newBase, path.join(dockerDir, 'base.Dockerfile')],
      [after, `BASE_IMAGE=${newBase}`],
    ]);
  });

  it('reuses the Claude image without rebuilding while claude-code.Dockerfile is unchanged', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const { stub } = imageStore();
    const p = { productId: '01PROD', contextDir: ctx, claude: true };
    const first = await rt(stub).ensureImage(p);
    const calls = stub.calls.length;
    expect(await rt(stub).ensureImage(p)).toBe(first);
    expect(stub.argvs().slice(calls)).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', await baseImageTag(dockerDir)],
      ['image', 'inspect', '--format', '{{.Id}}', first],
    ]);
    expect(builds(stub)).toHaveLength(2);
  });

  it('derives an image FROM the product image, tagged by product tag and Claude Dockerfile', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    await writeFile(path.join(ctx, 'Dockerfile'), 'FROM debian\n');
    const stub = stubDocker(missing);
    const productTag = await rt(stubDocker()).ensureImage({ productId: '01PROD', contextDir: ctx });
    const tag = await rt(stub).ensureImage({ productId: '01PROD', contextDir: ctx, claude: true });
    expect(tag).toMatch(/^vibecode\/p-01prod-claude:[0-9a-f]{64}$/);
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

    await writeFile(path.join(dockerDir, 'claude-code.Dockerfile'), `${CLAUDE_DF}# bump\n`);
    const bumped = await rt(stubDocker()).ensureImage({
      ...{ productId: '01PROD' },
      contextDir: ctx,
      claude: true,
    });
    expect(bumped).toMatch(/^vibecode\/p-01prod-claude:[0-9a-f]{64}$/);
    expect(bumped).not.toBe(tag);
  });

  it('reuses a derived image that already exists', async () => {
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const stub = stubDocker();
    await rt(stub).ensureImage({ productId: '01PROD', contextDir: ctx, claude: true });
    expect(stub.argvs().map((a) => a[0])).toEqual(['image', 'image']);
  });
});

describe('claudeLoginCommands', () => {
  let dockerDir: string;
  beforeEach(async () => {
    dockerDir = path.join(base, 'docker dir');
    await mkdir(dockerDir, { recursive: true });
    await writeFile(path.join(dockerDir, 'base.Dockerfile'), 'FROM debian\n');
    await writeFile(path.join(dockerDir, 'claude-code.Dockerfile'), 'FROM ${BASE_IMAGE}\n');
  });
  const rt = (stub: ReturnType<typeof stubDocker>) =>
    new DockerCliRuntime({
      dataDir,
      uid: 1234,
      gid: 5678,
      exec: stub.exec,
      spawnStream: stub.spawnStream,
      baseImageDir: dockerDir,
    });

  it('logs in as the host uid:gid with the current Claude image, on the same named volume', async () => {
    const stub = stubDocker();
    const ctx = path.join(base, 'p');
    await mkdir(ctx, { recursive: true });
    const tag = await rt(stubDocker()).ensureImage({
      productId: '01PROD',
      contextDir: ctx,
      claude: true,
    });
    const c = await rt(stub).claudeLoginCommands();
    expect(c.login).toBe(
      'docker run -it --rm --pull never --user 1234:5678 ' +
        `-v vibecode-claude-config:/home/agent/.claude ${tag} claude auth login`,
    );
    expect(c.volume).toBe('docker volume create vibecode-claude-config');
    const q = (name: string) => `'${path.join(dockerDir, name)}'`;
    const dir = `'${dockerDir}'`;
    const baseTag = await baseImageTag(dockerDir);
    expect(baseTag).toMatch(/^vibecode\/base:[0-9a-f]{12}$/);
    expect(c.build).toBe(
      `docker buildx build --load --tag ${baseTag} --file ${q('base.Dockerfile')} ${dir} && ` +
        `docker buildx build --load --tag ${tag} --build-arg BASE_IMAGE=${baseTag} ` +
        `--file ${q('claude-code.Dockerfile')} ${dir}`,
    );
    expect(stub.calls).toEqual([]);
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

  it('execs in /workspace under the pid wrapper, with stdin and a client backstop timeout', async () => {
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
    expect(wrapped(call?.argv)).toEqual(['cat']);
    expect(call?.o).toMatchObject({ input: 'hello\n', killSignal: 'SIGKILL' });
    // The deadline is enforced in the container first; the client's own timeout is a backstop.
    expect(call?.o.timeoutMs).toBeGreaterThan(1234);
    // No kill when the command ends on its own; only the pid/cancel file cleanup follows.
    const pidFile = call?.argv[9] ?? '';
    expect(stub.argvs().slice(2)).toEqual([
      ['exec', 'vibecode-01RUN', 'rm', '-f', pidFile, `${pidFile}.cancel`],
    ]);
    expect(stub.calls[2]?.o.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('logs a failed pid file cleanup with container and pid file, keeping the exec result', async () => {
    const logs: string[] = [];
    const stub = stubDocker((argv) =>
      argv[0] === 'exec' && argv[2] === 'rm'
        ? { code: 1, stderr: 'Error response from daemon: container is paused' }
        : argv[0] === 'exec'
          ? { code: 4, stdout: 'out\n', stderr: 'err\n' }
          : {},
    );
    const rt = new DockerCliRuntime({
      dataDir,
      uid: 1000,
      gid: 1000,
      exec: stub.exec,
      spawnStream: stub.spawnStream,
      log: (l) => logs.push(l),
    });
    const sb = await rt.open(spec());
    const r = await sb.exec(['make'], T);
    expect(r).toEqual({
      code: 4,
      stdout: 'out\n',
      stderr: 'err\n',
      timedOut: false,
      aborted: false,
      truncated: false,
    });
    const pidFile = stub.argvs()[1]?.[9] ?? '';
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('vibecode-01RUN');
    expect(logs[0]).toContain(pidFile);
    expect(logs[0]).toContain('container is paused');

    logs.length = 0;
    const throwing = stubDocker((argv) =>
      argv[0] === 'exec' && argv[2] === 'rm'
        ? new ExecError('Could not run "docker": EACCES', 'EACCES')
        : {},
    );
    const sb2 = await new DockerCliRuntime({
      dataDir,
      uid: 1000,
      gid: 1000,
      exec: throwing.exec,
      spawnStream: throwing.spawnStream,
      log: (l) => logs.push(l),
    }).open(spec());
    expect(await sb2.exec(['make'], T)).toMatchObject({ code: 0 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/vibecode-01RUN.*\/tmp\/vibecode-exec-.*EACCES/);
  });

  it('runs file ops through the shared fileOpArgv protocol', async () => {
    const stub = stubDocker();
    const sb = await runtime(stub).open(spec());
    const op = fileOpArgv({ op: 'write', path: 'src/a.ts' });
    if (!op.ok) throw new Error(op.reason);
    await sb.exec(op.argv, { stdin: 'x', timeoutMs: 1000 });
    expect(wrapped(stub.calls[1]?.argv)).toEqual(op.argv);
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
    expect(wrapped(stub.calls[1]?.argv)).toEqual(['make']);
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
      // Ended on SIGINT: no SIGKILL fallback; the client returned, so plain file cleanup.
      expect(docker.argvs().slice(3)).toEqual([
        ['exec', 'vibecode-01RUN', 'rm', '-f', pidFile, `${pidFile}.cancel`],
      ]);
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
      const after = docker.argvs().slice(2);
      expect(after.slice(0, 2).map((a) => a.slice(-2))).toEqual([
        ['INT', pidFile],
        ['KILL', pidFile],
      ]);
      // The client was killed, so a late wrapper may still read the cancel marker: the
      // cleanup goes through the guarded script, not a plain `rm`.
      expect(after.slice(2)).toEqual([
        ['exec', 'vibecode-01RUN', 'sh', '-c', expect.any(String), 'sh', pidFile],
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

  describe('stopping the process inside the container (timeout, abort)', () => {
    /**
     * A docker stub that runs the in-container part for real, on the host: `docker exec [-i]
     * [-w dir] <name> ...cmd` runs `cmd` (so the real wrapper and kill script), with pid files
     * under the test dir. Like real `docker exec`, killing the client does NOT reach the
     * command: the client's signal is ignored, only the in-container kill can stop it.
     */
    function localDocker(o: { startDelayMs?: number; clientDetaches?: boolean } = {}) {
      const calls: Call[] = [];
      /** In-container commands still running after their client returned (clientDetaches). */
      const background: Promise<unknown>[] = [];
      const local = (argv: readonly string[]) => {
        let i = 1;
        while (argv[i] === '-i' || argv[i] === '-w') i += argv[i] === '-w' ? 2 : 1;
        return argv
          .slice(i + 1)
          .map((a) =>
            a.startsWith('/tmp/vibecode-exec-') ? path.join(base, path.basename(a)) : a,
          );
      };
      const exec = async (_cmd: string, argv: readonly string[], opts: ExecOptions) => {
        calls.push({ argv: [...argv], o: opts, streamed: false });
        if (argv[0] !== 'exec') return { ...OK };
        const [cmd = '', ...rest] = local(argv);
        const isMain = argv[1] === '-i';
        const run = (async () => {
          if (isMain && o.startDelayMs !== undefined) {
            await new Promise((r) => setTimeout(r, o.startDelayMs));
          }
          return realExec(cmd, rest, { input: opts.input, cwd: wt, timeoutMs: 20_000 });
        })();
        if (!isMain || o.clientDetaches !== true) return run;
        // Killing the client returns at once; the exec may still start in the container later.
        background.push(run);
        return new Promise<ExecResult>((resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            resolve({ ...OK, code: null, aborted: true }),
          );
          run.then(resolve, reject);
        });
      };
      const spawnStream = () => Promise.reject(new Error('not used'));
      return { calls, exec, spawnStream, background, argvs: () => calls.map((c) => c.argv) };
    }
    /** The pid and cancel files the wrapper and kill script left in the "container" /tmp. */
    const execFiles = async () =>
      (await readdir(base)).filter((f) => f.startsWith('vibecode-exec-')).sort();
    const OK: ExecResult = {
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
    };
    const rtWith = (
      docker: ReturnType<typeof localDocker>,
      killGraceMs = 60_000,
      logs?: string[],
    ) =>
      new DockerCliRuntime({
        dataDir,
        uid: 1000,
        gid: 1000,
        exec: docker.exec,
        spawnStream: docker.spawnStream,
        killGraceMs,
        log: (l) => logs?.push(l),
      });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** Runs a background `sleep 300` (a grandchild of the wrapper) and records its pid. */
    const SLEEPER = ['sh', '-c', 'sleep 300 & echo $! > child.pid; echo started; wait'];
    const childPid = async () => Number(await readFile(path.join(wt, 'child.pid'), 'utf8'));

    it('on timeout, kills the exec process group inside the container', async () => {
      const docker = localDocker();
      const sb = await rtWith(docker).open(spec());
      const started = Date.now();
      const r = await sb.exec(SLEEPER, { timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(r).toMatchObject({ timedOut: true, aborted: false, stdout: 'started\n' });
      const pidFile = docker.argvs()[1]?.[9];
      expect(docker.argvs()[2]).toEqual([
        'exec',
        'vibecode-01RUN',
        'sh',
        '-c',
        expect.stringContaining('kill -s "$1" -- "-$pid"'),
        'sh',
        'TERM',
        pidFile,
      ]);
      const pid = await childPid();
      await expect.poll(() => alive(pid)).toBe(false);
      expect(await execFiles()).toEqual([]);
    });

    it('leaves no pid or cancel file after commands that end on their own', async () => {
      const docker = localDocker();
      const sb = await rtWith(docker).open(spec());
      expect(await sb.exec(['sh', '-c', 'echo hi'], T)).toMatchObject({ code: 0, stdout: 'hi\n' });
      expect(await sb.exec(['sh', '-c', 'exit 3'], T)).toMatchObject({ code: 3 });
      expect(await execFiles()).toEqual([]);
    });

    it('on abort, delivers killSignal first, then SIGKILL after the grace period', async () => {
      const docker = localDocker();
      const sb = await rtWith(docker, 200).open(spec());
      const ac = new AbortController();
      const running = sb.exec(
        [
          'sh',
          '-c',
          // No busy loop: `sleep` (async, so it ignores SIGINT) keeps running; `wait` resumes.
          "trap 'echo got-int' INT; sleep 300 & touch ready; while :; do wait; done",
        ],
        { timeoutMs: 60_000, signal: ac.signal, killSignal: 'SIGINT' },
      );
      await expect.poll(() => existsSync(path.join(wt, 'ready'))).toBe(true);
      ac.abort();
      const r = await running;
      expect(r.stdout).toContain('got-int'); // SIGINT arrived and was survived, so SIGKILL ended it
      expect(r).toMatchObject({ aborted: true, timedOut: false });
      expect(
        docker
          .argvs()
          .slice(2, 4)
          .map((a) => a[6]),
      ).toEqual(['INT', 'KILL']);
      expect(await execFiles()).toEqual([]);
    });

    it('stops the command when the abort arrives before the wrapper wrote its pid file', async () => {
      const docker = localDocker({ startDelayMs: 300 });
      const logs: string[] = [];
      const sb = await rtWith(docker, 60_000, logs).open(spec());
      const ac = new AbortController();
      const running = sb.exec(['sh', '-c', 'touch ran; sleep 300'], {
        timeoutMs: 60_000,
        signal: ac.signal,
      });
      await Promise.resolve();
      ac.abort(); // the kill runs while `docker exec` has not started the wrapper yet
      const r = await running;
      expect(r).toMatchObject({ aborted: true, code: 143 });
      expect(existsSync(path.join(wt, 'ran'))).toBe(false);
      expect(logs).toEqual([]);
      expect(await execFiles()).toEqual([]);
    });

    it('removes both files when the client was killed after the wrapper started', async () => {
      const docker = localDocker({ clientDetaches: true });
      const sb = await rtWith(docker, 50).open(spec());
      const ac = new AbortController();
      const running = sb.exec(
        ['sh', '-c', "trap '' TERM; sleep 300 & echo $! > child.pid; touch ready; wait"],
        { timeoutMs: 60_000, signal: ac.signal },
      );
      await expect.poll(() => existsSync(path.join(wt, 'ready'))).toBe(true);
      ac.abort();
      expect(await running).toMatchObject({ aborted: true });
      expect(await execFiles()).toEqual([]);
      const pid = await childPid();
      await expect.poll(() => alive(pid)).toBe(false);
      await Promise.all(docker.background);
    });

    it('keeps the cancel marker for a wrapper that starts after the client was killed', async () => {
      const docker = localDocker({ startDelayMs: 400, clientDetaches: true });
      const logs: string[] = [];
      const sb = await rtWith(docker, 20, logs).open(spec());
      const ac = new AbortController();
      const running = sb.exec(['sh', '-c', 'touch ran; sleep 300'], {
        timeoutMs: 60_000,
        signal: ac.signal,
      });
      await Promise.resolve();
      ac.abort();
      expect(await running).toMatchObject({ aborted: true, code: null });
      // The wrapper has not started yet: the marker must still be there for it.
      expect(await execFiles()).toEqual([expect.stringMatching(/\.pid\.cancel$/)]);
      const [late] = await Promise.all(docker.background);
      expect(late).toMatchObject({ code: 143 });
      expect(existsSync(path.join(wt, 'ran'))).toBe(false);
      expect(logs).toEqual([]);
      // The late wrapper saw the marker and removed both files itself.
      expect(await execFiles()).toEqual([]);
    });

    it('logs a failed in-container kill with container, signal and reason', async () => {
      const logs: string[] = [];
      const stub = stubDocker((argv) =>
        argv[0] === 'exec' && argv[6] === 'TERM'
          ? { code: 1, stderr: 'Error response from daemon: container abc is not running' }
          : argv[0] === 'exec' && argv[1] === '-i'
            ? { code: null, timedOut: true }
            : {},
      );
      const rt = new DockerCliRuntime({
        dataDir,
        uid: 1000,
        gid: 1000,
        exec: stub.exec,
        spawnStream: stub.spawnStream,
        log: (l) => logs.push(l),
      });
      const sb = await rt.open(spec());
      const ac = new AbortController();
      const running = sb.exec(['x'], { timeoutMs: 60_000, signal: ac.signal });
      ac.abort();
      await running;
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/SIGTERM.*vibecode-01RUN.*abort.*is not running/);

      logs.length = 0;
      const throwing = stubDocker((argv) =>
        argv[0] === 'exec' && argv[6] === 'INT'
          ? new ExecError('Could not run "docker": EACCES', 'EACCES')
          : argv[0] === 'exec' && argv[1] === '-i'
            ? { code: null }
            : {},
      );
      const sb2 = await new DockerCliRuntime({
        dataDir,
        uid: 1000,
        gid: 1000,
        exec: throwing.exec,
        spawnStream: throwing.spawnStream,
        log: (l) => logs.push(l),
      }).open(spec());
      const ac2 = new AbortController();
      const running2 = sb2.exec(['x'], {
        timeoutMs: 60_000,
        signal: ac2.signal,
        killSignal: 'SIGINT',
      });
      ac2.abort();
      expect(await running2).toMatchObject({ aborted: true });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/SIGINT.*vibecode-01RUN.*EACCES/);
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

  it('maps a daemon that stops mid-attempt to DOCKER_NOT_RUNNING for Sandbox.exec and runOnce', async () => {
    const DOWN =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
    let daemonUp = true;
    const stub = stubDocker((argv) =>
      daemonUp ? {} : { code: argv[0] === 'run' ? 125 : 1, stderr: `${DOWN}\n` },
    );
    const rt = runtime(stub);
    const sb = await rt.open(spec());
    daemonUp = false;
    await expect(sb.exec(['npm', 'test'], T)).rejects.toThrow(DOCKER_NOT_RUNNING);
    await expect(sb.exec(['npm', 'test'], { ...T, onLine: () => {} })).rejects.toThrow(
      DOCKER_NOT_RUNNING,
    );
    await expect(rt.runOnce(spec({ role: 'check' }), ['npm', 'test'], T)).rejects.toThrow(
      DOCKER_NOT_RUNNING,
    );
    // Sandbox.exec confirmed it with the daemon probe; nothing else is tried once it is down.
    const versions = stub.argvs().filter((a) => a[0] === 'version');
    expect(versions).toHaveLength(2);
    expect(stub.argvs().filter((a) => a[2] === 'rm' || a[2] === 'sh')).toEqual([]);
  });

  it('keeps a Sandbox.exec that exits 1 with the daemon message a command result while the daemon answers', async () => {
    const stderr = 'Error: Is the docker daemon running? (printed by the product tests)\n';
    const stub = stubDocker((argv) =>
      argv[0] === 'exec' && argv[1] === '-i' ? { code: 1, stdout: 'x\n', stderr } : {},
    );
    const sb = await runtime(stub).open(spec());
    expect(await sb.exec(['npm', 'test'], T)).toEqual({
      code: 1,
      stdout: 'x\n',
      stderr,
      timedOut: false,
      aborted: false,
      truncated: false,
    });
    expect(await sb.exec(['npm', 'test'], { ...T, onLine: () => {} })).toMatchObject({
      code: 1,
      stderr,
    });
    // The confirmation probe: `docker version` against the server.
    expect(stub.argvs()).toContainEqual(['version', '--format', '{{.Server.Version}}']);
  });

  it('keeps a failing command that merely prints the daemon message a command result', async () => {
    const stub = stubDocker(() => ({
      code: 2,
      stderr: 'Cannot connect to the Docker daemon (from the product tests)\n',
    }));
    const r = await runtime(stub).runOnce(spec({ role: 'check' }), ['npm', 'test'], T);
    expect(r.code).toBe(2);
  });
});
