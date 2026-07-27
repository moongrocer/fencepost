/**
 * Pointer interaction on the overlay canvas: drag handles, drag posts,
 * rubber-band selection, hover tracking. Hit-testing happens in CSS pixel
 * space against analytically computed handle positions, so it is exact
 * regardless of devicePixelRatio.
 */
import { ProjectState } from '../state/project';
import { setPostX } from '../warp/fence';
import { collectHandles, distToPolyline, Handle, postPolyline } from './handles';

export interface EditorHost {
  readonly project: ProjectState;
  readonly selection: Set<string>;
  hoverId: string | null;
  rubber: { x0: number; y0: number; x1: number; y1: number } | null;
  viewSize(): { cw: number; ch: number };
  /**
   * Which warp layer the UI is focused on (WARP tab -> bezier, FENCE tab ->
   * fence). Default fence handles coincide exactly with bezier corner
   * points, so the active layer wins hit-test ties — the tab decides what
   * you grab.
   */
  activeLayer(): 'bezier' | 'fence' | null;
  /** push an undo snapshot (called once per drag gesture, at first move) */
  beginGesture(): void;
  /** drag finished: rebuild full-res mesh, autosave */
  endGesture(): void;
  /** warp values changed: rebuild (interactive = low-tess) mesh + render */
  warpEdited(interactive: boolean): void;
  overlayDirty(): void;
  selectionChanged(): void;
  setCursorInfo(text: string): void;
}

const HIT_PX = 8;
const POST_HIT_PX = 6;

type DragMode =
  | { kind: 'handles'; starts: Map<string, { x: number; y: number }> }
  | { kind: 'post'; index: number; startX: number }
  | { kind: 'rubber'; base: Set<string> };

