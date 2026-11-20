import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeContainerRuntime,
  type ExecOpts,
  type FakeRunRule,
  type Sandbox,
  type SandboxSpec,
} from '../sandbox/index.ts';
import {
  TOOL_NAMES,
  TOOL_OUTPUT_LIMIT,
  agentTools,
  toolsForRole,
  truncateMiddle,
  type AgentTool,
  type ToolName,
} from './index.ts';

let base: string;
let dataDir: string;
let wt: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibecode-tools-'));
  dataDir = path.join(base, 'data');
  wt = path.join(dataDir, 'worktrees', '01RUN');
  outside = path.join(base, 'outside');
  await mkdir(wt, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'host secret\n');
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
    network: 'egress',
    ...over,
  };
}

async function open(
  script: readonly FakeRunRule[] = [],
  over: Partial<SandboxSpec> = {},
): Promise<{ rt: FakeContainerRuntime; sb: Sandbox }> {
  const rt = new FakeContainerRuntime({ dataDir, script });
  return { rt, sb: await rt.open(spec(over)) };
}

function tool(name: ToolName): AgentTool {
  const t = agentTools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

const file = (rel: string): Promise<string> => readFile(path.join(wt, rel), 'utf8');

describe('tool definitions', () => {
  it('defines every tool with a name, description and zod input schema', () => {
    expect(agentTools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of agentTools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.inputSchema.safeParse).toBe('function');
    }
  });

  it('returns invalid input as tool-error text, never throwing', async () => {
    const { sb } = await open();
    const out = await tool('read_file').execute({ nope: 1 }, sb);
    expect(out).toMatch(/^Error: invalid input/);
  });

  it('turns a sandbox failure into tool-error text', async () => {
    const { sb } = await open();
    await sb.close();
    const out = await tool('list_dir').execute({}, sb);
    expect(out).toMatch(/^Error: .*not running/);
  });
});

describe('read_file / write_file', () => {
  it('writes a file (creating directories) and reads it back', async () => {
    const { sb } = await open();
    const w = await tool('write_file').execute(
      { path: 'src/deep/a.ts', content: 'export const a = 1;\n' },
      sb,
    );
    expect(w).toMatch(/Wrote 20 chars to src\/deep\/a.ts/);
    expect(await file('src/deep/a.ts')).toBe('export const a = 1;\n');
    expect(await tool('read_file').execute({ path: 'src/deep/a.ts' }, sb)).toBe(
      'export const a = 1;\n',
    );
  });

  it('reports a missing file as an error', async () => {
    const { sb } = await open();
    expect(await tool('read_file').execute({ path: 'nope.ts' }, sb)).toMatch(
      /^Error: .*No such file/,
    );
  });

  it.each([['../outside/secret.txt'], ['/etc/passwd'], ['.git/config'], ['a/../../x']])(
    'path escape %s is a tool error, not an exception',
    async (p) => {
      const { sb } = await open();
      for (const name of ['read_file', 'list_dir'] as const) {
        expect(await tool(name).execute({ path: p }, sb)).toMatch(/^Error: /);
      }
      expect(await tool('write_file').execute({ path: p, content: 'x' }, sb)).toMatch(/^Error: /);
      expect(await tool('edit_file').execute({ path: p, old: 'a', new: 'b' }, sb)).toMatch(
        /^Error: /,
      );
      expect(await tool('grep').execute({ pattern: 'secret', path: p }, sb)).toMatch(/^Error: /);
    },
  );

  it('refuses to follow a symlink out of the worktree', async () => {
    await symlink(outside, path.join(wt, 'link'));
    const { sb } = await open();
    const out = await tool('read_file').execute({ path: 'link/secret.txt' }, sb);
    expect(out).toMatch(/^Error: .*symlink/);
    expect(out).not.toMatch(/host secret/);
  });

  it('write_file fails with an error on a read-only (reviewer) mount', async () => {
    const { sb } = await open([], { readOnly: true, network: 'none' });
    expect(await tool('write_file').execute({ path: 'a.txt', content: 'x' }, sb)).toMatch(
      /^Error: .*Read-only/,
    );
  });
});

