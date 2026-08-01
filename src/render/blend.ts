/**
 * Edge-blend falloff math, shared between the live GLSL render (which
 * mirrors this formula) and the baked alpha/beta map export.
 *
 * Blend is defined in CONTENT space: each ramp is measured in content
 * pixels inward from the region's content-window edge, and alpha is a
 * function of the region-local UV. Because that UV is interpolated across
 * the warped mesh, the ramp follows the warp — a keystoned or curved seam
 * gets a matching keystoned/curved blend on the projector raster. Two
 * neighboring regions whose content windows overlap by W px, each running
 * a W px ramp from the shared boundary, fade against each other at the
 * same content coordinates regardless of how differently they are warped.
 */
import { ProjectState, RegionState } from '../state/project';

/** Falloff for one edge: d = distance from edge in content px, w = zone width. */
export function edgeFalloff(d: number, w: number, gamma: number): number {
  if (w <= 0) return 1;
  const t = Math.min(1, Math.max(0, d / w));
  return Math.pow(t, gamma);
}

/**
 * Combined blend alpha at region-local (u, v) in [0,1]^2.
 * outputW/outputH are the mosaic framebuffer dims (content-space scale).
 */
export function regionAlpha(
  region: RegionState,
  outputW: number,
  outputH: number,
  u: number,
  v: number,
): number {
  const sw = region.src.w * outputW; // content px covered horizontally
  const sh = region.src.h * outputH;
  const b = region.blend;
  let a = 1;
  a *= edgeFalloff(u * sw, b.left.width, b.left.gamma);
  a *= edgeFalloff((1 - u) * sw, b.right.width, b.right.gamma);
  a *= edgeFalloff(v * sh, b.top.width, b.top.gamma);
  a *= edgeFalloff((1 - v) * sh, b.bottom.width, b.bottom.gamma);
  return a;
}

/**
 * Bake a region's alpha map at its output resolution (rows top-to-bottom,
 * for PNG) from the region's per-pixel content-UV map (as produced by
 * GLRenderer.renderUVMap: rgb triples, rows bottom-up, v flipped to
 * bottom-left origin, unmapped pixels < 0).
 */
export function bakeAlphaMap(
  region: RegionState,
  p: ProjectState,
  contentUV: Float32Array,
  wPx: number,
  hPx: number,
): Uint8Array {
  const out = new Uint8Array(wPx * hPx);
  for (let yTop = 0; yTop < hPx; yTop++) {
    const rowBot = hPx - 1 - yTop;
    for (let x = 0; x < wPx; x++) {
      const k = (rowBot * wPx + x) * 3;
      const cu = contentUV[k];
      const cvFlipped = contentUV[k + 1];
      if (cu < 0 || cvFlipped < 0) continue; // unmapped -> 0
      const cv = 1 - cvFlipped; // back to top-left-origin content v
      const u = (cu - region.src.x) / region.src.w;
      const v = (cv - region.src.y) / region.src.h;
      out[yTop * wPx + x] = Math.round(regionAlpha(region, p.outputW, p.outputH, u, v) * 255);
    }
  }
  return out;
}

/** Beta (black-level) map: uniform lift. */
export function bakeBetaMap(region: RegionState, wPx: number, hPx: number): Uint8Array {
  const v = Math.round(Math.min(1, Math.max(0, region.blackLevel)) * 255);
  return new Uint8Array(wPx * hPx).fill(v);
}

export function hasBlend(region: RegionState): boolean {
  const b = region.blend;
  return b.left.width > 0 || b.right.width > 0 || b.top.width > 0 || b.bottom.width > 0;
}
