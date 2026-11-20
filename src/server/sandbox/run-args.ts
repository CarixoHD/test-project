// Pure `docker run` argument builder: the single place where the container security policy lives
// (docs/ARCHITECTURE.md §4.8, ADR 6, CODING_STANDARDS §7). Every container MUST be created from it.
import path from 'node:path';
import type { HostIdentity, SandboxSpec } from './types.ts';

export const WORKSPACE = '/workspace';
export const AGENT_HOME = '/home/agent';
export const CLAUDE_CONFIG_VOLUME = 'vibecode-claude-config';
export const NETWORKS = {
  none: 'none',
  egress: 'vibecode-egress',
  preview: 'vibecode-preview',
} as const;
export const MANAGED_LABEL = 'vibecode.managed';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** docker image reference characters; a leading `-` would be read as a flag. */
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
/** Characters that would break or extend the `--mount` CSV syntax. */
const UNSAFE_MOUNT_CHARS = /[,"'=\n\r\0]/;

/** `docker run` options followed by the image; callers add `--detach`/`--rm` before and the command after. */
export function buildRunArgs(spec: SandboxSpec, host: HostIdentity): string[] {
  assertHost(host);
  assertSpec(spec);
  const worktreesDir = path.join(host.dataDir, 'worktrees');
  const emptyFile = path.join(host.dataDir, 'empty');
  assertMountSource(emptyFile);
  assertMountSource(spec.worktree);
  assertInside(spec.worktree, worktreesDir);

  const readOnly = spec.readOnly || spec.role === 'preview';
  const mounts = [
    `type=bind,src=${path.resolve(spec.worktree)},dst=${WORKSPACE}${readOnly ? ',readonly' : ''}`,
    `type=bind,src=${emptyFile},dst=${WORKSPACE}/.git,readonly`,
  ];
  if (spec.claude === true) {
    mounts.push(`type=volume,src=${CLAUDE_CONFIG_VOLUME},dst=${AGENT_HOME}/.claude`);
  }

  return [
    '--init',
    ...['--name', containerName(spec.runId)],
    ...['--user', `${host.uid}:${host.gid}`],
    ...['--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges:true'],
    '--read-only',
    ...['--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=1g,mode=1777'],
    ...[
      '--tmpfs',
      `${AGENT_HOME}:rw,nosuid,nodev,exec,size=1g,mode=0700,uid=${host.uid},gid=${host.gid}`,
    ],
    ...['--memory', '4g', '--memory-swap', '4g', '--cpus', '2', '--pids-limit', '512'],
    ...['--restart', 'no'],
    ...['--label', `${MANAGED_LABEL}=1`],
    ...['--label', `vibecode.product=${spec.productId}`],
    ...['--label', `vibecode.run=${spec.runId}`],
    ...['--label', `vibecode.role=${spec.role}`],
    ...mounts.flatMap((m) => ['--mount', m]),
    ...['--workdir', WORKSPACE],
    ...['--env', `HOME=${AGENT_HOME}`],
    ...networkArgs(spec),
    spec.image,
  ];
}

export function containerName(runId: string): string {
  return `vibecode-${runId}`;
}

/** The labels `buildRunArgs` puts on the container. */
export function managedLabels(spec: SandboxSpec): Record<string, string> {
  return {
    [MANAGED_LABEL]: '1',
    'vibecode.product': spec.productId,
    'vibecode.run': spec.runId,
    'vibecode.role': spec.role,
  };
}

function networkArgs(spec: SandboxSpec): string[] {
  const args = ['--network', NETWORKS[spec.network]];
  if (spec.network === 'preview') {
    // Port-only host part publishes on loopback with an ephemeral host port.
    args.push('--publish', `127.0.0.1::${String(spec.publishPort)}`);
  }
  return args;
}

function assertHost(host: HostIdentity): void {
  if (!path.isAbsolute(host.dataDir)) {
    throw new Error(`Sandbox data dir must be an absolute path, got ${host.dataDir}`);
  }
  for (const [k, v] of [
    ['uid', host.uid],
    ['gid', host.gid],
  ] as const) {
    if (!Number.isInteger(v) || v < 0)
      throw new Error(`Sandbox ${k} must be a non-negative integer`);
  }
  if (host.uid === 0) {
    throw new Error('Refusing to run containers as root: start Vibecode as a non-root user');
  }
}

function assertSpec(spec: SandboxSpec): void {
  if (!ID_RE.test(spec.runId)) throw new Error(`Invalid sandbox runId: ${spec.runId}`);
  if (!ID_RE.test(spec.productId)) throw new Error(`Invalid sandbox productId: ${spec.productId}`);
  if (!IMAGE_RE.test(spec.image)) throw new Error(`Invalid sandbox image: ${spec.image}`);
  if ((spec.role === 'preview') !== (spec.network === 'preview')) {
    throw new Error('The preview network is used by, and only by, the preview role');
  }
  if (spec.network === 'preview') {
    const p = spec.publishPort;
    if (p === undefined || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error('A preview sandbox needs a publishPort between 1 and 65535');
    }
  } else if (spec.publishPort !== undefined) {
    throw new Error('Only preview sandboxes may publish a port');
  }
}

function assertMountSource(source: string): void {
  if (source.toLowerCase().includes('docker.sock')) {
    throw new Error(`Refusing to mount a Docker socket into a container: ${source}`);
  }
  if (!path.isAbsolute(source)) throw new Error(`Mount source must be absolute: ${source}`);
  if (UNSAFE_MOUNT_CHARS.test(source))
    throw new Error(`Unsafe characters in mount source: ${source}`);
}

/** Lexical check (pure): `p` must be strictly below `dir` after normalisation. */
function assertInside(p: string, dir: string): void {
  const rel = path.relative(dir, path.resolve(p));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Refusing to mount ${p}: only directories inside ${dir} may be mounted`);
  }
}
