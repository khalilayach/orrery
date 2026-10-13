// @ts-check
// E2E tests for the TRACE workspace redesign: schematic symbols / portals / blocks, the Library and Objects
// panel, wire classes (Rules), board outline + cutouts, and the Code tab.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mockCatalog } from './helpers/catalog.js';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
async function gotoTrace(page, tab = 'graph') {
  await page.addInitScript((t) => { try { localStorage.setItem('trace-tab-v1', t); localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } }, tab);
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
  await page.evaluate(() => TRACE.exec('clear', {}));
}
const exec = (page, cmd, args, source) => page.evaluate(([c, a, s]) => TRACE.exec(c, a, s), [cmd, args, source]);
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));
const px = (page, x, y) => page.evaluate(([x, y]) => { const svg = document.getElementById('trsvg'), r = svg.getBoundingClientRect(), [vx, vy, vw] = svg.getAttribute('viewBox').split(' ').map(Number), k = r.width / vw; return { x: r.left + (x - vx) * k, y: r.top + (y - vy) * k }; }, [x, y]);

const DESIGN = {
  replace: true, board: { w: 70, h: 50 },
  parts: [
    { ref: 'J1', type: 'usbc', block: 'USB-C Conn' }, { ref: 'U1', type: 'ldo', block: '3V3 Regulator' }, { ref: 'C1', type: 'capacitor', value: '10uF', block: '3V3 Regulator' },
    { ref: 'U2', type: 'mcu', block: 'Microcontroller' }, { ref: 'U3', type: 'opamp', block: 'Sensor buffer' }, { ref: 'R1', type: 'resistor', value: '150R', block: 'Status LED' }, { ref: 'D1', type: 'led', block: 'Status LED' },
  ],
  nets: { GND: ['J1.GND', 'U1.GND', 'C1.2', 'U2.GND', 'U3.V-', 'D1.K'], VBUS: ['J1.VBUS', 'U1.IN'], '+3V3': ['U1.OUT', 'C1.1', 'U2.VDD', 'U3.V+'], LEDSIG: ['U2.PA5', 'R1.1'], LEDA: ['R1.2', 'D1.A'], ADC: ['U2.PA6', 'U3.OUT', 'U3.IN-'] },
};

// ---------------------------------------------------------------- schematic
test('schematic draws real symbols: IC boxes with named pins, resistor/capacitor/LED symbols, an op-amp triangle, datasheet icons', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  await page.click('#trglay'); await settle(page);
  for (const ref of ['J1', 'U1', 'C1', 'U2', 'U3', 'R1', 'D1']) await expect(page.locator(`[data-node="${ref}"]`)).toHaveCount(1);
  // IC box: a rectangle, pin names inside, datasheet icon
  await expect(page.locator('[data-node="U2"] rect[rx="3"]')).toHaveCount(1);
  await expect(page.locator('[data-node="U2"]')).toContainText('VDD');
  await expect(page.locator('[data-node="U2"]')).toContainText('USB_DP');
  await expect(page.locator('[data-node="U2"] [data-ds]')).toHaveCount(1);
  // two-pin parts are symbols, not boxes
  await expect(page.locator('[data-node="R1"] rect[rx="3"]')).toHaveCount(0);
  expect(await page.locator('[data-node="R1"] path').first().getAttribute('d')).toMatch(/L8 18L20 24/); // the zig-zag
  expect(await page.locator('[data-node="D1"] path').count()).toBeGreaterThan(1);                         // diode triangle + arrows
  // the op-amp is a triangle with + and − inputs
  await expect(page.locator('[data-node="U3"]')).toContainText('+');
  expect(await page.locator('[data-node="U3"] path').first().getAttribute('d')).toMatch(/M18 14V74L86 44Z/);
  // block frames with titles
  const titles = await page.locator('[data-block] text').allTextContents();
  expect(titles).toEqual(expect.arrayContaining(['USB-C Conn', '3V3 Regulator', 'Microcontroller', 'Sensor buffer', 'Status LED']));
});

