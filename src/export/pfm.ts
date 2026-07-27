/**
 * PFM (Portable Float Map) encode/decode.
 *
 * MPCDI geometry warp files are 3-channel PFMs:
 *   - header: "PF\n<width> <height>\n<scale>\n" (ASCII)
 *   - scale is negative for little-endian data => we always write -1.0
 *   - pixel data: rows stored BOTTOM-TO-TOP, left-to-right, 3 x float32
 *   - channels: R = u, G = v (absolute source UV, origin bottom-left per
 *     the PFM/MPCDI convention), B = 0.0
 *
 * The caller hands us data already in bottom-to-top row order (this falls
 * out naturally from glReadPixels, whose origin is also bottom-left).
 */

export interface PfmImage {
  width: number;
  height: number;
  scale: number;
  /** rgb triples, rows bottom-to-top */
  data: Float32Array;
}

export function encodePFM(width: number, height: number, rgbBottomUp: Float32Array): Uint8Array {
  if (rgbBottomUp.length !== width * height * 3) {
    throw new Error('encodePFM: data length must be width*height*3');
  }
  const header = `PF\n${width} ${height}\n-1.0\n`;
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(headerBytes.length + rgbBottomUp.length * 4);
  out.set(headerBytes, 0);
  const dv = new DataView(out.buffer, headerBytes.length);
  for (let i = 0; i < rgbBottomUp.length; i++) {
    dv.setFloat32(i * 4, rgbBottomUp[i], true); // explicit little-endian
  }
  return out;
}

export function decodePFM(bytes: Uint8Array): PfmImage {
  // Parse the three whitespace-terminated header tokens.
  let pos = 0;
  const readToken = (): string => {
    while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]))) pos++;
    let s = '';
    while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]))) {
      s += String.fromCharCode(bytes[pos++]);
    }
    pos++; // consume the single whitespace terminator
    return s;
  };
  const magic = readToken();
  if (magic !== 'PF') throw new Error(`decodePFM: bad magic "${magic}" (only 3-channel PF supported)`);
  const width = parseInt(readToken(), 10);
  const height = parseInt(readToken(), 10);
  const scale = parseFloat(readToken());
  const little = scale < 0;
  const count = width * height * 3;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + pos);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = dv.getFloat32(i * 4, little);
  return { width, height, scale, data };
}
