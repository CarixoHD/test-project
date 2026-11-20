// Real-Docker checks of the container security policy (ARCHITECTURE §4.8, ADR 6).
// Run with `npm run test:docker`. Without a running Docker daemon these tests FAIL, never skip.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCKER_NOT_RUNNING,
  DockerCliRuntime,
  fileOpArgv,
  type SandboxNetwork,
  type SandboxSpec,
} from '../../src/server/sandbox/index.ts';

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const T = { timeoutMs: 60_000 };
const GIT_POINTER = 'gitdir: /host/repos/p.git/worktrees/x\n';

let base: string;
let dataDir: string;
let rt: DockerCliRuntime;
let image: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vibecode-docker-'));
  dataDir = path.join(base, 'data');
  await mkdir(path.join(dataDir, 'worktrees'), { recursive: true });
  rt = new DockerCliRuntime({ dataDir, uid, gid });
  if (!(await rt.available())) throw new Error(`${DOCKER_NOT_RUNNING} (needed by tests/docker)`);
  const ctx = await mkdtemp(path.join(tmpdir(), 'vibecode-docker-ctx-'));
  image = await rt.ensureImage({ productId: 'dockertest', contextDir: ctx });
  await rm(ctx, { recursive: true, force: true });
}, 15 * 60_000);

afterAll(async () => {
  if (rt !== undefined) {
    for (const c of await rt.listManaged().catch(() => [])) {
      if (c.labels['vibecode.product'] === 'dockertest') await rt.remove(c.name);
    }
  }
  if (base !== undefined) await rm(base, { recursive: true, force: true });
});

async function worktree(): Promise<{ runId: string; dir: string }> {
  const runId = `t${randomBytes(6).toString('hex')}`;
  const dir = path.join(dataDir, 'worktrees', runId);
  await mkdir(dir);
  // What a git worktree has: a .git pointer file the container must never see.
  await writeFile(path.join(dir, '.git'), GIT_POINTER);
  return { runId, dir };
}

async function spec(network: SandboxNetwork = 'none'): Promise<SandboxSpec> {
  const { runId, dir } = await worktree();
  return {
    runId,
    productId: 'dockertest',
    role: network === 'none' ? 'check' : 'agent',
    image,
    worktree: dir,
    readOnly: false,
    network,
  };
}

const sh = (script: string) => ['sh', '-c', script];

describe('DockerCliRuntime against a real Docker daemon', () => {
  it('gives containers no Docker socket', async () => {
    const r = await rt.runOnce(
      await spec(),
      sh('test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && echo none'),
      T,
    );
    expect(r.stdout.trim()).toBe('none');
    expect(r.code).toBe(0);
  });

  it('masks /workspace/.git with an empty read-only file', async () => {
    const s = await spec();
    const r = await rt.runOnce(
      s,
      sh('wc -c < /workspace/.git; echo x > /workspace/.git && echo WROTE; true'),
      T,
    );
    expect(r.stdout.trim()).toBe('0');
    expect(r.stdout).not.toContain('WROTE');
    expect(await readFile(path.join(s.worktree, '.git'), 'utf8')).toBe(GIT_POINTER);
  });

  it('blocks all egress on network none', async () => {
    const s = await spec();
    const probe =
      "require('net').connect({host:'1.1.1.1',port:53,timeout:5000})" +
      ".on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))" +
      ".on('timeout',()=>process.exit(4))";
    const r = await rt.runOnce(s, ['node', '-e', probe], T);
    expect(r.code).not.toBe(0);
    const ifaces = await rt.runOnce({ ...s, runId: `${s.runId}b` }, ['cat', '/proc/net/dev'], T);
    expect(ifaces.stdout).toContain('lo:');
    expect(ifaces.stdout).not.toMatch(/eth\d+:/);
  });

  it('writes files into the worktree owned by the host uid', async () => {
    const s = await spec('egress');
    const sb = await rt.open(s);
    try {
      const op = fileOpArgv({ op: 'write', path: 'src/hello.txt' });
      if (!op.ok) throw new Error(op.reason);
      const r = await sb.exec(op.argv, { stdin: 'hi from the container\n', ...T });
      expect(r.code).toBe(0);
      const host = path.join(s.worktree, 'src', 'hello.txt');
      expect(await readFile(host, 'utf8')).toBe('hi from the container\n');
      const st = await stat(host);
      expect([st.uid, st.gid]).toEqual([uid, gid]);
      const listed = await rt.listManaged();
      expect(listed.map((c) => c.name)).toContain(sb.name);
    } finally {
      await sb.close();
    }
  });

  it('delivers killSignal SIGINT to the process inside the container on abort', async () => {
    const sb = await rt.open(await spec());
    try {
      const ac = new AbortController();
      const lines: string[] = [];
      const running = sb.exec(
        sh('trap "echo got-int; exit 7" INT; echo ready; while true; do sleep 0.1; done'),
        {
          ...T,
          signal: ac.signal,
          killSignal: 'SIGINT',
          onLine: (l) => {
            lines.push(l);
            if (l === 'ready') ac.abort();
          },
        },
      );
      const r = await running;
      expect(r.stdout).toContain('got-int');
      expect(r.code).toBe(7);
      expect(r.aborted).toBe(true);
    } finally {
      await sb.close();
    }
  });
});
