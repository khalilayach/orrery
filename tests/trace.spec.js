// @ts-check
// E2E tests for TRACE, the circuit-board studio constellation (index.html + trace/).
// Covers: constellation dive routing, board engine commands (place/move/route/
// measure/drc/undo), UI tools (select-drag, place, route, measure, delete, layers),
// dock slash commands, the Claude bridge (/trace/cmd → live board) and offline mode.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startMock } from './helpers/mock-server.js';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
const API = 'http://127.0.0.1:57312';

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
async function gotoTrace(page, qs = '?agents=57312') {
  await page.addInitScript(() => { try { localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } }); // these specs test the PCB tab
  await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } }); // these tests drive Claude's edits: Auto mode
  await page.goto(PAGE + qs + '#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
}
/** wait for two animation frames so the rAF-throttled SVG redraw has landed */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
/** world (mm) → client px using the live viewBox */
async function px(page, x, y) {
  return page.evaluate(([x, y]) => {
    const svg = document.getElementById('trsvg'), r = svg.getBoundingClientRect();
    const [vx, vy, vw] = svg.getAttribute('viewBox').split(' ').map(Number), k = r.width / vw;
    return { x: r.left + (x - vx) * k, y: r.top + (y - vy) * k };
  }, [x, y]);
}
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));
async function blank(page) { await exec(page, 'clear', {}); await settle(page); }

test('boots without errors and TRACE is a constellation in the manifest', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(PAGE + '?agents=57312');
  await page.click('#skip');
  await page.waitForTimeout(600);
  const t = await page.evaluate(() => MANIFEST.projects.find((p) => p.id === 'trace'));
  expect(t.name).toBe('TRACE');
  expect(t.nodes.length).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('clicking the TRACE constellation dives into the studio; Esc closes it', async ({ page }) => {
  await page.goto(PAGE + '?agents=57312');
  await page.click('#skip');
  await expect.poll(() => page.evaluate(() => boot.done)).toBe(true);
  const at = await page.evaluate(() => { const p = MANIFEST.projects.find((q) => q.id === 'trace'); const [sx, sy] = worldScreen(p); return { x: sx / dpr, y: sy / dpr }; });
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  expect(await page.evaluate(() => trOpen)).toBe(true);
  expect(await page.evaluate(() => location.hash)).toBe('#trace');
  await page.keyboard.press('Escape'); // nothing selected, no tool active → closes
  await expect(page.locator('#tr')).not.toHaveClass(/on/);
  expect(await page.evaluate(() => trOpen)).toBe(false);
});

test('#trace opens an opaque studio with the sample board, layers, parts and clean DRC', async ({ page }) => {
  await gotoTrace(page);
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('tr')).backgroundColor);
  expect(bg).toBe('rgb(16, 22, 20)');
  const st = await state(page);
  expect(st.parts.map((p) => p.ref)).toEqual(expect.arrayContaining(['J1', 'U1', 'U2', 'J2']));
  expect(st.traces.length).toBe(15);
  await expect(page.locator('#trsvg [data-ref]')).toHaveCount(11);
  await expect(page.locator('#trdrc')).toContainText('DRC clean');
  await expect(page.locator('#trlayers')).toContainText('F.Cu');
  await expect(page.locator('#trnets')).toContainText('USB_DP');
  await expect(page.locator('#trboard input').first()).toHaveValue('60');
  await expect(page.locator('#trsvg .tr-dim').first()).toBeVisible(); // 60.00 mm board dimension
  await expect(page.locator('#trsvg')).toContainText('60.00 mm');
});

test('engine: place assigns refs, move drags attached trace ends, rotate keeps connections', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  const a = await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  const b = await exec(page, 'place', { type: 'resistor', x: 20, y: 10 });
  expect([a.ref, b.ref]).toEqual(['R1', 'R2']);
  const r = await exec(page, 'route', { from: 'R1.2', to: 'R2.1' });
  expect(r.net).toBe('NET1');
  expect(r.points).toEqual([[11.5, 10], [18.5, 10]]);
  await exec(page, 'move', { ref: 'R2', x: 20, y: 14 });
  const t = (await state(page)).traces[0];
  expect(t.pts[t.pts.length - 1]).toEqual([18.5, 14]); // end followed the pad
  await exec(page, 'rotate', { ref: 'R2', rot: 90 });
  const t2 = (await state(page)).traces[0];
  expect(t2.pts[t2.pts.length - 1]).toEqual([20, 12.5]);
});

