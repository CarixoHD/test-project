// DockerCliRuntime: the real ContainerRuntime (docs/ARCHITECTURE.md §4.8, ADR 6). It drives the
// docker CLI through util/exec only (argv arrays, never a shell). Every container is created from
// buildRunArgs; before that, the worktree is resolved with realpath and confined to
// realpath(<dataDir>/worktrees), because Docker follows symlinks in bind sources.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectConfigSchema } from '../../shared/agent-results.ts';
import { redactor } from '../security/index.ts';
import {
  exec as defaultExec,
  spawnStream as defaultSpawnStream,
  ExecError,
  type ExecOptions,
  type ExecResult as UtilExecResult,
} from '../util/exec.ts';
import { NETWORKS, WORKSPACE, buildRunArgs, containerName } from './run-args.ts';
import type {
  ContainerRuntime,
  ExecOpts,
  ExecResult,
  HostIdentity,
  ManagedContainer,
  Sandbox,
  SandboxSpec,
} from './types.ts';

export const DOCKER_NOT_RUNNING =
  'Docker is not running: start Docker Desktop or the docker service';
export const BASE_IMAGE = 'vibecode/base';
/** docker/ at the repo root: base.Dockerfile and its build context. */
export const DEFAULT_BASE_IMAGE_DIR = path.resolve(import.meta.dirname, '../../../docker');

const MANAGE_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const MAX_STREAMED = 10 * 1024 * 1024;
const MAX_ERROR_DETAIL = 2000;
const DAEMON_DOWN =
  /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|docker daemon is not running/i;
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type DockerCliRuntimeOptions = {
  dataDir: string;
  uid: number;
  gid: number;
  /** docker CLI binary; default `docker`. */
  docker?: string | undefined;
  /** Directory holding base.Dockerfile; default the repo's docker/. */
  baseImageDir?: string | undefined;
  /** Injected so unit tests can stub util/exec and assert argv. */
  exec?: typeof defaultExec;
  spawnStream?: typeof defaultSpawnStream;
};

export class DockerCliRuntime implements ContainerRuntime {
  readonly #o: DockerCliRuntimeOptions;
  readonly #exec: typeof defaultExec;
  readonly #spawnStream: typeof defaultSpawnStream;
  readonly #docker: string;
  readonly #builds = new Map<string, Promise<void>>();
  #networks: Promise<void> | undefined;

