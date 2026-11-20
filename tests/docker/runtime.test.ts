// Real-Docker checks of the container security policy (ARCHITECTURE §4.8, ADR 6).
// Run with `npm run test:docker`. Without a running Docker daemon these tests FAIL, never skip.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCKER_NOT_RUNNING,
  DockerCliRuntime,
  IccUnsupportedError,
  fileOpArgv,
  type SandboxNetwork,
  type SandboxSpec,
} from '../../src/server/sandbox/index.ts';
import { exec } from '../../src/server/util/exec.ts';
import { expectFailsClosed, leftoverProbeNetworks, probeIccOff } from './icc-probe.ts';
import { EGRESS_PROBE, openInterfaces } from './net-probes.ts';

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;
const T = { timeoutMs: 60_000 };
const GIT_POINTER = 'gitdir: /host/repos/p.git/worktrees/x\n';
/** Whether this daemon can create the ICC-off egress network (needs br_netfilter); see icc-probe. */
const ICC_OFF = await probeIccOff();

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

  // Sparring (and reviewers, previews) mount the workspace read-only, so Docker cannot create the
  // /workspace/.git mountpoint itself: a brand-new product's scratch worktree has no .git (#202).
  describe.each([
    ['no .git', 'none'],
    ['a .git file (git worktree)', 'file'],
    ['a .git directory', 'dir'],
  ] as const)('a sandbox on a workspace with %s', (_name, kind) => {
    it.each([true, false])('starts and never exposes the real .git (readOnly %s)', async (ro) => {
      const runId = `t${randomBytes(6).toString('hex')}`;
      const dir = path.join(dataDir, 'worktrees', runId);
      await mkdir(dir);
      await writeFile(path.join(dir, 'README.md'), 'hello\n');
      const gitPath = path.join(dir, '.git');
      if (kind === 'file') await writeFile(gitPath, GIT_POINTER);
      if (kind === 'dir') {
        await mkdir(gitPath);
        await writeFile(path.join(gitPath, 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(path.join(gitPath, 'config'), '[core]\n\tbare = false\n');
      }
      const sb = await rt.open({
        runId,
        productId: 'dockertest',
        role: 'agent',
        image,
        worktree: dir,
        readOnly: ro,
        network: 'none',
      });
      try {
        const r = await sb.exec(
          sh(
            'cat README.md; ' +
              'if [ -d .git ]; then echo "dir $(ls -A .git | wc -l)"; else echo "file $(wc -c < .git)"; fi; ' +
              '(echo x > .git/HEAD) 2>/dev/null && echo WROTE; ' +
              '(echo x > .git/injected) 2>/dev/null && echo WROTE; ' +
              '(echo x > .git) 2>/dev/null && echo WROTE; true',
          ),
          T,
        );
        expect(r.code).toBe(0);
        const lines = r.stdout.trim().split('\n');
        expect(lines[0]).toBe('hello');
        expect(lines[1]).toMatch(/^(dir|file) 0$/);
        expect(r.stdout).not.toContain('WROTE');
      } finally {
        await sb.close();
      }
      if (kind === 'file') expect(await readFile(gitPath, 'utf8')).toBe(GIT_POINTER);
      if (kind === 'dir') {
        expect((await readdir(gitPath)).sort()).toEqual(['HEAD', 'config']);
        expect(await readFile(path.join(gitPath, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
      }
    });
  });

  it('gives network-none containers no interface but loopback (needs no internet)', async () => {
    const r = await rt.runOnce(await spec(), ['cat', '/proc/net/dev'], T);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lo:');
    expect(openInterfaces(r.stdout)).toEqual([]);
  });

  it('blocks egress on network none where a bridge-network control connects', async (ctx) => {
    const blocked = await rt.runOnce(await spec(), ['node', '-e', EGRESS_PROBE], T);
    expect(blocked.code).not.toBe(0);
    // Positive control: the same probe on Docker's default bridge. If that cannot connect
    // either, this host has no egress and the failure above proves nothing.
    const control = await exec(
      'docker',
      ['run', '--rm', '--network', 'bridge', image, 'node', '-e', EGRESS_PROBE],
      T,
    );
    const egressVerifiable = control.code === 0;
    ctx.skip(
      !egressVerifiable,
      `egress NOT verified: the bridge-network control could not reach 1.1.1.1:53 (exit ${String(control.code)}), ` +
        'so this host has no egress; only the structural no-interface test counts',
    );
    await ctx.annotate('bridge control connected to 1.1.1.1:53; network none blocked it');
  });

  // Needs the ICC-off egress network: on a host whose daemon cannot create one (no
  // br_netfilter), the same slot proves the runtime fails closed instead (icc-probe.ts).
  if (ICC_OFF.ok) {
    it('ensureNetworks probes ICC off and leaves no vibecode-icc-probe-* network behind', async () => {
      await rt.ensureNetworks();
      const opts = await exec(
        'docker',
        ['network', 'inspect', '--format', '{{json .Options}}', 'vibecode-egress'],
        T,
      );
      expect(opts.code).toBe(0);
      expect(JSON.parse(opts.stdout)).toMatchObject({
        'com.docker.network.bridge.enable_icc': 'false',
      });
      expect(await leftoverProbeNetworks()).toEqual([]);
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
  } else {
    it('fails closed with the actionable br_netfilter error (host cannot turn ICC off)', async (ctx) => {
      await expectFailsClosed(rt);
      // open() on egress goes through ensureNetworks too: no container starts.
      await expect(rt.open(await spec('egress'))).rejects.toBeInstanceOf(IccUnsupportedError);
      await ctx.annotate(
        'host cannot create an ICC-off bridge: "writes files into the worktree owned by the ' +
          'host uid" (egress network) is replaced by this fail-closed assertion',
      );
    });
  }

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

  it('leaves no process behind in the container after an exec timeout', async () => {
    const sb = await rt.open(await spec());
    try {
      const r = await sb.exec(sh('sleep 300; echo never'), { timeoutMs: 1000 });
      expect(r.timedOut).toBe(true);
      expect(r.stdout).not.toContain('never');
      // `sleep 300` is a child of the exec's shell, so only a process-group kill reaches it.
      const ps = await sb.exec(
        sh('for f in /proc/[0-9]*/cmdline; do tr "\\0" " " < "$f"; echo; done'),
        T,
      );
      expect(ps.code).toBe(0);
      expect(ps.stdout).toContain('sleep infinity');
      expect(ps.stdout).not.toContain('sleep 300');
    } finally {
      await sb.close();
    }
  }, 60_000);

  it('leaves no vibecode-exec pid or cancel file in /tmp after execs end, time out or abort', async () => {
    const sb = await rt.open(await spec());
    try {
      expect(await sb.exec(sh('echo hi'), T)).toMatchObject({ code: 0, stdout: 'hi\n' });
      expect(await sb.exec(sh('exit 3'), T)).toMatchObject({ code: 3 });
      const op = fileOpArgv({ op: 'write', path: 'a.txt' });
      if (!op.ok) throw new Error(op.reason);
      expect(await sb.exec(op.argv, { stdin: 'x', ...T })).toMatchObject({ code: 0 });
      expect(await sb.exec(sh('sleep 300'), { timeoutMs: 500 })).toMatchObject({ timedOut: true });
      const ac = new AbortController();
      const aborted = sb.exec(sh('echo ready; sleep 300'), {
        ...T,
        signal: ac.signal,
        onLine: (l) => {
          if (l === 'ready') ac.abort();
        },
      });
      expect(await aborted).toMatchObject({ aborted: true });
      // Listed with a plain `docker exec`: a Sandbox.exec would see its own pid file.
      const ls = await exec('docker', ['exec', sb.name, 'ls', '-a', '/tmp'], T);
      expect(ls.code).toBe(0);
      expect(ls.stdout.split('\n').filter((f) => f.startsWith('vibecode-exec-'))).toEqual([]);
    } finally {
      await sb.close();
    }
  }, 60_000);

  it('returns a command that exits 1 printing the daemon message as a result while Docker runs', async () => {
    const sb = await rt.open(await spec());
    try {
      const r = await sb.exec(sh('echo "Is the docker daemon running?" >&2; exit 1'), T);
      expect(r).toMatchObject({ code: 1, stderr: 'Is the docker daemon running?\n' });
    } finally {
      await sb.close();
    }
  });
});
