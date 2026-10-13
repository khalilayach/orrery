// @ts-check
// E2E tests for TRACE's electrical safety analyser (trace/electrical.js): shorts,
// over-voltage, over-current, part ratings, trace heating — each danger case has a
// matching "safe" case — plus the live panel, set_electrical and the analyze command.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;

async function gotoTrace(page) {
  await page.goto(PAGE + '?agents=57312#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const tryExec = (page, cmd, args) => page.evaluate(([c, a]) => { try { TRACE.exec(c, a); return null; } catch (e) { return e.message; } }, [cmd, args]);
const analyze = (page) => exec(page, 'analyze', {});
const codes = (r) => r.issues.map((i) => i.code);

/** return path to GND routed round the outside so copper never crosses the parts */
const RET = '50:46/2:46/2:20.8';
async function usb(page) { await exec(page, 'clear', {}); await exec(page, 'place', { type: 'usbc', x: 10, y: 20 }); }
async function ledCircuit(page, r) {
  await usb(page);
  await exec(page, 'place', { type: 'led', x: 45, y: 40 });
  if (r) {
    await exec(page, 'place', { type: 'resistor', x: 30, y: 40, value: r });
    await exec(page, 'route', { from: 'J1.VBUS', to: 'R1.1' });
    await exec(page, 'route', { from: 'R1.2', to: 'D1.A' });
  } else await exec(page, 'route', { from: 'J1.VBUS', to: 'D1.A' });
  await exec(page, 'route', { from: 'D1.K', to: 'J1.GND', points: RET });
}

test('the sample board is electrically safe', async ({ page }) => {
  await gotoTrace(page);
  const r = await analyze(page);
  expect(r.level).toBe('safe');
  expect(r.issues.filter((i) => i.level !== 'info')).toEqual([]);
  await expect(page.locator('#trsafe .tr-safe')).toHaveAttribute('data-level', 'safe');
});

test('LED: a proper series resistor is safe, none or too small is danger', async ({ page }) => {
  await gotoTrace(page);
  await ledCircuit(page, '330R');
  expect((await analyze(page)).level).toBe('safe');
  await exec(page, 'set_value', { ref: 'R1', value: '10R' });
  let r = await analyze(page);
  expect(r.level).toBe('danger');
  expect(codes(r)).toContain('led_overcurrent');
  await ledCircuit(page, null); // no resistor at all
  r = await analyze(page);
  expect(codes(r)).toEqual(expect.arrayContaining(['led_overcurrent', 'supply_overload']));
});

test('dead short across the supply is flagged with trace overheating', async ({ page }) => {
  await gotoTrace(page);
  await usb(page);
  await exec(page, 'place', { type: 'resistor', x: 30, y: 40, value: '0R1' });
  await exec(page, 'route', { from: 'J1.VBUS', to: 'R1.1' });
  await exec(page, 'route', { from: 'R1.2', to: 'J1.GND', points: RET });
  const r = await analyze(page);
  expect(r.level).toBe('danger');
  expect(codes(r)).toEqual(expect.arrayContaining(['resistor_overpower', 'supply_overload', 'trace_overheat']));
  await exec(page, 'set_value', { ref: 'R1', value: '1k' }); // same copper, sane load → safe again
  expect((await analyze(page)).level).toBe('safe');
});

test('engine refuses to merge VBUS and GND by accident', async ({ page }) => {
  await gotoTrace(page);
  await usb(page);
  await exec(page, 'place', { type: 'resistor', x: 30, y: 40 });
  await exec(page, 'route', { from: 'J1.VBUS', to: 'R1.1' });
  await exec(page, 'route', { from: 'R1.2', to: 'J1.GND', points: RET });
  expect(await tryExec(page, 'route', { from: 'J1.VBUS', to: 'J1.GND' })).toMatch(/short/i);
});

test('5 V on a 3.3 V chip is over-voltage', async ({ page }) => {
  await gotoTrace(page);
  await usb(page);
  await exec(page, 'place', { type: 'mcu', x: 40, y: 20 });
  await exec(page, 'route', { from: 'J1.VBUS', to: 'U1.VDD' });
  await exec(page, 'route', { from: 'J1.GND', to: 'U1.GND', points: '14:12/38:12' });
  const r = await analyze(page);
  expect(r.level).toBe('danger');
  expect(codes(r)).toContain('ic_overvoltage');
});

test('regulator with floating ground and an unpowered chip are caught', async ({ page }) => {
  await gotoTrace(page);
  await usb(page);
  await exec(page, 'place', { type: 'ldo', x: 30, y: 40 });
  await exec(page, 'route', { from: 'J1.VBUS', to: 'U1.IN' });
  expect(codes(await analyze(page))).toContain('reg_no_ground');
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'mcu', x: 30, y: 20 });
  expect(codes(await analyze(page))).toEqual(expect.arrayContaining(['ic_unpowered', 'no_source']));
});

test('set_electrical overrides ratings and validates its input', async ({ page }) => {
  await gotoTrace(page);
  await ledCircuit(page, '330R');
  expect((await analyze(page)).level).toBe('safe');
  await exec(page, 'set_electrical', { ref: 'R1', pmax: 0.0001 }); // tiny resistor now overheats
  expect(codes(await analyze(page))).toContain('resistor_overpower');
  expect(await tryExec(page, 'set_electrical', { ref: 'ZZ9', pmax: 1 })).toMatch(/no part/);
  expect(await tryExec(page, 'set_electrical', {})).toMatch(/nothing to set/);
  expect(await tryExec(page, 'set_electrical', { type: 'resistor', pmax: 1 })).toMatch(/built in/);
});

test('safety panel shows verdict and fixes, and updates live as the board changes', async ({ page }) => {
  await gotoTrace(page);
  await ledCircuit(page, '330R');
  await exec(page, 'set_value', { ref: 'R1', value: '10R' });
  await settle(page);
  await expect(page.locator('#trsafe .tr-safe')).toHaveAttribute('data-level', 'danger');
  await expect(page.locator('#trsafe .tr-issue.danger').filter({ hasText: '20 mA' })).toHaveCount(1);
  await expect(page.locator('#trsafe .tr-issue .f').first()).toContainText('Fix:');
  await exec(page, 'set_value', { ref: 'R1', value: '330R' });
  await settle(page);
  await expect(page.locator('#trsafe .tr-safe')).toHaveAttribute('data-level', 'safe');
  await expect(page.locator('#trsafe .tr-issue')).toHaveCount(0);
});

test('with no power source the analyser cannot check yet', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 });
  const r = await analyze(page);
  expect(r.level).toBe('unknown');
  expect(codes(r)).toContain('no_source');
  await expect(page.locator('#trsafe .tr-safe')).toHaveAttribute('data-level', 'unknown');
});
