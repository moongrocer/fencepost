# FENCEPOST

Browser-based manual projector calibration with MPCDI v2 export. One window
is both the editor and the clean projector feed: render a test pattern (or
your own still frames) through a live-editable two-layer warp, dial in the
geometry while watching the projection, then export a standards-conformant
MPCDI v2.0 archive. Pure client-side TypeScript + WebGL2 — no server.

```
npm install
npm run dev      # editor at http://localhost:5173
npm test         # math/export unit tests (vitest)
npm run build    # typecheck + production bundle in dist/
```

## The warp stack

Pipeline: **source UV → fence → bezier → screen.**

- **Fence (layer 1)** — vertical "posts" slice the image into boards. Each
  post carries independently movable top/bottom edge points; edges
  interpolate C1 (Catmull-Rom-style Hermite) between posts, or C0 at posts
  toggled to "hard/corner". Board interiors are ruled fills between the
  curved edges. Posts drag horizontally to set strip widths.
- **Bezier grid (layer 2)** — a clamped bicubic B-spline surface
  (3×3…17×17 control points). Local subdivision is exact Boehm knot
  insertion: adding a row/column never moves the surface. A fresh grid is
  exactly the identity (control points at Greville abscissae).

The composed warp is rendered through a high-tessellation mesh (129×129;
257×257 for export sampling) — no visible faceting.

## Keyboard

| Key | Action |
| --- | --- |
| TAB | Output mode (clean feed, all UI hidden) |
| F | Fullscreen (auto-enters calibrate mode) |
| H | Hide / show floating palette (calibrate mode) |
| Arrows / Shift+Arrows | Nudge selection 4 px / 0.25 px |
| 1–7 | Test pattern (5 cycles white/gray/black) |
| PgUp / PgDn | Cycle patterns + loaded stills |
| B / G / W | Toggle bezier / fence / wireframe overlays |
| C | Toggle hard corner on selected post |
| Delete | Remove selected post |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (snapshots, unlimited-ish) |
| Ctrl+S / Ctrl+E | Save project JSON / export MPCDI |
| ? | Help overlay |

Drag points with the mouse; rubber-band or shift-click for multi-select.
Drop PNG/JPEG files anywhere to load content stills.

## Using it on a projector

Three view states:

- **Edit (windowed)** — the docked LightWave layout, for desk setup.
- **Calibrate** — canvas fills the whole window 1:1 with the projector
  raster *and editing stays live*; the tool column becomes a floating,
  draggable, collapsible palette so it never blocks the area you're warping.
- **Output (TAB)** — bare warped image, every control hidden: the clean feed.

Workflow: drag the browser window onto the projector display, press **F**
to go fullscreen — this auto-enters calibrate mode. Set the output
resolution (EXPORT tab) to the projector's native resolution so the test
pattern stays square. Now warp the full surface; shove the palette aside
(drag its header), collapse it (▾), or hide it entirely (**H** / ×, brought
back by the corner **▸ TOOLS** chip). Press **TAB** any time for the clean
feed, **F** again to exit. Leaving fullscreen restores the docked layout.

## MPCDI v2 export

`Export .mpcdi Archive` produces a ZIP (profile `2d`, level 1) containing:

- `mpcdi.xml` — display/buffer/region at the configured resolution, file
  references with `geometricUnit` and `gammaEmbedded` (schema notes are in
  [src/export/mpcdi-xml.ts](src/export/mpcdi-xml.ts)).
- `warp.pfm` — 3-channel float32 PFM, little-endian (negative scale),
  rows bottom-to-top, absolute source UV per output pixel (R=u, G=v, B=0;
  uncovered pixels are −1). Sampled on the GPU by rasterizing the warp
  mesh's UVs at output resolution.
- `alpha.png` / `beta.png` — 8-bit grayscale blend and black-level maps,
  baked from the per-edge width/gamma settings (only included when in use).

`Export Raw ZIP` ships the identical files as a plain `.zip`.

Output resolution presets: 1080p / 1920×1200 / 4K, or custom up to 8192².

## Project files

Whole state (grids, fence, blend, pattern, resolution) saves as readable
JSON (Ctrl+S) and autosaves to localStorage on every change. Loaded stills
stay out of the JSON to keep it small; reload them per session.

## Layout

- `src/warp/` — B-spline basis + knot insertion, fence math, composition
- `src/render/` — WebGL2 pipeline (display + UV-export passes), patterns, blend math
- `src/ui/` — LightWave-Modeler-style hand-rolled DOM, overlay, interaction
- `src/export/` — PFM, grayscale PNG, mpcdi.xml, ZIP assembly
- `src/state/` — project model, snapshot undo, persistence
