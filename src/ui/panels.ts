/**
 * The left tool column — LightWave Modeler-style stacks of full-width
 * buttons and mini fields, grouped under etched separators. Content is
 * rebuilt wholesale on tab switch / undo / structural change, which keeps
 * every widget trivially in sync with the project state.
 *
 * WARP / FENCE / BLEND always edit the ACTIVE region.
 */
import type { App } from '../app';
import { PatternId } from '../state/project';
import { button, el, group, miniField, textField } from './dom';

export type TabId = 'PATTERNS' | 'WARP' | 'FENCE' | 'BLEND' | 'EXPORT';
export const TABS: TabId[] = ['PATTERNS', 'WARP', 'FENCE', 'BLEND', 'EXPORT'];

export function renderPanel(app: App, tab: TabId): HTMLElement {
  switch (tab) {
    case 'PATTERNS':
      return patternsPanel(app);
    case 'WARP':
      return warpPanel(app);
    case 'FENCE':
      return fencePanel(app);
    case 'BLEND':
      return blendPanel(app);
    case 'EXPORT':
      return exportPanel(app);
  }
}

function patternsPanel(app: App): HTMLElement {
  const p = app.project;
  const root = el('div');

  const patBtn = (label: string, id: PatternId) => {
    const b = button(label, () => app.setPattern(id));
    if (p.pattern.id === id) b.classList.add('active');
    return b;
  };

  root.appendChild(
    group(
      'Test Pattern',
      patBtn('Square Grid', 'grid'),
      patBtn('Fine Crosshatch', 'crosshatch'),
      patBtn('SMPTE Bars', 'smpte'),
      patBtn('Polar / Dome', 'polar'),
      ...(['white', 'gray', 'black'] as const).map((s) => {
        const b = button(`Solid ${s === 'gray' ? '50% Gray' : s[0].toUpperCase() + s.slice(1)}`, () =>
          app.edit(
            () => {
              app.project.pattern.id = 'solid';
              app.project.pattern.solid = s;
            },
            { pattern: true, structural: true },
          ),
        );
        if (p.pattern.id === 'solid' && p.pattern.solid === s) b.classList.add('active');
        return b;
      }),
      patBtn('Convergence RGB', 'convergence'),
      patBtn('Custom Image', 'custom'),
    ),
  );

  const spacing = miniField({
    label: 'Spacing',
    value: p.pattern.gridSpacing,
    min: 8,
    max: 512,
    step: 4,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => {
      app.project.pattern.gridSpacing = Math.round(v);
      app.applyEdit({ pattern: true });
    },
  });
  const lineW = miniField({
    label: 'Line Width',
    value: p.pattern.gridLineWidth,
    min: 1,
    max: 16,
    step: 1,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => {
      app.project.pattern.gridLineWidth = Math.round(v);
      app.applyEdit({ pattern: true });
    },
  });
  root.appendChild(group('Grid Params', spacing.root, lineW.root));

  const cx = miniField({
    label: 'Center X',
    value: p.pattern.polarCx,
    min: 0,
    max: 1,
    step: 0.005,
    decimals: 3,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => {
      app.project.pattern.polarCx = v;
      app.applyEdit({ pattern: true });
    },
  });
  const cy = miniField({
    label: 'Center Y',
    value: p.pattern.polarCy,
    min: 0,
    max: 1,
    step: 0.005,
    decimals: 3,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => {
      app.project.pattern.polarCy = v;
      app.applyEdit({ pattern: true });
    },
  });
  root.appendChild(group('Polar Center', cx.root, cy.root));

  const thumbs = el('div', 'lw-thumbs');
  app.stills.forEach((s, i) => {
    const t = el('div', 'lw-thumb');
    const img = el('img');
    img.src = s.url;
    img.title = s.name;
    img.draggable = false;
    t.appendChild(img);
    if (p.pattern.id === 'custom' && p.pattern.customIndex === i) t.classList.add('active');
    t.addEventListener('click', () => app.selectStill(i));
    const x = el('div', 'x', '×');
    x.title = 'remove';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      app.removeStill(i);
    });
    t.appendChild(x);
    thumbs.appendChild(t);
  });
  root.appendChild(
    group(
      'Stills',
      button('Load Image…', () => app.pickStillFiles()),
      thumbs,
      el('div', 'lw-note', 'Drag & drop PNG/JPEG anywhere. PgUp/PgDn cycles patterns + stills.'),
    ),
  );
  return root;
}

