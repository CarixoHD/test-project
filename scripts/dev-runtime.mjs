// Container runtime choice for `npm run dev` (issue #206): honour VIBECODE_FAKE_DOCKER, otherwise
// probe Docker so a dev server on a machine with a daemon runs Claude Code for real. Plain JS so
// dev.mjs can import it next to Vite (like dev-proxy.mjs).

/**
 * Which runtime the dev API starts with.
 * @param {Record<string, string | undefined>} env the caller's environment
 * @param {boolean} dockerReachable whether `docker info` answered
 * @returns {'docker' | 'fake'}
 */
export function chooseContainerRuntime(env, dockerReachable) {
  const fake = env.VIBECODE_FAKE_DOCKER;
  if (fake === '1' || fake === 'true') return 'fake';
  return dockerReachable ? 'docker' : 'fake';
}

/**
 * The startup line naming the runtime, with the reason when it is the fake one.
 * @param {'docker' | 'fake'} kind
 * @param {boolean} dockerReachable
 * @returns {string}
 */
export function containerRuntimeLabel(kind, dockerReachable) {
  if (kind === 'docker') return 'Containers: Docker';
  return `Containers: fake (${dockerReachable ? 'VIBECODE_FAKE_DOCKER=1' : 'Docker not reachable'})`;
}