export class InteractionController {
  private drag: DragMode | null = null;
  private downX = 0;
  private downY = 0;
  private moved = false;
  private gesturePushed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private host: EditorHost,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
  }

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private handleAt(x: number, y: number): Handle | null {
    const { cw, ch } = this.host.viewSize();
    const layer = this.host.activeLayer();
    const preferred = (h: Handle) =>
      layer === null ? true : layer === 'bezier' ? h.kind === 'bezier' : h.kind !== 'bezier';
    let bestPref: Handle | null = null;
    let bestPrefD = HIT_PX;
    let bestOther: Handle | null = null;
    let bestOtherD = HIT_PX;
    for (const h of collectHandles(this.host.project)) {
      const d = Math.hypot(h.x * cw - x, h.y * ch - y);
      if (preferred(h)) {
        if (d < bestPrefD) {
          bestPrefD = d;
          bestPref = h;
        }
      } else if (d < bestOtherD) {
        bestOtherD = d;
        bestOther = h;
      }
    }
    return bestPref ?? bestOther;
  }

  private postAt(x: number, y: number): number | null {
    if (!this.host.project.overlays.fence) return null;
    const { cw, ch } = this.host.viewSize();
    const posts = this.host.project.fence.posts;
    for (let i = 0; i < posts.length; i++) {
      const pts = postPolyline(this.host.project, i).map(
        ([nx, ny]) => [nx * cw, ny * ch] as [number, number],
      );
      if (distToPolyline(x, y, pts) < POST_HIT_PX) return i;
    }
    return null;
  }

  private ensureGesture(): void {
    if (!this.gesturePushed) {
      this.gesturePushed = true;
      this.host.beginGesture();
    }
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.toLocal(e);
    this.downX = x;
    this.downY = y;
    this.moved = false;
    this.gesturePushed = false;
    const sel = this.host.selection;

    let h = this.handleAt(x, y);
    // In fence mode, a post line beats a (fallback) bezier handle.
    if (this.host.activeLayer() === 'fence' && (!h || h.kind === 'bezier')) {
      const pi = this.postAt(x, y);
      if (pi !== null) {
        if (!e.shiftKey) sel.clear();
        sel.add(`fp:${pi}`);
        this.drag = { kind: 'post', index: pi, startX: this.host.project.fence.posts[pi].x };
        this.host.selectionChanged();
        return;
      }
    }
    if (h) {
      if (e.shiftKey) {
        sel.has(h.id) ? sel.delete(h.id) : sel.add(h.id);
      } else if (!sel.has(h.id)) {
        sel.clear();
        sel.add(h.id);
      }
      const starts = new Map<string, { x: number; y: number }>();
      const p = this.host.project;
      for (const id of sel) {
        const v = readHandleValue(p, id);
        if (v) starts.set(id, v);
      }
      this.drag = { kind: 'handles', starts };
      this.host.selectionChanged();
      return;
    }

    const pi = this.postAt(x, y);
    if (pi !== null) {
      if (!e.shiftKey) sel.clear();
      sel.add(`fp:${pi}`);
      this.drag = { kind: 'post', index: pi, startX: this.host.project.fence.posts[pi].x };
      this.host.selectionChanged();
      return;
    }

    this.drag = { kind: 'rubber', base: e.shiftKey ? new Set(sel) : new Set() };
    if (!e.shiftKey) {
      sel.clear();
      this.host.selectionChanged();
    }
    this.host.rubber = { x0: x, y0: y, x1: x, y1: y };
    this.host.overlayDirty();
  };

  private onMove = (e: PointerEvent): void => {
    const { x, y } = this.toLocal(e);
    const { cw, ch } = this.host.viewSize();
    const p = this.host.project;

    if (!this.drag) {
      const h = this.handleAt(x, y);
      const newHover = h ? h.id : null;
      if (newHover !== this.host.hoverId) {
        this.host.hoverId = newHover;
        this.host.overlayDirty();
      }
      const ox = (x / cw) * p.outputW;
      const oy = (y / ch) * p.outputH;
      this.host.setCursorInfo(`cur ${ox.toFixed(1)}, ${oy.toFixed(1)} px`);
      return;
    }

    const dxN = (x - this.downX) / cw;
    const dyN = (y - this.downY) / ch;
    if (Math.abs(x - this.downX) + Math.abs(y - this.downY) > 1) this.moved = true;

    if (this.drag.kind === 'handles') {
      if (!this.moved) return;
      this.ensureGesture();
      for (const [id, start] of this.drag.starts) {
        writeHandleValue(p, id, start, dxN, dyN);
      }
      this.host.warpEdited(true);
    } else if (this.drag.kind === 'post') {
      if (!this.moved) return;
      this.ensureGesture();
      p.fence = setPostX(p.fence, this.drag.index, this.drag.startX + dxN);
      this.host.warpEdited(true);
    } else {
      this.host.rubber = { x0: this.downX, y0: this.downY, x1: x, y1: y };
      this.host.overlayDirty();
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (this.drag.kind === 'rubber') {
      const r = this.host.rubber;
      if (r && this.moved) {
        const { cw, ch } = this.host.viewSize();
        const xMin = Math.min(r.x0, r.x1) / cw;
        const xMax = Math.max(r.x0, r.x1) / cw;
        const yMin = Math.min(r.y0, r.y1) / ch;
        const yMax = Math.max(r.y0, r.y1) / ch;
        const sel = this.host.selection;
        sel.clear();
        for (const id of this.drag.base) sel.add(id);
        for (const h of collectHandles(this.host.project)) {
          if (h.x >= xMin && h.x <= xMax && h.y >= yMin && h.y <= yMax) sel.add(h.id);
        }
        this.host.selectionChanged();
      }
      this.host.rubber = null;
      this.host.overlayDirty();
    } else if (this.moved) {
      this.host.endGesture();
    }
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
}

export function readHandleValue(p: ProjectState, id: string): { x: number; y: number } | null {
  const parts = id.split(':');
  if (parts[0] === 'b') {
    const i = +parts[1];
    const j = +parts[2];
    const k = (j * p.bezier.cols + i) * 2;
    return { x: p.bezier.points[k], y: p.bezier.points[k + 1] };
  }
  if (parts[0] === 'ft' || parts[0] === 'fb') {
    const post = p.fence.posts[+parts[1]];
    if (!post) return null;
    return { x: post.x, y: parts[0] === 'ft' ? post.top : post.bottom };
  }
  if (parts[0] === 'fp') {
    const post = p.fence.posts[+parts[1]];
    return post ? { x: post.x, y: 0 } : null;
  }
  return null;
}

/** Apply a drag delta to one handle. Fence edge points move vertically only. */
export function writeHandleValue(
  p: ProjectState,
  id: string,
  start: { x: number; y: number },
  dxN: number,
  dyN: number,
): void {
  const parts = id.split(':');
  if (parts[0] === 'b') {
    const i = +parts[1];
    const j = +parts[2];
    const k = (j * p.bezier.cols + i) * 2;
    p.bezier.points[k] = start.x + dxN;
    p.bezier.points[k + 1] = start.y + dyN;
  } else if (parts[0] === 'ft') {
    const post = p.fence.posts[+parts[1]];
    if (post) post.top = start.y + dyN;
  } else if (parts[0] === 'fb') {
    const post = p.fence.posts[+parts[1]];
    if (post) post.bottom = start.y + dyN;
  } else if (parts[0] === 'fp') {
    p.fence = setPostX(p.fence, +parts[1], start.x + dxN);
  }
}
