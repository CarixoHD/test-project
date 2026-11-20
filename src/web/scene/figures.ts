import type { BufferGeometry, Material, Object3D } from 'three';
import {
  AnimationClip,
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InterpolateSmooth,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  SphereGeometry,
  SpriteMaterial,
  Vector3,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Figure, PieceType } from '../../shared/scene.ts';
import { FIGURE_LOOKS, type FigureLook } from './scene-model.ts';

// Figures and building pieces (ADR 8). The scene draws the vendored CC0 Kenney GLBs in
// ./assets (Mini Characters, City Kit Industrial; see assets/README.md) and falls back to the
// low-poly primitives below while they load, if they fail, and in jsdom tests. Each figure is
// two meshes either way (Kenney: body + head; primitives: torso + arms), so ten workers stay
// around twenty draw calls.

/** Names the animation clips bind to inside a figure template. */
export const RIG = 'rig';
export const ARMS = 'arms';

function painted(geometry: BufferGeometry, color: string, at: Vector3): BufferGeometry {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  g.translate(at.x, at.y, at.z);
  const c = new Color(color);
  const count = g.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts);
  if (merged === null) throw new Error('figure parts have mismatched attributes');
  return merged;
}

const SKIN = '#f1c7a0';
const TROUSERS = '#3b4250';

function hatGeometry(look: FigureLook): BufferGeometry {
  switch (look.hat) {
    case 'hardhat':
      return merge([
        painted(
          new SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
          look.hatColor,
          new Vector3(0, 0.98, 0),
        ),
        painted(new CylinderGeometry(0.25, 0.25, 0.03, 12), look.hatColor, new Vector3(0, 0.98, 0)),
      ]);
    case 'helmet':
      return painted(
        new SphereGeometry(0.21, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.2),
        look.hatColor,
        new Vector3(0, 0.97, 0),
      );
    case 'cap':
      return painted(
        new CylinderGeometry(0.19, 0.2, 0.1, 10),
        look.hatColor,
        new Vector3(0, 1.02, 0),
      );
    case 'beret':
      return painted(
        new CylinderGeometry(0.22, 0.2, 0.06, 12),
        look.hatColor,
        new Vector3(0.03, 1.03, 0),
      );
  }
}

const figureMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
const templates = new Map<Figure, Group>();

/**
 * The shared template of one figure kind: `rig` (legs, body, head, hat) with `arms` pivoting
 * at the shoulders. Clone it with SkeletonUtils.clone; geometry and material stay shared.
 */
export function figureTemplate(figure: Figure): Group {
  const cached = templates.get(figure);
  if (cached !== undefined) return cached;
  const look = FIGURE_LOOKS[figure];
  const torso = new Mesh(
    merge([
      painted(new BoxGeometry(0.12, 0.34, 0.14), TROUSERS, new Vector3(-0.08, 0.17, 0)),
      painted(new BoxGeometry(0.12, 0.34, 0.14), TROUSERS, new Vector3(0.08, 0.17, 0)),
      painted(new BoxGeometry(0.34, 0.36, 0.2), look.body, new Vector3(0, 0.52, 0)),
      painted(new SphereGeometry(0.17, 10, 8), SKIN, new Vector3(0, 0.85, 0)),
      hatGeometry(look),
    ]),
    figureMaterial,
  );
  torso.name = 'torso';
  const arms = new Group();
  arms.name = ARMS;
  arms.position.set(0, 0.66, 0);
  arms.add(
    new Mesh(
      merge([
        painted(new BoxGeometry(0.09, 0.32, 0.1), look.body, new Vector3(-0.22, -0.14, 0)),
        painted(new BoxGeometry(0.09, 0.32, 0.1), look.body, new Vector3(0.22, -0.14, 0)),
      ]),
      figureMaterial,
    ),
  );
  const rig = new Group();
  rig.name = RIG;
  rig.add(torso, arms);
  const root = new Group();
  root.add(rig);
  templates.set(figure, root);
  return root;
}

const X = new Vector3(1, 0, 0);
const quat = (angle: number) => new Quaternion().setFromAxisAngle(X, angle).toArray();
const quatTrack = (name: string, times: number[], angles: number[]) =>
  new QuaternionKeyframeTrack(
    name,
    times,
    angles.flatMap((a) => quat(a)),
  );

export type ClipName = 'walk' | 'work' | 'idle' | 'sit';

