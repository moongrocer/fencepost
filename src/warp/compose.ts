/**
 * Warp composition and mesh sampling.
 *
 * Pipeline per region: region-local UV -> fence transform -> bezier
 * transform -> region-local warped position -> (optionally) placed into
 * the region's slice of the mosaic framebuffer.
 *
 * Mesh vertex data:
 *   - positions: warped coordinates. With placeInCanvas=true they are
 *     mosaic-canvas fractions (for the live display, all regions drawn
 *     into one canvas); with false they stay region-local [0,1] (for the
 *     per-region UV-export FBO at the region's own resolution).
 *   - uvs: the ORIGINAL region-local UVs. The shader derives the shared
 *     content-space UV via the region's src window (uSrc uniform), and the
 *     blend alpha from the same local UV — which is what makes blend
 *     ramps follow the warp.
 */
import { BezierGridState, evalBezier } from './bezier';
import { FenceState, fenceTransform } from './fence';
import { RegionState } from '../state/project';

export interface WarpMesh {
  positions: Float32Array;
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

export function buildRegionMesh(region: RegionState, tess: number, placeInCanvas: boolean): WarpMesh {
  const n = tess + 1;
  const positions = new Float32Array(n * n * 2);
  const uvs = new Float32Array(n * n * 2);
  const { rect } = region;
  for (let r = 0; r < n; r++) {
    const v = r / tess;
    for (let c = 0; c < n; c++) {
      const u = c / tess;
      const p = composedPoint(region.bezier, region.fence, u, v);
      const k = (r * n + c) * 2;
      if (placeInCanvas) {
        positions[k] = rect.x + p[0] * rect.w;
        positions[k + 1] = rect.y + p[1] * rect.h;
      } else {
        positions[k] = p[0];
        positions[k + 1] = p[1];
      }
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
