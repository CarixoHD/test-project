import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseImageTag, claudeImageTag } from '../src/server/sandbox/index.ts';
import { imageScript } from './build-images.ts';

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('imageScript', () => {
  it('prints the hashed base and Claude tags the runtime uses, and a build command for both', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vibecode-images-'));
    await writeFile(path.join(dir, 'base.Dockerfile'), 'FROM debian\n');
    await writeFile(path.join(dir, 'claude-code.Dockerfile'), 'FROM ${BASE_IMAGE}\n');
    const baseTag = await baseImageTag(dir);
    const claudeTag = await claudeImageTag(dir, '', baseTag);

    const lines = (await imageScript(dir)).split('\n');

    expect(lines).toContain(`# base:   ${baseTag}`);
    expect(lines).toContain(`# claude: ${claudeTag}`);
    const build = lines.filter((l) => !l.startsWith('#') && l !== '');
    expect(build).toEqual([
      `docker buildx build --load --tag ${baseTag} --file ${path.join(dir, 'base.Dockerfile')} ${dir} && ` +
        `docker buildx build --load --tag ${claudeTag} --build-arg BASE_IMAGE=${baseTag} ` +
        `--file ${path.join(dir, 'claude-code.Dockerfile')} ${dir}`,
    ]);
  });
});
