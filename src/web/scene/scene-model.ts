import type { AgentId } from '../../shared/ids.ts';
import { roleLabel } from '../features/agents/index.ts';
import type {
  Figure,
  PieceType,
  ScenePiece,
  SceneState,
  SceneWorker,
  Vec3,
} from '../../shared/scene.ts';

// Pure mapping from the shared SceneState to what the 3D view draws (ADR 8). Kept free of
// three.js so it can be unit-tested without WebGL: instance counts per piece type, where
// each worker figure stands, and where debris piles go.

export const PIECE_TYPES = ['floor', 'wall', 'window', 'roof'] as const satisfies PieceType[];

export type Frameloop = 'always' | 'demand' | 'never';

/**
 * Canvas frameloop: no rendering at all while the panel is collapsed or scrolled off-screen;
 * with reduced motion, render only when something changes (no animation loop).
 */
export function sceneFrameloop(v: {
  expanded: boolean;
  onScreen: boolean;
  reducedMotion: boolean;
  /**
   * A worker figure was clicked: the panel opens that agent's AgentPanel. The only thing the
   * scene can do; it never controls agents (ADR 8). Must keep its identity across renders.
   */
  onPickWorker?: ((agentId: AgentId) => void) | undefined;
}): Frameloop {
  if (!v.expanded || !v.onScreen) return 'never';
  return v.reducedMotion ? 'demand' : 'always';
}

export function piecesByType(scene: SceneState): Record<PieceType, ScenePiece[]> {
  const groups: Record<PieceType, ScenePiece[]> = { floor: [], wall: [], window: [], roof: [] };
  for (const p of scene.pieces) groups[p.type].push(p);
  return groups;
}

/** Instances each piece type's InstancedMesh draws. */
export function instanceCounts(scene: SceneState): Record<PieceType, number> {
  const groups = piecesByType(scene);
  return {
    floor: groups.floor.length,
    wall: groups.wall.length,
    window: groups.window.length,
    roof: groups.roof.length,
  };
}

/**
 * Rotation around y the 3D view draws a piece with. Wall and window modules are small
 * buildings whose front faces +z; they turn outward on their side of the footprint (the
 * layout's rotY only says which side a slot is on). Floors and roofs keep the layout's rotY.
 */
export function pieceFacing(p: ScenePiece): number {
  if (p.type !== 'wall' && p.type !== 'window') return p.rotY;
  const [x, , z] = p.pos;
  if (Math.abs(z) >= Math.abs(x)) return z < 0 ? Math.PI : 0;
  return x > 0 ? Math.PI / 2 : -Math.PI / 2;
}

/** How a role's figure looks: body colour and hat. Text in the agent list says the same. */
export interface FigureLook {
  body: string;
  hat: 'hardhat' | 'cap' | 'helmet' | 'beret';
  hatColor: string;
}

export const FIGURE_LOOKS: Record<Figure, FigureLook> = {
  foreman: { body: '#2f5d8a', hat: 'hardhat', hatColor: '#f4f4f0' },
  builder: { body: '#d9822b', hat: 'hardhat', hatColor: '#f2c230' },
  inspector: { body: '#4d8a4a', hat: 'helmet', hatColor: '#e04848' },
  drafter: { body: '#7a5aa6', hat: 'beret', hatColor: '#2b2b33' },
};

/** The small label shown while hovering a figure; the agent list uses the same wording. */
export function workerName(worker: SceneWorker): string {
  return roleLabel(worker.role);
}

export interface WorkerPlacement {
  worker: SceneWorker;
  look: FigureLook;
  /** Where the figure stands once it has walked there. */
  target: Vec3;
  /** Rotation around y so the figure faces its work (the building, the desk). */
  facing: number;
  atBench: boolean;
}

/** Half the building's footprint, from the pieces placed so far (at least one unit). */
function buildingRadius(scene: SceneState): number {
  let r = 1;
  for (const p of scene.pieces) r = Math.max(r, Math.abs(p.pos[0]), Math.abs(p.pos[2]));
  return r;
}

const round = (x: number) => Math.round(x * 1000) / 1000 + 0;

export const DESK_POS: Vec3 = [-4.5, 0, 3.5];
export const BENCH_POS: Vec3 = [4.5, 0, 3.5];
/** Where figures enter from and leave to. */
export const SITE_GATE: Vec3 = [0, 0, 9];

export function workerPlacements(scene: SceneState): WorkerPlacement[] {
  const ring = buildingRadius(scene) + 1.2;
  const site = scene.workers.filter((w) => w.location === 'site');
  const desk = scene.workers.filter((w) => w.location === 'desk');
  const bench = scene.workers.filter((w) => w.location === 'bench');
  const placed = new Map<SceneWorker, Omit<WorkerPlacement, 'worker' | 'look'>>();

  site.forEach((w, i) => {
    const angle = (i / Math.max(site.length, 1)) * Math.PI * 2 + Math.PI / 4;
    const target: Vec3 = [round(Math.sin(angle) * ring), 0, round(Math.cos(angle) * ring)];
    placed.set(w, { target, facing: angle + Math.PI, atBench: false });
  });
  desk.forEach((w, i) => {
    const target: Vec3 = [DESK_POS[0] + i * 0.8, 0, DESK_POS[2] + 0.7];
    placed.set(w, { target, facing: Math.PI, atBench: false });
  });
  bench.forEach((w, i) => {
    const target: Vec3 = [BENCH_POS[0] - 0.9 + i * 0.6, 0, BENCH_POS[2] + 0.3];
    placed.set(w, { target, facing: 0, atBench: true });
  });

  return scene.workers.map((worker) => {
    const p = placed.get(worker) ?? { target: SITE_GATE, facing: 0, atBench: false };
    return { worker, look: FIGURE_LOOKS[worker.figure], ...p };
  });
}

export interface DebrisPlacement {
  issueId: string;
  pos: Vec3;
}

/** Debris piles line up beside the building, one per failed issue. */
export function debrisPlacements(scene: SceneState): DebrisPlacement[] {
  const x = -(buildingRadius(scene) + 2.5);
  return scene.debris.map((d, i) => ({
    issueId: d.issueId,
    pos: [x - Math.floor(i / 6) * 1.2, 0, -3 + (i % 6) * 1.2] as const,
  }));
}

/** Props of the lazily loaded WebGL scene (Scene3D.tsx). */
export interface Scene3DProps {
  scene: SceneState;
  frameloop: Frameloop;
  /** prefers-reduced-motion: no placement, walk or work animations. */
  reducedMotion: boolean;
  /**
   * A worker figure was clicked: the panel opens that agent's AgentPanel. The only thing the
   * scene can do; it never controls agents (ADR 8). Must keep its identity across renders.
   */
  onPickWorker?: ((agentId: AgentId) => void) | undefined;
}
