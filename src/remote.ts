/**
 * Same-origin remote-control bridge (BroadcastChannel) — the transport for
 * camera-assisted calibration. A driving tab (or automated session) sends
 * commands; the display tab (fullscreen on the projector mosaic) executes
 * them: swap patterns, mask individual regions, flash raw raster-space
 * structured-light frames (bypassing the warp), grab webcam frames, run
 * gray-code measurement sweeps, and apply solved warps (undoable).
 *
 * Addressing: every instance answers `ping`; targeted commands carry the
 * destination instance id in `to`. Instances ignore messages addressed to
 * someone else, so a driving tab that is itself a FENCEPOST instance never
 * fights the display tab.
 */
import type { App } from './app';
import { serializeProject } from './state/project';
import { createFence } from './warp/fence';
import {
  CorrMap,
  grayBit,
  Intrinsics,
  scaleIntrinsics,
  solveRegion,
  undistortPoint,
} from './warp/calibrate';

const CHANNEL = 'fencepost-remote';
const CAM_PREF_KEY = 'fencepost.camera.attempt';
const REPORT_KEY = 'fencepost.calib.report';

interface RemoteMsg {
  id?: string;
  to?: string;
  cmd?: string;
  [k: string]: unknown;
}

interface FlashSpec {
  /** 'graycode' = binary stripe pattern in RASTER space; 'solid' = flat level */
  kind: 'graycode' | 'solid';
  axis?: 'x' | 'y';
  bit?: number;
  inverse?: boolean;
  level?: number; // 0..1 for solid
  /** restrict to one region's output slice (others black); omit = whole buffer */
  region?: number;
}

const instanceId = Math.random().toString(36).slice(2, 10);

let flashCanvas: HTMLCanvasElement | null = null;
let maskDiv: HTMLDivElement | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let grabCanvas: HTMLCanvasElement | null = null;

/** decoded correspondence maps per region index */
const corrMaps = new Map<number, CorrMap>();

function canvasRect(): DOMRect {
  const c = document.getElementById('gl-canvas');
  return c ? c.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
}

function ensureFlashCanvas(): HTMLCanvasElement {
  if (!flashCanvas) {
    flashCanvas = document.createElement('canvas');
    Object.assign(flashCanvas.style, {
      position: 'fixed',
      zIndex: '99990',
      pointerEvents: 'none',
    });
    document.body.appendChild(flashCanvas);
  }
  return flashCanvas;
}

function drawFlash(app: App, spec: FlashSpec): void {
  const r = canvasRect();
  const c = ensureFlashCanvas();
  c.style.left = `${r.left}px`;
  c.style.top = `${r.top}px`;
  c.style.width = `${r.width}px`;
  c.style.height = `${r.height}px`;
  c.style.display = 'block';
  // draw in framebuffer resolution for pixel-exact stripes
  const W = app.project.outputW;
  const H = app.project.outputH;
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  let x0 = 0;
  let x1 = W;
  let y0 = 0;
  let y1 = H;
  if (spec.region !== undefined) {
    const reg = app.project.regions[spec.region];
    if (reg) {
      x0 = Math.round(reg.rect.x * W);
      x1 = Math.round((reg.rect.x + reg.rect.w) * W);
      y0 = Math.round(reg.rect.y * H);
      y1 = Math.round((reg.rect.y + reg.rect.h) * H);
    }
  }

  if (spec.kind === 'solid') {
    const l = Math.round(255 * Math.min(1, Math.max(0, spec.level ?? 1)));
    ctx.fillStyle = `rgb(${l},${l},${l})`;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    return;
  }

  // graycode stripes, region-local raster coordinates
  const bit = spec.bit ?? 0;
  const inv = spec.inverse ? 1 : 0;
  const w = x1 - x0;
  const h = y1 - y0;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = spec.axis === 'y' ? y : x;
      const on = grayBit(v, bit) ^ inv;
      const k = (y * w + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = on ? 255 : 0;
      d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, y0);
}

function clearFlash(): void {
  if (flashCanvas) flashCanvas.style.display = 'none';
}

function setMask(app: App, region: number | null): void {
  if (region === null) {
    if (maskDiv) maskDiv.style.display = 'none';
    return;
  }
  const reg = app.project.regions[region];
  if (!reg) return;
  if (!maskDiv) {
    maskDiv = document.createElement('div');
    Object.assign(maskDiv.style, {
      position: 'fixed',
      background: '#000',
      zIndex: '99991',
      pointerEvents: 'none',
    });
    document.body.appendChild(maskDiv);
  }
  const r = canvasRect();
  maskDiv.style.left = `${r.left + reg.rect.x * r.width}px`;
  maskDiv.style.top = `${r.top + reg.rect.y * r.height}px`;
  maskDiv.style.width = `${reg.rect.w * r.width}px`;
  maskDiv.style.height = `${reg.rect.h * r.height}px`;
  maskDiv.style.display = 'block';
}

