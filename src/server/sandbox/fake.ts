// FakeContainerRuntime: the ContainerRuntime used by tests and demo mode (ADR 6). It never starts a
// process. File ops (file-ops.ts protocol) are applied to the worktree directly with confinement;
// every other argv is answered from a script. Specs go through buildRunArgs, so the fake enforces
// the same mount policy as the docker runtime.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { redactor } from '../security/index.ts';
import { applyFileOp, type FsResult } from './fake-fs.ts';
import { parseFileOp } from './file-ops.ts';
import { buildRunArgs, containerName, managedLabels } from './run-args.ts';
import type {
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

export type FakeRunResult = { code: number; stdout?: string; stderr?: string };

export type FakeRunRule = {
  /** An argv prefix, or a predicate. The first matching rule answers; rules are reusable. */
  match: readonly string[] | ((argv: readonly string[]) => boolean);
  result: FakeRunResult | ((argv: readonly string[], o: { stdin?: string }) => FakeRunResult);
};

export type FakeCall =
  | { kind: 'exec' | 'runOnce'; name: string; argv: string[]; stdin?: string }
  | { kind: 'runDetached'; name: string; argv: string[] }
  | { kind: 'open' | 'close' | 'remove'; name: string }
  | { kind: 'ensureImage'; productId: string; contextDir: string; claude?: boolean };

export type FakeContainerRuntimeOptions = {
  dataDir: string;
  uid?: number;
  gid?: number;
  script?: readonly FakeRunRule[];
  isAvailable?: boolean;
};

const DEFAULT_ID = 1000;
const NOT_FOUND = 127;
const BASE_IMAGE = 'vibecode/base';
const CLAUDE_IMAGE = 'vibecode/claude-code';
/** What a fake detached (preview) container serves on its published 127.0.0.1 port. */
const PREVIEW_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vibecode preview</title>' +
  '</head><body><h1>Vibecode demo preview</h1><p>This page stands in for the product ' +
  'running from main (fake container runtime).</p></body></html>';

export class FakeContainerRuntime implements ContainerRuntime {
  /** Every call, in order, for assertions. */
  readonly calls: FakeCall[] = [];
  readonly #host: HostIdentity;
  readonly #script: readonly FakeRunRule[];
  readonly #isAvailable: boolean;
  readonly #open = new Map<string, SandboxSpec>();
  /** `docker run` args (buildRunArgs) of every container started, by name. */
  readonly #runArgs = new Map<string, string[]>();
  /** Local page servers of detached containers, closed on remove. */
  readonly #servers = new Map<string, Server>();

  constructor(o: FakeContainerRuntimeOptions) {
    this.#host = { dataDir: o.dataDir, uid: o.uid ?? DEFAULT_ID, gid: o.gid ?? DEFAULT_ID };
    this.#script = o.script ?? [];
    this.#isAvailable = o.isAvailable ?? true;
  }

  available(): Promise<boolean> {
    return Promise.resolve(this.#isAvailable);
  }

  /**
   * `vibecode/p-<id>:<sha256(Dockerfile)[:12]>`, or vibecode/base when there is no Dockerfile.
   * With `claude`: vibecode/claude-code over the base, else `vibecode/p-<id>-claude:<same hash>`.
   */
  async ensureImage(p: EnsureImageParams): Promise<string> {
    const claude = p.claude === true;
    this.calls.push({
      kind: 'ensureImage',
      productId: p.productId,
      contextDir: p.contextDir,
      ...(claude ? { claude } : {}),
    });
    let dockerfile: Buffer;
    try {
      dockerfile = await readFile(path.join(p.contextDir, 'Dockerfile'));
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return claude ? CLAUDE_IMAGE : BASE_IMAGE;
      }
      throw err;
    }
    const hash = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12);
    return `vibecode/p-${p.productId}${claude ? '-claude' : ''}:${hash}`;
  }

  /** The `docker run` args the real runtime would use for container `name` (tests assert on them). */
  runArgs(name: string): string[] | undefined {
    const args = this.#runArgs.get(name);
    return args === undefined ? undefined : [...args];
  }

  async open(spec: SandboxSpec): Promise<Sandbox> {
    await Promise.resolve();
    // Rejects on any policy violation, exactly like the real runtime.
    const args = buildRunArgs(spec, this.#host);
    const name = containerName(spec.runId);
    if (this.#open.has(name)) throw new Error(`Container name ${name} is already in use`);
    this.#open.set(name, spec);
    this.#runArgs.set(name, args);
    this.calls.push({ kind: 'open', name });
    return {
      name,
      exec: (argv, o) => {
        const live = this.#open.get(name);
        if (live === undefined)
          return Promise.reject(new Error(`Container ${name} is not running`));
        this.calls.push({ kind: 'exec', name, ...callArgs(argv, o) });
        return this.#run(live, argv, o);
      },
      close: () => {
        this.calls.push({ kind: 'close', name });
        this.#open.delete(name);
        return Promise.resolve();
      },
    };
  }

  async runOnce(spec: SandboxSpec, argv: readonly string[], o: ExecOpts): Promise<ExecResult> {
    await Promise.resolve();
    this.#runArgs.set(containerName(spec.runId), buildRunArgs(spec, this.#host));
    this.calls.push({ kind: 'runOnce', name: containerName(spec.runId), ...callArgs(argv, o) });
    return this.#run(spec, argv, o);
  }

  /** Runs nothing: serves PREVIEW_PAGE on an ephemeral 127.0.0.1 port (see publishedPort). */
  async runDetached(spec: SandboxSpec, argv: readonly string[]): Promise<DetachedContainer> {
    await Promise.resolve();
    buildRunArgs(spec, this.#host);
    const name = containerName(spec.runId);
    if (this.#open.has(name)) throw new Error(`Container name ${name} is already in use`);
    this.#open.set(name, spec);
    this.calls.push({ kind: 'runDetached', name, argv: [...argv] });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PREVIEW_PAGE);
    });
    this.#servers.set(name, server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
    } catch (err) {
      this.#servers.delete(name);
      this.#open.delete(name);
      throw err;
    }
    return { name };
  }

  /** The port of the local demo page of detached container `name`, standing in for docker's. */
  publishedPort(name: string, port: number): Promise<number> {
    const server = this.#servers.get(name);
    if (server === undefined || this.#open.get(name)?.publishPort !== port) {
      return Promise.reject(new Error(`Port ${String(port)} of ${name} is not published`));
    }
    return Promise.resolve((server.address() as AddressInfo).port);
  }

  listManaged(): Promise<ManagedContainer[]> {
    return Promise.resolve(
      [...this.#open].map(([name, spec]) => ({ name, labels: managedLabels(spec) })),
    );
  }

  async remove(name: string): Promise<void> {
    this.calls.push({ kind: 'remove', name });
    this.#open.delete(name);
    const server = this.#servers.get(name);
    if (server === undefined) return;
    this.#servers.delete(name);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  async #run(spec: SandboxSpec, argv: readonly string[], o: ExecOpts): Promise<ExecResult> {
    if (o.signal?.aborted === true) {
      return {
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: true,
        truncated: false,
      };
    }
    const r = await this.#answer(spec, argv, o);
    const stdout = redactor.redact(r.stdout);
    const stderr = redactor.redact(r.stderr);
    if (o.onLine !== undefined) {
      for (const line of lines(stdout)) o.onLine(line, 'stdout');
      for (const line of lines(stderr)) o.onLine(line, 'stderr');
    }
    return { code: r.code, stdout, stderr, timedOut: false, aborted: false, truncated: false };
  }

  #answer(spec: SandboxSpec, argv: readonly string[], o: ExecOpts): Promise<FsResult> {
    const fileOp = parseFileOp(argv);
    if (fileOp.ok) {
      const readOnly = spec.readOnly || spec.role === 'preview';
      return applyFileOp(spec.worktree, fileOp.op, { stdin: o.stdin, readOnly });
    }
    if (fileOp.isFileOp) {
      return Promise.resolve({ code: 2, stdout: '', stderr: `vibecode: ${fileOp.reason}\n` });
    }
    const rule = this.#script.find((r) => matches(r.match, argv));
    if (rule === undefined) {
      const stderr = `fake: no script entry for ${JSON.stringify(argv)}\n`;
      return Promise.resolve({ code: NOT_FOUND, stdout: '', stderr });
    }
    const res =
      typeof rule.result === 'function'
        ? rule.result(argv, o.stdin === undefined ? {} : { stdin: o.stdin })
        : rule.result;
    return Promise.resolve({ code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
  }
}

function matches(m: FakeRunRule['match'], argv: readonly string[]): boolean {
  if (typeof m === 'function') return m(argv);
  return m.length <= argv.length && m.every((a, i) => argv[i] === a);
}

function callArgs(argv: readonly string[], o: ExecOpts): { argv: string[]; stdin?: string } {
  return o.stdin === undefined ? { argv: [...argv] } : { argv: [...argv], stdin: o.stdin };
}

function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.split(/\r?\n/);
  if (out.at(-1) === '') out.pop();
  return out;
}
