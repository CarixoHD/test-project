import { describe, expect, it } from 'vitest';
import type { AgentId, IssueId, ProductId } from '../../shared/ids.ts';
import { emptyScene, layoutPiece, type SceneState, type SceneWorker } from '../../shared/scene.ts';
import {
  FIGURE_LOOKS,
  PIECE_TYPES,
  debrisPlacements,
  instanceCounts,
  pieceFacing,
  piecesByType,
  sceneFrameloop,
  workerPlacements,
} from './scene-model.ts';

const P = 'p1' as ProductId;

function sceneWith(completed: number, total: number): SceneState {
  const s = emptyScene(P);
  return {
    ...s,
    totalIssues: total,
    pieces: Array.from({ length: completed }, (_, i) => ({
      issueId: `i${i}` as IssueId,
      placedAt: i + 1,
      ...layoutPiece(i, total),
    })),
  };
}

function worker(id: string, over: Partial<SceneWorker> = {}): SceneWorker {
  return {
    agentId: id as AgentId,
    role: 'implementer',
    figure: 'builder',
    issueId: null,
    activity: 'working',
    location: 'site',
    bubble: false,
    questionIds: [],
    ...over,
  };
}

describe('instanceCounts', () => {
  it('is zero for every piece type in an empty scene', () => {
    expect(instanceCounts(emptyScene(P))).toEqual({ floor: 0, wall: 0, window: 0, roof: 0 });
  });

  it('counts each piece type the layout produced, one instance per completed issue', () => {
    const scene = sceneWith(12, 12);
    const counts = instanceCounts(scene);
    const expected = { floor: 0, wall: 0, window: 0, roof: 0 };
    for (const p of scene.pieces) expected[p.type]++;
    expect(counts).toEqual(expected);
    expect(counts.roof).toBe(1);
    expect(counts.floor).toBeGreaterThan(0);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('follows the scene when more pieces are placed', () => {
    expect(instanceCounts(sceneWith(3, 100)).floor).toBe(1);
    const big = instanceCounts(sceneWith(100, 100));
    expect(big.floor + big.wall + big.window + big.roof).toBe(100);
  });
});

describe('piecesByType', () => {
  it('groups pieces under every piece type, keeping mergedOrder', () => {
    const groups = piecesByType(sceneWith(8, 20));
    expect(Object.keys(groups).sort()).toEqual([...PIECE_TYPES].sort());
    for (const type of PIECE_TYPES) {
      const placed = groups[type].map((p) => p.placedAt);
      expect(placed).toEqual([...placed].sort((a, b) => a - b));
      expect(groups[type].every((p) => p.type === type)).toBe(true);
    }
  });
});

describe('workerPlacements', () => {
  it('has one figure per scene worker, with the look of its role', () => {
    const scene: SceneState = {
      ...emptyScene(P),
      workers: [
        worker('a1', { figure: 'foreman', role: 'orchestrator' }),
        worker('a2'),
        worker('a3', { figure: 'inspector', role: 'reviewer' }),
      ],
    };
    const placed = workerPlacements(scene);
    expect(placed).toHaveLength(3);
    expect(placed.map((p) => p.look)).toEqual([
      FIGURE_LOOKS.foreman,
      FIGURE_LOOKS.builder,
      FIGURE_LOOKS.inspector,
    ]);
  });

  it('gives every worker its own spot and sends rate-limited ones to the bench', () => {
    const workers = Array.from({ length: 10 }, (_, i) =>
      worker(`a${i}`, i % 3 === 0 ? { location: 'bench', activity: 'resting' } : {}),
    );
    const placed = workerPlacements({ ...emptyScene(P), workers });
    const spots = new Set(placed.map((p) => p.target.join(',')));
    expect(spots.size).toBe(10);
    const bench = placed.filter((p) => p.worker.location === 'bench');
    expect(bench).toHaveLength(4);
    expect(bench.every((p) => p.atBench)).toBe(true);
  });

  it('removes a figure when its worker leaves the scene', () => {
    const two = { ...emptyScene(P), workers: [worker('a1'), worker('a2')] };
    expect(workerPlacements({ ...two, workers: two.workers.slice(1) })).toHaveLength(1);
  });
});

describe('debrisPlacements', () => {
  it('has one pile per failed issue, each at its own spot', () => {
    const scene: SceneState = {
      ...emptyScene(P),
      debris: [{ issueId: 'i1' as IssueId }, { issueId: 'i2' as IssueId }],
    };
    const piles = debrisPlacements(scene);
    expect(piles).toHaveLength(2);
    expect(piles[0]?.pos).not.toEqual(piles[1]?.pos);
  });
});

describe('sceneFrameloop', () => {
  it('never renders while collapsed or off-screen', () => {
    expect(sceneFrameloop({ expanded: false, onScreen: true, reducedMotion: false })).toBe('never');
    expect(sceneFrameloop({ expanded: true, onScreen: false, reducedMotion: false })).toBe('never');
  });

  it('animates continuously when visible, and only on demand with reduced motion', () => {
    expect(sceneFrameloop({ expanded: true, onScreen: true, reducedMotion: false })).toBe('always');
    expect(sceneFrameloop({ expanded: true, onScreen: true, reducedMotion: true })).toBe('demand');
  });
});

describe('pieceFacing', () => {
  it('turns every wall and window module to face away from the building centre', () => {
    const pieces = sceneWith(40, 41).pieces.filter((p) => p.type === 'wall' || p.type === 'window');
    expect(pieces.length).toBeGreaterThan(8);
    for (const p of pieces) {
      const angle = pieceFacing(p);
      // A model's front faces +z; rotated by `angle` it points along (sin, cos).
      const front = [Math.sin(angle), Math.cos(angle)] as const;
      expect(front[0] * p.pos[0] + front[1] * p.pos[2]).toBeGreaterThan(0);
      expect(Math.abs(front[0] * p.pos[2] - front[1] * p.pos[0])).toBeLessThan(
        Math.max(Math.abs(p.pos[0]), Math.abs(p.pos[2])),
      );
    }
  });

  it('keeps the layout rotation of floors and roofs', () => {
    for (const p of sceneWith(3, 3).pieces.filter((x) => x.type === 'floor' || x.type === 'roof')) {
      expect(pieceFacing(p)).toBe(p.rotY);
    }
  });
});
