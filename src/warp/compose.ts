/**
 * Warp composition and mesh sampling.
 *
 * Pipeline per region (all region-local, (0,0) top-left, y down):
 *
 *   uv → [homography] → [cylinder] → M(uv)          (parametric, model.ts)
 *   uv → fence → bezier → uv + D(uv)                (hand-placed residual)
 *   position = M(uv) + D(uv)
 *
 * The residual is a DISPLACEMENT from identity, not a re-parametrisation
 * of M's output: that keeps the bezier lattice defined over the unit
 * square whatever the model does, keeps a fresh grid (D ≡ 0) an exact
 * pass-through of the model, and means dragging a control point by δ
 * moves the picture by δ regardless of the model. With both model layers
 * off, position = bezier(fence(uv)) — the pre-model pipeline, so existing
 * projects render bit-for-bit as before.
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
 *
 * The homography is applied per vertex and linearly interpolated inside
 * each mesh triangle rather than via a perspective-correct w attribute:
 * with layers stacked (model + spline residual) no single per-vertex w is
 * exact anyway, and at FULL_TESS the per-cell deviation of a rational map
 * from linear is well under a pixel on a 4K raster.
 */
import { evalBezier } from './bezier';
import { fenceTransform } from './fence';
import { applyHomography, Corner, cylinderProject } from './model';
import { RegionState } from '../state/project';

export interface WarpMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  tess: number;
}

/** raster width/height of a region — the cylinder model needs it */
export function regionAspect(p: { outputW: number; outputH: number }, r: RegionState): number {
  return (r.rect.w * p.outputW) / (r.rect.h * p.outputH);
}

/** parametric layers only */
export function modelPoint(region: RegionState, aspect: number, u: number, v: number): Corner {
  let x = u;
  let y = v;
  if (region.homography.enabled) [x, y] = applyHomography(region.homography, x, y);
  if (region.cylinder.enabled) [x, y] = cylinderProject(region.cylinder, aspect, x, y);
  return [x, y];
}

/** hand-placed layers as a displacement from identity */
export function residualOffset(region: RegionState, u: number, v: number): Corner {
  if (!region.residualEnabled) return [0, 0];
  const f = fenceTransform(region.fence, u, v);
  const b = evalBezier(region.bezier, f[0], f[1]);
  return [b[0] - u, b[1] - v];
}

export function composedPoint(region: RegionState, aspect: number, u: number, v: number): Corner {
  const m = modelPoint(region, aspect, u, v);
  const d = residualOffset(region, u, v);
  return [m[0] + d[0], m[1] + d[1]];
}

export function buildRegionMesh(
  region: RegionState,
  aspect: number,
  tess: number,
  placeInCanvas: boolean,
): WarpMesh {
  const n = tess + 1;
  const positions = new Float32Array(n * n * 2);
  const uvs = new Float32Array(n * n * 2);
  const { rect } = region;
  for (let r = 0; r < n; r++) {
    const v = r / tess;
    for (let c = 0; c < n; c++) {
      const u = c / tess;
      const p = composedPoint(region, aspect, u, v);
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
