/**
 * 2D overlay canvas: control point glyphs, fence posts/edges, selection
 * highlights, rubber-band. Layered above the WebGL canvas; the GL pass
 * draws the tessellated wireframe itself.
 *
 * Glyph language (deliberately distinct per layer):
 *   bezier points  — squares, steel blue; selected = LW pale yellow-green
 *   fence edge pts — diamonds, orange
 *   fence posts    — orange vertical (warped) lines; selected brighter
 */
import { ProjectState } from '../state/project';
import { collectHandles, edgePolyline, Handle, postPolyline } from './handles';

export interface OverlayView {
  /** CSS pixel size of the viewport */
  cw: number;
  ch: number;
  dpr: number;
  selection: ReadonlySet<string>;
  hoverId: string | null;
  rubber: { x0: number; y0: number; x1: number; y1: number } | null;
  /** layer the current tab edits: it draws emphasized and on top */
  activeLayer: 'bezier' | 'fence' | null;
}

const BEZ_COLOR = '#6f9fd8';
const BEZ_SEL = '#d8d9a3';
const FENCE_COLOR = '#e8954a';
const FENCE_SEL = '#ffd9a3';

export function drawOverlay(ctx: CanvasRenderingContext2D, p: ProjectState, view: OverlayView): void {
  const { cw, ch, dpr } = view;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cw, ch);
  const X = (nx: number) => nx * cw;
  const Y = (ny: number) => ny * ch;
  // Default fence lines run exactly along the image border; inset them a
  // pixel so the stroke isn't clipped by the canvas edge.
  const CX = (nx: number) => Math.min(cw - 1, Math.max(1, nx * cw));
  const CY = (ny: number) => Math.min(ch - 1, Math.max(1, ny * ch));
  const fenceAlpha = view.activeLayer === 'bezier' ? 0.4 : 1;
  const bezierAlpha = view.activeLayer === 'fence' ? 0.35 : 1;

  const poly = (pts: Array<[number, number]>) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(CX(x), CY(y)) : ctx.lineTo(CX(x), CY(y))));
    ctx.stroke();
  };

  if (p.overlays.fence) {
    ctx.globalAlpha = fenceAlpha;
    // fence edge curves
    ctx.lineWidth = view.activeLayer === 'fence' ? 1.5 : 1;
    ctx.strokeStyle = 'rgba(232,149,74,0.6)';
    poly(edgePolyline(p, 'top'));
    poly(edgePolyline(p, 'bottom'));
    // posts
    p.fence.posts.forEach((post, i) => {
      const selected = view.selection.has(`fp:${i}`);
      ctx.strokeStyle = selected ? FENCE_SEL : 'rgba(232,149,74,0.85)';
      ctx.lineWidth = selected ? 2 : view.activeLayer === 'fence' ? 1.5 : 1;
      ctx.setLineDash(post.corner ? [] : [5, 4]);
      poly(postPolyline(p, i));
      ctx.setLineDash([]);
    });
    ctx.globalAlpha = 1;
  }

  if (p.overlays.bezier) {
    ctx.globalAlpha = bezierAlpha;
    // control net lattice
    const { cols, rows, points } = p.bezier;
    ctx.strokeStyle = 'rgba(111,159,216,0.35)';
    ctx.lineWidth = 1;
    for (let j = 0; j < rows; j++) {
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 2;
        i === 0 ? ctx.moveTo(X(points[k]), Y(points[k + 1])) : ctx.lineTo(X(points[k]), Y(points[k + 1]));
      }
      ctx.stroke();
    }
    for (let i = 0; i < cols; i++) {
      ctx.beginPath();
      for (let j = 0; j < rows; j++) {
        const k = (j * cols + i) * 2;
        j === 0 ? ctx.moveTo(X(points[k]), Y(points[k + 1])) : ctx.lineTo(X(points[k]), Y(points[k + 1]));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // handles — the active layer's glyphs draw last (on top) at full alpha
  const handles = collectHandles(p).sort((a, b) => {
    const act = (h: Handle) =>
      view.activeLayer === null ? 0 : (h.kind === 'bezier') === (view.activeLayer === 'bezier') ? 1 : 0;
    return act(a) - act(b);
  });
  for (const h of handles) {
    ctx.globalAlpha = h.kind === 'bezier' ? bezierAlpha : fenceAlpha;
    const selected = view.selection.has(h.id);
    const hovered = view.hoverId === h.id;
    const r = hovered ? 5 : 4;
    // glyphs on the image border draw inset so they stay visible (the
    // hit-test still uses the true position; the offset is within reach)
    const x = Math.min(cw - r - 1, Math.max(r + 1, X(h.x)));
    const y = Math.min(ch - r - 1, Math.max(r + 1, Y(h.y)));
    if (h.kind === 'bezier') {
      ctx.fillStyle = selected ? BEZ_SEL : BEZ_COLOR;
      ctx.strokeStyle = '#1c2735';
      ctx.lineWidth = 1;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.strokeRect(x - r + 0.5, y - r + 0.5, r * 2 - 1, r * 2 - 1);
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
