import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeContainerRuntime,
  fileOpArgv,
  type FileOp,
  type Sandbox,
  type SandboxSpec,
} from './index.ts';

let base: string;
let dataDir: string;
let wt: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibecode-fake-'));
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

function argv(op: FileOp): string[] {
  const r = fileOpArgv(op);
  if (!r.ok) throw new Error(r.reason);
  return r.argv;
}

const T = { timeoutMs: 1000 };

async function openAgent(
  rt = new FakeContainerRuntime({ dataDir }),
  over: Partial<SandboxSpec> = {},
): Promise<Sandbox> {
  return rt.open(spec(over));
}

describe('FakeContainerRuntime lifecycle', () => {
  it('opens a named sandbox, lists it as managed with labels, and forgets it on close/remove', async () => {
    const rt = new FakeContainerRuntime({ dataDir });
    const sb = await rt.open(spec());
    expect(sb.name).toBe('vibecode-01RUN');
    expect(await rt.listManaged()).toEqual([
      {
        name: 'vibecode-01RUN',
        labels: {
          'vibecode.managed': '1',
          'vibecode.product': '01PROD',
          'vibecode.run': '01RUN',
          'vibecode.role': 'agent',
        },
      },
    ]);
    await sb.close();
    expect(await rt.listManaged()).toEqual([]);

    const again = await rt.open(spec());
    await rt.remove(again.name);
    expect(await rt.listManaged()).toEqual([]);
    await expect(again.exec(['true'], T)).rejects.toThrow(/not running/);
  });

  it('refuses a second sandbox with the same name', async () => {
    const rt = new FakeContainerRuntime({ dataDir });
    await rt.open(spec());
    await expect(rt.open(spec())).rejects.toThrow(/already/);
  });

  it.each([
    ['a worktree outside data/worktrees', { worktree: outside }],
    ['the docker socket', { worktree: '/var/run/docker.sock' }],
  ])('enforces the buildRunArgs policy: refuses %s', async (_n, over) => {
    const rt = new FakeContainerRuntime({ dataDir });
    await expect(rt.open(spec(over))).rejects.toThrow();
    expect(await rt.listManaged()).toEqual([]);
  });

  it('reports availability as configured', async () => {
    expect(await new FakeContainerRuntime({ dataDir }).available()).toBe(true);
    expect(await new FakeContainerRuntime({ dataDir, isAvailable: false }).available()).toBe(false);
  });

  it('ensureImage returns a deterministic tag from the Dockerfile, or vibecode/base', async () => {
    const rt = new FakeContainerRuntime({ dataDir });
    const p = { productId: '01PROD', contextDir: wt };
    expect(await rt.ensureImage(p)).toBe('vibecode/base');
    await writeFile(path.join(wt, 'Dockerfile'), 'FROM node:22\n');
    const tag = await rt.ensureImage(p);
    expect(tag).toMatch(/^vibecode\/p-01PROD:[0-9a-f]{12}$/);
    expect(await rt.ensureImage(p)).toBe(tag);
    await writeFile(path.join(wt, 'Dockerfile'), 'FROM node:24\n');
    expect(await rt.ensureImage(p)).not.toBe(tag);
  });
});

