/**
 * Repairs for hand-kinked / over-fitted bezier lattices, and the explicit
 * migration of a legacy single-lattice warp onto the homography layer.
 *
 * Everything here works on the DISPLACEMENT from the Greville identity
 * grid, not on raw control positions: a clamped knot vector spaces the
 * Greville abscissae non-uniformly near the ends, so smoothing absolute
 * positions would bend a perfectly straight identity grid.
 */
import { basisFuns, clampedUniformKnots, findSpan, greville } from './bspline';
import { BezierGridState, colParam, evalBezier, insertColumn, insertRow, rowParam } from './bezier';
import { applyH, solveLinear } from './calibrate';
import { fenceTransform } from './fence';
import { homographyMatrix } from './model';
import { RegionState } from '../state/project';

type Grid = Pick<BezierGridState, 'cols' | 'rows' | 'degreeU' | 'degreeV' | 'knotsU' | 'knotsV'>;

/**
 * Least-squares control net for a surface on `grid` passing near the
 * samples (parameter (u,v) → value (x,y)). Normal equations; the basis is
 * (p+1)(q+1)-sparse per row so accumulation is cheap, and the dense solve
 * is cols·rows unknowns (400 at the 20×20 UI maximum).
 */
export function fitSurface(grid: Grid, samples: Array<[number, number, number, number]>): number[] {
  const { cols, rows, degreeU: p, degreeV: q, knotsU: U, knotsV: V } = grid;
  const n = cols * rows;
  const AtA: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const Atx = new Array<number>(n).fill(0);
  const Aty = new Array<number>(n).fill(0);
  const idx: number[] = [];
  const val: number[] = [];
  for (const [u0, v0, x, y] of samples) {
    const u = Math.min(1, Math.max(0, u0));
    const v = Math.min(1, Math.max(0, v0));
    const su = findSpan(cols, p, u, U);
    const Nu = basisFuns(su, u, p, U);
    const sv = findSpan(rows, q, v, V);
    const Nv = basisFuns(sv, v, q, V);
    idx.length = 0;
    val.length = 0;
    for (let a = 0; a <= q; a++) {
      for (let b = 0; b <= p; b++) {
        idx.push((sv - q + a) * cols + (su - p + b));
        val.push(Nv[a] * Nu[b]);
      }
    }
    for (let i = 0; i < idx.length; i++) {
      const ii = idx[i];
      Atx[ii] += val[i] * x;
      Aty[ii] += val[i] * y;
      for (let j = 0; j < idx.length; j++) AtA[ii][idx[j]] += val[i] * val[j];
    }
  }
  for (let i = 0; i < n; i++) AtA[i][i] += 1e-12;
  const px = solveLinear(AtA.map((r) => [...r]), Atx);
  const py = solveLinear(AtA, Aty);
  const points = new Array<number>(n * 2);
  for (let k = 0; k < n; k++) {
    points[k * 2] = px[k];
    points[k * 2 + 1] = py[k];
  }
  return points;
}

/** uv grid of the current surface, dense enough to pin a 20×20 net */
function sampleSurface(st: BezierGridState, n = 48): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const [x, y] = evalBezier(st, u, v);
      out.push([u, v, x, y]);
    }
  }
  return out;
}

/**
 * Boundary-preserving Laplacian smoothing of the interior control points'
 * displacement from identity. λ = 0.5 per pass; 2–3 passes takes the
 * kink out of a hand-jittered lattice without flattening real curvature.
 */
export function laplacianSmooth(st: BezierGridState, iterations: number, lambda = 0.5): BezierGridState {
  const { cols, rows } = st;
  if (cols < 3 || rows < 3) return st;
  const gx = Array.from({ length: cols }, (_, i) => colParam(st, i));
  const gy = Array.from({ length: rows }, (_, j) => rowParam(st, j));
  // identity position of the coordinate at flat index k
  const ident = (k: number) => (k % 2 === 0 ? gx[(k >> 1) % cols] : gy[Math.floor((k >> 1) / cols)]);
  let d = st.points.map((v, k) => v - ident(k));
  for (let it = 0; it < iterations; it++) {
    const next = d.slice();
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        for (let c = 0; c < 2; c++) {
          const k = (j * cols + i) * 2 + c;
          const avg =
            (d[((j - 1) * cols + i) * 2 + c] +
              d[((j + 1) * cols + i) * 2 + c] +
              d[(j * cols + i - 1) * 2 + c] +
              d[(j * cols + i + 1) * 2 + c]) /
            4;
          next[k] = d[k] + lambda * (avg - d[k]);
        }
      }
    }
    d = next;
  }
  return { ...st, points: d.map((v, k) => v + ident(k)) };
}

/**
 * Refit as ONE spline patch (no interior knots — a bicubic Bézier patch at
 * cubic degree), then re-insert the current interior knots so the lattice
 * comes back at the same density and knot vectors. Interior kinks cannot
 * survive a single patch; the overall shape the operator dialed in does.
 */
export function refitPatch(st: BezierGridState): BezierGridState {
  const pc = st.degreeU + 1;
  const pr = st.degreeV + 1;
  const patch: Grid = {
    cols: pc,
    rows: pr,
    degreeU: st.degreeU,
    degreeV: st.degreeV,
    knotsU: clampedUniformKnots(pc, st.degreeU),
    knotsV: clampedUniformKnots(pr, st.degreeV),
  };
  let out: BezierGridState = { ...patch, points: fitSurface(patch, sampleSurface(st)) };
  for (let k = st.degreeU + 1; k < st.cols; k++) out = insertColumn(out, st.knotsU[k]);
  for (let k = st.degreeV + 1; k < st.rows; k++) out = insertRow(out, st.knotsV[k]);
  return { ...out, knotsU: st.knotsU.slice(), knotsV: st.knotsV.slice() };
}

/**
 * Explicit migration: fit the homography to where the current residual
 * puts the four image corners, enable layer 1 with it, and refit the
 * bezier so the composed picture stays where it was. The fence is kept
 * (posts remain editable); the bezier absorbs (old − H) over the fence's
 * parameter range. Meaningful only while both model layers are off.
 */
export function upgradeToHomography(region: RegionState): void {
  if (region.homography.enabled || region.cylinder.enabled) return;
  const old = (u: number, v: number) => {
    const f = fenceTransform(region.fence, u, v);
    return evalBezier(region.bezier, f[0], f[1]);
  };
  const corners = [old(0, 0), old(1, 0), old(1, 1), old(0, 1)] as HomographyStateCorners;
  const H = homographyMatrix(corners);
  const samples: Array<[number, number, number, number]> = [];
  const n = 48;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const [wu, wv] = fenceTransform(region.fence, u, v);
      const o = old(u, v);
      const h = applyH(H, u, v);
      // new bezier evaluated at the fence output must equal old − H + uv
      samples.push([wu, wv, o[0] - h[0] + u, o[1] - h[1] + v]);
    }
  }
  region.bezier = { ...region.bezier, points: fitSurface(region.bezier, samples) };
  region.homography = { enabled: true, corners };
  region.residualEnabled = true;
}

type HomographyStateCorners = RegionState['homography']['corners'];

/** Greville identity positions — where a control point sits when the residual is zero. */
export function identityPoint(st: BezierGridState, i: number, j: number): [number, number] {
  return [greville(st.knotsU, st.degreeU, i), greville(st.knotsV, st.degreeV, j)];
}
