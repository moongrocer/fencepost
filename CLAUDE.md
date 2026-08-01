# FENCEPOST — project context for Claude Code

Browser-based manual projector calibration tool with MPCDI v2 export.
Pure client-side TypeScript + WebGL2, Vite, no backend, no UI framework
(hand-rolled DOM in a NewTek LightWave 5.6–7.5 Modeler visual style —
keep that aesthetic: bevels, taupe grays, Tahoma 11px, no rounded
corners/shadows/gradients).

## Commands

- `npm run dev` — dev server (or double-click `start.bat`)
- `npm test` — vitest unit tests (math + export formats)
- `npm run build` — typecheck (strict) + production bundle
- `npm run typecheck` — tsc only

Always run typecheck + tests after changes; verify rendering/interaction
live in a browser preview when possible (the app exposes `window.fencepost`
— the App instance — for scripted verification; `buildExportArtifacts()`
builds the full MPCDI export in memory for inspection).

## Architecture

- `src/warp/` — bspline.ts (clamped B-spline basis + exact Boehm knot
  insertion), bezier.ts (warp grid layer), fence.ts (vertical-board layer),
  compose.ts (fence→bezier composition, region mesh sampling)
- `src/render/` — gl.ts (WebGL2: per-region display pass + UV-export pass),
  patterns.ts (procedural test patterns), blend.ts (canonical blend math,
  mirrored by the shader)
- `src/ui/` — panels.ts (tool column per tab), overlay.ts (2D handle
  overlay), interaction.ts (pointer editing), handles.ts, dom.ts (LW-style
  widgets), help.ts, style.css
- `src/export/` — pfm.ts, png.ts (minimal gray PNG), mpcdi-xml.ts, zip.ts
- `src/state/` — project.ts (model v2 + v1 migration), undo.ts (snapshot
  stack), persist.ts (localStorage autosave + file save/load)

## Model & conventions (do not break these)

- **Multi-region mosaic**: project = one framebuffer (`outputW×outputH`)
  split into N regions (projectors). Each region: `rect` (its butt-joined
  slice of the framebuffer, fractions) + `src` (its window of shared
  CONTENT space; adjacent windows overlap where beams overlap) + own
  bezier/fence/blend/blackLevel. All editing applies to
  `project.activeRegion`.
- **Warp pipeline**: region-local UV → fence → bezier → region-local warped
  position → placed into region rect. Mesh uv attribute stays REGION-LOCAL;
  shaders derive content UV via the region's `src` uniform.
- **Blend is CONTENT-space** (widths in content px from the src-window
  edge, alpha computed from local UV): ramps ride the warp, so keystoned/
  curved seams get matching blends; neighboring ramps sum to 1 across the
  shared band (unit tested — keep that invariant).
- **Bezier layer is a clamped B-spline surface**: local subdivision must
  remain EXACT knot insertion (surface never moves). Fresh grids are exact
  identity (Greville abscissae).
- **Coordinate conventions**: y=0 is top in app space; clip-space y is
  flipped so glReadPixels row order matches PFM bottom-to-top directly.
  PFM: 3×float32 little-endian (scale -1.0), R=u G=v as ABSOLUTE
  content-space UV (bottom-left origin), B=0, unmapped = -1.
- **mpcdi.xml**: v2.0, profile "2d", one buffer, one region + fileset per
  projector. Schema notes are inline in mpcdi-xml.ts.
- Undo = whole-project JSON snapshots; push one snapshot per gesture.
  Autosave to localStorage on every change; stills are intentionally NOT
  serialized.

## View modes

Edit (docked, letterboxed) / Calibrate (full-bleed 1:1, editing live,
floating palette; auto-enters on fullscreen) / Output (TAB — bare feed,
zero UI). Intended rig: fullscreen window on an NVIDIA Mosaic / Eyefinity
desktop spanning all projectors.

## Roadmap (owner-confirmed priorities)

1. Field fixes: coalesce arrow-key nudge undo, replace confirm()/alert()
   with in-app modals (native dialogs kick the browser out of fullscreen),
   1:1 resolution-mismatch indicator in calibrate mode, WebGL context-loss
   recovery, worker-based export for 4K.
2. Camera-assisted calibration (webcam + structured-light gray codes)
   feeding the existing region model; manual editor stays as trim pass.
- Explicitly NOT wanted yet: dome/polar fence, STMap export, color tools.

## Repo etiquette

Commits are authored by the owner (moongrocer <moongrocer@users.noreply.github.com>);
do NOT add Co-Authored-By trailers. Test exports against real MPCDI
consumers before changing any byte-level format decision.
