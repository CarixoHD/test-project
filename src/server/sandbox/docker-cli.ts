// DockerCliRuntime: the real ContainerRuntime (docs/ARCHITECTURE.md §4.8, ADR 6). It drives the
// docker CLI through util/exec only (argv arrays, never a shell). Every container is created from
// buildRunArgs; before that, the worktree is resolved with realpath and confined to
// realpath(<dataDir>/worktrees), because Docker follows symlinks in bind sources.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat, truncate, writeFile } from 'node:fs/promises';
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
import {
  AGENT_HOME,
  CLAUDE_CONFIG_VOLUME,
  NETWORKS,
  WORKSPACE,
  buildRunArgs,
  containerName,
} from './run-args.ts';
import type {
  ClaudeLoginCommands,
  ClaudeLoginSource,
  ContainerRuntime,
  DetachedContainer,
  EnsureImageParams,
  ExecOpts,
  ExecResult,
  HostIdentity,
  ManagedContainer,
  Sandbox,
  SandboxSpec,
} from './types.ts';

export const DOCKER_NOT_RUNNING =
  'Docker is not running: start Docker Desktop or the docker service';
/** Repository of the fallback image, tagged `:<content hash>` (see baseImageTag). */
export const BASE_IMAGE = 'vibecode/base';
/**
 * Repository of vibecode/base plus the pinned Claude Code CLI, tagged `:<content hash>` (see
 * claudeImageTag); also the image the owner logs in with (ADR 4).
 */
export const CLAUDE_IMAGE = 'vibecode/claude-code';
const BASE_DOCKERFILE = 'base.Dockerfile';
const CLAUDE_DOCKERFILE = 'claude-code.Dockerfile';
/** docker/ at the repo root: base.Dockerfile, claude-code.Dockerfile and their build context. */
export const DEFAULT_BASE_IMAGE_DIR = path.resolve(import.meta.dirname, '../../../docker');

const MANAGE_TIMEOUT_MS = 60_000;
const SIGNAL_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
/**
 * In-container wrapper around every Sandbox.exec. It records the shell's pid in the file `$1`,
 * gives up if a stop already arrived (cancel marker `$1.cancel`), then execs the argv: same pid,
 * same stdio, same exit code. A `docker exec` process leads its own process group (runc calls
 * setsid), so KILL_SCRIPT can signal the command's whole tree. A signal to the host `docker exec`
 * client is not forwarded into the container (non-TTY), hence this mechanism.
 * A wrapper that finds the marker removes both files itself: it is the last reader of the
 * marker, which matters when it starts after the host gave up on it (see REAP_SCRIPT).
 */
const EXEC_WRAPPER =
  'echo $$ > "$1"; if [ -e "$1.cancel" ]; then rm -f "$1" "$1.cancel"; exit 143; fi; ' +
  'shift; exec "$@"';
/**
 * Run in the container by a separate `docker exec` with `<SIG> <pidFile>`. It writes the cancel
 * marker BEFORE reading the pid file, while the wrapper writes the pid file before checking the
 * marker: so either the wrapper sees the marker and never starts the command, or this sees the
 * pid. It signals the process group, falls back to the pid alone, and succeeds when the process
 * is already gone. It removes no file: the cleanup after the exec settles does (#removeExecFiles).
 */
const KILL_SCRIPT =
  ': > "$2.cancel" || exit 1; pid=$(cat "$2" 2>/dev/null) || exit 0; [ -n "$pid" ] || exit 0; ' +
  'case $pid in *[!0-9]*) echo "bad pid file" >&2; exit 1;; esac; ' +
  'kill -s "$1" -- "-$pid" 2>/dev/null || kill -s "$1" "$pid" 2>/dev/null || ! kill -0 "$pid" 2>/dev/null || exit 1';
/**
 * Cleanup with `<pidFile>` after a stopped exec whose host client we killed: the wrapper may not
 * have started yet and could still start later. No pid file, or one still being written: the
 * wrapper has not checked the marker yet, so the marker stays (that wrapper exits 143 and removes
 * both files itself). A complete pid: the wrapper is past writing it, so SIGKILL it (it was
 * stopped anyway, and the kill scripts already ran) before removing the marker, so it can never
 * get past the check and run the command.
 */
