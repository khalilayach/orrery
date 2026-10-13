// @ts-check
// E2E tests for TRACE's tabs and the Graph view (trace/graph.js): node editor with
// pins and wires, logical links (connect/disconnect/auto_wire), live error display,
// ratsnest on the Board tab, persistence.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;

async function gotoTrace(page, { graph = false } = {}) {
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
  if (graph) await openGraph(page);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40)))));
async function openGraph(page) { await page.click('[data-vtab="graph"]'); await settle(page); }
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const links = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()).links);
const pin = (page, ref) => page.locator(`[data-pin="${ref}"] circle`).nth(1);
/** screen position of the middle of the first signal wire (its centre box is often empty space) */
async function wirePoint(page) {
  return page.evaluate(() => {
    const p = document.querySelector('#trgsvg [data-wire] path'), m = p.getScreenCTM(), L = p.getTotalLength();
    for (let t = 0.5, i = 0; i < 40; i++, t = 0.5 + ((i % 2 ? 1 : -1) * Math.ceil(i / 2)) / 44) { // search outwards from the middle for a spot nothing else covers
      const pt = p.getPointAtLength(L * t), x = pt.x * m.a + m.e, y = pt.y * m.d + m.f, hit = document.elementFromPoint(x, y);
      if (hit && hit.closest('[data-wire]') && !hit.closest('[data-pin]')) return { x, y };
    }
    throw new Error('no clickable spot on the wire');
  });
}
async function dragPin(page, from, to) {
  const a = await pin(page, from).boundingBox(), b = await pin(page, to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await settle(page);
}
/** USB-C, LDO, MCU, resistor, LED placed on an empty board */
async function circuit(page) {
  await exec(page, 'clear', {});
  for (const [type, x, y, value] of [['usbc', 10, 20], ['ldo', 30, 20], ['mcu', 50, 20], ['resistor', 30, 40, '330R'], ['led', 45, 40]])
    await exec(page, 'place', { type, x, y, value });
  await settle(page);
}

test('tabs: Schematic is first and the default; Code and PCB switch with S/C/B; the choice is remembered', async ({ page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.removeItem('trace-tab-v1'); sessionStorage.setItem('seeded', '1'); } } catch (_) { /* ignore */ } });
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await expect(page.locator('.tr-vtabs [data-vtab]').evaluateAll((b) => b.map((x) => x.dataset.vtab))).resolves.toEqual(['graph', 'code', 'board']); // Schematic | Code | PCB
  await expect(page.locator('[data-vtab="graph"]')).toHaveText(/Schematic/);
  await expect(page.locator('[data-vtab="board"]')).toHaveText(/PCB/);
  await expect(page.locator('[data-vtab="graph"]')).toHaveAttribute('aria-selected', 'true'); // default
  await expect(page.locator('#trgraph')).toBeVisible();
  await expect(page.locator('#trstage')).toBeHidden();
  await page.keyboard.press('c');
  await expect(page.locator('#trcode')).toBeVisible();
  await expect(page.locator('#trgraph')).toBeHidden();
  await page.keyboard.press('b');
  await expect(page.locator('#trstage')).toBeVisible();
  await expect(page.locator('#trcode')).toBeHidden();
  await expect(page.locator('#trsvg [data-ref]').first()).toBeVisible(); // the PCB draws properly after being hidden at start-up
  await page.reload();
  await expect(page.locator('#trstage')).toBeVisible(); // remembered
  await page.keyboard.press('s');
  await expect(page.locator('#trgraph')).toBeVisible();
});

test('graph: every real part is a node with its pins; mounting holes are not', async ({ page }) => {
  await gotoTrace(page, { graph: true });
  for (const ref of ['J1', 'U1', 'U2', 'J2']) await expect(page.locator(`[data-node="${ref}"]`)).toHaveCount(1);
  await expect(page.locator('[data-node="H1"]')).toHaveCount(0);
  await expect(page.locator('[data-pin="J1.VBUS"]')).toHaveCount(1);
  await expect(page.locator('[data-pin="U2.GND"]')).toHaveCount(1);
  // the sample's copper shows up as wires
  expect(await page.locator('[data-wire][data-kind="trace"]').count()).toBeGreaterThan(1); // signal copper; power and ground are drawn as symbols
  await expect(page.locator('[data-pin][data-netkind="gnd"]').first()).toBeAttached();
  await expect(page.locator('[data-pin][data-netkind="power"]').first()).toBeAttached();
  await expect(page.locator('.tr-gissues')).toHaveAttribute('data-level', 'safe');
});