test('power and ground are portals on the pin, not wires across the sheet; signals are wires', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  await page.click('#trglay'); await settle(page);
  await expect(page.locator('[data-pin="U2.3"]')).toHaveAttribute('data-netkind', 'gnd'); // MCU GND
  await expect(page.locator('[data-pin="U2.4"]')).toHaveAttribute('data-netkind', 'power'); // MCU VDD
  await expect(page.locator('[data-pin="U2.4"]')).toContainText('+3V3');                     // portal shows the rail name
  await expect(page.locator('[data-pin="J1.VBUS"]')).toContainText('VBUS');
  const kinds = await page.locator('[data-wire]').evaluateAll((w) => w.map((x) => x.dataset.wirenet));
  expect(kinds.sort()).toEqual(['ADC', 'ADC', 'LEDA', 'LEDSIG']); // signal nets only (ADC joins three pins)
  // pins that are not wired stay open circles
  await expect(page.locator('[data-pin="U2.9"]')).toHaveAttribute('data-linked', '0');
});

test('signal wires are drawn orthogonally (only horizontal and vertical segments)', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  await page.click('#trglay'); await settle(page);
  const ds = await page.locator('[data-wire] path.wire').evaluateAll((p) => p.map((x) => x.getAttribute('d')));
  expect(ds.length).toBeGreaterThan(0); // (the long ones are net labels — see the next test)
  for (const d of ds) {
    const pts = d.replace(/[ML]/g, ' ').trim().split(/\s+/).reduce((a, v, i, arr) => (i % 2 ? a : a.concat([[+arr[i], +arr[i + 1]]])), []);
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i][0] - pts[i - 1][0]) < 0.01 || Math.abs(pts[i][1] - pts[i - 1][1]) < 0.01, `diagonal segment in ${d}`).toBe(true);
  }
});

test('a very long wire becomes net labels at both ends; selecting it shows the full wire', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'place', { type: 'resistor', x: 10, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 30, y: 10 });
  await exec(page, 'connect', { a: 'R1.2', b: 'R2.1', net: 'FAR' });
  await page.evaluate(() => { TRACE.findPart('R2').gx = 1400; TRACE.findPart('R2').gy = 0; TRACE.findPart('R1').gx = 0; TRACE.findPart('R1').gy = 0; TraceGraph.render(); });
  await settle(page);
  await expect(page.locator('[data-wire][data-label="1"]')).toHaveCount(1);
  await expect(page.locator('[data-wire] text')).toHaveText(['FAR', 'FAR']);
});

test('datasheet icon opens the part datasheet (the sourced part page when known)', async ({ page, context }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'U2', type: 'mcu', buy: { mpn: 'STM32G071', id: 'C707495', price: 1.4 } }] } });
  await settle(page);
  const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('[data-node="U2"] [data-ds]').dispatchEvent('pointerdown')]);
  expect(popup.url()).toContain('lcsc.com/product-detail/C707495');
  await popup.close();
});

test('the op-amp is a real library part with five named pins', async ({ page }) => {
  await gotoTrace(page);
  const r = await exec(page, 'place', { type: 'opamp', x: 20, y: 20 });
  expect(r.pads.map((p) => p.fn)).toEqual(['OUT', 'V-', 'IN+', 'IN-', 'V+']);
  await expect(page.locator('#trparts')).toContainText('Op-amp');
  await exec(page, 'connect', { a: 'U1.OUT', b: 'U1.IN-' }); // the classic buffer
  expect((await state(page)).links.length).toBe(1);
});

test('new parts are placed on the schematic in free space even when added one by one', async ({ page }) => {
  await gotoTrace(page);
  for (const [type, x, y] of [['usbc', 10, 20], ['ldo', 30, 20], ['mcu', 50, 20], ['resistor', 30, 40], ['led', 45, 40]]) { await exec(page, 'place', { type, x, y }); await settle(page); }
  const boxes = await page.evaluate(() => TraceGraph._G.nodes.map((n) => ({ ref: n.p.ref, x: n.x, y: n.y, w: n.w, h: n.h })));
  expect(boxes.length).toBe(5);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, a.ref + ' overlaps ' + b.ref).toBe(false);
  }
});

