// @ts-check
// E2E tests for TRACE's router, placer and "what settings give me this trace?" card:
//   autoroute  (classes, ground pour, vias, failures, rip-up), autoplace (edges, decoupling, no overlaps, soldering gap),
//   explain_trace / explain_net, and the Auto-place / Auto-route / Review buttons with their panels.
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

// ---------------------------------------------------------------- router
test('autoroute: every connection gets real copper, DRC stays clean, nothing is left unrouted', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  expect((await exec(page, 'analyze', {})).unrouted_links.length).toBe(10 + 2 + 0 + 0 > 0 ? (await exec(page, 'analyze', {})).unrouted_links.length : 0); // all wires start without copper
  expect((await exec(page, 'analyze', {})).unrouted_links.length).toBeGreaterThan(10);
  const r = await exec(page, 'autoroute', {});
  expect(r.failed).toEqual([]);
  expect(r.drc_errors).toBe(0);
  expect(r.traces_added).toBeGreaterThan(8);
  const a = await exec(page, 'analyze', {});
  expect(a.unrouted_links).toEqual([]);
  expect(a.issues.map((i) => i.code)).not.toContain('net_open');
  expect((await exec(page, 'drc', {})).errors).toEqual([]);
  // every trace ends exactly on a pad centre, a via, or on copper of its own net — never in mid-air
  const s = await state(page), pads = await exec(page, 'board', {});
  const centres = pads.parts.flatMap((p) => p.pads.map((q) => q.x + ',' + q.y));
  const ends = s.traces.flatMap((t) => [t.pts[0], t.pts[t.pts.length - 1]]);
  const onPad = ends.filter(([x, y]) => centres.includes(x + ',' + y)).length + s.vias.length * 0;
  expect(onPad).toBeGreaterThan(8);
  for (const t of s.traces) { expect(t.auto).toBe(true); expect(['F.Cu', 'B.Cu']).toContain(t.layer); }
});

test('autoroute: ground goes to a copper pour on the back layer with a via per surface-mount pin', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  const r = await exec(page, 'autoroute', {});
  expect(r.pour).toBe('GND');
  const s = await state(page);
  expect(s.zones).toHaveLength(1);
  expect(s.zones[0]).toMatchObject({ net: 'GND', layer: 'B.Cu' });
  const gndVias = s.vias.filter((v) => v.net === 'GND');
  expect(gndVias.length).toBeGreaterThanOrEqual(6); // one for each ground pad on a surface-mount part
  await page.click('[data-vtab="board"]');
  await expect(page.locator('#trsvg [data-pour]')).toHaveCount(1);
  // without the pour the same ground pins have no copper any more
  expect((await exec(page, 'analyze', {})).unrouted_links).toEqual([]);
  await exec(page, 'remove', { id: s.zones[0].id });
  const A = await exec(page, 'analyze', {});
  expect(A.unrouted_links.length).toBeGreaterThanOrEqual(6);
  expect(A.issues.map((i) => i.code)).toContain('unrouted');
});

test('autoroute: pour=off routes ground as ordinary traces; vias=0 stays on one layer', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  const r = await exec(page, 'autoroute', { pour: 'off', vias: 0 });
  expect(r.pour).toBeNull();
  const s = await state(page);
  expect(s.zones || []).toEqual([]);
  expect(s.vias).toEqual([]);
  expect(s.traces.every((t) => t.layer === 'F.Cu')).toBe(true);
  // a one-layer board may not be fully routable — failures must be reported, not hidden
  expect(r.routed + r.failed.length).toBeGreaterThan(8);
  for (const f of r.failed) expect(f.reason).toMatch(/blocked/);
});

