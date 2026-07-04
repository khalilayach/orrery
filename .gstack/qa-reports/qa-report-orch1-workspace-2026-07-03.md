# QA Report — ORCH1 Agent Workspace Integration

- **Date:** 2026-07-03
- **Target:** `index.html` (file://, static page) — branch `main`
- **Mode:** goal-driven integration + fix + verify (`/goal`: bring approved workspace design into the project with 4 corrections)
- **Framework:** vanilla JS canvas page (WebGL void + 2D overlays)
- **Evidence:** `screenshots/orch1-workspace-final.png`

## Goal corrections — all verified

| # | Requirement | Result |
|---|-------------|--------|
| 1 | Workspace canvas is blue; the void behind stays **black** | ✅ Canvas `#1d1fe6` halftone; black ASCII void + temple visible around it |
| 2 | Fix text-highlight bug on the canvas | ✅ `user-select:none` on `#ws` subtree; computed style verified |
| 3 | Canvas fully opaque — nothing shows through | ✅ Solid fill each frame; computed `rgb(29,31,230)`, opacity 1 |
| 4 | Move around inside the canvas like the void | ✅ Background drag pans dither + windows together, bounded ±75% |

## Issues found & fixed during integration QA

### ISSUE-001 — Seeded window covers the spawn node (medium, UX)
First agent window spawned dead-center, hiding the "+ summon agent" node.
**Fix:** cascade windows to the upper-left of the node. Verified via bounding-box
overlap check (no intersection). Included in feat commit `5a6170f`.

### ISSUE-002 — "↺ recenter" button active behind the workspace (low, UX)
The map's recenter button remained visible/clickable below the workspace edge and
panned the star map behind it. **Fix:** hidden while workspace is open, restored on
close. Verified. Included in feat commit `5a6170f`.

### ISSUE-003 — Test flake: opacity asserted mid-fade (test-only)
First test run asserted `opacity === 1` during the 0.45s fade-in.
**Fix:** poll until the transition settles. Test-only change; no app defect.

## Interaction verification (browser, real events)

- Dive routing: ORCH1 → workspace (`detailOpen` stays false) ✅
- Hash routing: `#orch1` → workspace, `#eve-ng` → detail panel ✅
- Spawn: each click adds a window (blue/white, serif name, random id) ✅
- Fold: lower collapses body to 0 height (paper fold), chip keeps avatar+name ✅
- Raise: click on chip bar (no drag) restores the window ✅
- Pan: background drag moved windows −120px with the gesture; bounded ✅
- ESC: closes workspace, restores UI, un-dives camera ✅
- Console: no app errors (only GPU ReadPixels perf warnings from screenshot capture) ✅

## Test suite (new)

Playwright e2e, 8 tests, **8/8 passing** (~15s): boot errors, hash open +
opacity/selection guarantees, dive routing, spawn, fold/raise, pan, ESC,
EVE-NG regression. CI workflow added (`.github/workflows/test.yml`).

## Commits

| SHA | What |
|-----|------|
| `712a428` | docs: design doc + Hermes visual reference |
| `5a6170f` | feat: ORCH1 dive opens agent workspace (incl. ISSUE-001/002 fixes) |
| `02acdd2` | chore: bootstrap Playwright e2e (8 tests) + CI + TESTING.md |

## Health

Baseline (pre-integration page): healthy, no known issues.
Final: **no open issues.** All goal corrections verified, 8/8 e2e green.

> PR summary: Integrated the ORCH1 agent workspace (blue canvas over black void)
> with 2 UX issues found and fixed during QA; added Playwright e2e suite (8/8).

## Deferred / future

- Terminal input is a static prompt (Phase 1 of the design doc — real typing +
  Agent SDK backend is Phase 2, out of scope for this pass).
- Folded chips can be partially pushed past the canvas edge by panning; recoverable
  by panning back (bounded world). Revisit if it annoys in practice.
