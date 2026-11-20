import { describe, expect, it } from 'vitest';
import { buildRunArgs, type HostIdentity, type SandboxSpec } from './index.ts';

const HOST: HostIdentity = { uid: 1000, gid: 1001, dataDir: '/srv/vibecode/data' };
const WT = '/srv/vibecode/data/worktrees/01RUN';
const EMPTY = '/srv/vibecode/data/empty';

const AGENT: SandboxSpec = {
  runId: '01JRUNAGENT',
  productId: '01JPROD',
  role: 'agent',
  image: 'vibecode/p-01JPROD:abc',
  worktree: WT,
  readOnly: false,
  network: 'egress',
};
const REVIEWER: SandboxSpec = { ...AGENT, runId: '01JRUNREV', readOnly: true, network: 'none' };
const CHECK: SandboxSpec = { ...AGENT, runId: '01JRUNCHECK', role: 'check', network: 'none' };
const PREVIEW: SandboxSpec = {
  ...AGENT,
  runId: '01JRUNPREV',
  role: 'preview',
  readOnly: true,
  network: 'preview',
  publishPort: 5173,
};

/** Value following each occurrence of `flag`. */
function values(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const next = args[i + 1];
    if (a === flag && next !== undefined) out.push(next);
  });
  return out;
}

function hasPair(args: string[], flag: string, value: string): boolean {
  return values(args, flag).includes(value);
}

const ROLES: [string, SandboxSpec][] = [
  ['agent', AGENT],
  ['reviewer', REVIEWER],
  ['check', CHECK],
  ['preview', PREVIEW],
];

describe('buildRunArgs mandatory flags', () => {
  describe.each(ROLES)('%s', (_name, spec) => {
    const args = buildRunArgs(spec, HOST);

    it.each([['--init'], ['--read-only']])('has %s', (flag) => {
      expect(args).toContain(flag);
    });

    it.each([
      ['--user', '1000:1001'],
      ['--cap-drop', 'ALL'],
      ['--security-opt', 'no-new-privileges:true'],
      ['--memory', '4g'],
      ['--memory-swap', '4g'],
      ['--cpus', '2'],
      ['--pids-limit', '512'],
      ['--restart', 'no'],
      ['--label', 'vibecode.managed=1'],
      ['--label', 'vibecode.product=01JPROD'],
      ['--label', `vibecode.run=${spec.runId}`],
      ['--label', `vibecode.role=${spec.role}`],
      ['--name', `vibecode-${spec.runId}`],
    ])('has %s %s', (flag, value) => {
      expect(hasPair(args, flag, value)).toBe(true);
    });

    it('mounts size-limited tmpfs at /tmp and /home/agent', () => {
      const tmpfs = values(args, '--tmpfs');
      for (const dst of ['/tmp', '/home/agent']) {
        const entry = tmpfs.find((t) => t.startsWith(`${dst}:`));
        expect(entry).toMatch(/(^|[:,])size=\d+[kmg]?(,|$)/);
      }
    });

    it('has exactly one bind: the worktree at /workspace, plus data/empty read-only over .git', () => {
      const mounts = values(args, '--mount');
      const binds = mounts.filter((m) => m.includes('type=bind'));
      expect(binds).toHaveLength(2);
      const ws = binds.filter((m) => m.includes('dst=/workspace,') || m.endsWith('dst=/workspace'));
      expect(ws).toHaveLength(1);
      expect(ws[0]).toContain(`src=${WT}`);
      expect(binds).toContain(`type=bind,src=${EMPTY},dst=/workspace/.git,readonly`);
      expect(values(args, '--volume')).toEqual([]);
      expect(values(args, '-v')).toEqual([]);
    });

    it('ends with the image', () => {
      expect(args.at(-1)).toBe(spec.image);
    });

    it('passes no environment except HOME', () => {
      expect(args).not.toContain('--env-file');
      expect(args).not.toContain('-e');
      expect(values(args, '--env')).toEqual(['HOME=/home/agent']);
      expect(args.join(' ')).not.toMatch(/API_KEY|AUTH_TOKEN/);
    });

    it('never mounts the claude config volume without spec.claude', () => {
      expect(args.join(' ')).not.toContain('vibecode-claude-config');
    });
  });

  it.each([
    ['agent (rw)', AGENT, false],
    ['reviewer', REVIEWER, true],
    ['check', CHECK, false],
    ['preview', PREVIEW, true],
    ['preview even if readOnly is false', { ...PREVIEW, readOnly: false }, true],
  ])('worktree mount for %s is readonly=%s', (_n, spec, ro) => {
    const ws = values(buildRunArgs(spec, HOST), '--mount').find((m) =>
      m.includes(`src=${WT},`),
    );
    expect(ws === `type=bind,src=${WT},dst=/workspace,readonly`).toBe(ro);
    if (!ro) expect(ws).toBe(`type=bind,src=${WT},dst=/workspace`);
  });

  it('mounts the claude config volume only when spec.claude', () => {
    const args = buildRunArgs({ ...AGENT, claude: true }, HOST);
    expect(values(args, '--mount')).toContain(
      'type=volume,src=vibecode-claude-config,dst=/home/agent/.claude',
    );
  });

  it.each([
    ['none', CHECK, 'none', []],
    ['egress', AGENT, 'vibecode-egress', []],
    ['preview', PREVIEW, 'vibecode-preview', ['127.0.0.1::5173']],
  ])('network %s', (_n, spec, network, publish) => {
    const args = buildRunArgs(spec, HOST);
    expect(values(args, '--network')).toEqual([network]);
    expect(values(args, '--publish')).toEqual(publish);
    expect(args).not.toContain('-p');
  });
});

