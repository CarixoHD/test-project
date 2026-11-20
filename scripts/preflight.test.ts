import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type NodeProblem = (input: {
  version: string;
  typescript: unknown;
  execPath: string;
  nodeOptions?: string | undefined;
}) => string | null;

// preflight.mjs is plain JS (it must load on Nodes that cannot run .ts), and tsconfig has no
// allowJs, so load it through a non-literal specifier and type the export here.
const PREFLIGHT_URL = new URL('./preflight.mjs', import.meta.url);
const { nodeProblem } = (await import(PREFLIGHT_URL.href)) as { nodeProblem: NodeProblem };

const EXEC = '/usr/bin/node';

describe('nodeProblem', () => {
  it('accepts Node 22.18+ with type stripping', () => {
    expect(nodeProblem({ version: 'v22.22.1', typescript: 'strip', execPath: EXEC })).toBeNull();
    expect(nodeProblem({ version: 'v22.18.0', typescript: 'strip', execPath: EXEC })).toBeNull();
    expect(nodeProblem({ version: 'v24.1.0', typescript: 'transform', execPath: EXEC })).toBeNull();
  });

  it('rejects Node older than 22.18 and names the binary', () => {
    const message = nodeProblem({ version: 'v22.17.0', typescript: 'strip', execPath: EXEC });
    expect(message).toContain('22.18');
    expect(message).toContain('v22.17.0');
    expect(message).toContain(EXEC);
    expect(nodeProblem({ version: 'v20.19.0', typescript: undefined, execPath: EXEC })).toContain(
      '22.18',
    );
  });

  it('tells you to remove --no-experimental-strip-types from NODE_OPTIONS', () => {
    const message = nodeProblem({
      version: 'v22.22.1',
      typescript: false,
      execPath: EXEC,
      nodeOptions: '--max-old-space-size=4096 --no-experimental-strip-types',
    });
    expect(message).toContain('NODE_OPTIONS');
    expect(message).toContain('--no-experimental-strip-types');
    expect(message).toContain(EXEC);
    expect(message).toContain('v22.22.1');
  });

  it('points a Node build without type stripping at an official build', () => {
    const message = nodeProblem({
      version: 'v22.22.1',
      typescript: false,
      execPath: EXEC,
      nodeOptions: '',
    });
    expect(message).toContain('official Node');
    expect(message).toContain('apt');
    expect(message).toContain(EXEC);
    expect(message).toContain('v22.22.1');
    expect(message).not.toContain('NODE_OPTIONS');
  });
});

describe('preflight CLI', () => {
  const script = fileURLToPath(PREFLIGHT_URL);
  const env = { ...process.env, NODE_OPTIONS: '' };

  it('exits 0 silently on this Node', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits 1 with the message on stderr only when type stripping is off', () => {
    const result = spawnSync(process.execPath, ['--no-experimental-strip-types', script], {
      encoding: 'utf8',
      env,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(process.execPath);
    expect(result.stderr).toContain(process.version);
  });
});
