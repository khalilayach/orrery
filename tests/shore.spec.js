// @ts-check
// E2E for the night-shore foreground (shore.js): the sea and sand must carry fine, varied texture
// (matching the void's grain) rather than flat bands. Colours are sampled from the canvas, not pixel-exact.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;

/** Distinct opaque colours + opaque coverage inside a horizontal band of the shore canvas (fractions of its height). */
const sample = (page, y0, y1) => page.evaluate(([a, b]) => {
  const cv = /** @type {HTMLCanvasElement} */ (document.getElementById('shore'));
  const c = cv.getContext('2d'), h = cv.height, w = cv.width;
  const d = c.getImageData(0, Math.floor(h * a), w, Math.floor(h * (b - a))).data;
  const set = new Set(); let opaque = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) { opaque++; set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
  return { colors: set.size, cover: opaque / (d.length / 4) };
}, [y0, y1]);

test('shore: sea and sand are fully painted and richly textured', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(PAGE);
  await expect.poll(() => page.evaluate(() => typeof Shore !== 'undefined' && Shore.ready)).toBe(true);
  await expect.poll(async () => (await sample(page, 0.95, 1)).cover, { timeout: 20000 }).toBeGreaterThan(0.95);   // intro finishes, shore paints
  const sea = await sample(page, 0.875, 0.925), sand = await sample(page, 0.975, 1);
  expect(sea.cover).toBeGreaterThan(0.95);
  expect(sand.cover).toBeGreaterThan(0.95);
  expect(sea.colors).toBeGreaterThanOrEqual(6);
  expect(sand.colors).toBeGreaterThanOrEqual(6);   // sand has real grain, not 2-3 flat tones
  expect(errors).toEqual([]);
});

test('shore: ?frame=photo hides the shore canvas (both paths)', async ({ page }) => {
  await page.goto(PAGE + '?frame=photo');
  await expect(page.locator('#shore')).toBeHidden();
});

test('shore: canvas re-bakes to the new size after a resize settles (debounced)', async ({ page }) => {
  await page.goto(PAGE);
  await expect.poll(() => page.evaluate(() => typeof Shore !== 'undefined' && Shore.ready)).toBe(true);
  const w0 = await page.evaluate(() => /** @type {HTMLCanvasElement} */ (document.getElementById('shore')).width);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(() => page.evaluate(() => /** @type {HTMLCanvasElement} */ (document.getElementById('shore')).width)).toBe(450);
  expect(w0).toBe(640);
});

test('main menu: no ORRERY title is drawn and dragging does not pan the map', async ({ page }) => {
  await page.goto(PAGE);
  await expect.poll(() => page.evaluate(() => boot.done), { timeout: 20000 }).toBe(true);
  await expect(page.locator('#recenter')).toHaveCount(0);
  // the title band at the top of the stage stays empty of bright title pixels
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({ x: pan.x, y: pan.y }));
  await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(300, 450, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ x: pan.x, y: pan.y, cursor: document.getElementById('overlay').style.cursor }));
  expect(after.x).toBe(before.x); expect(after.y).toBe(before.y);
  expect(after.cursor).not.toBe('grab');
  const bright = await page.evaluate(() => { const c = document.getElementById('overlay'), d = c.getContext('2d').getImageData(c.width * .35, 20, c.width * .3, 130).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 200) n++; return n; });
  expect(bright).toBe(0);
});

test('main menu: stars and constellations sit in the dark upper sky, above the horizon glow', async ({ page }) => {
  await page.goto(PAGE);
  await expect.poll(() => page.evaluate(() => boot.done), { timeout: 20000 }).toBe(true);
  const r = await page.evaluate(() => ({
    conY: MANIFEST.projects.map((p) => worldScreen(p)[1] / H),
    starMax: Math.max(...stars.map((s) => s.y)),
  }));
  for (const y of r.conY) expect(y).toBeLessThan(0.58);   // node origins; the shapes extend a little below
  expect(r.starMax).toBeLessThan(0.65);
});
