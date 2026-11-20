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

export type EnsureImageParams = {
  productId: string;
  contextDir: string;
  /** Layer the pinned Claude Code CLI on top of the product image (docker/claude-code.Dockerfile). */
  claude?: boolean | undefined;
};

export type HostIdentity = { uid: number; gid: number; dataDir: string };

export type OutputStream = 'stdout' | 'stderr';

export type ExecOpts = {
  /** Written to the process's stdin, which is then closed. */
  stdin?: string | undefined;
  /** Required: the process is killed after this many ms. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Delivered to the process when `signal` aborts; default SIGTERM. Claude Code ends its turn on SIGINT. */
  killSignal?: 'SIGINT' | 'SIGTERM' | undefined;
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

export type DetachedContainer = { name: string };

export type ManagedContainer = { name: string; labels: Record<string, string> };

export interface ContainerRuntime {
  available(): Promise<boolean>;
  /**
   * Tag `vibecode/p-<id>:<sha256(Dockerfile+imageInputs)>`, or without a Dockerfile
   * `vibecode/base:<sha256(base.Dockerfile + the files it COPYs)[:12]>` (baseImageTag), so
   * editing base.Dockerfile rebuilds. With `claude`, the derived Claude Code image FROM that
   * product image: `vibecode/claude-code:<hash>` over the base, else
   * `vibecode/p-<id>-claude:<hash>`, where the hash covers the product image tag and
   * docker/claude-code.Dockerfile, so a CLI pin bump or a new base rebuilds (ADR 4).
   */
  ensureImage(p: EnsureImageParams): Promise<string>;
  /** Starts a warm container (`sleep infinity`); every tool call is an exec in it. */
  open(spec: SandboxSpec): Promise<Sandbox>;
  /** One-shot container for checks. */
  runOnce(spec: SandboxSpec, argv: readonly string[], o: ExecOpts): Promise<ExecResult>;
  /**
   * Starts a detached container running `argv` (previews: `project.preview.command`) that
   * publishes `spec.publishPort` on 127.0.0.1 only; the host port comes from publishedPort.
   */
  runDetached(spec: SandboxSpec, argv: readonly string[]): Promise<DetachedContainer>;
  /** The 127.0.0.1 host port that container `name` publishes for container `port`. */
  publishedPort(name: string, port: number): Promise<number>;
  listManaged(): Promise<ManagedContainer[]>;
  remove(name: string): Promise<void>;
}

/** The owner's one-time Claude Code setup, as shell commands to run on the host (ADR 4). */
export type ClaudeLoginCommands = {
  /** Builds the current `vibecode/base:<hash>` and `vibecode/claude-code:<hash>` login image. */
  build: string;
  /** Creates the `vibecode-claude-config` volume. */
  volume: string;
  /** `docker run … --user <host uid>:<host gid> … vibecode/claude-code:<hash> claude auth login`. */
  login: string;
};

/** Implemented by both runtimes; the HTTP layer serves it to the Settings page. */
export interface ClaudeLoginSource {
  /** Computes the commands for this host's uid:gid and the current Claude image; runs nothing. */
  claudeLoginCommands(): Promise<ClaudeLoginCommands>;
}
