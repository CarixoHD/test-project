// Building layout for the 3D construction view (ADR 8): where the n-th completed issue's
// piece goes. Pure and deterministic.

export type PieceType = 'floor' | 'wall' | 'window' | 'roof';
export type Vec3 = readonly [number, number, number];

export interface PieceLayout {
  type: PieceType;
  /** Building-local position; one storey is 1 unit high, y = 0 is the ground floor. */
  pos: Vec3;
  /**
   * Rotation around the y axis, in radians. Walls and windows turn their local +z outward,
   * away from the footprint centre, so their outer face can lie on the perimeter line.
   */
  rotY: number;
  /**
   * The one wall or window per side whose local -x end meets the next side at a corner (the
   * last slot of the side, clockwise). The view shortens only this piece at that end, so the
   * sides meet like a pinwheel; every other piece spans its full slot. False for floors and roofs.
   */
  corner: boolean;
}

/** Footprint side lengths are whole units; each storey holds a floor plus 4·W perimeter pieces. */
const storeySize = (width: number) => 1 + 4 * width;

/** Smallest footprint whose storeys (≤ width of them) fit `count` pieces: roughly a cube. */
function footprintWidth(count: number): number {
  let width = 1;
  while (width * storeySize(width) < count) width++;
  return width;
}

/** Normalises -0 to 0 so positions compare equal with plain deep equality. */
const n0 = (x: number) => x + 0;

/**
 * Deterministic layout of the `index`-th placed piece (0-based) for a building sized for
 * `totalIssues` pieces. The last piece (`totalIssues - 1`) is the roof; the others fill
 * storeys bottom-up: a floor slab first, then walls and windows around the perimeter.
 * No two indices of one building share a position. An index at or beyond `totalIssues`
 * is laid out as if the building had `index + 1` pieces.
 */
export function layoutPiece(index: number, totalIssues: number): PieceLayout {
  const total = Math.max(totalIssues, index + 1);
  const body = total - 1; // pieces below the roof
  const width = footprintWidth(body);
  const perStorey = storeySize(width);
  if (index === total - 1) {
    const storeys = Math.ceil(body / perStorey);
    return { type: 'roof', pos: [0, storeys, 0], rotY: 0, corner: false };
  }
  const level = Math.floor(index / perStorey);
  const slot = index % perStorey;
  if (slot === 0) return { type: 'floor', pos: [0, level, 0], rotY: 0, corner: false };

  const k = slot - 1;
  const side = Math.floor(k / width); // 0 north, 1 east, 2 south, 3 west
  const offset = k % width;
  const half = width / 2;
  const along = -half + 0.5 + offset; // runs clockwise seen from above
  const sides: Record<number, [number, number]> = {
    0: [along, -half],
    1: [half, along],
    2: [-along, half],
    3: [-half, -along],
  };
  const [x, z] = sides[side] ?? [0, 0];
  const type: PieceType = (offset + level) % 2 === 1 ? 'window' : 'wall';
  // Local +z rotated by rotY points along (sin, cos): north π, east π/2, south 0, west -π/2.
  // Local +x then points against the clockwise run, so the last slot's -x end is the corner.
  return {
    type,
    pos: [n0(x), level + 0.5, n0(z)],
    rotY: Math.PI - (side * Math.PI) / 2,
    corner: offset === width - 1,
  };
}