// ---------------------------------------------------------------- library + objects
test('Library: the search bar filters your parts instantly', async ({ page }) => {
  await gotoTrace(page);
  await expect(page.locator('#trparts [data-part]')).not.toHaveCount(0);
  const all = await page.locator('#trparts [data-part]').count();
  await page.fill('#trlibq', 'resistor');
  await expect(page.locator('#trparts [data-part="resistor"]')).toBeVisible();
  await expect(page.locator('#trparts [data-part="mcu"]')).toHaveCount(0); // filtered out
  await page.fill('#trlibq', 'zzzz');
  await expect(page.locator('#trparts [data-part]')).toHaveCount(0);
  await page.press('#trlibq', 'Escape');
  await expect(page.locator('#trparts [data-part]')).toHaveCount(all);
});

test('Library: the same search finds real parts in the catalog (price, stock) and Add puts one in the schematic with its details', async ({ page }) => {
  await mockCatalog(page);
  await gotoTrace(page);
  await page.fill('#trlibq', 'AMS1117');
  await expect(page.locator('.tr-lcard')).toHaveCount(1, { timeout: 8000 });
  await expect(page.locator('.tr-lcard')).toContainText('AMS1117-3.3');
  await expect(page.locator('.tr-lcard')).toContainText('$0.0509');
  await expect(page.locator('.tr-lcard a').first()).toHaveAttribute('href', /lcsc\.com\/product-detail\/C22459274/);
  await page.click('[data-addreal]');
  const s = await state(page);
  expect(s.parts.length).toBe(1);
  expect(s.parts[0].buy.id).toBe('C22459274');
  await expect(page.locator(`[data-node="${s.parts[0].ref}"]`)).toHaveCount(1);
  // a failing search says so without breaking the panel
  await page.unroute('https://jlcsearch.tscircuit.com/**');
  await mockCatalog(page, { offline: true });
  await page.fill('#trlibq', 'something else');
  await expect(page.locator('.tr-lerr')).toContainText("can't reach the parts catalog", { timeout: 8000 });
  await expect(page.locator('#trparts')).toBeVisible();
});

test('Library: clicking a part adds it in the Schematic, and arms the place tool on the PCB', async ({ page }) => {
  await gotoTrace(page);
  await page.click('#trparts [data-part="capacitor"]');
  expect((await state(page)).parts.map((p) => p.type)).toEqual(['capacitor']);
  await expect(page.locator('[data-node="C1"]')).toHaveCount(1);
  await page.keyboard.press('b');
  await page.click('#trparts [data-part="resistor"]');
  expect((await state(page)).parts.length).toBe(1); // armed only — nothing placed yet
  await expect(page.locator('#trhint')).toContainText('click to place');
});

test('Objects: the hierarchy lists components by block, nets with their pins, and selecting shows the part', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  await page.click('[data-ltab="objects"]');
  const tree = page.locator('#trtree');
  await expect(tree).toContainText('Root');
  await expect(tree).toContainText('Components');
  for (const blk of ['USB-C Conn', '3V3 Regulator', 'Microcontroller']) await expect(tree).toContainText(blk);
  await expect(tree.locator('[data-tpart]')).toHaveCount(7);
  await expect(tree.locator('.tr-trow', { hasText: 'Nets' }).first()).toContainText('6'); // GND VBUS +3V3 LEDSIG LEDA ADC
  // nets collapsed until opened, then pins are listed
  await tree.locator('[data-tt="nets"]').click();
  await expect(tree).toContainText('LEDSIG');
  await tree.locator('[data-tt="n:LEDSIG"]').click();
  await expect(tree).toContainText('U2.5');
  // picking a part selects it and shows its properties
  await tree.locator('[data-tpart="R1"]').first().click();
  await expect(page.locator('[data-rtab="inspect"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#trinsp')).toContainText('R1');
  await page.click('[data-ltab="library"]');
  await expect(page.locator('#trparts')).toBeVisible(); // swap between Library and Objects freely
  // problems show on the tree
  await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'J1', type: 'usbc' }, { ref: 'D1', type: 'led' }], nets: { VBUS: ['J1.VBUS', 'D1.A'], GND: ['J1.GND', 'D1.K'] } } });
  await page.click('[data-ltab="objects"]');
  await expect(page.locator('#trtree .tr-trow.danger')).not.toHaveCount(0);
});