test('graph: dragging pin to pin creates a wire; power and ground become symbols; the engine rejects bad wires', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await openGraph(page);
  await dragPin(page, 'J1.D+', 'U2.1');
  expect((await links(page)).map((l) => [l.a, l.b])).toEqual([['J1.D+', 'U2.1']]);
  await expect(page.locator('[data-wire][data-kind="link"]')).toHaveCount(1);
  await expect(page.locator('[data-pin="U2.1"]')).toHaveAttribute('data-linked', '1');
  await expect(page.locator('.tr-gtoast')).toContainText('net');
  // a ground connection is not a wire across the sheet: both pins get ground symbols
  await dragPin(page, 'J1.GND', 'U1.GND');
  expect((await links(page)).length).toBe(2);
  await expect(page.locator('[data-pin="J1.GND"]')).toHaveAttribute('data-netkind', 'gnd');
  await expect(page.locator('[data-pin="U1.GND"]')).toHaveAttribute('data-netkind', 'gnd');
  await expect(page.locator('[data-wire][data-kind="link"]')).toHaveCount(1); // still only the signal wire
  // the engine rejects a repeat and a self-wire
  expect(await tryExec(page, 'connect', { a: 'J1.GND', b: 'U1.GND' })).toMatch(/already wired/);
  expect(await tryExec(page, 'connect', { a: 'J1.GND', b: 'J1.GND' })).toMatch(/itself/);
  expect(await tryExec(page, 'connect', { a: 'J1', b: 'U1.GND' })).toMatch(/not a pad/);
  expect(await tryExec(page, 'connect', { a: 'ZZ.1', b: 'U1.GND' })).toMatch(/unknown part/);
  expect((await links(page)).length).toBe(2);
  // dropping on empty canvas makes nothing
  const a = await pin(page, 'J1.D-').boundingBox();
  await page.mouse.move(a.x + 4, a.y + 4); await page.mouse.down(); await page.mouse.move(a.x - 80, a.y - 50, { steps: 4 }); await page.mouse.up();
  expect((await links(page)).length).toBe(2);
});

test('graph: clicking a ground or power symbol selects it, and Delete takes just that pin off the net', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await exec(page, 'build', { spec: { parts: [], nets: {} } }).catch(() => {});
  await exec(page, 'connect', { a: 'J1.GND', b: 'U1.GND' });
  await exec(page, 'connect', { a: 'J1.GND', b: 'U2.GND' });
  await openGraph(page);
  await pin(page, 'U1.GND').click({ force: true });
  expect(await page.evaluate(() => TraceGraph._G.sel)).toEqual({ kind: 'pin', id: 'U1.GND' });
  await page.keyboard.press('Delete');
  const l = await links(page);
  expect(l.map((x) => [x.a, x.b].sort().join('~'))).toEqual(['J1.GND~U2.3']); // the other two are still joined
  await expect(page.locator('[data-pin="U1.GND"]')).toHaveAttribute('data-netkind', '');
  expect(await tryExec(page, 'unplug', { pad: 'U1.GND' })).toMatch(/not wired/);
});

test('graph: select a wire, Delete removes it; the × button and undo work too', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await openGraph(page);
  await dragPin(page, 'J1.D+', 'U2.1');
  { const w = await wirePoint(page); await page.mouse.click(w.x, w.y); }
  await expect(page.locator('[data-del]')).toHaveCount(1);
  await page.keyboard.press('Delete');
  expect((await links(page)).length).toBe(0);
  await expect(page.locator('[data-wire]')).toHaveCount(0);
  await exec(page, 'undo', {}); // wire comes back
  expect((await links(page)).length).toBe(1);
  await settle(page);
  { const w = await wirePoint(page); await page.mouse.click(w.x, w.y); }
  await page.locator('[data-del]').click();
  expect((await links(page)).length).toBe(0);
  expect(await tryExec(page, 'disconnect', { a: 'J1.D+', b: 'U2.USB_DP' })).toMatch(/not linked/);
});

test('graph: a short (VBUS to GND) lights up the nodes, wire and issue list', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await exec(page, 'auto_wire', {});
  await openGraph(page);
  await expect(page.locator('.tr-gissues')).not.toHaveAttribute('data-level', 'danger');
  await exec(page, 'connect', { a: 'J1.VBUS', b: 'J1.GND' });
  await settle(page);
  await expect(page.locator('.tr-gissues')).toHaveAttribute('data-level', 'danger');
  await expect(page.locator('[data-node="J1"]')).toHaveAttribute('data-level', 'danger');
  await expect(page.locator('[data-wire][data-level="danger"]').first()).toBeAttached();
  await expect(page.locator('.tr-gi.danger').first()).toContainText('short');
  // clicking the issue selects the culprit and shows its fix
  await page.locator('.tr-gi.danger').first().click();
  await expect(page.locator('.tr-gi .f').first()).toContainText('Fix:');
  // remove the bad wire and the error clears
  await exec(page, 'disconnect', { a: 'J1.VBUS', b: 'J1.GND' });
  await settle(page);
  await expect(page.locator('.tr-gissues')).not.toHaveAttribute('data-level', 'danger');
  await expect(page.locator('[data-node="J1"]')).toHaveAttribute('data-level', '');
});