describe('edit_file', () => {
  it('replaces one exact, unique occurrence', async () => {
    await writeFile(path.join(wt, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    const { sb } = await open();
    const out = await tool('edit_file').execute(
      { path: 'a.ts', old: 'const b = 2;', new: 'const b = $&3;' },
      sb,
    );
    expect(out).toMatch(/Edited a.ts/);
    expect(await file('a.ts')).toBe('const a = 1;\nconst b = $&3;\n');
  });

  it('errors when the string is not found, leaving the file unchanged', async () => {
    await writeFile(path.join(wt, 'a.ts'), 'const a = 1;\n');
    const { sb } = await open();
    const out = await tool('edit_file').execute({ path: 'a.ts', old: 'zzz', new: 'y' }, sb);
    expect(out).toMatch(/^Error: .*not found/);
    expect(await file('a.ts')).toBe('const a = 1;\n');
  });

  it('errors when the string is ambiguous, leaving the file unchanged', async () => {
    await writeFile(path.join(wt, 'a.ts'), 'x\nx\n');
    const { sb } = await open();
    const out = await tool('edit_file').execute({ path: 'a.ts', old: 'x', new: 'y' }, sb);
    expect(out).toMatch(/^Error: .*2 times/);
    expect(await file('a.ts')).toBe('x\nx\n');
  });

  it('rejects an empty search string', async () => {
    await writeFile(path.join(wt, 'a.ts'), 'x\n');
    const { sb } = await open();
    expect(await tool('edit_file').execute({ path: 'a.ts', old: '', new: 'y' }, sb)).toMatch(
      /^Error: invalid input/,
    );
  });

  it('errors when the file does not exist', async () => {
    const { sb } = await open();
    expect(await tool('edit_file').execute({ path: 'no.ts', old: 'a', new: 'b' }, sb)).toMatch(
      /^Error: .*No such file/,
    );
  });
});

describe('list_dir', () => {
  it('lists the workspace root by default, directories with a trailing slash', async () => {
    await mkdir(path.join(wt, 'src'));
    await writeFile(path.join(wt, 'b.txt'), '');
    const { sb } = await open();
    expect(await tool('list_dir').execute({}, sb)).toBe('b.txt\nsrc/\n');
    expect(await tool('list_dir').execute({ path: 'src' }, sb)).toBe('(empty directory)');
  });
});

describe('grep', () => {
  it('finds matches recursively with workspace-relative paths', async () => {
    await mkdir(path.join(wt, 'src'));
    await writeFile(path.join(wt, 'src/a.ts'), 'foo\nbar\nfoo2\n');
    const { sb } = await open();
    expect(await tool('grep').execute({ pattern: 'foo' }, sb)).toBe(
      '/workspace/src/a.ts:1:foo\n/workspace/src/a.ts:3:foo2\n',
    );
    expect(await tool('grep').execute({ pattern: 'bar', path: 'src' }, sb)).toBe(
      '/workspace/src/a.ts:2:bar\n',
    );
  });

  it('reports no matches as a plain result, not an error', async () => {
    await writeFile(path.join(wt, 'a.ts'), 'x\n');
    const { sb } = await open();
    expect(await tool('grep').execute({ pattern: 'zzz' }, sb)).toBe('No matches.');
  });
});

describe('run', () => {
  function recording(sb: Sandbox): { sb: Sandbox; opts: ExecOpts[] } {
    const opts: ExecOpts[] = [];
    return {
      opts,
      sb: {
        name: sb.name,
        close: () => sb.close(),
        exec: (argv, o) => {
          opts.push(o);
          return sb.exec(argv, o);
        },
      },
    };
  }

  it('runs a command string as bash -lc inside the container with a timeout', async () => {
    const { rt, sb } = await open([
      { match: ['bash', '-lc'], result: { code: 0, stdout: 'ok\n', stderr: 'warn\n' } },
    ]);
    const rec = recording(sb);
    const out = await tool('run').execute(
      { command: 'npm test && echo ok', timeoutMs: 5000 },
      rec.sb,
    );
    expect(rt.calls.at(-1)).toMatchObject({
      kind: 'exec',
      argv: ['bash', '-lc', 'npm test && echo ok'],
    });
    expect(rec.opts[0]?.timeoutMs).toBe(5000);
    expect(out).toContain('exit code: 0');
    expect(out).toContain('ok');
    expect(out).toContain('warn');
  });

  it('runs an argv array as-is, with a default timeout', async () => {
    const { rt, sb } = await open([
      { match: ['npm', 'test'], result: { code: 1, stdout: 'FAIL' } },
    ]);
    const rec = recording(sb);
    const out = await tool('run').execute({ argv: ['npm', 'test'] }, rec.sb);
    expect(rt.calls.at(-1)).toMatchObject({ kind: 'exec', argv: ['npm', 'test'] });
    expect(rec.opts[0]?.timeoutMs).toBeGreaterThan(0);
    expect(out).toContain('exit code: 1');
    expect(out).toContain('FAIL');
  });

  it('requires exactly one of command or argv', async () => {
    const { sb } = await open();
    expect(await tool('run').execute({}, sb)).toMatch(/^Error: invalid input/);
    expect(await tool('run').execute({ command: 'ls', argv: ['ls'] }, sb)).toMatch(
      /^Error: invalid input/,
    );
  });

  it('reports a timeout', async () => {
    const { sb } = await open();
    const timedOut: Sandbox = {
      name: sb.name,
      close: () => sb.close(),
      exec: () =>
        Promise.resolve({
          code: null,
          stdout: 'partial',
          stderr: '',
          timedOut: true,
          aborted: false,
          truncated: false,
        }),
    };
    const out = await tool('run').execute({ command: 'sleep 999', timeoutMs: 1000 }, timedOut);
    expect(out).toMatch(/timed out after 1000 ms/);
    expect(out).toContain('partial');
  });

  /** A fake sandbox whose commands run until their timeout or until `signal` aborts. */
  function slow(sb: Sandbox): Sandbox {
    return {
      name: sb.name,
      close: () => sb.close(),
      exec: (argv, o) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            sb.exec(argv, o).then(resolve, reject);
          }, o.timeoutMs);
          o.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            // The FakeContainerRuntime reports an aborted result for an aborted signal.
            sb.exec(argv, o).then(resolve, reject);
          });
        }),
    };
  }

  it('returns promptly with an aborted result when the signal aborts during a long run', async () => {
    const { sb } = await open([{ match: ['bash', '-lc'], result: { code: 0, stdout: 'done' } }]);
    const controller = new AbortController();
    const pending = tool('run').execute({ command: 'sleep 600', timeoutMs: 600_000 }, slow(sb), {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 10);
    const out = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 2_000)),
    ]);
    expect(out).toMatch(/aborted/);
    expect(out).not.toContain('done');
  });

  it('forwards the signal to file operations', async () => {
    await writeFile(path.join(wt, 'a.txt'), 'x');
    const { sb } = await open();
    const rec = recording(sb);
    const controller = new AbortController();
    await tool('read_file').execute({ path: 'a.txt' }, rec.sb, { signal: controller.signal });
    expect(rec.opts[0]?.signal).toBe(controller.signal);
  });
});

