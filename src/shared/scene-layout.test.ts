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

describe('layoutPiece corner pieces', () => {
  it('marks exactly the last piece of each side (whose clockwise end meets the corner)', () => {
    for (const width of [1, 2, 3]) {
      const perStorey = 1 + 4 * width;
      const total = width * perStorey + 1;
      for (let i = 0; i < total; i++) {
        const p = layoutPiece(i, total);
        const slot = i % perStorey;
        const isPerimeter = i < total - 1 && slot !== 0;
        const last = isPerimeter && (slot - 1) % width === width - 1;
        expect(p.corner, `${i}/${total}`).toBe(last);
      }
    }
  });

  it("puts the corner piece's local -x end at the corner of the footprint", () => {
    for (const width of [1, 2, 3]) {
      const total = width * (1 + 4 * width) + 1;
      for (let i = 0; i < total - 1; i++) {
        const p = layoutPiece(i, total);
        if (!p.corner) continue;
        // Local -x rotated by rotY around y points along (-cos, sin).
        const end = [p.pos[0] - 0.5 * Math.cos(p.rotY), p.pos[2] + 0.5 * Math.sin(p.rotY)];
        expect(Math.abs(end[0] ?? NaN), `${i}/${total}`).toBeCloseTo(width / 2, 9);
        expect(Math.abs(end[1] ?? NaN), `${i}/${total}`).toBeCloseTo(width / 2, 9);
      }
    }
  });
});
