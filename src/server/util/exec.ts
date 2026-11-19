// The ONLY module allowed to import node:child_process (ESLint enforces this; CODING_STANDARDS §4).
// Processes are started with argv arrays and never through a shell. All captured output and
// every error message passes through the process-wide redactor (CODING_STANDARDS §7).
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { redactor } from '../security/index.ts';

export type OutputStream = 'stdout' | 'stderr';

export type ExecOptions = {
  cwd?: string | undefined;
  /** Merged over the inherited process.env; a key set to `undefined` removes that variable. */
  env?: Record<string, string | undefined> | undefined;
  /** Written to stdin, which is then closed. Without input, stdin is closed immediately. */
  input?: string | Uint8Array | undefined;
  /** Required: the process tree is killed after this many ms (sets `timedOut`). */
  timeoutMs: number;
  /** Aborting kills the process tree with `killSignal` (sets `aborted`). */
  signal?: AbortSignal | undefined;
  /** Signal sent on abort or timeout; default SIGTERM. Use SIGINT to let Claude Code end its turn. */
  killSignal?: NodeJS.Signals | undefined;
  /** If the process is still alive this long after `killSignal`, it gets SIGKILL; default 5000. */
  killGraceMs?: number | undefined;
  /** Max characters kept per captured stream (exec) or per line (spawnStream); default 10 MiB. */
  maxBuffer?: number | undefined;
};

export type RunOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
};

export type ExecResult = RunOutcome & { stdout: string; stderr: string; truncated: boolean };

export type StreamOptions = ExecOptions & {
  /** Called with each redacted line (without the trailing newline / CRLF). */
  onLine: (line: string, stream: OutputStream) => void;
};

/** Thrown when a process cannot be started. The message is redacted; `cause` is deliberately omitted. */
export class ExecError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(redactor.redact(message));
    this.name = 'ExecError';
    this.code = code;
  }
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Extra bytes captured past maxBuffer, so a secret straddling the maxBuffer-th character is masked, not dropped. */
const REDACT_MARGIN = 4096;
const MAX_COMMAND_IN_MESSAGE = 500;
const IS_POSIX = process.platform !== 'win32';

/** Runs `cmd` with `argv` (no shell) and captures its redacted output. Non-zero exit is not an error. */
export async function exec(
  cmd: string,
  argv: readonly string[],
  o: ExecOptions,
): Promise<ExecResult> {
  const maxBuffer = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const out = { stdout: new Capture(maxBuffer), stderr: new Capture(maxBuffer) };
  const outcome = await run(cmd, argv, o, {
    data: (stream, chunk) => out[stream].push(chunk),
    end: () => {},
  });
  const stdout = out.stdout.text();
  const stderr = out.stderr.text();
  return {
    ...outcome,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

/** Runs a long-lived process (no shell), delivering redacted output line by line. */
export async function spawnStream(
  cmd: string,
  argv: readonly string[],
  o: StreamOptions,
): Promise<RunOutcome> {
  const maxLine = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const lines = {
    stdout: new LineSplitter(maxLine, (l) => o.onLine(l, 'stdout')),
    stderr: new LineSplitter(maxLine, (l) => o.onLine(l, 'stderr')),
  };
  return run(cmd, argv, o, {
    data: (stream, chunk) => lines[stream].push(chunk),
    end: () => {
      lines.stdout.end();
      lines.stderr.end();
    },
  });
}

type Sink = { data: (stream: OutputStream, chunk: Buffer) => void; end: () => void };

function run(
  cmd: string,
  argv: readonly string[],
  o: ExecOptions,
  sink: Sink,
): Promise<RunOutcome> {
  validate(cmd, o);
  if (o.signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, timedOut: false, aborted: true });
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, argv, {
        cwd: o.cwd,
        env: buildEnv(o.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        // Own process group, so timeout/abort can signal the whole tree (see TreeKiller).
        // Trade-off: a terminal Ctrl-C/SIGHUP to the server no longer reaches the child, and if
        // the server dies, running children are orphaned. Long-lived ones (agents) run in
        // containers that recovery removes at boot; the callers own anything else.
        detached: IS_POSIX,
        windowsHide: true,
      });
    } catch (err) {
      reject(startError(cmd, argv, err));
      return;
    }
    supervise(child, cmd, argv, o, sink).then(resolve, reject);
  });
}

function supervise(
  child: ChildProcess,
  cmd: string,
  argv: readonly string[],
  o: ExecOptions,
  sink: Sink,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const state = { timedOut: false, aborted: false, failure: undefined as unknown };
    const killer = new TreeKiller(
      child,
      o.killSignal ?? 'SIGTERM',
      o.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    );
    const fail = (err: unknown): void => {
      state.failure ??= err;
      killer.terminate();
    };
    const onAbort = (): void => {
      if (!state.timedOut) state.aborted = true;
      killer.terminate();
    };
    const timer = setTimeout(() => {
      if (!state.aborted) state.timedOut = true;
      killer.terminate();
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const guard = (stream: OutputStream) => (chunk: Buffer) => {
      try {
        sink.data(stream, chunk);
      } catch (err) {
        fail(err);
      }
    };
    child.stdout?.on('data', guard('stdout'));
    child.stderr?.on('data', guard('stderr'));
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE: the child exited or closed stdin without reading all input; nothing left to deliver.
      if (err.code !== 'EPIPE') fail(startError(cmd, argv, err));
    });
    child.stdin?.end(o.input);

    let settled = false;
    child.on('error', (err) => {
      // Before spawn (pid undefined) this is a start failure, e.g. ENOENT; 'close' may not follow.
      if (child.pid !== undefined) return fail(startError(cmd, argv, err));
      if (settled) return;
      settled = true;
      cleanup();
      reject(startError(cmd, argv, err));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        sink.end();
      } catch (err) {
        state.failure ??= err;
      }
      if (state.failure !== undefined) return reject(state.failure);
      resolve({ code, signal, timedOut: state.timedOut, aborted: state.aborted });
    });

    function cleanup(): void {
      clearTimeout(timer);
      killer.dispose();
      o.signal?.removeEventListener('abort', onAbort);
    }
  });
}

