// @ts-check
// E2E tests for TRACE's parts library (create / find online / persist on disk),
// the Claude CLI part commands, the organic constellation shape, and the
// "Claude is working / finished" animation. Uses the mock agent server, whose
// "online" footprint library is a built-in fixture and whose parts folder is a
// throwaway temp dir (emptied after each test).
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startMock } from './helpers/mock-server.js';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = pathToFileURL(resolve(ROOT, 'index.html')).href;
let mock, API, PORT; // one private server per run of this file
test.beforeAll(async () => { mock = await startMock(); API = mock.api; PORT = mock.port; });
test.afterAll(() => mock && mock.stop());

async function gotoTrace(page, qs) {
  await page.addInitScript(() => { try { localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } }); // these specs test the PCB tab
  await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } }); // these tests drive Claude's edits: Auto mode
  await page.goto(PAGE + (qs || '?agents=' + PORT) + '#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
async function px(page, x, y) {
  return page.evaluate(([x, y]) => {
    const svg = document.getElementById('trsvg'), r = svg.getBoundingClientRect();
    const [vx, vy, vw] = svg.getAttribute('viewBox').split(' ').map(Number), k = r.width / vw;
    return { x: r.left + (x - vx) * k, y: r.top + (y - vy) * k };
  }, [x, y]);
}
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));
const blank = async (page) => { await exec(page, 'clear', {}); await settle(page); };
const parts = async (request) => (await request.get(API + '/parts')).json();
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const cli = (token, ...args) => new Promise((res) => execFile('node', ['server/trace-cli.mjs', ...args],
  { cwd: ROOT, env: { ...process.env, TRACE_PORT: String(PORT), TRACE_TOKEN: token } },
  (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout, err: stderr })));

test.afterEach(async ({ request }) => {
  for (const p of await parts(request)) await request.delete(API + '/parts/' + p.id);
});

test('constellation shape is organic: no edge is axis-aligned (not a boxy grid)', async ({ page }) => {
  await page.goto(PAGE + '?agents=' + PORT);
  const t = await page.evaluate(() => MANIFEST.projects.find((p) => p.id === 'trace'));
  const aligned = t.edges.filter(([a, b]) => Math.abs(t.nodes[a][0] - t.nodes[b][0]) < 1e-6 || Math.abs(t.nodes[a][1] - t.nodes[b][1]) < 1e-6);
  expect(aligned).toEqual([]);
  expect(t.nodes.length).toBeGreaterThanOrEqual(6);
});

test('engine: create_part templates generate correctly numbered pads', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  const dual = await exec(page, 'create_part', { id: 'my-soic8', label: 'My SOIC-8', prefix: 'U', template: 'dual', pins: 8 });
  expect(dual.pads).toBe(8);
  const lib = await exec(page, 'list_parts', {});
  const p = lib.find((q) => q.type === 'my-soic8');
  expect(p.custom).toBe(true);
  const by = Object.fromEntries(p.pads.map((q) => [q.n, q]));
  expect(by['1'].x).toBeLessThan(0); expect(by['1'].y).toBeLessThan(0);      // pin 1 top-left
  expect(by['4'].x).toBeLessThan(0); expect(by['4'].y).toBeGreaterThan(0);
  expect(by['5'].x).toBeGreaterThan(0); expect(by['5'].y).toBeGreaterThan(0); // pin 5 bottom-right
  expect(by['8'].x).toBeGreaterThan(0); expect(by['8'].y).toBeLessThan(0);
  expect((await exec(page, 'create_part', { id: 'q32', template: 'quad', pins: 32, pitch: 0.8 })).pads).toBe(32);
  expect((await exec(page, 'create_part', { id: 'hdr2x4', template: 'header', pins: 8, rows: 2 })).pads).toBe(8);
  expect((await exec(page, 'create_part', { id: 'res-0402', template: 'two_pad', pitch: 1.0, padw: 0.5, padh: 0.6 })).pads).toBe(2);
  const cp = await exec(page, 'create_part', { id: 'weird', pads: '1:-1:0:1:1/2:1:0:1:1:circle:thru/3:0:2:2:1', body: '4x4', prefix: 'x1' });
  expect(cp).toMatchObject({ pads: 3, body: [4, 4], prefix: 'X' });
  // place + route with a custom part: pad names work like built-ins
  await exec(page, 'place', { type: 'my-soic8', x: 20, y: 20 });
  await exec(page, 'place', { type: 'resistor', x: 10, y: 16 });
  const r = await exec(page, 'route', { from: 'R1.2', to: 'U1.1', net: 'SIG' }); // top pin: the diagonal approach doesn't cross a neighbour
  expect(r.net).toBe('SIG');
  expect((await exec(page, 'drc', {})).errors).toEqual([]);
  await settle(page);
  await expect(page.locator('#trsvg [data-ref="U1"]')).not.toHaveCount(0);
});