function warpPanel(app: App): HTMLElement {
  const r = app.region;
  const root = el('div');

  let pendingDensity = Math.max(r.bezier.cols, 3);
  const density = miniField({
    label: 'Density',
    value: pendingDensity,
    min: 3,
    max: 17,
    step: 1,
    onChange: (v) => {
      pendingDensity = Math.round(v);
    },
  });
  root.appendChild(
    group(
      'Grid Density',
      el('div', 'lw-note', `Current: ${r.bezier.cols} × ${r.bezier.rows}`),
      density.root,
      button('Apply Density (resets)', () => app.setDensity(pendingDensity)),
    ),
  );

  root.appendChild(
    group(
      'Local Subdivide',
      button('+ Column @ Selection', () => app.subdivide('col')),
      button('+ Row @ Selection', () => app.subdivide('row')),
      el('div', 'lw-note', 'Exact knot insertion — adds points without moving the surface.'),
    ),
  );

  const ovBtn = (label: string, key: 'bezier' | 'fence' | 'wireframe') => {
    const b = button(label, () => app.toggleOverlay(key));
    if (app.project.overlays[key]) b.classList.add('active');
    return b;
  };
  root.appendChild(
    group(
      'Overlays',
      ovBtn('Bezier Points  [B]', 'bezier'),
      ovBtn('Fence  [G]', 'fence'),
      ovBtn('Mesh Wireframe  [W]', 'wireframe'),
    ),
  );

  root.appendChild(
    group(
      'Reset',
      button('Reset Bezier (region)', () => app.resetBezier()),
      el('div', 'lw-note', 'Nudge: arrows = 4 px, Shift+arrows = 0.25 px (projector px).'),
    ),
  );
  return root;
}

function fencePanel(app: App): HTMLElement {
  const p = app.project;
  const region = app.region;
  const root = el('div');
  const sel = app.selectedPostIndex();
  const post = sel !== null ? region.fence.posts[sel] : null;
  const regionWpx = region.rect.w * p.outputW;
  const regionHpx = region.rect.h * p.outputH;

  const prevNext = el('div', 'lw-row');
  prevNext.appendChild(button('◂ Prev', () => app.selectPost(-1)));
  prevNext.appendChild(button('Next ▸', () => app.selectPost(1)));
  root.appendChild(
    group(
      'Posts',
      button('Add Post', () => app.addFencePost()),
      button('Remove Selected Post', () => app.removeSelectedPost()),
      button(post?.corner ? 'Post: Hard (corner)  [C]' : 'Post: Smooth  [C]', () => app.toggleCorner()),
      prevNext,
      el(
        'div',
        'lw-note',
        sel !== null
          ? `Selected post ${sel} of ${region.fence.posts.length - 1}${sel === 0 || sel === region.fence.posts.length - 1 ? ' (boundary)' : ''}. Up/Down nudges the whole post; drag diamonds for top/bottom.`
          : 'Click a post line / edge diamond, or use Prev/Next.',
      ),
    ),
  );

  if (post && sel !== null) {
    const px = miniField({
      label: 'Post X (px)',
      value: post.x * regionWpx,
      min: 0,
      max: regionWpx,
      step: 1,
      decimals: 2,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.movePostTo(sel, v / regionWpx);
        app.applyEdit({ warp: true });
      },
    });
    const pt = miniField({
      label: 'Top Y (px)',
      value: post.top * regionHpx,
      min: -regionHpx,
      max: regionHpx * 2,
      step: 0.25,
      decimals: 2,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.region.fence.posts[sel].top = v / regionHpx;
        app.applyEdit({ warp: true });
      },
    });
    const pb = miniField({
      label: 'Bottom Y (px)',
      value: post.bottom * regionHpx,
      min: -regionHpx,
      max: regionHpx * 2,
      step: 0.25,
      decimals: 2,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.region.fence.posts[sel].bottom = v / regionHpx;
        app.applyEdit({ warp: true });
      },
    });
    root.appendChild(group('Selected Post', px.root, pt.root, pb.root));
  }

  root.appendChild(
    group(
      'Reset',
      button('Reset Fence (region)', () => app.resetFence()),
      el(
        'div',
        'lw-note',
        'Fence applies before bezier: boards (strips) set coarse columnar geometry, bezier refines on top. Edge points move vertically; posts drag horizontally.',
      ),
    ),
  );
  return root;
}

