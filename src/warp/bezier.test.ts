import { describe, expect, it } from 'vitest';
import {
  createBezierGrid,
  evalBezier,
  insertColumn,
  insertRow,
  subdivideAfterColumn,
} from './bezier';

describe('bezier grid (B-spline surface)', () => {
  it('fresh grid is the identity map (control points at Greville abscissae)', () => {
    for (const n of [2, 3, 5, 9, 17]) {
      const g = createBezierGrid(n, n);
      for (let k = 0; k <= 10; k++) {
        const u = k / 10;
        const v = ((k * 7) % 11) / 10;
        const [x, y] = evalBezier(g, u, v);
        expect(x).toBeCloseTo(u, 9);
        expect(y).toBeCloseTo(v, 9);
      }
    }
  });

  it('2x2 grid is a degree-1 bilinear corner pin (no spline interpolation)', () => {
    const g = createBezierGrid(2, 2);
    expect(g.degreeU).toBe(1);
    expect(g.degreeV).toBe(1);
    // corners are the control points themselves
    expect(evalBezier(g, 0, 0)).toEqual([0, 0]);
    expect(evalBezier(g, 1, 1)[0]).toBeCloseTo(1, 12);

    // drag the top-right corner: result must be EXACTLY bilinear
    const k = (0 * 2 + 1) * 2; // i=1, j=0
    g.points[k] = 1.3;
    g.points[k + 1] = -0.1;
    const corner = (i: number, j: number): [number, number] => {
      const m = (j * 2 + i) * 2;
      return [g.points[m], g.points[m + 1]];
    };
    for (const [u, v] of [
      [0.25, 0.25],
      [0.5, 0.5],
      [0.75, 0.2],
      [0.1, 0.9],
    ] as const) {
      const [p00, p10, p01, p11] = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
      const bx =
        (1 - u) * (1 - v) * p00[0] + u * (1 - v) * p10[0] + (1 - u) * v * p01[0] + u * v * p11[0];
      const by =
        (1 - u) * (1 - v) * p00[1] + u * (1 - v) * p10[1] + (1 - u) * v * p01[1] + u * v * p11[1];
      const [x, y] = evalBezier(g, u, v);
      expect(x).toBeCloseTo(bx, 12);
      expect(y).toBeCloseTo(by, 12);
    }
  });

  it('knot insertion preserves the surface exactly', () => {
    let g = createBezierGrid(5, 5);
    // Deterministic pseudo-random distortion of every control point.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < g.points.length; i++) g.points[i] += (rand() - 0.5) * 0.2;

    const samples: Array<[number, number, number, number]> = [];
    for (let a = 0; a <= 12; a++) {
      for (let b = 0; b <= 12; b++) {
        const u = a / 12;
        const v = b / 12;
        const [x, y] = evalBezier(g, u, v);
        samples.push([u, v, x, y]);
      }
    }

    let g2 = insertColumn(g, 0.37);
    g2 = insertRow(g2, 0.61);
    g2 = insertColumn(g2, 0.37 + 1e-3); // near-duplicate knot still exact
    expect(g2.cols).toBe(7);
    expect(g2.rows).toBe(6);

    for (const [u, v, x, y] of samples) {
      const [x2, y2] = evalBezier(g2, u, v);
      expect(x2).toBeCloseTo(x, 10);
      expect(y2).toBeCloseTo(y, 10);
    }
  });

  it('subdivideAfterColumn inserts between the right Greville abscissae', () => {
    const g = createBezierGrid(5, 5);
    const g2 = subdivideAfterColumn(g, 1);
    expect(g2).not.toBeNull();
    expect(g2!.cols).toBe(6);
    expect(subdivideAfterColumn(g, 4)).toBeNull(); // last column has no band
    // still identity after subdividing an identity grid
    const [x, y] = evalBezier(g2!, 0.3, 0.8);
    expect(x).toBeCloseTo(0.3, 9);
    expect(y).toBeCloseTo(0.8, 9);
  });
});
