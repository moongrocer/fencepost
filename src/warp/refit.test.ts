import { describe, expect, it } from 'vitest';
import { createBezierGrid, evalBezier, insertColumn, insertRow } from './bezier';
import { composedPoint } from './compose';
import { laplacianSmooth, refitPatch, upgradeToHomography } from './refit';
import { defaultRegion } from '../state/project';

const sampleErr = (a: Parameters<typeof evalBezier>[0], b: Parameters<typeof evalBezier>[0]) => {
  let worst = 0;
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20; j++) {
      const p = evalBezier(a, i / 20, j / 20);
      const q = evalBezier(b, i / 20, j / 20);
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
  }
  return worst;
};

describe('laplacianSmooth', () => {
  it('leaves an identity grid alone (smooths displacement, not positions) and pins the boundary', () => {
    for (const n of [3, 5, 9]) {
      const g = createBezierGrid(n, n);
      const s = laplacianSmooth(g, 5);
      s.points.forEach((v, k) => expect(v).toBeCloseTo(g.points[k], 12));
    }
    const g = createBezierGrid(7, 7);
    g.points[(0 * 7 + 3) * 2 + 1] -= 0.1; // boundary point moved
    g.points[(3 * 7 + 3) * 2] += 0.2; // interior spike
    const s = laplacianSmooth(g, 3);
    expect(s.points[(0 * 7 + 3) * 2 + 1]).toBe(g.points[(0 * 7 + 3) * 2 + 1]);
    const spikeBefore = g.points[(3 * 7 + 3) * 2] - 0.5;
    const spikeAfter = s.points[(3 * 7 + 3) * 2] - 0.5;
    expect(Math.abs(spikeAfter)).toBeLessThan(Math.abs(spikeBefore) * 0.5);
  });
});

describe('refitPatch', () => {
  it('reproduces a surface that already IS a single patch, at the same density and knots', () => {
    // 4×4 cubic patch with random control points, refined by exact knot
    // insertion to 7×6 — refitting must return the same surface.
    let g = createBezierGrid(4, 4);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.2;
    g.points = g.points.map((v) => v + rand());
    g = insertColumn(g, 0.3);
    g = insertColumn(g, 0.55);
    g = insertColumn(g, 0.8);
    g = insertRow(g, 0.5);
    g = insertRow(g, 0.66);
    const r = refitPatch(g);
    expect(r.cols).toBe(g.cols);
    expect(r.rows).toBe(g.rows);
    expect(r.knotsU).toEqual(g.knotsU);
    expect(r.knotsV).toEqual(g.knotsV);
    expect(sampleErr(r, g)).toBeLessThan(1e-9);
  });

  it('removes an interior kink while keeping the overall shape', () => {
    const g = createBezierGrid(9, 9);
    g.points[(4 * 9 + 4) * 2] += 0.15; // one-point kink
    const r = refitPatch(g);
    // the spike is gone: its footprint is spread out and the surface is
    // closer to identity everywhere
    expect(sampleErr(r, createBezierGrid(9, 9))).toBeLessThan(sampleErr(g, createBezierGrid(9, 9)));
    expect(r.cols).toBe(9);
    // a 2×2 corner-pin is already a single (degree-1) patch: unchanged
    const c = createBezierGrid(2, 2);
    c.points[2] = 1.3;
    expect(sampleErr(refitPatch(c), c)).toBeLessThan(1e-12);
  });
});

describe('upgradeToHomography (explicit migration)', () => {
  it('enables layer 1 with the corners and keeps the composed picture where it was', () => {
    const r = defaultRegion('r', { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 });
    // a hand-made keystone on a 5×5 grid: drag the right corners inward
    r.bezier.points[(0 * 5 + 4) * 2 + 1] += 0.15;
    r.bezier.points[(4 * 5 + 4) * 2 + 1] -= 0.15;
    r.fence.posts[0].top = 0.02;
    const before: Array<[number, number, number, number]> = [];
    for (let i = 0; i <= 10; i++)
      for (let j = 0; j <= 10; j++) {
        const p = composedPoint(r, 16 / 9, i / 10, j / 10);
        before.push([i / 10, j / 10, p[0], p[1]]);
      }
    upgradeToHomography(r);
    expect(r.homography.enabled).toBe(true);
    expect(r.homography.corners[1][1]).toBeCloseTo(0.15, 12);
    expect(r.fence.posts[0].top).toBe(0.02); // fence preserved
    let worst = 0;
    for (const [u, v, x, y] of before) {
      const p = composedPoint(r, 16 / 9, u, v);
      worst = Math.max(worst, Math.hypot(p[0] - x, p[1] - y));
    }
    expect(worst).toBeLessThan(2e-3); // < 4 px on 1920
    // no-op once a model layer is on
    const snap = JSON.stringify(r);
    upgradeToHomography(r);
    expect(JSON.stringify(r)).toBe(snap);
  });
});