test('engine: create_part / delete_part reject bad input and protect parts in use', async ({ page }) => {
  await gotoTrace(page);
  await blank(page);
  expect(await tryExec(page, 'create_part', { id: 'resistor', template: 'dual' })).toContain('built-in');
  expect(await tryExec(page, 'create_part', { id: 'x', template: 'dual', pins: 7 })).toContain('even');
  expect(await tryExec(page, 'create_part', { id: 'x', template: 'nope' })).toContain('unknown template');
  expect(await tryExec(page, 'create_part', { id: 'x' })).toContain('template=');
  expect(await tryExec(page, 'create_part', { id: 'x', pads: '1:0:0' })).toContain('name:x:y:w:h');
  expect(await tryExec(page, 'create_part', { id: 'x', pads: '1:a:0:1:1' })).toContain('non-numeric');
  expect(await tryExec(page, 'create_part', { id: 'x', template: 'two_pad', body: 'big' })).toContain('5x4');
  await exec(page, 'create_part', { id: 'keepme', template: 'two_pad' });
  await exec(page, 'place', { type: 'keepme', x: 10, y: 10 });
  expect(await tryExec(page, 'delete_part', { id: 'keepme' })).toContain('placed on the board');
  expect(await tryExec(page, 'delete_part', { id: 'resistor' })).toContain('built in');
  expect(await tryExec(page, 'delete_part', { id: 'ghost' })).toContain('no part');
  const ref = (await state(page)).parts[0].ref;
  await exec(page, 'remove', { ref });
  expect((await exec(page, 'delete_part', { id: 'keepme' })).deleted).toBe('keepme');
});

test('UI: Create part dialog builds a part, saves it to disk, and it can be placed', async ({ page, request }) => {
  await gotoTrace(page);
  await blank(page);
  await page.click('#trnewpart');
  await expect(page.locator('#trmodal')).toBeVisible();
  await page.fill('#trpl', 'Flash SOIC-8');
  await page.selectOption('#trpt', 'dual');
  await page.fill('#trpins', '8');
  await page.click('#trpcreate');
  await expect(page.locator('#trpmsg')).toContainText('8 pads');
  await expect(page.locator('#trparts [data-part="flash_soic-8"]')).toContainText('Flash SOIC-8');
  await expect.poll(async () => (await parts(request)).map((p) => p.id)).toContain('flash_soic-8');
  const saved = (await parts(request)).find((p) => p.id === 'flash_soic-8');
  expect(saved.pads).toHaveLength(8);
  await page.keyboard.press('Escape'); // closes the dialog first, not the studio
  await expect(page.locator('#trmodal')).toBeHidden();
  expect(await page.evaluate(() => trOpen)).toBe(true);
  await page.click('[data-part="flash_soic-8"]');
  const p = await px(page, 30, 20);
  await page.mouse.click(p.x, p.y);
  expect((await state(page)).parts[0]).toMatchObject({ type: 'flash_soic-8', ref: 'U1' });
  // empty name → friendly error, nothing created
  await page.click('#trnewpart');
  await page.fill('#trpl', '');
  await page.click('#trpcreate');
  await expect(page.locator('#trpmsg')).toContainText('Give the part a name');
});

test('UI: custom part can be deleted from the library (file removed); built-ins have no delete', async ({ page, request }) => {
  await gotoTrace(page);
  await exec(page, 'create_part', { id: 'tmp-part', template: 'two_pad', label: 'Temp part' });
  await expect(page.locator('[data-delpart="tmp-part"]')).toBeVisible();
  await expect(page.locator('[data-delpart="resistor"]')).toHaveCount(0);
  await expect.poll(async () => (await parts(request)).length).toBe(1);
  await page.click('[data-delpart="tmp-part"]');
  await expect(page.locator('[data-part="tmp-part"]')).toHaveCount(0);
  await expect.poll(async () => (await parts(request)).length).toBe(0);
});

