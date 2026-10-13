// @ts-check
// E2E tests for LUMEN, the image / GIF / video studio constellation (index.html + lumen/).
// Covers: constellation routing, the command API (LUMEN.exec), real-pointer tools (move, resize,
// shape, text, brush, eraser, crop, wand), layers panel, properties, timeline animation,
// every exporter (PNG/JPG/WEBP/GIF/WebM/PDF), emoji + clipboard paste, autosave, and the Claude bridge.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { startMock } from './helpers/mock-server.js';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
const frames = (page, n = 2) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? setTimeout(r, 30) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function gotoLumen(page, qs = '?agents=57312&nodialog') {
  await page.goto(PAGE + qs + '#lumen');
  await expect(page.locator('#lm')).toHaveClass(/on/, { timeout: 5000 });
  await frames(page);
}
const exec = (page, cmd, args = {}) => page.evaluate(([c, a]) => LUMEN.exec(c, a), [cmd, args]);
const layers = (page) => page.evaluate(() => LUMEN.describe().layers);
/** a fresh blank 1000×600 canvas, white, fitted to the stage */
async function blank(page, w = 1000, h = 600, bg = '#ffffff') {
  await exec(page, 'new', { w, h, bg });
  await page.click('#lmfit');
  await frames(page);
}
/** doc px → client px, from the live (transformed) board rect */
async function at(page, x, y) {
  return page.evaluate(([x, y]) => {
    const r = document.getElementById('lmboard').getBoundingClientRect(), k = r.width / LUMEN.w;
    return { x: r.left + x * k, y: r.top + y * k };
  }, [x, y]);
}
async function drag(page, a, b, steps = 8) {
  const p = await at(page, a[0], a[1]), q = await at(page, b[0], b[1]);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps }); await page.mouse.up();
  await frames(page);
}
async function click(page, x, y) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); await frames(page); }
/** a data URL: red field with a green square in the middle */
const redGreen = (page) => page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 100; const x = c.getContext('2d');
  x.fillStyle = '#ff0000'; x.fillRect(0, 0, 200, 100); x.fillStyle = '#00ff00'; x.fillRect(80, 30, 40, 40);
  return c.toDataURL('image/png');
});
const pixel = (page, x, y) => page.evaluate(([x, y]) => LUMEN.pixel(x, y), [x, y]);

test.describe('routing', () => {
  test('boots without errors and LUMEN is a constellation in the manifest', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(PAGE + '?agents=57312');
    await page.click('#skip');
    await page.waitForTimeout(600);
    const t = await page.evaluate(() => MANIFEST.projects.find((p) => p.id === 'lumen'));
    expect(t.name).toBe('LUMEN');
    expect(t.nodes.length).toBeGreaterThan(2);
    expect(errors).toEqual([]);
  });

  test('clicking the LUMEN constellation dives into the studio; Esc closes it', async ({ page }) => {
    await page.goto(PAGE + '?agents=57312&nodialog');
    await page.click('#skip');
    await expect.poll(() => page.evaluate(() => boot.done)).toBe(true);
    const at2 = await page.evaluate(() => { const p = MANIFEST.projects.find((q) => q.id === 'lumen'); const [sx, sy] = worldScreen(p); return { x: sx / dpr, y: sy / dpr }; });
    await page.mouse.move(at2.x, at2.y);
    await page.mouse.click(at2.x, at2.y);
    await expect(page.locator('#lm')).toHaveClass(/on/, { timeout: 5000 });
    expect(await page.evaluate(() => lmOpen)).toBe(true);
    expect(await page.evaluate(() => location.hash)).toBe('#lumen');
    await page.keyboard.press('Escape');
    await expect(page.locator('#lm')).not.toHaveClass(/on/);
    expect(await page.evaluate(() => lmOpen)).toBe(false);
  });

  test('first open shows the New project dialog; a preset creates a canvas of that size', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(PAGE + '?agents=57312#lumen');
    await expect(page.locator('#lm')).toHaveClass(/on/, { timeout: 5000 });
    await expect(page.locator('.lm-dialog h2')).toHaveText('New project');
    await page.click('.lm-preset[data-p="billboard"]');
    expect(await page.inputValue('#nw')).toBe('6000');
    await page.click('#ncreate');
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([6000, 2000]);
    await expect(page.locator('#lmmodal')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Esc closes a modal before it closes the studio', async ({ page }) => {
    await gotoLumen(page);
    await page.click('#lmnew');
    await expect(page.locator('#lmmodal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#lmmodal')).toBeHidden();
    expect(await page.evaluate(() => lmOpen)).toBe(true);
  });
});

