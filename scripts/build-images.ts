// Prints the content-hashed image tags the runtime uses and the command that builds them:
// `npm run -s docker:images` to see them, `npm run -s docker:images | sh` to build.
// vibecode/base:<hash> is the fallback image (ADR 6); vibecode/claude-code:<hash> is it plus the
// pinned Claude Code CLI, the login image (ADR 4). Vibecode also builds both on first use.
import {
  DEFAULT_BASE_IMAGE_DIR,
  baseImageTag,
  claudeImageTag,
  claudeLoginCommands,
} from '../src/server/sandbox/index.ts';

/** A shell script (tags as comments, then the build command) for the images in `imageDir`. */
export async function imageScript(imageDir: string): Promise<string> {
  const baseTag = await baseImageTag(imageDir);
  const claudeTag = await claudeImageTag(imageDir, '', baseTag);
  // uid:gid only affect the login command, which is not printed here.
  const { build } = claudeLoginCommands({ imageDir, baseTag, claudeTag, uid: 0, gid: 0 });
  return `# base:   ${baseTag}\n# claude: ${claudeTag}\n${build}\n`;
}

if (import.meta.main) {
  process.stdout.write(await imageScript(DEFAULT_BASE_IMAGE_DIR));
}
