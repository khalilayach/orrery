// @ts-check
// E2E tests for the TRACE Copilot (trace/chat.js + the right-hand panel in ui.js): plan vs auto mode,
// plan mode really blocks Claude's edits, chat rendering (markdown, tables, block diagrams, options),
// "Approve & build", grouped activity and the workflow stepper.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startMock } from './helpers/mock-server.js';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = pathToFileURL(resolve(ROOT, 'index.html')).href;
let mock;
test.beforeAll(async () => { mock = await startMock(); });
test.afterAll(() => mock && mock.stop());

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40)))));
async function gotoTrace(page, mode) {
  await page.addInitScript((m) => { try { if (m) localStorage.setItem('trace-mode-v1', m); else if (!sessionStorage.getItem('seeded')) { localStorage.removeItem('trace-mode-v1'); sessionStorage.setItem('seeded', '1'); } localStorage.setItem('trace-tab-v1', 'board'); } catch (_) { /* ignore */ } }, mode);
  await page.goto(PAGE + '?agents=' + mock.port + '#trace');
  await expect(page.locator('#tr')).toHaveClass(/on/, { timeout: 5000 });
  await expect(page.locator('#trst')).toContainText('connected', { timeout: 5000 });
  await settle(page);
  await page.evaluate(() => TRACE.exec('clear', {}));
}
const exec = (page, cmd, args) => page.evaluate(([c, a]) => TRACE.exec(c, a), [cmd, args]);
const state = (page) => page.evaluate(() => JSON.parse(TRACE.serialize()));
const relay = async (request, cmd, args) => (await request.post(mock.api + '/trace/cmd', { data: { token: mock.token, cmd, args } })).json();
const say = (page, text) => page.evaluate((t) => TraceChat.put('a', t), text);

test('the AI lives in a Copilot panel on the right; picking something shows its properties, Copilot tab brings the chat back', async ({ page }) => {
  await gotoTrace(page, 'auto');
  await expect(page.locator('[data-rtab="copilot"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#trpane-copilot #trlog')).toBeVisible();
  await expect(page.locator('#trpane-copilot #trin')).toBeVisible();
  await expect(page.locator('#trpane-inspect')).toBeHidden();
  await exec(page, 'place', { type: 'resistor', x: 20, y: 20 });
  await page.locator('#trsvg [data-ref="R1"]').first().click({ force: true });
  await expect(page.locator('[data-rtab="inspect"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#trinsp')).toContainText('R1');
  await page.click('[data-rtab="copilot"]');
  await expect(page.locator('#trpane-copilot')).toBeVisible();
});

test('Plan mode is the default, Auto is one click away and is remembered', async ({ page }) => {
  await gotoTrace(page);
  await expect(page.locator('.tr-mode [data-mode="plan"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#trin')).toHaveAttribute('placeholder', /plan it with you first/);
  await page.click('.tr-mode [data-mode="auto"]');
  await expect(page.locator('.tr-mode [data-mode="auto"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.tr-dock')).toHaveAttribute('data-aimode', 'auto');
  await page.reload();
  await expect(page.locator('#tr')).toHaveClass(/on/);
  await expect(page.locator('.tr-mode [data-mode="auto"]')).toHaveAttribute('aria-checked', 'true');
});

test('Plan mode really blocks Claude from editing; reading, dry-run builds and find work; Auto allows edits', async ({ page, request }) => {
  await gotoTrace(page, 'plan');
  const blocked = await relay(request, 'place', ['type=resistor', 'x=20', 'y=20']);
  expect(blocked.ok).toBe(false);
  expect(blocked.error).toMatch(/PLAN MODE — you may not change the board yet/);
  expect((await state(page)).parts.length).toBe(0);
  await expect(page.locator('#trlog')).toContainText('plan mode: held back place');
  const spec = { parts: [{ ref: 'R1', type: 'resistor' }, { ref: 'R2', type: 'resistor' }], nets: { A: ['R1.2', 'R2.1'] } };
  expect((await relay(request, 'build', { spec })).error).toMatch(/PLAN MODE/); // a real build is an edit
  const dry = await relay(request, 'build', { spec: { ...spec, dry: true } });
  expect(dry.ok).toBe(true); // a dry run only checks
  expect((await state(page)).parts.length).toBe(0);
  expect((await relay(request, 'circuit', [])).ok).toBe(true);
  expect((await relay(request, 'analyze', [])).ok).toBe(true);
  expect((await relay(request, 'undo', [])).error).toMatch(/PLAN MODE|nothing to undo/);
  await page.click('[data-mode="auto"]');
  const ok = await relay(request, 'place', ['type=resistor', 'x=20', 'y=20']);
  expect(ok.ok).toBe(true);
  expect((await state(page)).parts.length).toBe(1);
});