const REAP_SCRIPT =
  'pid=$(cat "$1" 2>/dev/null) || exit 0; case $pid in ""|*[!0-9]*) exit 0;; esac; ' +
  'kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null; rm -f "$1" "$1.cancel"';
const SIGNAL_NAMES = { SIGINT: 'INT', SIGTERM: 'TERM' } as const;
/** The util/exec timeout of the client is a backstop behind our own deadline + grace period. */
const CLIENT_BACKSTOP_MS = 10_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
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
  /** Directory holding base.Dockerfile and claude-code.Dockerfile; default the repo's docker/. */
  baseImageDir?: string | undefined;
  /** After an in-container stop signal, how long until SIGKILL; default 5000. */
  killGraceMs?: number | undefined;
  /** Warnings (failed in-container kills), already redacted; default console.warn. */
  log?: ((line: string) => void) | undefined;
  /** Injected so unit tests can stub util/exec and assert argv. */
  exec?: typeof defaultExec;
  spawnStream?: typeof defaultSpawnStream;
};

/**
 * Tag of the fallback image (ADR 6): `vibecode/base:<sha256[:12]>` over base.Dockerfile and every
 * build-context file or directory it COPYs or ADDs (`--from` stages excluded). Editing any of them
 * yields a new tag, so ensureImage builds it instead of reusing a stale image on the host. The
 * runtime, FakeContainerRuntime, the login commands and `npm run docker:images` all use this.
 */
export async function baseImageTag(imageDir: string): Promise<string> {
  const dockerfile = await readFile(path.join(imageDir, BASE_DOCKERFILE));
  const h = createHash('sha256');
  const field = (label: string, data: Buffer) => {
    h.update(`${label}\0${String(data.length)}\0`);
    h.update(data);
  };
  field(BASE_DOCKERFILE, dockerfile);
  for (const src of copySources(dockerfile.toString('utf8'))) {
    for (const file of await contextFiles(imageDir, src)) {
      field(file, await readFile(path.join(imageDir, file)));
    }
  }
  return `${BASE_IMAGE}:${h.digest('hex').slice(0, 12)}`;
}

/** Build-context sources of the COPY/ADD instructions in a Dockerfile, in order (URLs skipped). */
function copySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const m = /^\s*(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (m?.[1] === undefined) continue;
    let rest = m[1].trim();
    const flags: string[] = [];
    while (rest.startsWith('--')) {
      const [flag = '', ...more] = rest.split(/\s+/);
      flags.push(flag);
      rest = more.join(' ');
    }
    if (flags.some((f) => f.startsWith('--from'))) continue;
    const args = rest.startsWith('[') ? (JSON.parse(rest) as string[]) : rest.split(/\s+/);
    sources.push(...args.slice(0, -1).filter((a) => !/^[a-z]+:\/\//i.test(a)));
  }
  return sources;
}

/** Files under `src` (a file or directory in `imageDir`), relative to `imageDir`, sorted. */
async function contextFiles(imageDir: string, src: string): Promise<string[]> {
  if (/[*?[]/.test(src)) throw new Error(`base.Dockerfile: unsupported COPY pattern ${src}`);
  const rel = path.relative(imageDir, path.resolve(imageDir, src));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`base.Dockerfile: COPY source ${src} is outside ${imageDir}`);
  }
  const full = path.join(imageDir, rel);
  if (!(await stat(full)).isDirectory()) return [rel];
  const entries = await readdir(full, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(imageDir, path.join(e.parentPath, e.name)))
    .sort();
}

/**
 * Tag of the Claude Code image FROM `productImage` (ADR 4): sha256 over the product image tag
 * and claude-code.Dockerfile (its only build-context input: the wrapper is written inline). The
 * base tag is itself a content hash, so a base or CLI pin change yields a new tag and a rebuild.
 * `vibecode/claude-code:<hash>` over the base (baseImageTag), else `vibecode/p-<id>-claude:<hash>`.
 */
