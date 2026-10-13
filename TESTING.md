# Testing

100% test coverage is the key to great vibe coding. Tests let you move fast, trust
your instincts, and ship with confidence — without them, vibe coding is just yolo
coding. With tests, it's a superpower.

## Framework

**Playwright** (`@playwright/test`) driving headless Chromium. This project is a
single static `index.html` full of canvas rendering and pointer interactions, so
the meaningful test layer is end-to-end in a real browser — there is no module
graph for unit tests to import.

## Run

```sh
npm test              # runs the full Playwright suite
npx playwright test --headed   # watch it run in a visible browser
```

One-time setup on a fresh machine: `npm install && npx playwright install chromium`.

## Layout

| Layer | Where | What it covers |
|---|---|---|
| E2E | `tests/*.spec.js` | Real browser flows: boot, dive routing, workspace interactions (spawn, fold, pan, close), regressions |

## Conventions

- One spec file per feature area (`orch1-workspace.spec.js` covers the agent workspace, `trace.spec.js` the TRACE circuit-board studio, `trace-parts.spec.js` its parts library / Claude animation).
- TRACE tests drive the board two ways: `TRACE.exec(cmd, args)` for engine behavior, and real mouse/keyboard on `#trsvg` for UI tools (use the `px()` helper to convert board mm → screen px). The Claude bridge is tested against the mock server with `/trace/cmd`.
- Tests assert observable behavior (classes, computed styles, element counts,
  positions after gestures) — never internal implementation details.
- Page globals (`wsOpen`, `detailOpen`, `MANIFEST`, `startDive`) are reachable via
  `page.evaluate` because `index.html` uses a classic script.
- Canvas visuals (dither, glow) are verified by QA screenshots, not pixel asserts —
  they animate every frame.
- Transitions: `await expect.poll(...)` until the animated property settles; never
  assert mid-transition.
- When fixing a bug, add a regression test in the same PR.

- Tests that send `/trace/cmd` or write parts spawn a **private** mock server (`tests/helpers/mock-server.js`): the bridge broadcasts to every open TRACE tab, so a shared server leaks commands between parallel specs. In mock mode the "online" footprint library is a built-in fixture (no network) and the parts folder is a temp dir.
- LUMEN (image studio): `lumen.spec.js` covers the editor core, `lumen-tools.spec.js` the Photoshop-style toolset (selections, fills, filters, retouch brushes, canvas transforms), stacked timeline clips and PDF export. Drive edits through `LUMEN.exec(cmd, args)` and real pointer gestures on `#lmstage` (use the `at()` helper to convert canvas px → screen px). Don't run two Playwright runs at once — each page software-renders a WebGL void, so parallel runs starve each other and tests time out; on Windows, `pkill` does not stop them (use `Stop-Process`), and leaked `chrome-headless-shell` processes keep burning CPU.
