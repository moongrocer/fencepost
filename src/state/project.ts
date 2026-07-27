/**
 * The serializable project model. Everything the UI edits lives here so
 * that undo (snapshotting), autosave, and save/load are trivial.
 *
 * Loaded still images are kept OUT of the serialized state (a project JSON
 * stays small/human-readable and localStorage autosave never hits quota);
 * only the pattern selection is persisted.
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
  /** blend zone width in output pixels (0 = off) */
  width: number;
  /** falloff exponent: alpha = (d/width)^gamma */
  gamma: number;
}

export interface ProjectState {
  version: 1;
  name: string;
  regionId: string;
  outputW: number;
  outputH: number;
  bezier: BezierGridState;
  fence: FenceState;
  blend: { left: BlendEdge; right: BlendEdge; top: BlendEdge; bottom: BlendEdge };
  /** uniform black-level lift, 0..0.5 */
  blackLevel: number;
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

export function defaultProject(): ProjectState {
  return {
    version: 1,
    name: 'fencepost-project',
    regionId: 'region0',
    outputW: 1920,
    outputH: 1080,
    bezier: createBezierGrid(5, 5),
    fence: createFence(),
    blend: {
      left: { width: 0, gamma: 2.2 },
      right: { width: 0, gamma: 2.2 },
      top: { width: 0, gamma: 2.2 },
      bottom: { width: 0, gamma: 2.2 },
    },
    blackLevel: 0,
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

export function serializeProject(p: ProjectState): string {
  return JSON.stringify(p, null, 2);
}

/** Parse + structurally validate a project JSON; throws on garbage. */
export function deserializeProject(json: string): ProjectState {
  const raw = JSON.parse(json) as Partial<ProjectState>;
  if (raw.version !== 1) throw new Error('Unsupported project version');
  const d = defaultProject();
  const p: ProjectState = {
    ...d,
    ...raw,
    blend: { ...d.blend, ...(raw.blend ?? {}) },
    pattern: { ...d.pattern, ...(raw.pattern ?? {}) },
    overlays: { ...d.overlays, ...(raw.overlays ?? {}) },
  } as ProjectState;
  const b = p.bezier;
  if (
    !b ||
    !Array.isArray(b.points) ||
    b.points.length !== b.cols * b.rows * 2 ||
    !Array.isArray(b.knotsU) ||
    !Array.isArray(b.knotsV)
  ) {
    throw new Error('Invalid bezier grid data');
  }
  if (!p.fence || !Array.isArray(p.fence.posts) || p.fence.posts.length < 2) {
    throw new Error('Invalid fence data');
  }
  return p;
}
