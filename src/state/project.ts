/**
 * The serializable project model. Everything the UI edits lives here so
 * that undo (snapshotting), autosave, and save/load are trivial.
 *
 * v2: multi-region (mosaic) support. The project describes ONE mosaic
 * framebuffer (outputW x outputH) split into N regions (one per
 * projector). Each region has:
 *   - rect: its slice of the framebuffer (fractions; mosaic tiles are
 *     butt-joined, e.g. 3 portrait columns -> w = 1/3 each)
 *   - src:  its window of the shared CONTENT space (fractions). Adjacent
 *     windows overlap where projector beams physically overlap on the
 *     wall — both regions render that shared band of content.
 *   - its own warp (fence + bezier) and blend/black-level.
 *
 * Blend is defined against the region's CONTENT window edges (widths in
 * content pixels), not the output raster — the ramp rides through the
 * warp, so a keystoned or curved seam gets a matching keystoned/curved
 * blend automatically, and neighboring ramps meet at the same content
 * coordinates.
 *
 * Loaded still images are kept OUT of the serialized state; only the
 * pattern selection is persisted.
 */
import { BezierGridState, createBezierGrid } from '../warp/bezier';
import { createFence, FenceState } from '../warp/fence';

export type PatternId =
  | 'grid'
  | 'crosshatch'
  | 'smpte'
  | 'polar'
  | 'solid'
  | 'convergence'
  | 'custom';

export interface BlendEdge {
  /** blend zone width in CONTENT pixels measured from the region's content window edge (0 = off) */
  width: number;
  /** falloff exponent: alpha = (d/width)^gamma */
  gamma: number;
}

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionState {
  /** region id, lands in mpcdi.xml */
  id: string;
  /** placement within the mosaic framebuffer (fractions of buffer) */
  rect: RegionRect;
  /** window of shared content space this projector displays (fractions) */
  src: RegionRect;
  bezier: BezierGridState;
  fence: FenceState;
  blend: { left: BlendEdge; right: BlendEdge; top: BlendEdge; bottom: BlendEdge };
  /** uniform black-level lift, 0..0.5 */
  blackLevel: number;
}

export interface ProjectState {
  version: 2;
  name: string;
  /** TOTAL mosaic framebuffer resolution */
  outputW: number;
  outputH: number;
  regions: RegionState[];
  activeRegion: number;
  pattern: {
    id: PatternId;
    solid: 'white' | 'gray' | 'black';
    gridSpacing: number;
    gridLineWidth: number;
    polarCx: number;
    polarCy: number;
    /** index into the (non-serialized) stills list */
    customIndex: number;
  };
  overlays: { bezier: boolean; fence: boolean; wireframe: boolean };
}

const noBlend = (): RegionState['blend'] => ({
  left: { width: 0, gamma: 2.2 },
  right: { width: 0, gamma: 2.2 },
  top: { width: 0, gamma: 2.2 },
  bottom: { width: 0, gamma: 2.2 },
});

export function defaultRegion(id: string, rect: RegionRect, src: RegionRect): RegionState {
  return {
    id,
    rect,
    src,
    bezier: createBezierGrid(5, 5),
    fence: createFence(),
    blend: noBlend(),
    blackLevel: 0,
  };
}

export function defaultProject(): ProjectState {
  return {
    version: 2,
    name: 'fencepost-project',
    outputW: 1920,
    outputH: 1080,
    regions: [defaultRegion('region0', { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })],
    activeRegion: 0,
    pattern: {
      id: 'grid',
      solid: 'white',
      gridSpacing: 64,
      gridLineWidth: 2,
      polarCx: 0.5,
      polarCy: 0.5,
      customIndex: 0,
    },
    overlays: { bezier: true, fence: true, wireframe: false },
  };
}

/**
 * Build an N-column mosaic: framebuffer = cols * projW wide, projH tall,
 * butt-joined output slices, content windows overlapping by overlapPx
 * (content pixels) so neighbors share a band, with matching blend ramps.
 *
 * Window math: with overlap fraction v = overlapPx / (cols*projW), each
 * window spans s = (1 + (cols-1)*v) / cols and consecutive windows step by
 * d = s - v; the last window ends exactly at 1.
 */