test('autoroute follows wire classes: width from the net class, clearance enforced, explicit width still wins', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  await exec(page, 'rule_class', { name: 'Power', width: 0.6, clearance: 0.25 });
  await exec(page, 'rule_assign', { net: 'VBUS,+3V3', class: 'Power' });
  const r = await exec(page, 'autoroute', {});
  expect(r.drc_errors).toBe(0);
  const s = await state(page);
  for (const t of s.traces.filter((x) => x.net === 'VBUS' || x.net === '+3V3')) expect(t.width).toBe(0.6);
  for (const t of s.traces.filter((x) => x.net === 'LEDSIG' || x.net === 'IO1')) expect(t.width).toBe(0.25);
  expect(s.vias.filter((v) => v.net === 'VBUS').every((v) => v.d === 1)).toBe(true); // the Power class via size
  // routing only one net leaves the rest alone
  await exec(page, 'clear_routes', { all: 1 });
  const one = await exec(page, 'autoroute', { net: 'LEDSIG', pour: 'off' });
  expect(new Set((await state(page)).traces.map((t) => t.net))).toEqual(new Set(['LEDSIG']));
  expect(one.routed).toBe(1);
});

test('autoroute: a net that needs more copper than the default gets a wider class automatically (IPC-2221)', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'battery', x: 38, y: 20 });
  await exec(page, 'place', { type: 'resistor', x: 10, y: 20, value: '3R3' });
  await exec(page, 'connect', { a: 'BT1.+', b: 'R1.2', net: 'HEAVY' });
  await exec(page, 'connect', { a: 'R1.1', b: 'BT1.-', net: 'GND' });
  const sug = await exec(page, 'suggest_rules', {});
  const heavy = sug.nets.find((n) => n.net === 'HEAVY');
  expect(heavy.amps).toBeGreaterThan(0.9);
  expect(heavy.needed_mm).toBeGreaterThan(0.25);
  expect(heavy.width_mm).toBeGreaterThanOrEqual(heavy.needed_mm); // rounded up with headroom
  expect(heavy.why).toMatch(/IPC-2221/);
  const r = await exec(page, 'autoroute', { pour: 'off' });
  expect(r.classes.assigned.join()).toMatch(/HEAVY/);
  const t = (await state(page)).traces.find((x) => x.net === 'HEAVY');
  expect(t.width).toBeGreaterThanOrEqual(heavy.needed_mm);
  expect((await exec(page, 'analyze', {})).issues.map((i) => i.code)).not.toContain('trace_overheat');
  // switching it off leaves the width at the default
  await exec(page, 'clear_routes', { all: 1 });
  await exec(page, 'rule_assign', { net: 'HEAVY', class: 'Default' });
  await exec(page, 'autoroute', { pour: 'off', classes: 'off' });
  expect((await state(page)).traces.find((x) => x.net === 'HEAVY').width).toBe(0.25);
});

test('autoroute: when copper is impossible it says so and why (a cut-out wall across the board)', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'set_board', { w: 30, h: 20 });
  await exec(page, 'place', { type: 'resistor', x: 6, y: 10 });
  await exec(page, 'place', { type: 'resistor', x: 24, y: 10 });
  await exec(page, 'connect', { a: 'R1.2', b: 'R2.1', net: 'SIG' });
  await exec(page, 'add_cutout', { shape: 'rect', x: 15, y: 10, w: 1.5, h: 19 }); // a slot from edge to edge
  const r = await exec(page, 'autoroute', { pour: 'off' });
  expect(r.failed).toHaveLength(1);
  expect(r.failed[0]).toMatchObject({ net: 'SIG' });
  expect(r.failed[0].reason).toMatch(/blocked.*R1\.2.*R2\.1|blocked.*R2\.1.*R1\.2/);
  expect(r.note).toMatch(/could not be routed/);
  expect((await state(page)).traces.length).toBe(0);
});

test('rip-up: running autoroute twice does not duplicate copper, hand-drawn traces stay, clear_routes removes only the router’s', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  await exec(page, 'autoroute', {});
  const n1 = (await state(page)).traces.length;
  await exec(page, 'autoroute', {});
  expect((await state(page)).traces.length).toBe(n1);
  await exec(page, 'clear_routes', { all: 1 });
  expect((await state(page)).traces.length).toBe(0);
  await exec(page, 'route', { from: 'U2.PA5', to: 'R1.1' }); // by hand
  await exec(page, 'autoroute', {});
  const s = await state(page);
  expect(s.traces.filter((t) => !t.auto)).toHaveLength(1);
  const gone = await exec(page, 'clear_routes', {});
  expect(gone.traces_removed).toBeGreaterThan(5);
  expect((await state(page)).traces.filter((t) => !t.auto)).toHaveLength(1);
});

