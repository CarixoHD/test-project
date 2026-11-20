import { describe, expect, it } from 'vitest';
import { DOCKER_NOT_RUNNING, DockerCliRuntime } from './docker-cli.ts';
import { FakeContainerRuntime } from './fake.ts';
import { selectRuntime } from './select-runtime.ts';

const SPEC = {
  runId: 'run-1',
  productId: 'product-1',
  role: 'agent',
  image: 'vibecode/base',
  worktree: '/data/worktrees/run-1',
  readOnly: false,
  network: 'none',
} as const;

describe('selectRuntime', () => {
  it('returns the FakeContainerRuntime when fakeDocker is set', () => {
    expect(selectRuntime({ fakeDocker: true, dataDir: '/data' })).toBeInstanceOf(
      FakeContainerRuntime,
    );
  });

  it('passes the script to the FakeContainerRuntime', async () => {
    const runtime = selectRuntime(
      { fakeDocker: true, dataDir: '/data' },
      { script: [{ match: ['make', 'check'], result: { code: 0, stdout: 'ok\n' } }] },
    );
    const r = await runtime.runOnce(SPEC, ['make', 'check'], { timeoutMs: 1 });
    expect([r.code, r.stdout]).toEqual([0, 'ok\n']);
  });

  it('without fakeDocker, returns the docker CLI runtime', () => {
    expect(selectRuntime({ fakeDocker: false, dataDir: '/data' })).toBeInstanceOf(DockerCliRuntime);
  });

  it('without a docker CLI, reports unavailable and rejects with an actionable message', async () => {
    const runtime = selectRuntime(
      { fakeDocker: false, dataDir: '/data' },
      { docker: '/nonexistent/vibecode-no-docker' },
    );
    await expect(runtime.available()).resolves.toBe(false);
    await expect(runtime.listManaged()).rejects.toThrow(DOCKER_NOT_RUNNING);
    await expect(runtime.remove('vibecode-run-1')).rejects.toThrow(DOCKER_NOT_RUNNING);
  });
});
