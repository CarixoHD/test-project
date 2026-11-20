import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactor } from '../security/index.ts';
import { exec, spawnStream } from './exec.ts';

const NODE = process.execPath;
/** argv for `node -e <script> -- ...args`; inside the script process.argv.slice(1) is args. */
const nodeArgs = (script: string, ...args: string[]): string[] => ['-e', script, '--', ...args];

const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
const FOREVER = 'setInterval(() => {}, 1000)';

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'vibecode-exec-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('exec', () => {
  it('passes shell metacharacters literally and never runs a shell', async () => {
    const hostile = [
      '$(touch pwned1)',
      '`touch pwned2`',
      '; touch pwned3',
      '| tee pwned4',
      '> pwned5',
      '&& echo $HOME',
      '*',
      '\'quoted\' "double"',
      'a\nb',
    ];
    const r = await exec(NODE, nodeArgs(ECHO_ARGV, ...hostile), { cwd: dir, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(hostile);
    for (const n of [1, 2, 3, 4, 5]) expect(existsSync(join(dir, `pwned${n}`))).toBe(false);
  });

  it('returns a non-zero exit code with captured stdout and stderr instead of throwing', async () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    const r = await exec(NODE, nodeArgs(script), { timeoutMs: 10_000 });
    expect(r).toMatchObject({
      code: 3,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      aborted: false,
      truncated: false,
    });
  });

  it('writes input to stdin and closes it', async () => {
    const script =
      "let s=''; process.stdin.on('data', d => s += d).on('end', () => process.stdout.write(s.toUpperCase()))";
    const r = await exec(NODE, nodeArgs(script), { input: 'hello stdin', timeoutMs: 10_000 });
    expect(r.stdout).toBe('HELLO STDIN');
  });

  it('closes stdin when no input is given', async () => {
    const script = "process.stdin.resume().on('end', () => process.stdout.write('eof'))";
    const r = await exec(NODE, nodeArgs(script), { timeoutMs: 10_000 });
    expect(r.stdout).toBe('eof');
  });

  it('runs in cwd and merges env over the inherited environment (undefined removes a var)', async () => {
    vi.stubEnv('VIBECODE_EXEC_INHERITED', 'inherited');
    vi.stubEnv('VIBECODE_EXEC_REMOVED', 'should-be-gone');
    const script =
      'const e = process.env; process.stdout.write(JSON.stringify([process.cwd(), e.VIBECODE_EXEC_INHERITED, e.VIBECODE_EXEC_ADDED, e.VIBECODE_EXEC_REMOVED ?? null]))';
    const r = await exec(NODE, nodeArgs(script), {
      cwd: dir,
      env: { VIBECODE_EXEC_ADDED: 'added', VIBECODE_EXEC_REMOVED: undefined },
      timeoutMs: 10_000,
    });
    expect(JSON.parse(r.stdout)).toEqual([dir, 'inherited', 'added', null]);
  });

  it('caps captured output at maxBuffer without killing the process', async () => {
    const script = "process.stdout.write('x'.repeat(100000)); process.stderr.write('small')";
    const r = await exec(NODE, nodeArgs(script), { maxBuffer: 1000, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('x'.repeat(1000));
    expect(r.stderr).toBe('small');
    expect(r.truncated).toBe(true);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const script =
      "const b = Buffer.from('ü€😀'); process.stdout.write(b.subarray(0, 3)); setTimeout(() => process.stdout.write(b.subarray(3)), 20)";
    const r = await exec(NODE, nodeArgs(script), { timeoutMs: 10_000 });
    expect(r.stdout).toBe('ü€😀');
  });

  it('rejects invalid options as programmer errors', async () => {
    await expect(exec(NODE, ['-v'], { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    await expect(exec(NODE, ['-v'], { timeoutMs: Number.NaN })).rejects.toThrow(/timeoutMs/);
    await expect(exec('', [], { timeoutMs: 1000 })).rejects.toThrow(/command/);
  });

  it('rejects with an actionable error when the command cannot be started', async () => {
    await expect(exec(join(dir, 'no-such-binary'), ['arg'], { timeoutMs: 10_000 })).rejects.toThrow(
      /no-such-binary.*ENOENT/,
    );
  });
});

describe('exec timeouts', () => {
  it('kills the process when timeoutMs elapses', async () => {
    const started = performance.now();
    const r = await exec(NODE, nodeArgs(FOREVER), { timeoutMs: 300 });
    expect(r).toMatchObject({ code: null, signal: 'SIGTERM', timedOut: true, aborted: false });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('kills the whole process tree, so grandchildren holding the pipes do not hang it', async () => {
    const script = `require('node:child_process').spawn(process.execPath, ['-e', '${FOREVER}'], { stdio: 'inherit' }); ${FOREVER}`;
    const r = await exec(NODE, nodeArgs(script), { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
  });

  it('escalates to SIGKILL when the process ignores the kill signal', async () => {
    const script =
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
    const ac = new AbortController();
    const r = await spawnStream(NODE, nodeArgs(script), {
      timeoutMs: 60_000,
      killGraceMs: 200,
      signal: ac.signal,
      onLine: (line) => {
        if (line === 'ready') ac.abort();
      },
    });
    expect(r).toMatchObject({ code: null, signal: 'SIGKILL', aborted: true });
  });
});

describe('exec abort', () => {
  it('kills the process with SIGTERM by default when the signal aborts', async () => {
    const ac = new AbortController();
    const pending = exec(NODE, nodeArgs(FOREVER), { timeoutMs: 60_000, signal: ac.signal });
    ac.abort();
    expect(await pending).toMatchObject({
      code: null,
      signal: 'SIGTERM',
      aborted: true,
      timedOut: false,
    });
  });

  it('does not start the process when the signal is already aborted', async () => {
    const script = `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'ran'))}, '')`;
    const r = await exec(NODE, nodeArgs(script), {
      timeoutMs: 10_000,
      signal: AbortSignal.abort(),
    });
    expect(r).toMatchObject({ code: null, aborted: true, stdout: '', stderr: '' });
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  it('sends the chosen killSignal (SIGINT) so the child can finish cleanly', async () => {
    const ac = new AbortController();
    const script =
      "process.on('SIGINT', () => { console.log('got SIGINT'); process.exit(0) }); console.log('ready'); setInterval(() => {}, 1000)";
    const lines: string[] = [];
    const r = await spawnStream(NODE, nodeArgs(script), {
      timeoutMs: 60_000,
      signal: ac.signal,
      killSignal: 'SIGINT',
      onLine: (line) => {
        lines.push(line);
        if (line === 'ready') ac.abort();
      },
    });
    expect(lines).toEqual(['ready', 'got SIGINT']);
    expect(r).toMatchObject({ code: 0, signal: null, aborted: true, timedOut: false });
  });
});

describe('spawnStream', () => {
  it('delivers complete lines per stream, including a final unterminated line and CRLF', async () => {
    const script =
      "process.stdout.write('a1\\na'); setTimeout(() => { process.stdout.write('2\\r\\na3'); process.stderr.write('e1\\n') }, 20)";
    const got: [string, string][] = [];
    const r = await spawnStream(NODE, nodeArgs(script), {
      timeoutMs: 10_000,
      onLine: (line, stream) => got.push([stream, line]),
    });
    expect(r).toMatchObject({ code: 0, timedOut: false, aborted: false });
    expect(got.filter(([s]) => s === 'stdout').map(([, l]) => l)).toEqual(['a1', 'a2', 'a3']);
    expect(got.filter(([s]) => s === 'stderr').map(([, l]) => l)).toEqual(['e1']);
  });

  it('kills the process and rejects with the error when onLine throws', async () => {
    const script = `console.log('ready'); ${FOREVER}`;
    const boom = new Error('consumer failed');
    const pending = spawnStream(NODE, nodeArgs(script), {
      timeoutMs: 60_000,
      onLine: () => {
        throw boom;
      },
    });
    await expect(pending).rejects.toBe(boom);
  });

  it('honours timeoutMs', async () => {
    const r = await spawnStream(NODE, nodeArgs(FOREVER), { timeoutMs: 300, onLine: () => {} });
    expect(r).toMatchObject({ code: null, timedOut: true });
  });
});

describe('exec redaction', () => {
  const SECRET = 'sk-test-exec-redaction-0123456789';
  beforeEach(() => redactor.register(SECRET));

  it('redacts registered secrets from captured stdout and stderr', async () => {
    const script = 'const s = process.argv[1]; console.log(`out ${s}`); console.error(`err ${s}`)';
    const r = await exec(NODE, nodeArgs(script, SECRET), { timeoutMs: 10_000 });
    expect(r.stdout).toBe('out ***6789\n');
    expect(r.stderr).toBe('err ***6789\n');
  });

  it('redacts a secret that spans output chunks', async () => {
    const script =
      'const s = process.argv[1]; process.stdout.write(s.slice(0, 10)); setTimeout(() => process.stdout.write(s.slice(10)), 20)';
    const r = await exec(NODE, nodeArgs(script, SECRET), { timeoutMs: 10_000 });
    expect(r.stdout).toBe('***6789');
  });

  it('redacts a secret that straddles the maxBuffer cut', async () => {
    const script = "process.stdout.write('x'.repeat(990) + process.argv[1] + 'y'.repeat(5000))";
    const r = await exec(NODE, nodeArgs(script, SECRET), { maxBuffer: 1000, timeoutMs: 10_000 });
    expect(r.stdout).not.toContain(SECRET.slice(0, 10));
    expect(r.stdout.startsWith('x'.repeat(990) + '***6789')).toBe(true);
    expect(r.truncated).toBe(true);
  });

  /** True if any 6-character piece of `secret` appears in text (masks show only the last 4). */
  const leaks = (text: string, secret = SECRET): boolean =>
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((piece) =>
      text.includes(piece),
    );
  // 100 distinct-ish chars: redaction shrinks it to 7, so truncated output stays under maxBuffer.
  const LONG_SECRET = `sk-long-${Array.from({ length: 23 }, (_, i) => `${i}`.padStart(4, '-')).join('')}`;

  it.each([
    ['multi-byte output (fewer characters than bytes)', '€'.repeat(10)],
    ['repeated secrets (redaction shortens the text)', ''],
  ])('does not leak part of a secret at the maxBuffer cut: %s', async (_name, filler) => {
    redactor.register(LONG_SECRET);
    // Blocks of filler + secret, so the byte cut lands inside a secret wherever it falls.
    const script =
      'const [f, s] = process.argv.slice(1); process.stdout.write((f + s).repeat(300))';
    const r = await exec(NODE, nodeArgs(script, filler, LONG_SECRET), {
      maxBuffer: 3000,
      timeoutMs: 10_000,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith(`${filler}***--22${filler}***--22`)).toBe(true);
    expect(leaks(r.stdout, LONG_SECRET)).toBe(false);
  });

  it('redacts a secret split across an over-long streamed line piece', async () => {
    const script =
      "const s = process.argv[1]; process.stdout.write('x'.repeat(90) + s.slice(0, 20)); setTimeout(() => process.stdout.write(s.slice(20) + '\\n'), 20)";
    const lines: string[] = [];
    await spawnStream(NODE, nodeArgs(script, SECRET), {
      maxBuffer: 100,
      timeoutMs: 10_000,
      onLine: (line) => lines.push(line),
    });
    expect(leaks(lines.join('|'))).toBe(false);
    expect(lines.join('')).toBe(`${'x'.repeat(90)}***6789`);
  });

  it('redacts streamed lines', async () => {
    const lines: string[] = [];
    await spawnStream(NODE, nodeArgs('console.log(process.argv[1])', SECRET), {
      timeoutMs: 10_000,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['***6789']);
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('never streams any line of a registered multi-line secret (%s)', async (_name, eol) => {
    const secretLines = [
      `pem-${eol.length}-line-one-AAAAbbbbCCCC`,
      `pem-${eol.length}-line-two-DDDDeeeeFFFF`,
      `pem-${eol.length}-line-three-GGGGhhhh`,
    ];
    const secret = secretLines.join(eol);
    redactor.register(secret);
    const script = 'process.stdout.write(`before\\n${process.argv[1]}\\nafter\\n`)';
    const lines: string[] = [];
    await spawnStream(NODE, nodeArgs(script, secret), {
      timeoutMs: 10_000,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('before');
    expect(lines[4]).toBe('after');
    for (const secretLine of secretLines) {
      for (const line of lines) expect(leaks(line, secretLine)).toBe(false);
    }
  });

  it('redacts secrets from error messages and stacks', async () => {
    const missing = join(dir, `bin-${SECRET}`);
    const err: unknown = await exec(missing, [`--token=${SECRET}`], { timeoutMs: 10_000 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toContain('***6789');
    expect(e.message).not.toContain(SECRET);
    expect(e.stack ?? '').not.toContain(SECRET);
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(SECRET);
    expect(e.cause).toBeUndefined();
  });
});
