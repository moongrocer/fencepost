/**
 * Shared handle geometry for the edit overlay and pointer hit-testing.
 * All positions are REGION-LOCAL normalized coordinates ((0,0) top-left of
 * the active region's slice); the overlay / interaction layers map them
 * into canvas space through the region's rect.
 *
 * Handle id scheme: 'b:i:j' bezier point, 'ft:i' / 'fb:i' fence top/bottom
 * edge point at post i, 'fp:i' fence post line, 'h:i' homography corner i.
 *
 * Bezier control points are drawn at model(greville) + (point − greville):
 * the residual displacement placed where the model puts that part of the
 * picture. With the model off that is the raw point, as before.
 */
import { ProjectState, RegionState } from '../state/project';
import { composedPoint, modelPoint } from '../warp/compose';
import { UNIT_CORNERS } from '../warp/model';
import { identityPoint } from '../warp/refit';

export type HandleKind = 'bezier' | 'ftop' | 'fbot' | 'homo';
export type Layer = 'bezier' | 'fence' | 'homo';

export interface Handle {
  id: string;
  kind: HandleKind;
  x: number;
  y: number;
  i: number;
  j: number;
}

export function layerOf(kind: HandleKind): Layer {
  return kind === 'bezier' ? 'bezier' : kind === 'homo' ? 'homo' : 'fence';
}

export function bezierHandlePos(region: RegionState, aspect: number, i: number, j: number): [number, number] {
  const k = (j * region.bezier.cols + i) * 2;
  const g = identityPoint(region.bezier, i, j);
  const m = modelPoint(region, aspect, g[0], g[1]);
  return [m[0] + region.bezier.points[k] - g[0], m[1] + region.bezier.points[k + 1] - g[1]];
}

export function collectHandles(region: RegionState, overlays: ProjectState['overlays'], aspect: number): Handle[] {
  const out: Handle[] = [];
  if (overlays.bezier && region.residualEnabled) {
    const { cols, rows } = region.bezier;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const [x, y] = bezierHandlePos(region, aspect, i, j);
        out.push({ id: `b:${i}:${j}`, kind: 'bezier', x, y, i, j });
      }
    }
  }
  if (overlays.fence && region.residualEnabled) {
    region.fence.posts.forEach((post, i) => {
      const t = composedPoint(region, aspect, post.x, 0);
      const b = composedPoint(region, aspect, post.x, 1);
      out.push({ id: `ft:${i}`, kind: 'ftop', x: t[0], y: t[1], i, j: 0 });
      out.push({ id: `fb:${i}`, kind: 'fbot', x: b[0], y: b[1], i, j: 1 });
    });
  }
  if (region.homography.enabled) {
    UNIT_CORNERS.forEach((c, i) => {
      const p = composedPoint(region, aspect, c[0], c[1]);
      out.push({ id: `h:${i}`, kind: 'homo', x: p[0], y: p[1], i, j: 0 });
    });
  }
  return out;
}

/** The (warped) vertical line of post i, as a region-local polyline. */
export function postPolyline(region: RegionState, aspect: number, i: number, samples = 24): Array<[number, number]> {
  const x = region.fence.posts[i].x;
  const pts: Array<[number, number]> = [];
  for (let s = 0; s <= samples; s++) {
    pts.push(composedPoint(region, aspect, x, s / samples));
  }
  return pts;
}

/** The warped top or bottom fence edge curve across the region's width. */
export function edgePolyline(
  region: RegionState,
  aspect: number,
  edge: 'top' | 'bottom',
  samples = 64,
): Array<[number, number]> {
  const v = edge === 'top' ? 0 : 1;
  const pts: Array<[number, number]> = [];
  for (let s = 0; s <= samples; s++) {
    pts.push(composedPoint(region, aspect, s / samples, v));
  }
  return pts;
}

export function distToPolyline(px: number, py: number, pts: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    best = Math.min(best, Math.hypot(px - qx, py - qy));
  }
  return best;
}
