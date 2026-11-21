import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isGone } from './process.ts';

const eventually = async (probe: () => boolean, ms = 3_000): Promise<boolean> => {
  const until = performance.now() + ms;
  while (!probe() && performance.now() < until) {
    await new Promise((done) => setTimeout(done, 20));
  }
  return probe();
};

const exitedPid = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid ?? 0));
  });

describe('isGone', () => {
  it('reports a live process as not gone', () => {
    expect(isGone(process.pid)).toBe(false);
  });

  it('reports an exited process as gone', async () => {
    const pid = await exitedPid();
    expect(await eventually(() => isGone(pid))).toBe(true);
  });

  it('reports a live process group as not gone until its members are killed', async () => {
    const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    const killGroup = () => {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    try {
      expect(isGone(-pgid)).toBe(false);
      killGroup();
      expect(await eventually(() => isGone(-pgid))).toBe(true);
    } finally {
      killGroup();
    }
  });
});
