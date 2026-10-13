# QA Report — Orrery (localhost:8123)

- **Date:** 2026-07-03
- **Mode:** Full (user-scoped: design pass + reported bugs)
- **Tier:** Standard
- **Framework:** Static single-file HTML + WebGL/Canvas2D (no framework)
- **Pages/states tested:** boot intro, landing, pan, hover, dive (both constellations), detail panel, close (button + Escape), recenter, deep-link hash open, mobile 375x812
- **Health score:** baseline **92** → final **98**

## Summary

| # | Issue | Severity | Category | Status |
|---|-------|----------|----------|--------|
| ISSUE-001 | Only constellation root node clickable | High | Functional | **verified** |
| ISSUE-002 | Leaving constellation snaps zoom instead of animating out | High | UX | **verified** |
| ISSUE-003 | Void dithering invisible behind detail panel | Medium | Visual | **verified** |
| ISSUE-004 | No vignette (edges / bottom 15% / top 5%) | Design request | Visual | **verified** |
| ISSUE-005 | No persistent title at top of void | Design request | Visual | **verified** |
| ISSUE-006 | Title illegible on narrow viewports (found during QA) | Medium | Visual | **verified** |

Fixes applied: 6 verified, 0 best-effort, 0 reverted. Deferred: 1 (below).

## Issues

### ISSUE-001 — Only the constellation root node was clickable (High, Functional)
- **Repro:** click any non-root node glyph of either constellation → nothing happens. `hitTest` only measured distance to the constellation center.
- **Fix:** `nodePoints`/`nearNode` helpers; `hitTest` and the hover highlight now test every node (radius `W*0.04`). Hovering any node shows pointer cursor + label; clicking any node dives.
- **Evidence:** function-level (`outerNodeHit:true` on both constellations, `emptyVoidMiss:true`) + end-to-end (outer-node click opened EVE-NG; ORCH1 opened via its outer node at screen 1088,461).
- **Commit:** `fix(qa): ISSUE-001`

### ISSUE-002 — No zoom-out when leaving a constellation (High, UX)
- **Repro:** open a constellation, click "back to the cosmos" → `cam.zoom` snapped 8→1 on the same tick.
- **Fix:** new `undive` camera phase — 750ms ease-out cubic from current zoom back to 1, temple frame scale/opacity ride the same curve, focus point held until the animation lands. Clicks are gated during undive; `prefers-reduced-motion` keeps the instant snap.
- **Evidence:** zoom samples after close: `8 → 6.94 → 2.15 → 1.15 → 1` (button) and `→ 3.01 → 1.9 → 1.3 → 1.01 → 1` (Escape).
- **Commit:** `fix(qa): ISSUE-002`

### ISSUE-003 — Void invisible behind the detail panel (Medium, Visual)
- **Fix:** detail overlay backdrop lightened (`rgba(2,3,8,.9)`+blur → `.34/.40`, no blur so glyphs stay crisp) and the shader brightens glyphs up to ~2.9x proportional to `uZoom`, so the dithering scaled up 8x by the dive reads clearly behind the panel.
- **Evidence:** screenshots `issue-003-detail-before.png` (black backdrop) vs `issue-003-detail-after.png` / `final-orch1-detail.png` (giant accent-tinted glyphs visible, text readable).
- **Commit:** `fix(qa): ISSUE-003`

### ISSUE-004 — Void vignette (Design)
- **Fix:** camera-space vignette in the GL fragment shader — smoothstep falloff over side edges (16%), bottom 15%, top ~6%, floor 0.12 so it darkens rather than clips. Ambient stars get the same falloff via `vigK()` in Canvas2D (top-origin Y; GL pan/flip conventions untouched per prior learning `orrery-pan-axis-bug`).
- **Evidence:** `issue-004-vignette-after.png` — top band and lower void fall off into black.
- **Commit:** `feat(qa): ISSUE-004`

### ISSUE-005 — Persistent dithered title (Design)
- **Fix:** "ORRERY" rasterized once to an offscreen canvas, sampled into a dither grid, redrawn every frame in screen space (camera-hooked — stays put while the world pans), bright white with per-cell twinkle from the ASCII ramp plus occasional `+` hard sparkles and a soft glow. Fades in as the boot zoom lands, dims during dives, static under `prefers-reduced-motion`, rebuilt on resize.
- **Evidence:** `issue-005-title-after.png`, `final-pan.png` (world panned, title fixed).
- **Commits:** `feat(qa): ISSUE-005` + legibility follow-up (finer grid, tighter glow).

### ISSUE-006 — Title illegible on mobile (Medium, found during QA)
- **Fix:** title height bound changed from `W*0.055` to `W*0.14` (desktop still governed by the `H*0.085` bound; narrow screens scale up).
- **Evidence:** `final-mobile.png` — legible at 375x812.
- **Commit:** `fix(qa): ISSUE-006`

## Deferred

- **A11y (Medium):** constellation nodes are canvas-only — no keyboard access or screen-reader names for the two project entries. Pre-existing; fixing well means DOM proxy buttons over the canvas. Deferred as separate scope.
- **Test framework:** project is a single static HTML file with no runtime; test bootstrap needs a user decision (user was AFK), so no regression test files were generated and no opt-out marker was written. Re-run `/qa` to be asked again.

## Console health

0 JS errors across all states/interactions. Only headless-Chromium `GPU stall due to ReadPixels` performance warnings during screenshot capture (not an app defect).

## PR summary

> QA found 6 issues (3 reported + design pass + 1 new), fixed 6, health score 92 → 98.