async function ensureCamera(deviceId?: string): Promise<HTMLVideoElement> {
  if (video && stream?.active) return video;
  // Some UVC devices stall negotiating 4K (or are simply busy). Try the
  // preferred mode first, then progressively loosen instead of failing.
  // The successful attempt index is cached so reloads reconnect fast.
  const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
  const attempts: MediaTrackConstraints[] = [
    { width: { ideal: 3840 }, height: { ideal: 2160 }, ...dev },
    { width: { ideal: 1920 }, height: { ideal: 1080 }, ...dev },
    { ...dev },
    {},
  ];
  const start = Math.min(Number(localStorage.getItem(CAM_PREF_KEY) ?? 0) || 0, attempts.length - 1);
  let lastErr: unknown = null;
  stream = null;
  for (let i = start; i < attempts.length; i++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: attempts[i] });
      try {
        localStorage.setItem(CAM_PREF_KEY, String(i));
      } catch {
        /* ignore */
      }
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!stream) throw lastErr ?? new Error('camera unavailable');
  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (video.readyState < 2) {
    await new Promise<void>((res) => video!.addEventListener('loadeddata', () => res(), { once: true }));
  }
  return video;
}

function captureFrame(maxW?: number): { canvas: HTMLCanvasElement; w: number; h: number } {
  if (!video) throw new Error('camera not started');
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = maxW && maxW < vw ? maxW / vw : 1;
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(video, 0, 0, w, h);
  return { canvas: c, w, h };
}

/** grab the current camera frame as luma (reuses one canvas) */
function grabLuma(): { w: number; h: number; luma: Float32Array } {
  if (!video) throw new Error('camera not started');
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!grabCanvas) grabCanvas = document.createElement('canvas');
  if (grabCanvas.width !== w || grabCanvas.height !== h) {
    grabCanvas.width = w;
    grabCanvas.height = h;
  }
  const ctx = grabCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const luma = new Float32Array(w * h);
  for (let i = 0; i < luma.length; i++) {
    const k = i * 4;
    luma[i] = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
  }
  return { w, h, luma };
}

const nextPaint = (): Promise<void> =>
  new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Gray-code measurement sweep for one region: flash bit patterns +
 * inverses, decode per camera pixel to REGION-LOCAL raster coordinates.
 */
async function measureRegion(
  app: App,
  region: number,
  settleMs: number,
  minContrast: number,
): Promise<{ valid: number; total: number }> {
  const reg = app.project.regions[region];
  if (!reg) throw new Error(`no region ${region}`);
  const W = app.project.outputW;
  const H = app.project.outputH;
  const rw = Math.round(reg.rect.w * W);
  const rh = Math.round(reg.rect.h * H);

  const first = grabLuma(); // also fixes dimensions
  const n = first.w * first.h;
  const decoded: { x?: Uint32Array; y?: Uint32Array } = {};
  const conf = new Float32Array(n);
  let bitsTotal = 0;

  for (const axis of ['x', 'y'] as const) {
    const dim = axis === 'x' ? rw : rh;
    const bits = Math.ceil(Math.log2(dim));
    const gray = new Uint8Array(n); // running gray->binary accumulator
    const out = new Uint32Array(n);
    for (let bit = bits - 1; bit >= 0; bit--) {
      drawFlash(app, { kind: 'graycode', axis, bit, region });
      await nextPaint();
      await sleep(settleMs);
      const pat = grabLuma().luma;
      drawFlash(app, { kind: 'graycode', axis, bit, inverse: true, region });
      await nextPaint();
      await sleep(settleMs);
      const inv = grabLuma().luma;
      for (let i = 0; i < n; i++) {
        const diff = pat[i] - inv[i];
        conf[i] += Math.abs(diff);
        const g = diff > 0 ? 1 : 0;
        gray[i] ^= g;
        out[i] = (out[i] << 1) | gray[i];
      }
      bitsTotal++;
    }
    decoded[axis] = out;
  }
  clearFlash();

  const rasterX = new Float32Array(n).fill(NaN);
  const rasterY = new Float32Array(n).fill(NaN);
  let valid = 0;
  const thr = minContrast * bitsTotal;
  for (let i = 0; i < n; i++) {
    const dx = decoded.x![i];
    const dy = decoded.y![i];
    if (conf[i] < thr || dx >= rw || dy >= rh) continue;
    rasterX[i] = dx;
    rasterY[i] = dy;
    valid++;
  }
  corrMaps.set(region, { w: first.w, h: first.h, rasterX, rasterY });
  return { valid, total: n };
}

