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

- `src/warp/` — model.ts (parametric layers: Heckbert homography +
  forward cylinder/UST lens model, Newton inverse), bspline.ts (clamped
  B-spline basis + exact Boehm knot insertion), bezier.ts (warp grid
  layer), fence.ts (vertical-board layer), compose.ts (layer stack
  composition, region mesh sampling), refit.ts (Laplacian smooth, single-
  patch refit, explicit legacy→homography upgrade)
- `src/render/` — gl.ts (WebGL2: per-region display pass + UV-export pass),
  patterns.ts (procedural test patterns), blend.ts (canonical blend math,
  mirrored by the shader)
- `src/ui/` — panels.ts (tool column per tab), overlay.ts (2D handle
  overlay), interaction.ts (pointer editing), handles.ts, dom.ts (LW-style
  widgets), modal.ts (in-app confirm/alert — NEVER use native
  confirm()/alert(), they force the browser out of fullscreen), help.ts,
  style.css
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
- **Warp pipeline** (three-layer stack, compose.ts): region-local UV →
  [1 homography] → [2 cylinder] = model M(uv); the hand-placed
  fence→bezier residual is a DISPLACEMENT from identity added on top
  (position = M(uv) + (bezier(fence(uv)) − uv)). So a fresh lattice passes
  the model through exactly, and with layers 1+2 off the pipeline is the
  old fence→bezier chain bit-for-bit. Each layer has its own `enabled`
  flag; toggling never touches parameters. Pre-stack projects load with
  1+2 off — promotion is the explicit MODEL-tab "Upgrade", never silent.
  Mesh uv attribute stays REGION-LOCAL; shaders derive content UV via the
  region's `src` uniform.
- **Blend is CONTENT-space** (widths in content px from the src-window
  edge, alpha computed from local UV): ramps ride the warp, so keystoned/
  curved seams get matching blends; neighboring ramps sum to 1 across the
  shared band AT EVERY GAMMA (unit tested across gammas — keep that
  invariant). The ramp is the NORMALIZED power blend
  `f(t) = t^g / (t^g + (1-t)^g)`; a bare `t^g` only sums to 1 at g=1 and
  put a 56% dark stripe down every seam at the default 2.2. blend.ts and
  the GLSL in gl.ts must stay mirrored.
- **Bezier layer is a clamped B-spline surface**: local subdivision must
  remain EXACT knot insertion (surface never moves). Fresh grids are exact
  identity (Greville abscissae). Density goes down to 2×2, which is
  degree 1 = exact bilinear corner-pin (plain 4-corner keystone, no spline
  interpolation).
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

1. Field fixes: ~~coalesce arrow-key nudge undo~~, ~~replace
   confirm()/alert() with in-app modals~~, ~~1:1 resolution-mismatch
   indicator in calibrate mode~~ — all DONE. Remaining: WebGL
   context-loss recovery, worker-based export for 4K.
2. Camera-assisted calibration (webcam + structured-light gray codes)
   feeding the existing region model; manual editor stays as trim pass.
   Bring-up proven end-to-end on the rig (`src/remote.ts` +
   `src/warp/calibrate.ts`). The solver is a GLOBAL robust least-squares
   fit of the control net over all decoded correspondences (trimmed
   refits with re-inclusion, Greville-space bending prior with
   coverage-adaptive weight — see solveRegion). Compensates measured wall
   irregularities up to the spline's expressiveness; validated on
   synthetic curved-wall + occlusion cases in calibrate.test.ts. Next
   step: re-run on the rig and compare against the saved 3×3 result in
   calibrations/.
- Explicitly NOT wanted yet: dome/polar fence, STMap export, color tools.

## Repo etiquette

Commits are authored by the owner (moongrocer <moongrocer@users.noreply.github.com>);
do NOT add Co-Authored-By trailers. Test exports against real MPCDI
consumers before changing any byte-level format decision.