/** One clip per activity; each worker plays them on its own AnimationMixer. */
export const CLIPS: Record<ClipName, AnimationClip> = {
  walk: new AnimationClip('walk', 0.5, [
    new NumberKeyframeTrack(
      `${RIG}.position[y]`,
      [0, 0.125, 0.25, 0.375, 0.5],
      [0, 0.05, 0, 0.05, 0],
      InterpolateSmooth,
    ),
    quatTrack(`${ARMS}.quaternion`, [0, 0.25, 0.5], [0.4, -0.4, 0.4]),
  ]),
  work: new AnimationClip('work', 0.7, [
    quatTrack(`${ARMS}.quaternion`, [0, 0.35, 0.45, 0.7], [-0.3, -1.9, -0.2, -0.3]),
    quatTrack(`${RIG}.quaternion`, [0, 0.35, 0.45, 0.7], [0, -0.05, 0.12, 0]),
  ]),
  idle: new AnimationClip('idle', 2, [
    new NumberKeyframeTrack(`${RIG}.scale[y]`, [0, 1, 2], [1, 1.025, 1], InterpolateSmooth),
  ]),
  sit: new AnimationClip('sit', 2, [
    new NumberKeyframeTrack(`${RIG}.position[y]`, [0, 1, 2], [-0.12, -0.11, -0.12]),
    quatTrack(`${ARMS}.quaternion`, [0, 2], [-0.6, -0.6]),
  ]),
};

let bubbleMaterial: SpriteMaterial | null = null;

/** The "?" bubble shown over a worker that waits for the owner. Shared by every worker. */
export function questionBubbleMaterial(): SpriteMaterial {
  if (bubbleMaterial !== null) return bubbleMaterial;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(32, 30, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#17202b';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#c0392b';
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 32, 32);
  }
  bubbleMaterial = new SpriteMaterial({ map: new CanvasTexture(canvas), depthWrite: false });
  return bubbleMaterial;
}

/**
 * Primitive geometry of one building piece. Floors and roofs have their origin at the bottom
 * centre; walls and windows are centred on their slot, which layoutPiece puts half a storey
 * up, so they stand on the floor slab and reach the next storey (PIECE_CELL).
 */
export function pieceGeometry(type: PieceType): BufferGeometry {
  switch (type) {
    case 'floor':
      return new BoxGeometry(1, 0.1, 1).translate(0, 0.05, 0);
    case 'wall':
      return new BoxGeometry(1, 0.9, 0.12).translate(0, 0.05, 0);
    case 'window':
      return merge([
        new BoxGeometry(1, 0.25, 0.12).translate(0, -0.275, 0),
        new BoxGeometry(1, 0.2, 0.12).translate(0, 0.4, 0),
        new BoxGeometry(0.2, 0.45, 0.12).translate(-0.4, 0.075, 0),
        new BoxGeometry(0.2, 0.45, 0.12).translate(0.4, 0.075, 0),
        new BoxGeometry(0.6, 0.45, 0.04).translate(0, 0.075, 0),
      ]);
    case 'roof':
      return new ConeGeometry(Math.SQRT1_2, 0.7, 4).rotateY(Math.PI / 4).translate(0, 0.35, 0);
  }
}

export const PIECE_COLORS: Record<PieceType, string> = {
  floor: '#b9a68c',
  wall: '#e8dcc6',
  window: '#9cc3d8',
  roof: '#b5523b',
};

// ---- Kenney GLBs ----------------------------------------------------------------------------

/** One instanced part of a building piece: one draw call per part. */
export interface PiecePart {
  geometry: BufferGeometry;
  material: Material;
}

/** A figure template (clone it with SkeletonUtils.clone) and the clips its rig plays. */
export interface FigureModel {
  object: Object3D;
  clips: Record<ClipName, AnimationClip>;
}

const primitiveFigures = new Map<Figure, FigureModel>();

/** The primitive stand-in figure: shown while the GLBs load, if they fail, and in jsdom. */
export function primitiveFigure(figure: Figure): FigureModel {
  let model = primitiveFigures.get(figure);
  if (model === undefined) {
    model = { object: figureTemplate(figure), clips: CLIPS };
    primitiveFigures.set(figure, model);
  }
  return model;
}

const primitiveParts = new Map<PieceType, PiecePart[]>();

/** The primitive stand-in of a building piece; shared by every Building, never disposed. */
export function primitivePieceParts(type: PieceType): PiecePart[] {
  let parts = primitiveParts.get(type);
  if (parts === undefined) {
    const material = new MeshStandardMaterial({ color: PIECE_COLORS[type], roughness: 0.85 });
    parts = [{ geometry: pieceGeometry(type), material }];
    primitiveParts.set(type, parts);
  }
  return parts;
}

// Vite only bundles assets referenced as `new URL('<literal>', import.meta.url)`.
/** Character per role: each role has its own model so they look distinct. */
export const CHARACTER_URLS: Record<Figure, string> = {
  foreman: new URL('./assets/mini-characters/character-male-c.glb', import.meta.url).href,
  builder: new URL('./assets/mini-characters/character-worker.glb', import.meta.url).href,
  inspector: new URL('./assets/mini-characters/character-female-c.glb', import.meta.url).href,
  drafter: new URL('./assets/mini-characters/character-male-e.glb', import.meta.url).href,
};

