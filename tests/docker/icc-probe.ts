// Shared probe (test-only): can this Docker daemon create a bridge with inter-container traffic
// off? Without the br_netfilter kernel module it cannot, and DockerCliRuntime must then fail
// closed with IccUnsupportedError (ADR 6) instead of creating vibecode-egress. Tests that need
// the networks run unchanged on capable hosts; on other hosts they are replaced by assertions
// that the real runtime rejects with the actionable error (as #152 did for hosts without internet).
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { DockerCliRuntime } from '../../src/server/sandbox/index.ts';
import {
  DOCKER_NOT_RUNNING,
  ICC_UNSUPPORTED,
  IccUnsupportedError,
  NETWORKS,
} from '../../src/server/sandbox/index.ts';
import { exec } from '../../src/server/util/exec.ts';

const T = { timeoutMs: 60_000 };

export type IccOffSupport = { ok: true } | { ok: false; stderr: string };

/**
 * Creates (and removes) a throwaway bridge with `enable_icc=false`. Logs which case applies.
 * Throws when docker itself cannot run, so a missing daemon still fails the suite loudly.
 */
export async function probeIccOff(): Promise<IccOffSupport> {
  const name = `vibecode-icc-probe-${randomBytes(4).toString('hex')}`;
  const created = await exec(
    'docker',
    [
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      name,
    ],
    T,
  );
  if (created.code === 0) {
    const removed = await exec('docker', ['network', 'rm', name], T);
    if (removed.code !== 0) throw new Error(`could not remove ${name}: ${removed.stderr}`);
    console.log(
      '[icc-probe] CAPABLE host: the daemon creates ICC-off bridges; the network tests run unchanged',
    );
    return { ok: true };
  }
  const stderr = created.stderr.trim();
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(stderr)) {
    throw new Error(`${DOCKER_NOT_RUNNING} (needed by tests/docker): ${stderr}`);
  }
  console.log(
    '[icc-probe] NOT CAPABLE host: the daemon cannot create an ICC-off bridge (br_netfilter ' +
      'missing?); the network tests assert the fail-closed IccUnsupportedError instead. ' +
      `Daemon said: ${stderr}`,
  );
  return { ok: false, stderr };
}

/**
 * On a host that cannot turn ICC off: the real runtime's ensureNetworks rejects with the
 * actionable error, and no vibecode-egress network (with ICC on or otherwise) was created.
 */
export async function expectFailsClosed(rt: DockerCliRuntime): Promise<IccUnsupportedError> {
  const existing = await exec('docker', ['network', 'inspect', NETWORKS.egress], T);
  if (existing.code === 0) {
    throw new Error(
      `${NETWORKS.egress} already exists although this daemon cannot create an ICC-off bridge: ` +
        'remove it (`docker network rm vibecode-egress`) so the fail-closed path can be verified',
    );
  }
  const err = await rt.ensureNetworks().then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof IccUnsupportedError)) {
    throw new Error(`expected IccUnsupportedError from ensureNetworks, got: ${String(err)}`);
  }
  expect(err.code).toBe(ICC_UNSUPPORTED);
  expect(err.message).toContain('br_netfilter');
  expect(err.message).toContain('sudo modprobe br_netfilter');
  const after = await exec('docker', ['network', 'inspect', NETWORKS.egress], T);
  expect(after.code, `${NETWORKS.egress} must not exist after a failed ICC-off create`).not.toBe(0);
  return err;
}
