/**
 * 2D overlay canvas: control point glyphs, fence posts/edges, selection
 * highlights, rubber-band, and (in mosaic projects) region outlines.
 * Layered above the WebGL canvas; the GL pass draws the tessellated
 * wireframe itself.
 *
 * Only the ACTIVE region's handles are drawn/editable; other regions get
 * a thin outline + id label. Handle positions are region-local and are
 * mapped through the active region's rect here.
 *
 * Glyph language (deliberately distinct per layer):
 *   bezier points  — squares, steel blue; selected = LW pale yellow-green
 *   fence edge pts — diamonds, orange
 *   fence posts    — orange vertical (warped) lines; selected brighter
 */
import { ProjectState } from '../state/project';
import { regionAspect } from '../warp/compose';
import { bezierHandlePos, collectHandles, edgePolyline, Layer, layerOf, postPolyline } from './handles';

export interface OverlayView {
  /** CSS pixel size of the viewport */
  cw: number;
  ch: number;
  dpr: number;
  selection: ReadonlySet<string>;
  hoverId: string | null;
  rubber: { x0: number; y0: number; x1: number; y1: number } | null;
  /** layer the current tab edits: it draws emphasized and on top */
  activeLayer: Layer | null;
}

const BEZ_COLOR = '#6f9fd8';
const BEZ_SEL = '#d8d9a3';
const FENCE_COLOR = '#e8954a';
const FENCE_SEL = '#ffd9a3';
const HOMO_COLOR = '#9fd86f';
const HOMO_SEL = '#e6ffc2';

export function drawOverlay(ctx: CanvasRenderingContext2D, p: ProjectState, view: OverlayView): void {
  const { cw, ch, dpr } = view;
  const region = p.regions[p.activeRegion];
  const rr = region.rect;
  const aspect = regionAspect(p, region);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cw, ch);
  // region-local normalized -> canvas CSS px
  const X = (nx: number) => (rr.x + nx * rr.w) * cw;
  const Y = (ny: number) => (rr.y + ny * rr.h) * ch;
  // Fence lines run along the region border; inset a pixel so the stroke
  // isn't clipped by the region/canvas edge.
  const CX = (nx: number) => Math.min((rr.x + rr.w) * cw - 1, Math.max(rr.x * cw + 1, X(nx)));
  const CY = (ny: number) => Math.min((rr.y + rr.h) * ch - 1, Math.max(rr.y * ch + 1, Y(ny)));
  const dim = (layer: Layer, a: number) => (view.activeLayer === null || view.activeLayer === layer ? 1 : a);
  const fenceAlpha = dim('fence', 0.4);
  const bezierAlpha = dim('bezier', 0.35);
  const homoAlpha = dim('homo', 0.5);

  // region outlines + labels (only interesting with more than one region)
  if (p.regions.length > 1) {
    ctx.font = '10px "Lucida Console", monospace';
    p.regions.forEach((reg, i) => {
      const active = i === p.activeRegion;
      const q = reg.rect;
      ctx.strokeStyle = active ? 'rgba(216,217,163,0.9)' : 'rgba(160,160,160,0.4)';
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.strokeRect(q.x * cw + 0.5, q.y * ch + 0.5, q.w * cw - 1, q.h * ch - 1);
      ctx.fillStyle = active ? 'rgba(216,217,163,0.9)' : 'rgba(180,180,180,0.6)';
      ctx.fillText(`R${i + 1} ${reg.id}`, q.x * cw + 5, q.y * ch + 13);
    });
  }

  const poly = (pts: Array<[number, number]>) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(CX(x), CY(y)) : ctx.lineTo(CX(x), CY(y))));
    ctx.stroke();
  };

  if (p.overlays.fence && region.residualEnabled) {
    ctx.globalAlpha = fenceAlpha;
    ctx.lineWidth = view.activeLayer === 'fence' ? 1.5 : 1;
    ctx.strokeStyle = 'rgba(232,149,74,0.6)';
    poly(edgePolyline(region, aspect, 'top'));
    poly(edgePolyline(region, aspect, 'bottom'));
    region.fence.posts.forEach((post, i) => {
      const selected = view.selection.has(`fp:${i}`);
      ctx.strokeStyle = selected ? FENCE_SEL : 'rgba(232,149,74,0.85)';
      ctx.lineWidth = selected ? 2 : view.activeLayer === 'fence' ? 1.5 : 1;
      ctx.setLineDash(post.corner ? [] : [5, 4]);
      poly(postPolyline(region, aspect, i));
      ctx.setLineDash([]);
    });
    ctx.globalAlpha = 1;
  }

  if (p.overlays.bezier && region.residualEnabled) {
    ctx.globalAlpha = bezierAlpha;
    const { cols, rows } = region.bezier;
    ctx.strokeStyle = 'rgba(111,159,216,0.35)';
    ctx.lineWidth = 1;
    const pt = (i: number, j: number, first: boolean) => {
      const [x, y] = bezierHandlePos(region, aspect, i, j);
      first ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y));
    };
    for (let j = 0; j < rows; j++) {
      ctx.beginPath();
      for (let i = 0; i < cols; i++) pt(i, j, i === 0);
      ctx.stroke();
    }
    for (let i = 0; i < cols; i++) {
      ctx.beginPath();
      for (let j = 0; j < rows; j++) pt(i, j, j === 0);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // handles — the active layer's glyphs draw last (on top) at full alpha
  const alphaOf = (l: Layer) => (l === 'bezier' ? bezierAlpha : l === 'homo' ? homoAlpha : fenceAlpha);
  const handles = collectHandles(region, p.overlays, aspect).sort(
    (a, b) => alphaOf(layerOf(a.kind)) - alphaOf(layerOf(b.kind)),
  );
  for (const h of handles) {
    ctx.globalAlpha = alphaOf(layerOf(h.kind));
    const selected = view.selection.has(h.id);
    const hovered = view.hoverId === h.id;
    const r = hovered ? 5 : 4;
    // glyphs on the region border draw inset so they stay visible (the
    // hit-test still uses the true position; the offset is within reach)
    const x = Math.min(cw - r - 1, Math.max(r + 1, X(h.x)));
    const y = Math.min(ch - r - 1, Math.max(r + 1, Y(h.y)));
    if (h.kind === 'bezier') {
      ctx.fillStyle = selected ? BEZ_SEL : BEZ_COLOR;
      ctx.strokeStyle = '#1c2735';
      ctx.lineWidth = 1;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.strokeRect(x - r + 0.5, y - r + 0.5, r * 2 - 1, r * 2 - 1);
    } else if (h.kind === 'homo') {
      // homography corners: circles, green — distinct from both residual layers
      ctx.fillStyle = selected ? HOMO_SEL : HOMO_COLOR;
      ctx.strokeStyle = '#1e3a10';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = selected ? FENCE_SEL : FENCE_COLOR;
      ctx.strokeStyle = '#402810';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - r - 1);
      ctx.lineTo(x + r + 1, y);
      ctx.lineTo(x, y + r + 1);
      ctx.lineTo(x - r - 1, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  if (view.rubber) {
    const { x0, y0, x1, y1 } = view.rubber;
    ctx.strokeStyle = '#d8d9a3';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }
  ctx.restore();
}
