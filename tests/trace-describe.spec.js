// @ts-check
// E2E tests for TRACE part / pin / net descriptions: plain-English "what it is" (per part
// type), "what it does here" (per part on the board, editable, settable by Claude),
// pin descriptions, net notes, and the hover tooltip.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startMock } from './helpers/mock-server.js';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
let mock;
test.beforeAll(async () => { mock = await startMock(); });
test.afterAll(() => mock && mock.stop());

async function gotoTrace(page) {
  await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } }); // the bridge test is Claude editing: Auto mode
  await page.addInitScript(() => { try { localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } }); // these specs test the PCB tab
  await page.goto(PAGE + '?agents=' + mock.port + '#trace');
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
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));

test('the sample board explains every part in plain English', async ({ page }) => {
  await gotoTrace(page);
  const b = await exec(page, 'board', {});
  for (const p of b.parts) {
    expect(p.what_it_is, p.ref + ' has no type description').not.toBe('');
    expect(p.what_it_does_here, p.ref + ' has no note').not.toBe('');
  }
  expect(b.parts.find((p) => p.ref === 'R1').what_it_does_here).toContain('LED');
  expect(b.parts.find((p) => p.ref === 'U2').what_it_is).toContain('3.3 V');
  expect(b.nets.find((n) => n.name === 'VBUS').note).toContain('5 V');
  expect(b.nets.every((n) => n.note)).toBe(true);
  expect(b.parts.find((p) => p.ref === 'U1').pads.find((q) => q.fn === 'PA5').desc).toContain('LED');
});

test('selecting a part shows WHAT IT IS, WHAT IT DOES HERE and a description for every pin', async ({ page }) => {
  await gotoTrace(page);
  const p = await px(page, 16, 30); // U2, the regulator
  await page.mouse.click(p.x, p.y);
  const insp = page.locator('#trinsp');
  await expect(insp).toContainText('WHAT IT IS');
  await expect(insp).toContainText('voltage regulator');
  await expect(insp).toContainText('WHAT IT DOES HERE');
  await expect(page.locator('#insnote')).toHaveValue(/5 V from USB/);
  await expect(insp).toContainText('PINS');
  await expect(insp).toContainText('Output — steady 3.3 V');
  await expect(insp).toContainText('Input — 5 V in');
});

test('editing "what it does here" saves to the part, is undoable, and survives a reload', async ({ page }) => {
  await gotoTrace(page);
  const p = await px(page, 30, 32); // R1
  await page.mouse.click(p.x, p.y);
  await page.fill('#insnote', 'Holds the LED current to about 5 mA.');
  await page.press('#insnote', 'Tab');
  let r1 = (await state(page)).parts.find((q) => q.ref === 'R1');
  expect(r1.note).toBe('Holds the LED current to about 5 mA.');
  await page.click('#trundo');
  r1 = (await state(page)).parts.find((q) => q.ref === 'R1');
  expect(r1.note).toContain('Current limiter');
  await page.click('#trredo');
  await page.waitForTimeout(400); // debounced save
  await page.reload();
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  expect((await state(page)).parts.find((q) => q.ref === 'R1').note).toBe('Holds the LED current to about 5 mA.');
  // clearing the box removes the note
  await exec(page, 'describe', { ref: 'R1', text: '' });
  expect((await state(page)).parts.find((q) => q.ref === 'R1').note).toBeUndefined();
});

test('hovering a part shows a tooltip with its job; hovering a pad adds the pin meaning and net', async ({ page }) => {
  await gotoTrace(page);
  const tip = page.locator('#trtip');
  await expect(tip).toBeHidden();
  const body = await px(page, 30, 20); // middle of U1
  await page.mouse.move(body.x - 3, body.y - 3);
  await page.mouse.move(body.x, body.y, { steps: 3 });
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('U1');
  await expect(tip).toContainText('main chip');
  const pad = await px(page, 27.6, 24.4); // U1 pin 5 = PA5
  await page.mouse.move(pad.x, pad.y, { steps: 4 });
  await expect(tip).toContainText('pin 5 (PA5)');
  await expect(tip).toContainText('LED_PA5');
  await expect(tip).toContainText('drives the status LED');
  await page.mouse.move(pad.x, pad.y + 300); // off the board
  await expect(tip).toBeHidden();
});