test.describe('command API', () => {
  test('new, add_text, add_shape, set, delete', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    const tid = await exec(page, 'add_text', { text: 'Hello', size: 80, color: '#ff0000' });
    const sid = await exec(page, 'add_shape', { shape: 'ellipse', w: 200, h: 100, x: 10, y: 10, fill: '#0000ff' });
    let l = await layers(page);
    expect(l.map((x) => x.type)).toEqual(['shape', 'text']); // top first
    expect(l[1]).toMatchObject({ id: tid, text: 'Hello', size: 80, color: '#ff0000' });
    expect(l[0]).toMatchObject({ id: sid, shape: 'ellipse', x: 10, y: 10, w: 200, h: 100 });
    await exec(page, 'set', { id: sid, x: '50', opacity: '0.5', blend: 'multiply', rot: 30 }); // CLI-style strings
    l = await layers(page);
    expect(l[0]).toMatchObject({ x: 50, opacity: 0.5, blend: 'multiply', rot: 30 });
    await exec(page, 'delete', { id: tid });
    expect((await layers(page)).length).toBe(1);
  });

  test('layers can be addressed by name; unknown layer and command error clearly', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await exec(page, 'add_shape', { name: 'Badge', x: 0, y: 0 });
    await exec(page, 'set', { id: 'Badge', x: 123 });
    expect((await layers(page))[0].x).toBe(123);
    const e1 = await page.evaluate(() => { try { LUMEN.exec('set', { id: 'nope', x: 1 }); } catch (e) { return e.message; } });
    expect(e1).toContain('no such layer');
    const e2 = await page.evaluate(() => { try { LUMEN.exec('frobnicate'); } catch (e) { return e.message; } });
    expect(e2).toContain('unknown command');
  });

  test('undo / redo walks back through edits, including pixels', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100);
    await exec(page, 'add_shape', { shape: 'rect', x: 0, y: 0, w: 200, h: 100, fill: '#ff0000' });
    expect((await pixel(page, 100, 50)).hex).toBe('#ff0000');
    await exec(page, 'set', { fill: '#0000ff' });
    expect((await pixel(page, 100, 50)).hex).toBe('#0000ff');
    await exec(page, 'undo');
    expect((await pixel(page, 100, 50)).hex).toBe('#ff0000');
    await exec(page, 'redo');
    expect((await pixel(page, 100, 50)).hex).toBe('#0000ff');
    await exec(page, 'undo'); await exec(page, 'undo');
    expect((await layers(page)).length).toBe(0);
  });

  test('duplicate, reorder, align, fit', async ({ page }) => {
    await gotoLumen(page); await blank(page, 1000, 600);
    const a = await exec(page, 'add_shape', { name: 'A', w: 100, h: 100, x: 0, y: 0 });
    await exec(page, 'add_shape', { name: 'B', w: 100, h: 100, x: 0, y: 0 });
    await exec(page, 'reorder', { id: a, dir: 'top' });
    expect((await layers(page)).map((x) => x.name)).toEqual(['A', 'B']);
    await exec(page, 'align', { id: a, to: 'center' });
    expect(await page.evaluate((id) => { const L = LUMEN.L(id); return [L.x, L.y]; }, a)).toEqual([450, 250]);
    await exec(page, 'align', { id: a, to: 'right' });
    expect(await page.evaluate((id) => LUMEN.L(id).x, a)).toBe(900);
    await exec(page, 'fit', { id: a, mode: 'contain' });
    expect(await page.evaluate((id) => LUMEN.L(id).h, a)).toBe(600);
    await exec(page, 'duplicate', { id: a });
    const names = (await layers(page)).map((x) => x.name);
    expect(names[0]).toBe('A copy');
  });

  test('add_image sizes to the canvas; remove_bg erases the background but keeps the subject', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 200, 'transparent');
    const src = await redGreen(page);
    const id = await page.evaluate((s) => LUMEN.exec('add_image', { src: s, fit: 'contain', name: 'photo' }), src);
    const l = (await layers(page))[0];
    expect(l).toMatchObject({ id, type: 'image', name: 'photo', w: 200, h: 100 }); // not upscaled past natural size
    expect((await pixel(page, 200, 100)).hex).toBe('#00ff00');
    const before = await pixel(page, 110, 60); expect(before.hex).toBe('#ff0000');
    const r = await exec(page, 'remove_bg', { id, tol: 10 });
    expect(r.erasedPixels).toBeGreaterThan(15000);
    expect((await pixel(page, 110, 60)).a).toBe(0);      // red background gone
    expect((await pixel(page, 200, 100)).hex).toBe('#00ff00'); // green subject intact
  });

  test('crop shifts layers and canvas_size can scale content', async ({ page }) => {
    await gotoLumen(page); await blank(page, 1000, 600);
    await exec(page, 'add_shape', { name: 'S', x: 500, y: 300, w: 100, h: 100 });
    await exec(page, 'crop', { x: 400, y: 200, w: 400, h: 300 });
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([400, 300]);
    expect(await page.evaluate(() => { const L = LUMEN.L('S'); return [L.x, L.y]; })).toEqual([100, 100]);
    await exec(page, 'canvas_size', { w: 800, h: 600, scale: true });
    expect(await page.evaluate(() => { const L = LUMEN.L('S'); return [L.x, L.w]; })).toEqual([200, 200]);
  });

  test('flatten and merge_down rasterize into a single image layer', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100);
    await exec(page, 'add_shape', { name: 'one', x: 0, y: 0, w: 100, h: 100, fill: '#ff0000' });
    await exec(page, 'add_shape', { name: 'two', x: 100, y: 0, w: 100, h: 100, fill: '#0000ff' });
    await exec(page, 'flatten');
    const l = await layers(page);
    expect(l.length).toBe(1);
    expect(l[0].type).toBe('image');
    expect((await pixel(page, 50, 50)).hex).toBe('#ff0000');
    expect((await pixel(page, 150, 50)).hex).toBe('#0000ff');
  });

  test('adjust filters change rendered pixels; blend modes apply', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100, '#808080');
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 100, h: 100, fill: '#ff0000' });
    await exec(page, 'adjust', { id, gray: 100 });
    const g = await pixel(page, 50, 50);
    expect(Math.abs(g.r - g.g)).toBeLessThan(3); // fully grey
    await exec(page, 'adjust', { id, gray: 0, invert: 100 });
    expect((await pixel(page, 50, 50)).hex).toBe('#00ffff');
    await exec(page, 'adjust', { id, invert: 0 });
    await exec(page, 'set', { id, blend: 'multiply' });
    const m = await pixel(page, 50, 50); // red × grey
    expect(m.r).toBeGreaterThan(100); expect(m.g).toBeLessThan(5);
  });

  test('rotation and flip move rendered pixels', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200);
    const id = await exec(page, 'add_shape', { x: 0, y: 90, w: 200, h: 20, fill: '#000000' });
    await exec(page, 'set', { id, rot: 90 });
    expect((await pixel(page, 100, 5)).hex).toBe('#000000'); // bar is now vertical
    expect((await pixel(page, 5, 100)).hex).toBe('#ffffff');
  });

  test('text layers hug their text; emoji render as pixels; size scales the box', async ({ page }) => {
    await gotoLumen(page); await blank(page, 600, 300);
    const id = await exec(page, 'add_text', { text: '🔥', size: 100, x: 100, y: 50 });
    const a = (await layers(page))[0];
    expect(a.w).toBeGreaterThan(40);
    const c = await page.evaluate(() => { const c = LUMEN.renderToCanvas(1); const d = c.getContext('2d').getImageData(100, 50, 200, 120).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255) n++; return n; });
    expect(c).toBeGreaterThan(300);
    await exec(page, 'set', { id, size: 200 });
    expect((await layers(page))[0].w).toBeGreaterThan(a.w * 1.5);
  });

  test('describe() / state is JSON-safe and lists top layer first', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await exec(page, 'add_shape', { name: 'bottom' }); await exec(page, 'add_text', { text: 'top' });
    const s = await exec(page, 'state');
    expect(s.canvas).toMatchObject({ w: 1000, h: 600 });
    expect(s.layers.map((l) => l.name)).toEqual(['top', 'bottom']);
    const h = await exec(page, 'help');
    expect(Object.keys(h.commands)).toEqual(expect.arrayContaining(['add_text', 'remove_bg', 'animate', 'export']));
  });
});

