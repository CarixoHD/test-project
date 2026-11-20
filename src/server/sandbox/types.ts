// Container runtime contract (docs/ARCHITECTURE.md §4.8, ADR 6). Implemented by the docker CLI
// runtime and by FakeContainerRuntime (tests and demo mode).

export type SandboxRole = 'agent' | 'check' | 'preview';
export type SandboxNetwork = 'none' | 'egress' | 'preview';

export type SandboxSpec = {
  /** ULID of the run; the container is named `vibecode-<runId>`. */
  runId: string;
  productId: string;
  role: SandboxRole;
  image: string;
  /** Absolute host path of the worktree; must lie inside `<dataDir>/worktrees`. Mounted at /workspace. */
  worktree: string;
  /** Reviewers mount read-only; previews are always read-only. */
  readOnly: boolean;
  network: SandboxNetwork;
  /** Mount the `vibecode-claude-config` volume at /home/agent/.claude (Claude Code backend). */
  claude?: boolean;
  /** Container port to publish on 127.0.0.1 (preview network only). */
  publishPort?: number;
};

export type HostIdentity = { uid: number; gid: number; dataDir: string };

export type OutputStream = 'stdout' | 'stderr';

export type ExecOpts = {
  /** Written to the process's stdin, which is then closed. */
  stdin?: string | undefined;
  /** Required: the process is killed after this many ms. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Called with each (redacted) output line as it arrives. */
  onLine?: ((line: string, stream: OutputStream) => void) | undefined;
};

export type ExecResult = {
  /** Exit code; null when the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
};

export interface Sandbox {
  readonly name: string;
  exec(argv: readonly string[], o: ExecOpts): Promise<ExecResult>;
  close(): Promise<void>;
}

export type DetachedContainer = { name: string; hostPort: number };

export type ManagedContainer = { name: string; labels: Record<string, string> };

export interface ContainerRuntime {
  available(): Promise<boolean>;
  /** Tag `vibecode/p-<id>:<sha256(Dockerfile+imageInputs)>`, or `vibecode/base` without a Dockerfile. */
  ensureImage(p: { productId: string; contextDir: string }): Promise<string>;
  /** Starts a warm container (`sleep infinity`); every tool call is an exec in it. */
  open(spec: SandboxSpec): Promise<Sandbox>;
  /** One-shot container for checks. */
  runOnce(spec: SandboxSpec, argv: readonly string[], o: ExecOpts): Promise<ExecResult>;
  /**
   * Starts a detached container running `argv` (previews: `project.preview.command`) and
   * resolves with the host port docker published on 127.0.0.1 for `spec.publishPort`.
   * Optional so runtimes can add it independently; previews report an error without it.
   */
  runDetached?(spec: SandboxSpec, argv: readonly string[]): Promise<DetachedContainer>;
  listManaged(): Promise<ManagedContainer[]>;
  remove(name: string): Promise<void>;
}
