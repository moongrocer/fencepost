# FENCEPOST — field bug list

Reported from the live 2-projector mosaic rig. Compiled during Claude Code
sessions; keep entries until fixed + verified on the rig.

## STATUS

| # | Item | State |
|---|------|-------|
| 1 | Fullscreen lost to native confirm()/alert() | **FIXED** — in-app modals |
| 2 | Arrow nudge silent no-op / selection lost | **FIXED** — feedback, click-through region switch, coalesced undo |
| 3 | Handles hard to grab; no keyboard traversal | **FIXED** — bigger hit radius, Ctrl+Arrows walk |
| 4 | 2×2 bilinear corner-pin unavailable | **FIXED** — density min 2 |
| 5 | Seam goes dark at gamma ≠ 1 | **FIXED** — normalized power blend |
| 6 | Calibrating under a debugger banner | **FIXED** — geometry gate + 1:1 warning |
| 7 | Camera solve overfits noisy data | **FIXED in code** — global robust LSQ; needs rig re-run to verify |
| 8 | Mosaic setup buried in EXPORT | **FIXED** — MOSAIC tab + region badge |

Fixes verified by 31 unit tests plus live in-browser checks (modal keyboard
handling, nudge/walk behaviour, and a GL readback confirming neighbouring
blend ramps sum to 1.00 ± 0.01 across the band at gamma 2.2). NOT yet
verified on the projectors — item 5 changes exported alpha maps, so test
against a real MPCDI consumer before shipping an export.

## 1. Fullscreen lost on bezier density change, mosaic build, resets

**Repro:** In fullscreen/calibrate mode, use "Apply Density", "Build Column
Mosaic", "Single Region", any Reset button, or hit an export/load error.
The browser drops out of fullscreen.

**Cause:** Native `confirm()`/`alert()` dialogs — browsers force-exit
fullscreen when one opens. Call sites: app.ts:217, 238, 912, 926, 1004,
1014, 1025, 1070, 1135.

**Fix:** Replace all native dialogs with in-app LW-style modals (bevels,
Tahoma, keyboard OK/Cancel). Already roadmap item 1; this confirms it
bites in the field on every structural change.

## 2. Arrow-key nudge "doesn't work" — silent no-op when nothing is selected

**Report:** Arrows don't nudge on the rig.

**Verified:** The nudge mechanism itself works (live-tested: with a bezier
handle in `selection`, ArrowRight moves it). `nudgeSelection` silently
returns when the selection is empty (app.ts:739) — and selection is very
easy to lose without any visual feedback:

- A click that MISSES a handle (8 px hit radius, interaction.ts:40)
  starts a rubber-band and clears the selection (interaction.ts:192).
- Hit-testing only covers the ACTIVE region's handles
  (interaction.ts:89); clicking a visible handle in the other projector's
  half just switches regions and selects nothing (interaction.ts:186).
  In a 2-projector mosaic this is the dominant failure flow.
- Region switch (, / . or click) always clears selection (app.ts:202).

**Fix ideas:** status-bar/HUD feedback ("no selection — click a point")
instead of silent no-op; when clicking a handle in an inactive region,
switch region AND select that handle in one click; larger/magnetic hit
radius. Related roadmap item: coalesce per-keypress undo snapshots
(nudgeSelection pushes one per press).

## 3. Handles hard to grab; no keyboard way to move selection between points

**Report:** Hard to grab points in some places; wants keyboard traversal
to the next point.

**Notes:** HIT_PX = 8 CSS px against analytic positions; dense grids and
seam-adjacent handle clusters make precise grabs fiddly, especially on a
projected image you're squinting at. Fence has Prev/Next post buttons but
bezier points have no keyboard selection at all.

**Fix ideas:** raise hit radius / snap to nearest handle within a larger
radius; Ctrl+Arrows (or similar — Tab is taken by output mode) to walk
the selection to the adjacent grid point in that direction; number-row or
Home/End style jumps to corners. Selection walking + nudge together would
allow full keyboard-only calibration, which beats mousing on a ladder.

## 4. Feature: 2×2 grid (bilinear / corner-pin mode) — "what if I don't need bezier interpolation?"

**Report:** Owner wants plain 4-corner keystone without spline
interpolation; density field bottoms out at 3.

