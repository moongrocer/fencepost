/**
 * Layer 1 of the warp stack: FENCE mode.
 *
 * The image is sliced into vertical strips ("boards") by vertical division
 * lines ("posts"). Every post carries a top-edge point and a bottom-edge
 * point that move vertically; between posts the two edges are interpolated
 * with a Catmull-Rom-style cubic Hermite (C1), unless a post is flagged
 * "corner", which splits the tangent and makes the edge C0 there. The board
 * interior is a ruled fill between the curved top and bottom edges.
 *
 * The fence transform maps unit-square UV to unit-square UV:
 *   (u, v)  ->  (u, top(u) + (bottom(u) - top(u)) * v)
 * Horizontal coordinates pass through unchanged; dragging a post sideways
 * repositions where its edge points act, i.e. sets the strip widths.
 *
 * Coordinates: y = 0 is the top of the image, y = 1 the bottom (matching
 * the bezier layer / raster convention).
 */

export interface FencePost {
  /** horizontal position in [0,1]; first post pinned to 0, last to 1 */
  x: number;
  /** y of the top edge point at this post (default 0) */
  top: number;
  /** y of the bottom edge point at this post (default 1) */
  bottom: number;
  /** corner posts are C0 (split tangents); smooth posts are C1 */
  corner: boolean;
}

export interface FenceState {
  /** sorted ascending by x; always >= 2 entries (the image boundaries) */
  posts: FencePost[];
}

export function createFence(): FenceState {
  return {
    posts: [
      { x: 0, top: 0, bottom: 1, corner: false },
      { x: 1, top: 0, bottom: 1, corner: false },
    ],
  };
}

type EdgeKey = 'top' | 'bottom';

/** Catmull-Rom-style central-difference slope at post i (one-sided at ends). */
function centralSlope(posts: FencePost[], key: EdgeKey, i: number): number {
  const n = posts.length;
  const a = Math.max(0, i - 1);
  const b = Math.min(n - 1, i + 1);
  const dx = posts[b].x - posts[a].x;
  return dx > 0 ? (posts[b][key] - posts[a][key]) / dx : 0;
}

function segmentSlope(posts: FencePost[], key: EdgeKey, i: number): number {
  const dx = posts[i + 1].x - posts[i].x;
  return dx > 0 ? (posts[i + 1][key] - posts[i][key]) / dx : 0;
}

/** Evaluate one fence edge curve at horizontal position x (clamped). */
export function evalEdge(state: FenceState, key: EdgeKey, x: number): number {
  const posts = state.posts;
  const n = posts.length;
  if (x <= posts[0].x) return posts[0][key];
  if (x >= posts[n - 1].x) return posts[n - 1][key];
  let i = 0;
  while (i < n - 2 && x > posts[i + 1].x) i++;
  const p0 = posts[i];
  const p1 = posts[i + 1];
  const h = p1.x - p0.x;
  if (h <= 0) return p0[key];
  const t = (x - p0.x) / h;
  // Corner posts use the one-sided (segment) slope on this side, breaking C1.
  const m0 = p0.corner ? segmentSlope(posts, key, i) : centralSlope(posts, key, i);
  const m1 = p1.corner ? segmentSlope(posts, key, i) : centralSlope(posts, key, i + 1);
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0[key] + h10 * h * m0 + h01 * p1[key] + h11 * h * m1;
}

/** The fence transform: unit-square UV in, unit-square-ish UV out. */
export function fenceTransform(state: FenceState, u: number, v: number): [number, number] {
  if (state.posts.length === 2) {
    const a = state.posts[0];
    const b = state.posts[1];
    // Fast path covers the identity default exactly.
    if (a.top === 0 && a.bottom === 1 && b.top === 0 && b.bottom === 1) return [u, v];
  }
  const top = evalEdge(state, 'top', u);
  const bottom = evalEdge(state, 'bottom', u);
  return [u, top + (bottom - top) * v];
}

/**
 * Insert a post at x, sampling top/bottom from the current curves so the
 * fence geometry is (visually) preserved at the insertion point.
 */
export function addPost(state: FenceState, x: number): FenceState {
  const posts = state.posts.slice();
  const clamped = Math.min(0.999, Math.max(0.001, x));
  const post: FencePost = {
    x: clamped,
    top: evalEdge(state, 'top', clamped),
    bottom: evalEdge(state, 'bottom', clamped),
    corner: false,
  };
  let i = 0;
  while (i < posts.length && posts[i].x < clamped) i++;
  posts.splice(i, 0, post);
  return { posts };
}

/** x of the midpoint of the widest gap — a sensible default insert spot. */
export function widestGapMid(state: FenceState): number {
  const posts = state.posts;
  let best = 0;
  let bestW = -1;
  for (let i = 0; i < posts.length - 1; i++) {
    const w = posts[i + 1].x - posts[i].x;
    if (w > bestW) {
      bestW = w;
      best = (posts[i].x + posts[i + 1].x) / 2;
    }
  }
  return best;
}

/** Remove post i. Boundary posts (first/last) cannot be removed. */
export function removePost(state: FenceState, i: number): FenceState {
  if (i <= 0 || i >= state.posts.length - 1) return state;
  const posts = state.posts.slice();
  posts.splice(i, 1);
  return { posts };
}

/** Move post i horizontally, clamped between its neighbors. */
export function setPostX(state: FenceState, i: number, x: number): FenceState {
  if (i <= 0 || i >= state.posts.length - 1) return state; // boundaries pinned
  const posts = state.posts.map((p) => ({ ...p }));
  const lo = posts[i - 1].x + 0.005;
  const hi = posts[i + 1].x - 0.005;
  posts[i].x = Math.min(hi, Math.max(lo, x));
  return { posts };
}
