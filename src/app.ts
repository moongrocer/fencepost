/**
 * FENCEPOST application orchestrator: owns the project state, undo stack,
 * GL renderer, overlay, panels, keyboard map, and the export pipeline.
 *
 * Multi-region (mosaic) model: the project is one mosaic framebuffer split
 * into N regions (projectors). All editing applies to the ACTIVE region;
 * the render pass draws every region into its slice of the one canvas —
 * which is exactly what a fullscreen window on an NVIDIA Mosaic / Eyefinity
 * desktop needs.
 */
import { bakeAlphaMap, bakeBetaMap, hasBlend } from './render/blend';
import { GLRenderer, RegionDrawUniforms } from './render/gl';
import { generatePattern, patternLabel, Still } from './render/patterns';
import { buildMpcdiXml, MpcdiRegionEntry, safeFileName } from './export/mpcdi-xml';
import { encodePFM } from './export/pfm';
import { encodeGrayPNG } from './export/png';
import { buildArchive, downloadBytes } from './export/zip';
import { autosave, loadAutosave, openProjectFile, saveProjectFile } from './state/persist';
import {
  defaultProject,
  defaultRegion,
  deserializeProject,
  mosaicColumns,
  PatternId,
  ProjectState,
  RegionState,
  serializeProject,
} from './state/project';
import { UndoStack } from './state/undo';
import { createBezierGrid, subdivideAfterColumn, subdivideAfterRow } from './warp/bezier';
import { buildRegionMesh, regionAspect } from './warp/compose';
import { addPost, createFence, removePost, setPostX, widestGapMid } from './warp/fence';
import { defaultCylinder, defaultHomography } from './warp/model';
import { laplacianSmooth, refitPatch, upgradeToHomography } from './warp/refit';
import { button, el } from './ui/dom';
import { buildHelpOverlay } from './ui/help';
import { alertModal, confirmModal, modalOpen } from './ui/modal';
import { EditorHost, InteractionController, readHandleValue, writeHandleValue } from './ui/interaction';
import { drawOverlay } from './ui/overlay';
import { Layer } from './ui/handles';
import { renderPanel, TabId, TABS } from './ui/panels';

export interface EditOpts {
  warp?: boolean;
  pattern?: boolean;
  /** structural changes rebuild the tool panel (button active states etc.) */
  structural?: boolean;
}

const FULL_TESS = 128;
const DRAG_TESS = 64;
/** consecutive arrow-key nudges within this window share one undo snapshot */
const NUDGE_COALESCE_MS = 700;
const PATTERN_CYCLE: Array<{ id: PatternId; solid?: 'white' | 'gray' | 'black' }> = [
  { id: 'grid' },
  { id: 'crosshatch' },
  { id: 'smpte' },
  { id: 'polar' },
  { id: 'solid', solid: 'white' },
  { id: 'solid', solid: 'gray' },
  { id: 'solid', solid: 'black' },
  { id: 'convergence' },
];

export class App implements EditorHost {
  project: ProjectState;
  stills: Still[] = [];
  selection = new Set<string>();
  hoverId: string | null = null;
  rubber: { x0: number; y0: number; x1: number; y1: number } | null = null;

  private undoStack = new UndoStack();
  private renderer: GLRenderer;
  private glCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private vpStack: HTMLElement;
  private viewportEl: HTMLElement;
  private toolcol!: HTMLElement;
  private tabButtons = new Map<TabId, HTMLButtonElement>();
  private currentTab: TabId = 'PATTERNS';
  private info: Record<'cursor' | 'sel' | 'step' | 'density' | 'pattern', HTMLElement>;
  private helpEl: HTMLElement | null = null;
  private outputMode = false;
  /**
   * Calibrate mode: canvas fills the whole window 1:1 with the projector
   * raster and editing stays live, while the tool column becomes a floating,
   * draggable, collapsible palette. Auto-engaged on fullscreen.
   */
  private calibrateMode = false;
  private palette!: HTMLElement;
  private paletteTabButtons = new Map<TabId, HTMLButtonElement>();
  private restoreChip!: HTMLButtonElement;
  private paletteCollapsed = false;
  private paletteHidden = false;
  private palettePos: { x: number; y: number } | null = null;
  private regionStripTop!: HTMLElement;
  private regionStripPalette!: HTMLElement;
  private patternDirty = true;
  /** which regions need a mesh rebuild ('all' after structural changes) */
  private dirtyRegions: Set<number> | 'all' = 'all';
  private currentTess = FULL_TESS;
  private rafPending = false;
  private cssW = 0;
  private cssH = 0;
  private nudgeRunUntil = 0;
  private nudgeRunKey = '';

