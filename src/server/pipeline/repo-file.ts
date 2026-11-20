import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

// Reads files of an agent's worktree on the host. Worktree content is untrusted: only regular
// files (never symlinks) below a size limit are read.

const MAX_READ_BYTES = 1_000_000;

export type RepoFileResult =
  { ok: true; value: string } | { ok: false; reason: string; missing?: true };

/** A regular file of the worktree; `missing` is set when it does not exist. */
export async function readRepoFile(dir: string, rel: string): Promise<RepoFileResult> {
  const file = path.join(dir, rel);
  try {
    const st = await lstat(file);
    if (!st.isFile()) return { ok: false, reason: `${rel} is not a regular file` };
    if (st.size > MAX_READ_BYTES) return { ok: false, reason: `${rel} is too large` };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { ok: false, reason: `${rel} is missing`, missing: true };
    }
    throw new Error(`Cannot read ${rel}`, { cause: err });
  }
  return { ok: true, value: await readFile(file, 'utf8') };
}