describe('sandbox output truncation notice', () => {
  function truncating(sb: Sandbox): Sandbox {
    return {
      name: sb.name,
      close: () => sb.close(),
      exec: async (argv, o) => ({ ...(await sb.exec(argv, o)), truncated: true }),
    };
  }

  it('tells the model when successful run output was truncated by the sandbox', async () => {
    const { sb } = await open([{ match: ['bash', '-lc'], result: { code: 0, stdout: 'head' } }]);
    const out = await tool('run').execute({ command: 'yes' }, truncating(sb));
    expect(out).toContain('exit code: 0');
    expect(out).toContain('[output truncated by sandbox]');
  });

  it('tells the model when failing run output was truncated by the sandbox', async () => {
    const { sb } = await open([{ match: ['bash', '-lc'], result: { code: 2, stderr: 'boom' } }]);
    const out = await tool('run').execute({ command: 'yes >&2; exit 2' }, truncating(sb));
    expect(out).toContain('exit code: 2');
    expect(out).toContain('[output truncated by sandbox]');
  });

  it('tells the model when file-op output was truncated, on success and failure', async () => {
    await writeFile(path.join(wt, 'a.txt'), 'content');
    const { sb } = await open();
    const ok = await tool('read_file').execute({ path: 'a.txt' }, truncating(sb));
    expect(ok).toContain('content');
    expect(ok).toContain('[output truncated by sandbox]');
    const failed = await tool('read_file').execute({ path: 'missing.txt' }, truncating(sb));
    expect(failed).toMatch(/^Error:/);
    expect(failed).toContain('[output truncated by sandbox]');
  });

  it('edit_file refuses to write when the read was truncated, leaving the file unchanged', async () => {
    const original = `start\n${'x'.repeat(100)}\nend\n`;
    await writeFile(path.join(wt, 'big.txt'), original);
    const { sb } = await open();
    const writes: string[][] = [];
    // Simulates the sandbox output cap: `cat` returns only the head of the file, flagged truncated.
    const capped: Sandbox = {
      name: sb.name,
      close: () => sb.close(),
      exec: async (argv, o) => {
        const r = await sb.exec(argv, o);
        if (argv[0] !== 'cat') {
          writes.push([...argv]);
          return r;
        }
        return { ...r, stdout: r.stdout.slice(0, 20), truncated: true };
      },
    };
    const out = await tool('edit_file').execute(
      { path: 'big.txt', old: 'start', new: 'begin' },
      capped,
    );
    expect(out).toMatch(/^Error:/);
    expect(out).toContain('truncated');
    expect(out).toMatch(/write_file|run/);
    expect(writes).toEqual([]);
    expect(await file('big.txt')).toBe(original);
  });

  it('adds no notice when the output was not truncated', async () => {
    const { sb } = await open([{ match: ['bash', '-lc'], result: { code: 0, stdout: 'ok' } }]);
    expect(await tool('run').execute({ command: 'true' }, sb)).not.toContain('truncated');
  });
});

