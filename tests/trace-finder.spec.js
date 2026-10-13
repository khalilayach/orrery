// @ts-check
// E2E tests for the TRACE parts finder: real-part search (price, stock, buy links), adding parts to the
// Graph with their real ratings, sourcing, the BOM, suggested fixes, offline behaviour and the CLI.
// The parts catalog is a fixture (tests/helpers/catalog.js) so nothing here touches the internet.
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startMock } from './helpers/mock-server.js';
import { mockCatalog, startCatalog } from './helpers/catalog.js';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = pathToFileURL(resolve(ROOT, 'index.html')).href;

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40)))));
async function gotoGraph(page, qs = '?agents=57312') {
  await page.addInitScript(() => { try { localStorage.removeItem('trace-finder-v1'); } catch (_) { /* ignore */ } });
  await page.goto(PAGE + qs + '#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await page.click('[data-vtab="graph"]');
  await settle(page);
}
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));
async function search(page, q, kind = '') {
  if (!(await page.locator('#trgfind').isVisible())) await page.click('#trgfindbtn');
  await page.fill('#trfq', q);
  await page.selectOption('#trfk', kind);
  await page.click('#trfgo');
  await expect(page.locator('.tr-fc').first()).toBeVisible();
}

test('finder maths: values, formatting and what you typed are understood', async ({ page }) => {
  await gotoGraph(page);
  const r = await page.evaluate(() => {
    const F = TraceFinder;
    return { v: ['330R', '4k7', '0R1', '100nF', '10uF', '3.3V', '1M', 'abc'].map(F.parseValue), o: [330, 4700, 0.1, 1e6].map(F.fmtOhms), c: [1e-7, 1e-5, 2.2e-11].map(F.fmtFarads),
      i1: F.intent('100nF 0603'), i2: F.intent('3.3V LDO'), i3: F.intent('green led'), i4: F.intent('AMS1117-3.3') };
  });
  expect(r.v.slice(0, 4)).toEqual([330, 4700, 0.1, expect.closeTo(1e-7, 12)]);
  expect(r.v[7]).toBeNaN();
  expect(r.o).toEqual(['330R', '4k7', '0R1', '1M']);
  expect(r.c).toEqual(['100nF', '10uF', '22pF']);
  expect([r.i1.kind, r.i1.pkg]).toEqual(['capacitor', '0603']);
  expect([r.i2.kind, r.i2.volts]).toEqual(['regulator', 3.3]);
  expect([r.i3.kind, r.i3.color]).toEqual(['led', 'green']);
  expect(r.i4.kind).toBe(''); // a bare part number is a generic search
});

test('search shows real parts: best stocked + basic first, price, stock and buy links', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await search(page, '330R 0603');
  const cards = page.locator('.tr-fc');
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toContainText('R-330-BASIC');
  await expect(cards.first()).toContainText('$0.0016');
  await expect(cards.first()).toContainText('1.1M in stock');
  await expect(cards.first().locator('.bs')).toHaveText('basic');
  await expect(cards.nth(1)).toContainText('18 in stock'); // barely stocked → second
  await expect(cards.last()).toContainText('out of stock'); // never first
  const hrefs = await cards.first().locator('.lk a').evaluateAll((a) => a.map((x) => x.href));
  expect(hrefs[0]).toBe('https://www.lcsc.com/product-detail/C23138.html');
  expect(hrefs.join(' ')).toMatch(/digikey\.com.*R-330-BASIC/);
  expect(hrefs.join(' ')).toMatch(/mouser\.com/);
  expect(hrefs.join(' ')).toMatch(/datasheet/);
});

test('add to graph: part lands in the diagram with its value, real price and sourcing', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await search(page, '100nF 0603');
  await page.locator('[data-add]').first().click();
  const s = await state(page);
  expect(s.parts.map((p) => [p.ref, p.type, p.value])).toEqual([['C1', 'capacitor', '100nF']]);
  expect(s.parts[0].buy).toMatchObject({ id: 'C14663', price: 0.0022, pkg: '0603' });
  expect(s.parts[0].elec).toMatchObject({ vmax: 50 }); // real voltage rating from the catalog
  await expect(page.locator('[data-node="C1"] [data-buy]')).toContainText('C14663');
  await expect(page.locator('#trgraph .tr-gtoast')).toContainText('Added C1');
  // BOM tab sums it
  await page.click('.tr-fhead [data-tab="bom"]');
  await expect(page.locator('.tr-brow')).toHaveCount(1);
  await expect(page.locator('[data-total]')).toHaveAttribute('data-total', '0.0022');
});