test('what Claude is told depends on the mode (and the reminder is not shown in your message)', async ({ page }) => {
  await gotoTrace(page, 'plan');
  const sent = [];
  await page.route('**/session/*/input', (route) => { sent.push(JSON.parse(route.request().postData() || '{}').text); route.continue(); });
  await page.fill('#trin', 'build me a sensor board');
  await page.press('#trin', 'Enter');
  await expect(page.locator('.msg.user').last()).toHaveText('build me a sensor board'); // clean bubble
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toContain('build me a sensor board');
  expect(sent[0]).toMatch(/TRACE mode: PLAN\. You may NOT edit the board/);
  await page.click('[data-mode="auto"]');
  await page.fill('#trin', 'go');
  await page.press('#trin', 'Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatch(/TRACE mode: AUTO/);
});

test('chat renders markdown: headings, bold, lists, code, links and a table; HTML is escaped', async ({ page }) => {
  await gotoTrace(page, 'auto');
  await say(page, '### Assumptions\n- Supply is **5 V** from USB\n- Load is `20 mA`\n\n### Calculations\nR = (3.3 − 2.1) / 8 mA = 150 Ω\n\n| Part | Vin | Iq |\n|---|---|---|\n| OPA1622 | 0.05 V | 4.5 mA |\n| AD8001 | 0.6 V | 140 mA |\n\nSee [the datasheet](https://example.com/ds) and <script>alert(1)</script>');
  const m = page.locator('.msg.ai').last();
  await expect(m.locator('h4.sec')).toHaveCount(2);
  await expect(m.locator('li')).toHaveCount(2);
  await expect(m.locator('li b')).toHaveText('5 V');
  await expect(m.locator('code')).toHaveText('20 mA');
  await expect(m.locator('table tbody tr')).toHaveCount(2);
  await expect(m.locator('th')).toHaveText(['Part', 'Vin', 'Iq']);
  await expect(m.locator('a')).toHaveAttribute('href', 'https://example.com/ds');
  await expect(m.locator('script')).toHaveCount(0);
  await expect(m).toContainText('<script>alert(1)</script>'); // shown as text, not executed
});

test('block diagrams: a ```diagram block becomes boxes and arrows, is remembered, and opens larger', async ({ page }) => {
  await gotoTrace(page, 'auto');
  await say(page, 'Here is the plan:\n```diagram\nSolar Cell Charger -> 5V Battery Pack\n5V Battery Pack -> 3.3V Regulator -> ATtiny Microcontroller\nAnalog Humidity Sensor -> Op Amp Buffer -> ATtiny Microcontroller\n```');
  const fig = page.locator('figure.dg');
  await expect(fig).toHaveAttribute('data-nodes', '6');
  await expect(fig.locator('[data-dnode]')).toHaveCount(6);
  await expect(fig.locator('path[marker-end]')).toHaveCount(5);
  await expect(fig.locator('[data-dnode="ATtiny Microcontroller"]')).toBeVisible();
  const ys = await fig.locator('[data-dnode] rect').evaluateAll((r) => r.map((x) => Number(x.getAttribute('y'))));
  expect(new Set(ys).size).toBeGreaterThanOrEqual(4); // flows downward in layers, not a single row
  expect((await state(page)).diagram).toMatch(/Solar Cell Charger -> 5V Battery Pack/); // saved with the board
  await page.click('[data-dgbig]');
  await expect(page.locator('#trdgmodal')).toBeVisible();
  await expect(page.locator('#trdgmodal [data-dnode]')).toHaveCount(6);
  await page.click('[data-dgclose]');
  await expect(page.locator('#trdgmodal')).toBeHidden();
  // an empty or arrow-less fence draws nothing harmful
  await say(page, '```diagram\n\n```');
  await expect(page.locator('figure.dg')).toHaveCount(1);
});

test('OPTIONS become clickable suggestions that send your choice', async ({ page }) => {
  await gotoTrace(page, 'auto');
  await say(page, 'Which op-amp do you prefer?\nOPTIONS: Verify LT6200 performance | Check OPA1622 input limits | Library op-amp search');
  const opts = page.locator('.msg.ai').last().locator('.tr-opt');
  await expect(opts).toHaveCount(3);
  await expect(page.locator('.msg.ai').last()).not.toContainText('OPTIONS:'); // the raw line is not shown
  await opts.nth(1).click();
  await expect(page.locator('.msg.user').last()).toHaveText('Check OPA1622 input limits');
  await expect(page.locator('#trlog')).toContainText('mock:TRACE received: Check OPA1622 input limits');
});

test('Plan mode: after Claude answers you get Approve & build, which switches to Auto and tells Claude to go', async ({ page }) => {
  await gotoTrace(page, 'plan');
  await page.fill('#trin', 'design a blinker');
  await page.press('#trin', 'Enter');
  await expect(page.locator('#trlog')).toContainText('mock:TRACE received: design a blinker');
  await expect(page.locator('.approve')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.approve')).toContainText('Happy with this plan?');
  await page.click('[data-approve]');
  await expect(page.locator('.tr-mode [data-mode="auto"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.msg.user').last()).toHaveText('Approved — build it now, following your plan.');
  await expect(page.locator('#trlog')).toContainText('mock:TRACE received: Approved');
  await expect(page.locator('.approve')).toHaveCount(0); // none in Auto mode
});

test('tool and result lines collapse into one "Working" group; the next message closes it', async ({ page }) => {
  await gotoTrace(page, 'auto');
  await page.evaluate(() => { TraceChat.put('t', '▸ Bash: build file=design.json'); TraceChat.put('r', '⌁ build → ok'); TraceChat.put('t', '▸ Bash: circuit'); });
  const groups = page.locator('details.act');
  await expect(groups).toHaveCount(1);
  await expect(groups.locator('summary')).toContainText('3 steps');
  await expect(groups.locator('.lines div')).toHaveCount(3);
  await say(page, 'Done.');
  await page.evaluate(() => TraceChat.put('t', '▸ Bash: drc'));
  await expect(groups).toHaveCount(2); // a new message started a new group
  await page.evaluate(() => TraceChat.turnDone());
  await expect(groups.last()).toHaveClass(/fin/);
});

test('workflow stepper follows the design: Architecture → Schematic → Research → Layout → Review', async ({ page }) => {
  await gotoTrace(page, 'auto');
  const st = () => page.locator('.tr-steps .step').evaluateAll((b) => b.map((x) => x.classList.contains('done') ? 'done' : x.classList.contains('current') ? 'current' : 'todo'));
  expect(await st()).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
  await say(page, '```diagram\nA -> B\n```');
  await settle(page);
  expect(await st()).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
  await exec(page, 'build', { spec: { replace: true, parts: [{ ref: 'J1', type: 'usbc' }, { ref: 'R1', type: 'resistor', value: '1k' }], nets: { VBUS: ['J1.VBUS', 'R1.1'], GND: ['J1.GND', 'R1.2'] } } });
  await settle(page);
  expect(await st()).toEqual(['done', 'done', 'current', 'todo', 'todo']);
  await exec(page, 'source', { ref: 'J1', mpn: 'TYPE-C', id: 'C1', price: 0.2 });
  await exec(page, 'source', { ref: 'R1', mpn: 'RX', id: 'C2', price: 0.01 });
  await settle(page);
  expect(await st()).toEqual(['done', 'done', 'done', 'current', 'todo']);
  await exec(page, 'route', { from: 'J1.VBUS', to: 'R1.1', points: '60:30' }).catch(() => {});
  // clicking a step takes you there
  await page.click('[data-step="sch"]');
  await expect(page.locator('#trgraph')).toBeVisible();
  await page.click('[data-vtab="board"]');
  await page.click('[data-step="lay"]');
  await expect(page.locator('#trstage')).toBeVisible();
  await page.click('[data-step="arch"]');
  await expect(page.locator('.msg.user').last()).toContainText('architecture');
});

test('composer: Enter sends, Shift+Enter makes a new line, slash commands still run offline-style', async ({ page }) => {
  await gotoTrace(page, 'auto');
  await page.fill('#trin', 'line one');
  await page.press('#trin', 'Shift+Enter');
  await page.keyboard.type('line two');
  expect(await page.inputValue('#trin')).toBe('line one\nline two');
  await page.press('#trin', 'Enter');
  await expect(page.locator('.msg.user').last()).toContainText('line one');
  expect(await page.inputValue('#trin')).toBe('');
  await page.fill('#trin', '/place type=capacitor x=25 y=20');
  await page.press('#trin', 'Enter');
  expect((await state(page)).parts.map((p) => p.type)).toEqual(['capacitor']);
  await page.click('.tr-chip >> nth=0'); // a starter suggestion sends itself
  await expect(page.locator('.msg.user').last()).toContainText('Design a USB-powered');
  await page.fill('#trin', 'via the button');
  await page.click('#trsend');
  await expect(page.locator('.msg.user').last()).toHaveText('via the button');
});
