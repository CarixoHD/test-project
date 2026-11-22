import { describe, expect, it } from 'vitest';

type Kind = 'docker' | 'fake';
type DevRuntime = {
  chooseContainerRuntime: (env: Record<string, string | undefined>, dockerReachable: boolean) => Kind;
  containerRuntimeLabel: (kind: Kind, dockerReachable: boolean) => string;
};

// dev-runtime.mjs is plain JS like dev-proxy.mjs, and tsconfig has no allowJs, so load it through a
// non-literal specifier and type the exports here.
const DEV_RUNTIME_URL = new URL('./dev-runtime.mjs', import.meta.url);
const { chooseContainerRuntime, containerRuntimeLabel } = (await import(
  DEV_RUNTIME_URL.href
)) as DevRuntime;

describe('chooseContainerRuntime', () => {
  it('honours VIBECODE_FAKE_DOCKER even when Docker is reachable', () => {
    expect(chooseContainerRuntime({ VIBECODE_FAKE_DOCKER: '1' }, true)).toBe('fake');
    expect(chooseContainerRuntime({ VIBECODE_FAKE_DOCKER: 'true' }, true)).toBe('fake');
  });

  it('uses Docker when it is reachable and VIBECODE_FAKE_DOCKER is unset', () => {
    expect(chooseContainerRuntime({}, true)).toBe('docker');
    expect(chooseContainerRuntime({ VIBECODE_FAKE_DOCKER: '0' }, true)).toBe('docker');
  });

  it('falls back to the fake runtime when Docker is unreachable', () => {
    expect(chooseContainerRuntime({}, false)).toBe('fake');
  });
});

describe('containerRuntimeLabel', () => {
  it('names the real runtime', () => {
    expect(containerRuntimeLabel('docker', true)).toBe('Containers: Docker');
  });

  it('says why the fake runtime is in use', () => {
    expect(containerRuntimeLabel('fake', false)).toBe(
      'Containers: fake (Docker not reachable)',
    );
    expect(containerRuntimeLabel('fake', true)).toBe('Containers: fake (VIBECODE_FAKE_DOCKER=1)');
  });
});
