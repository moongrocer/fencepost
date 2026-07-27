/**
 * FENCEPOST application orchestrator: owns the project state, undo stack,
 * GL renderer, overlay, panels, keyboard map, and the export pipeline.
 */
import { bakeAlphaMap, bakeBetaMap, hasBlend } from './render/blend';
import { GLRenderer } from './render/gl';
import { generatePattern, patternLabel, Still } from './render/patterns';
import { buildMpcdiXml } from './export/mpcdi-xml';
import { encodePFM } from './export/pfm';
import { encodeGrayPNG } from './export/png';
import { buildArchive, downloadBytes } from './export/zip';
import { autosave, loadAutosave, openProjectFile, saveProjectFile } from './state/persist';
import {
  defaultProject,
  deserializeProject,
  PatternId,
  ProjectState,
  serializeProject,
} from './state/project';
import { UndoStack } from './state/undo';
import { createBezierGrid, subdivideAfterColumn, subdivideAfterRow } from './warp/bezier';
import { buildWarpMesh } from './warp/compose';
import { addPost, createFence, removePost, setPostX, widestGapMid } from './warp/fence';
import { button, el } from './ui/dom';
import { buildHelpOverlay } from './ui/help';
import { EditorHost, InteractionController, readHandleValue } from './ui/interaction';
import { drawOverlay } from './ui/overlay';
import { renderPanel, TabId, TABS } from './ui/panels';

export interface EditOpts {
  warp?: boolean;
  pattern?: boolean;
  /** structural changes rebuild the tool panel (button active states etc.) */
  structural?: boolean;
}

