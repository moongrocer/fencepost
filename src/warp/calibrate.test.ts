import { describe, expect, it } from 'vitest';
import { createBezierGrid, evalBezier } from './bezier';
import { greville } from './bspline';
import {
  applyH,
  distortPoint,
  fitControlNet,
  fitHomography,
  grayBit,
  grayDecode,
  invertH,
  solveRegion,
  undistortPoint,
  Intrinsics,
} from './calibrate';

const ELP: Intrinsics = {
  fx: 1105.9,
  fy: 1101.8,
  cx: 942.5,
  cy: 480.0,
  k1: -0.3596,
  k2: 0.109,
  p1: -5.22e-4,
  p2: 2.3e-3,
};

describe('gray codes', () => {
  it('round-trips every value', () => {
    const bits = 11;
    for (const v of [0, 1, 2, 3, 511, 512, 1023, 1918, 1919]) {
      const g: number[] = [];
      for (let b = bits - 1; b >= 0; b--) g.push(grayBit(v, b));
      expect(grayDecode(g)).toBe(v);
    }
  });
});

describe('lens model', () => {
  it('undistort inverts distort across the frame', () => {
    for (const [u, v] of [
      [100, 100],
      [960, 540],
      [1800, 1000],
      [200, 900],
    ] as const) {
      const [du, dv] = distortPoint(ELP, u, v);
      const [uu, vv] = undistortPoint(ELP, du, dv);
      expect(uu).toBeCloseTo(u, 2);
      expect(vv).toBeCloseTo(v, 2);
    }
  });
});

describe('homography', () => {
  it('recovers a known projective map from noisy points', () => {
    const H = [1.1, 0.05, 30, -0.04, 0.95, 12, 1e-4, -5e-5, 1];
    const src: Array<[number, number]> = [];
    const dst: Array<[number, number]> = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.2;
    for (let y = 0; y <= 10; y++) {
      for (let x = 0; x <= 10; x++) {
        const p: [number, number] = [x * 100, y * 80];
        const q = applyH(H, p[0], p[1]);
        src.push(p);
        dst.push([q[0] + rnd(), q[1] + rnd()]);
      }
    }
    const F = fitHomography(src, dst);
    for (const [x, y] of [
      [0, 0],
      [500, 400],
      [1000, 800],
      [250, 730],
    ] as const) {
      const a = applyH(H, x, y);
      const b = applyH(F, x, y);
      expect(b[0]).toBeCloseTo(a[0], 0);
      expect(b[1]).toBeCloseTo(a[1], 0);
    }
    const inv = invertH(F);
    const p = applyH(inv, ...applyH(F, 123, 456));
    expect(p[0]).toBeCloseTo(123, 3);
    expect(p[1]).toBeCloseTo(456, 3);
  });
});

describe('control net fit', () => {
  it('interpolates identity exactly (fresh grid stays identity)', () => {
    const g = createBezierGrid(5, 5);
    const targets: Array<Array<[number, number]>> = [];
    for (let j = 0; j < 5; j++) {
      const row: Array<[number, number]> = [];
      for (let i = 0; i < 5; i++) {
        // identity surface: target = greville params, matching fresh grid
        row.push([g.points[(j * 5 + i) * 2], g.points[(j * 5 + i) * 2 + 1]]);
      }
      targets.push(row);
    }
    const pts = fitControlNet(g, targets);
    for (let k = 0; k < pts.length; k++) expect(pts[k]).toBeCloseTo(g.points[k], 10);
  });

  it('surface passes through non-trivial targets at greville params', () => {
    const g = createBezierGrid(5, 5);
    const f = (u: number, v: number): [number, number] => [
      0.05 + 0.9 * u + 0.03 * v * v,
      -0.02 + 0.95 * v + 0.04 * Math.sin(u * 3),
    ];
    const targets: Array<Array<[number, number]>> = [];
    for (let j = 0; j < 5; j++) {
      const gv = greville(g.knotsV, g.degreeV, j);
      const row: Array<[number, number]> = [];
      for (let i = 0; i < 5; i++) row.push(f(greville(g.knotsU, g.degreeU, i), gv));
      targets.push(row);
    }
    const fitted = { ...g, points: fitControlNet(g, targets) };
    for (let j = 0; j < 5; j++) {
      const gv = greville(g.knotsV, g.degreeV, j);
      for (let i = 0; i < 5; i++) {
        const gu = greville(g.knotsU, g.degreeU, i);
        const p = evalBezier(fitted, gu, gv);
        const t = f(gu, gv);
        expect(p[0]).toBeCloseTo(t[0], 8);
        expect(p[1]).toBeCloseTo(t[1], 8);
      }
    }
  });
});