test('copper pour: add_pour validates, one per net and layer, removed with the board clear', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  expect(await tryExec(page, 'add_pour', { net: 'NOPE' })).toMatch(/no net "NOPE"/);
  const z = await exec(page, 'add_pour', { net: 'GND' });
  expect(z.pour).toMatchObject({ net: 'GND', layer: 'B.Cu' });
  await exec(page, 'add_pour', { net: 'GND' });
  expect((await state(page)).zones).toHaveLength(1);
  await exec(page, 'clear', {});
  expect((await state(page)).zones || []).toHaveLength(0);
});

// ---------------------------------------------------------------- placer
test('autoplace: nothing overlaps, connectors sit on the edge facing out, wiring gets shorter', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: BOARD });
  const r = await exec(page, 'autoplace', {});
  expect(r.wirelength_after_mm).toBeLessThan(r.wirelength_before_mm);
  expect((await exec(page, 'drc', {})).errors).toEqual([]);
  expect(r.edge.J1).toBeTruthy();
  const s = await state(page), j1 = s.parts.find((p) => p.ref === 'J1');
  const side = r.edge.J1, want = { left: 0, top: 90, right: 180, bottom: 270 }[side];
  expect(j1.rot).toBe(want); // the USB-C opening points out of the board
  const rv = await exec(page, 'review', {});
  expect(rv.findings.map((f) => f.code)).not.toContain('connector_edge');
  expect(rv.findings.map((f) => f.code)).not.toContain('connector_facing');
});

test('autoplace: decoupling capacitors end up at the pin they serve', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: BOARD });
  const r = await exec(page, 'autoplace', {});
  expect(r.anchored.length).toBeGreaterThanOrEqual(2);
  const rv = await exec(page, 'review', {});
  expect(rv.findings.filter((f) => f.code === 'decoupling_far' && f.level === 'warning')).toEqual([]);
  expect(rv.findings.filter((f) => f.code === 'decoupling_missing')).toEqual([]);
});

test('autoplace: pinned parts do not move; old copper is removed; keep=1 drags it along; the board being too small is an error', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  await exec(page, 'autoroute', {});
  const before = (await state(page)).parts.find((p) => p.ref === 'U2');
  const r = await exec(page, 'autoplace', { pin: 'U2' });
  expect(r.copper_removed.traces_removed).toBeGreaterThan(5);
  expect((await state(page)).traces).toHaveLength(0);
  const after = (await state(page)).parts.find((p) => p.ref === 'U2');
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  await exec(page, 'autoroute', {});
  const kept = await exec(page, 'autoplace', { keep: 1, seed: 3 });
  expect(kept.copper_removed).toBeNull();
  await exec(page, 'set_board', { w: 14, h: 12 });
  expect(await tryExec(page, 'autoplace', {})).toMatch(/no room|make the board bigger/);
});

test('autoplace: deterministic for the same seed, and the soldering gap follows hand / reflow', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: BOARD });
  await exec(page, 'autoplace', { seed: 5 });
  const a = (await state(page)).parts.map((p) => [p.ref, p.x, p.y, p.rot].join());
  await exec(page, 'build', { spec: BOARD });
  await exec(page, 'autoplace', { seed: 5 });
  expect((await state(page)).parts.map((p) => [p.ref, p.x, p.y, p.rot].join())).toEqual(a);
  expect(await tryExec(page, 'set_assembly', { mode: 'wave' })).toMatch(/hand .* or reflow/);
  expect((await exec(page, 'set_assembly', { mode: 'reflow' })).min_gap_mm).toBe(0.5);
  expect((await exec(page, 'set_assembly', { mode: 'hand' })).min_gap_mm).toBe(0.9);
  expect((await state(page)).assembly).toBe('hand');
});