test('regulator search filters by voltage; adding sets the real limits the safety check uses', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await search(page, '3.3V LDO');
  await expect(page.locator('.tr-fc')).toHaveCount(2); // the 5 V part is filtered out
  await expect(page.locator('.tr-fc').first()).toContainText('AMS1117-3.3');
  await page.locator('[data-add]').first().click();
  const p = (await state(page)).parts[0];
  expect(p.type).toBe('ldo');
  expect(p.elec).toMatchObject({ vout: 3.3, dropout: 1.3, vin_max: 18, imax: 1 });
});

test('generic part-number search ranks relevant hits and builds a footprint from the package', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await search(page, 'AMS1117');
  await expect(page.locator('.tr-fc')).toHaveCount(1); // the unrelated ferrite bead is dropped
  await expect(page.locator('.tr-fc .warn')).toContainText('approximate SOT-223');
  await page.locator('[data-add]').first().click();
  const s = await state(page);
  expect(s.parts[0].type).toBe('found-c22459274');
  expect(s.lib['found-c22459274'].pads.length).toBe(4);
  expect(s.parts[0].buy.tiers.length).toBe(3);
});

test('nothing found says so; an empty search asks what you want', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await page.click('#trgfindbtn');
  await page.click('#trfgo');
  await expect(page.locator('.tr-ferr')).toContainText('Type what you are looking for');
  await page.fill('#trfq', 'zzzzqqq');
  await page.click('#trfgo');
  await expect(page.locator('.tr-fnote').filter({ hasText: 'Nothing matched' })).toBeVisible();
});

test('offline: a clear message, and the panel stays usable', async ({ page }) => {
  await mockCatalog(page, { offline: true });
  await gotoGraph(page);
  await page.click('#trgfindbtn');
  await page.fill('#trfq', '330R');
  await page.click('#trfgo');
  await expect(page.locator('.tr-ferr')).toContainText("can't reach the parts catalog");
  await expect(page.locator('#trfgo')).toBeEnabled();
});

test('a repeat search is served from the cache (no second network call)', async ({ page }) => {
  const calls = await mockCatalog(page);
  await gotoGraph(page);
  await search(page, '100nF 0603');
  const n = calls.length;
  await page.click('#trfgo');
  await expect(page.locator('.tr-fc').first()).toBeVisible();
  expect(calls.length).toBe(n);
});

test('LED without a resistor: the suggested fix computes a value, splices it in and sources it', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'usbc', x: 10, y: 20 });
  await exec(page, 'place', { type: 'led', x: 40, y: 30 });
  await exec(page, 'connect', { a: 'J1.VBUS', b: 'D1.A' });
  await exec(page, 'connect', { a: 'D1.K', b: 'J1.GND' });
  await settle(page);
  expect((await exec(page, 'analyze', {})).issues.map((i) => i.code)).toContain('led_overcurrent');
  await page.click('#trgfindbtn');
  const fix = page.locator('[data-series]');
  await expect(fix).toHaveCount(1);
  const label = await fix.textContent();
  expect(label).toMatch(/Add \d+R? resistor|Add \d+(\.\d+)?k resistor/);
  await fix.click();
  await expect(page.locator('#trgraph .tr-gtoast')).toContainText('in series with D1.A');
  const r = await exec(page, 'analyze', {});
  expect(r.issues.map((i) => i.code)).not.toContain('led_overcurrent');
  expect(r.level).not.toBe('danger');
  const s = await state(page);
  const res = s.parts.find((p) => p.type === 'resistor');
  expect(res.buy.mpn).toMatch(/^R-\d+-BASIC$/); // sourced automatically
  await expect(page.locator('[data-series]')).toHaveCount(0); // fix is gone
});

