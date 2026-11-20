// Provider-agnostic agent tools (docs/ARCHITECTURE.md §4.6). Every tool runs through
// `sandbox.exec`: file tools use the sandbox file-op protocol (with its path confinement), and `run`
// executes inside the container only. Tools never throw: failures become tool-result text for the
// model, and all output is truncated in the middle to TOOL_OUTPUT_LIMIT characters. The caller's
// AbortSignal reaches every exec, and output the sandbox cut short carries a TRUNCATION_NOTICE.
import { z } from 'zod';
import type { Role } from '../../shared/models.ts';
import { redactor } from '../security/index.ts';
import { fileOpArgv, type ExecResult, type FileOp, type Sandbox } from '../sandbox/index.ts';

export const TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'grep',
  'run',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_OUTPUT_LIMIT = 30_000;
const FILE_OP_TIMEOUT_MS = 30_000;
const RUN_DEFAULT_TIMEOUT_MS = 120_000;
const RUN_MAX_TIMEOUT_MS = 1_800_000;

/** Appended to the tool result when the sandbox reported `truncated` output for any exec. */
const TRUNCATION_NOTICE = '\n[output truncated by sandbox]';

export type ToolContext = {
  /** Aborts the tool's sandbox execs; an aborted `run` returns promptly with an aborted result. */
  signal?: AbortSignal | undefined;
};

export type AgentTool = {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /** Validates `input`, runs the tool and returns result text. Never rejects. */
  execute(input: unknown, sandbox: Sandbox, ctx?: ToolContext): Promise<string>;
};

/** Thrown inside a tool body to end it with an error result for the model. */
class ToolError extends Error {}

function defineTool<S extends z.ZodType>(def: {
  name: ToolName;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, sandbox: Sandbox) => Promise<string>;
}): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    async execute(input, sandbox, ctx = {}) {
      const parsed = def.inputSchema.safeParse(input);
      if (!parsed.success) {
        return truncateMiddle(`Error: invalid input: ${z.prettifyError(parsed.error)}`);
      }
      let truncated = false;
      const scoped: Sandbox = {
        name: sandbox.name,
        close: () => sandbox.close(),
        exec: async (argv, o) => {
          const r = await sandbox.exec(argv, { ...o, signal: ctx.signal });
          if (r.truncated) truncated = true;
          return r;
        },
      };
      let text: string;
      try {
        text = await def.run(parsed.data, scoped);
      } catch (err) {
        // Handled: the failure is reported to the model as the tool result; the run continues.
        const message = err instanceof Error ? err.message : String(err);
        text = `Error: ${redactor.redact(message)}`;
      }
      if (!truncated) return truncateMiddle(text);
      return truncateMiddle(text, TOOL_OUTPUT_LIMIT - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
    },
  };
}

