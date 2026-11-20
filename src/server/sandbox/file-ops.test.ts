import { describe, expect, it } from 'vitest';
import { fileOpArgv, normalizeRelPath, parseFileOp, type FileOp } from './index.ts';

describe('normalizeRelPath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src//a.ts', 'src/a.ts'],
    ['src/./b/', 'src/b'],
    ['.', '.'],
    ['', '.'],
    ['.gitignore', '.gitignore'],
    ['src/.github/x.yml', 'src/.github/x.yml'],
  ])('accepts %j as %j', (input, out) => {
    expect(normalizeRelPath(input)).toEqual({ ok: true, path: out });
  });

  it.each([
    ['/etc/passwd', 'absolute'],
    ['/workspace/src', 'absolute'],
    ['\\\\server\\share', 'absolute'],
    ['C:\\x', 'absolute'],
    ['..', '..'],
    ['../x', '..'],
    ['src/../../x', '..'],
    ['src/../a.ts', '..'],
    ['src\\..\\x', '..'],
    ['.git', '.git'],
    ['.git/config', '.git'],
    ['sub/.git/HEAD', '.git'],
    ['.GIT/config', '.git'],
    ['./.git', '.git'],
    ['a\0b', 'NUL'],
    ['a\nb', 'control'],
  ])('rejects %j (%s)', (input) => {
    const r = normalizeRelPath(input);
    expect(r.ok).toBe(false);
  });
});

describe('file-op argv protocol', () => {
  const ops: FileOp[] = [
    { op: 'read', path: 'src/a.ts' },
    { op: 'write', path: 'src/new/b.ts' },
    { op: 'list', path: '.' },
    { op: 'list', path: 'src' },
    { op: 'grep', path: '.', pattern: '-e foo|bar' },
    { op: 'grep', path: 'src', pattern: 'x' },
  ];

  it.each(ops)('round-trips %j', (op) => {
    const r = fileOpArgv(op);
    if (!r.ok) throw new Error(r.reason);
    expect(parseFileOp(r.argv)).toEqual({ ok: true, op });
  });

  it('addresses files under /workspace and never uses a shell for reads', () => {
    const r = fileOpArgv({ op: 'read', path: 'src/a.ts' });
    expect(r).toEqual({ ok: true, argv: ['cat', '--', '/workspace/src/a.ts'] });
  });

  it('passes the write path as an argument, not inside the script', () => {
    const r = fileOpArgv({ op: 'write', path: 'a b/$(x).ts' });
    if (!r.ok) throw new Error(r.reason);
    expect(r.argv.at(-1)).toBe('/workspace/a b/$(x).ts');
    expect(r.argv.slice(0, -1).join(' ')).not.toContain('$(x)');
  });

  it.each([
    [{ op: 'read', path: '../x' }],
    [{ op: 'write', path: '.git/config' }],
    [{ op: 'write', path: '.' }],
    [{ op: 'read', path: '.' }],
    [{ op: 'list', path: '/etc' }],
    [{ op: 'grep', path: '.git', pattern: 'x' }],
    [{ op: 'grep', path: '.', pattern: '' }],
  ] as [FileOp][])('refuses to build %j', (op) => {
    expect(fileOpArgv(op).ok).toBe(false);
  });

  it.each([
    [['ls', '-la', '/']],
    [['cat', '--', '/etc/passwd']],
    [['cat', '--', '/workspace/../etc/passwd']],
    [['cat', '--', '/workspace/.git']],
    [['cat', '/workspace/a']],
    [['npm', 'test']],
    [[]],
  ])('does not treat %j as a valid file op', (argv) => {
    expect(parseFileOp(argv)).not.toMatchObject({ ok: true });
  });

  it('marks argv in file-op shape with a bad path as rejected, other argv as not a file op', () => {
    expect(parseFileOp(['cat', '--', '/etc/passwd'])).toMatchObject({ ok: false, isFileOp: true });
    expect(parseFileOp(['npm', 'test'])).toEqual({ ok: false, isFileOp: false });
  });
});
