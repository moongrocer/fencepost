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
    for (const n of [3, 5, 9, 17]) {
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
