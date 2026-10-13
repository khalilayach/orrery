// @ts-check
// E2E tests for TRACE's design layer (trace/design.js): the `circuit` digest the AI reads, the atomic
// `build` command, collision-safe placement ("parts inside parts" can no longer happen) and the
// new problem markers on the board.
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startMock } from './helpers/mock-server.js';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = pathToFileURL(resolve(ROOT, 'index.html')).href;
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40)))));
async function gotoTrace(page, qs = '?agents=57312') {
  await page.addInitScript(() => { try { localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } }); // these specs test the PCB tab
  await page.goto(PAGE + qs + '#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await settle(page);
  await page.evaluate(() => TRACE.exec('clear', {}));
}
const exec = (page, cmd, args, source) => page.evaluate(([c, a, s]) => TRACE.exec(c, a, s), [cmd, args, source]);
const tryExec = (page, cmd, args, source) => page.evaluate(([c, a, s]) => { try { TRACE.exec(c, a, s); return null; } catch (e) { return e.message; } }, [cmd, args, source]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));

/** a complete small design: USB-C → LDO → MCU with decoupling and an LED */
const DESIGN = {
  replace: true, board: { w: 60, h: 40 },
  parts: [
    { ref: 'J1', type: 'usbc', block: 'power', note: 'USB-C brings in 5 V' },
    { ref: 'U1', type: 'ldo', block: 'power', note: 'Turns 5 V into 3.3 V' },
    { ref: 'C1', type: 'capacitor', value: '10uF', block: 'power' },
    { ref: 'U2', type: 'mcu', block: 'mcu', note: 'The brain' },
    { ref: 'C2', type: 'capacitor', block: 'mcu' },
    { ref: 'R1', type: 'resistor', value: '150R', block: 'led' },
    { ref: 'D1', type: 'led', block: 'led' },
  ],
  nets: {
    GND: ['J1.GND', 'U1.GND', 'C1.2', 'U2.GND', 'C2.2', 'D1.K'], VBUS: ['J1.VBUS', 'U1.IN'], '+3V3': ['U1.OUT', 'C1.1', 'U2.VDD', 'C2.1'],
    USB_DP: ['J1.D+', 'U2.USB_DP'], USB_DM: ['J1.D-', 'U2.USB_DM'], LEDSIG: ['U2.PA5', 'R1.1'], LEDA: ['R1.2', 'D1.A'],
  },
};

test('build places a whole design at once: no overlaps, wired, consistent, one undo step', async ({ page }) => {
  await gotoTrace(page);
  const r = await exec(page, 'build', { spec: DESIGN });
  expect(r.ok).toBe(true);
  expect(r.placed.map((p) => p.ref)).toEqual(['J1', 'U1', 'C1', 'U2', 'C2', 'R1', 'D1']);
  expect(r.drc_errors).toBe(0);
  expect(r.danger).toBe(0);
  const s = await state(page);
  expect(s.parts.length).toBe(7);
  expect(s.links.length).toBe(13); // 5 + 1 + 3 + 1 + 1 + 1 + 1
  expect(s.parts.find((p) => p.ref === 'U1').note).toBe('Turns 5 V into 3.3 V');
  expect((await exec(page, 'drc', {})).errors).toEqual([]); // nothing on top of anything
  // blocks stay together: the power parts are left of the MCU, the LED parts are right of it
  const x = (ref) => s.parts.find((p) => p.ref === ref).x;
  expect(x('J1')).toBeLessThan(x('U2')); expect(x('R1')).toBeGreaterThan(x('U2'));
  await exec(page, 'undo', {}); // the whole build is one undo step
  expect((await state(page)).parts.length).toBe(0);
});

test('build is all-or-nothing: a bad spec is rejected with every problem listed and nothing changes', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'place', { type: 'resistor', x: 30, y: 20 });
  const bad = { parts: [{ ref: 'X1', type: 'nope' }, { ref: 'U9', type: 'mcu', x: 30, y: 20 }, { ref: 'C9', type: 'capacitor' }], nets: { A: ['C9.1', 'Q7.1'] } };
  const msg = await tryExec(page, 'build', { spec: bad });
  expect(msg).toMatch(/BUILD REJECTED — nothing was changed/);
  expect(msg).toMatch(/unknown part type "nope"/);
  expect(msg).toMatch(/would overlap R1/); // names the part in the way…
  expect(msg).toMatch(/free spot x=/);      // …and offers a free spot
  expect(msg).toMatch(/Q7/);                // bad pad reference
  const s = await state(page);
  expect(s.parts.map((p) => p.ref)).toEqual(['R1']); // untouched
  expect(s.links.length).toBe(0);
  expect(await tryExec(page, 'build', { spec: '{not json' })).toMatch(/not valid JSON/);
  expect(await tryExec(page, 'build', {})).toMatch(/needs spec/);
  expect(await tryExec(page, 'build', { spec: { parts: [] } })).toMatch(/no parts/);
});

