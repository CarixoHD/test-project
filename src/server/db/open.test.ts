import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { open } from './index.ts';

// ARCHITECTURE §5: every table of the data model.
const TABLES = [
  'events',
  'products',
  'prd_versions',
  'prd_drafts',
  'spar_messages',
  'issues',
  'issue_deps',
  'attempts',
  'agents',
  'usage',
  'usage_totals',
  'questions',
  'inbox',
  'backend_limits',
  'previews',
  'settings',
  'secrets',
];

function tableNames(db: ReturnType<typeof open>): string[] {
  return db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('open', () => {
  it("applies the migrations to ':memory:'", () => {
    const db = open(':memory:');
    expect(tableNames(db)).toEqual(expect.arrayContaining(TABLES));
    db.$client.close();
  });

  it('sets the pragmas from ADR 5', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibecode-db-'));
    dirs.push(dir);
    const db = open(join(dir, 'vibecode.db'));
    const pragma = (name: string): unknown => db.$client.pragma(name, { simple: true });
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('synchronous')).toBe(1); // NORMAL
    expect(pragma('busy_timeout')).toBe(5000);
    expect(pragma('foreign_keys')).toBe(1);
    db.$client.close();
  });

  it('creates the database file with mode 0600 and reopens it idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibecode-db-'));
    dirs.push(dir);
    const path = join(dir, 'vibecode.db');
    open(path).$client.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = open(path);
    expect(tableNames(again)).toEqual(expect.arrayContaining(TABLES));
    again.$client.close();
  });
});