test('Objects: board outline and cutouts appear in the tree only on the PCB tab', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'add_cutout', { shape: 'circle', x: 10, y: 10, d: 4 });
  await page.click('[data-ltab="objects"]');
  await expect(page.locator('#trtree')).not.toContainText('Board outline');
  await page.keyboard.press('b');
  await expect(page.locator('#trtree')).toContainText('Board outline');
  await expect(page.locator('#trtree')).toContainText('Cutouts');
  await page.locator('#trtree [data-tt="cuts"]').click();
  await expect(page.locator('#trtree')).toContainText('cut');
});

// ---------------------------------------------------------------- rules (wire classes)
test('Rules tab exists only on the PCB; wire classes drive the width of new traces', async ({ page }) => {
  await gotoTrace(page);
  await expect(page.locator('#trltab-rules')).toBeHidden();
  await page.keyboard.press('b');
  await expect(page.locator('#trltab-rules')).toBeVisible();
  await exec(page, 'build', { spec: DESIGN });
  await page.click('#trltab-rules');
  await expect(page.locator('.tr-rcls')).toHaveCount(2); // Default + Power
  await expect(page.locator('.tr-rcls[data-cls="default"] [data-rk="width"]')).toHaveValue('0.25');
  // assign the power nets and route without saying a width: the class decides
  await page.selectOption('[data-rassign="VBUS"]', 'power');
  await page.selectOption('[data-rassign="+3V3"]', 'power');
  expect((await state(page)).rules.assign).toEqual({ VBUS: 'power', '+3V3': 'power' });
  const wide = await exec(page, 'route', { from: 'J1.VBUS', to: 'U1.IN' });
  expect(wide.width).toBe(0.5); expect(wide.class).toBe('Power');
  const thin = await exec(page, 'route', { from: 'U2.PA5', to: 'R1.1' });
  expect(thin.width).toBe(0.25);
  expect((await exec(page, 'route', { from: 'U2.PA6', to: 'U3.OUT', width: 0.4 })).width).toBe(0.4); // explicit width still wins
  // changing the class re-widths on request
  await page.fill('.tr-rcls[data-cls="power"] [data-rk="width"]', '0.8'); await page.locator('.tr-rcls[data-cls="power"] [data-rk="width"]').dispatchEvent('change');
  await page.click('#trrapply');
  expect((await state(page)).traces.find((t) => t.net === 'VBUS').width).toBe(0.8);
  await expect(page.locator('#trlog')).toContainText('Re-widthed 2 traces'); // VBUS 0.5→0.8 and the 0.4 ADC trace back to its Default 0.25
  expect((await state(page)).traces.find((t) => t.net === 'ADC').width).toBe(0.25);
});

test('classes: create, rename, delete (nets fall back to Default); engine validates', async ({ page }) => {
  await gotoTrace(page, 'board');
  await page.click('#trltab-rules');
  await page.click('#trraddcls');
  await expect(page.locator('.tr-rcls')).toHaveCount(3);
  expect((await state(page)).rules.classes.map((c) => c.name)).toEqual(['Default', 'Power', 'Class 1']);
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 }); await exec(page, 'place', { type: 'resistor', x: 40, y: 20 });
  await exec(page, 'connect', { a: 'R1.2', b: 'R2.1', net: 'SIG' });
  await exec(page, 'rule_assign', { net: 'SIG', class: 'Class 1' });
  await page.locator('.tr-rcls[data-cls="class_1"] [data-rdel]').click();
  expect((await state(page)).rules.assign).toEqual({});
  expect(await tryExec(page, 'rule_class', { name: 'Bad', width: 0.01 })).toMatch(/width must be/);
  expect(await tryExec(page, 'rule_class', { name: 'Bad', via_d: 0.5, via_drill: 0.6 })).toMatch(/smaller than via_d/);
  expect(await tryExec(page, 'rule_assign', { net: 'NOPE', class: 'Power' })).toMatch(/unknown net/);
  expect(await tryExec(page, 'rule_assign', { net: 'SIG', class: 'Ghost' })).toMatch(/no class/);
  expect(await tryExec(page, 'rule_class_delete', { name: 'Default' })).toMatch(/cannot be deleted/);
  expect(await tryExec(page, 'rule_class_delete', { name: 'Ghost' })).toMatch(/no class/);
});

