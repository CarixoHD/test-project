import { ContactShadows } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InstancedMesh } from 'three';
import {
  AnimationMixer,
  BoxGeometry,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
  type Group,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { PieceType, ScenePiece, SceneState } from '../../shared/scene.ts';
import {
  BENCH_POS,
  DESK_POS,
  debrisPlacements,
  PIECE_TYPES,
  piecesByType,
  SITE_GATE,
  workerPlacements,
  type Frameloop,
  type Scene3DProps,
  type WorkerPlacement,
} from './scene-model.ts';
import {
  CLIPS,
  figureTemplate,
  PIECE_COLORS,
  pieceGeometry,
  questionBubbleMaterial,
  type ClipName,
} from './figures.ts';

// The WebGL construction site (ADR 8). Loaded lazily by ScenePanel and rendering state only:
// one InstancedMesh per piece type, one cloned figure + AnimationMixer per worker, debris
// piles, a bench and a desk. DPR ≤ 1.5, one ContactShadows, no postprocessing.

const PLACE_SECONDS = 0.6;
const WALK_SPEED = 2.2; // units per second

declare global {
  interface Window {
    /** Render stats for the E2E smoke test; set in dev/test builds or with SCENE_STATS_FLAG. */
    __vibecodeScene?: {
      drawCalls: number;
      triangles: number;
      frames: number;
      /** Figures and pieces in the scene state being drawn. */
      workers: number;
      pieces: number;
    };
  }
}

/** localStorage flag that turns the stats on in a production build (the E2E smoke test). */
export const SCENE_STATS_FLAG = 'vibecode.debug.sceneStats';

function exposeStats(): boolean {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') return true;
  try {
    return localStorage.getItem(SCENE_STATS_FLAG) === '1';
  } catch {
    return false;
  }
}

function webglAvailable(): boolean {
  return typeof ResizeObserver !== 'undefined' && typeof WebGL2RenderingContext !== 'undefined';
}

export default function Scene3D({ scene, frameloop, reducedMotion }: Scene3DProps) {
  if (!webglAvailable()) {
    return <p className="scene-panel__loading">This browser cannot show the 3D view.</p>;
  }
  const animate = !reducedMotion;
  const stats = exposeStats();
  return (
    <Canvas
      className="scene-panel__canvas"
      frameloop={frameloop}
      dpr={[1, 1.5]}
      camera={{ position: [9, 8, 11], fov: 38 }}
      gl={{ antialias: true, powerPreference: 'low-power' }}
    >
      <color attach="background" args={['#e7ecef']} />
      <hemisphereLight args={['#ffffff', '#b8b0a0', 1.6]} />
      <directionalLight position={[6, 10, 4]} intensity={1.6} />
      <Ground />
      <Building scene={scene} animate={animate} />
      <DebrisPiles scene={scene} />
      <SiteProps />
      <Workers scene={scene} animate={animate} />
      <ContactShadows
        position={[0, 0.005, 0]}
        scale={26}
        resolution={256}
        opacity={0.45}
        blur={2}
        far={5}
        frames={animate ? Infinity : 1}
      />
      <RenderOnChange frameloop={frameloop} scene={scene} />
      {stats && <StatsProbe scene={scene} />}
    </Canvas>
  );
}

/** In demand mode (reduced motion) draw one frame whenever the view or the scene changes. */
function RenderOnChange({ frameloop, scene }: { frameloop: Frameloop; scene: SceneState }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (frameloop === 'demand') invalidate();
  }, [frameloop, scene, invalidate]);
  return null;
}

function StatsProbe({ scene }: { scene: SceneState }) {
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  // Runs first in each frame, before ContactShadows' own passes, so `info` still holds the
  // previous frame's main render (R3F renders the scene after every useFrame callback).
  useFrame(() => {
    frames.current += 1;
    window.__vibecodeScene = {
      drawCalls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      frames: frames.current,
      workers: scene.workers.length,
      pieces: scene.pieces.length,
    };
  }, -1000);
  useEffect(() => () => void delete window.__vibecodeScene, []);
  return null;
}

function Ground() {
  return (
    <mesh rotation-x={-Math.PI / 2}>
      <circleGeometry args={[13, 40]} />
      <meshStandardMaterial color="#cfc8b4" roughness={1} />
    </mesh>
  );
}

// ---- building ------------------------------------------------------------------------------

/** Half the footprint, from the walls and windows placed so far. */
function footprintHalf(pieces: readonly ScenePiece[]): number {
  let half = 0.5;
  for (const p of pieces) {
    if (p.type === 'wall' || p.type === 'window') {
      half = Math.max(half, Math.abs(p.pos[0]), Math.abs(p.pos[2]));
    }
  }
  return half;
}

const capacityFor = (n: number) => Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(n, 1))));