test('LED driven by a 3.3 V chip pin gets a value sized for 3.3 V, not 5 V', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  for (const [type, x, y] of [['usbc', 10, 20], ['ldo', 30, 20], ['mcu', 50, 20], ['led', 45, 40]]) await exec(page, 'place', { type, x, y });
  await exec(page, 'auto_wire', {});
  await exec(page, 'connect', { a: 'U2.PA5', b: 'D1.A' });
  await exec(page, 'connect', { a: 'D1.K', b: 'J1.GND' });
  await page.click('#trgfindbtn');
  await expect(page.locator('[data-series]')).toHaveText('Add 150R resistor'); // (3.3 V - 2.1 V) / 8 mA → 150R, the next E24 value up
  await page.locator('[data-series]').click();
  await expect(page.locator('#trgraph .tr-gtoast')).toContainText('in series with D1.A');
  expect((await exec(page, 'analyze', {})).issues.map((i) => i.code)).not.toContain('led_overcurrent');
});

test('while the parts panel is open the error list collapses to a pill that expands on hover', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'usbc', x: 10, y: 20 });
  await exec(page, 'place', { type: 'led', x: 40, y: 30 });
  await exec(page, 'connect', { a: 'J1.VBUS', b: 'D1.A' });
  await exec(page, 'connect', { a: 'D1.K', b: 'J1.GND' });
  await settle(page);
  const h0 = (await page.locator('.tr-gissues').boundingBox()).height;
  await page.click('#trgfindbtn');
  const h1 = (await page.locator('.tr-gissues').boundingBox()).height;
  expect(h1).toBeLessThan(60);
  expect(h1).toBeLessThan(h0);
  await page.locator('.tr-gissues').hover();
  await expect.poll(async () => (await page.locator('.tr-gissues').boundingBox()).height).toBeGreaterThan(100);
  await page.click('#trgfindbtn'); // closing the panel restores the docked list
  await expect.poll(async () => (await page.locator('.tr-gissues').boundingBox()).height).toBeGreaterThan(100);
});

test('Find for an existing part sets its real part; "Pick best for all" sources the rest', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20, value: '4k7' });
  await exec(page, 'place', { type: 'capacitor', x: 30, y: 20 });
  await exec(page, 'place', { type: 'led', x: 40, y: 20 });
  await exec(page, 'place', { type: 'ldo', x: 50, y: 20 });
  await exec(page, 'place', { type: 'hole', x: 5, y: 5 }).catch(() => {});
  await page.click('#trgfindbtn');
  await expect(page.locator('.tr-frow')).toHaveCount(4);
  await page.locator('[data-findfor="R1"]').click();
  await expect(page.locator('[data-use]').first()).toContainText('Use for R1');
  await page.locator('[data-use]').first().click();
  expect((await state(page)).parts.find((p) => p.ref === 'R1').buy.id).toBe('C23138');
  await expect(page.locator('.tr-frow')).toHaveCount(3);
  await page.click('#trfall');
  await expect(page.locator('.tr-fok')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#trgraph .tr-gtoast')).toContainText('Sourced 3 of 3');
  const b = await exec(page, 'bom', {});
  expect(b.unsourced).toEqual([]);
  expect(b.total).toBeGreaterThan(0.04);
});

test('BOM: quantity price breaks, unsourced warning, CSV export', async ({ page }) => {
  await mockCatalog(page);
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20, value: '330R' });
  await exec(page, 'place', { type: 'resistor', x: 30, y: 20, value: '330R' });
  await exec(page, 'place', { type: 'led', x: 40, y: 20 });
  await exec(page, 'source', { ref: 'R1', mpn: 'RX', id: 'C1', price: 0.01, tiers: '1-199:0.01,200-:0.005' });
  await exec(page, 'source', { ref: 'R2', mpn: 'RX', id: 'C1', price: 0.01, tiers: '1-199:0.01,200-:0.005' });
  await page.click('#trgbombtn');
  await expect(page.locator('.tr-brow')).toHaveCount(2); // R1+R2 grouped, LED separate
  await expect(page.locator('.tr-brow.miss')).toHaveCount(1);
  await expect(page.locator('[data-total]')).toHaveAttribute('data-total', '0.02');
  await expect(page.locator('.tr-fnote.small')).toContainText('1 part(s) not sourced');
  await page.fill('#trfb', '100'); await page.locator('#trfb').dispatchEvent('change'); // 200 pieces → the cheaper tier
  await expect(page.locator('[data-total]')).toHaveAttribute('data-total', '1');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#trfcsv')]);
  const text = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  expect(text).toMatch(/^Comment,Designator,Footprint,LCSC Part #,Quantity/);
  expect(text).toContain('"R1,R2"');
  expect(text).toContain('"C1"');
});

