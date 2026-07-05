// @ts-check
// E2E tests for the real-Claude terminal backend (server/agent-server.mjs).
// Playwright's webServer starts it in MOCK_CLAUDE mode on :57312, so these are
// deterministic and make no API calls. The page is pointed at the mock server
// via the ?agents=<port> query param.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve, basename } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;
const API = 'http://127.0.0.1:57312';
const ROOT = resolve(import.meta.dirname, '..');

/** Open the workspace wired to the mock agent server. */
async function gotoWired(page) {
  await page.goto(PAGE + '?agents=57312#orch1');
  await expect(page.locator('#ws')).toHaveClass(/on/, { timeout: 5000 });
  // seeded window is connected once the hello event lands
  await expect(page.locator('.ws-term').first()).toContainText('connected ·', { timeout: 5000 });
}

async function typeIn(page, win, text) {
  const input = win.locator('.ws-input input');
  await input.fill(text);
  await input.press('Enter');
}

// ---------- server API ----------

test('server: health reports mock mode', async ({ request }) => {
  const r = await (await request.get(API + '/health')).json();
  expect(r.ok).toBe(true);
  expect(r.mock).toBe(true);
});

test('server: rejects foreign origins and bad swarm tokens', async ({ request }) => {
  const evil = await request.post(API + '/session', {
    headers: { origin: 'https://evil.example' }, data: { name: 'Mallory' },
  });
  expect(evil.status()).toBe(403);
  const bad = await request.post(API + '/swarm/send', {
    data: { token: 'wrong', from: 'x', to: 'all', text: 'hax' },
  });
  expect(bad.status()).toBe(403);
});

test('server: session create resolves a usable cwd', async ({ request }) => {
  const s = await (await request.post(API + '/session', { data: { name: 'ApiTest' } })).json();
  expect(s.id).toBeTruthy();
  expect(s.cwd).toBe(ROOT); // defaults to the repo root
  await request.delete(API + '/session/' + s.id);
});

// ---------- terminal UI ----------

test('typing in a terminal streams back a real reply', async ({ page }) => {
  await gotoWired(page);
  const win = page.locator('.ws-win').first();
  await typeIn(page, win, 'hello agent');
  await expect(win.locator('.ws-term')).toContainText('› hello agent');
  await expect(win.locator('.ws-term')).toContainText(/mock:\w+ received: hello agent/);
});

test('cd points the terminal at any folder; bad paths are rejected', async ({ page }) => {
  const dir = mkdtempSync(resolve(tmpdir(), 'orrery-cd-'));
  const leaf = basename(dir);
  await gotoWired(page);
  const win = page.locator('.ws-win').first();
  await typeIn(page, win, 'cd ' + dir.replaceAll('\\', '/'));
  await expect(win.locator('.ws-term')).toContainText('cwd → ');
  await expect(win.locator('.ws-term')).toContainText(leaf);
  await typeIn(page, win, 'pwd');
  await expect(win.locator('.ws-term .m').last()).toContainText(leaf);
  await typeIn(page, win, 'cd ./definitely/not/a/real/dir');
  await expect(win.locator('.ws-term')).toContainText('no such directory');
});

/** Spawn a second window, park it clear of the first, return [w1, w2]. */
async function twoTerminals(page) {
  await page.click('#wsspawn');
  await expect(page.locator('.ws-win')).toHaveCount(2);
  const w1 = page.locator('.ws-win').nth(0), w2 = page.locator('.ws-win').nth(1);
  await expect(w2.locator('.ws-term')).toContainText('connected ·', { timeout: 5000 });
  await page.evaluate(() => {
    const w = document.querySelectorAll('.ws-win')[1];
    w.style.left = '660px'; w.style.top = '60px';
  });
  return [w1, w2];
}

/** Create a link server-side using the windows' session ids. */
async function apiLink(page, fromIdx, toIdx, type) {
  await page.evaluate(async ({ fromIdx, toIdx, type }) => {
    const wins = document.querySelectorAll('.ws-win');
    await fetch('http://127.0.0.1:57312/link', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: wins[fromIdx].dataset.sid, to: wins[toIdx].dataset.sid, type }),
    });
  }, { fromIdx, toIdx, type });
}

test('unlinked terminals cannot message each other', async ({ page }) => {
  await gotoWired(page);
  const [w1, w2] = await twoTerminals(page);
  const n2 = (await w2.locator('.ws-name').textContent()).trim();
  await typeIn(page, w1, `@${n2} psst`);
  await expect(w1.locator('.ws-term')).toContainText('not linked to ' + n2);
  await expect(w2.locator('.ws-term')).not.toContainText('psst');
});