function blendPanel(app: App): HTMLElement {
  const region = app.region;
  const root = el('div');
  const edges = ['left', 'right', 'top', 'bottom'] as const;
  for (const e of edges) {
    const width = miniField({
      label: 'Width (px)',
      value: region.blend[e].width,
      min: 0,
      max: Math.max(app.project.outputW, app.project.outputH),
      step: 1,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.region.blend[e].width = Math.round(v);
        app.applyEdit({});
      },
    });
    const gamma = miniField({
      label: 'Gamma',
      value: region.blend[e].gamma,
      min: 0.1,
      max: 5,
      step: 0.05,
      decimals: 2,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.region.blend[e].gamma = v;
        app.applyEdit({});
      },
    });
    root.appendChild(group(`${e} edge`, width.root, gamma.root));
  }
  const lift = miniField({
    label: 'Lift',
    value: region.blackLevel,
    min: 0,
    max: 0.5,
    step: 0.005,
    decimals: 3,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => {
      app.region.blackLevel = v;
      app.applyEdit({});
    },
  });
  root.appendChild(
    group(
      'Black Level',
      lift.root,
      el(
        'div',
        'lw-note',
        'Widths are CONTENT pixels from the region’s content-window edge — the ramp rides the warp, so keystoned/curved seams get matching blends. Neighboring regions built by the mosaic tool share ramp widths. Lift exports as the beta map.',
      ),
    ),
  );
  return root;
}

function exportPanel(app: App): HTMLElement {
  const p = app.project;
  const region = app.region;
  const root = el('div');

  // ---- mosaic / regions ----
  let mCols = Math.max(2, p.regions.length);
  let mW = 1200;
  let mH = 1920;
  let mOv = 200;
  const colsF = miniField({ label: 'Columns', value: mCols, min: 2, max: 8, step: 1, onChange: (v) => (mCols = Math.round(v)) });
  const wF = miniField({ label: 'Proj W', value: mW, min: 64, max: 8192, step: 1, onChange: (v) => (mW = Math.round(v)) });
  const hF = miniField({ label: 'Proj H', value: mH, min: 64, max: 8192, step: 1, onChange: (v) => (mH = Math.round(v)) });
  const ovF = miniField({ label: 'Overlap px', value: mOv, min: 0, max: 2000, step: 1, onChange: (v) => (mOv = Math.round(v)) });
  root.appendChild(
    group(
      'Mosaic / Regions',
      el('div', 'lw-note', `Regions: ${p.regions.length} (active R${p.activeRegion + 1} "${region.id}"). , / . switch.`),
      colsF.root,
      wF.root,
      hF.root,
      ovF.root,
      button('Build Column Mosaic', () => app.buildMosaic(mCols, mW, mH, mOv)),
      button('Single Region (reset)', () => app.makeSingleRegion()),
      el(
        'div',
        'lw-note',
        'Butt-joined framebuffer slices (one fullscreen window on a Mosaic/Eyefinity desktop); content windows overlap by the given band and get matching blend ramps.',
      ),
    ),
  );

  root.appendChild(
    group(
      'Metadata',
      textField('Name', p.name, (v) =>
        app.edit(() => {
          app.project.name = v || 'fencepost-project';
        }, {}),
      ),
      textField(`Region ID (R${p.activeRegion + 1})`, region.id, (v) => app.setRegionId(v)),
    ),
  );

  const presets: Array<[string, number, number]> = [
    ['1920 × 1080', 1920, 1080],
    ['1920 × 1200', 1920, 1200],
    ['3840 × 2160 (4K)', 3840, 2160],
  ];
  const presetBtns = presets.map(([label, w, h]) => {
    const b = button(label, () => app.setResolution(w, h));
    if (p.outputW === w && p.outputH === h) b.classList.add('active');
    return b;
  });
  const wf = miniField({
    label: 'Width',
    value: p.outputW,
    min: 64,
    max: 16384,
    step: 1,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => app.setResolution(Math.round(v), app.project.outputH, true),
  });
  const hf = miniField({
    label: 'Height',
    value: p.outputH,
    min: 64,
    max: 8192,
    step: 1,
    onGestureStart: () => app.beginGesture(),
    onChange: (v) => app.setResolution(app.project.outputW, Math.round(v), true),
  });
  root.appendChild(group('Framebuffer Resolution', ...presetBtns, wf.root, hf.root));

  root.appendChild(
    group(
      'MPCDI v2 Export',
      button('Export .mpcdi Archive', () => void app.exportMpcdi(false)),
      button('Export Raw ZIP', () => void app.exportMpcdi(true)),
      el(
        'div',
        'lw-note',
        'Profile 2d, level 1. One buffer, one fileset per region: PFM warp (absolute content-space UV), PNG alpha/beta maps.',
      ),
    ),
  );

  root.appendChild(
    group(
      'Project',
      button('Save Project (Ctrl+S)', () => app.saveProject()),
      button('Load Project…', () => app.loadProjectFile()),
      button('Reset All', () => app.resetAll()),
      el('div', 'lw-note', 'Autosaves to localStorage on every change. v1 projects load and migrate.'),
    ),
  );
  return root;
}