export function mosaicColumns(
  cols: number,
  projW: number,
  projH: number,
  overlapPx: number,
): { outputW: number; outputH: number; regions: RegionState[] } {
  const outputW = cols * projW;
  const outputH = projH;
  const v = Math.max(0, Math.min(0.45, overlapPx / outputW));
  const s = (1 + (cols - 1) * v) / cols;
  const d = s - v;
  const regions: RegionState[] = [];
  for (let i = 0; i < cols; i++) {
    const r = defaultRegion(
      `region${i}`,
      { x: i / cols, y: 0, w: 1 / cols, h: 1 },
      { x: i * d, y: 0, w: s, h: 1 },
    );
    if (overlapPx > 0) {
      if (i > 0) r.blend.left = { width: overlapPx, gamma: 2.2 };
      if (i < cols - 1) r.blend.right = { width: overlapPx, gamma: 2.2 };
    }
    regions.push(r);
  }
  return { outputW, outputH, regions };
}

export function serializeProject(p: ProjectState): string {
  return JSON.stringify(p, null, 2);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validateRegion(r: RegionState, label: string): void {
  const b = r.bezier;
  if (
    !b ||
    !Array.isArray(b.points) ||
    b.points.length !== b.cols * b.rows * 2 ||
    !Array.isArray(b.knotsU) ||
    !Array.isArray(b.knotsV) ||
    b.points.some((x) => !isNum(x))
  ) {
    throw new Error(`Invalid bezier grid data (${label})`);
  }
  if (!r.fence || !Array.isArray(r.fence.posts) || r.fence.posts.length < 2) {
    throw new Error(`Invalid fence data (${label})`);
  }
  for (const rect of [r.rect, r.src]) {
    if (!rect || !isNum(rect.x) || !isNum(rect.y) || !isNum(rect.w) || !isNum(rect.h) || rect.w <= 0 || rect.h <= 0) {
      throw new Error(`Invalid region rect (${label})`);
    }
  }
}

/** Parse + structurally validate a project JSON; migrates v1 files. */
export function deserializeProject(json: string): ProjectState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(json) as any;
  const d = defaultProject();

  if (raw?.version === 1) {
    // v1 -> v2: the old single warp/blend becomes region 0, full frame.
    const region: RegionState = {
      ...defaultRegion(raw.regionId ?? 'region0', { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }),
      bezier: raw.bezier,
      fence: raw.fence,
      blend: { ...noBlend(), ...(raw.blend ?? {}) },
      blackLevel: isNum(raw.blackLevel) ? raw.blackLevel : 0,
    };
    const p: ProjectState = {
      ...d,
      name: raw.name ?? d.name,
      outputW: isNum(raw.outputW) ? raw.outputW : d.outputW,
      outputH: isNum(raw.outputH) ? raw.outputH : d.outputH,
      regions: [region],
      activeRegion: 0,
      pattern: { ...d.pattern, ...(raw.pattern ?? {}) },
      overlays: { ...d.overlays, ...(raw.overlays ?? {}) },
    };
    validateRegion(region, 'migrated v1');
    return p;
  }

  if (raw?.version !== 2) throw new Error('Unsupported project version');
  const p: ProjectState = {
    ...d,
    ...raw,
    pattern: { ...d.pattern, ...(raw.pattern ?? {}) },
    overlays: { ...d.overlays, ...(raw.overlays ?? {}) },
  } as ProjectState;
  if (!Array.isArray(p.regions) || p.regions.length === 0) throw new Error('Project has no regions');
  p.regions = p.regions.map((r, i) => ({
    ...defaultRegion(r.id ?? `region${i}`, r.rect, r.src),
    ...r,
    blend: { ...noBlend(), ...(r.blend ?? {}) },
  }));
  p.regions.forEach((r, i) => validateRegion(r, r.id ?? `#${i}`));
  p.activeRegion = Math.min(Math.max(0, p.activeRegion | 0), p.regions.length - 1);
  if (!isNum(p.outputW) || !isNum(p.outputH)) throw new Error('Invalid output resolution');
  return p;
}