test('class clearance is enforced by DRC (a Power class with a bigger gap flags traces that are too close)', async ({ page }) => {
  await gotoTrace(page, 'board');
  await exec(page, 'rule_class', { name: 'Power', clearance: 1 });
  await exec(page, 'place', { type: 'resistor', x: 15, y: 15 }); await exec(page, 'place', { type: 'resistor', x: 15, y: 16.6 });
  await exec(page, 'connect', { a: 'R1.1', b: 'R1.2', net: 'HOT' });
  await exec(page, 'connect', { a: 'R2.1', b: 'R2.2', net: 'COLD' });
  await exec(page, 'route', { from: 'R1.1', to: 'R1.2', net: 'HOT', width: 0.25 });
  await exec(page, 'route', { from: 'R2.1', to: 'R2.2', net: 'COLD', width: 0.25 });
  expect((await exec(page, 'drc', {})).errors.some((e) => e.rule === 'class_clearance')).toBe(false); // both on Default
  await exec(page, 'rule_assign', { net: 'HOT', class: 'Power' });
  const d = await exec(page, 'drc', {});
  expect(d.errors.some((e) => e.rule === 'class_clearance' && /1 mm \(net class\)/.test(e.msg))).toBe(true);
  // a thinner trace than its class asks for is a warning
  await exec(page, 'rule_class', { name: 'Power', clearance: 0.2, width: 0.6 });
  expect((await exec(page, 'drc', {})).warnings.some((w) => w.rule === 'class_width')).toBe(true);
});

// ---------------------------------------------------------------- board outline + cutouts
test('outline and cutouts: rounded corners, add / move / resize / delete, DRC keeps copper away', async ({ page }) => {
  await gotoTrace(page, 'board');
  await page.click('#trltab-rules');
  await page.fill('#trrrad', '6'); await page.locator('#trrrad').dispatchEvent('change');
  expect((await state(page)).outline.radius).toBe(6);
  await expect(page.locator('#trsvg rect[data-board]')).toHaveAttribute('rx', '6');
  expect(await tryExec(page, 'set_outline', { radius: 999 })).toMatch(/corner radius must be/);
  await page.click('[data-addcut="circle"]');
  const cut = (await state(page)).cutouts[0];
  expect(cut).toMatchObject({ shape: 'circle', d: 3.2 });
  await expect(page.locator('#trsvg [data-cut]')).toHaveCount(1);
  await expect(page.locator('#trinsp')).toContainText('Cutout ' + cut.id); // selected → inspector card
  // edit its size from the inspector
  await page.click('[data-rtab="inspect"]');
  await page.fill('#insd', '5'); await page.locator('#insd').dispatchEvent('change');
  expect((await state(page)).cutouts[0].d).toBe(5);
  // drag it on the PCB, one undo step
  const c = (await state(page)).cutouts[0], at = await px(page, c.x, c.y);
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 60, at.y + 30, { steps: 5 }); await page.mouse.up();
  const moved = (await state(page)).cutouts[0];
  expect(moved.x).toBeGreaterThan(c.x); expect(moved.y).toBeGreaterThan(c.y);
  await page.keyboard.press('Control+z');
  expect((await state(page)).cutouts[0].x).toBe(c.x);
  // other shapes + engine validation
  await exec(page, 'add_cutout', { shape: 'slot', x: 50, y: 30, w: 14, h: 3 });
  await exec(page, 'add_cutout', { shape: 'rect', x: 40, y: 10, w: 8, h: 4 });
  expect((await state(page)).cutouts.map((x) => x.shape)).toEqual(['circle', 'slot', 'rect']);
  expect(await tryExec(page, 'add_cutout', { shape: 'star' })).toMatch(/circle, rect or slot/);
  expect(await tryExec(page, 'add_cutout', { shape: 'circle', x: 500, y: 5 })).toMatch(/off the/);
  expect(await tryExec(page, 'set_cutout', { id: 'nope', x: 1 })).toMatch(/no cutout/);
  // copper near a cutout, and a part over one, are DRC errors
  await exec(page, 'place', { type: 'resistor', x: 40, y: 10 });
  const d = await exec(page, 'drc', {});
  expect(d.errors.some((e) => e.rule === 'cutout' || e.rule === 'cutout_part')).toBe(true);
  await exec(page, 'remove', { ref: 'R1' });
  expect((await exec(page, 'drc', {})).errors.filter((e) => /cutout/.test(e.rule))).toEqual([]);
  await page.locator('#trsvg [data-cut]').first().click({ force: true });
  await page.keyboard.press('Delete');
  expect((await state(page)).cutouts.length).toBe(2);
  expect((await exec(page, 'remove', { id: 'cut999' }).catch((e) => e.message)) || '').toBeDefined();
});

