/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Box3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Object3D,
} from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layoutPiece, type Figure } from '../../shared/scene.ts';
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
  WALL_THICKNESS,
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

const textured = (m: Mesh) => m.material instanceof MeshStandardMaterial && m.material.map !== null;

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
    '%s fills a storey-high facade cell with its outer face on the slot line',
    async (type) => {
      const parts = piecePartsFromGltf(type, await load(BUILDING_LOADER, PIECE_URLS[type]));
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.every((p) => textured(new Mesh(p.geometry, p.material)))).toBe(true);
      expect(fetched.some((u) => u.includes('/assets/city-kit-industrial/Textures/'))).toBe(true);
      const box = bounds(parts);
      expect(box.min.y).toBeCloseTo(-0.4, 3);
      expect(box.max.y).toBeCloseTo(0.5, 3);
      expect(box.min.x).toBeCloseTo(-0.5 + WALL_THICKNESS, 3);
      expect(box.max.x).toBeCloseTo(0.5, 3);
      expect(box.min.z).toBeCloseTo(-WALL_THICKNESS, 3);
      expect(box.max.z).toBeCloseTo(0, 3);
    },
  );

  it('roof covers a unit footprint from its base', async () => {
    const box = bounds(piecePartsFromGltf('roof', await load(BUILDING_LOADER, PIECE_URLS.roof)));
    expect(box.min.y).toBeCloseTo(0, 3);
    expect(box.max.x - box.min.x).toBeCloseTo(1, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(1, 3);
  });
});

/** Pieces in one building of `width`: floor slab and perimeter of the ground storey. */
function storey(width: number) {
  const perStorey = 1 + 4 * width;
  // A building of `width` storeys of `width`, plus the roof, has footprint `width`.
  const total = width * perStorey + 1;
  const pieces = Array.from({ length: perStorey }, (_, i) => layoutPiece(i, total));
  expect(pieces.filter((p) => p.type === 'floor')).toHaveLength(1);
  return pieces.filter((p) => p.type === 'wall' || p.type === 'window');
}

const UP = new Vector3(0, 1, 0);

/** World box of `parts` placed at a layout slot (as the 3D view does, settled). */
function placed(parts: PiecePart[], pos: readonly number[], rotY: number): Box3 {
  const [x = 0, y = 0, z = 0] = pos;
  const m = new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(UP, rotY),
    new Vector3(1, 1, 1),
  );
  return bounds(parts).applyMatrix4(m);
}

function overlap(a: Box3, b: Box3): number {
  const i = a.clone().intersect(b);
  if (i.isEmpty()) return 0;
  const s = i.getSize(new Vector3());
  return s.x * s.y * s.z;
}

describe('perimeter shell (walls and windows of one storey)', () => {
  async function partsBy(source: 'glb' | 'primitive') {
    if (source === 'primitive') {
      return { wall: primitivePieceParts('wall'), window: primitivePieceParts('window') };
    }
    const [wall, window] = await Promise.all(
      (['wall', 'window'] as const).map(async (t) =>
        piecePartsFromGltf(t, await load(BUILDING_LOADER, PIECE_URLS[t])),
      ),
    );
    return { wall: wall ?? [], window: window ?? [] };
  }

  describe.each(['glb', 'primitive'] as const)('%s pieces', (source) => {
    it.each([1, 2, 3])('stay inside the floor slab of width %i', async (width) => {
      const parts = await partsBy(source);
      const half = width / 2;
      for (const p of storey(width)) {
        const box = placed(parts[p.type as 'wall' | 'window'], p.pos, p.rotY);
        const where = `${p.type} at ${p.pos.join(',')}`;
        expect(box.min.x, where).toBeGreaterThanOrEqual(-half - 1e-3);
        expect(box.max.x, where).toBeLessThanOrEqual(half + 1e-3);
        expect(box.min.z, where).toBeGreaterThanOrEqual(-half - 1e-3);
        expect(box.max.z, where).toBeLessThanOrEqual(half + 1e-3);
        // Stands on the slab (top at level + 0.1) and reaches the next storey.
        expect(box.min.y, where).toBeCloseTo(0.1, 3);
        expect(box.max.y, where).toBeCloseTo(1, 3);
      }
    });

    it.each([1, 2, 3])('do not intersect each other at width %i', async (width) => {
      const parts = await partsBy(source);
      const pieces = storey(width);
      const boxes = pieces.map((p) => placed(parts[p.type as 'wall' | 'window'], p.pos, p.rotY));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i] as Box3;
          const b = boxes[j] as Box3;
          expect(overlap(a, b), `pieces ${i} and ${j}`).toBeLessThanOrEqual(1e-3);
        }
      }
    });

    it.each([1, 2, 3])('close every corner of width %i', async (width) => {
      const parts = await partsBy(source);
      const boxes = storey(width).map((p) =>
        placed(parts[p.type as 'wall' | 'window'], p.pos, p.rotY),
      );
      const half = width / 2;
      for (const [cx, cz] of [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ] as const) {
        const corner = new Vector3(cx, 0.5, cz);
        expect(
          boxes.some((b) => b.distanceToPoint(corner) < 1e-3),
          `corner ${cx},${cz}`,
        ).toBe(true);
      }
    });
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
