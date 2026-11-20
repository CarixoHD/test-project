// Picks the ContainerRuntime for the running server (ARCHITECTURE §4.8, ADR 6): the in-memory
// FakeContainerRuntime with VIBECODE_FAKE_DOCKER=1, otherwise the docker CLI runtime.
import { DockerCliRuntime } from './docker-cli.ts';
import { FakeContainerRuntime, type FakeRunRule } from './fake.ts';
import type { ClaudeLoginSource, ContainerRuntime } from './types.ts';

const FALLBACK_ID = 1000;

/**
 * `o.script` answers non-file-op commands in the fake runtime (demo mode: the check).
 * `o.docker` overrides the docker CLI binary (tests point it at a missing one).
 */
export function selectRuntime(
  config: { fakeDocker: boolean; dataDir: string },
  o: { script?: readonly FakeRunRule[]; docker?: string } = {},
): ContainerRuntime & ClaudeLoginSource {
  if (config.fakeDocker) {
    return new FakeContainerRuntime({
      dataDir: config.dataDir,
      ...(o.script === undefined ? {} : { script: o.script }),
    });
  }
  return new DockerCliRuntime({
    dataDir: config.dataDir,
    uid: process.getuid?.() ?? FALLBACK_ID,
    gid: process.getgid?.() ?? FALLBACK_ID,
    docker: o.docker,
  });
}