/** Undistorted-camera-space bounding box of a measured region's footprint. */
function footprint(
  m: CorrMap,
  intr: Intrinsics,
): { u1: number; u99: number; v1: number; v99: number; count: number } {
  const us: number[] = [];
  const vs: number[] = [];
  for (let y = 0; y < m.h; y += 3) {
    for (let x = 0; x < m.w; x += 3) {
      if (Number.isNaN(m.rasterX[y * m.w + x])) continue;
      const [u, v] = undistortPoint(intr, x, y);
      us.push(u);
      vs.push(v);
    }
  }
  if (us.length < 50) throw new Error('footprint: too few valid pixels');
  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { u1: pct(us, 0.01), u99: pct(us, 0.99), v1: pct(vs, 0.01), v99: pct(vs, 0.99), count: us.length };
}

/**
 * Largest target rect (undistorted camera space) that BOTH projectors can
 * physically cover, given each region's content window. Horizontal is a
 * tiny 2-var LP solved by scanning the left edge; vertical is a direct
 * intersection since every region spans the full content height.
 */
function chooseTarget(
  fps: Array<{ u1: number; u99: number; v1: number; v99: number }>,
  srcs: Array<{ x: number; y: number; w: number; h: number }>,
  insetFrac: number,
): { x: number; y: number; w: number; h: number } {
  const lo = Math.min(...fps.map((f) => f.u1));
  const hi = Math.max(...fps.map((f) => f.u99));
  let best: { x: number; w: number } | null = null;
  const STEPS = 400;
  for (let s = 0; s <= STEPS; s++) {
    const X = lo + ((hi - lo) * s) / STEPS;
    // W must satisfy, for every region i covering content [a_i, b_i]:
    //   X + a_i*W >= f_i.u1   and   X + b_i*W <= f_i.u99
    let wMax = Infinity;
    let wMin = 0;
    let feasible = true;
    for (let i = 0; i < fps.length; i++) {
      const a = srcs[i].x;
      const b = srcs[i].x + srcs[i].w;
      if (b > 1e-9) wMax = Math.min(wMax, (fps[i].u99 - X) / b);
      else if (X > fps[i].u99) feasible = false;
      if (a > 1e-9) wMin = Math.max(wMin, (fps[i].u1 - X) / a);
      else if (X < fps[i].u1) feasible = false;
    }
    if (!feasible || !(wMax > 0) || wMin > wMax) continue;
    if (!best || wMax > best.w) best = { x: X, w: wMax };
  }
  if (!best) throw new Error('no feasible target rect — do the beams overlap as configured?');
  const y = Math.max(...fps.map((f) => f.v1));
  const y1 = Math.min(...fps.map((f) => f.v99));
  if (y1 <= y) throw new Error('no vertical overlap between projector footprints');
  const ins = insetFrac;
  return {
    x: best.x + best.w * ins,
    y: y + (y1 - y) * ins,
    w: best.w * (1 - 2 * ins),
    h: (y1 - y) * (1 - 2 * ins),
  };
}

/**
 * Fully autonomous calibration run, so it can execute with no debugger
 * attached (a devtools/automation banner changes the window's client
 * height, which would otherwise be baked into the solve). Progress and
 * results land in localStorage for later pickup.
 */
