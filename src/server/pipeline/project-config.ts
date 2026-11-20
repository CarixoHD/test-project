import { z } from 'zod';
import { ProjectConfigSchema, type ProjectConfig } from '../../shared/agent-results.ts';
import { readRepoFile } from './repo-file.ts';

// `.vibecode/project.json` (ARCHITECTURE §5): one validation shared by the orchestrator (its
// worktree before merging) and attempts (main after merging), so both accept the same files.

export const PROJECT_FILE = '.vibecode/project.json';

export type ProjectConfigResult =
  { ok: true; value: ProjectConfig } | { ok: false; reason: string };

/** The file's text validated with ProjectConfig. */
export function parseProjectConfig(text: string): ProjectConfigResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${PROJECT_FILE} is not valid JSON` };
  }
  const parsed = ProjectConfigSchema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: `invalid ${PROJECT_FILE}: ${z.prettifyError(parsed.error)}` };
}

/** The worktree's project.json validated with ProjectConfig; null when the file does not exist. */
export async function readProjectConfig(
  dir: string,
): Promise<{ ok: true; value: ProjectConfig | null } | { ok: false; reason: string }> {
  const file = await readRepoFile(dir, PROJECT_FILE);
  if (!file.ok) return file.missing === true ? { ok: true, value: null } : file;
  return parseProjectConfig(file.value);
}

/** Whether `next` differs from the product's current config (null: none yet). */
export function projectConfigChanged(current: ProjectConfig | null, next: ProjectConfig): boolean {
  return JSON.stringify(next) !== JSON.stringify(current);
}
