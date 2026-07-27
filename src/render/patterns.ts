/**
 * Procedural test patterns, drawn into a 2D canvas at output resolution and
 * uploaded as the warp texture.
 */
import { ProjectState } from '../state/project';

export interface Still {
  name: string;
  source: HTMLImageElement | ImageBitmap;
  /** object URL for the thumbnail strip */
  url: string;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function drawGrid(w: number, h: number, spacing: number, lineWidth: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  // lines mirror out from center so the crosshair sits on the lattice
  for (let x = cx; x <= w; x += spacing) ctx.fillRect(Math.round(x - lineWidth / 2), 0, lineWidth, h);
  for (let x = cx - spacing; x >= -lineWidth; x -= spacing) ctx.fillRect(Math.round(x - lineWidth / 2), 0, lineWidth, h);
  for (let y = cy; y <= h; y += spacing) ctx.fillRect(0, Math.round(y - lineWidth / 2), w, lineWidth);
  for (let y = cy - spacing; y >= -lineWidth; y -= spacing) ctx.fillRect(0, Math.round(y - lineWidth / 2), w, lineWidth);
  // center crosshair
  ctx.fillStyle = '#00ff40';
  const ch = Math.round(spacing * 0.75);
  ctx.fillRect(cx - ch, cy - 1, ch * 2, 3);
  ctx.fillRect(cx - 1, cy - ch, 3, ch * 2);
  ctx.strokeStyle = '#00ff40';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.round(spacing * 0.5), 0, Math.PI * 2);
  ctx.stroke();
  // corner markers (L shapes)
  ctx.fillStyle = '#ff4040';
  const m = Math.max(24, Math.round(spacing / 2));
  const t = Math.max(3, lineWidth + 1);
  for (const [px, py, sx, sy] of [
    [0, 0, 1, 1],
    [w, 0, -1, 1],
    [0, h, 1, -1],
    [w, h, -1, -1],
  ] as const) {
    ctx.fillRect(px + (sx < 0 ? -m : 0), py + (sy < 0 ? -t : 0), m, t);
    ctx.fillRect(px + (sx < 0 ? -t : 0), py + (sy < 0 ? -m : 0), t, m);
  }
  return c;
}

function drawCrosshatch(w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#9a9a9a';
  for (let x = 0; x < w; x += 8) ctx.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += 8) ctx.fillRect(0, y, w, 1);
  ctx.fillStyle = '#fff';
  for (let x = 0; x < w; x += 64) ctx.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += 64) ctx.fillRect(0, y, w, 1);
  return c;
}

function drawSmpte(w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  // 75% bars, SMPTE-style three-band layout
  const bars75 = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const topH = Math.round(h * 0.67);
  const bw = w / 7;
  bars75.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), topH);
  });
  // castellation strip: reverse blue bars
  const midH = Math.round(h * 0.08);
  const mid = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
  mid.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(i * bw), topH, Math.ceil(bw), midH);
  });
  // bottom: -I, white, +Q, black, PLUGE, black
  const by = topH + midH;
  const bh = h - by;
  const widths = [5 / 28, 5 / 28, 5 / 28, 5 / 28, 8 / 28];
  const cols = ['#00214c', '#ffffff', '#32006a', '#131313', '#131313'];
  let x = 0;
  for (let i = 0; i < widths.length; i++) {
    ctx.fillStyle = cols[i];
    ctx.fillRect(Math.round(x), by, Math.ceil(widths[i] * w), bh);
    x += widths[i] * w;
  }
  // PLUGE pulses inside the last black region
  const px = Math.round((20 / 28) * w);
  const pw = Math.round((8 / 28 / 3) * w);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(px, by, pw, bh);
  ctx.fillStyle = '#131313';
  ctx.fillRect(px + pw, by, pw, bh);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(px + 2 * pw, by, pw, bh);
  return c;
}

function drawPolar(w: number, h: number, cxN: number, cyN: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const cx = cxN * w;
  const cy = cyN * h;
  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  const step = Math.min(w, h) / 12;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  for (let r = step; r <= maxR; r += step) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let a = 0; a < 360; a += 15) {
    const rad = (a * Math.PI) / 180;
    ctx.strokeStyle = a % 90 === 0 ? '#00ff40' : a % 45 === 0 ? '#ffff00' : '#fff';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * maxR, cy + Math.sin(rad) * maxR);
    ctx.stroke();
  }
  ctx.fillStyle = '#ff4040';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function drawSolid(w: number, h: number, kind: 'white' | 'gray' | 'black'): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = kind === 'white' ? '#ffffff' : kind === 'gray' ? '#808080' : '#000000';
  ctx.fillRect(0, 0, w, h);
  return c;
}

function drawConvergence(w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const spacing = 32;
  const cols = ['#ff0000', '#00ff00', '#0000ff'];
  let i = 0;
  for (let x = 0; x < w; x += spacing, i++) {
    ctx.fillStyle = cols[i % 3];
    ctx.fillRect(x, 0, 1, h); // single-pixel verticals cycling R,G,B
  }
  i = 0;
  for (let y = 0; y < h; y += spacing, i++) {
    ctx.fillStyle = cols[i % 3];
    ctx.fillRect(0, y, w, 1);
  }
  return c;
}

function drawNoStill(w: number, h: number): HTMLCanvasElement {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#808080';
  ctx.font = `${Math.round(h / 24)}px Tahoma, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('NO IMAGE LOADED — drop a PNG/JPEG or use Load Image', w / 2, h / 2);
  return c;
}

export function generatePattern(p: ProjectState, stills: Still[]): TexImageSource {
  const w = p.outputW;
  const h = p.outputH;
  switch (p.pattern.id) {
    case 'grid':
      return drawGrid(w, h, Math.max(8, p.pattern.gridSpacing), Math.max(1, p.pattern.gridLineWidth));
    case 'crosshatch':
      return drawCrosshatch(w, h);
    case 'smpte':
      return drawSmpte(w, h);
    case 'polar':
      return drawPolar(w, h, p.pattern.polarCx, p.pattern.polarCy);
    case 'solid':
      return drawSolid(w, h, p.pattern.solid);
    case 'convergence':
      return drawConvergence(w, h);
    case 'custom': {
      const s = stills[p.pattern.customIndex];
      return s ? s.source : drawNoStill(w, h);
    }
  }
}

export function patternLabel(p: ProjectState, stills: Still[]): string {
  switch (p.pattern.id) {
    case 'grid':
      return `Grid ${p.pattern.gridSpacing}px`;
    case 'crosshatch':
      return 'Crosshatch';
    case 'smpte':
      return 'SMPTE Bars';
    case 'polar':
      return 'Polar/Dome';
    case 'solid':
      return `Solid ${p.pattern.solid}`;
    case 'convergence':
      return 'Convergence RGB';
    case 'custom':
      return stills[p.pattern.customIndex]?.name ?? 'Custom (none)';
  }
}
