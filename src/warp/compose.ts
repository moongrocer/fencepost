/**
 * Warp composition and mesh sampling.
 *
 * Pipeline: source UV -> fence transform -> bezier transform -> screen.
 * The composed warp is sampled into a regular tessellated mesh whose vertex
 * positions are warped output coordinates and whose texcoords are the
 * original source UVs. The same mesh drives both on-screen rendering and
 * the GPU rasterization that produces the per-pixel UV map for PFM export.
 */
import { BezierGridState, evalBezier } from './bezier';
import { FenceState, fenceTransform } from './fence';

export interface WarpMesh {
  /** (tess+1)^2 vertices, xy pairs in normalized output coords */
  positions: Float32Array;
  /** matching source UVs */
  uvs: Float32Array;
  indices: Uint32Array;
  tess: number;
}

export function composedPoint(
  bezier: BezierGridState,
  fence: FenceState,
  u: number,
  v: number,
): [number, number] {
  const f = fenceTransform(fence, u, v);
  return evalBezier(bezier, f[0], f[1]);
}

export function buildWarpMesh(
  bezier: BezierGridState,
  fence: FenceState,
  tess: number,
): WarpMesh {
  const n = tess + 1;
  const positions = new Float32Array(n * n * 2);
  const uvs = new Float32Array(n * n * 2);
  for (let r = 0; r < n; r++) {
    const v = r / tess;
    for (let c = 0; c < n; c++) {
      const u = c / tess;
      const p = composedPoint(bezier, fence, u, v);
      const k = (r * n + c) * 2;
      positions[k] = p[0];
      positions[k + 1] = p[1];
      uvs[k] = u;
      uvs[k + 1] = v;
    }
  }
  const indices = new Uint32Array(tess * tess * 6);
  let w = 0;
  for (let r = 0; r < tess; r++) {
    for (let c = 0; c < tess; c++) {
      const i0 = r * n + c;
      const i1 = i0 + 1;
      const i2 = i0 + n;
      const i3 = i2 + 1;
      indices[w++] = i0;
      indices[w++] = i2;
      indices[w++] = i1;
      indices[w++] = i1;
      indices[w++] = i2;
      indices[w++] = i3;
    }
  }
  return { positions, uvs, indices, tess };
}