describe('solveRegion (global robust fit)', () => {
  const intr: Intrinsics = { fx: 100, fy: 100, cx: 100, cy: 75, k1: 0, k2: 0, p1: 0, p2: 0 };

  /**
   * Build a synthetic correspondence map from a projector->camera model by
   * forward-splatting a dense raster grid (like the gray-code decode does,
   * camera pixels not hit by any raster sample stay NaN).
   */
  const buildMap = (
    w: number,
    h: number,
    regionW: number,
    regionH: number,
    proj: (rx: number, ry: number) => [number, number],
  ) => {
    // average all raster samples landing on a camera pixel (keep-last would
    // add a directional bias the solver then faithfully fits)
    const sumX = new Float64Array(w * h);
    const sumY = new Float64Array(w * h);
    const cnt = new Float64Array(w * h);
    for (let ry = 0; ry < regionH; ry += 0.25) {
      for (let rx = 0; rx < regionW; rx += 0.25) {
        const [cx, cy] = proj(rx, ry);
        const x = Math.round(cx);
        const y = Math.round(cy);
        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        const k = y * w + x;
        sumX[k] += rx;
        sumY[k] += ry;
        cnt[k]++;
      }
    }
    const rasterX = new Float32Array(w * h).fill(NaN);
    const rasterY = new Float32Array(w * h).fill(NaN);
    for (let k = 0; k < w * h; k++) {
      if (cnt[k] > 0) {
        rasterX[k] = sumX[k] / cnt[k];
        rasterY[k] = sumY[k] / cnt[k];
      }
    }
    return { w, h, rasterX, rasterY };
  };

  // Comfortably inside the wavy footprint (cam x ∈ ~[17,73], y ∈ ~[7.5,92.5]
  // with the waves swinging the edges ±3) — mirrors chooseTarget, which
  // insets inside the measured percentile bounds and never rides the edge.
  const TARGET = { x: 33, y: 24, w: 34, h: 52 };

  it('solves a synthetic affine projector to land content on target', () => {
    // projector raster 100x160 appears in camera as cam = raster*0.5 + (20,10)
    const map = buildMap(200, 150, 100, 160, (rx, ry) => [rx * 0.5 + 20, ry * 0.5 + 10]);
    const target = { x: 30, y: 20, w: 40, h: 60 };
    const res = solveRegion({
      map,
      intr,
      target,
      src: { x: 0, y: 0, w: 1, h: 1 },
      regionW: 100,
      regionH: 160,
      grid: createBezierGrid(5, 5),
    });
    // Expected: content (u,v) -> cam (30+40u, 20+60v) -> raster
    // ((30+40u)-20)/0.5 = 20+80u px -> normalized (20+80u)/100
    const fitted = { ...createBezierGrid(5, 5), points: res.points };
    for (const [u, v] of [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
      [0.25, 0.75],
    ] as const) {
      const p = evalBezier(fitted, u, v);
      expect(p[0]).toBeCloseTo((20 + 80 * u) / 100, 1);
      expect(p[1]).toBeCloseTo((20 + 120 * v) / 160, 1);
    }
    expect(res.rmsPx).toBeLessThan(1.5);
  });

  // The physical model: a bowed wall. Projector->camera includes smooth
  // sinusoidal displacement on top of the affine map. The solved warp must
  // compensate, i.e. content must land on the (flat, rectangular) target
  // even where the wall bulges — THIS is wall-irregularity smoothing.
  const wavyProj = (rx: number, ry: number): [number, number] => [
    rx * 0.5 + 20 + 3 * Math.sin(ry / 22),
    ry * 0.5 + 10 + 2.5 * Math.sin(rx / 17),
  ];

  const wallError = (points: number[], grid = createBezierGrid(7, 7)) => {
    // For content (u,v): where does the solved warp actually put it on the
    // wall (through the true projector model), vs where target says?
    const fitted = { ...grid, points };
    let worst = 0;
    for (let a = 0; a <= 8; a++) {
      for (let b = 0; b <= 8; b++) {
        const u = a / 8;
        const v = b / 8;
        const s = evalBezier(fitted, u, v);
        const [wx, wy] = wavyProj(s[0] * 100, s[1] * 160);
        const ex = TARGET.x + u * TARGET.w;
        const ey = TARGET.y + v * TARGET.h;
        worst = Math.max(worst, Math.hypot(wx - ex, wy - ey));
      }
    }
    return worst;
  };

  it('compensates smooth wall irregularities (curved screen)', () => {
    const map = buildMap(200, 150, 100, 160, wavyProj);
    const res = solveRegion({
      map,
      intr,
      target: TARGET,
      src: { x: 0, y: 0, w: 1, h: 1 },
      regionW: 100,
      regionH: 160,
      grid: createBezierGrid(7, 7),
    });
    // camera px error on the wall, everywhere including between control
    // points. ~1 cam px = ~2 projector px here; the floor is set by the
    // synthetic map's splat noise plus cubic approximation of a full sine
    // period — a real capture with denser correspondences does better.
    expect(wallError(res.points)).toBeLessThan(1.1);
    expect(res.rmsPx).toBeLessThan(1.5);
  });

  it('survives an occluded / garbage patch (robust trimming)', () => {
    const map = buildMap(200, 150, 100, 160, wavyProj);
    // simulate an object blocking the camera: a block of confidently WRONG
    // decodes (this is what produced the tent-spike on the real rig)
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    // inside the target-mapped domain, unlike garbage outside the domain,
    // which the solver rightly never even looks at
    for (let y = 40; y < 70; y++) {
      for (let x = 42; x < 62; x++) {
        map.rasterX[y * map.w + x] = rnd() * 100;
        map.rasterY[y * map.w + x] = rnd() * 160;
      }
    }
    const res = solveRegion({
      map,
      intr,
      target: TARGET,
      src: { x: 0, y: 0, w: 1, h: 1 },
      regionW: 100,
      regionH: 160,
      grid: createBezierGrid(7, 7),
    });
    expect(res.outliers).toBeGreaterThan(100); // it actually found the garbage

    // The occluded window itself is unmeasurable — the prior bridges it,
    // which costs some accuracy THERE. What must hold is that the garbage
    // does not contaminate the rest of the surface (on the rig, the old
    // per-point solver grew a tent-shaped spike from exactly this), and
    // that the bridged area stays bounded rather than spiking.
    const fitted = { ...createBezierGrid(7, 7), points: res.points };
    let worstOutside = 0;
    let worstInside = 0;
    for (let a = 0; a <= 16; a++) {
      for (let b = 0; b <= 16; b++) {
        const u = a / 16;
        const v = b / 16;
        const s = evalBezier(fitted, u, v);
        const [wx, wy] = wavyProj(s[0] * 100, s[1] * 160);
        const ex = TARGET.x + u * TARGET.w;
        const ey = TARGET.y + v * TARGET.h;
        const err = Math.hypot(wx - ex, wy - ey);
        const inHole = ex > 42 - 4 && ex < 62 + 4 && ey > 40 - 4 && ey < 70 + 4;
        if (inHole) worstInside = Math.max(worstInside, err);
        else worstOutside = Math.max(worstOutside, err);
      }
    }
    expect(worstOutside).toBeLessThan(1.1); // no contamination
    expect(worstInside).toBeLessThan(3); // bridge stays sane, no spike
  });

  it('stays sane where the camera saw nothing (smoothness carries the edge)', () => {
    const map = buildMap(200, 150, 100, 160, wavyProj);
    // blind the camera to the right 20% of the projector footprint
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const k = y * map.w + x;
        if (map.rasterX[k] > 80) {
          map.rasterX[k] = NaN;
          map.rasterY[k] = NaN;
        }
      }
    }
    const res = solveRegion({
      map,
      intr,
      target: TARGET,
      src: { x: 0, y: 0, w: 1, h: 1 },
      regionW: 100,
      regionH: 160,
      grid: createBezierGrid(7, 7),
    });
    expect(res.lowCoverage).toBeGreaterThan(0); // it KNOWS the edge is blind
    const fitted = { ...createBezierGrid(7, 7), points: res.points };
    // extrapolated edge: no wild values, stays within a plausible band
    for (let b2 = 0; b2 <= 8; b2++) {
      const s = evalBezier(fitted, 1, b2 / 8);
      expect(s[0]).toBeGreaterThan(0.7);
      expect(s[0]).toBeLessThan(1.4);
      expect(Number.isFinite(s[1])).toBe(true);
    }
  });
});
