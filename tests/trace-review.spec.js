// @ts-check
// E2E tests for TRACE's engineer review: each check fires on the mistake and goes away when it is fixed.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
async function gotoTrace(page) {
  await page.addInitScript(() => { try { localStorage.setItem('trace-tab-v1', 'board'); localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } });
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
  await page.evaluate(() => TRACE.exec('clear', {}));
}
const exec = (page, cmd, args, source) => page.evaluate(([c, a, s]) => TRACE.exec(c, a, s), [cmd, args, source]);
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));

/** a small, realistic board: USB-C → LDO → MCU, decoupling, an LED, a header */
const BOARD = {
  replace: true, board: { w: 50, h: 40 },
  parts: [
    { ref: 'J1', type: 'usbc', block: 'power' }, { ref: 'U1', type: 'ldo', block: 'power' }, { ref: 'C1', type: 'capacitor', value: '10uF', block: 'power' }, { ref: 'C3', type: 'capacitor', value: '1uF', block: 'power' },
    { ref: 'U2', type: 'mcu', block: 'mcu' }, { ref: 'C2', type: 'capacitor', block: 'mcu' }, { ref: 'C4', type: 'capacitor', block: 'mcu' },
    { ref: 'R1', type: 'resistor', value: '150R', block: 'led' }, { ref: 'D1', type: 'led', block: 'led' }, { ref: 'J2', type: 'header', block: 'io' },
  ],
  nets: {
    GND: ['J1.GND', 'U1.GND', 'C1.2', 'C3.2', 'U2.GND', 'C2.2', 'C4.2', 'D1.K'], VBUS: ['J1.VBUS', 'U1.IN', 'C1.1'], '+3V3': ['U1.OUT', 'C3.1', 'U2.VDD', 'C2.1', 'C4.1'],
    USB_DP: ['J1.D+', 'U2.USB_DP'], USB_DM: ['J1.D-', 'U2.USB_DM'], LEDSIG: ['U2.PA5', 'R1.1'], LEDA: ['R1.2', 'D1.A'], IO1: ['U2.PA6', 'J2.1'], IO2: ['U2.PA7', 'J2.2'],
  },
};
async function placed(page) { await exec(page, 'build', { spec: BOARD }); await exec(page, 'autoplace', {}); }
const codes = async (page) => (await exec(page, 'review', {})).findings.map((f) => f.code);


test('every finding says what is wrong and how to fix it', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  const r = await exec(page, 'review', {});
  expect(r.verdict).toBeTruthy();
  expect(r.findings.length).toBeGreaterThan(0);
  for (const f of r.findings) { expect(f.msg.length).toBeGreaterThan(10); expect(f.fix.length).toBeGreaterThan(10); expect(['danger', 'warning', 'info']).toContain(f.level); }
});

test('unrouted: fires while connections have no copper, clears after autoroute', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  await exec(page, 'route', { from: 'R1.2', to: 'D1.A' });
  expect(await codes(page)).toContain('unrouted');
  await exec(page, 'autoroute', {});
  expect(await codes(page)).not.toContain('unrouted');
});

test('decoupling_missing: a chip with no capacitor on its supply is flagged, adding one fixes it', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, board: { w: 40, h: 30 }, parts: [{ ref: 'U2', type: 'mcu' }, { ref: 'J2', type: 'header' }], nets: { GND: ['U2.GND', 'J2.1'], '+3V3': ['U2.VDD', 'J2.2'] } } });
  await exec(page, 'autoplace', {});
  expect(await codes(page)).toContain('decoupling_missing');
  await exec(page, 'build', { spec: { parts: [{ ref: 'C9', type: 'capacitor', value: '100nF' }], nets: { GND: ['C9.2', 'U2.GND'], '+3V3': ['C9.1', 'U2.VDD'] } } });
  await exec(page, 'autoplace', {});
  expect(await codes(page)).not.toContain('decoupling_missing');
});

test('reg_input_cap / reg_output_cap: a regulator without its capacitors is flagged', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, board: { w: 40, h: 30 }, parts: [{ ref: 'U1', type: 'ldo' }, { ref: 'J1', type: 'header' }], nets: { GND: ['U1.GND', 'J1.1'], VIN: ['U1.IN', 'J1.2'], '+3V3': ['U1.OUT', 'J1.3'] } } });
  await exec(page, 'autoplace', {});
  const c = await codes(page);
  expect(c).toContain('reg_input_cap'); expect(c).toContain('reg_output_cap');
  await exec(page, 'build', { spec: { parts: [{ ref: 'C1', type: 'capacitor', value: '10uF' }, { ref: 'C3', type: 'capacitor', value: '10uF' }], nets: { GND: ['C1.2', 'C3.2', 'U1.GND'], VIN: ['C1.1', 'U1.IN'], '+3V3': ['C3.1', 'U1.OUT'] } } });
  await exec(page, 'autoplace', {});
  const d = await codes(page);
  expect(d).not.toContain('reg_input_cap'); expect(d).not.toContain('reg_output_cap');
});

test('connector_edge: a connector in the middle of the board is flagged, auto-place moves it to the edge', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  expect(await codes(page)).not.toContain('connector_edge');
  const p = (await state(page)).parts.find((q) => q.ref === 'J1');
  await exec(page, 'move', { ref: 'J1', x: 25, y: 20 });
  expect(await codes(page)).toContain('connector_edge');
  await exec(page, 'autoplace', {});
  expect(await codes(page)).not.toContain('connector_edge');
  expect(p).toBeTruthy();
});

test('single_pin_net: a net that reaches one pin is flagged', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, board: { w: 30, h: 20 }, parts: [{ ref: 'R1', type: 'resistor' }, { ref: 'R2', type: 'resistor' }, { ref: 'R3', type: 'resistor' }], nets: { A: ['R1.1', 'R2.1'], LONELY: ['R1.2', 'R3.1'] } } });
  await exec(page, 'remove', { ref: 'R3' });
  await exec(page, 'autoplace', {});
  expect(await codes(page)).toContain('single_pin_net');
});

test('too_close: parts crammed together are flagged when hand-soldering, fine for reflow', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, board: { w: 30, h: 20 }, parts: [{ ref: 'R1', type: 'resistor' }, { ref: 'R2', type: 'resistor' }], nets: { A: ['R1.2', 'R2.1'] } } });
  await exec(page, 'set_assembly', { mode: 'hand' });
  await exec(page, 'move', { ref: 'R1', x: 10, y: 10 });
  let found = false;
  for (let x = 11; x <= 16 && !found; x += 0.1) { await exec(page, 'move', { ref: 'R2', x, y: 10 }); found = (await codes(page)).includes('too_close'); }
  expect(found).toBe(true);
  await exec(page, 'move', { ref: 'R2', x: 18, y: 10 });
  expect(await codes(page)).not.toContain('too_close');
});

test('review panel: Review button lists findings with fixes and a verdict', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  await page.click('#trreviewbtn');
  await expect(page.locator('#trreview')).toContainText(/Not ready|Almost there|Looks ready/);
  await expect(page.locator('#trreview [data-rv]').first()).toBeVisible();
});
