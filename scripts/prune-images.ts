// Prints the command that removes outdated vibecode/base and vibecode/claude-code images: every
// local tag of those two repositories except the current content-hashed ones (plain `latest`
// tags and old hashes). `npm run -s docker:prune` to see it, `npm run -s docker:prune | sh` to
// remove. It never removes anything itself, and never touches other repositories (product
// images vibecode/p-* included).
import { exec } from '../src/server/util/exec.ts';
import {
  BASE_IMAGE,
  CLAUDE_IMAGE,
  DEFAULT_BASE_IMAGE_DIR,
  baseImageTag,
  claudeImageTag,
} from '../src/server/sandbox/index.ts';

const PRUNED_REPOSITORIES: readonly string[] = [BASE_IMAGE, CLAUDE_IMAGE];
const LIST_TIMEOUT_MS = 30_000;

/**
 * Tags in `allTags` (`repository:tag`) of vibecode/base or vibecode/claude-code that are not in
 * `currentTags`, in order and without duplicates. Other repositories and `<none>` entries are
 * ignored.
 */
export function staleImageTags(
  allTags: readonly string[],
  currentTags: readonly string[],
): string[] {
  const current = new Set(currentTags);
  const stale = new Set<string>();
  for (const raw of allTags) {
    const ref = raw.trim();
    const sep = ref.lastIndexOf(':');
    if (sep <= 0) continue;
    const repository = ref.slice(0, sep);
    const tag = ref.slice(sep + 1);
    if (!PRUNED_REPOSITORIES.includes(repository)) continue;
    if (tag === '' || tag === '<none>') continue;
    if (!current.has(ref)) stale.add(ref);
  }
  return [...stale];
}

/** One `docker image rm` line for `tags`, or '' when there is nothing to remove. */
export function pruneCommand(tags: readonly string[]): string {
  return tags.length === 0 ? '' : `docker image rm ${tags.join(' ')}\n`;
}

/** Local `repository:tag` references of the pruned repositories, via `docker image ls`. */
async function localImageTags(): Promise<string[]> {
  const argv = [
    'image',
    'ls',
    '--format',
    '{{.Repository}}:{{.Tag}}',
    ...PRUNED_REPOSITORIES.flatMap((r) => ['--filter', `reference=${r}`]),
  ];
  const r = await exec('docker', argv, { timeoutMs: LIST_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`docker image ls failed (exit ${String(r.code)}): ${r.stderr.trim()}`);
  }
  return r.stdout.split('\n');
}

if (import.meta.main) {
  const baseTag = await baseImageTag(DEFAULT_BASE_IMAGE_DIR);
  const claudeTag = await claudeImageTag(DEFAULT_BASE_IMAGE_DIR, '', baseTag);
  const stale = staleImageTags(await localImageTags(), [baseTag, claudeTag]);
  process.stdout.write(pruneCommand(stale));
}