test('parts persist on disk: still there after the browser forgets everything', async ({ page, request }) => {
  await gotoTrace(page);
  await exec(page, 'create_part', { id: 'forever', template: 'quad', pins: 16, label: 'Forever QFN' });
  await expect.poll(async () => (await parts(request)).length).toBe(1);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await expect(page.locator('[data-part="forever"]')).toContainText('Forever QFN'); // loaded from the file on disk
  await exec(page, 'place', { type: 'forever', x: 30, y: 20 });
  expect((await exec(page, 'board', {})).parts.find((q) => q.type === 'forever').pads).toHaveLength(16);
});

test('a saved board still renders its custom parts even if the library file is gone', async ({ page, request }) => {
  await gotoTrace(page);
  await blank(page);
  await exec(page, 'create_part', { id: 'ephemeral', template: 'dual', pins: 6, label: 'Ephemeral', prefix: 'U' });
  await exec(page, 'place', { type: 'ephemeral', x: 30, y: 20 });
  await page.waitForTimeout(400);
  for (const p of await parts(request)) await request.delete(API + '/parts/' + p.id);
  await page.evaluate(() => localStorage.removeItem('trace-parts-v1'));
  await page.reload();
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  expect(await page.evaluate(() => TRACE.pads(TRACE.findPart('U1')).length)).toBe(6); // definition travelled inside the saved board
});

test('UI: Find online searches the footprint library and imports a part (pads parsed from KiCad)', async ({ page, request }) => {
  await gotoTrace(page);
  await page.click('#trfindpart');
  await page.fill('#trsq', 'soic');
  await page.press('#trsq', 'Enter');
  await expect(page.locator('#trsr')).toContainText('SOIC-8_3.9x4.9mm_P1.27mm');
  await page.click('#trsr [data-import]');
  await expect(page.locator('#trsr [data-import]').first()).toHaveText('✓ Added');
  await expect(page.locator('#trlog')).toContainText('imported soic-8_3.9x4.9mm_p1.27mm · 8 pads');
  await page.click('#trmodalclose');
  await expect(page.locator('#trparts [data-part="soic-8_3.9x4.9mm_p1.27mm"]')).toBeVisible();
  await expect.poll(async () => (await parts(request)).length).toBe(1);
  const def = (await parts(request))[0];
  expect(def.id).toBe('soic-8_3.9x4.9mm_p1.27mm');
  expect(def.source).toContain('KiCad footprint library');
  expect(def.body).toEqual([7.4, 5.8]); // courtyard extents
  expect(def.pads.find((q) => q.n === '1')).toMatchObject({ x: -2.475, y: -1.905, w: 1.95, h: 0.6 });
  expect(def.pads.find((q) => q.n === '8').x).toBeGreaterThan(0);
  // searching for nonsense gives a hint, not a crash
  await page.click('#trfindpart');
  await page.fill('#trsq', 'zzzqqq');
  await page.click('#trsgo');
  await expect(page.locator('#trsr')).toContainText('Nothing found');
});

test('Find online with the agent server offline explains how to fix it', async ({ page }) => {
  await gotoTrace(page, '?agents=59999');
  await page.click('#trfindpart');
  await page.fill('#trsq', 'soic');
  await page.click('#trsgo');
  await expect(page.locator('#trsr')).toContainText('npm run agents');
});

test('footprint import parses thru-hole + rotated pads; refuses unknown paths and bad part files', async ({ request }) => {
  const hits = await (await request.get(API + '/parts/search?q=pinheader')).json();
  expect(hits[0].name).toBe('PinHeader_1x02_P2.54mm_Vertical');
  const imp = await (await request.get(API + '/parts/import?path=' + encodeURIComponent(hits[0].path))).json();
  expect(imp.def.pads).toHaveLength(2);
  expect(imp.def.pads[0]).toMatchObject({ thru: true, shape: 'rect', w: 1.7 });
  expect(imp.def.pads[1]).toMatchObject({ thru: true, shape: 'circle' }); // oval 1.7x1.7 → round
  expect(imp.def.prefix).toBe('J');
  const bad = await request.get(API + '/parts/import?path=' + encodeURIComponent('../../etc/passwd'));
  expect(bad.status()).toBe(502);
  expect((await bad.json()).error).toContain('unknown footprint path');
  expect((await request.get(API + '/parts/search?q=')).status()).toBe(502);
  const post = await request.post(API + '/parts', { data: { id: 'Bad ID!', pads: [{ n: '1', x: 0, y: 0, w: 1, h: 1 }], body: [1, 1] } });
  expect(post.status()).toBe(400);
  expect((await request.delete(API + '/parts/..%2Fevil')).status()).toBe(400);
  expect((await request.delete(API + '/parts/not-there')).status()).toBe(404);
});