**Notes:** The math already supports it — degree = min(3, n-1)
(bezier.ts:31), so a 2×2 grid is degree-1 = exact bilinear corner-pin.
Only the UI forbids it (density miniField min: 3, panels.ts). Lowering
the min to 2 gives a true keystone mode nearly for free. Caveats to
check: subdivide on a degree-1 surface stays piecewise-linear (fine, but
"Apply Density" reset is the path to smooth cubic later); overlay/
handles code paths with cols=2; unit-test identity + PFM export for the
degree-1 case.

## 5. BLEND SEAM GOES DARK AT ANY GAMMA != 1 (ramps do not sum to 1)

**Seen on the rig:** after camera calibration the geometry lines up but a
distinctly DARK vertical band remains through the whole overlap.

**Cause:** `edgeFalloff` (render/blend.ts:17) returns a bare power ramp,
`alpha = (d/w)^gamma`, and the shader mirrors it (render/gl.ts:45).
Neighboring ramps are complementary in t, so they sum to 1 ONLY at
gamma = 1. Center-of-band sum, measured:

| gamma | sum at band center | brightness dip |
|-------|--------------------|----------------|
| 1.0   | 1.000              | 0%             |
| 1.5   | 0.707              | 29%            |
| 2.2   | 0.435              | **56%**        |
| 3.0   | 0.250              | 75%            |

The project default is **gamma 2.2**, so every fresh mosaic has a 56%
dark band down the seam.

**Why the unit test passes:** project.test.ts:44 asserts the sum-to-1
invariant but sets `gamma = 1` on both regions first (lines 47-48), so it
only ever covers the one value where the current formula happens to work.

**Fix:** normalized power blend, which sums to exactly 1 for ANY gamma:

    f(t) = t^g / (t^g + (1-t)^g)

Apply in `edgeFalloff` AND the GLSL (they must stay mirrored), then
re-point the test at gamma 2.2 / 0.5 / 3.0 instead of only 1.0. Note this
changes exported alpha maps — per repo etiquette, re-verify against a
real MPCDI consumer before shipping.

## 6. Calibration must not run while a debugger/automation banner is attached

**Found during camera-calibration bring-up.** Chrome's "being debugged"
infobar steals ~57 CSS px of client height (rig fullscreen measured
1920×1480 against a 1920×1537 screen). The GL canvas is laid out from
client size, so every raster pixel maps to a different wall position with
the banner present vs absent. Measuring under one condition and running
under the other bakes in a ~3.7% vertical error.

**Handled:** `runAll` in remote.ts gates on
`document.fullscreenElement && innerHeight >= screen.height - 8` before
firing any pattern, and records the wait in the report.

