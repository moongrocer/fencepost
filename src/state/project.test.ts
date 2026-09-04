import { describe, expect, it } from 'vitest';
import {
  defaultProject,
  deserializeProject,
  mosaicColumns,
  serializeProject,
} from './project';
import { createBezierGrid, evalBezier } from '../warp/bezier';
import { composedPoint } from '../warp/compose';
import { createFence } from '../warp/fence';
import { regionAlpha } from '../render/blend';

describe('mosaic column math', () => {
  it('content windows tile [0,1] with the requested overlap', () => {
    const m = mosaicColumns(3, 1200, 1920, 200);
    expect(m.outputW).toBe(3600);
    expect(m.outputH).toBe(1920);
    expect(m.regions.length).toBe(3);
    const ov = 200 / 3600;
    for (let i = 0; i < 3; i++) {
      const r = m.regions[i];
      expect(r.rect.x).toBeCloseTo(i / 3, 12);
      expect(r.rect.w).toBeCloseTo(1 / 3, 12);
    }
    // consecutive windows overlap by exactly the overlap fraction
    for (let i = 0; i < 2; i++) {
      const a = m.regions[i].src;
      const b = m.regions[i + 1].src;
      expect(a.x + a.w - b.x).toBeCloseTo(ov, 12);
    }
    // full coverage: first starts at 0, last ends at 1
    expect(m.regions[0].src.x).toBeCloseTo(0, 12);
    const last = m.regions[2].src;
    expect(last.x + last.w).toBeCloseTo(1, 12);
    // interior blend edges got the overlap width
    expect(m.regions[0].blend.right.width).toBe(200);
    expect(m.regions[1].blend.left.width).toBe(200);
    expect(m.regions[1].blend.right.width).toBe(200);
    expect(m.regions[0].blend.left.width).toBe(0);
    expect(m.regions[2].blend.right.width).toBe(0);
  });
});

describe('blend continuity across a mosaic seam', () => {
  // Must hold at EVERY gamma, not just 1. The old bare-power ramp summed
  // to 0.435 at the band centre with the default gamma 2.2 — a 56% dark
  // stripe down every seam — and the previous version of this test hid
  // that by forcing gamma to 1 first.
  for (const gamma of [1, 1.5, 2.2, 3, 0.5]) {
    it(`neighboring ramps sum to 1 at shared content points (gamma ${gamma})`, () => {
      const m = mosaicColumns(2, 1000, 1000, 100);
      const [a, b] = m.regions;
      a.blend.right.gamma = gamma;
      b.blend.left.gamma = gamma;
      // walk the shared content band
      const bandStart = b.src.x;
      const bandEnd = a.src.x + a.src.w;
      for (let k = 0; k <= 10; k++) {
        const cu = bandStart + ((bandEnd - bandStart) * k) / 10;
        const ua = (cu - a.src.x) / a.src.w; // local u in region a
        const ub = (cu - b.src.x) / b.src.w; // local u in region b
        const alphaA = regionAlpha(a, m.outputW, m.outputH, ua, 0.5);
        const alphaB = regionAlpha(b, m.outputW, m.outputH, ub, 0.5);
        // 1e-6 is ~1/4000 of an 8-bit alpha step. The ramp is nonlinear
        // now, so rounding in the content-space t gets amplified by f'(t)
        // near the band edges — well below anything a projector can show.
        expect(alphaA + alphaB).toBeCloseTo(1, 6);
      }
    });
  }

  it('gamma still shapes the ramp (it is not just linear)', () => {
    const m = mosaicColumns(2, 1000, 1000, 100);
    const [a] = m.regions;
    const quarterAt = (g: number) => {
      a.blend.right.gamma = g;
      // 1/4 into the band from region a's content-window right edge
      const cu = a.src.x + a.src.w - (0.25 * 100) / m.outputW;
      return regionAlpha(a, m.outputW, m.outputH, (cu - a.src.x) / a.src.w, 0.5);
    };
    expect(quarterAt(1)).toBeCloseTo(0.25, 6);
    expect(quarterAt(2.2)).toBeLessThan(0.25 - 1e-3); // steeper shoulder
    expect(quarterAt(0.5)).toBeGreaterThan(0.25 + 1e-3);
  });
});

describe('project (de)serialization & migration', () => {
  it('v2 round-trips', () => {
    const p = defaultProject();
    const m = mosaicColumns(3, 1200, 1920, 150);
    p.outputW = m.outputW;
    p.outputH = m.outputH;
    p.regions = m.regions;
    p.activeRegion = 2;
    const q = deserializeProject(serializeProject(p));
    expect(q.regions.length).toBe(3);
    expect(q.activeRegion).toBe(2);
    expect(q.regions[1].src.w).toBeCloseTo(p.regions[1].src.w, 12);
  });

  it('migrates v1 projects into a single full-frame region', () => {
    const v1 = {
      version: 1,
      name: 'old',
      regionId: 'proj-left',
      outputW: 1920,
      outputH: 1080,
      bezier: createBezierGrid(5, 5),
      fence: createFence(),
      blend: { left: { width: 120, gamma: 2.0 }, right: { width: 0, gamma: 2.2 }, top: { width: 0, gamma: 2.2 }, bottom: { width: 0, gamma: 2.2 } },
      blackLevel: 0.03,
      pattern: { id: 'grid', solid: 'white', gridSpacing: 32, gridLineWidth: 2, polarCx: 0.5, polarCy: 0.5, customIndex: 0 },
      overlays: { bezier: true, fence: false, wireframe: false },
    };
    const p = deserializeProject(JSON.stringify(v1));
    expect(p.version).toBe(2);
    expect(p.regions.length).toBe(1);
    const r = p.regions[0];
    expect(r.id).toBe('proj-left');
    expect(r.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(r.src).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(r.blend.left.width).toBe(120);
    expect(r.blackLevel).toBeCloseTo(0.03, 12);
    expect(p.pattern.gridSpacing).toBe(32);
    expect(p.overlays.fence).toBe(false);
  });

  it('all three warp layers round-trip bit-identically', () => {
    const p = defaultProject();
    const r = p.regions[0];
    r.homography = { enabled: true, corners: [[0.01, 0.02], [0.97, -0.03], [1.04, 0.99], [0.0, 1.01]] };
    r.cylinder = { ...r.cylinder, enabled: true, radius: 2.7, pos: [0.1, 1.3, -0.4], yaw: 2.5, k1: -0.031 };
    r.residualEnabled = false;
    const json = serializeProject(p);
    const q = deserializeProject(json);
    expect(serializeProject(q)).toBe(json);
  });

  it('projects saved before the model stack load with layers 1/2 off and render unchanged', () => {
    const p = defaultProject();
    const legacy = JSON.parse(serializeProject(p));
    delete legacy.regions[0].homography;
    delete legacy.regions[0].cylinder;
    delete legacy.regions[0].residualEnabled;
    legacy.regions[0].bezier.points[12] += 0.1;
    const q = deserializeProject(JSON.stringify(legacy));
    const r = q.regions[0];
    expect(r.homography.enabled).toBe(false);
    expect(r.cylinder.enabled).toBe(false);
    expect(r.residualEnabled).toBe(true);
    expect(composedPoint(r, 16 / 9, 0.5, 0.5)).toEqual(evalBezier(r.bezier, 0.5, 0.5));
  });

  it('rejects garbage', () => {
    expect(() => deserializeProject('{"version":3}')).toThrow();
    expect(() => deserializeProject('{"version":2,"regions":[]}')).toThrow();
  });
});
