import { describe, expect, it } from 'vitest';
import { layoutPiece } from './scene-layout.ts';

describe('layoutPiece perimeter rotation', () => {
  it("turns every wall and window so its local +z points out of its side's centre", () => {
    for (const total of [6, 19, 40, 100]) {
      for (let i = 0; i < total - 1; i++) {
        const p = layoutPiece(i, total);
        if (p.type !== 'wall' && p.type !== 'window') continue;
        const [x, , z] = p.pos;
        // Rotated by rotY around y, local +z points along (sin, cos).
        const out = [Math.sin(p.rotY), Math.cos(p.rotY)] as const;
        const half = Math.max(Math.abs(x), Math.abs(z));
        const normal = Math.abs(z) === half ? [0, Math.sign(z)] : [Math.sign(x), 0];
        expect(out[0], `${i}/${total}`).toBeCloseTo(normal[0] ?? NaN, 9);
        expect(out[1], `${i}/${total}`).toBeCloseTo(normal[1] ?? NaN, 9);
      }
    }
  });
});