test('auto-wire connects ground, supplies and USB; a second press finds nothing new', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await openGraph(page);
  await page.click('#trgauto');
  const l1 = (await links(page)).map((l) => l.a + '>' + l.b);
  expect(l1).toEqual(expect.arrayContaining(['J1.GND>U1.GND', 'J1.VBUS>U1.IN', 'U1.OUT>U2.4']));
  expect(l1.some((x) => /D\+/.test(x))).toBe(true);
  await expect(page.locator('#trgraph .tr-gtoast')).toContainText('Connected');
  const n = l1.length;
  await page.click('#trgauto');
  expect((await links(page)).length).toBe(n);
  await expect(page.locator('#trgraph .tr-gtoast')).toContainText('Nothing new');
  const r = await exec(page, 'analyze', {});
  expect(r.level).not.toBe('danger'); // 5 V goes through the regulator, never straight to the 3.3 V chip
  expect(r.issues.map((i) => i.code)).toContain('unrouted');
});

test('auto-wire respects voltage limits: a 3.3 V chip with no regulator is left unpowered, with a reason', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'usbc', x: 10, y: 20 });
  await exec(page, 'place', { type: 'mcu', x: 40, y: 20 });
  const r = await exec(page, 'auto_wire', {});
  expect(r.connected.join()).not.toMatch(/VBUS/);
  expect(r.needs_a_human_or_claude.join()).toMatch(/regulator/);
});

test('board tab shows dashed airwires for unrouted graph wires, and drops them once copper exists', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'resistor', x: 15, y: 15 });
  await exec(page, 'place', { type: 'resistor', x: 30, y: 15 });
  await exec(page, 'connect', { a: 'R1.2', b: 'R2.1' });
  await settle(page);
  await expect(page.locator('#trsvg [data-rat]')).toHaveCount(1);
  await exec(page, 'route', { from: 'R1.2', to: 'R2.1' });
  await settle(page);
  await expect(page.locator('#trsvg [data-rat]')).toHaveCount(0);
  expect((await exec(page, 'analyze', {})).issues.map((i) => i.code)).not.toContain('unrouted');
});

test('graph: Add part places a node; removing a part drops its wires; nodes drag and keep their place', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await exec(page, 'auto_wire', {});
  await openGraph(page);
  await page.selectOption('#trgadd', 'capacitor');
  await settle(page);
  await expect(page.locator('[data-node="C1"]')).toHaveCount(1);
  const before = await exec(page, 'board', {});
  expect(before.links.length).toBeGreaterThan(3);
  await exec(page, 'remove', { ref: 'U1' });
  const after = (await exec(page, 'board', {})).links;
  expect(after.some((l) => l.a.startsWith('U1.') || l.b.startsWith('U1.'))).toBe(false);
  // drag the LED node by its header
  const head = page.locator('[data-node="D1"] [data-head]');
  const h = await head.boundingBox();
  const gx0 = await page.evaluate(() => TRACE.findPart('D1').gx);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down(); await page.mouse.move(h.x + h.width / 2 + 90, h.y + h.height / 2 + 40, { steps: 5 }); await page.mouse.up();
  await settle(page);
  expect(await page.evaluate(() => TRACE.findPart('D1').gx)).toBeGreaterThan(gx0);
  await page.reload();
  await settle(page);
  const saved = await page.evaluate(() => TRACE.findPart('D1') && TRACE.findPart('D1').gx);
  expect(saved).toBeGreaterThan(gx0);
});

test('graph: newly added parts never land on top of existing nodes', async ({ page }) => {
  await gotoTrace(page);
  await circuit(page);
  await exec(page, 'auto_wire', {});
  await openGraph(page);
  for (let i = 0; i < 4; i++) { await page.selectOption('#trgadd', 'resistor'); await settle(page); }
  const boxes = await page.evaluate(() => TraceGraph._G.nodes.map((n) => ({ ref: n.p.ref, x: n.x, y: n.y, w: n.w, h: n.h })));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, a.ref + ' overlaps ' + b.ref).toBe(false);
  }
});

test('graph: Ask Claude hands the whole task to the dock; empty graph says so', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await openGraph(page);
  await expect(page.locator('.tr-gempty')).toBeVisible();
  await page.click('#trgai');
  await expect(page.locator('#trlog')).toContainText('Read the circuit');
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 });
  await settle(page);
  await expect(page.locator('.tr-gempty')).toBeHidden();
});

test('regression: board keyboard tools do nothing on the Graph tab', async ({ page }) => {
  await gotoTrace(page, { graph: true });
  await page.keyboard.press('w'); // route tool on the Board tab
  expect(await page.evaluate(() => document.querySelector('#tr [data-tool="route"]').getAttribute('aria-pressed'))).toBe('false');
  await page.keyboard.press('b');
  await page.keyboard.press('w');
  expect(await page.evaluate(() => document.querySelector('#tr [data-tool="route"]').getAttribute('aria-pressed'))).toBe('true');
});
