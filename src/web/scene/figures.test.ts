/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box3, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Figure } from '../../shared/scene.ts';
import {
  BUILDING_LOADER,
  CHARACTER_LOADER,
  CHARACTER_URLS,
  figureFromGltf,
  PIECE_URLS,
  piecePartsFromGltf,
  primitiveFigure,
  primitivePieceParts,
  type ClipName,
  type FigureModel,
  type PiecePart,
} from './figures.ts';

// The vendored Kenney GLBs parsed by the same loaders the scene uses. jsdom cannot decode
// images, so fetch reads files from disk (recording every URL) and createImageBitmap returns a
// stand-in; a texture that does not exist next to its GLB makes the fetch fail.

const fetched: string[] = [];

/** Vitest serves asset URLs from the repo root at http://localhost:3000/; map them to disk. */
const HERE = import.meta.url; // not inline: Vite would rewrite `new URL(…, import.meta.url)`
const REPO_ROOT = new URL('../../../', HERE);
const diskPath = (url: string) => fileURLToPath(new URL(`.${new URL(url).pathname}`, REPO_ROOT));

beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    const path = diskPath(url);
    if (!existsSync(path)) return Promise.reject(new Error(`missing ${path}`));
    return Promise.resolve(new Response(readFileSync(path)));
  });
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 16, height: 16, close: () => undefined }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load(loader: GLTFLoader, url: string): Promise<GLTF> {
  const bytes = readFileSync(diskPath(url));
  // A fresh ArrayBuffer of this realm: GLTFLoader checks `instanceof ArrayBuffer`.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return loader.parseAsync(buffer, new URL('.', url).href);
}

function meshes(object: Object3D): Mesh[] {
  const found: Mesh[] = [];
  object.traverse((o) => {
    if (o instanceof Mesh) found.push(o);
  });
  return found;
}

const textured = (m: Mesh) =>
  m.material instanceof MeshStandardMaterial && m.material.map !== null;

const CLIP_NAMES: ClipName[] = ['walk', 'work', 'idle', 'sit'];
const ROLES: Figure[] = ['foreman', 'builder', 'inspector'];

describe('character GLBs (Kenney Mini Characters)', () => {
  it('gives foreman, builder and inspector different models', () => {
    expect(new Set(ROLES.map((f) => CHARACTER_URLS[f])).size).toBe(ROLES.length);
  });

  it.each(Object.keys(CHARACTER_URLS) as Figure[])(
    '%s loads with its texture, at most two draw calls and every clip',
    async (figure) => {
      const model = figureFromGltf(await load(CHARACTER_LOADER, CHARACTER_URLS[figure]));
      const parts = meshes(cloneSkinned(model.object));
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.length).toBeLessThanOrEqual(2);
      for (const m of parts) {
        expect(Array.isArray(m.material)).toBe(false);
        expect(textured(m)).toBe(true);
      }
      expect(fetched.some((u) => u.includes('/assets/mini-characters/Textures/'))).toBe(true);
      for (const name of CLIP_NAMES) expect(model.clips[name].tracks.length).toBeGreaterThan(0);
      // Stands about as tall as the primitive figures it replaces.
      model.object.updateMatrixWorld(true);
      const height = new Box3().setFromObject(model.object).getSize(new Vector3()).y;
      expect(height).toBeGreaterThan(0.9);
      expect(height).toBeLessThan(1.4);
    },
  );

  it('keeps ten workers within about two draw calls each', async () => {
    const models = await Promise.all(
      ROLES.map(async (f) => figureFromGltf(await load(CHARACTER_LOADER, CHARACTER_URLS[f]))),
    );
    const crew = Array.from({ length: 10 }, (_, i) =>
      cloneSkinned((models[i % models.length] as FigureModel).object),
    );
    expect(crew.reduce((n, o) => n + meshes(o).length, 0)).toBeLessThanOrEqual(20);
  });
});

function bounds(parts: PiecePart[]): Box3 {
  const box = new Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    if (p.geometry.boundingBox !== null) box.union(p.geometry.boundingBox);
  }
  return box;
}

describe('building GLBs (Kenney City Kit Industrial)', () => {
  it('uses industrial models for walls, windows and the roof', () => {
    expect(Object.keys(PIECE_URLS).sort()).toEqual(['roof', 'wall', 'window']);
  });

  it.each(['wall', 'window'] as const)(
    '%s fits one storey-high, one-unit cell centred on its slot',
    async (type) => {
      const parts = piecePartsFromGltf(type, await load(BUILDING_LOADER, PIECE_URLS[type]));
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.every((p) => textured(new Mesh(p.geometry, p.material)))).toBe(true);
      expect(fetched.some((u) => u.includes('/assets/city-kit-industrial/Textures/'))).toBe(true);
      const box = bounds(parts);
      expect(box.min.y).toBeCloseTo(-0.4, 3);
      expect(box.max.y).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(box.max.x - box.min.x).toBeLessThanOrEqual(1 + 1e-6);
      expect(box.max.z - box.min.z).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(1e-6);
      expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(1e-6);
    },
  );

  it('roof covers a unit footprint from its base', async () => {
    const box = bounds(piecePartsFromGltf('roof', await load(BUILDING_LOADER, PIECE_URLS.roof)));
    expect(box.min.y).toBeCloseTo(0, 3);
    expect(box.max.x - box.min.x).toBeCloseTo(1, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(1, 3);
  });
});

describe('primitive fallback (while loading and in jsdom)', () => {
  it('builds every figure from two meshes with the shared clips', () => {
    for (const figure of ['foreman', 'builder', 'inspector', 'drafter'] as const) {
      const model = primitiveFigure(figure);
      expect(meshes(cloneSkinned(model.object))).toHaveLength(2);
      for (const name of CLIP_NAMES) expect(model.clips[name]).toBeDefined();
    }
  });

  it('has one part per piece type', () => {
    for (const type of ['floor', 'wall', 'window', 'roof'] as const) {
      expect(primitivePieceParts(type)).toHaveLength(1);
    }
  });
});
