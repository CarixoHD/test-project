// Picks the ContainerRuntime for the running server (ARCHITECTURE §4.8, ADR 6): the in-memory
// FakeContainerRuntime with VIBECODE_FAKE_DOCKER=1. The docker CLI runtime (#42) replaces the
// unavailable placeholder below.
import { FakeContainerRuntime, type FakeRunRule } from './fake.ts';
import type { ContainerRuntime } from './types.ts';

export const DOCKER_UNAVAILABLE_REASON =
  'Docker runtime not available yet: set VIBECODE_FAKE_DOCKER=1';

/** A runtime whose every container operation fails with DOCKER_UNAVAILABLE_REASON. */
function unavailableRuntime(): ContainerRuntime {
  const reject = () => Promise.reject(new Error(DOCKER_UNAVAILABLE_REASON));
  return {
    available: () => Promise.resolve(false),
    ensureImage: reject,
    open: reject,
    runOnce: reject,
    listManaged: reject,
    remove: reject,
  };
}

/** `o.script` answers non-file-op commands in the fake runtime (demo mode: the check). */
export function selectRuntime(
  config: { fakeDocker: boolean; dataDir: string },
  o: { script?: readonly FakeRunRule[] } = {},
): ContainerRuntime {
  return config.fakeDocker
    ? new FakeContainerRuntime({ dataDir: config.dataDir, ...o })
    : unavailableRuntime();
}