function Building({ scene, animate }: { scene: SceneState; animate: boolean }) {
  const groups = useMemo(() => piecesByType(scene), [scene]);
  const half = footprintHalf(scene.pieces);
  // Pieces up to this mergedOrder were already on screen; newer ones get the drop animation.
  const shown = useRef<number | null>(null);
  const [since] = useState(() => new Map<string, number>());
  const clock = useThree((s) => s.clock);
  useLayoutEffect(() => {
    const top = scene.pieces.reduce((m, p) => Math.max(m, p.placedAt), 0);
    if (shown.current !== null && animate) {
      for (const p of scene.pieces) {
        if (p.placedAt > shown.current) since.set(p.issueId, clock.elapsedTime);
      }
    }
    shown.current = Math.max(shown.current ?? 0, top);
  }, [scene, animate, since, clock]);

  return (
    <group>
      {PIECE_TYPES.map((type) => (
        <PieceInstances
          key={`${type}-${String(capacityFor(groups[type].length))}`}
          type={type}
          pieces={groups[type]}
          half={half}
          since={since}
          animate={animate}
        />
      ))}
    </group>
  );
}

const tmp = new Object3D();
const UP = new Vector3(0, 1, 0);

/** Writes one piece's matrix; `t` in [0,1] is the placement animation (1 = settled). */
function pieceMatrix(p: ScenePiece, half: number, t: number, out: Matrix4): Matrix4 {
  const ease = 1 - (1 - t) ** 3;
  const drop = (1 - ease) * 1.5;
  tmp.position.set(p.pos[0], p.pos[1] + drop, p.pos[2]);
  tmp.quaternion.setFromAxisAngle(UP, p.rotY);
  const span = 2 * half;
  const s = 0.4 + 0.6 * ease;
  if (p.type === 'floor') tmp.scale.set(span * s, 1, span * s);
  else if (p.type === 'roof') tmp.scale.set((span + 0.4) * s, s, (span + 0.4) * s);
  else tmp.scale.set(s, s, s);
  tmp.updateMatrix();
  return out.copy(tmp.matrix);
}

function PieceInstances({
  type,
  pieces,
  half,
  since,
  animate,
}: {
  type: PieceType;
  pieces: ScenePiece[];
  half: number;
  since: Map<string, number>;
  animate: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const capacity = capacityFor(pieces.length);
  const geometry = useMemo(() => pieceGeometry(type), [type]);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: PIECE_COLORS[type], roughness: 0.85 }),
    [type],
  );
  const matrix = useMemo(() => new Matrix4(), []);
  const invalidate = useThree((s) => s.invalidate);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (m === null) return;
    pieces.forEach((p, i) =>
      m.setMatrixAt(i, pieceMatrix(p, half, since.has(p.issueId) ? 0 : 1, matrix)),
    );
    m.count = pieces.length;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [pieces, half, since, matrix, invalidate]);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (m === null || since.size === 0 || !animate) return;
    let changed = false;
    pieces.forEach((p, i) => {
      const start = since.get(p.issueId);
      if (start === undefined) return;
      const t = Math.min(1, (clock.elapsedTime - start) / PLACE_SECONDS);
      m.setMatrixAt(i, pieceMatrix(p, half, t, matrix));
      if (t >= 1) since.delete(p.issueId);
      changed = true;
    });
    if (changed) m.instanceMatrix.needsUpdate = true;
  });

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  return <instancedMesh ref={mesh} args={[geometry, material, capacity]} frustumCulled={false} />;
}

// ---- debris, bench, desk --------------------------------------------------------------------

const RUBBLE = [
  [0, 0.12, 0, 0.3, 0.6],
  [0.25, 0.08, 0.15, 1.1, 0.4],
  [-0.2, 0.07, 0.2, 2.2, 0.35],
] as const;
const MAX_DEBRIS = 64;

function DebrisPiles({ scene }: { scene: SceneState }) {
  const mesh = useRef<InstancedMesh>(null);
  const piles = useMemo(() => debrisPlacements(scene).slice(0, MAX_DEBRIS), [scene]);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (m === null) return;
    let i = 0;
    for (const pile of piles) {
      for (const [dx, y, dz, rot, size] of RUBBLE) {
        tmp.position.set(pile.pos[0] + dx, y, pile.pos[2] + dz);
        tmp.quaternion.setFromAxisAngle(UP, rot);
        tmp.scale.setScalar(size);
        tmp.updateMatrix();
        m.setMatrixAt(i++, tmp.matrix);
      }
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [piles, invalidate]);
  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, MAX_DEBRIS * RUBBLE.length]}
      frustumCulled={false}
    >
      <boxGeometry args={[0.5, 0.3, 0.4]} />
      <meshStandardMaterial color="#7d7468" roughness={1} />
    </instancedMesh>
  );
}