const FULL_TESS = 128;
const DRAG_TESS = 64;
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
   * draggable, collapsible palette so it can be shoved off the area being
   * warped. Auto-engaged on fullscreen (the on-projector working state).
   */
  private calibrateMode = false;
  private palette!: HTMLElement;
  private paletteTabButtons = new Map<TabId, HTMLButtonElement>();
  private restoreChip!: HTMLButtonElement;
  private paletteCollapsed = false;
  private paletteHidden = false;
  private palettePos: { x: number; y: number } | null = null;
  private meshDirty = true;
  private patternDirty = true;
  private currentTess = FULL_TESS;
  private rafPending = false;
  private cssW = 0;
  private cssH = 0;

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

    this.setTab('PATTERNS');
    this.layoutViewport();
    this.updateInfo();
    this.requestRender();
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
      // so the warped frame maps 1:1 to the projector raster. (Set output
      // resolution to the projector's native res to keep the pattern square.)
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

  private renderFrame(): void {
    if (this.patternDirty) {
      this.patternDirty = false;
      this.renderer.setPattern(generatePattern(this.project, this.stills));
    }
    if (this.meshDirty) {
      this.meshDirty = false;
      this.renderer.setMesh(buildWarpMesh(this.project.bezier, this.project.fence, this.currentTess));
    }
    const b = this.project.blend;
    this.renderer.draw(
      {
        blendWidths: [b.left.width, b.right.width, b.top.width, b.bottom.width],
        blendGammas: [b.left.gamma, b.right.gamma, b.top.gamma, b.bottom.gamma],
        lift: this.project.blackLevel,
        outputW: this.project.outputW,
        outputH: this.project.outputH,
      },
      this.project.overlays.wireframe && !this.outputMode,
    );
    if (!this.outputMode) {
      drawOverlay(this.overlayCtx, this.project, {
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

  // ============================== editing & undo ==============================

  private snapshot(): string {
    return serializeProject(this.project);
  }

  beginGesture(): void {
    this.undoStack.push(this.snapshot());
  }

  endGesture(): void {
    this.currentTess = FULL_TESS;
    this.meshDirty = true;
    autosave(this.project);
    this.requestRender();
    this.updateInfo();
  }

  warpEdited(interactive: boolean): void {
    this.currentTess = interactive ? DRAG_TESS : FULL_TESS;
    this.meshDirty = true;
    this.requestRender();
    this.updateInfo();
  }

  applyEdit(opts: EditOpts = {}): void {
    if (opts.warp) this.meshDirty = true;
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
    this.meshDirty = true;
    this.patternDirty = true;
    this.currentTess = FULL_TESS;
    autosave(this.project);
    this.rebuildPanel();
    this.layoutViewport();
    this.requestRender();
    this.updateInfo();
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
    const p = this.project;
    for (const id of Array.from(this.selection)) {
      const parts = id.split(':');
      const valid =
        parts[0] === 'b'
          ? +parts[1] < p.bezier.cols && +parts[2] < p.bezier.rows
          : +parts[1] < p.fence.posts.length;
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
    let selText = `sel ${this.selection.size}`;
    if (this.selection.size === 1) {
      const id = this.selection.values().next().value as string;
      const v = readHandleValue(p, id);
      if (v) {
        if (id.startsWith('b:')) {
          selText = `sel ${id} @ ${(v.x * p.outputW).toFixed(2)}, ${(v.y * p.outputH).toFixed(2)} px`;
        } else if (id.startsWith('fp:')) {
          selText = `sel post ${id.slice(3)} @ x ${(v.x * p.outputW).toFixed(2)} px`;
        } else {
          selText = `sel ${id} @ y ${(v.y * p.outputH).toFixed(2)} px`;
        }
      }
    }
    this.info.sel.textContent = selText;
    this.info.step.textContent = 'step 4px / shift 0.25px';
    this.info.density.textContent = `grid ${p.bezier.cols}×${p.bezier.rows} | posts ${p.fence.posts.length}`;
    this.info.pattern.textContent = `${patternLabel(p, this.stills)} | ${p.outputW}×${p.outputH}`;
  }

  // ============================== tabs & panels ==============================

  /** WARP tab edits the bezier layer, FENCE tab the fence layer. */
  activeLayer(): 'bezier' | 'fence' | null {
    return this.currentTab === 'WARP' ? 'bezier' : this.currentTab === 'FENCE' ? 'fence' : null;
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
        this.nudgeSelection(dx, dy, e.shiftKey);
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

  /** dx/dy in {-1,0,1}; fine = 0.25 px steps, coarse = 4 px. */
  private nudgeSelection(dx: number, dy: number, fine: boolean): void {
    if (this.selection.size === 0) return;
    const px = fine ? 0.25 : 4;
    const dxN = (dx * px) / this.project.outputW;
    const dyN = (dy * px) / this.project.outputH;
    this.beginGesture();
    const p = this.project;
    for (const id of this.selection) {
      const parts = id.split(':');
      if (parts[0] === 'b') {
        const k = (+parts[2] * p.bezier.cols + +parts[1]) * 2;
        p.bezier.points[k] += dxN;
        p.bezier.points[k + 1] += dyN;
      } else if (parts[0] === 'ft') {
        const post = p.fence.posts[+parts[1]];
        if (post) post.top += dyN;
      } else if (parts[0] === 'fb') {
        const post = p.fence.posts[+parts[1]];
        if (post) post.bottom += dyN;
      } else if (parts[0] === 'fp') {
        const i = +parts[1];
        if (dxN !== 0) p.fence = setPostX(p.fence, i, p.fence.posts[i].x + dxN);
        if (dyN !== 0) {
          // up/down on a selected post shifts the whole board edge: both its
          // top and bottom edge points move together
          p.fence.posts[i].top += dyN;
          p.fence.posts[i].bottom += dyN;
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

  // ============================== warp ops ==============================

  setDensity(n: number): void {
    const d = Math.min(17, Math.max(3, Math.round(n)));
    if (!confirm(`Reset bezier grid to ${d} × ${d}? Current bezier warp will be lost.`)) return;
    this.edit(
      () => {
        this.project.bezier = createBezierGrid(d, d);
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  /** Subdivide the band at the selected bezier point (knot insertion). */
  subdivide(direction: 'col' | 'row'): void {
    const sel = Array.from(this.selection).filter((s) => s.startsWith('b:'));
    if (sel.length === 0) {
      alert('Select a bezier control point first — the band after it gets subdivided.');
      return;
    }
    const parts = sel[0].split(':');
    const i = +parts[1];
    const j = +parts[2];
    const next =
      direction === 'col'
        ? subdivideAfterColumn(this.project.bezier, Math.min(i, this.project.bezier.cols - 2))
        : subdivideAfterRow(this.project.bezier, Math.min(j, this.project.bezier.rows - 2));
    if (!next) return;
    this.edit(
      () => {
        this.project.bezier = next;
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  /** Cycle post selection from the panel (no precise clicking needed). */
  selectPost(dir: number): void {
    const n = this.project.fence.posts.length;
    const cur = this.selectedPostIndex();
    const next = cur === null ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
    this.selection.clear();
    this.selection.add(`fp:${next}`);
    this.selectionChanged();
  }

  selectedPostIndex(): number | null {
    for (const id of this.selection) {
      const m = id.match(/^f[tbp]:(\d+)$/) ?? id.match(/^fp:(\d+)$/);
      if (m) return +m[1];
    }
    return null;
  }

  addFencePost(): void {
    this.edit(
      () => {
        this.project.fence = addPost(this.project.fence, widestGapMid(this.project.fence));
      },
      { warp: true, structural: true },
    );
  }

  removeSelectedPost(): void {
    const i = this.selectedPostIndex();
    if (i === null) return;
    if (i === 0 || i === this.project.fence.posts.length - 1) return; // boundaries
    this.edit(
      () => {
        this.project.fence = removePost(this.project.fence, i);
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
        const post = this.project.fence.posts[i];
        post.corner = !post.corner;
      },
      { warp: true, structural: true },
    );
  }

  movePostTo(i: number, x: number): void {
    this.project.fence = setPostX(this.project.fence, i, x);
  }

  resetBezier(): void {
    if (!confirm('Reset bezier warp to identity?')) return;
    this.edit(
      () => {
        this.project.bezier = createBezierGrid(this.project.bezier.cols, this.project.bezier.rows);
      },
      { warp: true, structural: true },
    );
  }

  resetFence(): void {
    if (!confirm('Reset fence (remove all posts, flatten edges)?')) return;
    this.edit(
      () => {
        this.project.fence = createFence();
        this.selection.clear();
      },
      { warp: true, structural: true },
    );
  }

  resetAll(): void {
    if (!confirm('Reset EVERYTHING to defaults?')) return;
    this.edit(
      () => {
        const keep = { w: this.project.outputW, h: this.project.outputH };
        this.project = { ...defaultProject(), outputW: keep.w, outputH: keep.h };
        this.selection.clear();
      },
      { warp: true, pattern: true, structural: true },
    );
    this.layoutViewport();
  }

  setResolution(w: number, h: number, gestureAlreadyPushed = false): void {
    const apply = () => {
      this.project.outputW = Math.min(8192, Math.max(64, Math.round(w)));
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
        this.applyEdit({ warp: true, pattern: true, structural: true });
        this.layoutViewport();
      },
      (msg) => alert(`Could not load project: ${msg}`),
    );
  }

  // ============================== MPCDI export ==============================

  /** Build all export artifacts in memory (also used by automated tests). */
  buildExportArtifacts(): {
    xml: string;
    pfm: Uint8Array;
    alpha: Uint8Array | null;
    beta: Uint8Array | null;
    archive: Uint8Array;
  } {
    const p = this.project;
    // High-density sampling mesh for export (256 -> 257x257 vertices).
    this.renderer.setMesh(buildWarpMesh(p.bezier, p.fence, 256));
    const uv = this.renderer.renderUVMap(p.outputW, p.outputH);
    this.meshDirty = true; // display mesh needs a rebuild afterwards
    this.requestRender();

    const pfm = encodePFM(p.outputW, p.outputH, uv);
    const alpha = hasBlend(p) ? encodeGrayPNG(p.outputW, p.outputH, bakeAlphaMap(p)) : null;
    const beta = p.blackLevel > 0 ? encodeGrayPNG(p.outputW, p.outputH, bakeBetaMap(p)) : null;
    const xml = buildMpcdiXml({
      name: p.name,
      regionId: p.regionId,
      width: p.outputW,
      height: p.outputH,
      date: new Date().toISOString(),
      hasAlpha: alpha !== null,
      hasBeta: beta !== null,
      warpPath: 'warp.pfm',
      alphaPath: 'alpha.png',
      betaPath: 'beta.png',
    });
    const archive = buildArchive({
      xml,
      pfm,
      alpha: alpha ?? undefined,
      beta: beta ?? undefined,
      warpPath: 'warp.pfm',
      alphaPath: 'alpha.png',
      betaPath: 'beta.png',
    });
    return { xml, pfm, alpha, beta, archive };
  }

  async exportMpcdi(raw: boolean): Promise<void> {
    try {
      const { archive } = this.buildExportArtifacts();
      const base = this.project.name || 'fencepost';
      if (raw) downloadBytes(archive, `${base}-raw.zip`, 'application/zip');
      else downloadBytes(archive, `${base}.mpcdi`, 'application/zip');
    } catch (e) {
      alert(`Export failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
