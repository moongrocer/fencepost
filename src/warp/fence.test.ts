import { describe, expect, it } from 'vitest';
import { addPost, createFence, evalEdge, fenceTransform, removePost, setPostX } from './fence';

const numericSlope = (f: (x: number) => number, x: number, side: -1 | 1) => {
  const h = 1e-6;
  return side < 0 ? (f(x) - f(x - h)) / h : (f(x + h) - f(x)) / h;
};

describe('fence interpolation', () => {
  it('default fence is the identity', () => {
    const f = createFence();
    expect(fenceTransform(f, 0.3, 0.7)).toEqual([0.3, 0.7]);
  });

  it('edge curve interpolates the post edge points', () => {
    let f = createFence();
    f = addPost(f, 0.4);
    f.posts[1].top = 0.1;
    f.posts[1].bottom = 0.9;
    expect(evalEdge(f, 'top', 0.4)).toBeCloseTo(0.1, 12);
    expect(evalEdge(f, 'bottom', 0.4)).toBeCloseTo(0.9, 12);
    expect(evalEdge(f, 'top', 0)).toBeCloseTo(0, 12);
    expect(evalEdge(f, 'top', 1)).toBeCloseTo(0, 12);
  });

  it('smooth posts are C1, corner posts are C0 with a tangent break', () => {
    let f = createFence();
    f = addPost(f, 0.5);
    f.posts[1].top = 0.15; // a kink-worthy bump
    const top = (x: number) => evalEdge(f, 'top', x);

    // smooth: derivative continuous across the post
    const dl = numericSlope(top, 0.5, -1);
    const dr = numericSlope(top, 0.5, 1);
    expect(dl).toBeCloseTo(dr, 4);

    // corner: value continuous (C0) but derivative breaks
    f.posts[1].corner = true;
    const v = top(0.5);
    expect(top(0.5 - 1e-9)).toBeCloseTo(v, 6);
    expect(top(0.5 + 1e-9)).toBeCloseTo(v, 6);
    const cl = numericSlope(top, 0.5, -1);
    const cr = numericSlope(top, 0.5, 1);
    expect(Math.abs(cl - cr)).toBeGreaterThan(0.1);
  });

  it('interior is ruled between top and bottom edges', () => {
    let f = createFence();
    f = addPost(f, 0.5);
    f.posts[1].top = 0.2;
    f.posts[1].bottom = 0.8;
    const [u, y] = fenceTransform(f, 0.5, 0.5);
    expect(u).toBe(0.5);
    expect(y).toBeCloseTo((0.2 + 0.8) / 2, 12);
  });

  it('post management: add keeps order, boundaries are pinned', () => {
    let f = createFence();
    f = addPost(f, 0.7);
    f = addPost(f, 0.3);
    expect(f.posts.map((p) => p.x)).toEqual([0, 0.3, 0.7, 1]);
    expect(removePost(f, 0)).toBe(f); // boundary not removable
    expect(setPostX(f, 0, 0.2)).toBe(f); // boundary not movable
    f = setPostX(f, 1, 0.65); // clamped below post at 0.7
    expect(f.posts[1].x).toBeLessThan(0.7);
    f = removePost(f, 1);
    expect(f.posts.length).toBe(3);
  });
});
