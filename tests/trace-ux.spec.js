// @ts-check
// E2E tests for TRACE usability fixes: rulers can be selected and deleted, in-progress
// rulers/routes cancel with right-click, and the board autosave is flushed on close.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40)))));
async function gotoTrace(page) {
  await page.addInitScript(() => { try { localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } }); // these specs test the PCB tab
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
}
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const rulers = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()).measures.length);
async function px(page, x, y) {
  return page.evaluate(([x, y]) => {
    const svg = document.getElementById('trsvg'), r = svg.getBoundingClientRect();
    const [vx, vy, vw] = svg.getAttribute('viewBox').split(' ').map(Number), k = r.width / vw;
    return { x: r.left + (x - vx) * k, y: r.top + (y - vy) * k };
  }, [x, y]);
}

test('ruler: click selects it, Delete removes it (and the inspector button does too)', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'measure', { from: '10:10', to: '30:10' });
  await exec(page, 'measure', { from: '10:20', to: '30:30' });
  await settle(page);
  expect(await rulers(page)).toBe(2);
  const p = await px(page, 20, 10);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('[data-meas][data-selected="1"]')).toHaveCount(1);
  await expect(page.locator('#insdel')).toHaveText('Delete ruler');
  await page.keyboard.press('Delete');
  expect(await rulers(page)).toBe(1);
  await settle(page);
  const q = await px(page, 20, 25);
  await page.mouse.click(q.x, q.y);
  await page.click('#insdel');
  expect(await rulers(page)).toBe(0);
});

test('ruler: Delete with the Measure tool and nothing selected removes the last ruler; Select tool leaves them', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'measure', { from: '10:10', to: '30:10' });
  await exec(page, 'measure', { from: '10:20', to: '30:20' });
  await page.keyboard.press('Delete');
  expect(await rulers(page)).toBe(2); // select tool: no accidental deletes
  await page.keyboard.press('m');
  await page.keyboard.press('Delete');
  expect(await rulers(page)).toBe(1);
  await page.keyboard.press('Delete');
  expect(await rulers(page)).toBe(0);
  await page.keyboard.press('Delete'); // nothing left: harmless
  expect(await rulers(page)).toBe(0);
});

test('ruler: right-click cancels a half-drawn ruler; undo removes a finished one', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await page.keyboard.press('m');
  const a = await px(page, 20, 15), b = await px(page, 40, 15);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator('#trhint')).toContainText('second point');
  await page.mouse.click(b.x, b.y, { button: 'right' });
  await expect(page.locator('#trhint')).toContainText('click two points');
  expect(await rulers(page)).toBe(0);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  expect(await rulers(page)).toBe(1);
  await page.keyboard.press('Control+z');
  expect(await rulers(page)).toBe(0);
});

test('autosave: an edit made right before the page is closed is not lost', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 });
  await page.reload(); // well inside the 200 ms autosave debounce
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  const refs = await page.evaluate(() => JSON.parse(TRACE.serialize()).parts.map((p) => p.ref));
  expect(refs).toEqual(['R1']);
});