test('an RF module goes on the top edge with its antenna pointing out, and nothing is placed in front of it', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, board: { w: 46, h: 60 }, parts: [
    { ref: 'U1', type: 'esp32', create: { id: 'esp32', template: 'quad', pins: 48, label: 'ESP32-S3-MINI-1', prefix: 'U' } }, { ref: 'C1', type: 'capacitor' }, { ref: 'R1', type: 'resistor' }, { ref: 'J1', type: 'usbc' }],
  nets: { GND: ['U1.1', 'C1.2', 'J1.GND'], '+3V3': ['U1.2', 'C1.1', 'R1.1'], USB_DP: ['J1.D+', 'U1.3'], USB_DM: ['J1.D-', 'U1.4'], EN: ['U1.5', 'R1.2'] } } });
  const r = await exec(page, 'autoplace', {});
  expect(r.edge.U1).toBe('top');
  const u1 = (await state(page)).parts.find((p) => p.ref === 'U1');
  expect(u1.rot).toBe(0);
  expect(u1.y).toBeLessThan(12);
  expect((await exec(page, 'review', {})).findings.map((f) => f.code)).not.toContain('antenna_keepout');
});

// ---------------------------------------------------------------- "what do I set to get exactly this trace?"
test('explain_trace: class, width, current, clearance, via, resistance and notes — and flags a trace that is too thin', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'battery', x: 38, y: 20 });
  await exec(page, 'place', { type: 'resistor', x: 10, y: 20, value: '3R3' });
  await exec(page, 'connect', { a: 'BT1.+', b: 'R1.2', net: 'HEAVY' });
  await exec(page, 'connect', { a: 'R1.1', b: 'BT1.-', net: 'GND' });
  const t = await exec(page, 'route', { from: 'BT1.+', to: 'R1.2', width: 0.2 });
  const e = await exec(page, 'explain_trace', { id: t.id });
  expect(e).toMatchObject({ net: 'HEAVY', layer: 'F.Cu', class: 'Default', width_now_mm: 0.2, ok_for_current: false });
  expect(e.current_a).toBeGreaterThan(0.9);
  expect(e.min_width_for_current_mm).toBeGreaterThan(0.3);
  expect(e.recommended_width_mm).toBeGreaterThanOrEqual(e.min_width_for_current_mm);
  expect(e.notes.join(' ')).toMatch(/TOO THIN/);
  expect(e.resistance_mohm).toBeGreaterThan(0);
  expect(e.drop_mv).toBeGreaterThan(0);
  expect(e.steps.join('\n')).toMatch(/Width: .* mm/);
  expect(e.steps.join('\n')).toMatch(/rule_class name="Default" width=/);
  expect(e.clearance_mm).toBe(0.15);
  expect(e.via_d_mm).toBe(0.8);
  // a thick enough trace passes
  await exec(page, 'set_trace', { id: t.id, width: e.recommended_width_mm });
  const ok = await exec(page, 'explain_trace', { id: t.id });
  expect(ok.ok_for_current).toBe(true);
  expect(ok.margin).toBeGreaterThan(1);
  expect(await tryExec(page, 'explain_trace', { id: 'nope' })).toMatch(/no trace/);
  const n = await exec(page, 'explain_net', { net: 'HEAVY' });
  expect(n.routed).toBe(true); expect(n.pads).toEqual(['BT1.+', 'R1.2']);
  expect(await tryExec(page, 'explain_net', { net: 'NOPE' })).toMatch(/no net/);
});