test('net notes: clicking a net highlights it, shows its meaning in the list and the dock', async ({ page }) => {
  await gotoTrace(page);
  await page.click('[data-ltab="objects"]'); // nets live under the Objects tab
  await page.click('[data-net="VBUS"]');
  await expect(page.locator('#trnets .tr-netnote')).toContainText('5 V from the USB cable');
  await expect(page.locator('#trlog')).toContainText('VBUS — 5 V from the USB cable');
  await expect(page.locator('[data-net="VBUS"]')).toHaveAttribute('title', /5 V from the USB cable/);
});

test('engine: describe works on parts and nets, rejects unknown targets, clears with the board', async ({ page }) => {
  await gotoTrace(page);
  expect(await tryExec(page, 'describe', { ref: 'ZZ9', text: 'x' })).toContain('no part');
  expect(await tryExec(page, 'describe', { net: 'NOPE', text: 'x' })).toContain('no net');
  expect(await tryExec(page, 'describe', { text: 'x' })).toContain('missing ref=');
  const r = await exec(page, 'describe', { net: 'GND', text: 'The 0 V reference.' });
  expect(r.note).toBe('The 0 V reference.');
  expect((await exec(page, 'board', {})).nets.find((n) => n.name === 'GND').note).toBe('The 0 V reference.');
  await exec(page, 'clear', {});
  expect((await state(page)).netNotes).toEqual({});
});

test('custom parts carry a description (form field) that shows up on the placed part', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await page.click('#trnewpart');
  await page.fill('#trpl', 'Flash chip');
  await page.fill('#trpdesc', 'Stores the firmware so it survives power off.');
  await page.selectOption('#trpt', 'dual');
  await page.click('#trpcreate');
  await expect(page.locator('#trpmsg')).toContainText('pads');
  await page.keyboard.press('Escape');
  await page.click('[data-part="flash_chip"]');
  await expect(page.locator('#trparts .tr-netnote')).toContainText('Stores the firmware'); // shown while placing
  await expect(page.locator('#trhint')).toContainText('Stores the firmware');
  const p = await px(page, 30, 20);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('#trinsp')).toContainText('Stores the firmware so it survives power off.');
});

test('imported KiCad footprints bring their own description', async ({ page, request }) => {
  const hits = await (await request.get(mock.api + '/parts/search?q=soic')).json();
  const imp = await (await request.get(mock.api + '/parts/import?path=' + encodeURIComponent(hits[0].path))).json();
  expect(imp.def.desc).toContain('SOIC, 8 Pin');
  expect(imp.def.desc).toContain('tags: SOIC SO');
});

test('Claude can annotate the board: describe over the bridge updates the inspector and counts as an edit', async ({ page, request }) => {
  await gotoTrace(page);
  await expect.poll(async () => (await (await request.get(mock.api + '/trace/status')).json()).open).toBe(true);
  const p = await px(page, 37, 32); // D1
  await page.mouse.click(p.x, p.y);
  await page.evaluate(() => trSetAI('working'));
  const res = await request.post(mock.api + '/trace/cmd', { data: { token: mock.token, cmd: 'describe', args: ['ref=D1', 'text=Lights up when the chip sets PA5 high.'] } });
  expect((await res.json()).ok).toBe(true);
  await expect(page.locator('#insnote')).toHaveValue('Lights up when the chip sets PA5 high.');
  await expect(page.locator('#trai')).toContainText('1 edit');
});

test('regression: layer colour swatches stay small squares (row styles must not stretch them)', async ({ page }) => {
  await gotoTrace(page);
  const w = await page.evaluate(() => document.querySelector('#trlayers .sw').getBoundingClientRect().width);
  expect(w).toBeLessThan(16);
});
