/**
 * Client-side archive assembly + download. An MPCDI archive is a plain ZIP
 * with mpcdi.xml and the referenced data files at the root; by convention
 * it ships with the .mpcdi extension. "Raw" export is the identical file
 * set in a normal .zip for pipelines that unpack manually.
 */
import { zipSync } from 'fflate';

export interface ArchiveFiles {
  xml: string;
  pfm: Uint8Array;
  alpha?: Uint8Array;
  beta?: Uint8Array;
  warpPath: string;
  alphaPath: string;
  betaPath: string;
}

export function buildArchive(f: ArchiveFiles): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'mpcdi.xml': new TextEncoder().encode(f.xml),
    [f.warpPath]: f.pfm,
  };
  if (f.alpha) entries[f.alphaPath] = f.alpha;
  if (f.beta) entries[f.betaPath] = f.beta;
  // PFM is float noise to DEFLATE; level 6 still wins on the PNGs/XML.
  return zipSync(entries, { level: 6 });
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/octet-stream'): void {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  downloadBytes(new TextEncoder().encode(text), filename, mime);
}
