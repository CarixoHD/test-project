import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCKERFILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docker/claude-code.Dockerfile',
);

/** Docker image reference grammar (distribution/reference), without digest: [host[:port]/]path[:tag]. */
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const DOMAIN =
  '(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]+)?';
const IMAGE_REF = new RegExp(
  `^(?:${DOMAIN}/)?${COMPONENT}(?:/${COMPONENT})*(?::[\\w][\\w.-]{0,127})?$`,
);

async function baseImageDefault(): Promise<string | undefined> {
  const text = await readFile(DOCKERFILE, 'utf8');
  const line = text.split('\n').find((l) => /^ARG\s+BASE_IMAGE\b/.test(l));
  expect(line, 'ARG BASE_IMAGE line').toBeDefined();
  return /^ARG\s+BASE_IMAGE=(\S+)\s*$/.exec(line ?? '')?.[1];
}

describe('docker/claude-code.Dockerfile ARG BASE_IMAGE', () => {
  it('has a default, so docker does not warn InvalidDefaultArgInFrom', async () => {
    expect(await baseImageDefault()).toBeTruthy();
  });

  it('defaults to a valid image reference', async () => {
    expect(await baseImageDefault()).toMatch(IMAGE_REF);
  });

  it('defaults to a forgot-the-build-arg sentinel, never a usable vibecode/base tag', async () => {
    const value = (await baseImageDefault()) ?? '';
    expect(['vibecode/base', 'vibecode/base:latest']).not.toContain(value);
    expect(value).toMatch(/BASE_IMAGE/);
    expect(value).not.toMatch(/^vibecode\/base:[0-9a-f]{12}$/);
  });
});