test('engine: routes use a 45° elbow, never short two nets, reject bad input', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 20, y: 16 });
  const r = await exec(page, 'route', { from: 'R1.2', to: 'R2.1', net: 'A' });
  // straight run then a 45° diagonal into the pad
  expect(r.points).toEqual([[11.5, 10], [12.5, 10], [18.5, 16]]);
  const dx = r.points[2][0] - r.points[1][0], dy = r.points[2][1] - r.points[1][1];
  expect(Math.abs(dx)).toBeCloseTo(Math.abs(dy), 5);
  await exec(page, 'route', { from: 'R1.1', to: 'R2.2', net: 'B' });
  const err = (cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
  expect(await err('route', { from: 'R1.1', to: 'R1.2' })).toContain('would short nets');
  expect(await err('place', { type: 'nope', x: 1, y: 1 })).toContain('unknown part type');
  expect(await err('place', { type: 'resistor', x: 'abc', y: 1 })).toContain('must be a number');
  expect(await err('place', { type: 'resistor', x: 1, y: 1, rot: 45 })).toContain('multiple of 90');
  expect(await err('move', { ref: 'ZZ9', x: 1, y: 1 })).toContain('no part');
  expect(await err('frobnicate', {})).toContain('unknown command');
  expect((await state(page)).traces.length).toBe(2); // failed commands left no residue
});

test('engine: DRC flags clearance, shorts, edge and min-width; clean boards pass', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10.9, ref: 'R9' }); // pads 0.1 mm apart vertically (1.2 tall, 0.9 pitch)
  let d = await exec(page, 'drc', {});
  expect(d.errors.some((e) => e.rule === 'short')).toBe(true);
  await exec(page, 'move', { ref: 'R9', x: 10, y: 11.25 }); // pads 0.05 apart → below the 0.15 gap rule
  d = await exec(page, 'drc', {});
  expect(d.errors.some((e) => e.rule === 'clearance')).toBe(true);
  await exec(page, 'move', { ref: 'R9', x: 10, y: 11.35 }); // exactly 0.15 apart → at the limit, allowed
  d = await exec(page, 'drc', {});
  expect(d.errors.filter((e) => e.rule !== 'part_overlap')).toEqual([]); // pad clearance is fine at the limit…
  expect(d.errors.map((e) => e.rule)).toEqual(['part_overlap']); // …but the two parts are physically on top of each other, and DRC says so
  expect(d.errors[0].refs).toEqual(['R1', 'R9']);
  await exec(page, 'move', { ref: 'R9', x: 1, y: 1 });
  d = await exec(page, 'drc', {});
  expect(d.errors.some((e) => e.rule === 'edge')).toBe(true);
  await exec(page, 'remove', { ref: 'R9' });
  await exec(page, 'route', { from: 'R1.1', to: 'R1.2', width: 0.1 });
  d = await exec(page, 'drc', {});
  expect(d.errors.some((e) => e.rule === 'min_trace')).toBe(true);
  // the sample board is a known-good design
  await exec(page, 'load_sample', {});
  expect((await exec(page, 'drc', {})).errors).toEqual([]);
});

test('engine: measure returns exact distances and persists as a dimension on the board', async ({ page }) => {
  await gotoTrace(page);
  const m = await exec(page, 'measure', { from: 'J1.D+', to: 'U1.1' });
  expect(m).toMatchObject({ dx: 19.4, dy: 0, distance: 19.4 });
  const m2 = await exec(page, 'measure', { from: '0:0', to: '60:40' });
  expect(m2.distance).toBeCloseTo(72.111, 2);
  await settle(page);
  await expect(page.locator('#trmeas')).toContainText('19.40 mm');
  await expect(page.locator('#trsvg')).toContainText('72.11 mm');
  await exec(page, 'clear_measures', {});
  await expect(page.locator('#trmeas')).toContainText('Use the Measure tool');
});