/** City Kit Industrial model per piece type; the kit has no floor slab, so floors stay primitive. */
export const PIECE_URLS = {
  wall: new URL('./assets/city-kit-industrial/building-e.glb', import.meta.url).href,
  window: new URL('./assets/city-kit-industrial/building-m.glb', import.meta.url).href,
  roof: new URL('./assets/city-kit-industrial/solar-panel-landscape-group.glb', import.meta.url)
    .href,
} as const satisfies Partial<Record<PieceType, string>>;

export type ModelPieceType = keyof typeof PIECE_URLS;

/**
 * A GLTFLoader for one Kenney pack. Every GLB of a pack references `Textures/colormap.png`;
 * the build hashes all assets into one folder, so the texture URL is pointed at this pack's
 * own colormap (the two packs' colormaps differ).
 */
function packLoader(colormapUrl: string): GLTFLoader {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => (url.endsWith('Textures/colormap.png') ? colormapUrl : url));
  return new GLTFLoader(manager);
}

export const CHARACTER_LOADER = packLoader(
  new URL('./assets/mini-characters/Textures/colormap.png', import.meta.url).href,
);
export const BUILDING_LOADER = packLoader(
  new URL('./assets/city-kit-industrial/Textures/colormap.png', import.meta.url).href,
);

/** Kenney clip played for each activity. */
const KENNEY_CLIPS: Record<ClipName, string> = {
  walk: 'walk',
  work: 'interact-right',
  idle: 'idle',
  sit: 'sit',
};


/** Kenney characters are 0.7-0.8 units tall; scaled, they match the primitive figures. */
const CHARACTER_SCALE = 1.45;

const gltfFigures = new WeakMap<GLTF, FigureModel>();

/** A figure template from a loaded Mini Characters GLB (cached per GLB). */
export function figureFromGltf(gltf: GLTF): FigureModel {
  const cached = gltfFigures.get(gltf);
  if (cached !== undefined) return cached;
  const clip = (name: ClipName) => {
    const found = gltf.animations.find((a) => a.name === KENNEY_CLIPS[name]);
    if (found === undefined) throw new Error(`character GLB has no "${KENNEY_CLIPS[name]}" clip`);
    return found;
  };
  // The GLB's own scene becomes the template's only child; workers get SkeletonUtils clones.
  const object = new Group();
  object.add(gltf.scene);
  gltf.scene.scale.setScalar(CHARACTER_SCALE);
  const model: FigureModel = {
    object,
    clips: { walk: clip('walk'), work: clip('work'), idle: clip('idle'), sit: clip('sit') },
  };
  gltfFigures.set(gltf, model);
  return model;
}

/** Where each GLB piece is fitted, in the coordinates of its slot (see pieceGeometry). */
const PIECE_CELL: Record<ModelPieceType, { size: Vector3; bottom: number; stretch: boolean }> = {
  wall: { size: new Vector3(1, 0.9, 1), bottom: -0.4, stretch: false },
  window: { size: new Vector3(1, 0.9, 1), bottom: -0.4, stretch: false },
  // The roof is scaled to the footprint per instance, so its x/z span one unit.
  roof: { size: new Vector3(1, 0.3, 1), bottom: 0, stretch: true },
};

const gltfParts = new WeakMap<GLTF, PiecePart[]>();

/**
 * The parts (one per mesh/material) of a City Kit Industrial GLB, baked and fitted into the
 * piece's cell: walls and windows keep their proportions; the roof is stretched to a unit
 * footprint. Cached per GLB; the geometries are never disposed.
 */
export function piecePartsFromGltf(type: ModelPieceType, gltf: GLTF): PiecePart[] {
  const cached = gltfParts.get(gltf);
  if (cached !== undefined) return cached;
  gltf.scene.updateMatrixWorld(true);
  const parts: PiecePart[] = [];
  const box = new Box3();
  gltf.scene.traverse((o) => {
    if (!(o instanceof Mesh) || Array.isArray(o.material)) return;
    const geometry = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    geometry.computeBoundingBox();
    if (geometry.boundingBox !== null) box.union(geometry.boundingBox);
    parts.push({ geometry, material: o.material as Material });
  });
  const cell = PIECE_CELL[type];
  const size = box.getSize(new Vector3());
  const fit = new Vector3(cell.size.x / size.x, cell.size.y / size.y, cell.size.z / size.z);
  const uniform = Math.min(fit.x, fit.y, fit.z);
  const scale = cell.stretch
    ? new Vector3(fit.x, Math.min(1, fit.y), fit.z)
    : new Vector3(uniform, uniform, uniform);
  const centre = box.getCenter(new Vector3());
  for (const p of parts) {
    p.geometry
      .translate(-centre.x, -box.min.y, -centre.z)
      .scale(scale.x, scale.y, scale.z)
      .translate(0, cell.bottom, 0);
  }
  gltfParts.set(gltf, parts);
  return parts;
}