test('engine: source / bom / insert_series validate their input', async ({ page }) => {
  await gotoGraph(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 });
  expect(await tryExec(page, 'source', { ref: 'ZZ', mpn: 'x' })).toMatch(/no part/);
  expect(await tryExec(page, 'source', { ref: 'R1' })).toMatch(/mpn/);
  expect(await tryExec(page, 'source', { ref: 'R1', mpn: 'x', price: -1 })).toMatch(/price/);
  await exec(page, 'source', { ref: 'R1', mpn: 'x', price: 1 });
  expect((await exec(page, 'bom', {})).parts_sourced).toBe(1);
  await exec(page, 'source', { ref: 'R1', clear: 1 });
  expect((await state(page)).parts[0].buy).toBeUndefined();
  // insert_series needs a wired pin without copper
  expect(await tryExec(page, 'insert_series', { pad: 'R1.1' })).toMatch(/not wired/);
  await exec(page, 'place', { type: 'resistor', x: 40, y: 20 });
  await exec(page, 'route', { from: 'R1.2', to: 'R2.1' });
  await exec(page, 'connect', { a: 'R1.2', b: 'R2.1' });
  expect(await tryExec(page, 'insert_series', { pad: 'R1.2' })).toMatch(/copper/);
});

test('mounting holes are not part of the BOM', async ({ page }) => {
  await gotoGraph(page);
  await page.evaluate(() => TRACE.exec('load_sample', {}));
  const b = await exec(page, 'bom', {});
  expect(b.rows.map((r) => r.refs).join(',')).not.toMatch(/H\d/);
});

test('CLI: find_parts and add_part use the catalog, place the part and record where to buy it', async ({ page, request }) => {
  const mock = await startMock(), cat = await startCatalog();
  try {
    await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } }); // these tests drive Claude's edits: Auto mode
    await page.goto(PAGE + '?agents=' + mock.port + '#trace');
    await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
    await exec(page, 'clear', {});
    const run = (...args) => new Promise((res) => execFile('node', ['server/trace-cli.mjs', ...args],
      { cwd: ROOT, env: { ...process.env, TRACE_PORT: String(mock.port), TRACE_TOKEN: mock.token, TRACE_FINDER_BASE: cat.url } },
      (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout, err: stderr })));
    const f = await run('find_parts', 'q=330R 0603', 'limit=2');
    expect(f.code).toBe(0);
    const j = JSON.parse(f.out);
    expect(j.results.length).toBe(2);
    expect(j.results[0]).toMatchObject({ id: 'C23138', mpn: 'R-330-BASIC', jlcpcb_basic: true, adds_to_board_as: 'resistor' });
    expect(j.results[0].buy).toBe('https://www.lcsc.com/product-detail/C23138.html');
    const a = await run('add_part', 'q=3.3V LDO');
    expect(a.code).toBe(0);
    const added = JSON.parse(a.out);
    expect(added).toMatchObject({ as: 'AMS1117-3.3', ratings_set: { vout: 3.3, imax: 1 } });
    const s = await state(page);
    expect(s.parts.map((p) => p.type)).toEqual(['ldo']);
    expect(s.parts[0].buy.id).toBe('C347222');
    const bad = await run('add_part', 'q=zzzzqqq');
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/nothing found/);
    const none = await run('find_parts');
    expect(none.err).toMatch(/needs q=/);
  } finally { mock.stop(); cat.stop(); }
});