// ---------------------------------------------------------------- code tab
test('Code tab: pin map from the schematic, starter firmware for the chosen target, edits are kept', async ({ page }) => {
  await gotoTrace(page);
  await page.keyboard.press('c');
  await expect(page.locator('.tr-codepins')).toContainText('No microcontroller pins are wired yet');
  await exec(page, 'build', { spec: DESIGN });
  await settle(page);
  const pins = page.locator('.tr-codepins .pin');
  await expect(pins).toHaveCount(2); // PA5 (LED) and PA6 (ADC)
  await expect(pins.filter({ hasText: 'LEDSIG' })).toContainText('output'); // it drives an LED through R1
  await expect(pins.filter({ hasText: 'ADC' })).toContainText('input');
  const ed = page.locator('#trcode-ed');
  await expect(ed).toHaveValue(/#define PIN_LEDSIG +PA5/);
  await expect(ed).toHaveValue(/pinMode\(PIN_LEDSIG, OUTPUT\)/);
  await expect(ed).toHaveValue(/digitalWrite\(PIN_LEDSIG, HIGH\)/);
  await page.selectOption('#trcode-t', 'micropython');
  await expect(ed).toHaveValue(/from machine import Pin/);
  await expect(ed).toHaveValue(/LEDSIG +=\s+Pin\("PA5", Pin\.OUT\)/);
  await page.selectOption('#trcode-t', 'espidf');
  await expect(ed).toHaveValue(/gpio_set_direction\(PIN_LEDSIG, GPIO_MODE_OUTPUT\)/);
  await page.selectOption('#trcode-t', 'header');
  await expect(ed).toHaveValue(/#pragma once/);
  // your edits survive switching targets and redrawing; Regenerate throws them away
  await page.selectOption('#trcode-t', 'arduino');
  await ed.fill('// my own sketch\n');
  await page.selectOption('#trcode-t', 'micropython'); await page.selectOption('#trcode-t', 'arduino');
  await expect(ed).toHaveValue('// my own sketch\n');
  await page.click('#trcode-reset');
  await expect(ed).toHaveValue(/#define PIN_LEDSIG/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#trcode-dl')]);
  expect(dl.suggestedFilename()).toBe('main.ino');
});

test('Code tab: "Ask Claude to write the firmware" sends the pin map and what the circuit does', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  await page.keyboard.press('c');
  await page.click('#trcode-ai');
  await expect(page.locator('.msg.user').last()).toContainText('Write the firmware for this board');
  await expect(page.locator('.msg.user').last()).toContainText('U2.PA5 → net LEDSIG');
  await expect(page.locator('.msg.user').last()).toContainText('5 V signal on a 3.3 V pin');
});

// ---------------------------------------------------------------- engine
test('unplug takes one pin off a net and keeps the rest wired', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  const before = (await state(page)).links.length;
  const r = await exec(page, 'unplug', { pad: 'U1.GND' });
  expect(r.kept_wired.length).toBeGreaterThan(0);
  const s = await state(page);
  const gnd = ['J1.GND', 'C1.2', 'U2.3', 'U3.2', 'D1.K'];
  for (const p of gnd) expect(s.links.some((l) => l.a === p || l.b === p)).toBe(true); // everyone else is still on GND
  expect(s.links.some((l) => l.a === 'U1.GND' || l.b === 'U1.GND')).toBe(false);
  expect(before - s.links.length).toBeGreaterThanOrEqual(1);
  expect(await tryExec(page, 'unplug', { pad: 'U1.GND' })).toMatch(/not wired/);
  expect(await tryExec(page, 'unplug', { pad: 'U1' })).toMatch(/not a pad/);
});

test('build keeps the block name on every part (it becomes the schematic sheet)', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  const s = await state(page);
  expect(s.parts.find((p) => p.ref === 'U3').block).toBe('Sensor buffer');
  expect(s.parts.find((p) => p.ref === 'R1').block).toBe('Status LED');
  expect((await exec(page, 'circuit', {})).text).toMatch(/U3 Op-amp/);
});