  constructor(o: DockerCliRuntimeOptions) {
    this.#o = o;
    this.#exec = o.exec ?? defaultExec;
    this.#spawnStream = o.spawnStream ?? defaultSpawnStream;
    this.#docker = o.docker ?? 'docker';
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.#exec(this.#docker, ['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 10_000,
      });
      return r.code === 0;
    } catch (err) {
      if (err instanceof ExecError) return false;
      throw err;
    }
  }

  /** Creates the `vibecode-egress` (ICC off) and `vibecode-preview` bridges when missing. */
  async ensureNetworks(): Promise<void> {
    const nets = [
      { name: NETWORKS.egress, opts: ['--opt', 'com.docker.network.bridge.enable_icc=false'] },
      { name: NETWORKS.preview, opts: [] },
    ];
    for (const n of nets) {
      const found = await this.#manage(['network', 'inspect', n.name]);
      if (found.code === 0) continue;
      await this.#manageOk(
        ['network', 'create', '--driver', 'bridge', ...n.opts, n.name],
        `Could not create the Docker network ${n.name}`,
      );
    }
  }

  async ensureImage(p: { productId: string; contextDir: string }): Promise<string> {
    if (!PRODUCT_ID_RE.test(p.productId)) throw new Error(`Invalid productId: ${p.productId}`);
    const dockerfile = path.join(p.contextDir, 'Dockerfile');
    const content = await readIfExists(dockerfile);
    if (content === null) {
      const dir = this.#o.baseImageDir ?? DEFAULT_BASE_IMAGE_DIR;
      await this.#ensureBuilt(BASE_IMAGE, path.join(dir, 'base.Dockerfile'), dir);
      return BASE_IMAGE;
    }
    const hash = await imageHash(p.contextDir, content);
    const tag = `vibecode/p-${p.productId.toLowerCase()}:${hash}`;
    await this.#ensureBuilt(tag, dockerfile, p.contextDir);
    return tag;
  }

  async open(spec: SandboxSpec): Promise<Sandbox> {
    const args = await this.#prepare(spec);
    await this.#manageOk(
      ['run', '--detach', ...args, 'sleep', 'infinity'],
      `Could not start container ${containerName(spec.runId)}`,
    );
    return this.#sandbox(containerName(spec.runId));
  }

  async runOnce(spec: SandboxSpec, argv: readonly string[], o: ExecOpts): Promise<ExecResult> {
    const args = await this.#prepare(spec);
    const r = await this.#run(['run', '--rm', '-i', ...args, ...argv], o);
    // Killing the CLI client does not always stop the container: remove it explicitly.
    if (r.timedOut || r.aborted) await this.remove(containerName(spec.runId));
    return r;
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const r = await this.#manageOk(
      [
        'ps',
        '--all',
        '--no-trunc',
        '--filter',
        'label=vibecode.managed=1',
        '--format',
        '{{.Names}}\t{{.Labels}}',
      ],
      'Could not list Vibecode containers',
    );
    return r.stdout
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((line) => {
        const [name = '', labels = ''] = line.split('\t');
        return { name, labels: parseLabels(labels) };
      });
  }

  async remove(name: string): Promise<void> {
    assertContainerName(name);
    const r = await this.#manage(['rm', '--force', name]);
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
      throw new Error(`Could not remove container ${name}: ${detail(r)}`);
    }
  }

  /** Host port (on 127.0.0.1) that a preview container publishes for `port`. */
  async publishedPort(name: string, port: number): Promise<number> {
    assertContainerName(name);
    const r = await this.#manage(['port', name, `${String(port)}/tcp`]);
    const m = r.code === 0 ? /:(\d+)\s*$/m.exec(r.stdout) : null;
    if (m?.[1] === undefined) {
      throw new Error(`Port ${String(port)} of ${name} is not published: ${detail(r)}`);
    }
    return Number(m[1]);
  }

  /** Confinement + mask file + networks, then buildRunArgs (which stays pure). */
  async #prepare(spec: SandboxSpec): Promise<string[]> {
    const real = await this.#resolve(spec.worktree);
    await ensureMaskFile(real.dataDir);
    const host: HostIdentity = { uid: this.#o.uid, gid: this.#o.gid, dataDir: real.dataDir };
    const args = buildRunArgs({ ...spec, worktree: real.worktree }, host);
    if (spec.network !== 'none') await this.#ensureNetworksOnce();
    return args;
  }

  async #resolve(worktree: string): Promise<{ worktree: string; dataDir: string }> {
    let real: string;
    try {
      real = await realpath(worktree);
    } catch {
      throw new Error(`Refusing to mount ${worktree}: it does not exist`);
    }
    const dataDir = await realpath(this.#o.dataDir);
    const root = await realpath(path.join(this.#o.dataDir, 'worktrees'));
    const rel = path.relative(root, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(
        `Refusing to mount ${worktree}: it resolves to ${real}, outside ${root}. ` +
          'Worktrees must be real directories inside the data dir.',
      );
    }
    return { worktree: real, dataDir };
  }

  #ensureNetworksOnce(): Promise<void> {
    this.#networks ??= this.ensureNetworks().catch((err: unknown) => {
      this.#networks = undefined;
      throw err;
    });
    return this.#networks;
  }

  /** Builds `tag` unless it exists; concurrent callers share one build. */
  #ensureBuilt(tag: string, dockerfile: string, contextDir: string): Promise<void> {
    let build = this.#builds.get(tag);
    if (build === undefined) {
      build = (async () => {
        const found = await this.#manage(['image', 'inspect', '--format', '{{.Id}}', tag]);
        if (found.code === 0) return;
        const r = await this.#manage(
          ['buildx', 'build', '--load', '--tag', tag, '--file', dockerfile, contextDir],
          BUILD_TIMEOUT_MS,
        );
        if (r.code !== 0) throw new Error(`Image build failed for ${tag}: ${detail(r)}`);
      })().finally(() => this.#builds.delete(tag));
      this.#builds.set(tag, build);
    }
    return build;
  }

  #sandbox(name: string): Sandbox {
    return {
      name,
      exec: (argv, o) => this.#run(['exec', '-i', '-w', WORKSPACE, name, ...argv], o),
      close: () => this.remove(name),
    };
  }

  /** A command whose output belongs to the caller (exec / runOnce). */
  async #run(argv: string[], o: ExecOpts): Promise<ExecResult> {
    const base: ExecOptions = {
      input: o.stdin,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      killSignal: 'SIGINT',
    };
    try {
      if (o.onLine === undefined) {
        const r = await this.#exec(this.#docker, argv, base);
        return toResult(r);
      }
      const onLine = o.onLine;
      const out = { stdout: new Collected(), stderr: new Collected() };
      const r = await this.#spawnStream(this.#docker, argv, {
        ...base,
        onLine: (line, stream) => {
          out[stream].add(line);
          onLine(line, stream);
        },
      });
      return {
        code: r.code,
        stdout: out.stdout.text(),
        stderr: out.stderr.text(),
        timedOut: r.timedOut,
        aborted: r.aborted,
        truncated: out.stdout.truncated || out.stderr.truncated,
      };
    } catch (err) {
      throw unavailable(err);
    }
  }

  /** A management command: a stopped daemon becomes DOCKER_NOT_RUNNING. */
  async #manage(argv: string[], timeoutMs = MANAGE_TIMEOUT_MS): Promise<UtilExecResult> {
    let r: UtilExecResult;
    try {
      r = await this.#exec(this.#docker, argv, { timeoutMs });
    } catch (err) {
      throw unavailable(err);
    }
    if (r.code !== 0 && DAEMON_DOWN.test(r.stderr)) throw new Error(DOCKER_NOT_RUNNING);
    return r;
  }

  async #manageOk(argv: string[], what: string): Promise<UtilExecResult> {
    const r = await this.#manage(argv);
    if (r.code !== 0) throw new Error(`${what}: ${detail(r)}`);
    return r;
  }
}