  constructor(root: HTMLElement) {
    this.project = loadAutosave() ?? defaultProject();

    // ---------- DOM layout ----------
    const top = el('div', 'lw-top');
    top.appendChild(el('div', 'lw-logo', 'FENCEPOST'));
    const tabs = el('div', 'lw-tabs');
    for (const t of TABS) {
      const b = el('button', 'lw-tab', t);
      b.addEventListener('click', () => this.setTab(t));
      tabs.appendChild(b);
      this.tabButtons.set(t, b);
    }
    top.appendChild(tabs);
    this.regionStripTop = el('div', 'lw-topbtns');
    top.appendChild(this.regionStripTop);
    const topBtns = el('div', 'lw-topbtns');
    topBtns.appendChild(button('CALIBRATE', () => this.setCalibrateMode(!this.calibrateMode), 'lw-btn mini'));
    topBtns.appendChild(button('OUTPUT', () => this.setOutputMode(true), 'lw-btn mini'));
    topBtns.appendChild(button('FULLSCR', () => this.toggleFullscreen(), 'lw-btn mini'));
    topBtns.appendChild(button('?', () => this.toggleHelp(), 'lw-btn mini'));
    top.appendChild(topBtns);

    const main = el('div', 'lw-main');
    this.palette = this.buildPalette();
    this.viewportEl = el('div', 'lw-viewport');
    this.vpStack = el('div', 'vp-stack');
    this.glCanvas = el('canvas');
    this.glCanvas.id = 'gl-canvas';
    this.overlayCanvas = el('canvas');
    this.overlayCanvas.id = 'overlay-canvas';
    this.vpStack.appendChild(this.glCanvas);
    this.vpStack.appendChild(this.overlayCanvas);
    this.viewportEl.appendChild(this.vpStack);
    main.appendChild(this.palette);
    main.appendChild(this.viewportEl);

    const infobar = el('div', 'lw-infobar');
    const mkInfo = () => {
      const s = el('span');
      infobar.appendChild(s);
      return s;
    };
    this.info = {
      cursor: mkInfo(),
      sel: mkInfo(),
      step: mkInfo(),
      density: mkInfo(),
      pattern: mkInfo(),
    };

    // Floating chip to bring the palette back after it's fully hidden in
    // calibrate mode (only shown via CSS while body.palette-hidden).
    this.restoreChip = button('▸ TOOLS', () => this.showPalette(), 'lw-btn lw-restore-chip');

    root.appendChild(top);
    root.appendChild(main);
    root.appendChild(infobar);
    root.appendChild(this.restoreChip);

    // ---------- subsystems ----------
    this.renderer = new GLRenderer(this.glCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d')!;
    new InteractionController(this.overlayCanvas, this);

    window.addEventListener('resize', () => this.layoutViewport());
    new ResizeObserver(() => this.layoutViewport()).observe(this.viewportEl);
    window.addEventListener('keydown', this.onKey);
    // Entering/leaving the browser's fullscreen toggles calibrate mode so the
    // on-projector workflow (fullscreen -> full-bleed + floating palette) is
    // automatic, and Esc-out of fullscreen restores the docked layout.
    document.addEventListener('fullscreenchange', () => {
      this.setCalibrateMode(!!document.fullscreenElement);
    });

    // drag & drop stills
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) void this.addStillFiles(Array.from(e.dataTransfer.files));
    });

    this.refreshRegionStrips();
    this.setTab('PATTERNS');
    this.layoutViewport();
    this.updateInfo();
    this.requestRender();
  }

  // ============================== regions ==============================

  /** the region all editing applies to */
  get region(): RegionState {
    return this.project.regions[this.project.activeRegion];
  }

  setActiveRegion(i: number): void {
    const n = this.project.regions.length;
    const clamped = Math.min(Math.max(0, i), n - 1);
    if (clamped === this.project.activeRegion) return;
    this.project.activeRegion = clamped;
    this.selection.clear();
    autosave(this.project);
    this.refreshRegionStrips();
    this.rebuildPanel();
    this.requestRender();
    this.updateInfo();
  }

  cycleRegion(dir: number): void {
    const n = this.project.regions.length;
    this.setActiveRegion((this.project.activeRegion + dir + n) % n);
  }

  /** Replace the project's regions with an N-column mosaic. */
  async buildMosaic(cols: number, projW: number, projH: number, overlapPx: number): Promise<void> {
    const ok = await confirmModal(
      `Build a ${cols}-column mosaic (${cols} × ${projW} × ${projH}, ${overlapPx} px overlap)?\n` +
        'All region warps reset.',
      'BUILD MOSAIC',
      'Build',
    );
    if (!ok) return;
    this.edit(
      () => {
        const m = mosaicColumns(cols, projW, projH, overlapPx);
        this.project.outputW = m.outputW;
        this.project.outputH = m.outputH;
        this.project.regions = m.regions;
        this.project.activeRegion = 0;
        this.selection.clear();
      },
      { warp: true, pattern: true, structural: true },
    );
    this.dirtyRegions = 'all';
    this.refreshRegionStrips();
    this.layoutViewport();
  }

  /** Collapse back to a single full-frame region. */
  async makeSingleRegion(): Promise<void> {
    if (!(await confirmModal('Collapse to a single full-frame region? All region warps reset.', 'SINGLE REGION')))
      return;
    this.edit(
      () => {
        this.project.regions = [
          defaultRegion('region0', { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }),
        ];
        this.project.activeRegion = 0;
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
    this.dirtyRegions = 'all';
    this.refreshRegionStrips();
  }

  setRegionId(v: string): void {
    this.edit(() => {
      this.region.id = v || `region${this.project.activeRegion}`;
    }, {});
  }

  private refreshRegionStrips(): void {
    const build = (host: HTMLElement) => {
      host.replaceChildren();
      if (this.project.regions.length < 2) return;
      this.project.regions.forEach((r, i) => {
        const b = button(`R${i + 1}`, () => this.setActiveRegion(i), 'lw-btn mini');
        b.title = r.id;
        if (i === this.project.activeRegion) b.classList.add('active');
        host.appendChild(b);
      });
    };
    build(this.regionStripTop);
    build(this.regionStripPalette);
  }

  // ============================== palette ==============================

  /**
   * The tool column lives inside a wrapper that is a normal docked grid cell
   * in windowed mode and a floating, draggable, collapsible palette in
   * calibrate mode. rebuildPanel only swaps the scroll content (.lw-toolcol),
   * so the header, compact tab strip, and drag position survive rebuilds.
   */
  private buildPalette(): HTMLElement {
    const palette = el('div', 'lw-palette');

    // header doubles as the drag handle (only visible in calibrate mode)
    const header = el('div', 'lw-palette-header');
    header.appendChild(el('span', 'lw-palette-title', 'FENCEPOST'));
    const spacer = el('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);
    const collapseBtn = button('▾', () => this.setPaletteCollapsed(!this.paletteCollapsed), 'lw-palette-x');
    collapseBtn.title = 'Collapse / expand tools';
    const hideBtn = button('×', () => this.hidePalette(), 'lw-palette-x');
    hideBtn.title = 'Hide tools (H to toggle)';
    header.appendChild(collapseBtn);
    header.appendChild(hideBtn);
    this.makeDraggable(palette, header);
    palette.appendChild(header);

    // compact tab strip — the top tab bar is hidden in calibrate mode
    const tabRow = el('div', 'lw-palette-tabs');
    for (const t of TABS) {
      const b = el('button', 'lw-tab', t);
      b.addEventListener('click', () => this.setTab(t));
      tabRow.appendChild(b);
      this.paletteTabButtons.set(t, b);
    }
    palette.appendChild(tabRow);

    this.regionStripPalette = el('div', 'lw-palette-tabs');
    palette.appendChild(this.regionStripPalette);

    this.toolcol = el('div', 'lw-toolcol');
    palette.appendChild(this.toolcol);
    return palette;
  }

  /** Pointer-drag `handle` to reposition `elm` (clamped to the window). */
  private makeDraggable(elm: HTMLElement, handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return; // header buttons
      if (!this.calibrateMode) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const rect = elm.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const move = (ev: PointerEvent) => {
        const x = Math.min(window.innerWidth - 40, Math.max(0, ev.clientX - offX));
        const y = Math.min(window.innerHeight - 24, Math.max(0, ev.clientY - offY));
        this.palettePos = { x, y };
        elm.style.left = `${x}px`;
        elm.style.top = `${y}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private applyPalettePos(): void {
    if (this.calibrateMode && this.palettePos) {
      this.palette.style.left = `${this.palettePos.x}px`;
      this.palette.style.top = `${this.palettePos.y}px`;
    } else {
      this.palette.style.left = '';
      this.palette.style.top = '';
    }
  }

  private setPaletteCollapsed(on: boolean): void {
    this.paletteCollapsed = on;
    this.palette.classList.toggle('collapsed', on);
  }

  hidePalette(): void {
    this.paletteHidden = true;
    document.body.classList.add('palette-hidden');
  }

  showPalette(): void {
    this.paletteHidden = false;
    document.body.classList.remove('palette-hidden');
  }

  togglePalette(): void {
    this.paletteHidden ? this.showPalette() : this.hidePalette();
  }

  // ============================== layout ==============================

  viewSize(): { cw: number; ch: number } {
    return { cw: this.cssW, ch: this.cssH };
  }

  private layoutViewport(): void {
    const vw = this.viewportEl.clientWidth;
    const vh = this.viewportEl.clientHeight;
    if (vw === 0 || vh === 0) return;
    let w: number;
    let h: number;
    let x: number;
    let y: number;
    if (this.outputMode || this.calibrateMode) {
      // bare projector feed / live calibration: fill the window edge to edge
      // so the warped frame maps 1:1 to the mosaic raster. (Set output
      // resolution to the mosaic's native res to keep the pattern square.)
      w = vw;
      h = vh;
      x = 0;
      y = 0;
    } else {
      const margin = 14;
      const aspect = this.project.outputW / this.project.outputH;
      w = vw - margin * 2;
      h = w / aspect;
      if (h > vh - margin * 2) {
        h = vh - margin * 2;
        w = h * aspect;
      }
      x = (vw - w) / 2;
      y = (vh - h) / 2;
    }
    this.cssW = w;
    this.cssH = h;
    Object.assign(this.vpStack.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
    const dpr = window.devicePixelRatio || 1;
    this.glCanvas.width = Math.max(1, Math.round(w * dpr));
    this.glCanvas.height = Math.max(1, Math.round(h * dpr));
    this.overlayCanvas.width = this.glCanvas.width;
    this.overlayCanvas.height = this.glCanvas.height;
    this.requestRender();
  }

  // ============================== rendering ==============================

  requestRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.renderFrame();
    });
  }

  private regionUniforms(r: RegionState): RegionDrawUniforms {
    const p = this.project;
    return {
      src: [r.src.x, r.src.y, r.src.w, r.src.h],
      srcPx: [r.src.w * p.outputW, r.src.h * p.outputH],
      blendWidths: [r.blend.left.width, r.blend.right.width, r.blend.top.width, r.blend.bottom.width],
      blendGammas: [r.blend.left.gamma, r.blend.right.gamma, r.blend.top.gamma, r.blend.bottom.gamma],
      lift: r.blackLevel,
    };
  }

  private renderFrame(): void {
    const p = this.project;
    if (this.patternDirty) {
      this.patternDirty = false;
      this.renderer.setPattern(generatePattern(p, this.stills));
    }
    this.renderer.setRegionCount(p.regions.length);
    if (this.dirtyRegions === 'all') {
      p.regions.forEach((r, i) => this.renderer.setRegionMesh(i, buildRegionMesh(r, regionAspect(p, r), FULL_TESS, true)));
    } else {
      for (const i of this.dirtyRegions) {
        const r = p.regions[i];
        if (r) this.renderer.setRegionMesh(i, buildRegionMesh(r, regionAspect(p, r), this.currentTess, true));
      }
    }
    this.dirtyRegions = new Set();
    this.renderer.draw(
      p.regions.map((r) => this.regionUniforms(r)),
      p.overlays.wireframe && !this.outputMode,
    );
    if (!this.outputMode) {
      drawOverlay(this.overlayCtx, p, {
        cw: this.cssW,
        ch: this.cssH,
        dpr: window.devicePixelRatio || 1,
        selection: this.selection,
        hoverId: this.hoverId,
        rubber: this.rubber,
        activeLayer: this.activeLayer(),
      });
    }
  }

  overlayDirty(): void {
    this.requestRender();
  }

  private markActiveDirty(): void {
    if (this.dirtyRegions !== 'all') this.dirtyRegions.add(this.project.activeRegion);
  }

  // ============================== editing & undo ==============================

  private snapshot(): string {
    return serializeProject(this.project);
  }

  beginGesture(): void {
    this.undoStack.push(this.snapshot());
    this.nudgeRunUntil = 0; // any other edit ends the current nudge run
  }

  /**
   * Undo snapshot for arrow-key nudging. A burst of key repeats is ONE
   * gesture — otherwise holding an arrow buries the stack under hundreds
   * of 4 px steps and undo becomes useless.
   */
  private beginNudgeGesture(): void {
    const now = performance.now();
    const key = `${this.project.activeRegion}|${Array.from(this.selection).sort().join(',')}`;
    if (now < this.nudgeRunUntil && key === this.nudgeRunKey) {
      this.nudgeRunUntil = now + NUDGE_COALESCE_MS;
      return;
    }
    this.undoStack.push(this.snapshot());
    this.nudgeRunKey = key;
    this.nudgeRunUntil = now + NUDGE_COALESCE_MS;
  }

  endGesture(): void {
    this.currentTess = FULL_TESS;
    this.markActiveDirty();
    autosave(this.project);
    this.requestRender();
    this.updateInfo();
  }

  warpEdited(interactive: boolean): void {
    this.currentTess = interactive ? DRAG_TESS : FULL_TESS;
    this.markActiveDirty();
    this.requestRender();
    this.updateInfo();
  }

  applyEdit(opts: EditOpts = {}): void {
    if (opts.warp) this.markActiveDirty();
    if (opts.pattern) this.patternDirty = true;
    this.currentTess = FULL_TESS;
    autosave(this.project);
    if (opts.structural) this.rebuildPanel();
    this.requestRender();
    this.updateInfo();
  }

  /** Undoable edit: snapshot, mutate, apply. */
  edit(fn: () => void, opts: EditOpts = {}): void {
    this.beginGesture();
    fn();
    this.applyEdit(opts);
  }

  private restoreSnapshot(json: string): void {
    this.project = deserializeProject(json);
    this.pruneSelection();
    this.dirtyRegions = 'all';
    this.patternDirty = true;
    this.currentTess = FULL_TESS;
    autosave(this.project);
    this.refreshRegionStrips();
    this.rebuildPanel();
    this.layoutViewport();
    this.requestRender();
    this.updateInfo();
  }

  /** Replace the whole project from serialized JSON (remote bridge); undoable. */
  applyProjectJson(json: string): void {
    this.beginGesture();
    this.restoreSnapshot(json);
  }

  undo(): void {
    const s = this.undoStack.undo(this.snapshot());
    if (s !== null) this.restoreSnapshot(s);
  }

  redo(): void {
    const s = this.undoStack.redo(this.snapshot());
    if (s !== null) this.restoreSnapshot(s);
  }

  private pruneSelection(): void {
    const r = this.region;
    for (const id of Array.from(this.selection)) {
      const parts = id.split(':');
      const valid =
        parts[0] === 'b'
          ? +parts[1] < r.bezier.cols && +parts[2] < r.bezier.rows
          : parts[0] === 'h'
            ? +parts[1] < 4 && r.homography.enabled
            : +parts[1] < r.fence.posts.length;
      if (!valid) this.selection.delete(id);
    }
  }

  selectionChanged(): void {
    if (this.currentTab === 'FENCE') this.rebuildPanel();
    this.requestRender();
    this.updateInfo();
  }

  // ============================== info bar ==============================

  setCursorInfo(text: string): void {
    this.info.cursor.textContent = text;
  }

  updateInfo(): void {
    const p = this.project;
    const r = this.region;
    let selText = `sel ${this.selection.size}`;
    if (this.selection.size === 1) {
      const id = this.selection.values().next().value as string;
      const v = readHandleValue(r, regionAspect(p, r), id);
      if (v) {
        const rw = r.rect.w * p.outputW;
        const rh = r.rect.h * p.outputH;
        if (id.startsWith('b:') || id.startsWith('h:')) {
          selText = `sel ${id} @ ${(v.x * rw).toFixed(2)}, ${(v.y * rh).toFixed(2)} px`;
        } else if (id.startsWith('fp:')) {
          selText = `sel post ${id.slice(3)} @ x ${(v.x * rw).toFixed(2)} px`;
        } else {
          selText = `sel ${id} @ y ${(v.y * rh).toFixed(2)} px`;
        }
      }
    }
    this.info.sel.textContent = selText;
    this.info.step.textContent = 'step 4px / shift 0.25px';
    const regionInfo =
      p.regions.length > 1 ? `R${p.activeRegion + 1}/${p.regions.length} ${r.id} | ` : '';
    this.info.density.textContent = `${regionInfo}grid ${r.bezier.cols}×${r.bezier.rows} | posts ${r.fence.posts.length}`;
    // 1:1 check. In calibrate mode the canvas is meant to map one
    // framebuffer pixel to one projector pixel; if it doesn't, the image
    // on the wall is resampled and any camera calibration made at a
    // different window geometry no longer lines up. Say so loudly rather
    // than letting someone calibrate against a scaled view.
    const dpr = window.devicePixelRatio || 1;
    const devW = Math.round(this.cssW * dpr);
    const devH = Math.round(this.cssH * dpr);
    const off = Math.abs(devW - p.outputW) > 1 || Math.abs(devH - p.outputH) > 1;
    this.info.pattern.textContent =
      `${patternLabel(p, this.stills)} | ${p.outputW}×${p.outputH}` +
      (this.calibrateMode && off ? `  ⚠ NOT 1:1 — showing ${devW}×${devH}` : '');
    this.info.pattern.classList.toggle('warn', this.calibrateMode && off);
  }

  // ============================== tabs & panels ==============================

  /** WARP tab edits the bezier layer, FENCE the fence, MODEL the homography corners. */
  activeLayer(): Layer | null {
    return this.currentTab === 'WARP'
      ? 'bezier'
      : this.currentTab === 'FENCE'
        ? 'fence'
        : this.currentTab === 'MODEL'
          ? 'homo'
          : null;
  }

  private setTab(t: TabId): void {
    this.currentTab = t;
    for (const [id, b] of this.tabButtons) b.classList.toggle('active', id === t);
    for (const [id, b] of this.paletteTabButtons) b.classList.toggle('active', id === t);
    // Entering an editing tab always shows that layer's overlay — you can't
    // edit what you can't see.
    if (t === 'WARP' && !this.project.overlays.bezier) this.project.overlays.bezier = true;
    if (t === 'FENCE' && !this.project.overlays.fence) this.project.overlays.fence = true;
    autosave(this.project);
    this.rebuildPanel();
    this.requestRender();
  }

  private rebuildPanel(): void {
    this.toolcol.replaceChildren(renderPanel(this, this.currentTab));
  }

  // ============================== keyboard ==============================

  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (modalOpen()) return; // a dialog owns the keyboard

    if (e.key === 'Tab') {
      e.preventDefault();
      this.setOutputMode(!this.outputMode);
      return;
    }
    if (e.key === 'Escape') {
      if (this.helpEl) this.toggleHelp();
      else if (this.selection.size) {
        this.selection.clear();
        this.selectionChanged();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Arrows walk the selection to the neighbouring control point,
      // so a whole calibration pass can be done without the mouse.
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        this.walkSelection(
          e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0,
          e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0,
        );
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      } else if (k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (k === 's') {
        e.preventDefault();
        this.saveProject();
      } else if (k === 'e') {
        e.preventDefault();
        void this.exportMpcdi(false);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (e.altKey) this.walkSelection(dx, dy);
        else this.nudgeSelection(dx, dy, e.shiftKey);
        return;
      }
      case 'PageUp':
        e.preventDefault();
        this.cyclePattern(-1);
        return;
      case 'PageDown':
        e.preventDefault();
        this.cyclePattern(1);
        return;
      case 'Delete':
      case 'Backspace':
        this.removeSelectedPost();
        return;
      case ',':
        this.cycleRegion(-1);
        return;
      case '.':
        this.cycleRegion(1);
        return;
      case '?':
        this.toggleHelp();
        return;
    }
    switch (e.key.toLowerCase()) {
      case 'f':
        this.toggleFullscreen();
        return;
      case 'b':
        this.toggleOverlay('bezier');
        return;
      case 'g':
        this.toggleOverlay('fence');
        return;
      case 'w':
        this.toggleOverlay('wireframe');
        return;
      case 'c':
        this.toggleCorner();
        return;
      case 'h':
        // hide/show the floating palette (calibrate mode)
        if (this.calibrateMode) this.togglePalette();
        return;
    }
    if (e.key >= '1' && e.key <= '7') {
      const ids: PatternId[] = ['grid', 'crosshatch', 'smpte', 'polar', 'solid', 'convergence', 'custom'];
      const id = ids[+e.key - 1];
      if (id === 'solid' && this.project.pattern.id === 'solid') {
        // repeated presses of 5 cycle white -> gray -> black
        const order = ['white', 'gray', 'black'] as const;
        const next = order[(order.indexOf(this.project.pattern.solid) + 1) % 3];
        this.edit(
          () => {
            this.project.pattern.solid = next;
          },
          { pattern: true, structural: true },
        );
      } else {
        this.setPattern(id);
      }
    }
  };

  /**
   * Move the selection to the neighbouring control point (Ctrl/Alt+Arrows).
   * With nothing selected this seeds a selection rather than doing nothing,
   * so the keyboard alone can start an editing session.
   */
  walkSelection(dx: number, dy: number): void {
    const r = this.region;
    const bez = r.bezier;
    const cur = Array.from(this.selection).find((s) => s.startsWith('b:'));
    if (!cur) {
      const post = this.selectedPostIndex();
      if (post !== null && dx !== 0) {
        this.selectPost(dx);
        return;
      }
      // seed at the nearest corner in the direction pressed
      const i = dx > 0 ? bez.cols - 1 : 0;
      const j = dy > 0 ? bez.rows - 1 : 0;
      this.selection.clear();
      this.selection.add(`b:${i}:${j}`);
      this.selectionChanged();
      this.setCursorInfo(`selected point ${i},${j}`);
      return;
    }
    const parts = cur.split(':');
    const i = Math.min(bez.cols - 1, Math.max(0, +parts[1] + dx));
    const j = Math.min(bez.rows - 1, Math.max(0, +parts[2] + dy));
    this.selection.clear();
    this.selection.add(`b:${i}:${j}`);
    this.selectionChanged();
    this.setCursorInfo(`point ${i},${j} of ${bez.cols - 1},${bez.rows - 1}`);
  }

  /** dx/dy in {-1,0,1}; fine = 0.25 px steps, coarse = 4 px (projector px). */
  private nudgeSelection(dx: number, dy: number, fine: boolean): void {
    if (this.selection.size === 0) {
      // Used to be a silent no-op, which reads as "the arrow keys are
      // broken" — especially in a mosaic, where switching regions or
      // missing a handle clears the selection invisibly.
      this.setCursorInfo('nothing selected — click a point, or Ctrl+Arrows to pick one');
      return;
    }
    const px = fine ? 0.25 : 4;
    const r = this.region;
    // region-local normalized units so a "px" is a pixel of THIS projector
    const dxN = (dx * px) / (this.project.outputW * r.rect.w);
    const dyN = (dy * px) / (this.project.outputH * r.rect.h);
    this.beginNudgeGesture();
    for (const id of this.selection) {
      const parts = id.split(':');
      if (parts[0] === 'b') {
        const k = (+parts[2] * r.bezier.cols + +parts[1]) * 2;
        r.bezier.points[k] += dxN;
        r.bezier.points[k + 1] += dyN;
      } else if (parts[0] === 'ft') {
        const post = r.fence.posts[+parts[1]];
        if (post) post.top += dyN;
      } else if (parts[0] === 'fb') {
        const post = r.fence.posts[+parts[1]];
        if (post) post.bottom += dyN;
      } else if (parts[0] === 'h') {
        const a = regionAspect(this.project, r);
        const v = readHandleValue(r, a, id);
        if (v) writeHandleValue(r, a, id, v, dxN, dyN);
      } else if (parts[0] === 'fp') {
        const i = +parts[1];
        if (dxN !== 0) r.fence = setPostX(r.fence, i, r.fence.posts[i].x + dxN);
        if (dyN !== 0) {
          // up/down on a selected post shifts the whole board edge: both its
          // top and bottom edge points move together
          r.fence.posts[i].top += dyN;
          r.fence.posts[i].bottom += dyN;
        }
      }
    }
    this.applyEdit({ warp: true });
  }

  // ============================== modes ==============================

  setOutputMode(on: boolean): void {
    this.outputMode = on;
    document.body.classList.toggle('output-mode', on);
    this.layoutViewport();
  }

  /** Full-bleed live-editing mode with the tool column floating as a palette. */
  setCalibrateMode(on: boolean): void {
    if (this.calibrateMode === on) return;
    this.calibrateMode = on;
    document.body.classList.toggle('calibrate-mode', on);
    if (on) {
      // first entry: seat the palette in the top-left, expanded and visible
      if (!this.palettePos) this.palettePos = { x: 12, y: 12 };
      this.showPalette();
      this.setPaletteCollapsed(false);
    }
    this.applyPalettePos();
    this.layoutViewport();
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }

  toggleHelp(): void {
    if (this.helpEl) {
      this.helpEl.remove();
      this.helpEl = null;
    } else {
      this.helpEl = buildHelpOverlay(() => this.toggleHelp());
      document.body.appendChild(this.helpEl);
    }
  }

  toggleOverlay(key: 'bezier' | 'fence' | 'wireframe'): void {
    // view-only toggle: not undoable, but persisted
    this.project.overlays[key] = !this.project.overlays[key];
    autosave(this.project);
    if (this.currentTab === 'WARP') this.rebuildPanel();
    this.requestRender();
  }

  // ============================== patterns & stills ==============================

  setPattern(id: PatternId): void {
    this.edit(
      () => {
        this.project.pattern.id = id;
      },
      { pattern: true, structural: true },
    );
  }

  cyclePattern(dir: number): void {
    type Entry = { id: PatternId; solid?: 'white' | 'gray' | 'black'; still?: number };
    const list: Entry[] = [...PATTERN_CYCLE, ...this.stills.map((_, i) => ({ id: 'custom' as PatternId, still: i }))];
    const p = this.project.pattern;
    let cur = list.findIndex(
      (e) =>
        e.id === p.id &&
        (e.id !== 'solid' || e.solid === p.solid) &&
        (e.id !== 'custom' || e.still === p.customIndex),
    );
    if (cur < 0) cur = 0;
    const next = list[(cur + dir + list.length) % list.length];
    this.edit(
      () => {
        this.project.pattern.id = next.id;
        if (next.solid) this.project.pattern.solid = next.solid;
        if (next.still !== undefined) this.project.pattern.customIndex = next.still;
      },
      { pattern: true, structural: true },
    );
  }

  pickStillFiles(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.multiple = true;
    input.onchange = () => {
      if (input.files?.length) void this.addStillFiles(Array.from(input.files));
    };
    input.click();
  }

  async addStillFiles(files: File[]): Promise<void> {
    let added = false;
    for (const f of files) {
      if (!/^image\/(png|jpeg)$/.test(f.type)) continue;
      try {
        const source = await createImageBitmap(f);
        this.stills.push({ name: f.name, source, url: URL.createObjectURL(f) });
        added = true;
      } catch {
        /* unreadable image — skip */
      }
    }
    if (added) {
      this.edit(
        () => {
          this.project.pattern.id = 'custom';
          this.project.pattern.customIndex = this.stills.length - 1;
        },
        { pattern: true, structural: true },
      );
    }
  }

  selectStill(i: number): void {
    this.edit(
      () => {
        this.project.pattern.id = 'custom';
        this.project.pattern.customIndex = i;
      },
      { pattern: true, structural: true },
    );
  }

  removeStill(i: number): void {
    const s = this.stills.splice(i, 1)[0];
    if (s) URL.revokeObjectURL(s.url);
    this.edit(
      () => {
        const p = this.project.pattern;
        if (p.customIndex >= this.stills.length) p.customIndex = Math.max(0, this.stills.length - 1);
        if (this.stills.length === 0 && p.id === 'custom') p.id = 'grid';
      },
      { pattern: true, structural: true },
    );
  }

  // ============================== warp ops (active region) ==============================

  async setDensity(n: number): Promise<void> {
    const d = Math.min(17, Math.max(2, Math.round(n)));
    const label = d === 2 ? '2 × 2 (bilinear corner-pin)' : `${d} × ${d}`;
    if (!(await confirmModal(`Reset bezier grid to ${label}? Current bezier warp will be lost.`, 'GRID DENSITY')))
      return;
    this.edit(
      () => {
        this.region.bezier = createBezierGrid(d, d);
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  /** Subdivide the band at the selected bezier point (knot insertion). */
  async subdivide(direction: 'col' | 'row'): Promise<void> {
    const sel = Array.from(this.selection).filter((s) => s.startsWith('b:'));
    if (sel.length === 0) {
      await alertModal(
        'Select a bezier control point first — the band after it gets subdivided.',
        'NO SELECTION',
      );
      return;
    }
    const parts = sel[0].split(':');
    const i = +parts[1];
    const j = +parts[2];
    const bez = this.region.bezier;
    const next =
      direction === 'col'
        ? subdivideAfterColumn(bez, Math.min(i, bez.cols - 2))
        : subdivideAfterRow(bez, Math.min(j, bez.rows - 2));
    if (!next) return;
    this.edit(
      () => {
        this.region.bezier = next;
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  /** Cycle post selection from the panel (no precise clicking needed). */
  selectPost(dir: number): void {
    const n = this.region.fence.posts.length;
    const cur = this.selectedPostIndex();
    const next = cur === null ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
    this.selection.clear();
    this.selection.add(`fp:${next}`);
    this.selectionChanged();
  }

  selectedPostIndex(): number | null {
    for (const id of this.selection) {
      const m = id.match(/^f[tbp]:(\d+)$/);
      if (m) return +m[1];
    }
    return null;
  }

  addFencePost(): void {
    this.edit(
      () => {
        this.region.fence = addPost(this.region.fence, widestGapMid(this.region.fence));
      },
      { warp: true, structural: true },
    );
  }

  removeSelectedPost(): void {
    const i = this.selectedPostIndex();
    if (i === null) return;
    if (i === 0 || i === this.region.fence.posts.length - 1) return; // boundaries
    this.edit(
      () => {
        this.region.fence = removePost(this.region.fence, i);
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  toggleCorner(): void {
    const i = this.selectedPostIndex();
    if (i === null) return;
    this.edit(
      () => {
        const post = this.region.fence.posts[i];
        post.corner = !post.corner;
      },
      { warp: true, structural: true },
    );
  }

  movePostTo(i: number, x: number): void {
    this.region.fence = setPostX(this.region.fence, i, x);
  }

  async resetBezier(): Promise<void> {
    if (!(await confirmModal('Reset bezier warp to identity (active region)?', 'RESET BEZIER'))) return;
    this.edit(
      () => {
        this.region.bezier = createBezierGrid(this.region.bezier.cols, this.region.bezier.rows);
      },
      { warp: true, structural: true },
    );
  }

  // ---- model layers (MODEL tab) ----

  toggleLayer(layer: 'homography' | 'cylinder' | 'residual'): void {
    this.edit(
      () => {
        const r = this.region;
        if (layer === 'residual') r.residualEnabled = !r.residualEnabled;
        else r[layer].enabled = !r[layer].enabled;
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  async resetHomography(): Promise<void> {
    if (!(await confirmModal('Reset homography corners to identity (active region)?', 'RESET HOMOGRAPHY'))) return;
    this.edit(
      () => {
        this.region.homography = { ...defaultHomography(), enabled: this.region.homography.enabled };
      },
      { warp: true, structural: true },
    );
  }

  async resetCylinder(): Promise<void> {
    if (!(await confirmModal('Reset cylinder / projector parameters (active region)?', 'RESET CYLINDER'))) return;
    this.edit(
      () => {
        this.region.cylinder = { ...defaultCylinder(), enabled: this.region.cylinder.enabled };
      },
      { warp: true, structural: true },
    );
  }

  /** Legacy single-lattice warp → homography + residual; picture stays put. Undoable. */
  upgradeToHomography(): void {
    this.edit(
      () => {
        upgradeToHomography(this.region);
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  smoothBezier(iterations: number): void {
    this.edit(
      () => {
        this.region.bezier = laplacianSmooth(this.region.bezier, iterations);
      },
      { warp: true },
    );
  }

  refitBezier(): void {
    this.edit(
      () => {
        this.region.bezier = refitPatch(this.region.bezier);
      },
      { warp: true },
    );
  }

  async resetFence(): Promise<void> {
    if (!(await confirmModal('Reset fence (active region)?', 'RESET FENCE'))) return;
    this.edit(
      () => {
        this.region.fence = createFence();
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  async resetAll(): Promise<void> {
    if (!(await confirmModal('Reset EVERYTHING to defaults?', 'RESET ALL'))) return;
    this.edit(
      () => {
        const keep = { w: this.project.outputW, h: this.project.outputH };
        this.project = { ...defaultProject(), outputW: keep.w, outputH: keep.h };
        this.selection.clear();
      },
      { warp: true, pattern: true, structural: true },
    );
    this.dirtyRegions = 'all';
    this.refreshRegionStrips();
    this.layoutViewport();
  }

  setResolution(w: number, h: number, gestureAlreadyPushed = false): void {
    const apply = () => {
      this.project.outputW = Math.min(16384, Math.max(64, Math.round(w)));
      this.project.outputH = Math.min(8192, Math.max(64, Math.round(h)));
    };
    if (gestureAlreadyPushed) {
      apply();
      this.applyEdit({ pattern: true, structural: true });
    } else {
      this.edit(apply, { pattern: true, structural: true });
    }
    this.layoutViewport();
  }

  // ============================== project I/O ==============================

  saveProject(): void {
    saveProjectFile(this.project);
  }

  loadProjectFile(): void {
    openProjectFile(
      (p) => {
        this.beginGesture();
        this.project = p;
        this.selection.clear();
        this.dirtyRegions = 'all';
        this.refreshRegionStrips();
        this.applyEdit({ warp: true, pattern: true, structural: true });
        this.layoutViewport();
      },
      (msg) => void alertModal(`Could not load project: ${msg}`, 'LOAD FAILED'),
    );
  }

  // ============================== MPCDI export ==============================

  /** Build all export artifacts in memory (also used by automated tests). */
  buildExportArtifacts(): {
    xml: string;
    files: Record<string, Uint8Array>;
    archive: Uint8Array;
  } {
    const p = this.project;
    const files: Record<string, Uint8Array> = {};
    const entries: MpcdiRegionEntry[] = [];
    for (const r of p.regions) {
      const wPx = Math.max(1, Math.round(r.rect.w * p.outputW));
      const hPx = Math.max(1, Math.round(r.rect.h * p.outputH));
      // High-density sampling mesh, region-local positions for the FBO pass.
      const mesh = buildRegionMesh(r, regionAspect(p, r), 256, false);
      const uv = this.renderer.renderUVMap(mesh, [r.src.x, r.src.y, r.src.w, r.src.h], wPx, hPx);
      const fn = safeFileName(r.id);
      const warpPath = `warp_${fn}.pfm`;
      files[warpPath] = encodePFM(wPx, hPx, uv);
      let alphaPath: string | null = null;
      let betaPath: string | null = null;
      if (hasBlend(r)) {
        alphaPath = `alpha_${fn}.png`;
        files[alphaPath] = encodeGrayPNG(wPx, hPx, bakeAlphaMap(r, p, uv, wPx, hPx));
      }
      if (r.blackLevel > 0) {
        betaPath = `beta_${fn}.png`;
        files[betaPath] = encodeGrayPNG(wPx, hPx, bakeBetaMap(r, wPx, hPx));
      }
      entries.push({
        id: r.id,
        x: r.rect.x,
        y: r.rect.y,
        xsize: r.rect.w,
        ysize: r.rect.h,
        resW: wPx,
        resH: hPx,
        warpPath,
        alphaPath,
        betaPath,
      });
    }
    const xml = buildMpcdiXml({
      name: p.name,
      width: p.outputW,
      height: p.outputH,
      date: new Date().toISOString(),
      regions: entries,
    });
    const archive = buildArchive(xml, files);
    return { xml, files, archive };
  }

  async exportMpcdi(raw: boolean): Promise<void> {
    try {
      const { archive } = this.buildExportArtifacts();
      const base = this.project.name || 'fencepost';
      if (raw) downloadBytes(archive, `${base}-raw.zip`, 'application/zip');
      else downloadBytes(archive, `${base}.mpcdi`, 'application/zip');
    } catch (e) {
      await alertModal(`Export failed: ${e instanceof Error ? e.message : e}`, 'EXPORT FAILED');
    }
  }
}
