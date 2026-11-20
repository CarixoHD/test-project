import { describe, expect, it } from 'vitest';
import { FakeContainerRuntime } from './fake.ts';
import { DOCKER_UNAVAILABLE_REASON, selectRuntime } from './select-runtime.ts';

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

  it('without fakeDocker, reports unavailable and rejects with an actionable message', async () => {
    const runtime = selectRuntime({ fakeDocker: false, dataDir: '/data' });
    expect(DOCKER_UNAVAILABLE_REASON).toBe(
      'Docker runtime not available yet: set VIBECODE_FAKE_DOCKER=1',
    );
    await expect(runtime.available()).resolves.toBe(false);
    const reason = new Error(DOCKER_UNAVAILABLE_REASON);
    await expect(runtime.ensureImage({ productId: 'p', contextDir: '/x' })).rejects.toThrow(reason);
    await expect(runtime.open(SPEC)).rejects.toThrow(reason);
    await expect(runtime.runOnce(SPEC, ['true'], { timeoutMs: 1 })).rejects.toThrow(reason);
    await expect(runtime.listManaged()).rejects.toThrow(reason);
    await expect(runtime.remove('vibecode-run-1')).rejects.toThrow(reason);
  });
});
