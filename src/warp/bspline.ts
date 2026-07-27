/**
 * Clamped non-uniform B-spline basis utilities (degree <= 3).
 *
 * The "bezier grid" warp layer is implemented as a clamped cubic B-spline
 * surface. This gives us mathematically exact, shape-preserving local
 * subdivision via Boehm knot insertion — inserting a knot adds a control
 * row/column WITHOUT moving the surface, which is the property the
 * calibration workflow depends on (refine density mid-session without
 * disturbing already-dialed geometry).
 *
 * With control points placed at Greville abscissae the surface reproduces
 * the identity map exactly (B-splines reproduce linear functions), so a
 * fresh grid of any density is a perfect pass-through warp.
 */

/** Clamped, uniform-interior knot vector for n control points, degree p. */
export function clampedUniformKnots(n: number, p: number): number[] {
  const m = n + p + 1;
  const knots = new Array<number>(m);
  const interiorCount = n - p - 1;
  for (let i = 0; i < m; i++) {
    if (i <= p) knots[i] = 0;
    else if (i >= m - p - 1) knots[i] = 1;
    else knots[i] = (i - p) / (interiorCount + 1);
  }
  return knots;
}

/** Knot span index containing u (NURBS book A2.1). n = control point count. */
export function findSpan(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n]) return n - 1;
  if (u <= U[p]) return p;
  let lo = p;
  let hi = n;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Nonzero basis functions N[span-p..span] at u (NURBS book A2.2). */
export function basisFuns(span: number, u: number, p: number, U: number[]): number[] {
  const N = new Array<number>(p + 1).fill(0);
  N[0] = 1;
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Greville abscissa of control point i: mean of p consecutive knots. */
export function greville(U: number[], p: number, i: number): number {
  let s = 0;
  for (let k = 1; k <= p; k++) s += U[i + k];
  return s / p;
}

/**
 * Boehm single knot insertion for a curve whose "points" are vectors of
 * arbitrary dimension (we pass whole grid rows/columns through as flat
 * vectors so one routine serves both surface directions).
 *
 * Returns the new knot vector and new control points; the curve (and thus
 * the surface) is mathematically unchanged.
 */
export function insertKnot(
  U: number[],
  p: number,
  ctrl: Float64Array[],
  ubar: number,
): { knots: number[]; ctrl: Float64Array[] } {
  const n = ctrl.length;
  const k = findSpan(n, p, ubar, U);
  const dim = ctrl[0].length;
  const out: Float64Array[] = new Array(n + 1);
  for (let i = 0; i <= k - p; i++) out[i] = ctrl[i].slice();
  for (let i = k; i < n; i++) out[i + 1] = ctrl[i].slice();
  for (let i = k - p + 1; i <= k; i++) {
    const denom = U[i + p] - U[i];
    const a = denom > 0 ? (ubar - U[i]) / denom : 0;
    const q = new Float64Array(dim);
    const pa = ctrl[i];
    const pb = ctrl[i - 1];
    for (let d = 0; d < dim; d++) q[d] = a * pa[d] + (1 - a) * pb[d];
    out[i] = q;
  }
  const knots = U.slice();
  knots.splice(k + 1, 0, ubar);
  return { knots, ctrl: out };
}
