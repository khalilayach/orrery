// @ts-check
// E2E tests for the TRACE cart: the button with the live total, the cart view (quantities, price breaks,
// stock), the single-vendor check, and the export / buy actions.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mockCatalog } from './helpers/catalog.js';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
async function gotoTrace(page) {
  await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); if (!sessionStorage.getItem('seeded')) { localStorage.removeItem('trace-boards-v1'); sessionStorage.setItem('seeded', '1'); } localStorage.setItem('trace-tab-v1', 'graph'); } catch (_) { /* ignore */ } });
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
  await page.evaluate(() => TRACE.exec('clear', {}));
}
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);

/** two resistors, an LED and a regulator, fully sourced from "LCSC" (one has a quantity price break) */
async function sourcedBoard(page, opts = {}) {
  await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'R1', type: 'resistor', value: '330R' }, { ref: 'R2', type: 'resistor', value: '330R' }, { ref: 'D1', type: 'led' }, { ref: 'U1', type: 'ldo' }] } });
  await exec(page, 'source', { ref: 'R1', mpn: 'R-330', id: 'C23138', pkg: '0603', price: 0.01, stock: opts.lowStock ? 5 : 100000, basic: 1, tiers: '1-199:0.01,200-:0.005' });
  await exec(page, 'source', { ref: 'R2', mpn: 'R-330', id: 'C23138', pkg: '0603', price: 0.01, stock: opts.lowStock ? 5 : 100000, basic: 1, tiers: '1-199:0.01,200-:0.005' });
  await exec(page, 'source', { ref: 'D1', mpn: 'LED-G', id: 'C2899882', pkg: '0603', price: 0.05, stock: 20000 });
  await exec(page, 'source', opts.otherVendor ? { ref: 'U1', mpn: 'REG-X', pkg: 'SOT-223', price: 0.2, stock: 900 } : { ref: 'U1', mpn: 'AMS1117-3.3', id: 'C347222', pkg: 'SOT-223', price: 0.04, stock: 2000000 });
  await settle(page);
}

test('the cart button sits top right and always shows the live total', async ({ page }) => {
  await gotoTrace(page);
  await expect(page.locator('#trcart')).toBeVisible();
  await expect(page.locator('#trcart')).toContainText('Cart'); // empty
  await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'R1', type: 'resistor' }, { ref: 'D1', type: 'led' }] } });
  await settle(page);
  await expect(page.locator('#trcart .cnt')).toHaveText('!');           // two parts, none sourced yet
  await expect(page.locator('#trcart .cnt')).toHaveClass(/warn/);
  await exec(page, 'source', { ref: 'R1', mpn: 'R-330', id: 'C1', price: 0.01 });
  await exec(page, 'source', { ref: 'D1', mpn: 'LED-G', id: 'C2', price: 0.05 });
  await settle(page);
  await expect(page.locator('#trcart .tot')).toHaveText('$0.06');
  await expect(page.locator('#trcart .cnt')).toHaveText('2');
  await expect(page.locator('#trcart .cnt')).not.toHaveClass(/warn/);
  // the total follows edits
  await exec(page, 'source', { ref: 'D1', mpn: 'LED-G', id: 'C2', price: 0.15 });
  await settle(page);
  await expect(page.locator('#trcart .tot')).toHaveText('$0.16');
});

test('the cart lists every part with quantity, price at your order size, stock and a buy link; one vendor is confirmed', async ({ page }) => {
  await gotoTrace(page);
  await sourcedBoard(page);
  await page.click('#trcart');
  const box = page.locator('.tr-cartbox');
  await expect(box).toBeVisible();
  await expect(box.locator('tbody tr')).toHaveCount(3); // R1+R2 are one line (same part), LED, regulator
  const r = box.locator('tbody tr', { hasText: 'R-330' });
  await expect(r).toContainText('R1, R2'.replace(', ', ','));
  await expect(r.locator('td.n').first()).toHaveText('2');
  await expect(r.locator('a')).toHaveAttribute('href', 'https://www.lcsc.com/product-detail/C23138.html');
  await expect(box.locator('[data-carttotal]')).toHaveAttribute('data-carttotal', '0.11'); // 2×0.01 + 0.05 + 0.04
  await expect(box.locator('.vend.ok')).toContainText('One vendor: LCSC');
  await expect(box.locator('.vend.ok')).toContainText('All 4 parts');
  await expect(box.locator('.miss')).toHaveCount(0);
  await expect(box).toContainText('Shipping, duties and tax are added at checkout');
});

test('order size: more boards use the quantity price break, are remembered, and low stock is flagged', async ({ page }) => {
  await gotoTrace(page);
  await sourcedBoard(page);
  await page.click('#trcart');
  await page.fill('#trcartn', '100'); await page.locator('#trcartn').dispatchEvent('change');
  // R: 200 pieces → 0.005 each = 1.00 ; LED 100×0.05 = 5 ; reg 100×0.04 = 4
  await expect(page.locator('[data-carttotal]')).toHaveAttribute('data-carttotal', '10');
  await expect(page.locator('#trcart .tot')).toHaveText('$10.00');
  await page.keyboard.press('Escape');
  await expect(page.locator('.tr-cartbox')).toBeHidden();
  await page.reload();
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await page.click('#trcart');
  await expect(page.locator('#trcartn')).toHaveValue('100'); // remembered
  // not enough in stock for what you need
  await sourcedBoard(page, { lowStock: true });
  await page.keyboard.press('Escape');
  await page.click('#trcart');
  await expect(page.locator('.tr-cartbox tr.low')).toHaveCount(1);
  await expect(page.locator('.tr-cartbox tr.low .bad')).toContainText('only 5');
});