async function runAll(
  app: App,
  opts: { intr: Intrinsics; delayMs: number; settleMs: number; insetFrac: number; waitMs?: number },
): Promise<void> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] };
  const steps = report.steps as unknown[];
  const save = () => {
    try {
      localStorage.setItem(REPORT_KEY, JSON.stringify(report));
    } catch {
      /* ignore */
    }
  };
  const note = (s: unknown) => {
    steps.push(s);
    save();
  };
  try {
    await sleep(opts.delayMs);
    // Wait for a clean display state: true fullscreen AND no automation /
    // devtools banner stealing client height. Calibrating against either
    // would bake that offset into the warp and break when it goes away.
    const deadline = Date.now() + (opts.waitMs ?? 300000);
    let waited = 0;
    for (;;) {
      const clean = !!document.fullscreenElement && innerHeight >= screen.height - 8;
      if (clean) break;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for clean fullscreen (fullscreen=${!!document
            .fullscreenElement}, innerH=${innerHeight}, screenH=${screen.height})`,
        );
      }
      await sleep(1000);
      waited++;
    }
    report.geom = { innerW: innerWidth, innerH: innerHeight, rect: canvasRect().toJSON(), waitedSec: waited };
    note({ step: 'start', fullscreen: true, waitedSec: waited });

    const v = await ensureCamera();
    const intr = scaleIntrinsics(opts.intr, v.videoWidth / 3840, v.videoHeight / 2160);
    report.capture = { w: v.videoWidth, h: v.videoHeight };
    note({ step: 'camera', w: v.videoWidth, h: v.videoHeight });

    const n = app.project.regions.length;
    const fps: Array<{ u1: number; u99: number; v1: number; v99: number }> = [];
    for (let i = 0; i < n; i++) {
      const res = await measureRegion(app, i, opts.settleMs, 10);
      const fp = footprint(corrMaps.get(i)!, intr);
      fps.push(fp);
      note({ step: 'measure', region: i, ...res, footprint: fp });
    }

    const target = chooseTarget(
      fps,
      app.project.regions.map((r) => r.src),
      opts.insetFrac,
    );
    report.target = target;
    note({ step: 'target', target });

    const clone = JSON.parse(serializeProject(app.project));
    for (let i = 0; i < n; i++) {
      const reg = app.project.regions[i];
      const res = solveRegion({
        map: corrMaps.get(i)!,
        intr,
        target,
        src: reg.src,
        regionW: reg.rect.w * app.project.outputW,
        regionH: reg.rect.h * app.project.outputH,
        grid: reg.bezier,
      });
      clone.regions[i].bezier = { ...clone.regions[i].bezier, points: res.points };
      clone.regions[i].fence = createFence();
      // the solve owns the full geometry: parametric layers off, residual on
      clone.regions[i].homography.enabled = false;
      clone.regions[i].cylinder.enabled = false;
      clone.regions[i].residualEnabled = true;
      note({
        step: 'solve',
        region: i,
        rmsPx: res.rmsPx,
        samples: res.samples,
        inliers: res.inliers,
        outliers: res.outliers,
        lowCoverage: res.lowCoverage,
      });
    }
    app.applyProjectJson(JSON.stringify(clone));
    note({ step: 'applied' });

    // verification stills: grid, then a flat white field for the seam
    app.setPattern('grid');
    await nextPaint();
    await sleep(600);
    report.verifyGrid = captureFrame(1280).canvas.toDataURL('image/jpeg', 0.7);
    save();
    app.setPattern('solid');
    await nextPaint();
    await sleep(600);
    report.verifyWhite = captureFrame(1280).canvas.toDataURL('image/jpeg', 0.7);
    app.setPattern('grid');
    report.done = true;
    note({ step: 'done' });
  } catch (e) {
    report.error = String(e);
    report.done = true;
    clearFlash();
    save();
  }
}

export function initRemote(app: App): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(CHANNEL);

  const reply = (msg: RemoteMsg, data: Record<string, unknown>): void => {
    ch.postMessage({ re: msg.id, from: instanceId, ok: true, ...data });
  };
  const fail = (msg: RemoteMsg, err: unknown): void => {
    ch.postMessage({ re: msg.id, from: instanceId, ok: false, error: String(err) });
  };

  ch.onmessage = (ev: MessageEvent<RemoteMsg>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object' || !msg.cmd) return;
    if (msg.to && msg.to !== instanceId) return;
    void (async () => {
      try {
        switch (msg.cmd) {
          case 'ping':
            reply(msg, {
              fullscreen: !!document.fullscreenElement,
              innerW: innerWidth,
              innerH: innerHeight,
              screenW: screen.width,
              screenH: screen.height,
              dpr: devicePixelRatio,
              canvas: canvasRect().toJSON(),
              regions: app.project.regions.length,
              outputW: app.project.outputW,
              outputH: app.project.outputH,
              measured: [...corrMaps.keys()],
            });
            break;
          /** Kick off an autonomous run, then reply immediately. */
          case 'runAll':
            void runAll(app, {
              intr: msg.intr as Intrinsics,
              delayMs: (msg.delayMs as number) ?? 20000,
              settleMs: (msg.settleMs as number) ?? 350,
              insetFrac: (msg.insetFrac as number) ?? 0.02,
              waitMs: (msg.waitMs as number) ?? 300000,
            });
            reply(msg, { scheduled: true });
            break;
          case 'report': {
            const raw = localStorage.getItem(REPORT_KEY);
            if (!raw) {
              reply(msg, { report: null });
              break;
            }
            const rep = JSON.parse(raw) as Record<string, unknown>;
            if (!msg.withImages) {
              delete rep.verifyGrid;
              delete rep.verifyWhite;
            }
            reply(msg, { report: rep });
            break;
          }
          case 'reportImage': {
            const raw = localStorage.getItem(REPORT_KEY);
            const rep = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            reply(msg, { image: rep[msg.which as string] ?? null });
            break;
          }
          case 'state':
            reply(msg, { json: serializeProject(app.project) });
            break;
          case 'apply':
            app.applyProjectJson(String(msg.json));
            reply(msg, {});
            break;
          case 'pattern': {
            const id = msg.patternId as never;
            app.setPattern(id);
            reply(msg, {});
            break;
          }
          case 'mask':
            setMask(app, (msg.region ?? null) as number | null);
            reply(msg, {});
            break;
          case 'flash':
            if (msg.spec) drawFlash(app, msg.spec as FlashSpec);
            else clearFlash();
            reply(msg, {});
            break;
          case 'devices': {
            const devs = await navigator.mediaDevices.enumerateDevices();
            reply(msg, {
              devices: devs
                .filter((d) => d.kind === 'videoinput')
                .map((d) => ({ id: d.deviceId, label: d.label })),
            });
            break;
          }
          case 'camera': {
            const v = await ensureCamera(msg.deviceId as string | undefined);
            reply(msg, { w: v.videoWidth, h: v.videoHeight });
            break;
          }
          case 'capture': {
            const full = captureFrame();
            if (msg.preview) {
              const prev = captureFrame((msg.previewW as number) || 960);
              reply(msg, {
                w: full.w,
                h: full.h,
                preview: prev.canvas.toDataURL('image/jpeg', 0.75),
              });
            } else {
              reply(msg, { w: full.w, h: full.h });
            }
            break;
          }
          case 'measure': {
            const res = await measureRegion(
              app,
              (msg.region as number) ?? 0,
              (msg.settleMs as number) ?? 400,
              (msg.minContrast as number) ?? 10,
            );
            reply(msg, res as unknown as Record<string, unknown>);
            break;
          }
          /** Undistorted-camera-space bounds of a measured region's footprint. */
          case 'footprint': {
            const m = corrMaps.get((msg.region as number) ?? 0);
            if (!m) throw new Error('region not measured');
            const intr = msg.intr as Intrinsics;
            const us: number[] = [];
            const vs: number[] = [];
            for (let y = 0; y < m.h; y += 4) {
              for (let x = 0; x < m.w; x += 4) {
                if (Number.isNaN(m.rasterX[y * m.w + x])) continue;
                const [u, v] = undistortPoint(intr, x, y);
                us.push(u);
                vs.push(v);
              }
            }
            us.sort((a, b) => a - b);
            vs.sort((a, b) => a - b);
            const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
            reply(msg, {
              count: us.length,
              u1: pct(us, 0.01),
              u99: pct(us, 0.99),
              v1: pct(vs, 0.01),
              v99: pct(vs, 0.99),
            });
            break;
          }
          /**
           * Solve measured regions against a target rect (undistorted camera
           * space) and apply the new warps in ONE undoable project update.
           * Resets the solved regions' fences to identity (the solve owns
           * the full geometry; fence stays available as a manual trim).
           */
          case 'solveApply': {
            const intr = msg.intr as Intrinsics;
            const target = msg.target as { x: number; y: number; w: number; h: number };
            const regionIdxs = (msg.regions as number[]) ?? [...corrMaps.keys()];
            const clone = JSON.parse(serializeProject(app.project));
            const stats: Record<string, unknown>[] = [];
            for (const idx of regionIdxs) {
              const m = corrMaps.get(idx);
              if (!m) throw new Error(`region ${idx} not measured`);
              const reg = app.project.regions[idx];
              const res = solveRegion({
                map: m,
                intr,
                target,
                src: reg.src,
                regionW: reg.rect.w * app.project.outputW,
                regionH: reg.rect.h * app.project.outputH,
                grid: reg.bezier,
              });
              clone.regions[idx].bezier = { ...clone.regions[idx].bezier, points: res.points };
              clone.regions[idx].fence = createFence();
              clone.regions[idx].homography.enabled = false;
              clone.regions[idx].cylinder.enabled = false;
              clone.regions[idx].residualEnabled = true;
              stats.push({
                region: idx,
                rmsPx: res.rmsPx,
                samples: res.samples,
                inliers: res.inliers,
                outliers: res.outliers,
                lowCoverage: res.lowCoverage,
              });
            }
            app.applyProjectJson(JSON.stringify(clone));
            reply(msg, { stats });
            break;
          }
          default:
            fail(msg, `unknown cmd ${msg.cmd}`);
        }
      } catch (e) {
        fail(msg, e);
      }
    })();
  };
}