describe('FakeContainerRuntime file ops', () => {
  it('writes from stdin (creating directories) and reads back', async () => {
    const sb = await openAgent();
    const w = await sb.exec(argv({ op: 'write', path: 'src/deep/a.ts' }), {
      ...T,
      stdin: 'export const a = 1;\n',
    });
    expect(w.code).toBe(0);
    expect(await readFile(path.join(wt, 'src/deep/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const r = await sb.exec(argv({ op: 'read', path: 'src/deep/a.ts' }), T);
    expect(r).toMatchObject({ code: 0, stdout: 'export const a = 1;\n' });
  });

  it('reading a missing file fails like cat', async () => {
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'read', path: 'nope.ts' }), T);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No such file/);
  });

  it.each([
    ['reviewer (readOnly)', { readOnly: true, network: 'none' }],
    ['preview', { role: 'preview', network: 'preview', publishPort: 3000 }],
  ] as [string, Partial<SandboxSpec>][])('refuses writes in a %s sandbox', async (_n, over) => {
    const sb = await openAgent(undefined, over);
    const r = await sb.exec(argv({ op: 'write', path: 'a.ts' }), { ...T, stdin: 'x' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Read-only/);
    await expect(readFile(path.join(wt, 'a.ts'))).rejects.toThrow();
  });

  it('lists a directory sorted, directories with a slash, .git hidden', async () => {
    await mkdir(path.join(wt, '.git'));
    await mkdir(path.join(wt, 'src'));
    await writeFile(path.join(wt, 'b.txt'), '');
    await writeFile(path.join(wt, '.env.example'), '');
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'list', path: '.' }), T);
    expect(r).toMatchObject({ code: 0, stdout: '.env.example\nb.txt\nsrc/\n' });
  });

  it('greps recursively with /workspace paths, skipping .git; no match exits 1', async () => {
    await mkdir(path.join(wt, '.git'));
    await writeFile(path.join(wt, '.git', 'x'), 'needle\n');
    await mkdir(path.join(wt, 'src'));
    await writeFile(path.join(wt, 'src', 'a.ts'), 'one\nneedle two\nthree needle\n');
    await writeFile(path.join(wt, 'z.md'), 'needle\n');
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'grep', path: '.', pattern: 'need+le' }), T);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      '/workspace/src/a.ts:2:needle two\n/workspace/src/a.ts:3:three needle\n/workspace/z.md:1:needle\n',
    );
    const none = await sb.exec(argv({ op: 'grep', path: 'src', pattern: 'absent' }), T);
    expect(none).toMatchObject({ code: 1, stdout: '' });
  });
});

describe('FakeContainerRuntime confinement', () => {
  it.each([
    [['cat', '--', '/etc/passwd']],
    [['cat', '--', '/workspace/../outside/secret.txt']],
    [['cat', '--', '/workspace/.git']],
    [['ls', '-1Ap', '--', '/']],
  ])('rejects file-op argv with a bad path %j instead of consulting the script', async (bad) => {
    const rt = new FakeContainerRuntime({
      dataDir,
      script: [{ match: () => true, result: { code: 0, stdout: 'scripted' } }],
    });
    const sb = await rt.open(spec());
    const r = await sb.exec(bad, T);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('refuses to read, list or grep through a symlink that escapes the worktree', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(wt, 'link.txt'));
    await symlink(outside, path.join(wt, 'linkdir'));
    const sb = await openAgent();
    for (const op of [
      { op: 'read', path: 'link.txt' },
      { op: 'read', path: 'linkdir/secret.txt' },
      { op: 'list', path: 'linkdir' },
      { op: 'grep', path: 'linkdir', pattern: 'secret' },
    ] as FileOp[]) {
      const r = await sb.exec(argv(op), T);
      expect(r.code, JSON.stringify(op)).not.toBe(0);
      expect(r.stdout).not.toContain('host secret');
    }
  });

  it('does not follow escaping symlinks found while grepping the workspace', async () => {
    await symlink(outside, path.join(wt, 'linkdir'));
    await symlink(path.join(outside, 'secret.txt'), path.join(wt, 'link.txt'));
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'grep', path: '.', pattern: 'secret' }), T);
    expect(r.stdout).not.toContain('host secret');
  });

  it.each([
    ['a symlinked file', 'link.txt'],
    ['a file under a symlinked directory', 'linkdir/new.txt'],
    ['a dangling symlink', 'dangling.txt'],
  ])('refuses to write through %s that escapes the worktree', async (_n, target) => {
    await symlink(path.join(outside, 'secret.txt'), path.join(wt, 'link.txt'));
    await symlink(outside, path.join(wt, 'linkdir'));
    await symlink(path.join(outside, 'created.txt'), path.join(wt, 'dangling.txt'));
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'write', path: target }), { ...T, stdin: 'pwned' });
    expect(r.code).not.toBe(0);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('host secret\n');
    await expect(readFile(path.join(outside, 'new.txt'))).rejects.toThrow();
    await expect(readFile(path.join(outside, 'created.txt'))).rejects.toThrow();
  });

  it('refuses a symlink that points into .git', async () => {
    await mkdir(path.join(wt, '.git'));
    await writeFile(path.join(wt, '.git', 'config'), '[core]\n');
    await symlink(path.join(wt, '.git'), path.join(wt, 'g'));
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'read', path: 'g/config' }), T);
    expect(r.code).not.toBe(0);
    const w = await sb.exec(argv({ op: 'write', path: 'g/hooks/pre-commit' }), {
      ...T,
      stdin: 'x',
    });
    expect(w.code).not.toBe(0);
  });

  it('allows symlinks that stay inside the worktree', async () => {
    await writeFile(path.join(wt, 'real.txt'), 'inside\n');
    await symlink('real.txt', path.join(wt, 'alias.txt'));
    const sb = await openAgent();
    const r = await sb.exec(argv({ op: 'read', path: 'alias.txt' }), T);
    expect(r).toMatchObject({ code: 0, stdout: 'inside\n' });
  });
});

