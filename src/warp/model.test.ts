import { describe, expect, it } from 'vitest';
import { applyH, H3 } from './calibrate';
import { composedPoint, modelPoint } from './compose';
import { evalBezier } from './bezier';
import { fenceTransform } from './fence';
import {
  applyHomography,
  cylinderProject,
  defaultCylinder,
  defaultHomography,
  homographyMatrix,
  HomographyState,
  invertMap,
  UNIT_CORNERS,
} from './model';
import { defaultRegion } from '../state/project';

const region = () => defaultRegion('r', { x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 });

describe('homography (Heckbert closed form)', () => {
  it('identity corners give the identity matrix', () => {
    const H = homographyMatrix(defaultHomography().corners);
    expect(H).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('maps the unit-square corners exactly onto the destinations', () => {
    const st = defaultHomography();
    st.corners = [
      [0.05, 0.1],
      [0.9, 0.02],
      [1.1, 0.95],
      [-0.1, 1.05],
    ];
    UNIT_CORNERS.forEach((c, i) => {
      const [x, y] = applyHomography(st, c[0], c[1]);
      expect(x).toBeCloseTo(st.corners[i][0], 12);
      expect(y).toBeCloseTo(st.corners[i][1], 12);
    });
  });

  it('is a true perspective map: an edge midpoint does not land at the destination midpoint', () => {
    // 30°-off-axis keystone: right edge shorter than left
    const st = defaultHomography();
    st.corners = [
      [0, 0],
      [1, 0.2],
      [1, 0.8],
      [0, 1],
    ];
    const H = homographyMatrix(st.corners);
    expect(Math.abs(H[6]) + Math.abs(H[7])).toBeGreaterThan(1e-3); // foreshortening terms live
    const [x] = applyHomography(st, 0.5, 0.5);
    expect(Math.abs(x - 0.5)).toBeGreaterThan(0.02); // bilinear would give exactly 0.5
  });

  it('flat wall off-axis (acceptance): four corners reproduce the whole pinhole map, no interior points needed', () => {
    // A raster looking at a plane rotated 30° about the vertical axis IS a
    // homography P. Feed only the four corners of P to Heckbert and the
    // result must equal P at every interior point — that is what makes a
    // layer-1-only calibration geometrically exact.
    const th = (30 * Math.PI) / 180;
    const P: H3 = [Math.cos(th), 0, 0.1, 0.05, 1, 0.02, -Math.sin(th) * 0.6, 0.03, 1.3];
    const st = defaultHomography();
    st.corners = UNIT_CORNERS.map((c) => applyH(P, c[0], c[1])) as HomographyState['corners'];
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const [x, y] = applyHomography(st, i / 8, j / 8);
        const [px, py] = applyH(P, i / 8, j / 8);
        expect(x).toBeCloseTo(px, 10);
        expect(y).toBeCloseTo(py, 10);
      }
  });

  it('parallelogram destinations take the affine branch', () => {
    const st = defaultHomography();
    st.corners = [
      [0.1, 0.1],
      [1.1, 0.2],
      [1.3, 1.2],
      [0.3, 1.1],
    ];
    const H = homographyMatrix(st.corners);
    expect(H[6]).toBe(0);
    expect(H[7]).toBe(0);
    const [x, y] = applyHomography(st, 0.5, 0.5);
    expect(x).toBeCloseTo(0.7, 12); // affine centre = mean of corners
    expect(y).toBeCloseTo(0.65, 12);
  });
});

describe('cylinder model', () => {
  it('projector on the axis, aimed at the wall centre: centre maps to the principal point, symmetric in u', () => {
    const c = defaultCylinder();
    c.enabled = true;
    const [x, y] = cylinderProject(c, 16 / 9, 0.5, 0.5);
    expect(x).toBeCloseTo(0.5, 12);
    expect(y).toBeCloseTo(0.5, 12);
    const l = cylinderProject(c, 16 / 9, 0.25, 0.3);
    const r = cylinderProject(c, 16 / 9, 0.75, 0.3);
    expect(l[0] + r[0]).toBeCloseTo(1, 12);
    expect(l[1]).toBeCloseTo(r[1], 12);
  });

  it('a projector beyond the axis sees the arc ends closer: magnification drops there, so the raster spends more pixels per metre of wall at the ends', () => {
    // Brief's rig: projector on the far side of the axis, ends nearer
    // than the centre. Equal steps in content u are equal arc lengths on
    // the wall, so the model's raster spacing IS the correction layer 2
    // applies. Analytically dx/dθ ∝ (1 + a·cosθ)/(cosθ + a)² with
    // a = −pz/R: for a below ~2 the ends take MORE raster than the centre
    // (perspective wins); for large a it flips to less (the orthographic
    // limit, where only the arc's cosθ foreshortening remains).
    const c = defaultCylinder();
    c.pos = [0, 1, -1.5]; // a = 0.5
    c.throwRatio = 1.1;
    const x = (u: number) => cylinderProject(c, 16 / 9, u, 0.5)[0];
    const centreCell = x(0.55) - x(0.45);
    const endCell = x(1.0) - x(0.9);
    expect(endCell).toBeGreaterThan(centreCell * 1.2);
    c.pos = [0, 1, -9]; // a = 3: far projector, ends compress
    expect(x(1.0) - x(0.9)).toBeLessThan((x(0.55) - x(0.45)) * 0.97);
    c.pos = [0, 1, -1.5];
    // an equal-raster-spacing warp is exactly what layer 2 must undo, so the
    // forward map is monotonic and invertible along the arc
    for (let k = 0; k < 10; k++) expect(x((k + 1) / 10)).toBeGreaterThan(x(k / 10));
  });

  it('Newton inverse recovers the content point from a raster position (with lens shift + distortion)', () => {
    const c = defaultCylinder();
    c.pos = [0.2, 0.4, -0.8];
    c.yaw = 3;
    c.pitch = 12;
    c.roll = -1;
    c.lensOffset = 0.6;
    c.k1 = -0.05;
    c.k2 = 0.01;
    const f = (u: number, v: number) => cylinderProject(c, 1200 / 1920, u, v);
    for (const [u, v] of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.93, 0.87],
    ]) {
      const [x, y] = f(u, v);
      const [u2, v2] = invertMap(f, x, y, [0.5, 0.5]);
      expect(u2).toBeCloseTo(u, 8);
      expect(v2).toBeCloseTo(v, 8);
    }
  });
});