/** Sends the kill signal to the child's process group, then SIGKILL after a grace period. */
class TreeKiller {
  #child: ChildProcess;
  #signal: NodeJS.Signals;
  #graceMs: number;
  #graceTimer: NodeJS.Timeout | undefined;
  #isTerminating = false;
  #isDisposed = false;

  constructor(child: ChildProcess, signal: NodeJS.Signals, graceMs: number) {
    this.#child = child;
    this.#signal = signal;
    this.#graceMs = graceMs;
  }

  terminate(): void {
    if (this.#isTerminating || this.#isDisposed) return;
    this.#isTerminating = true;
    this.#send(this.#signal);
    this.#graceTimer = setTimeout(() => this.#send('SIGKILL'), this.#graceMs);
  }

  dispose(): void {
    this.#isDisposed = true;
    clearTimeout(this.#graceTimer);
  }

  #send(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined || this.#isDisposed) return;
    if (!IS_POSIX) {
      this.#child.kill(signal);
      return;
    }
    try {
      // Negative pid = the whole process group. The group id cannot be reused while any member
      // is alive, and we stop signalling once the pipes close.
      process.kill(-pid, signal);
    } catch (err) {
      // ESRCH: the group is already gone, so there is nothing left to kill.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') this.#child.kill(signal);
    }
  }
}

/** Collects one output stream with a bounded buffer; redacts before cutting to maxBuffer. */
class Capture {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #limit: number;
  #isTruncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.#limit + REDACT_MARGIN - this.#bytes;
    if (chunk.length > room) this.#isTruncated = true;
    if (room <= 0) return;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.#chunks.push(kept);
    this.#bytes += kept.length;
  }

  text(): { text: string; truncated: boolean } {
    const bytes = Buffer.concat(this.#chunks);
    if (!this.#isTruncated) return this.#cap(redactor.redact(bytes.toString('utf8')), false);
    // The raw bytes were cut, possibly inside a character or a secret. Drop the incomplete
    // character (decoder.write holds it back) and any tail that may begin a secret.
    const decoded = new StringDecoder('utf8').write(bytes);
    return this.#cap(redactor.redact(decoded.slice(0, redactor.safeBoundary(decoded))), true);
  }

  /** Cutting redacted text is safe: every complete secret in it is already masked. */
  #cap(text: string, truncated: boolean): { text: string; truncated: boolean } {
    if (text.length <= this.#limit) return { text, truncated };
    return { text: text.slice(0, this.#limit), truncated: true };
  }
}

/** Splits a byte stream into redacted lines (LF or CRLF); over-long lines are emitted in pieces. */
class LineSplitter {
  #decoder = new StringDecoder('utf8');
  #pending = '';
  #maxLine: number;
  #emit: (line: string) => void;

  constructor(maxLine: number, emit: (line: string) => void) {
    this.#maxLine = maxLine;
    this.#emit = emit;
  }

  push(chunk: Buffer): void {
    const parts = (this.#pending + this.#decoder.write(chunk)).split('\n');
    this.#pending = parts.pop() ?? '';
    for (const line of parts) this.#line(line);
    if (this.#pending.length > this.#maxLine) {
      // Emit the over-long line in pieces, holding back a tail that may begin a secret,
      // so a secret is never split across pieces (and so never escapes redaction).
      const cut = redactor.safeBoundary(this.#pending);
      if (cut > 0) this.#emit(redactor.redact(this.#pending.slice(0, cut)));
      this.#pending = this.#pending.slice(cut);
    }
  }

  end(): void {
    const rest = this.#pending + this.#decoder.end();
    this.#pending = '';
    if (rest.length > 0) this.#line(rest);
  }

  #line(raw: string): void {
    this.#emit(redactor.redact(raw.endsWith('\r') ? raw.slice(0, -1) : raw));
  }
}

function validate(cmd: string, o: ExecOptions): void {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    throw new TypeError('exec: command must be a non-empty string');
  }
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0 || o.timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`exec: timeoutMs must be > 0 and <= ${MAX_TIMER_MS}`);
  }
  if (o.killGraceMs !== undefined && !(o.killGraceMs >= 0 && o.killGraceMs <= MAX_TIMER_MS)) {
    throw new RangeError('exec: killGraceMs must be >= 0');
  }
  if (o.maxBuffer !== undefined && !(Number.isInteger(o.maxBuffer) && o.maxBuffer > 0)) {
    throw new RangeError('exec: maxBuffer must be a positive integer');
  }
}

function buildEnv(env: ExecOptions['env']): NodeJS.ProcessEnv {
  if (env === undefined) return process.env;
  const entries = Object.entries({ ...process.env, ...env });
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function startError(cmd: string, argv: readonly string[], err: unknown): ExecError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const detail = err instanceof Error ? err.message : String(err);
  const hint = code === 'ENOENT' ? ' (is it installed and on PATH, and does cwd exist?)' : '';
  // Redact before cutting, so a secret is never left half-visible at the cut.
  let command = redactor.redact([cmd, ...argv].map((a) => JSON.stringify(a)).join(' '));
  if (command.length > MAX_COMMAND_IN_MESSAGE) {
    command = `${command.slice(0, MAX_COMMAND_IN_MESSAGE)}…`;
  }
  // The original error is not attached as `cause`: it carries path/spawnargs unredacted.
  return new ExecError(`Could not run ${command}: ${detail}${hint}`, code);
}
