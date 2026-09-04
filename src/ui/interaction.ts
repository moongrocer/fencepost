/**
 * Pointer interaction on the overlay canvas: drag handles, drag posts,
 * rubber-band selection, hover tracking, and (in mosaic projects)
 * click-to-switch between regions. Hit-testing happens in CSS pixel space
 * against analytically computed handle positions, so it is exact
 * regardless of devicePixelRatio.
 *
 * All editing applies to the ACTIVE region; handle coordinates are
 * region-local and get mapped through the region's rect.
 */
import { ProjectState, RegionState } from '../state/project';
import { composedPoint, regionAspect, residualOffset } from '../warp/compose';
import { setPostX } from '../warp/fence';
import { cylinderProject, invertMap, UNIT_CORNERS } from '../warp/model';
import { collectHandles, distToPolyline, Handle, Layer, layerOf, postPolyline } from './handles';

export interface EditorHost {
  readonly project: ProjectState;
  readonly selection: Set<string>;
  hoverId: string | null;
  rubber: { x0: number; y0: number; x1: number; y1: number } | null;
  viewSize(): { cw: number; ch: number };
  /**
   * Which warp layer the UI is focused on (WARP tab -> bezier, FENCE tab ->
   * fence, MODEL tab -> homography corners). Default fence handles coincide
   * exactly with bezier corner points (and homography corners), so the
   * active layer wins hit-test ties — the tab decides what you grab.
   */
  activeLayer(): Layer | null;
  setActiveRegion(i: number): void;
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

const HIT_PX = 12;
const POST_HIT_PX = 8;

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

  private region(): RegionState {
    return this.host.project.regions[this.host.project.activeRegion];
  }

  private aspect(): number {
    return regionAspect(this.host.project, this.region());
  }

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** region-local normalized -> canvas CSS px */
  private handleCss(h: { x: number; y: number }): { x: number; y: number } {
    const { cw, ch } = this.host.viewSize();
    const rr = this.region().rect;
    return { x: (rr.x + h.x * rr.w) * cw, y: (rr.y + h.y * rr.h) * ch };
  }