describe('buildRunArgs refuses unsafe specs', () => {
  it.each([
    ['docker.sock as worktree', { ...AGENT, worktree: '/var/run/docker.sock' }],
    ['docker.sock inside worktrees', { ...AGENT, worktree: `${HOST.dataDir}/worktrees/docker.sock` }],
    ['outside data/worktrees', { ...AGENT, worktree: '/home/owner/project' }],
    ['the data dir itself', { ...AGENT, worktree: HOST.dataDir }],
    ['the worktrees dir itself', { ...AGENT, worktree: `${HOST.dataDir}/worktrees` }],
    ['.. escape', { ...AGENT, worktree: `${HOST.dataDir}/worktrees/../repos/x.git` }],
    ['sibling prefix', { ...AGENT, worktree: `${HOST.dataDir}/worktrees-evil/x` }],
    ['relative worktree', { ...AGENT, worktree: 'data/worktrees/x' }],
    ['comma in worktree', { ...AGENT, worktree: `${WT},dst=/etc` }],
    ['bad runId', { ...AGENT, runId: 'x y' }],
    ['runId with slash', { ...AGENT, runId: '../x' }],
    ['bad productId', { ...AGENT, productId: 'a,b' }],
    ['image looking like a flag', { ...AGENT, image: '--privileged' }],
    ['empty image', { ...AGENT, image: '' }],
    ['preview without a port', { ...PREVIEW, publishPort: undefined } as SandboxSpec],
    ['port on a non-preview network', { ...AGENT, publishPort: 3000 }],
    ['port out of range', { ...PREVIEW, publishPort: 70000 }],
    ['preview role on the egress network', { ...PREVIEW, network: 'egress' } as SandboxSpec],
  ])('%s', (_n, spec) => {
    expect(() => buildRunArgs(spec, HOST)).toThrow();
  });

  it.each([
    ['docker.sock in the data dir', { ...HOST, dataDir: '/var/run/docker.sock' }],
    ['relative data dir', { ...HOST, dataDir: 'data' }],
    ['root uid', { ...HOST, uid: 0 }],
    ['negative gid', { ...HOST, gid: -1 }],
  ])('host: %s', (_n, host) => {
    const spec = { ...AGENT, worktree: `${host.dataDir}/worktrees/01RUN` };
    expect(() => buildRunArgs(spec, host)).toThrow();
  });
});
