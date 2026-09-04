/**
 * Parametric warp layers — the part of the stack that is NOT hand-placed.
 *
 *   content uv → [homography] → [cylinder] → model position M(uv)
 *
 * The hand-edited fence + bezier layers ride on top of M as a residual
 * displacement (see compose.ts), so with both layers here disabled the
 * pipeline is exactly the old fence→bezier chain and old projects render
 * unchanged.
 *
 * Homography (8 DOF): the true perspective corner-pin. A bilinear 2×2 grid
 * puts u=0.5 on the edge midpoint; under perspective it must not (the
 * cross-ratio wins), which is what operators were hand-correcting with
 * dense lattices. Closed form after Heckbert (unit square → quad), no
 * 8×8 solve.
 *
 * Cylinder: analytic model of an ultra-short-throw projector lighting a
 * concave cylindrical wall (vertical axis). We evaluate it FORWARD —
 * content uv → point on the wall → pinhole + radial distortion → raster —
 * which needs no ray/cylinder intersection and no inversion; the mesh is
 * parametrised by uv already. Dragging a homography corner through the
 * cylinder uses a generic Newton inverse (invertMap) instead.
 *
 * Units: metres for radius/height/arc/pos, degrees for angles. World Y is
 * up; the cylinder axis is the world Y axis; the wall centre sits at
 * (0, ·, R). A projector at zero rotation looks along +Z at that centre.
 */
import { applyH, H3 } from './calibrate';

export type Corner = [number, number];

export interface HomographyState {
  enabled: boolean;
  /** destinations of the unit-square corners (0,0),(1,0),(1,1),(0,1) — region-local */
  corners: [Corner, Corner, Corner, Corner];
}

export interface CylinderState {
  enabled: boolean;
  /** wall radius (m) */
  radius: number;
  /** wall height (m); content v=0 is the top edge */
  height: number;
  /** arc length of wall the content spans (m), centred on θ=0 */
  arc: number;
  /** projector centre of projection (m): x right, y up, z toward the wall */
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  roll: number;
  /** throw distance / image width */
  throwRatio: number;
  /** vertical lens shift as a fraction of image height (0 = centred, 0.5 = optical axis on the bottom edge) */
  lensOffset: number;
  /**
   * Radial distortion of the LENS (not wall shape): the UST mirror path is
   * not a pinhole, and leaving these at 0 pushes real barrel residual onto
   * the hand-placed layer. xd = xn (1 + k1 r² + k2 r⁴).
   */
  k1: number;
  k2: number;
}

export const UNIT_CORNERS: [Corner, Corner, Corner, Corner] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export function defaultHomography(): HomographyState {
  return { enabled: false, corners: UNIT_CORNERS.map((c) => [...c]) as HomographyState['corners'] };
}

export function defaultCylinder(): CylinderState {
  // Wall of radius 3 m, projector on the axis at mid-height, throw chosen so
  // the image width at the wall equals the arc — a roughly full-frame start.
  return {
    enabled: false,
    radius: 3,
    height: 2,
    arc: 4,
    pos: [0, 1, 0],
    yaw: 0,
    pitch: 0,
    roll: 0,
    throwRatio: 0.75,
    lensOffset: 0,
    k1: 0,
    k2: 0,
  };
}

const EPS = 1e-9;

/**
 * Heckbert's closed-form unit-square → quad homography. Row-major 3×3
 * with h22 = 1 (same layout as calibrate.ts H3, so applyH/invertH apply).
 * Parallelograms (and a singular denominator) take the affine branch.
 */
export function homographyMatrix(c: HomographyState['corners']): H3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = c;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  let h20 = 0;
  let h21 = 0;
  if ((Math.abs(dx3) > EPS || Math.abs(dy3) > EPS) && Math.abs(den) > EPS) {
    h20 = (dx3 * dy2 - dx2 * dy3) / den;
    h21 = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [
    x1 - x0 + h20 * x1, x3 - x0 + h21 * x3, x0,
    y1 - y0 + h20 * y1, y3 - y0 + h21 * y3, y0,
    h20, h21, 1,
  ];
}

export function applyHomography(st: HomographyState, u: number, v: number): Corner {
  return applyH(homographyMatrix(st.corners), u, v);
}

const DEG = Math.PI / 180;

/**
 * Forward cylinder model: content (u,v) → wall point → projector raster
 * (region-local fractions, y down). `aspect` = region raster width/height.
 */
export function cylinderProject(st: CylinderState, aspect: number, u: number, v: number): Corner {
  const R = st.radius;
  const theta = ((u - 0.5) * st.arc) / R;
  const wx = R * Math.sin(theta);
  const wy = st.height * (1 - v);
  const wz = R * Math.cos(theta);
  // world → camera: R_cw = (Ry·Rx·Rz)^T applied to (W - P)
  const dx = wx - st.pos[0];
  const dy = wy - st.pos[1];
  const dz = wz - st.pos[2];
  const cy = Math.cos(st.yaw * DEG);
  const sy = Math.sin(st.yaw * DEG);
  const cp = Math.cos(st.pitch * DEG);
  const sp = Math.sin(st.pitch * DEG);
  const cr = Math.cos(st.roll * DEG);
  const sr = Math.sin(st.roll * DEG);
  // undo yaw (about Y)
  const ax = cy * dx - sy * dz;
  const ay = dy;
  const az = sy * dx + cy * dz;
  // undo pitch (about X)
  const bx = ax;
  const by = cp * ay - sp * az;
  const bz = sp * ay + cp * az;
  // undo roll (about Z)
  const cxv = cr * bx + sr * by;
  const cyv = -sr * bx + cr * by;
  const czv = Math.max(1e-3, bz); // ponytail: points behind the lens are clamped, not culled
  let xn = cxv / czv;
  let yn = cyv / czv;
  const r2 = xn * xn + yn * yn;
  const f = 1 + st.k1 * r2 + st.k2 * r2 * r2;
  xn *= f;
  yn *= f;
  const T = st.throwRatio;
  return [0.5 + T * xn, 0.5 + st.lensOffset - T * aspect * yn];
}

/**
 * Newton inverse of a smooth 2D map with a finite-difference Jacobian.
 * Returns the best point found (never throws — a bad guess just converges
 * less far); adequate for handle drags, where the guess is last frame's
 * answer.
 */
export function invertMap(
  f: (x: number, y: number) => Corner,
  tx: number,
  ty: number,
  guess: Corner,
): Corner {
  let [x, y] = guess;
  const h = 1e-6;
  for (let it = 0; it < 25; it++) {
    const [fx, fy] = f(x, y);
    const ex = fx - tx;
    const ey = fy - ty;
    if (Math.abs(ex) + Math.abs(ey) < 1e-10) break;
    const [fxx, fyx] = f(x + h, y);
    const [fxy, fyy] = f(x, y + h);
    const a = (fxx - fx) / h;
    const b = (fxy - fx) / h;
    const c = (fyx - fy) / h;
    const d = (fyy - fy) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-14) break;
    x -= (d * ex - b * ey) / det;
    y -= (-c * ex + a * ey) / det;
  }
  return [x, y];
}
