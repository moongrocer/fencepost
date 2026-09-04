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

export type TabId = 'MOSAIC' | 'PATTERNS' | 'MODEL' | 'WARP' | 'FENCE' | 'BLEND' | 'EXPORT';
export const TABS: TabId[] = ['MOSAIC', 'PATTERNS', 'MODEL', 'WARP', 'FENCE', 'BLEND', 'EXPORT'];

export function renderPanel(app: App, tab: TabId): HTMLElement {
  switch (tab) {
    case 'MOSAIC':
      return mosaicPanel(app);
    case 'PATTERNS':
      return patternsPanel(app);
    case 'MODEL':
      return withRegionBadge(app, modelPanel(app));
    case 'WARP':
      return withRegionBadge(app, warpPanel(app));
    case 'FENCE':
      return withRegionBadge(app, fencePanel(app));
    case 'BLEND':
      return withRegionBadge(app, blendPanel(app));
    case 'EXPORT':
      return exportPanel(app);
  }
}

/**
 * WARP / FENCE / BLEND edit exactly one region. Say which, at the top of
 * the panel — the status bar alone was too easy to miss, and editing the
 * wrong projector is a silent, confusing failure.
 */
function withRegionBadge(app: App, panel: HTMLElement): HTMLElement {
  const p = app.project;
  if (p.regions.length < 2) return panel;
  const wrap = el('div');
  const badge = el('div', 'lw-region-badge');
  badge.appendChild(el('span', 'lw-region-badge-tag', `R${p.activeRegion + 1}`));
  badge.appendChild(el('span', '', `editing "${app.region.id}" — , / . to switch`));
  wrap.appendChild(badge);
  wrap.appendChild(panel);
  return wrap;
}

function mosaicPanel(app: App): HTMLElement {
  const p = app.project;
  const root = el('div');

  let mCols = Math.max(2, p.regions.length);
  let mW = Math.round(p.outputW / Math.max(1, p.regions.length));
  let mH = p.outputH;
  let mOv = Math.round(p.regions[0]?.blend.right.width || 200);

  const colsF = miniField({ label: 'Columns', value: mCols, min: 2, max: 8, step: 1, onChange: (v) => (mCols = Math.round(v)) });
  const wF = miniField({ label: 'Proj W', value: mW, min: 64, max: 8192, step: 1, onChange: (v) => (mW = Math.round(v)) });
  const hF = miniField({ label: 'Proj H', value: mH, min: 64, max: 8192, step: 1, onChange: (v) => (mH = Math.round(v)) });
  const ovF = miniField({ label: 'Overlap px', value: mOv, min: 0, max: 2000, step: 1, onChange: (v) => (mOv = Math.round(v)) });

  root.appendChild(
    group(
      'Layout',
      el(
        'div',
        'lw-note',
        p.regions.length < 2
          ? 'SINGLE REGION. For two or more projectors, set the per-projector resolution and physical beam overlap, then build.'
          : `${p.regions.length} regions — framebuffer ${p.outputW} × ${p.outputH}.`,
      ),
      colsF.root,
      wF.root,
      hF.root,
      ovF.root,
      button('Build Column Mosaic', () => void app.buildMosaic(mCols, mW, mH, mOv)),
      button('Single Region (reset)', () => void app.makeSingleRegion()),
      el(
        'div',
        'lw-note',
        'Butt-joined framebuffer slices (one fullscreen window on a Mosaic/Eyefinity desktop); content windows overlap by the given band and get matching blend ramps.',
      ),
    ),
  );

  const regionBtns: HTMLElement[] = p.regions.map((r, i) => {
    const b = button(`R${i + 1} — ${r.id}`, () => app.setActiveRegion(i));
    if (i === p.activeRegion) b.classList.add('active');
    return b;
  });
  root.appendChild(
    group(
      'Active Region',
      ...regionBtns,
      textField(`Region ID (R${p.activeRegion + 1})`, app.region.id, (v) => app.setRegionId(v)),
      el(
        'div',
        'lw-note',
        'WARP / FENCE / BLEND always edit the ACTIVE region. Switch with , / . or by clicking that projector’s half of the canvas.',
      ),
    ),
  );
  return root;
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

/**
 * MODEL tab: the parametric layers. Homography = true perspective
 * corner-pin (drag the 4 green corners on the canvas); cylinder = analytic
 * UST-on-curved-wall model. Both sit UNDER the hand-placed fence/bezier
 * residual, which should end up small once these are dialed in.
 */
function modelPanel(app: App): HTMLElement {
  const r = app.region;
  const root = el('div');

  const onOff = (on: boolean) => (on ? 'ON' : 'OFF');
  const toggleBtn = (label: string, on: boolean, fn: () => void) => {
    const b = button(`${label}: ${onOff(on)}`, fn);
    if (on) b.classList.add('active');
    return b;
  };

  const legacy = !r.homography.enabled && !r.cylinder.enabled;
  root.appendChild(
    group(
      '1 · Homography (8 DOF)',
      toggleBtn('Homography', r.homography.enabled, () => app.toggleLayer('homography')),
      button('Reset Corners', () => void app.resetHomography()),
      ...(legacy ? [button('Upgrade: bezier corners → homography', () => app.upgradeToHomography())] : []),
      el(
        'div',
        'lw-note',
        'Drag the green corner circles. Exact perspective (cross-ratio spacing), so a flat wall off-axis needs NO interior points. ' +
          (legacy
            ? 'Upgrade fits the homography to the current bezier corners and refits the bezier as a residual — the picture does not move. Reset Bezier afterwards to drop to the pure homography.'
            : ''),
      ),
    ),
  );

  const c = r.cylinder;
  const field = (
    label: string,
    key: Exclude<keyof typeof c, 'enabled' | 'pos'>,
    min: number,
    max: number,
    step: number,
    decimals = 3,
  ) =>
    miniField({
      label,
      value: c[key],
      min,
      max,
      step,
      decimals,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.region.cylinder[key] = v;
        app.applyEdit({ warp: true });
      },
    }).root;
  const posField = (label: string, i: 0 | 1 | 2) =>
    miniField({
      label,
      value: c.pos[i],
      min: -50,
      max: 50,
      step: 0.01,
      decimals: 3,
      onGestureStart: () => app.beginGesture(),
      onChange: (v) => {
        app.region.cylinder.pos[i] = v;
        app.applyEdit({ warp: true });
      },
    }).root;

  root.appendChild(
    group(
      '2 · Cylinder Wall',
      toggleBtn('Cylinder', c.enabled, () => app.toggleLayer('cylinder')),
      field('Radius (m)', 'radius', 0.1, 100, 0.01),
      field('Height (m)', 'height', 0.1, 50, 0.01),
      field('Arc Length (m)', 'arc', 0.1, 300, 0.01),
      el('div', 'lw-note', 'Vertical axis at the origin; content spans the arc centred on the wall middle, v=0 at the top edge.'),
    ),
  );
  root.appendChild(
    group(
      'Projector',
      posField('Pos X (m)', 0),
      posField('Pos Y up (m)', 1),
      posField('Pos Z →wall (m)', 2),
      field('Yaw (°)', 'yaw', -180, 180, 0.1, 2),
      field('Pitch (°)', 'pitch', -90, 90, 0.1, 2),
      field('Roll (°)', 'roll', -180, 180, 0.1, 2),
      field('Throw Ratio', 'throwRatio', 0.05, 10, 0.005),
      field('Lens Offset (×H)', 'lensOffset', -2, 3, 0.005),
      el('div', 'lw-note', 'Pos is the centre of projection: for a UST that is the mirror’s virtual pupil, not the box. Throw = distance ÷ image width. Offset 0 = centred, 0.5 = axis on the bottom edge.'),
    ),
  );
  root.appendChild(
    group(
      'Lens Distortion',
      field('k1', 'k1', -2, 2, 0.001, 4),
      field('k2', 'k2', -2, 2, 0.001, 4),
      button('Reset Cylinder Params', () => void app.resetCylinder()),
      el('div', 'lw-note', 'Radial terms absorb the UST mirror’s barrel distortion — LENS, not wall shape. Leave at 0 for a pinhole.'),
    ),
  );

  root.appendChild(
    group(
      '3 · Residual (fence + bezier)',
      toggleBtn('Residual', r.residualEnabled, () => app.toggleLayer('residual')),
      el('div', 'lw-note', 'Hand-placed trim on top of 1 + 2. Toggling a layer never changes its values.'),
    ),
  );
  return root;
}