describe('composed stack', () => {
  it('with both model layers off, the pipeline is exactly the old fence→bezier chain', () => {
    const r = region();
    r.bezier.points[(2 * 5 + 2) * 2] += 0.07;
    r.fence.posts[0].top = 0.05;
    for (const [u, v] of [
      [0, 0],
      [0.3, 0.8],
      [1, 1],
      [0.5, 0.5],
    ]) {
      const f = fenceTransform(r.fence, u, v);
      const old = evalBezier(r.bezier, f[0], f[1]);
      expect(composedPoint(r, 16 / 9, u, v)).toEqual(old);
    }
  });

  it('residual is a displacement: identity lattice passes the model through exactly', () => {
    const r = region();
    r.homography.enabled = true;
    r.homography.corners[1] = [0.95, 0.1];
    r.cylinder.enabled = true;
    for (const [u, v] of [
      [0.2, 0.1],
      [0.5, 0.5],
      [0.9, 0.95],
    ]) {
      const m = modelPoint(r, 16 / 9, u, v);
      const p = composedPoint(r, 16 / 9, u, v);
      expect(p[0]).toBeCloseTo(m[0], 9);
      expect(p[1]).toBeCloseTo(m[1], 9);
    }
  });

  it('toggling a layer off and on returns the exact prior state', () => {
    const r = region();
    r.homography.enabled = true;
    r.homography.corners[2] = [1.2, 0.9];
    r.cylinder.enabled = true;
    r.cylinder.yaw = 7;
    const before = JSON.stringify(r);
    const p0 = composedPoint(r, 16 / 9, 0.37, 0.61);
    for (const key of ['homography', 'cylinder'] as const) {
      r[key].enabled = false;
      expect(composedPoint(r, 16 / 9, 0.37, 0.61)).not.toEqual(p0);
      r[key].enabled = true;
    }
    r.residualEnabled = false;
    r.residualEnabled = true;
    expect(JSON.stringify(r)).toBe(before);
    expect(composedPoint(r, 16 / 9, 0.37, 0.61)).toEqual(p0);
  });
});
