# Orrery

An interactive constellation workspace, with ORCH1 agent terminals, TRACE (PCB circuit studio) and LUMEN (image studio).

## [▶ Open the live site](https://khalilayach.github.io/orrery/)

https://khalilayach.github.io/orrery/

> The ORCH1 terminals talk to a real Claude agent through a local server, so that part only works when you run the project yourself. Everything else runs in the browser.

## Run it locally

```bash
git clone https://github.com/khalilayach/orrery.git
cd orrery
npm install
node server/agent-server.mjs   # optional: enables real agent terminals
```

Then open `index.html` in a browser (or serve the folder, e.g. `npx serve .`).

## Tests

```bash
npm test
```

Playwright end-to-end tests live in `tests/`.
