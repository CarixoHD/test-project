// Node preflight (ADR 0012): plain JS, so it loads on Nodes that cannot run .ts.
// npm scripts run `node scripts/preflight.mjs && …` and dev.mjs calls nodeProblem() before
// spawning the API. The CLI writes only to stderr: `docker:images` stdout is piped into `sh`.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN_MAJOR = 22;
const MIN_MINOR = 18;
const DISABLE_FLAG = '--no-experimental-strip-types';

/**
 * Returns null when this Node can run the project's .ts entry points, else a multi-line message.
 * @param {{ version: string, typescript: unknown, execPath: string, nodeOptions?: string | undefined }} node
 * @returns {string | null}
 */
export function nodeProblem({ version, typescript, execPath, nodeOptions }) {
  const which = `This Node: ${execPath} (${version})`;
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
    return [
      `Vibecode needs Node >= ${MIN_MAJOR}.${MIN_MINOR} with native TypeScript type stripping.`,
      which,
      'Install an official Node 22 build (nodejs.org, nvm/fnm with the repo .nvmrc, or NodeSource).',
    ].join('\n');
  }
  if (typescript) return null;
  if ((nodeOptions ?? '').split(/\s+/).includes(DISABLE_FLAG)) {
    return [
      'Vibecode runs .ts files with Node type stripping, but it is turned off.',
      which,
      `NODE_OPTIONS contains ${DISABLE_FLAG}: remove it from NODE_OPTIONS and try again.`,
    ].join('\n');
  }
  return [
    'Vibecode runs .ts files with Node type stripping, but this Node build has none',
    '(typical for the Debian/Ubuntu apt `nodejs` package, which ships without amaro),',
    `or it was started with ${DISABLE_FLAG}.`,
    which,
    `Install an official Node build (>= ${MIN_MAJOR}.${MIN_MINOR}) from nodejs.org, nvm/fnm (the repo has an .nvmrc) or NodeSource, and put it first on PATH.`,
  ].join('\n');
}

function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const problem = nodeProblem({
    version: process.version,
    typescript: process.features.typescript,
    execPath: process.execPath,
    nodeOptions: process.env.NODE_OPTIONS,
  });
  if (problem !== null) {
    process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
}
