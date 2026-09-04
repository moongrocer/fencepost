/**
 * Camera-assisted calibration math: gray codes, lens (un)distortion,
 * homography fitting, and solving a region's B-spline control net so the
 * projected content lands on a chosen target rectangle in camera space.
 *
 * Pure math — no DOM, no capture. The remote bridge (remote.ts) feeds it
 * decoded camera→raster correspondence maps; the future CAMERA tab will
 * use the same entry points.
 */
import { basisFuns, findSpan, greville } from './bspline';
import { BezierGridState } from './bezier';

// ----------------------------- gray codes -----------------------------

/** bit `bit` of the gray code of v. */
export function grayBit(v: number, bit: number): 0 | 1 {
  const g = v ^ (v >> 1);
  return ((g >> bit) & 1) as 0 | 1;
}

/** Decode accumulated gray bits (MSB first array) to a binary integer. */
export function grayDecode(bits: number[]): number {
  let b = 0;
  let out = 0;
  for (const g of bits) {
    b ^= g;
    out = (out << 1) | b;
  }
  return out;
}

// ----------------------------- lens model -----------------------------

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}

/** Scale intrinsics from the calibration resolution to the capture resolution. */
export function scaleIntrinsics(k: Intrinsics, sx: number, sy: number): Intrinsics {
  return { ...k, fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy };
}

/** Ideal (undistorted) pixel -> observed (distorted) pixel. */
export function distortPoint(k: Intrinsics, u: number, v: number): [number, number] {
  const x = (u - k.cx) / k.fx;
  const y = (v - k.cy) / k.fy;
  const r2 = x * x + y * y;
  const rad = 1 + k.k1 * r2 + k.k2 * r2 * r2;
  const xd = x * rad + 2 * k.p1 * x * y + k.p2 * (r2 + 2 * x * x);
  const yd = y * rad + k.p1 * (r2 + 2 * y * y) + 2 * k.p2 * x * y;
  return [xd * k.fx + k.cx, yd * k.fy + k.cy];
}

/** Observed (distorted) pixel -> ideal pixel, by fixed-point iteration. */
export function undistortPoint(k: Intrinsics, u: number, v: number): [number, number] {
  const xd = (u - k.cx) / k.fx;
  const yd = (v - k.cy) / k.fy;
  let x = xd;
  let y = yd;
  for (let i = 0; i < 25; i++) {
    const r2 = x * x + y * y;
    const rad = 1 + k.k1 * r2 + k.k2 * r2 * r2;
    const dx = 2 * k.p1 * x * y + k.p2 * (r2 + 2 * x * x);
    const dy = k.p1 * (r2 + 2 * y * y) + 2 * k.p2 * x * y;
    x = (xd - dx) / rad;
    y = (yd - dy) / rad;
  }
  return [x * k.fx + k.cx, y * k.fy + k.cy];
}

// ----------------------------- homography -----------------------------

export type H3 = number[]; // row-major 3x3, h[8] normalized to 1

/** Solve A x = b (dense, small) by Gaussian elimination with pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('singular system');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/**
 * Least-squares homography src->dst (inhomogeneous DLT with Hartley
 * normalization). Needs >= 4 well-spread points; happily takes thousands.
 */