test('undo / redo restore the board across commands', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'led', x: 5, y: 5 });
  await exec(page, 'place', { type: 'led', x: 15, y: 5 });
  expect((await state(page)).parts.length).toBe(2);
  await page.click('#trundo');
  expect((await state(page)).parts.length).toBe(1);
  await page.click('#trredo');
  expect((await state(page)).parts.length).toBe(2);
  await page.keyboard.press('Control+z');
  expect((await state(page)).parts.length).toBe(1);
});

test('UI: place tool drops the chosen part on the grid; R rotates the ghost; Esc cancels', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await page.click('[data-part="ldo"]');
  await page.keyboard.press('r');
  const p = await px(page, 20.1, 15.9);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  const s = await state(page);
  expect(s.parts).toHaveLength(1);
  expect(s.parts[0]).toMatchObject({ type: 'ldo', ref: 'U1', x: 20, y: 16, rot: 90 }); // snapped to 0.25 grid
  await expect(page.locator('#trinsp')).toContainText('U1');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
});

test('UI: select + drag moves a part (one undo step) and live DRC reacts', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 });
  await exec(page, 'place', { type: 'resistor', x: 30, y: 20 });
  await settle(page);
  const a = await px(page, 20, 20), b = await px(page, 26, 20);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  let s = await state(page);
  expect(s.parts.find((q) => q.ref === 'R1').x).toBeCloseTo(26, 0);
  // dragging R1 onto R2 (x=30 vs 26: pads touch/overlap) is flagged by DRC
  await page.click('#trundo');
  s = await state(page);
  expect(s.parts.find((q) => q.ref === 'R1').x).toBe(20); // the whole drag was a single undo
  const c = await px(page, 20, 20), d = await px(page, 29, 20);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#trdrc')).toContainText('error');
  await expect(page.locator('#trsvg [data-drc]').first()).toBeVisible();
});

test('UI: route tool wires two pads with a 45° trace; V drops a via and continues on B.Cu', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 30, y: 20 });
  await settle(page);
  await page.keyboard.press('w');
  const a = await px(page, 11.5, 10), b = await px(page, 28.5, 20);
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.click(b.x, b.y);
  let s = await state(page);
  expect(s.traces).toHaveLength(1);
  expect(s.traces[0]).toMatchObject({ layer: 'F.Cu', width: 0.25 });
  expect(s.parts.find((q) => q.ref === 'R1').nets['2']).toBe(s.traces[0].net);
  // second route: start on R1.1, mid-click a corner, press V to via, finish on a pad
  await page.keyboard.press('Escape'); // cancels the tool back to select
  await page.keyboard.press('w');
  const c = await px(page, 8.5, 10), mid = await px(page, 8.5, 6), v = await px(page, 14, 6), e = await px(page, 31.5, 20);
  await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.click(mid.x, mid.y);
  await page.mouse.move(v.x, v.y);
  await page.keyboard.press('v');
  s = await state(page);
  expect(s.vias).toHaveLength(1);
  expect(await page.evaluate(() => document.querySelector('[data-tool="route"]').getAttribute('aria-pressed'))).toBe('true');
  await expect(page.locator('#trstatus')).toContainText('B.Cu');
  await page.mouse.move(e.x, e.y, { steps: 3 });
  await page.mouse.click(e.x, e.y);
  s = await state(page);
  expect(s.traces.map((t) => t.layer)).toEqual(['F.Cu', 'F.Cu', 'B.Cu']);
  expect(new Set(s.traces.slice(1).map((t) => t.net)).size).toBe(1); // via keeps the same net
  await expect(page.locator('#trsvg .tr-bcu path')).not.toHaveCount(0);
});

