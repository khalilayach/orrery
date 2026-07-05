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

test('swarm: @name routes between terminals and the target agent responds', async ({ page }) => {
  await gotoWired(page);
  await page.click('#wsspawn');
  await expect(page.locator('.ws-win')).toHaveCount(2);
  const w1 = page.locator('.ws-win').nth(0), w2 = page.locator('.ws-win').nth(1);
  await expect(w2.locator('.ws-term')).toContainText('connected ·', { timeout: 5000 });
  const n1 = (await w1.locator('.ws-name').textContent()).trim();
  const n2 = (await w2.locator('.ws-name').textContent()).trim();
  await typeIn(page, w1, `@${n2} start on the parser`);
  await expect(w1.locator('.ws-term')).toContainText('sent to ' + n2);
  await expect(w2.locator('.ws-term')).toContainText(`⇄ ${n1}: start on the parser`);
  // the message became a real turn for the target agent
  await expect(w2.locator('.ws-term')).toContainText(`[swarm message from ${n1}] start on the parser`);
});

test('swarm: @all fans out to every other terminal', async ({ page }) => {
  await gotoWired(page);
  await page.click('#wsspawn');
  await page.click('#wsspawn');
  await expect(page.locator('.ws-win')).toHaveCount(3);
  const w1 = page.locator('.ws-win').nth(0);
  await typeIn(page, w1, '@all status report');
  for (const i of [1, 2]) {
    await expect(page.locator('.ws-win').nth(i).locator('.ws-term'))
      .toContainText('status report', { timeout: 5000 });
  }
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
