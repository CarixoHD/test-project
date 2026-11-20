import {
  AnimationClip,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InterpolateSmooth,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  SphereGeometry,
  SpriteMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Figure, PieceType } from '../../shared/scene.ts';
import { FIGURE_LOOKS, type FigureLook } from './scene-model.ts';

// Low-poly figures and building pieces from three.js primitives. They stand in for the Kenney
// Mini Characters / building-kit GLBs (ADR 8), which could not be downloaded in the build
// sandbox; swapping them in only changes this file. Each figure is two meshes (torso, arms)
// with vertex colours, so ten workers stay around twenty draw calls.

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
        painted(new SphereGeometry(0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), look.hatColor, new Vector3(0, 0.98, 0)),
        painted(new CylinderGeometry(0.25, 0.25, 0.03, 12), look.hatColor, new Vector3(0, 0.98, 0)),
      ]);
    case 'helmet':
      return painted(new SphereGeometry(0.21, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.2), look.hatColor, new Vector3(0, 0.97, 0));
    case 'cap':
      return painted(new CylinderGeometry(0.19, 0.2, 0.1, 10), look.hatColor, new Vector3(0, 1.02, 0));
    case 'beret':
      return painted(new CylinderGeometry(0.22, 0.2, 0.06, 12), look.hatColor, new Vector3(0.03, 1.03, 0));
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
  new QuaternionKeyframeTrack(name, times, angles.flatMap((a) => quat(a)));

export type ClipName = 'walk' | 'work' | 'idle' | 'sit';

/** One clip per activity; each worker plays them on its own AnimationMixer. */
export const CLIPS: Record<ClipName, AnimationClip> = {
  walk: new AnimationClip('walk', 0.5, [
    new NumberKeyframeTrack(`${RIG}.position[y]`, [0, 0.125, 0.25, 0.375, 0.5], [0, 0.05, 0, 0.05, 0], InterpolateSmooth),
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

/** Geometry of one building piece, with its origin at the bottom centre. */
export function pieceGeometry(type: PieceType): BufferGeometry {
  switch (type) {
    case 'floor':
      return new BoxGeometry(1, 0.1, 1).translate(0, 0.05, 0);
    case 'wall':
      return new BoxGeometry(1, 0.9, 0.12).translate(0, 0.55, 0);
    case 'window':
      return merge([
        new BoxGeometry(1, 0.25, 0.12).translate(0, 0.225, 0),
        new BoxGeometry(1, 0.2, 0.12).translate(0, 0.9, 0),
        new BoxGeometry(0.2, 0.45, 0.12).translate(-0.4, 0.575, 0),
        new BoxGeometry(0.2, 0.45, 0.12).translate(0.4, 0.575, 0),
        new BoxGeometry(0.6, 0.45, 0.04).translate(0, 0.575, 0),
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