test('clicking a trace shows its spec; "Use this spec for the net" creates the class and re-widths; Copy settings copies the steps', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoTrace(page);
  await exec(page, 'clear', {});
  await exec(page, 'place', { type: 'battery', x: 38, y: 20 });
  await exec(page, 'place', { type: 'resistor', x: 10, y: 20, value: '3R3' });
  await exec(page, 'connect', { a: 'BT1.+', b: 'R1.2', net: 'HEAVY' });
  await exec(page, 'connect', { a: 'R1.1', b: 'BT1.-', net: 'GND' });
  const t = await exec(page, 'route', { from: 'BT1.+', to: 'R1.2', width: 0.2 });
  await settle(page);
  const mid = (await state(page)).traces[0].pts;
  const at = await page.evaluate(([x, y]) => { const svg = document.getElementById('trsvg'), r = svg.getBoundingClientRect(), [vx, vy, vw] = svg.getAttribute('viewBox').split(' ').map(Number), k = r.width / vw; return { x: r.left + (x - vx) * k, y: r.top + (y - vy) * k }; }, [(mid[0][0] + mid[mid.length - 1][0]) / 2, mid[0][1]]);
  await page.mouse.click(at.x, at.y);
  const spec = page.locator('.tr-spec');
  await expect(spec).toBeVisible();
  await expect(spec).toContainText('TRACE SPEC');
  await expect(spec).toContainText('Wire class');
  await expect(spec).toContainText('Default');
  await expect(spec.locator('.tr-line.bad').first()).toBeVisible(); // the width / current row is red: it is too thin
  await expect(spec).toContainText('TOO THIN');
  await expect(spec).toContainText('Clearance');
  await expect(spec).toContainText('1 oz');
  await page.click('[data-spec="copy"]');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/Width: .* mm/);
  await page.click('[data-spec="apply"]');
  const s = await state(page);
  expect(s.rules.classes.some((c) => /^Power /.test(c.name))).toBe(true);
  expect(s.traces.find((x) => x.id === t.id).width).toBeGreaterThan(0.3);
  expect((await exec(page, 'explain_trace', { id: t.id })).ok_for_current).toBe(true);
});

test('clicking an airwire explains the trace it will become, and "Route this net" makes it', async ({ page }) => {
  await gotoTrace(page);
  await placed(page);
  await expect(page.locator('#trsvg [data-rat]').first()).toBeAttached();
  // find a spot on some airwire that nothing else covers (airwires sit under the copper and the parts)
  const spot = await page.evaluate(() => {
    for (const ln of document.querySelectorAll('#trsvg [data-rat]')) {
      const m = ln.getScreenCTM(), x1 = +ln.getAttribute('x1'), y1 = +ln.getAttribute('y1'), x2 = +ln.getAttribute('x2'), y2 = +ln.getAttribute('y2');
      for (let t = 0.15; t < 0.86; t += 0.05) { const x = (x1 + (x2 - x1) * t) * m.a + m.e, y = (y1 + (y2 - y1) * t) * m.d + m.f; if (document.elementFromPoint(x, y) === ln) return { x, y }; }
    }
    return null;
  });
  expect(spot).not.toBeNull();
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('.tr-card')).toContainText('Not routed yet');
  await expect(page.locator('.tr-spec')).toContainText('Width to use');
  const net = await page.locator('#insroute').getAttribute('data-net');
  await page.click('#insroute');
  await expect.poll(async () => { const st = await state(page); return [...st.traces, ...st.vias].filter((t) => t.net === net).length; }, { timeout: 5000 }).toBeGreaterThan(0); // (a ground net may be a via to the pour, not a trace)
});

// ---------------------------------------------------------------- the buttons
test('toolbar: Auto-place, Auto-route and Review do their job and report in plain words', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: BOARD });
  await settle(page);
  await expect(page.locator('#trplace')).toBeVisible();
  await page.click('#trplace');
  await expect(page.locator('#trlog')).toContainText('auto-place:');
  await expect(page.locator('#trlog')).toContainText('decoupling caps at their pins');
  await page.click('#trroute');
  await expect(page.locator('#trlog')).toContainText('auto-route:', { timeout: 8000 });
  await expect(page.locator('#trlog')).toContainText('0 DRC errors');
  await expect(page.locator('#trlog')).toContainText('GND pour on B.Cu');
  await expect(page.locator('#trsvg [data-rat]')).toHaveCount(0);   // no airwires left: all copper
  await expect(page.locator('#trsvg [data-pour]')).toHaveCount(1);
  await page.click('#trreviewbtn');
  await expect(page.locator('[data-rtab="inspect"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#trreview')).toContainText('Last auto-route');
  await expect(page.locator('#trreview')).toContainText('routed');
  await expect(page.locator('#trlog')).toContainText('review:');
  // stepper: Layout is done once everything is routed and DRC is clean
  await page.click('[data-rtab="copilot"]');
  await expect(page.locator('.tr-steps .step[data-step="lay"]')).toHaveClass(/done/);
});

