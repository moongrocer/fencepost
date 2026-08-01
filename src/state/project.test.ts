import { describe, expect, it } from 'vitest';
import {
  defaultProject,
  deserializeProject,
  mosaicColumns,
  serializeProject,
} from './project';
import { createBezierGrid } from '../warp/bezier';
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
  it('neighboring ramps sum to 1 at shared content points (gamma 1)', () => {
    const m = mosaicColumns(2, 1000, 1000, 100);
    const [a, b] = m.regions;
    a.blend.right.gamma = 1;
    b.blend.left.gamma = 1;
    // walk the shared content band
    const bandStart = b.src.x;
    const bandEnd = a.src.x + a.src.w;
    for (let k = 0; k <= 10; k++) {
      const cu = bandStart + ((bandEnd - bandStart) * k) / 10;
      const ua = (cu - a.src.x) / a.src.w; // local u in region a
      const ub = (cu - b.src.x) / b.src.w; // local u in region b
      const alphaA = regionAlpha(a, m.outputW, m.outputH, ua, 0.5);
      const alphaB = regionAlpha(b, m.outputW, m.outputH, ub, 0.5);
      expect(alphaA + alphaB).toBeCloseTo(1, 10);
    }
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

  it('rejects garbage', () => {
    expect(() => deserializeProject('{"version":3}')).toThrow();
    expect(() => deserializeProject('{"version":2,"regions":[]}')).toThrow();
  });
});
