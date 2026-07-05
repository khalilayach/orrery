// @ts-check
// E2E tests for the ORCH1 agent workspace (index.html).
// Covers: dive routing, opacity/selection guarantees, spawn, fold-to-chip,
// canvas panning, ESC close, and the EVE-NG detail-panel regression.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;

/** Collect console + page errors for the lifetime of the page. */
function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Open the page straight into the workspace via the #orch1 hash. */
async function gotoWorkspace(page) {
  await page.goto(PAGE + '#orch1');
  await expect(page.locator('#ws')).toHaveClass(/on/, { timeout: 5000 });
}

test('boots without console or page errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(PAGE);
  await page.click('#skip');
  await page.waitForTimeout(800);
  expect(errors).toEqual([]);
});

test('#orch1 hash opens the workspace: opaque blue, no text selection', async ({ page }) => {
  await gotoWorkspace(page);
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('ws'));
    return { bg: cs.backgroundColor, sel: cs.userSelect };
  });
  expect(s.bg).toBe('rgb(29, 31, 230)');   // #1d1fe6, fully opaque — void can't show through
  expect(s.sel).toBe('none');              // highlight bug fix
  // fade-in transition (.45s) settles at fully opaque
  await expect.poll(async () =>
    page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('ws')).opacity))
  ).toBe(1);
  // seeds exactly one agent window, spawn node stays visible (no overlap)
  await expect(page.locator('.ws-win')).toHaveCount(1);
  const clear = await page.evaluate(() => {
    const s = document.getElementById('wsspawn').getBoundingClientRect();
    const w = document.querySelector('.ws-win').getBoundingClientRect();
    return !(s.left < w.right && s.right > w.left && s.top < w.bottom && s.bottom > w.top);
  });
  expect(clear).toBe(true);
});

test('diving into ORCH1 opens the workspace, not the detail panel', async ({ page }) => {
  await page.goto(PAGE);
  await page.click('#skip');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    // @ts-ignore page globals
    startDive(MANIFEST.projects.find((p) => p.id === 'orch1'), innerWidth * 0.6, innerHeight * 0.55);
  });
  await expect(page.locator('#ws')).toHaveClass(/on/, { timeout: 5000 });
  const detail = await page.evaluate(() => detailOpen);
  expect(detail).toBe(false);
});

test('spawn node summons additional agents', async ({ page }) => {
  await gotoWorkspace(page);
  await page.click('#wsspawn');
  await page.click('#wsspawn');
  await expect(page.locator('.ws-win')).toHaveCount(3);
});

test('lower folds a window into a chip; clicking the chip raises it', async ({ page }) => {
  await gotoWorkspace(page);
  await page.click('.ws-win .ws-lower');
  await expect(page.locator('.ws-win.lowered')).toHaveCount(1);
  // body collapses to zero height once the fold transition lands
  await expect.poll(async () =>
    page.evaluate(() => document.querySelector('.ws-win.lowered .ws-body').getBoundingClientRect().height)
  ).toBeLessThan(1);
  // click (no drag) on the chip bar raises it
  await page.click('.ws-win.lowered .ws-bar');
  await expect(page.locator('.ws-win.lowered')).toHaveCount(0);
});

test('lowering a second time still fully collapses the body (regression)', async ({ page }) => {
  // Prior bug: raising a lowered window set an inline body height that
  // outranked the .lowered CSS rule, so the second lower left the body
  // stuck at its raised height instead of collapsing to 0.
  await gotoWorkspace(page);
  await page.click('.ws-win .ws-lower');
  await page.click('.ws-win.lowered .ws-bar'); // raise
  await expect(page.locator('.ws-win.lowered')).toHaveCount(0);
  await page.click('.ws-win .ws-lower'); // lower again
  await expect(page.locator('.ws-win.lowered')).toHaveCount(1);
  await expect.poll(async () =>
    page.evaluate(() => document.querySelector('.ws-win.lowered .ws-body').getBoundingClientRect().height)
  ).toBeLessThan(1);
});

test('dragging the canvas background pans windows with the world', async ({ page }) => {
  await gotoWorkspace(page);
  const before = await page.evaluate(() => parseFloat(document.querySelector('.ws-win').style.left));
  const box = await page.locator('#ws').boundingBox();
  // background spot: bottom-LEFT (bottom-right is the summon-agent button now)
  const sx = box.x + 60, sy = box.y + box.height - 60;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx - 150, sy - 50, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => parseFloat(document.querySelector('.ws-win').style.left));
  expect(after - before).toBeLessThan(-100); // window traveled left with the pan
});

test('ESC closes the workspace and restores the map UI', async ({ page }) => {
  await gotoWorkspace(page);
  await page.keyboard.press('Escape');
  await expect.poll(async () => page.evaluate(() => wsOpen)).toBe(false);
  await expect.poll(async () =>
    page.evaluate(() => document.getElementById('ui').style.visibility)
  ).not.toBe('hidden');
});

test('regression: EVE-NG still opens the detail panel', async ({ page }) => {
  await page.goto(PAGE + '#eve-ng');
  await expect(page.locator('#detail')).toHaveClass(/on/, { timeout: 5000 });
  await expect(page.locator('#d-title')).toHaveText('EVE-NG Enterprise Fabric');
  const ws = await page.evaluate(() => wsOpen);
  expect(ws).toBe(false);
});
