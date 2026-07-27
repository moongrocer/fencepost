import { describe, expect, it } from 'vitest';
import { decodePFM, encodePFM } from './pfm';
import { buildMpcdiXml } from './mpcdi-xml';

describe('PFM byte layout', () => {
  it('writes the canonical little-endian header', () => {
    const data = new Float32Array(2 * 2 * 3).fill(0.5);
    const bytes = encodePFM(2, 2, data);
    const header = new TextDecoder().decode(bytes.subarray(0, 11));
    expect(header).toBe('PF\n2 2\n-1.0');
    expect(bytes[11]).toBe(0x0a);
    expect(bytes.length).toBe(12 + 2 * 2 * 3 * 4);
  });

  it('stores float32 little-endian directly after the header', () => {
    const data = new Float32Array([1.0, 0, 0, 0, 0, 0]);
    const bytes = encodePFM(2, 1, data);
    const headerLen = 'PF\n2 1\n-1.0\n'.length;
    // 1.0f little-endian = 00 00 80 3F
    expect(Array.from(bytes.subarray(headerLen, headerLen + 4))).toEqual([0x00, 0x00, 0x80, 0x3f]);
  });

  it('round-trips data and dimensions', () => {
    const w = 5;
    const h = 3;
    const data = new Float32Array(w * h * 3);
    for (let i = 0; i < data.length; i++) data[i] = Math.fround(Math.sin(i) * 2);
    const img = decodePFM(encodePFM(w, h, data));
    expect(img.width).toBe(w);
    expect(img.height).toBe(h);
    expect(img.scale).toBeLessThan(0);
    expect(Array.from(img.data)).toEqual(Array.from(data));
  });

  it('rejects bad data lengths', () => {
    expect(() => encodePFM(2, 2, new Float32Array(5))).toThrow();
  });
});

describe('mpcdi.xml structure', () => {
  it('contains the required v2 2d-profile elements and attributes', () => {
    const xml = buildMpcdiXml({
      name: 'test',
      regionId: 'region0',
      width: 1920,
      height: 1080,
      date: '2026-06-12',
      hasAlpha: true,
      hasBeta: true,
      warpPath: 'warp.pfm',
      alphaPath: 'alpha.png',
      betaPath: 'beta.png',
    });
    expect(xml).toContain('version="2.0"');
    expect(xml).toContain('profile="2d"');
    expect(xml).toContain('<buffer id="buffer0" Xresolution="1920" Yresolution="1080">');
    expect(xml).toContain('region id="region0"');
    expect(xml).toContain('xsize="1.0"');
    expect(xml).toContain('<fileset region="region0">');
    expect(xml).toContain('<geometryWarpFile>');
    expect(xml).toContain('<geometricUnit>2d</geometricUnit>');
    expect(xml).toContain('<path>warp.pfm</path>');
    expect(xml).toContain('<alphaMap bitdepth="8">');
    expect(xml).toContain('<betaMap bitdepth="8">');
    // balanced tags (cheap well-formedness sanity check)
    for (const tag of ['MPCDI', 'display', 'buffer', 'files', 'fileset', 'geometryWarpFile']) {
      expect(xml.split(`</${tag}>`).length).toBe(2);
    }
  });

  it('omits alpha/beta when not present and escapes the region id', () => {
    const xml = buildMpcdiXml({
      name: 'x',
      regionId: 'a<b&c',
      width: 800,
      height: 600,
      date: 'd',
      hasAlpha: false,
      hasBeta: false,
      warpPath: 'warp.pfm',
      alphaPath: 'alpha.png',
      betaPath: 'beta.png',
    });
    expect(xml).not.toContain('alphaMap');
    expect(xml).not.toContain('betaMap');
    expect(xml).toContain('a&lt;b&amp;c');
  });
});