describe('FakeContainerRuntime scripted run', () => {
  it('answers other argv from the first matching script entry and records calls', async () => {
    const rt = new FakeContainerRuntime({
      dataDir,
      script: [
        {
          match: ['npm', 'test'],
          result: { code: 1, stdout: 'line 1\nline 2\n', stderr: 'boom\n' },
        },
        {
          match: (a) => a[0] === 'echo',
          result: (a) => ({ code: 0, stdout: `${a.slice(1).join(' ')}\n` }),
        },
      ],
    });
    const sb = await rt.open(spec());
    const lines: string[] = [];
    const r = await sb.exec(['npm', 'test', '--', 'x'], {
      ...T,
      stdin: 'in',
      onLine: (l, s) => lines.push(`${s}:${l}`),
    });
    expect(r).toEqual({
      code: 1,
      stdout: 'line 1\nline 2\n',
      stderr: 'boom\n',
      timedOut: false,
      aborted: false,
      truncated: false,
    });
    expect(lines).toEqual(['stdout:line 1', 'stdout:line 2', 'stderr:boom']);
    expect((await sb.exec(['echo', 'hi', 'there'], T)).stdout).toBe('hi there\n');
    expect(rt.calls).toContainEqual({
      kind: 'exec',
      name: 'vibecode-01RUN',
      argv: ['npm', 'test', '--', 'x'],
      stdin: 'in',
    });
  });

  it('runs no processes: unscripted argv exits 127 and has no side effects', async () => {
    const sb = await openAgent();
    const r = await sb.exec(['sh', '-c', 'echo pwned > pwned.txt'], T);
    expect(r.code).toBe(127);
    await expect(readFile(path.join(wt, 'pwned.txt'))).rejects.toThrow();
  });

  it('runOnce answers from the script without leaving a managed container', async () => {
    const rt = new FakeContainerRuntime({
      dataDir,
      script: [{ match: ['npm', 'test'], result: { code: 0, stdout: 'ok\n' } }],
    });
    const r = await rt.runOnce(spec({ role: 'check', network: 'none' }), ['npm', 'test'], T);
    expect(r).toMatchObject({ code: 0, stdout: 'ok\n' });
    expect(await rt.listManaged()).toEqual([]);
    expect(rt.calls.map((c) => c.kind)).toEqual(['runOnce']);
  });

  it('returns an aborted result when the signal is already aborted', async () => {
    const sb = await openAgent();
    const ac = new AbortController();
    ac.abort();
    const r = await sb.exec(['npm', 'test'], { ...T, signal: ac.signal });
    expect(r).toMatchObject({ aborted: true, code: null });
  });
});

describe('FakeContainerRuntime detached preview', () => {
  const previewSpec = (): SandboxSpec =>
    spec({ role: 'preview', network: 'preview', readOnly: true, publishPort: 3000 });

  it('serves a small page on 127.0.0.1 until the container is removed', async () => {
    const rt = new FakeContainerRuntime({ dataDir });
    const c = await rt.runDetached(previewSpec(), ['npm', 'start']);
    expect(c.name).toBe('vibecode-01RUN');
    expect(rt.calls).toContainEqual({
      kind: 'runDetached',
      name: 'vibecode-01RUN',
      argv: ['npm', 'start'],
    });
    expect((await rt.listManaged()).map((m) => m.labels['vibecode.role'])).toEqual(['preview']);

    const res = await fetch(`http://127.0.0.1:${String(c.hostPort)}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/preview/i);

    await rt.remove(c.name);
    expect(await rt.listManaged()).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${String(c.hostPort)}/`)).rejects.toThrow();
  });

  it('enforces the run-args policy for detached containers', async () => {
    const rt = new FakeContainerRuntime({ dataDir });
    await expect(rt.runDetached(spec({ worktree: outside }), ['x'])).rejects.toThrow();
    const { publishPort: _omit, ...noPort } = previewSpec();
    await expect(rt.runDetached(noPort, ['x'])).rejects.toThrow(/publishPort/);
    expect(await rt.listManaged()).toEqual([]);
  });
});