const benchGeometry = new BoxGeometry(2.2, 0.08, 0.5);
const deskGeometry = new BoxGeometry(1.6, 0.08, 0.8);

function SiteProps() {
  return (
    <>
      <mesh geometry={benchGeometry} position={[BENCH_POS[0], 0.32, BENCH_POS[2] + 0.3]}>
        <meshStandardMaterial color="#8b5e3c" />
      </mesh>
      <mesh geometry={deskGeometry} position={[DESK_POS[0] + 0.4, 0.62, DESK_POS[2]]}>
        <meshStandardMaterial color="#5c6f80" />
      </mesh>
    </>
  );
}

// ---- workers ---------------------------------------------------------------------------------

interface ShownWorker {
  placement: WorkerPlacement;
  leaving: boolean;
}

/** Departed workers walk back to the gate before they disappear (immediately with reduced motion). */
function Workers({ scene, animate }: { scene: SceneState; animate: boolean }) {
  const placements = useMemo(() => workerPlacements(scene), [scene]);
  const [prev, setPrev] = useState(placements);
  const [leaving, setLeaving] = useState<WorkerPlacement[]>([]);
  if (prev !== placements) {
    const present = new Set(placements.map((p) => p.worker.agentId));
    const gone = animate ? prev.filter((p) => !present.has(p.worker.agentId)) : [];
    setPrev(placements);
    setLeaving((l) => [...l.filter((p) => !present.has(p.worker.agentId)), ...gone]);
  }
  useEffect(() => {
    if (leaving.length === 0) return;
    const timer = setTimeout(() => setLeaving([]), 6000);
    return () => clearTimeout(timer);
  }, [leaving]);

  const shown: ShownWorker[] = [
    ...placements.map((placement) => ({ placement, leaving: false })),
    ...leaving.map((placement) => ({ placement, leaving: true })),
  ];
  return (
    <>
      {shown.map(({ placement, leaving: isLeaving }) => (
        <WorkerFigure
          key={placement.worker.agentId}
          placement={placement}
          leaving={isLeaving}
          animate={animate}
        />
      ))}
    </>
  );
}

const ROT = new Quaternion();

function clipFor(placement: WorkerPlacement, moving: boolean): ClipName {
  if (moving) return 'walk';
  if (placement.atBench) return 'sit';
  return placement.worker.activity === 'working' ? 'work' : 'idle';
}

function WorkerFigure({
  placement,
  leaving,
  animate,
}: {
  placement: WorkerPlacement;
  leaving: boolean;
  animate: boolean;
}) {
  const figure = placement.worker.figure;
  const rig = useMemo(() => cloneSkinned(figureTemplate(figure)), [figure]);
  const mixer = useMemo(() => new AnimationMixer(rig), [rig]);
  const root = useRef<Group>(null);
  const current = useRef<{ name: ClipName; action: AnimationAction } | null>(null);
  const target = leaving ? SITE_GATE : placement.target;
  const facing = placement.facing;

  useLayoutEffect(() => {
    const g = root.current;
    if (g === null) return;
    // New figures walk in from the gate; with reduced motion they simply stand at their spot.
    if (animate) g.position.set(...SITE_GATE);
    else g.position.set(...placement.target);
    // Only on mount: later moves are walked in useFrame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const g = root.current;
    if (g === null || animate) return;
    g.position.set(...target);
    g.rotation.set(0, facing, 0);
    mixer.stopAllAction();
    current.current = null;
  }, [animate, target, facing, mixer]);

  useEffect(() => () => void mixer.stopAllAction(), [mixer]);

  useFrame((_, delta) => {
    const g = root.current;
    if (g === null || !animate) return;
    const dt = Math.min(delta, 0.1);
    const to = new Vector3(...target);
    const offset = to.sub(g.position);
    const distance = offset.length();
    const moving = distance > 0.02;
    if (moving) {
      const step = Math.min(distance, WALK_SPEED * dt);
      g.position.addScaledVector(offset.normalize(), step);
      ROT.setFromAxisAngle(UP, Math.atan2(offset.x, offset.z));
    } else {
      ROT.setFromAxisAngle(UP, facing);
    }
    g.quaternion.slerp(ROT, Math.min(1, dt * 8));
    const name = clipFor(placement, moving);
    if (current.current?.name !== name) {
      const action = mixer.clipAction(CLIPS[name]).reset().fadeIn(0.2).play();
      current.current?.action.fadeOut(0.2);
      current.current = { name, action };
    }
    mixer.update(dt);
  });

  return (
    <group ref={root}>
      <primitive object={rig} />
      {placement.worker.bubble && !leaving && (
        <sprite material={questionBubbleMaterial()} position={[0, 1.45, 0]} scale={0.45} />
      )}
    </group>
  );
}