  private handleAt(x: number, y: number): Handle | null {
    const layer = this.host.activeLayer();
    const preferred = (h: Handle) => layer === null || layerOf(h.kind) === layer;
    let bestPref: Handle | null = null;
    let bestPrefD = HIT_PX;
    let bestOther: Handle | null = null;
    let bestOtherD = HIT_PX;
    for (const h of collectHandles(this.region(), this.host.project.overlays, this.aspect())) {
      const c = this.handleCss(h);
      const d = Math.hypot(c.x - x, c.y - y);
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
    const posts = this.region().fence.posts;
    for (let i = 0; i < posts.length; i++) {
      const pts = postPolyline(this.region(), this.aspect(), i).map((pt) => {
        const c = this.handleCss({ x: pt[0], y: pt[1] });
        return [c.x, c.y] as [number, number];
      });
      if (distToPolyline(x, y, pts) < POST_HIT_PX) return i;
    }
    return null;
  }

  /** region index whose output rect contains this canvas point (canvas fractions) */
  private regionAtPoint(nx: number, ny: number): number | null {
    const regions = this.host.project.regions;
    for (let i = 0; i < regions.length; i++) {
      const q = regions[i].rect;
      if (nx >= q.x && nx <= q.x + q.w && ny >= q.y && ny <= q.y + q.h) return i;
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
    if (this.host.activeLayer() === 'fence' && (!h || layerOf(h.kind) !== 'fence')) {
      const pi = this.postAt(x, y);
      if (pi !== null) {
        if (!e.shiftKey) sel.clear();
        sel.add(`fp:${pi}`);
        this.drag = { kind: 'post', index: pi, startX: this.region().fence.posts[pi].x };
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
      for (const id of sel) {
        const v = readHandleValue(this.region(), this.aspect(), id);
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
      this.drag = { kind: 'post', index: pi, startX: this.region().fence.posts[pi].x };
      this.host.selectionChanged();
      return;
    }

    // Click landed in ANOTHER region's slice: switch to it. If the click
    // was actually ON one of that region's handles, grab it in the same
    // gesture — otherwise the first click silently selects nothing and the
    // arrow keys appear dead.
    const { cw, ch } = this.host.viewSize();
    const ri = this.regionAtPoint(x / cw, y / ch);
    if (ri !== null && ri !== this.host.project.activeRegion) {
      this.host.setActiveRegion(ri);
      const h2 = this.handleAt(x, y); // now hit-tests the newly active region
      if (h2) {
        sel.clear();
        sel.add(h2.id);
        const starts = new Map<string, { x: number; y: number }>();
        const v = readHandleValue(this.region(), this.aspect(), h2.id);
        if (v) starts.set(h2.id, v);
        this.drag = { kind: 'handles', starts };
        this.host.selectionChanged();
        return;
      }
      const pi2 = this.postAt(x, y);
      if (pi2 !== null) {
        sel.clear();
        sel.add(`fp:${pi2}`);
        this.drag = { kind: 'post', index: pi2, startX: this.region().fence.posts[pi2].x };
        this.host.selectionChanged();
        return;
      }
      this.drag = null;
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
    const region = this.region();
    const rr = region.rect;

    if (!this.drag) {
      const h = this.handleAt(x, y);
      const newHover = h ? h.id : null;
      if (newHover !== this.host.hoverId) {
        this.host.hoverId = newHover;
        this.host.overlayDirty();
      }
      const p = this.host.project;
      const ox = (x / cw) * p.outputW;
      const oy = (y / ch) * p.outputH;
      this.host.setCursorInfo(`cur ${ox.toFixed(1)}, ${oy.toFixed(1)} px`);
      return;
    }

    // drag deltas in REGION-LOCAL normalized units
    const dxN = (x - this.downX) / (cw * rr.w);
    const dyN = (y - this.downY) / (ch * rr.h);
    if (Math.abs(x - this.downX) + Math.abs(y - this.downY) > 1) this.moved = true;

    if (this.drag.kind === 'handles') {
      if (!this.moved) return;
      this.ensureGesture();
      for (const [id, start] of this.drag.starts) {
        writeHandleValue(region, this.aspect(), id, start, dxN, dyN);
      }
      this.host.warpEdited(true);
    } else if (this.drag.kind === 'post') {
      if (!this.moved) return;
      this.ensureGesture();
      region.fence = setPostX(region.fence, this.drag.index, this.drag.startX + dxN);
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
        const xMin = Math.min(r.x0, r.x1);
        const xMax = Math.max(r.x0, r.x1);
        const yMin = Math.min(r.y0, r.y1);
        const yMax = Math.max(r.y0, r.y1);
        const sel = this.host.selection;
        sel.clear();
        for (const id of this.drag.base) sel.add(id);
        for (const h of collectHandles(this.region(), this.host.project.overlays, this.aspect())) {
          const c = this.handleCss(h);
          if (c.x >= xMin && c.x <= xMax && c.y >= yMin && c.y <= yMax) sel.add(h.id);
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

/**
 * The draggable value behind a handle. Bezier/fence values are the raw
 * stored numbers (drags add deltas to them). A homography corner's value
 * is where the image corner currently LANDS, so a drag moves the picture's
 * corner to the mouse whatever sits downstream.
 */
export function readHandleValue(region: RegionState, aspect: number, id: string): { x: number; y: number } | null {
  const parts = id.split(':');
  if (parts[0] === 'h') {
    const c = UNIT_CORNERS[+parts[1]];
    if (!c) return null;
    const p = composedPoint(region, aspect, c[0], c[1]);
    return { x: p[0], y: p[1] };
  }
  if (parts[0] === 'b') {
    const i = +parts[1];
    const j = +parts[2];
    const k = (j * region.bezier.cols + i) * 2;
    return { x: region.bezier.points[k], y: region.bezier.points[k + 1] };
  }
  if (parts[0] === 'ft' || parts[0] === 'fb') {
    const post = region.fence.posts[+parts[1]];
    if (!post) return null;
    return { x: post.x, y: parts[0] === 'ft' ? post.top : post.bottom };
  }
  if (parts[0] === 'fp') {
    const post = region.fence.posts[+parts[1]];
    return post ? { x: post.x, y: 0 } : null;
  }
  return null;
}

/** Apply a drag delta to one handle. Fence edge points move vertically only. */
export function writeHandleValue(
  region: RegionState,
  aspect: number,
  id: string,
  start: { x: number; y: number },
  dxN: number,
  dyN: number,
): void {
  const parts = id.split(':');
  if (parts[0] === 'h') {
    const i = +parts[1];
    const c = UNIT_CORNERS[i];
    if (!c) return;
    // composed = cyl(H(c)) + D(c)  →  H(c) = cyl⁻¹(target − D(c))
    const d = residualOffset(region, c[0], c[1]);
    const tx = start.x + dxN - d[0];
    const ty = start.y + dyN - d[1];
    const cyl = region.cylinder;
    region.homography.corners[i] = cyl.enabled
      ? invertMap((x, y) => cylinderProject(cyl, aspect, x, y), tx, ty, region.homography.corners[i])
      : [tx, ty];
    return;
  }
  if (parts[0] === 'b') {
    const i = +parts[1];
    const j = +parts[2];
    const k = (j * region.bezier.cols + i) * 2;
    region.bezier.points[k] = start.x + dxN;
    region.bezier.points[k + 1] = start.y + dyN;
  } else if (parts[0] === 'ft') {
    const post = region.fence.posts[+parts[1]];
    if (post) post.top = start.y + dyN;
  } else if (parts[0] === 'fb') {
    const post = region.fence.posts[+parts[1]];
    if (post) post.bottom = start.y + dyN;
  } else if (parts[0] === 'fp') {
    region.fence = setPostX(region.fence, +parts[1], start.x + dxN);
  }
}
