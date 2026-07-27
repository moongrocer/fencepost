/**
 * Layer 2 of the warp stack: the "bezier grid" — a clamped bicubic
 * B-spline surface mapping the unit square (post-fence UV) to normalized
 * output coordinates ((0,0) = top-left of the projector raster,
 * (1,1) = bottom-right).
 *
 * Degree is cubic wherever the control count allows (min(3, n-1)), so a
 * 3x3 grid degrades gracefully to biquadratic.
 */
import {
  basisFuns,
  clampedUniformKnots,
  findSpan,
  greville,
  insertKnot,
} from './bspline';

export interface BezierGridState {
  /** control point counts along u (columns/x) and v (rows/y) */
  cols: number;
  rows: number;
  degreeU: number;
  degreeV: number;
  knotsU: number[];
  knotsV: number[];
  /** row-major flattened pairs: points[(j*cols+i)*2 + 0|1] = x|y */
  points: number[];
}

export function createBezierGrid(cols: number, rows: number): BezierGridState {
  const degreeU = Math.min(3, cols - 1);
  const degreeV = Math.min(3, rows - 1);
  const knotsU = clampedUniformKnots(cols, degreeU);
  const knotsV = clampedUniformKnots(rows, degreeV);
  const points = new Array<number>(cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    const gy = greville(knotsV, degreeV, j);
    for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 2;
      points[k] = greville(knotsU, degreeU, i);
      points[k + 1] = gy;
    }
  }
  return { cols, rows, degreeU, degreeV, knotsU, knotsV, points };
}

/** Surface evaluation, u and v must already lie in [0,1]. */
function evalCore(st: BezierGridState, u: number, v: number): [number, number] {
  const { cols, rows, degreeU: p, degreeV: q, knotsU: U, knotsV: V, points } = st;
  const su = findSpan(cols, p, u, U);
  const Nu = basisFuns(su, u, p, U);
  const sv = findSpan(rows, q, v, V);
  const Nv = basisFuns(sv, v, q, V);
  let x = 0;
  let y = 0;
  for (let a = 0; a <= q; a++) {
    const j = sv - q + a;
    let rx = 0;
    let ry = 0;
    for (let b = 0; b <= p; b++) {
      const k = (j * cols + (su - p + b)) * 2;
      rx += Nu[b] * points[k];
      ry += Nu[b] * points[k + 1];
    }
    x += Nv[a] * rx;
    y += Nv[a] * ry;
  }
  return [x, y];
}

const EPS = 1e-4;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Evaluate the surface. Inputs slightly outside [0,1] (the fence layer can
 * push v beyond the domain) are handled by linear extrapolation along the
 * boundary tangent, so the warp stays continuous instead of flattening.
 */
export function evalBezier(st: BezierGridState, u: number, v: number): [number, number] {
  const uc = clamp01(u);
  const vc = clamp01(v);
  const p = evalCore(st, uc, vc);
  if (uc !== u) {
    const u2 = uc === 0 ? EPS : 1 - EPS;
    const q = evalCore(st, u2, vc);
    const s = (u - uc) / (u2 - uc);
    p[0] += (q[0] - p[0]) * s;
    p[1] += (q[1] - p[1]) * s;
  }
  if (vc !== v) {
    const v2 = vc === 0 ? EPS : 1 - EPS;
    const q = evalCore(st, uc, v2);
    const s = (v - vc) / (v2 - vc);
    p[0] += (q[0] - p[0]) * s;
    p[1] += (q[1] - p[1]) * s;
  }
  return p;
}

/** Greville abscissa (parameter location) of column i / row j. */
export function colParam(st: BezierGridState, i: number): number {
  return greville(st.knotsU, st.degreeU, i);
}
export function rowParam(st: BezierGridState, j: number): number {
  return greville(st.knotsV, st.degreeV, j);
}

function gridToVectors(st: BezierGridState, direction: 'u' | 'v'): Float64Array[] {
  // For u-direction insertion each "curve control point" is an entire grid
  // column (all rows' xy), and vice versa for v.
  const { cols, rows, points } = st;
  if (direction === 'u') {
    const out: Float64Array[] = new Array(cols);
    for (let i = 0; i < cols; i++) {
      const vec = new Float64Array(rows * 2);
      for (let j = 0; j < rows; j++) {
        vec[j * 2] = points[(j * cols + i) * 2];
        vec[j * 2 + 1] = points[(j * cols + i) * 2 + 1];
      }
      out[i] = vec;
    }
    return out;
  }
  const out: Float64Array[] = new Array(rows);
  for (let j = 0; j < rows; j++) {
    const vec = new Float64Array(cols * 2);
    for (let i = 0; i < cols; i++) {
      vec[i * 2] = points[(j * cols + i) * 2];
      vec[i * 2 + 1] = points[(j * cols + i) * 2 + 1];
    }
    out[j] = vec;
  }
  return out;
}

/**
 * Insert a control column at parameter ubar (exact knot insertion — the
 * surface does not move). Returns a new state.
 */
export function insertColumn(st: BezierGridState, ubar: number): BezierGridState {
  const { knots, ctrl } = insertKnot(st.knotsU, st.degreeU, gridToVectors(st, 'u'), ubar);
  const cols = st.cols + 1;
  const points = new Array<number>(cols * st.rows * 2);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < st.rows; j++) {
      points[(j * cols + i) * 2] = ctrl[i][j * 2];
      points[(j * cols + i) * 2 + 1] = ctrl[i][j * 2 + 1];
    }
  }
  return { ...st, cols, knotsU: knots, points };
}

/** Insert a control row at parameter vbar (exact, shape-preserving). */
export function insertRow(st: BezierGridState, vbar: number): BezierGridState {
  const { knots, ctrl } = insertKnot(st.knotsV, st.degreeV, gridToVectors(st, 'v'), vbar);
  const rows = st.rows + 1;
  const points = new Array<number>(st.cols * rows * 2);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < st.cols; i++) {
      points[(j * st.cols + i) * 2] = ctrl[j][i * 2];
      points[(j * st.cols + i) * 2 + 1] = ctrl[j][i * 2 + 1];
    }
  }
  return { ...st, rows, knotsV: knots, points };
}

/**
 * Subdivide the band to the right of column i: insert a knot halfway
 * between column i's and column i+1's Greville abscissae. Returns null when
 * i is the last column.
 */
export function subdivideAfterColumn(st: BezierGridState, i: number): BezierGridState | null {
  if (i < 0 || i >= st.cols - 1) return null;
  return insertColumn(st, (colParam(st, i) + colParam(st, i + 1)) / 2);
}

export function subdivideAfterRow(st: BezierGridState, j: number): BezierGridState | null {
  if (j < 0 || j >= st.rows - 1) return null;
  return insertRow(st, (rowParam(st, j) + rowParam(st, j + 1)) / 2);
}