test('build dry-run changes nothing; replace swaps the whole design and undo brings the old one back', async ({ page }) => {
  await gotoTrace(page);
  const dry = await exec(page, 'build', { spec: { ...DESIGN, dry: true } });
  expect(dry.dry).toBe(true);
  expect(dry.note).toMatch(/nothing was placed/);
  expect((await state(page)).parts.length).toBe(0);
  await exec(page, 'build', { spec: DESIGN });
  const v2 = { replace: true, parts: [{ ref: 'R1', type: 'resistor', value: '1k' }, { ref: 'R2', type: 'resistor', value: '2k' }], nets: { MID: ['R1.2', 'R2.1'] } };
  await exec(page, 'build', { spec: v2 });
  expect((await state(page)).parts.map((p) => p.ref)).toEqual(['R1', 'R2']);
  await exec(page, 'undo', {});
  expect((await state(page)).parts.length).toBe(7);
});

test('build reports electrical danger instead of hiding it (and tells the AI to rebuild, not patch)', async ({ page }) => {
  await gotoTrace(page);
  const r = await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'J1', type: 'usbc' }, { ref: 'D1', type: 'led' }], nets: { VBUS: ['J1.VBUS', 'D1.A'], GND: ['J1.GND', 'D1.K'] } } });
  expect(r.ok).toBe(true);
  expect(r.danger).toBeGreaterThan(0);
  expect(r.summary).toMatch(/DANGER led_overcurrent/);
  expect(r.next).toMatch(/replace:true/);
});

test('circuit digest: the whole circuit in a few lines — parts, nets with volts, power tree, problems, to-do', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: DESIGN });
  const d = await exec(page, 'circuit', {});
  const lines = d.text.split('\n');
  expect(lines.length).toBeLessThan(45);
  expect(d.text).toMatch(/BOARD 60x40mm · 7 parts · 13 wires \(13 not routed\)/);
  expect(d.text).toMatch(/U1 3\.3V LDO "3V3" \[regulator out 3\.3V/);
  expect(d.text).toMatch(/IN→VBUS GND→GND OUT→\+3V3/);
  expect(d.text).toMatch(/— Turns 5 V into 3\.3 V/); // what the part is for
  expect(d.text).toMatch(/\+3V3 3\.3V /);
  expect(d.text).toMatch(/VBUS 5V /);
  expect(d.text).toMatch(/POWER {2}J1 5V .* → U1 3\.3V/);
  expect(d.text).toMatch(/PROBLEMS none/);
  expect(d.text).toMatch(/TODO .*source real parts for .*route copper for 13 wires/);
  expect(d.text).toMatch(/U1 has no decoupling capacitor on VBUS/); // design-intent check
  expect(d.safety).toBe('safe');
  expect(d.unrouted).toBe(13);
  // and problems show up, with their fix
  await exec(page, 'disconnect', { a: 'D1.K', b: 'J1.GND' });
  await exec(page, 'connect', { a: 'D1.K', b: 'J1.VBUS' }); // LED across the supply, no GND return
  expect((await exec(page, 'circuit', {})).text).toMatch(/PROBLEMS\n (DANGER|warn)/);
});

test('placement guard: the AI cannot put a part inside another one; you still can; auto and free_spot find room', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'place', { type: 'mcu', x: 30, y: 20 }, 'claude');
  const msg = await tryExec(page, 'place', { type: 'mcu', x: 31, y: 20 }, 'claude');
  expect(msg).toMatch(/would overlap U1/);
  expect(msg).toMatch(/Nearest free spot: x=\d+(\.\d)? y=\d+(\.\d)?/);
  expect((await state(page)).parts.length).toBe(1);
  expect(await tryExec(page, 'place', { type: 'mcu', x: 1, y: 1 }, 'claude')).toMatch(/board edge/);
  // the user dragging/placing by hand is not blocked (DRC will tell them)
  expect(await tryExec(page, 'place', { type: 'mcu', x: 31, y: 20 }, 'user')).toBeNull();
  // auto=1 picks a free spot by itself
  const a = await exec(page, 'place', { type: 'capacitor', auto: 1 }, 'claude');
  expect((await exec(page, 'drc', {})).errors.some((e) => e.refs && e.refs.includes(a.ref))).toBe(false);
  const near = await exec(page, 'free_spot', { type: 'resistor', near: 'U1' });
  expect(near).toHaveProperty('x'); expect(near).toHaveProperty('y');
  expect(await tryExec(page, 'free_spot', { type: 'nope' })).toMatch(/unknown part type/);
  // move guard for the AI
  const m = await tryExec(page, 'move', { ref: a.ref, x: 30, y: 20 }, 'claude');
  expect(m).toMatch(/would overlap/);
  expect(await tryExec(page, 'move', { ref: a.ref, x: 45, y: 8 }, 'claude')).toBeNull();
});