describe('output truncation', () => {
  it('leaves short output alone', () => {
    expect(truncateMiddle('abc')).toBe('abc');
    expect(truncateMiddle('x'.repeat(TOOL_OUTPUT_LIMIT))).toHaveLength(TOOL_OUTPUT_LIMIT);
  });

  it('keeps head and tail of long output with a marker, within 30k chars', () => {
    const text = `HEAD${'m'.repeat(50_000)}TAIL`;
    const out = truncateMiddle(text);
    expect(TOOL_OUTPUT_LIMIT).toBe(30_000);
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toMatch(/\[\.\.\. \d+ chars truncated \.\.\.\]/);
  });

  it('applies to tool output', async () => {
    await writeFile(path.join(wt, 'big.txt'), `START${'z'.repeat(40_000)}END`);
    const { sb } = await open();
    const out = await tool('read_file').execute({ path: 'big.txt' }, sb);
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out.startsWith('START')).toBe(true);
    expect(out.endsWith('END')).toBe(true);
    expect(out).toContain('chars truncated');
  });
});

describe('toolsForRole', () => {
  const names = (role: Parameters<typeof toolsForRole>[0]): string[] =>
    toolsForRole(role).map((t) => t.name);

  it.each([['implementer'], ['orchestrator']] as const)('%s gets all tools', (role) => {
    expect(names(role)).toEqual([...TOOL_NAMES]);
  });

  it('reviewer gets read_file, list_dir, grep, run and no write/edit', () => {
    expect(names('reviewer')).toEqual(['read_file', 'list_dir', 'grep', 'run']);
    expect(names('reviewer')).not.toContain('write_file');
    expect(names('reviewer')).not.toContain('edit_file');
  });

  it.each([['sparring'], ['utility']] as const)('%s gets no tools', (role) => {
    expect(names(role)).toEqual([]);
  });
});