test('UI: measure tool snaps to pads and records the distance', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 25, y: 10 });
  await settle(page);
  await page.keyboard.press('m');
  const a = await px(page, 11.6, 10.1), b = await px(page, 23.4, 9.9); // near, not on, the pad centers
  await page.mouse.move(a.x, a.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.click(b.x, b.y);
  const m = (await state(page)).measures;
  expect(m).toHaveLength(1);
  expect(m[0].a).toEqual({ x: 11.5, y: 10 });
  expect(m[0].b).toEqual({ x: 23.5, y: 10 });
  await expect(page.locator('#trlog')).toContainText('12.00 mm');
});

test('UI: Delete removes the selected part and its traces; inspector edits apply', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 20, y: 10 });
  await exec(page, 'route', { from: 'R1.2', to: 'R2.1' });
  await settle(page);
  const p = await px(page, 10, 10);
  await page.mouse.click(p.x, p.y);
  await page.fill('#insv', '4k7');
  await page.press('#insv', 'Tab');
  expect((await state(page)).parts[0].value).toBe('4k7');
  await page.fill('#insx', '12');
  await page.press('#insx', 'Tab');
  const t = (await state(page));
  expect(t.parts[0].x).toBe(12);
  expect(t.traces[0].pts[0]).toEqual([13.5, 10]); // trace end followed the edit
  const q = await px(page, 12, 10);
  await page.mouse.click(q.x, q.y);
  await page.keyboard.press('Delete');
  const s = await state(page);
  expect(s.parts.map((r) => r.ref)).toEqual(['R2']);
  expect(s.traces).toHaveLength(0);
});

test('UI: layer visibility toggles hide copper; active layer switches with 1/2', async ({ page }) => {
  await gotoTrace(page);
  await page.click('[data-ltab="objects"]'); // layer list lives under Objects
  await expect(page.locator('#trsvg .tr-fcu path')).not.toHaveCount(0); // (straight paths have an empty box, so count instead of visibility)
  await page.click('[data-vis="fcu"]');
  await expect(page.locator('#trsvg .tr-fcu path')).toHaveCount(0);
  await page.click('[data-vis="fcu"]');
  await expect(page.locator('#trsvg .tr-fcu path')).not.toHaveCount(0); // (straight paths have an empty box, so count instead of visibility)
  await page.keyboard.press('2');
  await expect(page.locator('#trstatus')).toContainText('B.Cu');
  await page.keyboard.press('1');
  await expect(page.locator('#trstatus')).toContainText('F.Cu');
});

test('UI: wheel zooms around the cursor; F refits', async ({ page }) => {
  await gotoTrace(page);
  const w0 = await page.evaluate(() => +document.getElementById('trsvg').getAttribute('viewBox').split(' ')[2]);
  const c = await px(page, 30, 20);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -400);
  await settle(page);
  const w1 = await page.evaluate(() => +document.getElementById('trsvg').getAttribute('viewBox').split(' ')[2]);
  expect(w1).toBeLessThan(w0);
  await page.keyboard.press('f');
  await settle(page);
  const w2 = await page.evaluate(() => +document.getElementById('trsvg').getAttribute('viewBox').split(' ')[2]);
  expect(w2).toBeCloseTo(w0, 1);
});

test('dock: slash commands run on the board offline; bad commands report errors; /help lists them', async ({ page }) => {
  await gotoTrace(page, '?agents=59999'); // nothing listens → offline
  await expect(page.locator('#trst')).toHaveText('offline');
  await expect(page.locator('#trlog')).toContainText('agent server offline');
  await blank(page);
  await page.fill('#trin', '/place type=capacitor x=12 y=8');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trlog')).toContainText('C1');
  expect((await state(page)).parts[0]).toMatchObject({ ref: 'C1', x: 12, y: 8 });
  await page.fill('#trin', '/place type=capacitor');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trlog')).toContainText('missing x=');
  await page.fill('#trin', '/help');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trlog')).toContainText('route from=');
  await page.fill('#trin', 'hello claude');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trlog')).toContainText('slash commands like /place work offline');
});

test('dock: chatting reaches a real server session (mock Claude replies)', async ({ page }) => {
  await gotoTrace(page);
  await expect(page.locator('#trst')).toContainText('connected');
  await page.fill('#trin', 'place a resistor please');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trlog .msg.ai')).toContainText('mock:TRACE received: place a resistor please');
});

