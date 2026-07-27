/**
 * Edge-blend falloff math, shared between the live GLSL render (which
 * mirrors this formula) and the baked alpha/beta map export. Keeping the
 * canonical implementation in TS means what you see projected is what the
 * MPCDI consumer will reproduce.
 */
import { ProjectState } from '../state/project';

/** Falloff for one edge: d = distance from edge in px, w = zone width. */
export function edgeFalloff(d: number, w: number, gamma: number): number {
  if (w <= 0) return 1;
  const t = Math.min(1, Math.max(0, d / w));
  return Math.pow(t, gamma);
}

/** Combined blend alpha at output pixel center (x, y), origin top-left. */
export function blendAlphaAt(p: ProjectState, x: number, y: number): number {
  const { left, right, top, bottom } = p.blend;
  let a = 1;
  a *= edgeFalloff(x + 0.5, left.width, left.gamma);
  a *= edgeFalloff(p.outputW - x - 0.5, right.width, right.gamma);
  a *= edgeFalloff(y + 0.5, top.width, top.gamma);
  a *= edgeFalloff(p.outputH - y - 0.5, bottom.width, bottom.gamma);
  return a;
}

/** Bake the full-resolution alpha map (rows top-to-bottom, for PNG). */
export function bakeAlphaMap(p: ProjectState): Uint8Array {
  const out = new Uint8Array(p.outputW * p.outputH);
  for (let y = 0; y < p.outputH; y++) {
    for (let x = 0; x < p.outputW; x++) {
      out[y * p.outputW + x] = Math.round(blendAlphaAt(p, x, y) * 255);
    }
  }
  return out;
}

/** Beta (black-level) map: uniform lift. */
export function bakeBetaMap(p: ProjectState): Uint8Array {
  const v = Math.round(Math.min(1, Math.max(0, p.blackLevel)) * 255);
  return new Uint8Array(p.outputW * p.outputH).fill(v);
}

export function hasBlend(p: ProjectState): boolean {
  const b = p.blend;
  return b.left.width > 0 || b.right.width > 0 || b.top.width > 0 || b.bottom.width > 0;
}