test('DRC reports parts on top of parts; the board shows a small badge and outline, not a big circle', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'place', { type: 'resistor', x: 30, y: 20 });
  await exec(page, 'place', { type: 'resistor', x: 31.5, y: 20 }); // user-placed on top
  const d = await exec(page, 'drc', {});
  const ov = d.errors.find((e) => e.rule === 'part_overlap');
  expect(ov.refs).toEqual(['R1', 'R2']);
  expect(ov.msg).toMatch(/on top of each other/);
  await settle(page);
  const marks = page.locator('#trsvg [data-badge]');
  expect(await marks.count()).toBeGreaterThanOrEqual(2); // one per part involved
  await expect(page.locator('#trsvg rect[data-mark="R1"]')).toHaveCount(1);
  // the badge is small: radius is a handful of screen pixels, never a huge ring
  const r = await page.evaluate(() => { const c = document.querySelector('#trsvg [data-badge] circle'); const svg = document.getElementById('trsvg'); const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width; return Number(c.getAttribute('r')) * k; });
  expect(r).toBeGreaterThan(4); expect(r).toBeLessThan(10);
  await expect(page.locator('#trsvg [data-badge] title').first()).toContainText('overlap');
  // move it away → the problem and its marks disappear
  await exec(page, 'move', { ref: 'R2', x: 50, y: 20 });
  await settle(page);
  expect((await exec(page, 'drc', {})).errors).toEqual([]);
  await expect(page.locator('#trsvg [data-badge]')).toHaveCount(0);
});

test('CLI: build file=… and circuit work through the server; bad input fails with a clear message', async ({ page }) => {
  const mock = await startMock();
  const dir = mkdtempSync(join(tmpdir(), 'trace-design-'));
  try {
    await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); } catch (_) { /* ignore */ } }); // these tests drive Claude's edits: Auto mode
    await page.goto(PAGE + '?agents=' + mock.port + '#trace');
    await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
    await exec(page, 'clear', {});
    const run = (...args) => new Promise((res) => execFile('node', [resolve(ROOT, 'server/trace-cli.mjs'), ...args],
      { cwd: dir, env: { ...process.env, TRACE_PORT: String(mock.port), TRACE_TOKEN: mock.token } },
      (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout, err: stderr })));
    writeFileSync(join(dir, 'design.json'), JSON.stringify(DESIGN));
    const b = await run('build', 'file=design.json');
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/^BOARD 60x40mm · 7 parts/m);
    expect(b.out).toMatch(/"ok":true/);
    expect((await state(page)).parts.length).toBe(7);
    const c = await run('circuit');
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/^PARTS/m);
    expect(c.out.split('\n').length).toBeLessThan(45);
    expect(c.out).not.toMatch(/^\{/); // plain text, not a JSON blob
    writeFileSync(join(dir, 'bad.json'), '{ nope');
    expect((await run('build', 'file=bad.json')).err).toMatch(/not valid JSON/);
    expect((await run('build', 'file=missing.json')).err).toMatch(/cannot read/);
    expect((await run('build')).err).toMatch(/needs file=/);
    writeFileSync(join(dir, 'over.json'), JSON.stringify({ parts: [{ ref: 'U9', type: 'mcu', x: 30, y: 20 }] }));
    const o = await run('build', 'file=over.json');
    expect(o.code).not.toBe(0);
    expect(o.err).toMatch(/BUILD REJECTED/);
    expect((await state(page)).parts.length).toBe(7); // untouched
    // the AI's place command is guarded through the same path
    const p = await run('place', 'type=mcu', 'x=30', 'y=20');
    expect(p.err).toMatch(/would overlap|cannot place/);
  } finally { mock.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('build can also set up the board shape and wire classes in the same validated call; the digest lists the schematic blocks', async ({ page }) => {
  await gotoTrace(page);
  const spec = { ...DESIGN, outline: { radius: 5 }, cutouts: [{ shape: 'circle', x: 6, y: 6, d: 3 }], rules: { classes: [{ name: 'Power', width: 0.6, clearance: 0.25 }], assign: { VBUS: 'Power', '+3V3': 'Power' } } };
  const r = await exec(page, 'build', { spec });
  expect(r.ok).toBe(true);
  const s = await state(page);
  expect(s.outline.radius).toBe(5);
  expect(s.cutouts.length).toBe(1);
  expect(s.rules.assign).toEqual({ VBUS: 'power', '+3V3': 'power' });
  expect(s.rules.classes.find((c) => c.id === 'power').width).toBe(0.6);
  expect((await exec(page, 'route', { from: 'J1.VBUS', to: 'U1.IN' })).width).toBe(0.6);
  expect((await exec(page, 'circuit', {})).text).toMatch(/BLOCKS {2}power: J1,U1,C1 · mcu: U2,C2 · led: R1,D1/);
  // a bad extra rejects the WHOLE build, nothing placed
  await exec(page, 'clear', {});
  const msg = await tryExec(page, 'build', { spec: { ...DESIGN, rules: { assign: { NOPE: 'Power' } }, outline: { radius: 999 } } });
  expect(msg).toMatch(/BUILD REJECTED/);
  expect(msg).toMatch(/corner radius must be/);
  expect(msg).toMatch(/unknown net/);
  expect((await state(page)).parts.length).toBe(0);
});