test('bridge: server /trace/cmd drives the live board (what the Claude CLI does)', async ({ page, request }) => {
  const mock = await startMock(); // private server: /trace/cmd broadcasts to every open TRACE tab
  try {
    const API = mock.api, token = mock.token;
    await gotoTrace(page, '?agents=' + mock.port);
    await expect(page.locator('#trst')).toContainText('connected');
    await expect.poll(async () => (await (await request.get(API + '/trace/status')).json()).open).toBe(true);
    await blank(page);
    const send = (cmd, args) => request.post(API + '/trace/cmd', { data: { token, cmd, args } });
    const r1 = await (await send('place', ['type=resistor', 'x=10', 'y=10'])).json();
    expect(r1).toMatchObject({ ok: true, result: { ref: 'R1' } });
    await send('place', ['type=resistor', 'x=20', 'y=10']);
    const r3 = await (await send('route', ['from=R1.2', 'to=R2.1', 'net=SIG'])).json();
    expect(r3.result.net).toBe('SIG');
    // Claude's presence marker appears on the board for a moment
    await expect(page.locator('#trsvg .tr-claude').first()).toBeVisible();
    const s = await state(page);
    expect(s.parts.map((p) => p.ref)).toEqual(['R1', 'R2']);
    expect(s.traces).toHaveLength(1);
    await expect(page.locator('#trlog')).toContainText('⌁ route');
    await expect(page.locator('#trnets')).toContainText('SIG');
    // errors travel back to the caller
    const bad = await send('route', ['from=R1.1', 'to=NOPE.1']);
    expect(bad.status()).toBe(422);
    expect((await bad.json()).error).toContain('unknown part');
    // read-only commands work too
    const bd = await (await send('board', [])).json();
    expect(bd.result.parts).toHaveLength(2);
    expect(bd.result.drc.errors).toBe(0);
  } finally { mock.stop(); }
});

test('bridge: needs the internal token, and says so when TRACE is not open', async ({ request }) => {
  const mock = await startMock(); // private server with no browser attached
  try {
    const denied = await request.post(mock.api + '/trace/cmd', { data: { token: 'wrong', cmd: 'board', args: [] } });
    expect(denied.status()).toBe(403);
    const closed = await request.post(mock.api + '/trace/cmd', { data: { token: mock.token, cmd: 'board', args: [] } });
    expect(closed.status()).toBe(503);
    expect((await closed.json()).error).toContain('not open');
  } finally { mock.stop(); }
});

test('export downloads the board as JSON', async ({ page }) => {
  await gotoTrace(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#trexport')]);
  expect(dl.suggestedFilename()).toBe('trace-board.json');
  const body = JSON.parse(await readFile(await dl.path(), 'utf8'));
  expect(body.format).toBe('trace-board');
  expect(body.parts.length).toBe(11);
});

test('the board persists across reloads', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'place', { type: 'led', x: 33, y: 7, ref: 'D7' });
  await page.waitForTimeout(400); // debounced save
  await page.reload();
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  expect((await state(page)).parts.map((p) => p.ref)).toEqual(['D7']);
});

test('regression: ORCH1 workspace still opens and TRACE does not leak into it', async ({ page }) => {
  await page.goto(PAGE + '?agents=57312#orch1');
  await expect(page.locator('#ws')).toHaveClass(/on/, { timeout: 5000 });
  expect(await page.evaluate(() => trOpen)).toBe(false);
  await expect(page.locator('#tr')).not.toHaveClass(/on/);
  await page.keyboard.press('Escape'); // first Esc blurs the focused terminal input
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws')).not.toHaveClass(/on/);
});

test('regression: dimension lines stay hairline-thin at any zoom (vector-effect on every path)', async ({ page }) => {
  await gotoTrace(page);
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('#trsvg .tr-dim path')].filter((p) => getComputedStyle(p).vectorEffect !== 'non-scaling-stroke').length);
  expect(await page.locator('#trsvg .tr-dim path').count()).toBeGreaterThan(4);
  expect(bad).toBe(0);
});