test('single-vendor check: a part that is not on LCSC is called out, and so is a part with no real part yet', async ({ page }) => {
  await gotoTrace(page);
  await sourcedBoard(page, { otherVendor: true });
  await page.click('#trcart');
  await expect(page.locator('.vend.warn')).toContainText('Not everything is on LCSC');
  await expect(page.locator('.vend.warn')).toContainText('U1 (REG-X)');
  await expect(page.locator('.vend.warn')).toContainText('second shipment');
  await page.click('[data-cartclose]');
  await exec(page, 'place', { type: 'capacitor', auto: 1 });
  await settle(page);
  await page.click('#trcart');
  await expect(page.locator('.vend.warn')).toContainText('still without a real part');
  await expect(page.locator('.miss .mrow')).toHaveCount(1);
});

test('unsourced parts: Find opens the finder for exactly that part; Pick best for all sources the rest', async ({ page }) => {
  await mockCatalog(page);
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'R1', type: 'resistor', value: '4k7' }, { ref: 'C1', type: 'capacitor', value: '100nF' }] } });
  await settle(page);
  await page.click('#trcart');
  await expect(page.locator('.miss .mrow')).toHaveCount(2);
  await page.locator('[data-cartfind="R1"]').click();
  await expect(page.locator('.tr-cartbox')).toBeHidden();
  await expect(page.locator('#trgraph')).toBeVisible();
  await expect(page.locator('#trfq')).toHaveValue('4k7');
  await expect(page.locator('.tr-fc').first()).toContainText('R-4700', { timeout: 8000 });
  await expect(page.locator('[data-use]').first()).toContainText('Use for R1');
  await page.click('#trcart');
  await page.click('[data-cartall]');
  await expect(page.locator('.tr-cartbox')).toBeHidden();
  await expect(page.locator('#trcart .cnt')).not.toHaveClass(/warn/, { timeout: 10000 });
  await page.click('#trcart');
  await expect(page.locator('.vend.ok')).toContainText('One vendor: LCSC');
  await expect(page.locator('.tr-cartbox tbody tr')).toHaveCount(2);
});

test('exports: CSV with LCSC part numbers and quantities, a copy-able list, and Open all on LCSC', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoTrace(page);
  await sourcedBoard(page);
  await page.click('#trcart');
  await page.fill('#trcartn', '10'); await page.locator('#trcartn').dispatchEvent('change');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-cartcsv]')]);
  const text = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  expect(text).toMatch(/^LCSC Part Number,Quantity,Comment,Designator,Footprint/);
  expect(text).toContain('"C23138",20,"R-330","R1,R2"'); // 2 per board × 10 boards
  expect(text).toContain('"C2899882",10');
  await page.click('[data-cartcopy]');
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe('C23138\t20\nC2899882\t10\nC347222\t10');
  const opened = [];
  context.on('page', (p) => opened.push(p));
  await page.click('[data-cartopen]');
  await expect.poll(() => opened.length).toBe(3);
  expect(opened.map((p) => p.url()).sort().join(' ')).toMatch(/C23138.*C2899882.*C347222|C2899882.*C23138/);
});

test('empty cart explains itself; the exports are disabled; × and clicking outside close it', async ({ page }) => {
  await gotoTrace(page);
  await page.click('#trcart');
  await expect(page.locator('.tr-cartbox .empty')).toContainText('Nothing to buy yet');
  await expect(page.locator('[data-cartcsv]')).toBeDisabled();
  await expect(page.locator('[data-cartopen]')).toBeDisabled();
  await page.click('[data-cartclose]');
  await expect(page.locator('.tr-cartbox')).toBeHidden();
  await page.click('#trcart');
  await page.locator('#trcartmodal').click({ position: { x: 8, y: 8 } }); // on the dimmed backdrop
  await expect(page.locator('.tr-cartbox')).toBeHidden();
});

test('engine: bom reports unit price at the order size and totals only what is sourced', async ({ page }) => {
  await gotoTrace(page);
  await sourcedBoard(page);
  const b1 = await exec(page, 'bom', { boards: 1 }), b100 = await exec(page, 'bom', { boards: 100 });
  expect(b1.total).toBe(0.11);
  expect(b100.total).toBe(10);
  expect(b100.rows.find((r) => r.mpn === 'R-330').unit_price).toBe(0.005);
  await exec(page, 'place', { type: 'capacitor', auto: 1 });
  const b = await exec(page, 'bom', {});
  expect(b.unsourced).toEqual(['C1']);
  expect(b.note).toMatch(/total is incomplete/);
});