test.describe('tools with a real pointer', () => {
  test('toolbox buttons and keyboard shortcuts switch tools', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.click('[data-tool="brush"]');
    await expect(page.locator('[data-tool="brush"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#obs')).toBeVisible();
    for (const [key, tool] of [['v', 'move'], ['t', 'text'], ['u', 'shape'], ['e', 'eraser'], ['c', 'crop'], ['w', 'wand'], ['h', 'hand']]) {
      await page.keyboard.press(key);
      await expect(page.locator(`[data-tool="${tool}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('shape tool: dragging creates a shape of that size; Shift squares it', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.keyboard.press('u');
    await drag(page, [100, 100], [300, 220]);
    let l = (await layers(page))[0];
    expect(l.type).toBe('shape');
    expect(Math.abs(l.w - 200)).toBeLessThan(3); expect(Math.abs(l.h - 120)).toBeLessThan(3);
    expect(Math.abs(l.x - 100)).toBeLessThan(3);
    await expect(page.locator('[data-tool="move"]')).toHaveAttribute('aria-pressed', 'true'); // returns to move
    await page.keyboard.press('u');
    await page.keyboard.down('Shift');
    await drag(page, [500, 100], [700, 160]);
    await page.keyboard.up('Shift');
    l = (await layers(page))[0];
    expect(Math.abs(l.w - l.h)).toBeLessThan(2);
  });

  test('text tool: click adds a text layer and focuses its content box', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.keyboard.press('t');
    await click(page, 200, 150);
    const l = (await layers(page))[0];
    expect(l).toMatchObject({ type: 'text', text: 'Text' });
    await expect(page.locator('#ptext')).toBeFocused();
    await page.keyboard.type('Billboard 🚀');
    expect((await layers(page))[0].text).toBe('Billboard 🚀');
    await page.keyboard.press('Tab');
    expect((await layers(page))[0].name).toBe('Billboard 🚀');
  });

  test('move tool: click selects the top layer; drag moves it; arrows nudge; Del deletes', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    const a = await exec(page, 'add_shape', { name: 'A', x: 100, y: 100, w: 200, h: 200, fill: '#ff0000' });
    const b = await exec(page, 'add_shape', { name: 'B', x: 200, y: 200, w: 200, h: 200, fill: '#0000ff' });
    await exec(page, 'select', { id: null });
    await click(page, 250, 250); // overlap → topmost (B)
    expect(await page.evaluate(() => LUMEN.sel)).toBe(b);
    await click(page, 120, 120); // only A
    expect(await page.evaluate(() => LUMEN.sel)).toBe(a);
    await drag(page, [150, 150], [250, 180]);
    const A = await page.evaluate((id) => { const L = LUMEN.L(id); return [L.x, L.y]; }, a);
    expect(Math.abs(A[0] - 200)).toBeLessThan(8); expect(Math.abs(A[1] - 130)).toBeLessThan(8);
    await page.keyboard.press('Shift+ArrowRight');
    expect(await page.evaluate((id) => LUMEN.L(id).x, a)).toBe(A[0] + 10);
    await page.keyboard.press('Delete');
    expect((await layers(page)).map((x) => x.name)).toEqual(['B']);
    await page.keyboard.press('Control+z');
    expect((await layers(page)).length).toBe(2);
  });

  test('clicking a transparent pixel of an image selects what is behind it', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 200);
    const back = await exec(page, 'add_shape', { name: 'back', x: 0, y: 0, w: 400, h: 200 });
    const src = await redGreen(page);
    const img = await page.evaluate((s) => LUMEN.exec('add_image', { src: s, fit: 'none' }), src);
    await exec(page, 'remove_bg', { id: img, tol: 10 });
    await exec(page, 'select', { id: null });
    await click(page, 120, 80); // inside the image box but on erased red
    expect(await page.evaluate(() => LUMEN.sel)).toBe(back);
    await click(page, 200, 100); // green subject
    expect(await page.evaluate(() => LUMEN.sel)).toBe(img);
  });

  test('resize handle (proportional corner) and rotate handle', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    const id = await exec(page, 'add_shape', { x: 300, y: 200, w: 200, h: 100 });
    await exec(page, 'select', { id });
    await frames(page);
    await drag(page, [500, 300], [600, 350]); // SE corner: +100 px wide → proportional
    let L = await page.evaluate((i) => { const l = LUMEN.L(i); return { x: l.x, y: l.y, w: l.w, h: l.h }; }, id);
    expect(L.x).toBe(300); expect(L.y).toBe(200);
    expect(Math.abs(L.w / L.h - 2)).toBeLessThan(0.05);
    expect(L.w).toBeGreaterThan(270);
    // rotate: handle sits 28 screen px above the top edge centre
    const k = await page.evaluate(() => { const r = document.getElementById('lmboard').getBoundingClientRect(); return r.width / LUMEN.w; });
    const top = { x: L.x + L.w / 2, y: L.y - 28 / k };
    const to = { x: L.x + L.w / 2 + 200, y: L.y + L.h / 2 };
    await drag(page, [top.x, top.y], [to.x, to.y], 12);
    L = await page.evaluate((i) => LUMEN.L(i).rot, id);
    expect(Math.abs(L - 90)).toBeLessThan(6);
  });

  test('west edge handle resizes from the right edge fixed', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    const id = await exec(page, 'add_shape', { x: 300, y: 200, w: 200, h: 100 });
    await exec(page, 'select', { id }); await frames(page);
    await drag(page, [300, 250], [200, 250]);
    const L = await page.evaluate((i) => { const l = LUMEN.L(i); return { x: l.x, w: l.w, h: l.h }; }, id);
    expect(L.x + L.w).toBe(500); expect(L.w).toBeGreaterThan(280); expect(L.h).toBe(100);
  });

  test('brush paints on a new paint layer; eraser removes; [ ] resize the brush', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 200);
    await page.keyboard.press('b');
    await page.fill('#obs', '30'); await page.fill('#obh', '100');
    await page.evaluate(() => { const i = document.getElementById('lmfg'); i.value = '#ff0000'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await drag(page, [50, 100], [350, 100]);
    let l = await layers(page);
    expect(l[0]).toMatchObject({ type: 'draw', name: 'Paint' });
    expect((await pixel(page, 200, 100)).hex).toBe('#ff0000');
    expect((await pixel(page, 200, 160)).hex).toBe('#ffffff');
    await page.keyboard.press('e');
    await page.fill('#obs', '40'); await page.fill('#obh', '100');
    await drag(page, [150, 100], [250, 100]);
    expect((await pixel(page, 200, 100)).hex).toBe('#ffffff');
    expect((await pixel(page, 80, 100)).hex).toBe('#ff0000');
    await page.keyboard.press('Control+z');
    expect((await pixel(page, 200, 100)).hex).toBe('#ff0000'); // erase undone
    await page.keyboard.press('b'); await page.keyboard.press(']');
    expect(Number(await page.inputValue('#obs'))).toBeGreaterThan(30);
  });

  test('brush on an image layer paints that layer; eraser cuts it', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100, 'transparent');
    const src = await redGreen(page);
    const id = await page.evaluate((s) => LUMEN.exec('add_image', { src: s, fit: 'none' }), src);
    await page.keyboard.press('e');
    await page.fill('#obs', '30'); await page.fill('#obh', '100');
    await drag(page, [20, 20], [60, 20]);
    expect((await pixel(page, 40, 20)).a).toBe(0);
    expect((await layers(page)).filter((x) => x.type === 'image').length).toBe(1);
    expect(id).toBeTruthy();
  });

  test('remove-colour tool erases a clicked colour region', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100, 'transparent');
    const src = await redGreen(page);
    await page.evaluate((s) => LUMEN.exec('add_image', { src: s, fit: 'none' }), src);
    await page.keyboard.press('k');
    await click(page, 10, 10);
    expect((await pixel(page, 10, 10)).a).toBe(0);
    expect((await pixel(page, 100, 50)).hex).toBe('#00ff00');
  });

  test('eyedropper picks the composited colour into the foreground swatch', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100, '#336699');
    await page.keyboard.press('i');
    await click(page, 100, 50);
    expect(await page.inputValue('#lmfg')).toBe('#336699');
  });

  test('crop tool: drag a region, Enter applies it; Esc cancels', async ({ page }) => {
    await gotoLumen(page); await blank(page, 1000, 600);
    await page.keyboard.press('c');
    await drag(page, [100, 100], [500, 400]);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([1000, 600]); // cancelled
    await drag(page, [100, 100], [500, 400]);
    await page.keyboard.press('Enter');
    const [w, h] = await page.evaluate(() => [LUMEN.w, LUMEN.h]);
    expect(Math.abs(w - 400)).toBeLessThan(4); expect(Math.abs(h - 300)).toBeLessThan(4);
  });

  test('hand tool and Space pan the view; wheel with Ctrl zooms; Fit restores', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    const rect = () => page.evaluate(() => document.getElementById('lmboard').getBoundingClientRect().toJSON());
    const r0 = await rect();
    await page.keyboard.press('h');
    const s = await page.locator('#lmstage').boundingBox();
    await page.mouse.move(s.x + 300, s.y + 200); await page.mouse.down(); await page.mouse.move(s.x + 360, s.y + 230, { steps: 4 }); await page.mouse.up();
    const r1 = await rect();
    expect(Math.round(r1.x - r0.x)).toBe(60); expect(Math.round(r1.y - r0.y)).toBe(30);
    await page.keyboard.press('v');
    await page.mouse.move(s.x + 400, s.y + 250);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control');
    await frames(page);
    expect((await rect()).width).toBeGreaterThan(r1.width * 1.05);
    await page.click('#lmfit');
    expect(Math.abs((await rect()).width - r0.width)).toBeLessThan(2);
  });
});

test.describe('panels', () => {
  test('layers panel: select, hide, lock, rename, reorder, duplicate, delete', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await exec(page, 'add_shape', { name: 'One' }); await exec(page, 'add_shape', { name: 'Two' });
    const rows = page.locator('.lm-layer');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.nm')).toHaveText('Two'); // top first
    await rows.nth(1).click();
    await expect(rows.nth(1)).toHaveClass(/act/);
    await rows.nth(1).locator('[data-act="vis"]').click();
    expect((await layers(page)).find((l) => l.name === 'One').visible).toBe(false);
    await page.locator('.lm-layer', { hasText: 'One' }).locator('[data-act="lock"]').click();
    expect((await layers(page)).find((l) => l.name === 'One').locked).toBe(true);
    await rows.nth(1).locator('.nm').dblclick();
    await page.keyboard.type(' renamed'); await page.keyboard.press('Enter');
    expect((await layers(page)).map((l) => l.name)).toContain('One renamed');
    await page.click('#lmup');
    expect((await layers(page))[0].name).toBe('One renamed');
    await page.click('#lmdup');
    expect((await layers(page))[0].name).toBe('One renamed copy');
    await page.click('#lmdel');
    expect((await layers(page)).length).toBe(2);
    await page.click('#lmadd');
    expect((await layers(page))[0].type).toBe('draw');
  });

  test('layers panel: drag a row onto another reorders', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await exec(page, 'add_shape', { name: 'One' }); await exec(page, 'add_shape', { name: 'Two' });
    await page.locator('.lm-layer', { hasText: 'One' }).dragTo(page.locator('.lm-layer', { hasText: 'Two' }));
    expect((await layers(page)).map((l) => l.name)).toEqual(['One', 'Two']);
  });

  test('properties panel edits the selected layer (transform, opacity, blend, text, shape, adjust)', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    const sid = await exec(page, 'add_shape', { shape: 'rect', x: 10, y: 10, w: 100, h: 100 });
    await page.fill('#px', '250'); await page.fill('#pw', '300');
    await page.locator('#po').fill('40');
    await page.selectOption('#pb', 'screen');
    await page.selectOption('#pshape', 'ellipse');
    let l = (await layers(page))[0];
    expect(l).toMatchObject({ x: 250, w: 300, opacity: 0.4, blend: 'screen', shape: 'ellipse' });
    await page.locator('#props details summary', { hasText: 'Adjust' }).click();
    await page.locator('#f_blur').fill('7');
    expect((await layers(page))[0].filters.blur).toBe(7);
    await page.click('[data-a="resetfx"]');
    expect((await layers(page))[0].filters).toBeUndefined();
    await page.click('[data-a="flipX"]');
    expect(await page.evaluate((i) => LUMEN.L(i).flipX, sid)).toBe(true);
    await page.click('[data-a="center"]');
    expect(await page.evaluate((i) => LUMEN.L(i).x, sid)).toBe(350);
    // text layer: font, size, bold
    await exec(page, 'add_text', { text: 'Hi', size: 50 });
    await page.fill('#psize', '120');
    await page.click('#pbold');
    l = (await layers(page))[0];
    expect(l.size).toBe(120);
    expect(await page.evaluate(() => LUMEN.L().bold)).toBe(true);
  });

  test('with nothing selected the panel edits the canvas background (and transparency)', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await exec(page, 'select', { id: null });
    await page.locator('#pbg').fill('#102030');
    expect(await page.evaluate(() => LUMEN.bg)).toBe('#102030');
    await page.check('#pbgt');
    expect(await page.evaluate(() => LUMEN.bg)).toBe('transparent');
    await expect(page.locator('#lmboard')).toHaveClass(/tr/);
  });

  test('drop shadow toggles and renders', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200);
    await exec(page, 'add_shape', { x: 50, y: 50, w: 60, h: 60, fill: '#000000' });
    await page.locator('#props details summary', { hasText: 'Shadow' }).click();
    await page.check('#psh');
    await page.fill('#pshx', '30'); await page.fill('#pshb', '0');
    const p = await pixel(page, 130, 100); // outside the box, inside the shadow offset
    expect(p.r).toBeLessThan(255);
  });

  test('menus open, run commands and close on outside click', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.click('[data-menu="Layer"]');
    await expect(page.locator('[data-dd="Layer"]')).toHaveClass(/on/);
    await page.locator('[data-dd="Layer"] button', { hasText: 'New paint layer' }).click();
    expect((await layers(page))[0].type).toBe('draw');
    await page.click('[data-menu="Edit"]');
    await expect(page.locator('[data-dd="Edit"] button', { hasText: 'Undo' })).toBeEnabled();
    await page.click('#lmfile'); // outside
    await expect(page.locator('[data-dd="Edit"]')).not.toHaveClass(/on/);
  });

  test('canvas size dialog resizes the canvas', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.click('[data-menu="Image"]');
    await page.locator('[data-dd="Image"] button', { hasText: 'Canvas size' }).click();
    await page.fill('#sw', '640'); await page.fill('#sh', '480');
    await page.click('#sok');
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([640, 480]);
  });
});

test.describe('timeline and animation', () => {
  test('animate fade-in: invisible at t=0, fully visible after the clip', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100);
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 100, h: 100, fill: '#000000' });
    await exec(page, 'animate', { id, kind: 'fade-in', start: 0, end: 1 });
    const at = (t) => page.evaluate((t) => { const c = LUMEN.renderToCanvas(1, t); return c.getContext('2d').getImageData(50, 50, 1, 1).data[0]; }, t);
    expect(await at(0)).toBe(255);
    expect(await at(1)).toBe(0);
    const mid = await at(0.5); expect(mid).toBeGreaterThan(10); expect(mid).toBeLessThan(245);
    expect(await at(3)).toBe(0);
  });

  test('slide-up, zoom-in, spin and bounce change geometry over time', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 400);
    const id = await exec(page, 'add_shape', { x: 150, y: 150, w: 100, h: 100, fill: '#000000' });
    const dark = (t) => page.evaluate((t) => { const c = LUMEN.renderToCanvas(1, t), d = c.getContext('2d').getImageData(0, 0, 400, 400).data; let n = 0, sy = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] < 128) { n++; sy += ((i / 4) / 400) | 0; } return { n, cy: n ? sy / n : 0 }; }, t);
    await exec(page, 'animate', { id, kind: 'slide-up', start: 0, end: 1 });
    expect((await dark(0.5)).cy).toBeGreaterThan((await dark(1)).cy + 20);
    await exec(page, 'animate', { id, kind: 'zoom-in', start: 0, end: 1 });
    expect((await dark(0.4)).n).toBeLessThan((await dark(1)).n);
    await exec(page, 'animate', { id, kind: 'spin', start: 0, end: 1 });
    const spun = await dark(0.125); expect(spun.n).toBeGreaterThan(9000); // still a 100×100 square, rotated
    await exec(page, 'animate', { id, kind: 'bounce', start: 0, end: 1 });
    expect((await dark(0.25)).cy).toBeLessThan((await dark(0)).cy - 5);
  });

  test('timeline UI: clips show for animated layers, scrub moves the playhead and canvas, play advances time', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100);
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 100, h: 100, fill: '#000000' });
    await page.selectOption('#pan', 'fade-in');
    await expect(page.locator('.tl-clip')).toHaveCount(1);
    await expect(page.locator('.tl-clip')).toContainText('fade-in');
    const ruler = await page.locator('#tlruler').boundingBox();
    await page.mouse.click(ruler.x + 1, ruler.y + 8); // t≈0 → invisible
    const px0 = await page.evaluate(() => { const c = document.getElementById('lmcv'), g = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data; return g[3]; });
    expect(px0).toBe(0);
    await page.mouse.click(ruler.x + ruler.width * 0.9, ruler.y + 8); // past the clip → solid
    const px1 = await page.evaluate(() => { const c = document.getElementById('lmcv'), g = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data; return g[3]; });
    expect(px1).toBe(255);
    await page.click('#tlplay');
    await expect.poll(() => page.locator('#tltime').textContent()).not.toMatch(/^0\.90s/);
    await page.click('#tlplay');
    expect(id).toBeTruthy();
  });

  test('dragging a clip edge retimes the animation', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100);
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 100, h: 100 });
    await exec(page, 'animate', { id, kind: 'fade-in', start: 0, end: 1 });
    const clip = await page.locator('.tl-clip').boundingBox();
    await page.mouse.move(clip.x + clip.width - 3, clip.y + clip.height / 2);
    await page.mouse.down(); await page.mouse.move(clip.x + clip.width + 80, clip.y + clip.height / 2, { steps: 5 }); await page.mouse.up();
    const end = await page.evaluate((i) => LUMEN.L(i).anim.end, id);
    expect(end).toBeGreaterThan(1.3);
  });

  test('timeline can be hidden and its length / fps set', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.click('#lmtlt');
    await expect(page.locator('#lmtimeline')).toBeHidden();
    await page.click('#lmtlt');
    await expect(page.locator('#lmtimeline')).toBeVisible();
    await exec(page, 'duration', { seconds: 6, fps: 20 });
    expect(await page.evaluate(() => [LUMEN.duration, LUMEN.fps])).toEqual([6, 20]);
  });
});

test.describe('export', () => {
  const run = (page, opt) => page.evaluate(async (opt) => {
    const r = await LumenExport.run(LUMEN, opt);
    const b = new Uint8Array(await r.blob.arrayBuffer());
    return { ext: r.ext, size: b.length, type: r.blob.type, head: [...b.slice(0, 8)], text: new TextDecoder('latin1').decode(b.slice(0, 20)) };
  }, opt);

  test('PNG / JPG / WEBP have the right signature and scale', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100, '#336699');
    const png = await run(page, { format: 'png', scale: 2 });
    expect(png.head.slice(1, 4)).toEqual([0x50, 0x4e, 0x47]);
    const dims = await page.evaluate(async () => { const r = await LumenExport.run(LUMEN, { format: 'png', scale: 2 }); const im = await createImageBitmap(r.blob); return [im.width, im.height]; });
    expect(dims).toEqual([400, 200]);
    expect((await run(page, { format: 'jpg' })).head.slice(0, 2)).toEqual([0xff, 0xd8]);
    expect((await run(page, { format: 'webp' })).text.slice(0, 4)).toBe('RIFF');
  });

  test('transparent canvas exports PNG with alpha but JPG on white', async ({ page }) => {
    await gotoLumen(page); await blank(page, 50, 50, 'transparent');
    const px = await page.evaluate(async () => {
      const dec = async (fmt) => { const r = await LumenExport.run(LUMEN, { format: fmt }); const im = await createImageBitmap(r.blob); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return [...x.getImageData(5, 5, 1, 1).data]; };
      return { png: await dec('png'), jpg: await dec('jpg') };
    });
    expect(px.png[3]).toBe(0);
    expect(px.jpg[0]).toBeGreaterThan(250);
  });

  test('GIF: valid header, trailer and one frame per tick of the animation', async ({ page }) => {
    await gotoLumen(page); await blank(page, 60, 40, '#ffffff');
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 30, h: 40, fill: '#ff0000' });
    await exec(page, 'animate', { id, kind: 'slide-left', start: 0, end: 1 });
    const g = await page.evaluate(async () => {
      const r = await LumenExport.run(LUMEN, { format: 'gif', fps: 5, duration: 1 });
      const b = new Uint8Array(await r.blob.arrayBuffer());
      const info = { head: new TextDecoder().decode(b.slice(0, 6)), w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8), last: b[b.length - 1], size: b.length };
      if (typeof ImageDecoder !== 'undefined') {
        const d = new ImageDecoder({ data: b, type: 'image/gif' }); await d.tracks.ready;
        info.frameCount = d.tracks.selectedTrack.frameCount;
        const f = await d.decode({ frameIndex: info.frameCount - 1 }); const c = new OffscreenCanvas(60, 40), x = c.getContext('2d'); x.drawImage(f.image, 0, 0);
        info.lastPx = [...x.getImageData(10, 20, 1, 1).data];
      }
      return info;
    });
    expect(g.head).toBe('GIF89a'); expect([g.w, g.h]).toEqual([60, 40]); expect(g.last).toBe(0x3b);
    if (g.frameCount !== undefined) {
      expect(g.frameCount).toBe(5);
      expect(g.lastPx[0]).toBeGreaterThan(200); expect(g.lastPx[1]).toBeLessThan(60); // red square decoded back
    }
  });

  test('GIF with a transparent canvas keeps transparency', async ({ page }) => {
    await gotoLumen(page); await blank(page, 40, 40, 'transparent');
    await exec(page, 'add_shape', { x: 0, y: 0, w: 20, h: 40, fill: '#0000ff' });
    const a = await page.evaluate(async () => {
      const r = await LumenExport.run(LUMEN, { format: 'gif', fps: 2, duration: 1 });
      if (typeof ImageDecoder === 'undefined') return null;
      const d = new ImageDecoder({ data: await r.blob.arrayBuffer(), type: 'image/gif' }); await d.tracks.ready;
      const f = await d.decode({ frameIndex: 0 }); const c = new OffscreenCanvas(40, 40), x = c.getContext('2d'); x.drawImage(f.image, 0, 0);
      return { left: x.getImageData(5, 20, 1, 1).data[3], right: x.getImageData(35, 20, 1, 1).data[3] };
    });
    if (a) { expect(a.left).toBe(255); expect(a.right).toBe(0); }
  });

  test('PDF: structurally valid (xref offsets point at the objects), embeds the image, fit and A4 pages', async ({ page }) => {
    await gotoLumen(page); await blank(page, 300, 200, '#ff0000');
    for (const [pageOpt, box] of [['fit', '[0 0 225.00 150.00]'], ['a4', '[0 0 841.89 595.28]']]) {
      const bytes = await page.evaluate(async (po) => { const r = await LumenExport.run(LUMEN, { format: 'pdf', page: po }); return [...new Uint8Array(await r.blob.arrayBuffer())]; }, pageOpt);
      const buf = Buffer.from(bytes), txt = buf.toString('latin1');
      expect(txt.startsWith('%PDF-1.4')).toBe(true);
      expect(txt.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(txt).toContain('/DCTDecode');
      expect(txt).toContain('/Width 300/Height 200');
      expect(txt).toContain('/MediaBox' + box);
      const sx = Number(/startxref\n(\d+)/.exec(txt)[1]);
      expect(txt.slice(sx, sx + 4)).toBe('xref');
      const entries = [...txt.slice(sx).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
      expect(entries.length).toBe(5);
      entries.forEach((off, i) => expect(txt.slice(off, off + 7)).toBe(`${i + 1} 0 obj`));
      expect(buf.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true); // embedded JPEG
    }
  });

  test('WebM video records frames', async ({ page }) => {
    test.setTimeout(45_000);
    await gotoLumen(page); await blank(page, 64, 64);
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 64, h: 64, fill: '#ff8800' });
    await exec(page, 'animate', { id, kind: 'pulse', start: 0, end: 1 });
    const r = await page.evaluate(async () => {
      try { const o = await LumenExport.run(LUMEN, { format: 'webm', fps: 10, duration: 0.6 }); const b = new Uint8Array(await o.blob.arrayBuffer()); return { ok: true, size: b.length, head: [...b.slice(0, 4)], type: o.blob.type }; }
      catch (e) { return { ok: false, err: e.message }; }
    });
    if (r.ok) { expect(r.size).toBeGreaterThan(200); expect(r.head).toEqual([0x1a, 0x45, 0xdf, 0xa3]); expect(r.type).toBe('video/webm'); }
    else expect(r.err).toMatch(/not supported|cannot record/i); // environments without MediaRecorder
  });

  test('Export dialog: format options toggle, downloads a real file, names it after the project', async ({ page }) => {
    await gotoLumen(page); await blank(page, 120, 80, '#223344');
    await page.click('#lmexport');
    await expect(page.locator('.x-a').first()).toBeHidden(); // PNG: no fps
    await page.click('.lm-fmt[data-f="gif"]');
    await expect(page.locator('.x-a').first()).toBeVisible();
    await page.click('.lm-fmt[data-f="pdf"]');
    await expect(page.locator('.x-p')).toBeVisible();
    await page.click('.lm-fmt[data-f="png"]');
    await page.selectOption('#xs', '0.5');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xgo')]);
    expect(dl.suggestedFilename()).toBe('lumen-project.png');
    const path = await dl.path();
    const { statSync } = await import('node:fs');
    expect(statSync(path).size).toBeGreaterThan(50);
    await expect(page.locator('#lmmodal')).toBeHidden();
    await expect(page.locator('#lmstatus')).toContainText('Exported');
  });

  test('project round-trips through .lum (save → open) with pixels intact', async ({ page }) => {
    await gotoLumen(page); await blank(page, 300, 200, '#101010');
    const src = await redGreen(page);
    await page.evaluate((s) => LUMEN.exec('add_image', { src: s, fit: 'none', name: 'photo' }), src);
    await exec(page, 'add_text', { text: 'Round trip', size: 40, x: 10, y: 10 }); // clear of the green square
    const json = await page.evaluate(() => LUMEN.toJSON());
    await exec(page, 'new', { w: 10, h: 10 });
    expect((await layers(page)).length).toBe(0);
    await page.evaluate((j) => LUMEN.load(j), json);
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([300, 200]);
    expect((await layers(page)).map((l) => l.name)).toEqual(['Round trip', 'photo']);
    expect((await pixel(page, 150, 100)).hex).toBe('#00ff00');
    const bad = await page.evaluate(async () => { try { await LUMEN.load('{"nope":1}'); } catch (e) { return e.message; } });
    expect(bad).toContain('not a LUMEN project');
  });
});

test.describe('emoji, clipboard and files', () => {
  test('emoji dialog: picking an emoji adds an Emoji text layer; pasted emoji go to the layer too', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.click('[data-menu="Edit"]');
    await page.locator('[data-dd="Edit"] button', { hasText: 'Paste text / emoji' }).click();
    await expect(page.locator('.lm-emoji button').first()).toBeVisible();
    await page.locator('.lm-emoji button[data-e="🔥"]').click();
    let l = (await layers(page))[0];
    expect(l).toMatchObject({ type: 'text', text: '🔥', name: '🔥' === l.name ? l.name : 'Emoji' });
    await page.fill('#epaste', '🎉✨');
    await page.click('#eadd');
    l = (await layers(page))[0];
    expect(l.text).toBe('🎉✨');
    // with a text layer selected, picking inserts into its text instead of making a new layer
    const n = (await layers(page)).length;
    await page.locator('.lm-emoji button[data-e="💯"]').click();
    expect((await layers(page)).length).toBe(n + 1); // modal open → panel text box not present, so new layer
    await page.click('#eclose');
    await expect(page.locator('#lmmodal')).toBeHidden();
  });

  test('inserting an emoji while editing a text layer goes into that text', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await exec(page, 'add_text', { text: 'Sale ', size: 60 });
    await page.evaluate(() => { const t = document.getElementById('ptext'); t.focus(); t.setSelectionRange(5, 5); });
    await page.evaluate(() => document.getElementById('pemoji').click());
    // dialog is open on top of the panel; the text box still exists, so the emoji is inserted into it
    await page.locator('.lm-emoji button[data-e="🔥"]').click();
    expect((await layers(page)).length).toBe(1);
    expect((await layers(page))[0].text).toBe('Sale 🔥');
  });

  test('Ctrl+V of text (and emoji) makes a text layer; ignored while typing in a field', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'Grand opening'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
    await frames(page);
    expect((await layers(page))[0]).toMatchObject({ type: 'text', text: 'Grand opening' });
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '😀'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
    await frames(page);
    expect((await layers(page))[0].text).toBe('😀');
    const n = (await layers(page)).length;
    await page.focus('#clin');
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'into chat'); document.getElementById('clin').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
    expect((await layers(page)).length).toBe(n);
  });

  test('pasting an image (screenshot) adds an image layer; the first image on an empty canvas sizes it', async ({ page }) => {
    await gotoLumen(page);
    await exec(page, 'new', { w: 1920, h: 1080 });
    await page.evaluate(() => { window.__touched = false; });
    const src = await redGreen(page);
    await page.evaluate(async (s) => {
      const blob = await (await fetch(s)).blob();
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, src);
    await expect.poll(async () => (await layers(page)).length).toBe(1);
    expect((await layers(page))[0]).toMatchObject({ type: 'image', name: 'shot' });
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([200, 100]); // canvas took the image's size
    const src2 = await redGreen(page);
    await page.evaluate(async (s) => { const blob = await (await fetch(s)).blob(); const dt = new DataTransfer(); dt.items.add(new File([blob], 'two.png', { type: 'image/png' })); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); }, src2);
    await expect.poll(async () => (await layers(page)).length).toBe(2);
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([200, 100]); // second image does not resize
  });

  test('file input opens images and .lum projects', async ({ page }) => {
    await gotoLumen(page); await blank(page, 300, 200);
    const src = await redGreen(page);
    const png = Buffer.from(src.split(',')[1], 'base64');
    await page.setInputFiles('#lmfilein', { name: 'pic.png', mimeType: 'image/png', buffer: png });
    await expect.poll(async () => (await layers(page)).length).toBe(1);
    expect((await layers(page))[0].name).toBe('pic');
    const proj = await page.evaluate(() => LUMEN.toJSON());
    await exec(page, 'new', { w: 50, h: 50 });
    await page.setInputFiles('#lmfilein', { name: 'a.lum', mimeType: 'application/json', buffer: Buffer.from(proj) });
    await expect.poll(() => page.evaluate(() => LUMEN.w)).toBe(300);
    expect((await layers(page)).length).toBe(1);
  });

  test('a non-image file is ignored with no error', async ({ page }) => {
    const errors = trackErrors(page);
    await gotoLumen(page); await blank(page);
    await page.setInputFiles('#lmfilein', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await frames(page, 4);
    expect((await layers(page)).length).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe('persistence and Claude', () => {
  test('autosave: edits survive a reload', async ({ page }) => {
    await gotoLumen(page); await blank(page, 640, 360, '#202020');
    await exec(page, 'add_text', { text: 'Persist me', size: 50 });
    await page.waitForTimeout(1200); // debounce
    await page.reload();
    await expect(page.locator('#lm')).toHaveClass(/on/, { timeout: 5000 });
    await expect.poll(async () => (await layers(page)).length).toBe(1);
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h, LUMEN.bg])).toEqual([640, 360, '#202020']);
    expect((await layers(page))[0].text).toBe('Persist me');
  });

  test('dock slash commands run the same command API', async ({ page }) => {
    await gotoLumen(page, '?agents=1&nodialog'); await blank(page);
    await page.fill('#clin', '/text Big Sale');
    await page.press('#clin', 'Enter');
    await expect.poll(async () => (await layers(page)).length).toBe(1);
    expect((await layers(page))[0].text).toBe('Big Sale');
    await page.fill('#clin', '/shape ellipse');
    await page.press('#clin', 'Enter');
    await expect.poll(async () => (await layers(page))[0].shape).toBe('ellipse');
    await page.fill('#clin', '/bg #123456'); await page.press('#clin', 'Enter');
    await expect.poll(() => page.evaluate(() => LUMEN.bg)).toBe('#123456');
    await page.fill('#clin', '/undo'); await page.press('#clin', 'Enter');
    await expect.poll(async () => (await layers(page)).length).toBe(2);
    await page.fill('#clin', '/nonsense'); await page.press('#clin', 'Enter');
    await expect(page.locator('.cl-log .e').last()).toContainText('unknown command');
    await page.fill('#clin', '/help'); await page.press('#clin', 'Enter');
    await expect(page.locator('.cl-log .m').last()).toContainText('/text');
    await expect(page.locator('#lmai')).toHaveText('offline'); // agents=1 → nothing listening
  });

  test('typing in the dock does not trigger tool shortcuts', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    await page.focus('#clin');
    await page.keyboard.type('bte');
    await expect(page.locator('[data-tool="move"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.inputValue('#clin')).toBe('bte');
  });

  test('bridge: server /lumen/cmd drives the live canvas (what the Claude CLI does)', async ({ page, request }) => {
    const mock = await startMock();
    try {
      await gotoLumen(page, `?agents=${mock.port}&nodialog`); await blank(page);
      await expect(page.locator('#lmai')).not.toHaveText('offline');
      await expect(page.locator('.cl-log')).toContainText('connected');
      const send = (cmd, args) => request.post(mock.api + '/lumen/cmd', { data: { token: mock.token, cmd, args } });
      const r1 = await send('add_text', { text: 'From Claude', size: '90', color: '#ff00aa' });
      expect(r1.ok()).toBe(true);
      const id = (await r1.json()).result;
      expect((await layers(page))[0]).toMatchObject({ id, text: 'From Claude', size: 90, color: '#ff00aa' });
      const r2 = await send('animate', { id, kind: 'slide-up', start: '0', end: '1' });
      expect(r2.ok()).toBe(true);
      expect((await layers(page))[0].anim).toMatchObject({ kind: 'slide-up', end: 1 });
      const st = await (await send('state', {})).json();
      expect(st.result.layers[0].text).toBe('From Claude');
      const bad = await send('set', { id: 'ghost', x: 1 });
      expect(bad.status()).toBe(422);
      expect((await bad.json()).error).toContain('no such layer');
      await expect(page.locator('.cl-log .r').first()).toContainText('add_text');
      await expect(page.locator('#lmai')).toContainText('working');
      // the user can undo what Claude did
      await page.keyboard.press('Control+z');
      expect((await layers(page))[0].anim).toBeUndefined();
    } finally { mock.stop(); }
  });

  test('bridge: wrong token is rejected; with LUMEN closed the CLI gets a helpful 503', async ({ request }) => {
    const mock = await startMock();
    try {
      const denied = await request.post(mock.api + '/lumen/cmd', { data: { token: 'wrong', cmd: 'state', args: {} } });
      expect(denied.status()).toBe(403);
      const closed = await request.post(mock.api + '/lumen/cmd', { data: { token: mock.token, cmd: 'state', args: {} } });
      expect(closed.status()).toBe(503);
      expect((await closed.json()).error).toContain('not open');
      expect(await (await request.get(mock.api + '/lumen/status')).json()).toEqual({ open: false });
    } finally { mock.stop(); }
  });

  test('a Claude dock message reaches the lumen session (mock agent echoes it)', async ({ page }) => {
    const mock = await startMock();
    try {
      await gotoLumen(page, `?agents=${mock.port}&nodialog`);
      await expect(page.locator('.cl-log')).toContainText('connected');
      await page.fill('#clin', 'make the headline bigger');
      await page.press('#clin', 'Enter');
      await expect(page.locator('.cl-log .a')).toContainText('received: make the headline bigger', { timeout: 8000 });
      await expect(page.locator('#lmai')).toHaveText('done');
      // lumen docks are not swarm agents
      expect(await (await page.request.get(mock.api + '/sessions')).json()).toEqual([]);
    } finally { mock.stop(); }
  });
});