function warpPanel(app: App): HTMLElement {
  const r = app.region;
  const root = el('div');

  let pendingDensity = Math.max(r.bezier.cols, 2);
  const density = miniField({
    label: 'Density',
    value: pendingDensity,
    min: 2,
    max: 17,
    step: 1,
    onChange: (v) => {
      pendingDensity = Math.round(v);
    },
  });
  const degreeName = r.bezier.degreeU === 1 ? 'bilinear corner-pin' : r.bezier.degreeU === 2 ? 'quadratic' : 'cubic';
  root.appendChild(
    group(
      'Grid Density',
      el('div', 'lw-note', `Current: ${r.bezier.cols} × ${r.bezier.rows} (${degreeName})`),
      density.root,
      button('Apply Density (resets)', () => void app.setDensity(pendingDensity)),
      el('div', 'lw-note', '2 × 2 = plain 4-corner keystone, no spline interpolation.'),
    ),
  );

  root.appendChild(
    group(
      'Local Subdivide',
      button('+ Column @ Selection', () => void app.subdivide('col')),
      button('+ Row @ Selection', () => void app.subdivide('row')),
      el('div', 'lw-note', 'Exact knot insertion — adds points without moving the surface.'),
    ),
  );

  let smoothIters = 2;
  const iters = miniField({
    label: 'Passes',
    value: smoothIters,
    min: 1,
    max: 20,
    step: 1,
    onChange: (v) => (smoothIters = Math.round(v)),
  });
  root.appendChild(
    group(
      'Repair',
      button('Smooth (Laplacian)', () => app.smoothBezier(smoothIters)),
      iters.root,
      button('Refit as Single Patch', () => app.refitBezier()),
      el(
        'div',
        'lw-note',
        'Smooth relaxes interior points toward their neighbours (edges fixed). Refit fits ONE cubic patch through the current surface and resamples the lattice at this density — kinks cannot survive it; the dialed-in shape does. Both undoable.',
      ),
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
      button('Reset Bezier (region)', () => void app.resetBezier()),
      el(
        'div',
        'lw-note',
        'Nudge: arrows = 4 px, Shift+arrows = 0.25 px (projector px). Ctrl+arrows walk the selection point to point — no mouse needed.',
      ),
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
      button('Reset Fence (region)', () => void app.resetFence()),
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

  root.appendChild(
    group(
      'Metadata',
      textField('Name', p.name, (v) =>
        app.edit(() => {
          app.project.name = v || 'fencepost-project';
        }, {}),
      ),
      textField(`Region ID (R${p.activeRegion + 1})`, region.id, (v) => app.setRegionId(v)),
      el('div', 'lw-note', 'Mosaic layout and region switching moved to the MOSAIC tab.'),
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
      button('Reset All', () => void app.resetAll()),
      el('div', 'lw-note', 'Autosaves to localStorage on every change. v1 projects load and migrate.'),
    ),
  );
  return root;
}