test('Claude CLI: search_parts + import_part add a real footprint to the live board library', async ({ page, request }) => {
  await gotoTrace(page);
  await expect.poll(async () => (await (await request.get(API + '/trace/status')).json()).open).toBe(true);
  const token = (await (await request.get(API + '/health')).json()).token;
  const s = await cli(token, 'search_parts', 'q=0603');
  expect(s.code).toBe(0);
  const hits = JSON.parse(s.out);
  expect(hits[0].path).toContain('R_0603');
  const i = await cli(token, 'import_part', 'path=' + hits[0].path, 'id=r0603');
  expect(i.code).toBe(0);
  expect(JSON.parse(i.out)).toMatchObject({ id: 'r0603', pads: 2 });
  await expect(page.locator('[data-part="r0603"]')).toBeVisible();
  const placed = await cli(token, 'place', 'type=r0603', 'x=20', 'y=20');
  expect(placed.code).toBe(0);
  expect((await state(page)).parts.some((q) => q.type === 'r0603')).toBe(true);
  const bad = await cli(token, 'import_part', 'path=nope.kicad_mod');
  expect(bad.code).toBe(1);
  expect(bad.err).toContain('unknown footprint path');
  const none = await cli(token, 'search_parts', 'q=zzzzqqqq');
  expect(JSON.parse(none.out).note).toContain('nothing found');
});

test('AI activity: working shows a scanning animation; finishing shows a check; then it clears', async ({ page }) => {
  await gotoTrace(page);
  await page.evaluate(() => trSetAI('working'));
  await expect(page.locator('#trstage')).toHaveClass(/ai-working/);
  await expect(page.locator('#trai')).toContainText('Claude is working');
  await expect(page.locator('.tr-dock')).toHaveClass(/working/);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.tr-scan')).animationName)).toBe('trscan');
  expect(await page.evaluate(() => +getComputedStyle(document.querySelector('.tr-scan')).opacity)).toBe(1);
  await page.evaluate(() => trSetAI('done'));
  await expect(page.locator('#trstage')).toHaveClass(/ai-done/);
  await expect(page.locator('#trstage')).not.toHaveClass(/ai-working/);
  await expect(page.locator('#trai')).toContainText('Claude finished');
  await expect(page.locator('#trai .tick')).toHaveCount(1);
  await expect(page.locator('#trai')).toHaveAttribute('data-state', 'idle', { timeout: 6000 }); // auto-clears
  await expect(page.locator('#trstage')).not.toHaveClass(/ai-done/);
});

test('AI activity: a real chat turn runs working → finished; edits Claude makes are counted', async ({ page, request }) => {
  await gotoTrace(page);
  await expect(page.locator('#trst')).toContainText('connected');
  await expect.poll(async () => (await (await request.get(API + '/trace/status')).json()).open).toBe(true);
  await blank(page);
  const token = (await (await request.get(API + '/health')).json()).token;
  await page.evaluate(() => {
    window.__ai = [];
    new MutationObserver(() => window.__ai.push(document.getElementById('trai').dataset.state))
      .observe(document.getElementById('trai'), { attributes: true, attributeFilter: ['data-state'] });
  });
  await page.fill('#trin', 'do something');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trai')).toHaveAttribute('data-state', 'done');
  const seq = await page.evaluate(() => window.__ai);
  expect(seq.indexOf('working')).toBeGreaterThanOrEqual(0);
  expect(seq.indexOf('working')).toBeLessThan(seq.indexOf('done'));
  await page.evaluate(() => trSetAI('working'));
  await request.post(API + '/trace/cmd', { data: { token, cmd: 'place', args: ['type=led', 'x=10', 'y=10'] } });
  await expect(page.locator('#trai')).toContainText('1 edit');
});

test('AI activity: a failed send ends in a stopped state, not a stuck spinner', async ({ page }) => {
  await gotoTrace(page);
  await expect(page.locator('#trst')).toContainText('connected');
  await page.route('**/session/*/input', (r) => r.abort());
  await page.fill('#trin', 'hello');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trai')).toContainText('Claude stopped');
  await expect(page.locator('#trstage')).not.toHaveClass(/ai-working/);
});