test('dragging the comm dot wires two terminals; @name then routes; clicking the line unwires', async ({ page }) => {
  await gotoWired(page);
  const [w1, w2] = await twoTerminals(page);
  const n1 = (await w1.locator('.ws-name').textContent()).trim();
  const n2 = (await w2.locator('.ws-name').textContent()).trim();
  // drag the blue comm dot from w1 onto w2 → a wire appears
  const pb = await w1.locator('.ws-port[data-type="comm"]').boundingBox();
  const tb = await w2.boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#wslinks path.vis')).toHaveCount(1);
  await expect(w1.locator('.ws-term')).toContainText('linked: can now message ' + n2);
  // linked → routing works
  await typeIn(page, w1, `@${n2} start on the parser`);
  await expect(w1.locator('.ws-term')).toContainText('sent to ' + n2);
  await expect(w2.locator('.ws-term')).toContainText(`⇄ ${n1}: start on the parser`);
  await expect(w2.locator('.ws-term')).toContainText(`[swarm message from ${n1}] start on the parser`);
  // clicking the wire removes it and messaging is gated again
  await page.locator('#wslinks path.hit').click();
  await expect(page.locator('#wslinks path.vis')).toHaveCount(0);
  await typeIn(page, w1, `@${n2} again?`);
  await expect(w1.locator('.ws-term')).toContainText('not linked to ' + n2);
});

test('boss link: messages arrive as operator instructions', async ({ page }) => {
  await gotoWired(page);
  const [w1, w2] = await twoTerminals(page);
  const n1 = (await w1.locator('.ws-name').textContent()).trim();
  const n2 = (await w2.locator('.ws-name').textContent()).trim();
  await apiLink(page, 0, 1, 'boss');
  await typeIn(page, w1, `@${n2} refactor the parser and report back`);
  await expect(w2.locator('.ws-term')).toContainText(`⚑ order from ${n1}`);
  await expect(w2.locator('.ws-term')).toContainText(`[instruction from your manager ${n1}] refactor the parser`);
});

test('swarm: @all fans out to every linked terminal', async ({ page }) => {
  await gotoWired(page);
  await page.click('#wsspawn');
  await page.click('#wsspawn');
  await expect(page.locator('.ws-win')).toHaveCount(3);
  await expect(page.locator('.ws-win').nth(2).locator('.ws-term')).toContainText('connected ·', { timeout: 5000 });
  await apiLink(page, 0, 1, 'comm');
  await apiLink(page, 0, 2, 'comm');
  const w1 = page.locator('.ws-win').nth(0);
  await typeIn(page, w1, '@all status report');
  for (const i of [1, 2]) {
    await expect(page.locator('.ws-win').nth(i).locator('.ws-term'))
      .toContainText('status report', { timeout: 5000 });
  }
});

test('read link gates transcript access', async ({ request }) => {
  const token = (await (await request.get(API + '/health')).json()).token;
  const a = await (await request.post(API + '/session', { data: { name: 'ReaderA' } })).json();
  const b = await (await request.post(API + '/session', { data: { name: 'ReadeeB' } })).json();
  await request.post(API + '/session/' + b.id + '/input', { data: { text: 'hello transcript' } });
  // no link yet → forbidden
  const denied = await request.get(`${API}/swarm/read?token=${token}&from=ReaderA&target=ReadeeB`);
  expect(denied.status()).toBe(403);
  await request.post(API + '/link', { data: { from: a.id, to: b.id, type: 'read' } });
  await expect.poll(async () => {
    const r = await (await request.get(`${API}/swarm/read?token=${token}&from=ReaderA&target=ReadeeB`)).json();
    return r.transcript.join('\n');
  }).toContain('mock:ReadeeB received: hello transcript'); // mock reply lands ~60ms after input
  const r = await (await request.get(`${API}/swarm/read?token=${token}&from=ReaderA&target=ReadeeB`)).json();
  expect(r.transcript.join('\n')).toContain('user: hello transcript');
  // read link does NOT grant messaging
  const send = await request.post(API + '/swarm/send', {
    data: { token, from: 'ReaderA', to: 'ReadeeB', text: 'should be blocked' },
  });
  expect(send.status()).toBe(403);
  await request.delete(API + '/session/' + a.id);
  await request.delete(API + '/session/' + b.id);
});

test('offline: terminal degrades gracefully when no server is running', async ({ page }) => {
  await page.goto(PAGE + '?agents=59999#orch1'); // nothing listens there
  await expect(page.locator('#ws')).toHaveClass(/on/, { timeout: 5000 });
  await expect(page.locator('.ws-term').first())
    .toContainText('agent server offline', { timeout: 5000 });
});

test('closing a terminal deletes its server session', async ({ page, request }) => {
  await gotoWired(page);
  const before = (await (await request.get(API + '/sessions')).json()).length;
  await page.click('#wsspawn');
  await expect(page.locator('.ws-win')).toHaveCount(2);
  await expect(page.locator('.ws-win').nth(1).locator('.ws-term')).toContainText('connected ·');
  await page.locator('.ws-win').nth(1).locator('.ws-x').click();
  await expect(page.locator('.ws-win')).toHaveCount(1);
  await expect.poll(async () =>
    (await (await request.get(API + '/sessions')).json()).length
  ).toBe(before);
});