export function fitHomography(src: Array<[number, number]>, dst: Array<[number, number]>): H3 {
  if (src.length < 4 || src.length !== dst.length) throw new Error('need >= 4 point pairs');
  const norm = (pts: Array<[number, number]>) => {
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p[0];
      my += p[1];
    }
    mx /= pts.length;
    my /= pts.length;
    let md = 0;
    for (const p of pts) md += Math.hypot(p[0] - mx, p[1] - my);
    md /= pts.length;
    const s = md > 0 ? Math.SQRT2 / md : 1;
    return { s, mx, my, apply: (p: [number, number]): [number, number] => [(p[0] - mx) * s, (p[1] - my) * s] };
  };
  const ns = norm(src);
  const nd = norm(dst);
  // normal equations for the 8 unknowns
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
      Atb[i] += row[i] * rhs;
    }
  };
  for (let i = 0; i < src.length; i++) {
    const [x, y] = ns.apply(src[i]);
    const [u, v] = nd.apply(dst[i]);
    addRow([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    addRow([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  const h = solveLinear(AtA, Atb);
  const Hn: H3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // denormalize: H = Td^-1 * Hn * Ts
  const Ts = [ns.s, 0, -ns.s * ns.mx, 0, ns.s, -ns.s * ns.my, 0, 0, 1];
  const TdInv = [1 / nd.s, 0, nd.mx, 0, 1 / nd.s, nd.my, 0, 0, 1];
  return mulH(mulH(TdInv, Hn), Ts);
}

export function mulH(a: H3, b: H3): H3 {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  const s = o[8] !== 0 ? 1 / o[8] : 1;
  return o.map((v) => v * s);
}

export function applyH(h: H3, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function invertH(h: H3): H3 {
  const [a, b, c, d, e, f, g, hh, i] = h;
  const A = e * i - f * hh;
  const B = c * hh - b * i;
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (Math.abs(det) < 1e-14) throw new Error('singular homography');
  const o = [
    A, B, C,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * hh - e * g, b * g - a * hh, a * e - b * d,
  ].map((v) => v / det);
  const s = o[8] !== 0 ? 1 / o[8] : 1;
  return o.map((v) => v * s);
}

// ------------------- B-spline surface interpolation -------------------

/**
 * Solve for control points so the surface INTERPOLATES `targets` at the
 * Greville abscissae (tensor-product collocation; Schoenberg–Whitney
 * guarantees the systems are nonsingular). targets: row-major [rows][cols]
 * of [x, y]. Returns a flat points array matching BezierGridState.points.
 */
export function fitControlNet(
  grid: Pick<BezierGridState, 'cols' | 'rows' | 'degreeU' | 'degreeV' | 'knotsU' | 'knotsV'>,
  targets: Array<Array<[number, number]>>,
): number[] {
  const { cols, rows, degreeU, degreeV, knotsU, knotsV } = grid;
  const collocation = (n: number, p: number, U: number[]): number[][] => {
    const M: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
      const t = greville(U, p, i);
      const span = findSpan(n, p, t, U);
      const N = basisFuns(span, t, p, U);
      for (let a = 0; a <= p; a++) M[i][span - p + a] = N[a];
    }
    return M;
  };
  const solveMany = (M: number[][], rhs: number[][]): number[][] =>
    rhs.map((b) => solveLinear(M.map((r) => [...r]), b));

  const Mu = collocation(cols, degreeU, knotsU);
  const Mv = collocation(rows, degreeV, knotsV);

  // First pass: for each row of targets solve along u.
  const interX: number[][] = [];
  const interY: number[][] = [];
  for (let j = 0; j < rows; j++) {
    const [sx, sy] = solveMany(Mu, [targets[j].map((p) => p[0]), targets[j].map((p) => p[1])]);
    interX.push(sx);
    interY.push(sy);
  }
  // Second pass: for each column solve along v.
  const points = new Array<number>(cols * rows * 2);
  for (let i = 0; i < cols; i++) {
    const [px, py] = solveMany(Mv, [interX.map((r) => r[i]), interY.map((r) => r[i])]);
    for (let j = 0; j < rows; j++) {
      points[(j * cols + i) * 2] = px[j];
      points[(j * cols + i) * 2 + 1] = py[j];
    }
  }
  return points;
}

// ----------------------------- region solve ----------------------------

export interface CorrMap {
  /** camera capture dimensions */
  w: number;
  h: number;
  /** region-local raster coords per camera pixel (NaN where invalid) */
  rasterX: Float32Array;
  rasterY: Float32Array;
}

export interface RegionSolveInput {
  map: CorrMap;
  intr: Intrinsics;
  /** target rect in UNDISTORTED camera px: content 0..1 maps onto it */
  target: { x: number; y: number; w: number; h: number };
  /** region src window (content fractions) */
  src: { x: number; y: number; w: number; h: number };
  /** region raster size in projector px */
  regionW: number;
  regionH: number;
  grid: Pick<BezierGridState, 'cols' | 'rows' | 'degreeU' | 'degreeV' | 'knotsU' | 'knotsV'>;
}

export interface RegionSolveResult {
  points: number[];
  /** residual of the fit over inliers, in projector px */
  rmsPx: number;
  samples: number;
  inliers: number;
  outliers: number;
  /** per-control-point data weight (basis-mass diagonal) — low = smoothness-carried */
  coverage: number[];
  /** count of control points whose neighbourhood was essentially unmeasured */
  lowCoverage: number;
}

/**
 * Compute a region's control net so that content lands on `target` —
 * GLOBAL robust least squares over every valid correspondence.
 *
 * Each measured pair (raster r seen at camera x) becomes one linear
 * constraint on the control net: x maps through the target rect to a
 * content parameter uv, and the surface at uv must equal r. The B-spline
 * basis makes that linear in the control points, so the whole net is one
 * normal-equations solve — tens of thousands of rows, cols*rows unknowns.
 *
 * This replaced a per-control-point local lookup that overfit noisy or
 * occluded patches (measured on the rig: a physical occlusion produced a
 * tent-shaped spike and a 48% scale step across the seam at 7×7). Here:
 *  - every control point is informed by ALL data under its basis support,
 *    so dense measurements average instead of being sampled at one spot;
 *  - trimmed refits (robust MAD threshold) reject decode garbage from
 *    occlusions/speculars instead of fitting it;
 *  - a bending-energy prior keeps the net finite and smooth where the
 *    camera saw nothing (outside the footprint, masked areas), replacing
 *    the old homography-extrapolation fallback.
 */
export function solveRegion(inp: RegionSolveInput): RegionSolveResult {
  const { map, intr, target, src, regionW, regionH, grid } = inp;
  const { cols, rows, degreeU: p, degreeV: q, knotsU: U, knotsV: V } = grid;
  const n = cols * rows;

  // ---- gather constraints: (uv, raster_norm) ----
  // Subsample the camera grid to keep the accumulation ~50k rows.
  const valid = (() => {
    let c = 0;
    for (let i = 0; i < map.rasterX.length; i++) if (!Number.isNaN(map.rasterX[i])) c++;
    return c;
  })();
  if (valid < 100) throw new Error(`too few correspondences (${valid})`);
  const step = Math.max(1, Math.round(Math.sqrt(valid / 50000)));

  const us: number[] = [];
  const vs: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  for (let y = 0; y < map.h; y += step) {
    for (let x = 0; x < map.w; x += step) {
      const k = y * map.w + x;
      const rx = map.rasterX[k];
      if (Number.isNaN(rx)) continue;
      const [cu, cv] = undistortPoint(intr, x, y);
      // camera -> content -> region-local surface parameter
      const cxn = (cu - target.x) / target.w;
      const cyn = (cv - target.y) / target.h;
      const u = (cxn - src.x) / src.w;
      const v = (cyn - src.y) / src.h;
      if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) continue;
      us.push(Math.min(1, Math.max(0, u)));
      vs.push(Math.min(1, Math.max(0, v)));
      bx.push(rx / regionW);
      by.push(map.rasterY[k] / regionH);
    }
  }
  const samples = us.length;
  if (samples < 100) throw new Error(`too few in-domain correspondences (${samples})`);

  // ---- basis row per sample (sparse: (p+1)*(q+1) nonzeros) ----
  const nnz = (p + 1) * (q + 1);
  const colIdx = new Int32Array(samples * nnz);
  const colVal = new Float64Array(samples * nnz);
  for (let s = 0; s < samples; s++) {
    const su = findSpan(cols, p, us[s], U);
    const Nu = basisFuns(su, us[s], p, U);
    const sv = findSpan(rows, q, vs[s], V);
    const Nv = basisFuns(sv, vs[s], q, V);
    let w = 0;
    for (let a = 0; a <= q; a++) {
      const j = sv - q + a;
      for (let b = 0; b <= p; b++) {
        colIdx[s * nnz + w] = j * cols + (su - p + b);
        colVal[s * nnz + w] = Nv[a] * Nu[b];
        w++;
      }
    }
  }

  // ---- bending-energy prior: curvature across the net ----
  // Divided-difference second derivative over the GREVILLE abscissae, not
  // plain index-space differences: clamped knots space the abscissae
  // non-uniformly, and an index-space penalty is nonzero for linear
  // functions — it visibly dragged corners outward on clean data. This
  // form is exactly zero for any linear (i.e. identity/affine) net, so it
  // only ever penalizes true curvature. Scaled by mean spacing² to stay
  // comparable across triples. Weighted to be decisive where data is
  // absent but negligible against dense data.
  const gu = Array.from({ length: cols }, (_, i) => greville(U, p, i));
  const gv = Array.from({ length: rows }, (_, j) => greville(V, q, j));
  const curvRow = (t0: number, t1: number, t2: number): [number, number, number] => {
    const D = (t2 - t0) * (t1 - t0) * (t2 - t1);
    const h2 = ((t2 - t0) / 2) ** 2;
    return [(2 * (t2 - t1) * h2) / D, (-2 * (t2 - t0) * h2) / D, (2 * (t1 - t0) * h2) / D];
  };
  // ADAPTIVE weight: the prior's job is to carry control points the camera
  // never saw; on well-measured points it must not fight real wall
  // curvature. Starvation must be judged against the mass a UNIFORM data
  // field would give that same point — corner/edge basis functions have
  // intrinsically small support, and comparing them against the global
  // average misreads every corner as starved (which flattened real
  // curvature exactly where keystone correction is largest).
  const covAll = new Array<number>(n).fill(0);
  for (let s = 0; s < samples; s++)
    for (let a = 0; a < nnz; a++) covAll[colIdx[s * nnz + a]] += colVal[s * nnz + a];
  const expected = new Array<number>(n).fill(0);
  const G = 40;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const uu = (gx + 0.5) / G;
      const vv = (gy + 0.5) / G;
      const su = findSpan(cols, p, uu, U);
      const Nu = basisFuns(su, uu, p, U);
      const sv = findSpan(rows, q, vv, V);
      const Nv = basisFuns(sv, vv, q, V);
      for (let a = 0; a <= q; a++)
        for (let b = 0; b <= p; b++)
          expected[(sv - q + a) * cols + (su - p + b)] += Nv[a] * Nu[b];
    }
  }
  const massScale = samples / (G * G);
  const ratio = covAll.map((c, i) => c / Math.max(1e-9, expected[i] * massScale));
  const covRef = samples / n;
  const rowWeight = (i0: number, i1: number, i2: number): number => {
    const minR = Math.min(ratio[i0], ratio[i1], ratio[i2]);
    return covRef / (1 + 25 * minR); // starved → covRef (decisive), full data → ~4%
  };
  const smoothRows: Array<[number, number, number, number, number, number, number]> = []; // i0,i1,i2,c0,c1,c2,w
  for (let j = 0; j < rows; j++)
    for (let i = 1; i < cols - 1; i++) {
      const [c0, c1, c2] = curvRow(gu[i - 1], gu[i], gu[i + 1]);
      const i0 = j * cols + i - 1;
      const i1 = j * cols + i;
      const i2 = j * cols + i + 1;
      smoothRows.push([i0, i1, i2, c0, c1, c2, rowWeight(i0, i1, i2)]);
    }
  for (let i = 0; i < cols; i++)
    for (let j = 1; j < rows - 1; j++) {
      const [c0, c1, c2] = curvRow(gv[j - 1], gv[j], gv[j + 1]);
      const i0 = (j - 1) * cols + i;
      const i1 = j * cols + i;
      const i2 = (j + 1) * cols + i;
      smoothRows.push([i0, i1, i2, c0, c1, c2, rowWeight(i0, i1, i2)]);
    }

  const use = new Uint8Array(samples).fill(1);
  let pointsX: number[] = [];
  let pointsY: number[] = [];
  let rmsPx = 0;
  let inliers = samples;
  const coverage = new Array<number>(n).fill(0);

  // ---- trimmed refit loop: fit, re-classify inliers, fit again ----
  // Membership is recomputed from scratch every round (not only removed):
  // a heavily contaminated first fit mislabels good points, and they must
  // be able to return once the surface pulls toward the consensus.
  let prevInliers = -1;
  for (let round = 0; round < 6; round++) {
    const AtA: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const Atbx = new Array<number>(n).fill(0);
    const Atby = new Array<number>(n).fill(0);
    coverage.fill(0);
    for (let s = 0; s < samples; s++) {
      if (!use[s]) continue;
      const o = s * nnz;
      for (let a = 0; a < nnz; a++) {
        const ia = colIdx[o + a];
        const va = colVal[o + a];
        coverage[ia] += va;
        Atbx[ia] += va * bx[s];
        Atby[ia] += va * by[s];
        for (let b = 0; b < nnz; b++) AtA[ia][colIdx[o + b]] += va * colVal[o + b];
      }
    }
    for (const [i0, i1, i2, c0, c1, c2, wRow] of smoothRows) {
      const w2 = wRow * wRow;
      // AtA += w2 * c^T c (rhs contribution is 0 — prior pulls toward zero curvature)
      AtA[i0][i0] += w2 * c0 * c0;
      AtA[i1][i1] += w2 * c1 * c1;
      AtA[i2][i2] += w2 * c2 * c2;
      AtA[i0][i1] += w2 * c0 * c1;
      AtA[i1][i0] += w2 * c0 * c1;
      AtA[i1][i2] += w2 * c1 * c2;
      AtA[i2][i1] += w2 * c1 * c2;
      AtA[i0][i2] += w2 * c0 * c2;
      AtA[i2][i0] += w2 * c0 * c2;
    }
    for (let i = 0; i < n; i++) AtA[i][i] += 1e-9; // ridge, numerical safety

    pointsX = solveLinear(
      AtA.map((r) => [...r]),
      Atbx,
    );
    pointsY = solveLinear(AtA, Atby);

    // residuals in projector px
    const resid = new Float64Array(samples);
    for (let s = 0; s < samples; s++) {
      let ex = 0;
      let ey = 0;
      const o = s * nnz;
      for (let a = 0; a < nnz; a++) {
        ex += colVal[o + a] * pointsX[colIdx[o + a]];
        ey += colVal[o + a] * pointsY[colIdx[o + a]];
      }
      resid[s] = Math.hypot((ex - bx[s]) * regionW, (ey - by[s]) * regionH);
    }
    // Robust scale from the CURRENT inlier set, threshold applied to ALL
    // samples — rejected points re-enter when they agree with the fit.
    const active = Array.from(resid).filter((_, s) => use[s] === 1);
    active.sort((a2, b2) => a2 - b2);
    const median = active[active.length >> 1];
    const mad = active.map((r) => Math.abs(r - median)).sort((a2, b2) => a2 - b2)[active.length >> 1];
    const thr = Math.max(1.5, median + 4 * 1.4826 * mad);
    let se = 0;
    inliers = 0;
    for (let s = 0; s < samples; s++) {
      use[s] = resid[s] <= thr ? 1 : 0;
      if (use[s]) {
        se += resid[s] * resid[s];
        inliers++;
      }
    }
    rmsPx = Math.sqrt(se / Math.max(1, inliers));
    if (inliers === prevInliers) break; // membership stable — converged
    prevInliers = inliers;
  }

  const points = new Array<number>(n * 2);
  for (let k = 0; k < n; k++) {
    points[k * 2] = pointsX[k];
    points[k * 2 + 1] = pointsY[k];
  }
  // Flag control points that are essentially data-free relative to what a
  // uniform field would give them (carried by the smoothness prior).
  const lowCoverage = ratio.filter((r) => r < 0.05).length;
  return { points, rmsPx, samples, inliers, outliers: samples - inliers, coverage, lowCoverage };
}