/** `<dataDir>/empty` is bind-mounted over /workspace/.git; it must be an empty regular file. */
async function ensureMaskFile(dataDir: string): Promise<void> {
  const file = path.join(dataDir, 'empty');
  try {
    await writeFile(file, '', { flag: 'wx', mode: 0o644 });
  } catch (err) {
    if (!isCode(err, 'EEXIST')) throw err;
  }
  const st = await lstat(file);
  if (!st.isFile()) {
    throw new Error(`${file} must be an empty regular file: remove it and try again`);
  }
  if (st.size !== 0) await truncate(file, 0);
}

/**
 * sha256 over the Dockerfile and each imageInputs file (path + content, length-prefixed),
 * read from the repo with realpath confinement.
 */
async function imageHash(contextDir: string, dockerfile: Buffer): Promise<string> {
  const h = createHash('sha256');
  const field = (label: string, data: Buffer | null) => {
    h.update(`${label}\0${data === null ? 'missing' : String(data.length)}\0`);
    if (data !== null) h.update(data);
  };
  field('Dockerfile', dockerfile);
  const inputs = [...new Set(await readImageInputs(contextDir))].sort();
  const root = await realpath(contextDir);
  for (const rel of inputs) {
    const file = path.join(contextDir, rel);
    let real: string | null = null;
    try {
      real = await realpath(file);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
    if (real !== null && !real.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Image input ${rel} resolves outside the repository`);
    }
    field(`input:${rel}`, real === null ? null : await readFile(real));
  }
  return h.digest('hex');
}

async function readImageInputs(contextDir: string): Promise<string[]> {
  const raw = await readIfExists(path.join(contextDir, '.vibecode', 'project.json'));
  if (raw === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('.vibecode/project.json is not valid JSON');
  }
  const parsed = ProjectConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`.vibecode/project.json is invalid: ${parsed.error.message}`);
  }
  return parsed.data.imageInputs;
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if (isCode(err, 'ENOENT')) return null;
    throw err;
  }
}

function isCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

function unavailable(err: unknown): unknown {
  return err instanceof ExecError && err.code === 'ENOENT' ? new Error(DOCKER_NOT_RUNNING) : err;
}

function assertContainerName(name: string): void {
  if (!CONTAINER_NAME_RE.test(name)) throw new Error(`Invalid container name: ${name}`);
}

function parseLabels(s: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) labels[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return labels;
}

function detail(r: UtilExecResult): string {
  const text = (r.stderr.trim() || r.stdout.trim() || `exit code ${String(r.code)}`).slice(
    -MAX_ERROR_DETAIL,
  );
  return redactor.redact(text);
}

function toResult(r: UtilExecResult): ExecResult {
  return {
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    aborted: r.aborted,
    truncated: r.truncated,
  };
}

/** Lines delivered by spawnStream, re-joined (each line ends in `\n`), capped at MAX_STREAMED. */
class Collected {
  #parts: string[] = [];
  #size = 0;
  truncated = false;

  add(line: string): void {
    if (this.#size + line.length + 1 > MAX_STREAMED) {
      this.truncated = true;
      return;
    }
    this.#parts.push(`${line}\n`);
    this.#size += line.length + 1;
  }

  text(): string {
    return this.#parts.join('');
  }
}
