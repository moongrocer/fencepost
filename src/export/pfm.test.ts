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

describe('mpcdi.xml structure (multi-region)', () => {
  const region = (id: string, x: number, alpha: boolean) => ({
    id,
    x,
    y: 0,
    xsize: 1 / 3,
    ysize: 1,
    resW: 1200,
    resH: 1920,
    warpPath: `warp_${id}.pfm`,
    alphaPath: alpha ? `alpha_${id}.png` : null,
    betaPath: null,
  });

  it('contains the required v2 2d-profile elements for every region', () => {
    const xml = buildMpcdiXml({
      name: 'test',
      width: 3600,
      height: 1920,
      date: '2026-06-28',
      regions: [region('region0', 0, true), region('region1', 1 / 3, true), region('region2', 2 / 3, false)],
    });
    expect(xml).toContain('version="2.0"');
    expect(xml).toContain('profile="2d"');
    expect(xml).toContain('<buffer id="buffer0" Xresolution="3600" Yresolution="1920">');
    for (const id of ['region0', 'region1', 'region2']) {
      expect(xml).toContain(`region id="${id}"`);
      expect(xml).toContain(`<fileset region="${id}">`);
      expect(xml).toContain(`<path>warp_${id}.pfm</path>`);
    }
    expect(xml).toContain('Xresolution="1200" Yresolution="1920"');
    expect(xml.split('<geometryWarpFile>').length).toBe(4); // 3 regions
    expect(xml.split('<alphaMap bitdepth="8">').length).toBe(3); // 2 with alpha
    expect(xml).not.toContain('betaMap');
    expect(xml).toContain('<geometricUnit>2d</geometricUnit>');
    // balanced tags (cheap well-formedness sanity check)
    for (const tag of ['MPCDI', 'display', 'buffer', 'files']) {
      expect(xml.split(`</${tag}>`).length).toBe(2);
    }
  });

  it('escapes region ids in XML', () => {
    const xml = buildMpcdiXml({
      name: 'x',
      width: 800,
      height: 600,
      date: 'd',
      regions: [{ ...region('r', 0, false), id: 'a<b&c' }],
    });
    expect(xml).toContain('a&lt;b&amp;c');
  });
});