/** Keeps the head and tail of `text`, replacing the middle with a marker; result ≤ `limit` chars. */
export function truncateMiddle(text: string, limit: number = TOOL_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = (n: number): string => `\n[... ${String(n)} chars truncated ...]\n`;
  // The real omitted count is ≤ text.length, so this marker is at least as long as the real one.
  const keep = Math.max(0, limit - marker(text.length).length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}${marker(text.length - keep)}${text.slice(text.length - tail)}`;
}

async function fileOp(sandbox: Sandbox, op: FileOp, stdin?: string): Promise<ExecResult> {
  const argv = fileOpArgv(op);
  if (!argv.ok) throw new ToolError(argv.reason);
  return sandbox.exec(argv.argv, { timeoutMs: FILE_OP_TIMEOUT_MS, stdin });
}

function failure(r: ExecResult): ToolError {
  if (r.timedOut) return new ToolError('timed out');
  if (r.aborted) return new ToolError('aborted');
  const detail = r.stderr.trim() || r.stdout.trim() || `exit code ${String(r.code)}`;
  return new ToolError(detail);
}

async function readText(sandbox: Sandbox, path: string): Promise<string> {
  const r = await fileOp(sandbox, { op: 'read', path });
  if (r.code !== 0) throw failure(r);
  return r.stdout;
}

/** Like `readText`, but refuses a read the sandbox cut short so the caller never writes it back. */
async function readWholeText(sandbox: Sandbox, path: string): Promise<string> {
  const r = await fileOp(sandbox, { op: 'read', path });
  if (r.code !== 0) throw failure(r);
  if (r.truncated) {
    throw new ToolError(
      `${path} is too large to edit with edit_file: its read was truncated by the sandbox, so ` +
        'writing it back would lose the rest of the file. The file was not modified. Use `run` ' +
        '(e.g. sed -i) to edit it in place, or write_file with the full content.',
    );
  }
  return r.stdout;
}

async function writeText(sandbox: Sandbox, path: string, content: string): Promise<void> {
  const r = await fileOp(sandbox, { op: 'write', path }, content);
  if (r.code !== 0) throw failure(r);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

const PATH = z.string().describe('Path relative to the workspace root, e.g. src/index.ts');
const DIR = PATH.optional().describe('Directory relative to the workspace root (default: root)');

const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace.',
  inputSchema: z.strictObject({ path: PATH }),
  run: ({ path }, sb) => readText(sb, path),
});

const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Create or overwrite a file in the workspace; parent directories are created.',
  inputSchema: z.strictObject({ path: PATH, content: z.string() }),
  run: async ({ path, content }, sb) => {
    await writeText(sb, path, content);
    return `Wrote ${String(content.length)} chars to ${path}`;
  },
});

const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace one exact occurrence of `old` with `new` in a file. `old` must match exactly once ' +
    '(include surrounding lines to make it unique).',
  inputSchema: z.strictObject({
    path: PATH,
    old: z.string().min(1).describe('Exact text to replace; must occur exactly once'),
    new: z.string().describe('Replacement text'),
  }),
  run: async ({ path, old, new: replacement }, sb) => {
    const text = await readWholeText(sb, path);
    const count = countOccurrences(text, old);
    if (count === 0) throw new ToolError(`old string not found in ${path}`);
    if (count > 1) {
      throw new ToolError(`old string occurs ${String(count)} times in ${path}; make it unique`);
    }
    const at = text.indexOf(old);
    await writeText(sb, path, text.slice(0, at) + replacement + text.slice(at + old.length));
    return `Edited ${path}`;
  },
});

const listDirTool = defineTool({
  name: 'list_dir',
  description: 'List a workspace directory, one entry per line; directories end in /.',
  inputSchema: z.strictObject({ path: DIR }),
  run: async ({ path }, sb) => {
    const r = await fileOp(sb, { op: 'list', path: path ?? '.' });
    if (r.code !== 0) throw failure(r);
    const entries = r.stdout
      .split('\n')
      .filter((l) => l !== '' && l.replace(/\/$/, '').toLowerCase() !== '.git');
    return entries.length === 0 ? '(empty directory)' : entries.map((e) => `${e}\n`).join('');
  },
});

const grepTool = defineTool({
  name: 'grep',
  description:
    'Search files recursively with an extended regular expression. Output: path:line:text. ' +
    'Binary files and .git are skipped.',
  inputSchema: z.strictObject({ pattern: z.string().min(1), path: DIR }),
  run: async ({ pattern, path }, sb) => {
    const r = await fileOp(sb, { op: 'grep', path: path ?? '.', pattern });
    if (r.code === 1 && r.stderr.trim() === '') return 'No matches.';
    if (r.code !== 0) throw failure(r);
    return r.stdout;
  },
});

const runTool = defineTool({
  name: 'run',
  description:
    'Run a command inside the sandbox container (working directory /workspace). Pass `command` ' +
    '(run with bash -lc) or `argv` (run directly). Returns the exit code, stdout and stderr.',
  inputSchema: z
    .strictObject({
      command: z.string().min(1).optional().describe('Shell command, run as bash -lc'),
      argv: z.array(z.string()).min(1).optional().describe('Program and arguments'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(RUN_MAX_TIMEOUT_MS)
        .optional()
        .describe(`Timeout in ms (default ${String(RUN_DEFAULT_TIMEOUT_MS)})`),
    })
    .refine((i) => (i.command === undefined) !== (i.argv === undefined), {
      message: 'pass exactly one of command or argv',
    }),
  run: async ({ command, argv, timeoutMs }, sb) => {
    const timeout = timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS;
    const cmd = command === undefined ? (argv ?? []) : ['bash', '-lc', command];
    const r = await sb.exec(cmd, { timeoutMs: timeout });
    const status = r.timedOut
      ? `timed out after ${String(timeout)} ms`
      : r.aborted
        ? 'aborted'
        : `exit code: ${String(r.code)}`;
    return `${status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
  },
});

export const agentTools: readonly AgentTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  grepTool,
  runTool,
];

const ROLE_TOOLS: Record<Role, readonly ToolName[]> = {
  implementer: TOOL_NAMES,
  orchestrator: TOOL_NAMES,
  reviewer: ['read_file', 'list_dir', 'grep', 'run'],
  sparring: [],
  utility: [],
};

export function toolsForRole(role: Role): AgentTool[] {
  const allowed = ROLE_TOOLS[role];
  return agentTools.filter((t) => allowed.includes(t.name));
}