export async function claudeImageTag(
  imageDir: string,
  productId: string,
  productImage: string,
): Promise<string> {
  const h = createHash('sha256');
  const field = (label: string, data: Buffer | null) => {
    h.update(`${label}\0${data === null ? 'missing' : String(data.length)}\0`);
    if (data !== null) h.update(data);
  };
  field('from', Buffer.from(productImage));
  field(CLAUDE_DOCKERFILE, await readFile(path.join(imageDir, CLAUDE_DOCKERFILE)));
  if (productImage.startsWith(`${BASE_IMAGE}:`)) {
    return `${CLAUDE_IMAGE}:${h.digest('hex')}`;
  }
  return `vibecode/p-${productId.toLowerCase()}-claude:${h.digest('hex')}`;
}

/**
 * The owner's one-time setup (ADR 4), as shell commands for the host: build the login image
 * (`claudeTag`, FROM `baseTag`, both from the same imageDir), create the volume, and log in as the host uid:gid (the
 * identity agents run as, so they can read the login). `--pull never`: never fetch a
 * look-alike image from a registry.
 */
export function claudeLoginCommands(o: {
  imageDir: string;
  baseTag: string;
  claudeTag: string;
  uid: number;
  gid: number;
}): ClaudeLoginCommands {
  const dir = shellQuote(o.imageDir);
  const file = (name: string) => shellQuote(path.join(o.imageDir, name));
  return {
    build:
      `docker buildx build --load --tag ${o.baseTag} --file ${file(BASE_DOCKERFILE)} ${dir} && ` +
      `docker buildx build --load --tag ${o.claudeTag} --build-arg BASE_IMAGE=${o.baseTag} ` +
      `--file ${file(CLAUDE_DOCKERFILE)} ${dir}`,
    volume: `docker volume create ${CLAUDE_CONFIG_VOLUME}`,
    login:
      `docker run -it --rm --pull never --user ${String(o.uid)}:${String(o.gid)} ` +
      `-v ${CLAUDE_CONFIG_VOLUME}:${AGENT_HOME}/.claude ${o.claudeTag} claude auth login`,
  };
}

