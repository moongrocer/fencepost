/**
 * Shared handle geometry for the edit overlay and pointer hit-testing.
 * All positions are REGION-LOCAL normalized coordinates ((0,0) top-left of
 * the active region's slice); the overlay / interaction layers map them
 * into canvas space through the region's rect.
 *
 * Handle id scheme: 'b:i:j' bezier point, 'ft:i' / 'fb:i' fence top/bottom
 * edge point at post i, 'fp:i' fence post line.
 */
import { ProjectState, RegionState } from '../state/project';
import { composedPoint } from '../warp/compose';

export interface Handle {
  id: string;
  kind: 'bezier' | 'ftop' | 'fbot';
  x: number;
  y: number;
  i: number;
  j: number;
}

export function collectHandles(region: RegionState, overlays: ProjectState['overlays']): Handle[] {
  const out: Handle[] = [];
  if (overlays.bezier) {
    const { cols, rows, points } = region.bezier;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 2;
        out.push({ id: `b:${i}:${j}`, kind: 'bezier', x: points[k], y: points[k + 1], i, j });
      }
    }
  }
  if (overlays.fence) {
    region.fence.posts.forEach((post, i) => {
      const t = composedPoint(region.bezier, region.fence, post.x, 0);
      const b = composedPoint(region.bezier, region.fence, post.x, 1);
      out.push({ id: `ft:${i}`, kind: 'ftop', x: t[0], y: t[1], i, j: 0 });
      out.push({ id: `fb:${i}`, kind: 'fbot', x: b[0], y: b[1], i, j: 1 });
    });
  }
  return out;
}

/** The (warped) vertical line of post i, as a region-local polyline. */
export function postPolyline(region: RegionState, i: number, samples = 24): Array<[number, number]> {
  const x = region.fence.posts[i].x;
  const pts: Array<[number, number]> = [];
  for (let s = 0; s <= samples; s++) {
    pts.push(composedPoint(region.bezier, region.fence, x, s / samples));
  }
  return pts;
}

/** The warped top or bottom fence edge curve across the region's width. */
export function edgePolyline(
  region: RegionState,
  edge: 'top' | 'bottom',
  samples = 64,
): Array<[number, number]> {
  const v = edge === 'top' ? 0 : 1;
  const pts: Array<[number, number]> = [];
  for (let s = 0; s <= samples; s++) {
    pts.push(composedPoint(region.bezier, region.fence, s / samples, v));
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