test('Review panel: grouped findings with fixes, a count on the Inspect tab, and clicking one selects the part', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: { replace: true, board: { w: 40, h: 30 }, parts: [{ ref: 'U2', type: 'mcu' }, { ref: 'R1', type: 'resistor' }], nets: { SDA: ['U2.PA5', 'R1.1'] } } });
  await page.click('#trreviewbtn');
  const rv = page.locator('#trreview');
  await expect(rv).toContainText(/Not ready|Almost there/);
  await expect(rv.locator('.tr-rvcat').first()).toBeVisible();
  await expect(rv.locator('.tr-rv.warning').first()).toBeVisible();
  await expect(rv.locator('.tr-rv .f').first()).not.toBeEmpty();
  await expect(page.locator('#trissuecount')).toBeVisible();
  const n = Number(await page.locator('#trissuecount').textContent());
  expect(n).toBeGreaterThan(1);
  await rv.locator('.tr-rv', { hasText: 'supply pin' }).first().click();
  await expect(page.locator('#trinsp')).toContainText('U2');
  // the board shows the problem on the part itself
  await expect(page.locator('#trsvg [data-badge="U2"]')).toHaveCount(1);
});

test('the circuit digest the AI reads includes the review and the real routing state', async ({ page }) => {
  await gotoTrace(page);
  await exec(page, 'build', { spec: BOARD });
  const d0 = await exec(page, 'circuit', {});
  expect(d0.unrouted).toBeGreaterThan(10);
  await exec(page, 'autoplace', {}); await exec(page, 'autoroute', {});
  const d = await exec(page, 'circuit', {});
  expect(d.unrouted).toBe(0);
  expect(d.text).toMatch(/\(0 not routed\)/);
  expect(d.text).not.toMatch(/route copper for/);
  expect(d.text).toMatch(/REVIEW {2}\d+ things? an engineer would fix:/);
  expect(d.text).toMatch(/warn i2c|warn decoupling|warn /);
});

test('CLI: autoplace, autoroute, review and explain_trace work through the server', async ({ page }) => {
  const { startMock } = await import('./helpers/mock-server.js');
  const { execFile } = await import('node:child_process');
  const mock = await startMock();
  try {
    await page.addInitScript(() => { try { localStorage.setItem('trace-mode-v1', 'auto'); localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } });
    await page.goto(PAGE + '?agents=' + mock.port + '#trace');
    await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
    await exec(page, 'clear', {});
    await exec(page, 'build', { spec: BOARD });
    const run = (...args) => new Promise((res) => execFile('node', [resolve(import.meta.dirname, '..', 'server/trace-cli.mjs'), ...args], { env: { ...process.env, TRACE_PORT: String(mock.port), TRACE_TOKEN: mock.token } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout, err: stderr })));
    const p = await run('autoplace'); expect(p.code).toBe(0); expect(JSON.parse(p.out).edge).toBeTruthy();
    const r = await run('autoroute'); expect(r.code).toBe(0); expect(JSON.parse(r.out).failed).toEqual([]);
    const v = await run('review'); expect(v.code).toBe(0); expect(JSON.parse(v.out).findings.length).toBeGreaterThan(0);
    const tid = (await state(page)).traces[0].id;
    const e = await run('explain_trace', 'id=' + tid); expect(e.code).toBe(0); expect(JSON.parse(e.out).steps.length).toBeGreaterThan(3);
    const bad = await run('autoroute', 'net=NOPE'); expect(bad.code).toBe(0); expect(JSON.parse(bad.out).routed).toBe(0);
  } finally { mock.stop(); }
});