/** POSIX single-quoting, only when needed: `/a b` → `'/a b'`, `it's` → `'it'\''s'`. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

export class DockerCliRuntime implements ContainerRuntime, ClaudeLoginSource {
  readonly #o: DockerCliRuntimeOptions;
  readonly #exec: typeof defaultExec;
  readonly #spawnStream: typeof defaultSpawnStream;
  readonly #docker: string;
  readonly #log: (line: string) => void;
  readonly #builds = new Map<string, Promise<void>>();
  #networks: Promise<void> | undefined;

  constructor(o: DockerCliRuntimeOptions) {
    this.#o = o;
    this.#exec = o.exec ?? defaultExec;
    this.#spawnStream = o.spawnStream ?? defaultSpawnStream;
    this.#docker = o.docker ?? 'docker';
    this.#log = o.log ?? ((line: string) => console.warn(line));
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

  async ensureImage(p: EnsureImageParams): Promise<string> {
    if (!PRODUCT_ID_RE.test(p.productId)) throw new Error(`Invalid productId: ${p.productId}`);
    const productImage = await this.#ensureProductImage(p.productId, p.contextDir);
    if (p.claude !== true) return productImage;
    return this.#ensureClaudeImage(p.productId, productImage);
  }

  async #ensureProductImage(productId: string, contextDir: string): Promise<string> {
    const dockerfile = path.join(contextDir, 'Dockerfile');
    const content = await readIfExists(dockerfile);
    if (content === null) {
      const dir = this.#imageDir();
      const tag = await baseImageTag(dir);
      await this.#ensureBuilt(tag, path.join(dir, BASE_DOCKERFILE), dir);
      return tag;
    }
    const hash = await imageHash(contextDir, content);
    const tag = `vibecode/p-${productId.toLowerCase()}:${hash}`;
    await this.#ensureBuilt(tag, dockerfile, contextDir);
    return tag;
  }

  /**
   * The derived image FROM `productImage` with the pinned CLI layered on (ADR 4), tagged by
   * claudeImageTag. Over the base image (baseImageTag) it is `vibecode/claude-code:<hash>`, the login image.
   */
  async #ensureClaudeImage(productId: string, productImage: string): Promise<string> {
    const dir = this.#imageDir();
    const dockerfile = path.join(dir, CLAUDE_DOCKERFILE);
    const tag = await claudeImageTag(dir, productId, productImage);
    await this.#ensureBuilt(tag, dockerfile, dir, ['--build-arg', `BASE_IMAGE=${productImage}`]);
    return tag;
  }

  /** The login setup for this host's uid:gid and the current Claude image tag; runs no docker. */
  async claudeLoginCommands(): Promise<ClaudeLoginCommands> {
    const imageDir = this.#imageDir();
    const baseTag = await baseImageTag(imageDir);
    const claudeTag = await claudeImageTag(imageDir, '', baseTag);
    const { uid, gid } = this.#o;
    return claudeLoginCommands({ imageDir, baseTag, claudeTag, uid, gid });
  }

  #imageDir(): string {
    return this.#o.baseImageDir ?? DEFAULT_BASE_IMAGE_DIR;
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

  /** `docker run --detach` (previews): the command runs until the container is removed. */
  async runDetached(spec: SandboxSpec, argv: readonly string[]): Promise<DetachedContainer> {
    const args = await this.#prepare(spec);
    const name = containerName(spec.runId);
    await this.#manageOk(
      ['run', '--detach', ...args, ...argv],
      `Could not start container ${name}`,
    );
    return { name };
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
  #ensureBuilt(
    tag: string,
    dockerfile: string,
    contextDir: string,
    buildArgs: readonly string[] = [],
  ): Promise<void> {
    let build = this.#builds.get(tag);
    if (build === undefined) {
      build = (async () => {
        const found = await this.#manage(['image', 'inspect', '--format', '{{.Id}}', tag]);
        if (found.code === 0) return;
        const r = await this.#manage(
          [
            'buildx',
            'build',
            '--load',
            '--tag',
            tag,
            ...buildArgs,
            '--file',
            dockerfile,
            contextDir,
          ],
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
      exec: (argv, o) => this.#execInContainer(name, argv, o),
      close: () => this.remove(name),
    };
  }

  /**
   * Every Sandbox.exec runs under EXEC_WRAPPER. On timeout or abort, `killSignal` (default
   * SIGTERM) goes to the command's process group inside the container, then after the grace
   * period SIGKILL there and to the host client. The deadline is ours, not util/exec's, so a
   * timeout takes the same in-container path as an abort.
   */
  async #execInContainer(name: string, argv: readonly string[], o: ExecOpts): Promise<ExecResult> {
    if (o.signal?.aborted === true) return { ...ABORTED };
    const pidFile = `/tmp/vibecode-exec-${randomUUID()}.pid`;
    const firstSignal = SIGNAL_NAMES[o.killSignal ?? 'SIGTERM'];
    const graceMs = this.#o.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const client = new AbortController();
    const kills: Promise<void>[] = [];
    let stoppedBy: 'timeout' | 'abort' | undefined;
    let grace: NodeJS.Timeout | undefined;
    const stop = (why: 'timeout' | 'abort'): void => {
      if (stoppedBy !== undefined) return;
      stoppedBy = why;
      kills.push(this.#signalInContainer(name, pidFile, firstSignal, why));
      grace = setTimeout(() => {
        kills.push(this.#signalInContainer(name, pidFile, 'KILL', why));
        client.abort();
      }, graceMs);
    };
    const onAbort = (): void => stop('abort');
    const deadline = setTimeout(() => stop('timeout'), Math.min(o.timeoutMs, MAX_TIMER_MS));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let r: ExecResult;
    try {
      // If util/exec throws, the docker client never ran, so no file was created to clean up.
      r = await this.#runRaw(
        ['exec', '-i', '-w', WORKSPACE, name, 'sh', '-c', EXEC_WRAPPER, 'sh', pidFile, ...argv],
        {
          ...o,
          signal: client.signal,
          timeoutMs: Math.min(o.timeoutMs + graceMs + CLIENT_BACKSTOP_MS, MAX_TIMER_MS),
        },
        'SIGKILL',
      );
    } finally {
      clearTimeout(deadline);
      clearTimeout(grace);
      o.signal?.removeEventListener('abort', onAbort);
      await Promise.all(kills);
    }
    // A user command's own exit 1 may print the daemon message too: only a failing probe of the
    // daemon makes it DOCKER_NOT_RUNNING. With the daemon down, there is no container to clean.
    if (daemonDown(r) && !(await this.available())) throw new Error(DOCKER_NOT_RUNNING);
    // All kill scripts have finished, so none writes the marker any more. The client killed by
    // us (or by util/exec's backstop) is the only case where the wrapper may still start.
    await this.#removeExecFiles(name, pidFile, r.timedOut || r.aborted);
    return {
      ...r,
      timedOut: stoppedBy === 'timeout' || (stoppedBy === undefined && r.timedOut),
      aborted: stoppedBy === 'abort' || (stoppedBy === undefined && r.aborted),
    };
  }

  /**
   * Removes the exec's pid file and cancel marker from the container's /tmp (a 1g tmpfs that
   * would otherwise collect one file per exec). When the client returned on its own, the wrapper
   * has run and ended, so a plain `rm -f` is safe. When the client was killed, REAP_SCRIPT keeps
   * the marker for a wrapper that has not started yet. Never throws; failures are logged.
   */
  async #removeExecFiles(name: string, pidFile: string, clientKilled: boolean): Promise<void> {
    const argv = clientKilled
      ? ['exec', name, 'sh', '-c', REAP_SCRIPT, 'sh', pidFile]
      : ['exec', name, 'rm', '-f', pidFile, `${pidFile}.cancel`];
    let failure: string;
    try {
      const r = await this.#exec(this.#docker, argv, { timeoutMs: CLEANUP_TIMEOUT_MS });
      if (r.code === 0) return;
      failure = r.timedOut ? 'timed out' : detail(r);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    this.#log(
      redactor.redact(
        `Could not clean up inside container ${name}: removing ${pidFile} and its .cancel ` +
          `marker failed: ${failure}`,
      ),
    );
  }

  /**
   * Signals the exec's process group inside the container (see KILL_SCRIPT). Never throws:
   * the grace-period SIGKILL of the client still applies, but a failure is logged with context.
   */
  async #signalInContainer(name: string, pidFile: string, sig: string, why: string): Promise<void> {
    let failure: string;
    try {
      const r = await this.#exec(
        this.#docker,
        ['exec', name, 'sh', '-c', KILL_SCRIPT, 'sh', sig, pidFile],
        { timeoutMs: SIGNAL_TIMEOUT_MS },
      );
      if (r.code === 0) return;
      failure = r.timedOut ? 'timed out' : detail(r);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    this.#log(
      redactor.redact(
        `Could not send SIG${sig} inside container ${name} (after ${why}) to the process ` +
          `group in ${pidFile}: ${failure}`,
      ),
    );
  }

  /**
   * A `docker run` whose output belongs to the caller (runOnce). A stopped daemon becomes
   * DOCKER_NOT_RUNNING (an infra error), never a command result such as a failed check.
   * Sandbox.exec does the same in #execInContainer, after confirming with a daemon probe.
   */
  async #run(argv: string[], o: ExecOpts): Promise<ExecResult> {
    const r = await this.#runRaw(argv, o, 'SIGINT');
    if (daemonDown(r)) throw new Error(DOCKER_NOT_RUNNING);
    return r;
  }

  async #runRaw(
    argv: string[],
    o: ExecOpts,
    clientKillSignal: NodeJS.Signals,
  ): Promise<ExecResult> {
    const base: ExecOptions = {
      input: o.stdin,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      killSignal: clientKillSignal,
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

/**
 * The docker CLI exits 125 (run) or 1 (exec) with a connection error when the daemon is down.
 * For an exec, exit 1 is also the user command's own: callers there confirm with a probe.
 */
function daemonDown(r: { code: number | null; stderr: string }): boolean {
  return (r.code === 125 || r.code === 1) && DAEMON_DOWN.test(r.stderr);
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

const ABORTED: ExecResult = {
  code: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: true,
  truncated: false,
};

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