**Generalizes:** ANY change to window chrome, zoom level, or display
scaling after calibration invalidates the warp. Worth a stored
"calibrated at" geometry stamp + a mismatch warning in calibrate mode
(overlaps roadmap item 1's 1:1 resolution-mismatch indicator).

## 7. Camera calibration: 3×3 grid is too coarse; verification still bug

From the first successful autonomous run (both regions measured, solved,
applied — see calibrations/):

- The rig project uses a **3×3** control net (degree 2). That is a single
  quadratic patch per axis — it cannot represent the residual curvature of
  the screen, and the grid capture still shows bowed top/bottom edges.
  Re-run at 5×5 or 7×7; the solver is density-agnostic.
- Region 0 needed **2 of 9** control points filled by homography
  extrapolation (`usedFallback: 2`) — those points fell outside the
  measured footprint, so they are the least trustworthy corners.
- **Homography RMS was high** (75.9 px region 0, 44.8 px region 1) against
  a 1920×1080 capture. A projector-to-camera map on a FLAT screen is
  exactly a homography, so this size of residual says the screen is not
  flat (consistent with the visibly curved surface). Direct per-point
  lookup handles that fine; only the extrapolated fallbacks suffer.
- **MEASURED RESIDUAL: a 20% scale step across the seam.** Undistorting
  the verification capture with the ELP intrinsics and measuring grid-line
  spacing along a mid-height scanline (sub-pixel peak centroids) gives
  **8.98 px/cell left of the seam vs 10.77 px right** — 20% mismatch, and
  it holds right at the seam (8.67 vs 10.73). Content cells are uniform in
  content space and both regions map equal-width content windows onto
  equal-width target spans, so a correct solve MUST produce matching
  spacing. This is the 3×3 net: the solve interpolates exactly at the 9
  Greville points but a single degree-2 patch cannot follow the curved
  screen between them. Fix = re-run at 5×5/7×7, then re-measure this
  number; it is the objective pass/fail metric for the calibration.
- **Verification-still bug (mine):** `runAll` captures a "white field" via
  `setPattern('solid')`, which inherits `pattern.solid` from the project —
  that was `black`, so the white-field verification image is a black
  frame. Worked around by setting `solid='white'` in the pushed project;
  still worth fixing in `runAll` itself.

### 7×7 re-run RESULT: WORSE, not better — the solver overfits bad data

Re-ran at 7×7 / degree 3 (49 control points/region, 45 and 48 of them
from direct measurement). Seam mismatch went from 20% to **47.8%
overall, 60.3% near the seam**, and the capture shows violent LOCAL
deformation the 3×3 run did not have: a sharp tent/spike in the lower
right and undulating grid lines along the bottom and left edges.

**Diagnosis:** this is classic overfitting, not a density shortfall. Each
control point is set from ONE local lookup — an 11×11 plane fit around a
single camera point (`lookup` in calibrate.ts) — with a homography
fallback whose residual is 79 px. With 9 control points that noise
averaged out; with 49, every bad neighbourhood pulls its own point. The
spike coincides with what looks like a physical object occluding the
lower-right of the screen from the camera, where gray-code decoding
yields garbage rather than "no data".

**Real fix (do this before raising density again):**
1. Global least-squares fit of the control net over ALL valid
   correspondences, not one lookup per control point.
2. Outlier rejection (RANSAC or robust loss) so occluded/specular areas
   can't drag a point.
3. A smoothness/regularization term, weighted up where data is sparse —
   this is what keeps the net sane at edges instead of the current
   homography fallback.
4. Validate coverage per control point and REFUSE to solve (or fall back
   to lower density) when a point's neighbourhood is under-sampled.
5. Operationally: the camera must see the whole projection unoccluded —
   worth detecting and reporting rather than silently fitting to it.

**IMPLEMENTED (2026-08-02), pending rig verification.** `solveRegion` in
warp/calibrate.ts is now a global robust fit:

- Every valid correspondence becomes one linear constraint on the net
  (camera point → target → content uv; B-spline basis row = surface(uv)
  must equal the measured raster). One normal-equations solve per axis
  over ~50k rows.
- Trimmed refits with a robust MAD threshold; inlier membership is
  re-classified from scratch each round so points mislabelled by a
  contaminated first fit can return. Survives a 24% garbage patch.
- Bending-energy prior using divided differences over the GREVILLE
  abscissae (index-space differences are wrong on clamped knots — they
  penalize linear surfaces and drag corners outward; found via synthetic
  affine test). Weight is adaptive per point, normalized against the
  basis mass a UNIFORM data field would give that point (corners
  intrinsically have ~¼ the mass of interior points; naive normalization
  flattened real curvature exactly where keystone is largest).
- `lowCoverage` in the result reports control points carried by the prior
  (ratio < 5% of uniform-field mass).

Synthetic validation (calibrate.test.ts): exact on affine (1e-9 px);
≤1.1 cam px worst-case on a sinusoidally bowed wall at 7×7 incl. between
control points; an occluded patch is detected (>100 samples rejected),
does not contaminate the rest (≤1.1 px outside), and the unmeasurable
hole is bridged smoothly (≤3 px, no spike). The old 3×3 result stays in
calibrations/fencepost-camera-calib-2026-08-01.json until a new rig run
beats it; runAll/solveApply now report {rmsPx, inliers, outliers,
lowCoverage} instead of the homography stats.

## 8. Mosaic setup buried in EXPORT tab, feels like a hidden step process

**Report:** Owner ran the app across a 2-projector mosaic and found no
visible way to warp/blend the seam — the "Build Column Mosaic" step lives
in the EXPORT tab, and nothing in the UI signals that (a) regions must be
built first, or (b) warp/fence/blend edit only the ACTIVE region (switch
via , / . or clicking a region).

**Fix ideas (owner to pick direction):**
- Promote mosaic/region setup to its own tab (e.g. MOSAIC or SETUP as the
  first tab) instead of a subgroup of EXPORT.
- Make the active-region concept visible outside the status bar: region
  tint/label on the canvas, active-region indicator in WARP/FENCE/BLEND
  panel headers ("editing R2").
- First-run or per-project hint when regions == 1 and the window spans a
  multi-head desktop.
