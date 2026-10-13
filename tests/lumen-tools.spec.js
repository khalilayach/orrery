// @ts-check
// E2E tests for LUMEN's Photoshop-style toolset: marquee / lasso / magic select, fills, gradients,
// filters, retouch brushes, canvas transforms, stacked timeline clips, and multi-page PDF export.
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PAGE = pathToFileURL(resolve(import.meta.dirname, '..', 'index.html')).href;

function trackErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
const frames = (page, n = 2) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? setTimeout(r, 30) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function gotoLumen(page) {
  await page.goto(PAGE + '?agents=57312&nodialog#lumen');
  await expect(page.locator('#lm')).toHaveClass(/on/, { timeout: 5000 });
  await frames(page);
}
const exec = (page, cmd, args = {}) => page.evaluate(([c, a]) => LUMEN.exec(c, a), [cmd, args]);
async function blank(page, w = 1000, h = 600, bg = '#ffffff') {
  await exec(page, 'new', { w, h, bg });
  await page.click('#lmfit');
  await frames(page);
}
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
async function click(page, x, y, mods = []) {
  const p = await at(page, x, y);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of mods) await page.keyboard.up(m);
  await frames(page);
}
const pixel = (page, x, y) => page.evaluate(([x, y]) => LUMEN.pixel(x, y), [x, y]);
const sel = (page) => page.evaluate(() => LUMEN.selBounds());
/** a data URL: red field with a green square in the middle */
const redGreen = (page) => page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 100; const x = c.getContext('2d');
  x.fillStyle = '#ff0000'; x.fillRect(0, 0, 200, 100); x.fillStyle = '#00ff00'; x.fillRect(80, 30, 40, 40);
  return c.toDataURL('image/png');
});
async function withImage(page) {
  await blank(page, 200, 100, '#ffffff');
  await page.evaluate(async (s) => { await LUMEN.exec('add_image', { src: s, fit: 'none' }); }, await redGreen(page));
}

test.describe('toolbox', () => {
  test('every Photoshop-style tool is in the toolbox and switches the options bar', async ({ page }) => {
    const errors = trackErrors(page);
    await gotoLumen(page);
    const ids = ['move', 'marquee', 'lasso', 'wand', 'crop', 'pick', 'brush', 'pencil', 'eraser', 'bgerase', 'clone', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'bucket', 'gradient', 'text', 'shape', 'hand', 'zoom'];
    for (const id of ids) {
      await page.click(`[data-tool="${id}"]`);
      await expect(page.locator(`[data-tool="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#lmopts .otool')).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
  });

  test('keyboard shortcuts pick the new tools', async ({ page }) => {
    await gotoLumen(page); await blank(page);
    for (const [k, id] of [['m', 'marquee'], ['l', 'lasso'], ['w', 'wand'], ['g', 'bucket'], ['j', 'gradient'], ['s', 'clone'], ['r', 'blur'], ['y', 'smudge'], ['o', 'dodge'], ['q', 'burn'], ['n', 'pencil'], ['k', 'bgerase']]) {
      await page.keyboard.press(k);
      await expect(page.locator(`[data-tool="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
  });
});

test.describe('selections', () => {
  test('magic select picks the clicked colour region; Shift adds, Alt subtracts', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await page.keyboard.press('w');
    await click(page, 100, 50); // the green square
    expect(await sel(page)).toEqual({ x: 80, y: 30, w: 40, h: 40 });
    await click(page, 10, 10); // red replaces
    const red = await sel(page); expect(red.w).toBeGreaterThan(190); expect(red.h).toBeGreaterThan(90);
    await click(page, 100, 50, ['Alt']); // subtract the green square from red? it is not in red → still red
    expect((await sel(page)).w).toBeGreaterThan(190);
    await page.keyboard.press('Escape'); expect(await sel(page)).toBeNull();
    await click(page, 100, 50); await click(page, 10, 10, ['Shift']); // add red to green
    const both = await sel(page); expect(both.w).toBeGreaterThan(190);
  });

  test('magic select tolerance: 0 selects exact colour, high tolerance spreads', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100, '#ffffff');
    await exec(page, 'add_shape', { x: 0, y: 0, w: 50, h: 100, fill: '#808080' });
    await exec(page, 'add_shape', { x: 50, y: 0, w: 50, h: 100, fill: '#909090' });
    await exec(page, 'select_wand', { x: 10, y: 10, tol: 0, all: true });
    expect((await sel(page)).w).toBe(50);
    await exec(page, 'select_wand', { x: 10, y: 10, tol: 30, all: true });
    expect((await sel(page)).w).toBe(100);
  });

  test('marquee: drag selects a rectangle; an ellipse excludes the corners; click deselects', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 400);
    await page.keyboard.press('m');
    await drag(page, [100, 100], [300, 250]);
    expect(await sel(page)).toEqual({ x: 100, y: 100, w: 200, h: 150 });
    await page.selectOption('#omq', 'ellipse');
    await drag(page, [100, 100], [300, 300]);
    await exec(page, 'fill_selection', { color: '#ff0000' });
    expect((await pixel(page, 200, 200)).hex).toBe('#ff0000');
    expect((await pixel(page, 104, 104)).hex).toBe('#ffffff'); // corner of the box, outside the ellipse
    await click(page, 20, 20); // a plain click deselects
    expect(await sel(page)).toBeNull();
  });

  test('lasso: freehand outline becomes a selection', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 400);
    await page.keyboard.press('l');
    const pts = [[100, 100], [300, 100], [300, 300], [100, 300]];
    const first = await at(page, ...pts[0]); await page.mouse.move(first.x, first.y); await page.mouse.down();
    for (const p of pts.slice(1)) { const q = await at(page, ...p); await page.mouse.move(q.x, q.y, { steps: 6 }); }
    await page.mouse.up(); await frames(page);
    const b = await sel(page); expect(b.x).toBeGreaterThanOrEqual(99); expect(b.w).toBeGreaterThan(190);
    await exec(page, 'select_poly', { points: [[0, 0], [50, 0], [0, 50]] });
    expect((await sel(page)).w).toBe(50);
    await expect(exec(page, 'select_poly', { points: [[0, 0]] })).rejects.toThrow(/at least 3 points/);
  });

  test('select all, inverse, deselect and Esc', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200);
    await page.keyboard.press('Control+a');
    expect(await sel(page)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    await exec(page, 'select_rect', { x: 0, y: 0, w: 100, h: 200 });
    await exec(page, 'invert_selection');
    const inv = await sel(page); expect(inv.x).toBe(100); expect(inv.w).toBe(100);
    await page.keyboard.press('Escape');
    expect(await sel(page)).toBeNull();
    await expect(page.locator('#lm')).toHaveClass(/on/); // Esc deselected first and did not close the studio
  });

  test('feather softens the edge; expand grows and shrinks', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200);
    await exec(page, 'select_rect', { x: 50, y: 50, w: 100, h: 100 });
    await exec(page, 'expand', { px: 10 });
    expect(await sel(page)).toEqual({ x: 40, y: 40, w: 120, h: 120 });
    await exec(page, 'expand', { px: -10 });
    const b = await sel(page); expect(b.w).toBeLessThanOrEqual(101); expect(b.w).toBeGreaterThanOrEqual(98);
    await exec(page, 'feather', { radius: 12 });
    await exec(page, 'fill_selection', { color: '#000000' });
    const edge = await pixel(page, 50, 100); // on the old edge: partial coverage
    expect(edge.r).toBeGreaterThan(40); expect(edge.r).toBeLessThan(230);
    expect((await pixel(page, 100, 100)).hex).toBe('#000000');
  });

  test('fill and clear stay inside the selection; Delete clears pixels, not the layer', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await exec(page, 'select_rect', { x: 0, y: 0, w: 100, h: 100 });
    await exec(page, 'fill_selection', { color: '#0000ff' });
    expect((await pixel(page, 10, 10)).hex).toBe('#0000ff');
    expect((await pixel(page, 190, 10)).hex).toBe('#ff0000');
    const before = await page.evaluate(() => LUMEN.layers.length);
    await page.keyboard.press('Delete');
    expect(await page.evaluate(() => LUMEN.layers.length)).toBe(before);
    expect((await pixel(page, 10, 10)).hex).toBe('#ffffff'); // erased → canvas white shows through
    expect((await pixel(page, 190, 10)).hex).toBe('#ff0000');
    await page.keyboard.press('Control+z'); // pixel edits undo
    expect((await pixel(page, 10, 10)).hex).toBe('#0000ff');
  });

  test('layer via copy and via cut; crop to selection', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await exec(page, 'select_rect', { x: 70, y: 20, w: 60, h: 60 });
    await page.keyboard.press('Control+j');
    const L = await page.evaluate(() => LUMEN.describe().layers);
    expect(L.length).toBe(2); expect(L[0].name).toMatch(/copy/); expect([L[0].x, L[0].y, L[0].w, L[0].h]).toEqual([70, 20, 60, 60]);
    await exec(page, 'selection_to_layer', { cut: true, id: L[1].id });
    expect((await pixel(page, 5, 5)).hex).toBe('#ff0000');
    await exec(page, 'crop_to_selection');
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([60, 60]);
    expect(await sel(page)).toBeNull();
    await exec(page, 'select_all'); await exec(page, 'new', { w: 50, h: 50 });
    expect(await sel(page)).toBeNull(); // a new project drops the selection
    await expect(exec(page, 'crop_to_selection')).rejects.toThrow(/nothing is selected/);
  });

  test('a brush stroke is clipped to the selection', async ({ page }) => {
    await gotoLumen(page); await blank(page, 400, 200);
    await exec(page, 'add_draw');
    await exec(page, 'select_rect', { x: 100, y: 0, w: 100, h: 200 });
    await page.keyboard.press('b'); await page.fill('#obs', '40'); await page.fill('#obh', '100');
    await drag(page, [20, 100], [380, 100], 12);
    expect((await pixel(page, 150, 100)).a).toBe(255);
    expect((await pixel(page, 40, 100)).hex).toBe('#ffffff');
    expect((await pixel(page, 350, 100)).hex).toBe('#ffffff');
  });
});

test.describe('fills and filters', () => {
  test('paint bucket fills a contiguous region; non-contiguous fills the colour everywhere', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await page.keyboard.press('g');
    await page.evaluate(() => { document.getElementById('lmfg').value = '#0000ff'; document.getElementById('lmfg').dispatchEvent(new Event('input', { bubbles: true })); });
    await click(page, 10, 10);
    expect((await pixel(page, 10, 10)).hex).toBe('#0000ff');
    expect((await pixel(page, 190, 90)).hex).toBe('#0000ff');
    expect((await pixel(page, 100, 50)).hex).toBe('#00ff00'); // the green square is a different colour
    await exec(page, 'bucket', { x: 100, y: 50, color: '#ffff00', tol: 0 });
    expect((await pixel(page, 100, 50)).hex).toBe('#ffff00');
  });

  test('gradient: linear runs foreground → background; radial; transparent end keeps the colour', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100);
    await exec(page, 'gradient', { x0: 0, y0: 0, x1: 200, y1: 0, from: '#000000', to: '#ffffff' });
    const l = (await pixel(page, 5, 50)).r, m = (await pixel(page, 100, 50)).r, r = (await pixel(page, 195, 50)).r;
    expect(l).toBeLessThan(m); expect(m).toBeLessThan(r); expect(l).toBeLessThan(30); expect(r).toBeGreaterThan(225);
    await exec(page, 'new', { w: 200, h: 100 });
    await exec(page, 'gradient', { x0: 100, y0: 50, x1: 100, y1: 0, from: '#ff0000', to: '#0000ff', kind: 'radial' });
    expect((await pixel(page, 100, 50)).r).toBeGreaterThan(240);
    expect((await pixel(page, 5, 95)).b).toBeGreaterThan(200);
    await exec(page, 'new', { w: 100, h: 100 });
    await exec(page, 'gradient', { x0: 0, y0: 0, x1: 100, y1: 0, from: '#ff0000', to: 'transparent' });
    const mid = await pixel(page, 50, 50); expect(mid.r).toBeGreaterThan(mid.g + 40); // fading red over white, not grey
    await page.keyboard.press('j');
    await drag(page, [10, 10], [90, 10]); // the tool path runs without error
  });

  test('filters: invert, threshold, pixelate, blur, sharpen, noise, emboss, edges, posterize, vignette, auto contrast, sepia, desaturate, solarize', async ({ page }) => {
    const errors = trackErrors(page);
    await gotoLumen(page); await withImage(page);
    await exec(page, 'filter', { name: 'invert' });
    expect((await pixel(page, 10, 10)).hex).toBe('#00ffff');
    await exec(page, 'filter', { name: 'invert' });
    await exec(page, 'filter', { name: 'desaturate' });
    const g = await pixel(page, 10, 10); expect(g.r).toBe(g.g); expect(g.g).toBe(g.b);
    await exec(page, 'filter', { name: 'threshold', amount: 100 });
    expect([0, 255]).toContain((await pixel(page, 10, 10)).r);
    for (const name of ['pixelate', 'blur', 'sharpen', 'noise', 'emboss', 'edges', 'posterize', 'vignette', 'auto_contrast', 'sepia', 'solarize']) await exec(page, 'filter', { name });
    await expect(exec(page, 'filter', { name: 'nope' })).rejects.toThrow(/unknown filter/);
    expect(errors).toEqual([]);
  });

  test('blur softens a hard edge; a filter respects the selection', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100, '#ffffff');
    await exec(page, 'add_shape', { x: 0, y: 0, w: 50, h: 100, fill: '#000000' });
    await exec(page, 'rasterize');
    await exec(page, 'select_rect', { x: 0, y: 0, w: 100, h: 50 });
    await exec(page, 'filter', { name: 'blur', amount: 10 });
    const top = await pixel(page, 52, 20), bottom = await pixel(page, 52, 80);
    expect(top.r).toBeLessThan(250); expect(top.r).toBeGreaterThan(5); // blurred across the edge in the selected half
    expect(bottom.r).toBe(255); // untouched below
  });

  test('Filter menu opens a dialog with a slider and applies it', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await page.click('[data-menu="Filter"]');
    await page.locator('[data-dd="Filter"] button', { hasText: 'Posterize' }).click();
    await expect(page.locator('.lm-dialog h2')).toHaveText('Posterize');
    await page.locator('#fa').fill('2');
    await page.click('#fok');
    await expect(page.locator('#lmstatus')).toContainText('Posterize applied');
    await page.click('[data-menu="Filter"]');
    await page.locator('[data-dd="Filter"] button', { hasText: 'Invert colours' }).click(); // no slider: applies at once
    expect((await pixel(page, 10, 10)).hex).toBe('#00ffff');
  });
});

test.describe('retouch brushes', () => {
  async function paintOver(page, tool, from = [20, 50], to = [180, 50]) {
    await page.keyboard.press(tool);
    await page.fill('#obs', '30');
    await drag(page, from, to, 14);
  }
  test('blur, sharpen, dodge, burn and smudge change pixels on an image layer', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    const before = await pixel(page, 100, 20);
    await paintOver(page, 'o', [60, 20], [140, 20]); // dodge lightens
    expect((await pixel(page, 100, 20)).r).toBeGreaterThanOrEqual(before.r);
    expect((await pixel(page, 100, 20)).g).toBeGreaterThan(before.g);
    await paintOver(page, 'q', [60, 80], [140, 80]); // burn darkens
    expect((await pixel(page, 100, 80)).r).toBeLessThan(255);
    await paintOver(page, 'r', [70, 50], [130, 50]); // blur the green square's edge
    const edge = await pixel(page, 82, 50); expect(edge.r === 255 && edge.g === 0).toBe(false);
    await paintOver(page, 'a', [70, 50], [130, 50]);
    await paintOver(page, 'y', [40, 50], [160, 50]);
    expect(await page.evaluate(() => LUMEN.canUndo)).toBe(true);
  });

  test('retouch needs an image or paint layer; clone needs an alt-click source first', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100);
    await page.keyboard.press('r'); await drag(page, [20, 50], [100, 50]);
    await expect(page.locator('#lmstatus')).toContainText('image or paint layer');
    await exec(page, 'add_draw');
    await page.keyboard.press('s'); await click(page, 50, 50);
    await expect(page.locator('#lmstatus')).toContainText('Alt-click');
  });

  test('clone stamp copies pixels from the alt-click source', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await page.keyboard.press('s'); await page.fill('#obs', '24'); await page.fill('#obh', '100');
    await click(page, 100, 50, ['Alt']); // source: the green square
    await expect(page.locator('#lmstatus')).toContainText('Clone source set');
    await drag(page, [30, 20], [30, 22], 2); // paint onto red, 70px left and 30px up from the source
    expect((await pixel(page, 30, 21)).g).toBeGreaterThan(150);
  });

  test('retouch stays inside a selection', async ({ page }) => {
    await gotoLumen(page); await withImage(page);
    await exec(page, 'select_rect', { x: 0, y: 0, w: 100, h: 100 });
    await page.keyboard.press('q'); await page.fill('#obs', '60'); await page.fill('#obh', '100'); await page.fill('#ost', '100');
    await drag(page, [20, 20], [180, 20], 14);
    expect((await pixel(page, 40, 20)).r).toBeLessThan(255);
    expect((await pixel(page, 170, 20)).r).toBe(255); // right of the selection: untouched
  });
});

test.describe('canvas transforms', () => {
  test('rotate 90° swaps the size and turns the content; flip mirrors it', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100, '#ffffff');
    await exec(page, 'add_shape', { x: 0, y: 0, w: 50, h: 50, fill: '#ff0000' }); // top-left red square
    await exec(page, 'rotate_canvas', { deg: 90 });
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([100, 200]);
    expect((await pixel(page, 90, 10)).hex).toBe('#ff0000'); // top-left → top-right
    await exec(page, 'rotate_canvas', { deg: 270 });
    expect((await pixel(page, 10, 10)).hex).toBe('#ff0000');
    await exec(page, 'flip_canvas', { axis: 'h' });
    expect((await pixel(page, 190, 10)).hex).toBe('#ff0000');
    await exec(page, 'flip_canvas', { axis: 'v' });
    expect((await pixel(page, 190, 90)).hex).toBe('#ff0000');
    await exec(page, 'rotate_canvas', { deg: 180 });
    expect((await pixel(page, 10, 10)).hex).toBe('#ff0000');
  });

  test('paint layers rotate with the canvas and the Image menu drives it', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 100, '#ffffff');
    await exec(page, 'add_draw');
    await exec(page, 'fill_selection', { color: '#00aa00' });
    await page.click('[data-menu="Image"]');
    await page.locator('[data-dd="Image"] button', { hasText: 'Rotate 90° clockwise' }).click();
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([100, 200]);
    expect((await pixel(page, 50, 100)).hex).toBe('#00aa00');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => [LUMEN.w, LUMEN.h])).toEqual([200, 100]);
  });
});

test.describe('timeline clips', () => {
  test('several effects stack on one layer and compose', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200, 'transparent');
    const id = await exec(page, 'add_shape', { x: 50, y: 50, w: 100, h: 100, fill: '#000000' });
    await exec(page, 'add_clip', { id, kind: 'fade-in', start: 0, end: 1 });
    const r = await exec(page, 'add_clip', { id, kind: 'slide-up', start: 0, end: 1 });
    expect(r.index).toBe(1);
    const alpha = (t) => page.evaluate((t) => { const c = LUMEN.renderToCanvas(1, t), d = c.getContext('2d').getImageData(100, 100, 1, 1).data; return d[3]; }, t);
    expect(await alpha(0)).toBe(0);
    expect(await page.evaluate(() => { const c = LUMEN.renderToCanvas(1, 1), d = c.getContext('2d').getImageData(100, 100, 1, 1).data; return d[3]; })).toBe(255);
    expect(await page.evaluate((i) => LUMEN.describe().layers.find((l) => l.id === i).fx.length, id)).toBe(1);
    await exec(page, 'animate', { id, index: 1, kind: 'spin', start: 1, end: 2 });
    expect(await page.evaluate((i) => LUMEN.L(i).fx[0].kind, id)).toBe('spin');
    await exec(page, 'remove_clip', { id, index: 1 });
    expect(await page.evaluate((i) => (LUMEN.L(i).fx || []).length, id)).toBe(0);
    await exec(page, 'remove_clip', { id, index: 0 });
    expect(await page.evaluate((i) => LUMEN.L(i).anim.kind, id)).toBe('none');
    await expect(exec(page, 'animate', { id, index: 5, kind: 'pulse' })).rejects.toThrow(/no such clip/);
    await expect(exec(page, 'remove_clip', { id, index: 3 })).rejects.toThrow(/no such clip/);
  });

  test('clips undo/redo and duplicate with the layer', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100);
    const id = await exec(page, 'add_shape', { w: 40, h: 40 });
    await exec(page, 'add_clip', { id, kind: 'fade-in' }); await exec(page, 'add_clip', { id, kind: 'pulse', start: 1, end: 2 });
    await exec(page, 'duplicate', { id });
    expect(await page.evaluate(() => LUMEN.L().fx.length)).toBe(1);
    await exec(page, 'undo'); await exec(page, 'undo');
    expect(await page.evaluate((i) => (LUMEN.L(i).fx || []).length, id)).toBe(0);
    await exec(page, 'redo');
    expect(await page.evaluate((i) => LUMEN.L(i).fx.length, id)).toBe(1);
  });

  test('timeline UI: add an effect from the menu, pick a clip, edit it in the inspector, delete it', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200);
    await exec(page, 'add_shape', { w: 100, h: 100 });
    await page.selectOption('#tladd', 'zoom-in');
    await expect(page.locator('.tl-clip')).toHaveCount(1);
    await page.selectOption('#tladd', 'pulse');
    await expect(page.locator('.tl-clip')).toHaveCount(2);
    await expect(page.locator('#tlkind')).toHaveValue('pulse'); // the new clip is selected in the inspector
    await page.locator('#tlkind').selectOption('bounce');
    await expect(page.locator('.tl-clip.sel')).toContainText('bounce');
    await page.locator('#tlend').fill('3');
    await page.locator('#tlend').dispatchEvent('change');
    expect(await page.evaluate(() => LUMEN.L().fx[0].end)).toBe(3);
    const lanes = await page.locator('.tl-clip').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect(new Set(lanes.map(Math.round)).size).toBe(2); // overlapping clips are stacked in separate lanes, never on top of each other
    await page.locator('.tl-clip', { hasText: 'zoom-in' }).click();
    await expect(page.locator('#tlkind')).toHaveValue('zoom-in');
    await page.click('#tlcdel');
    await expect(page.locator('.tl-clip')).toHaveCount(1);
    await expect(page.locator('.tl-clip')).toContainText('bounce'); // the extra clip was promoted to the main one
  });

  test('double-click on a track adds an effect at that time; Animate menu adds one at the playhead', async ({ page }) => {
    await gotoLumen(page); await blank(page, 200, 200);
    await exec(page, 'add_shape', { w: 100, h: 100 });
    const tr = await page.locator('.tl-track').first().boundingBox();
    await page.mouse.dblclick(tr.x + tr.width * 0.5, tr.y + 9);
    await expect(page.locator('.tl-clip')).toHaveCount(1);
    const start = await page.evaluate(() => LUMEN.L().anim.start);
    expect(start).toBeGreaterThan(1.5); expect(start).toBeLessThan(2.5);
    await page.click('[data-menu="Animate"]');
    await page.locator('[data-dd="Animate"] button', { hasText: 'Add effect at playhead' }).click();
    await expect(page.locator('.tl-clip')).toHaveCount(2);
  });

  test('transport: step frames, stop, loop off ends at the end; ruler scrubs; zoom widens the timeline', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100);
    await exec(page, 'add_shape', { w: 50, h: 50 });
    await exec(page, 'duration', { seconds: 2, fps: 10 });
    await page.click('#tlnext'); await page.click('#tlnext');
    await expect(page.locator('#tltime')).toContainText('0.20s / 2.00s');
    await page.click('#tlprev');
    await expect(page.locator('#tltime')).toContainText('0.10s');
    await page.click('#tlstop');
    await expect(page.locator('#tltime')).toContainText('0.00s');
    const w1 = (await page.locator('#tlinner').boundingBox()).width;
    await page.click('#tlz\\+');
    expect((await page.locator('#tlinner').boundingBox()).width).toBeGreaterThan(w1 * 1.3);
    await page.click('#tlz-');
    await page.uncheck('#tlloop');
    await page.click('#tlplay');
    await expect(page.locator('#tltime')).toContainText('2.00s / 2.00s', { timeout: 6000 });
    await expect(page.locator('#tlplay')).toHaveAttribute('aria-label', 'Play'); // stopped itself at the end
  });

  test('the playhead is one line across every layer row', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100);
    await exec(page, 'add_shape', { w: 50, h: 50 }); await exec(page, 'add_shape', { w: 40, h: 40 });
    const head = await page.locator('#tlhead').boundingBox(), rows = await page.locator('.tl-row').last().boundingBox();
    expect(head.y).toBeLessThanOrEqual(rows.y); expect(head.y + head.height).toBeGreaterThanOrEqual(rows.y + rows.height - 1);
  });
});

test.describe('PDF export', () => {
  const pdf = (page, opt) => page.evaluate(async (opt) => { const r = await LumenExport.run(LUMEN, { format: 'pdf', ...opt }); return [...new Uint8Array(await r.blob.arrayBuffer())]; }, opt);
  const text = (bytes) => Buffer.from(bytes).toString('latin1');

  test('every animation frame becomes a page, and the xref is valid for any page count', async ({ page }) => {
    await gotoLumen(page); await blank(page, 120, 80, '#112233');
    const id = await exec(page, 'add_shape', { x: 0, y: 0, w: 40, h: 40, fill: '#ff8800' });
    await exec(page, 'animate', { id, kind: 'slide-left', start: 0, end: 1 });
    await exec(page, 'duration', { seconds: 1, fps: 4 });
    const txt = text(await pdf(page, { allFrames: true, page: 'fit' }));
    expect(txt).toContain('/Count 4');
    expect((txt.match(/\/Type\/Page\//g) || []).length).toBe(4);
    const sx = Number(/startxref\n(\d+)/.exec(txt)[1]);
    const entries = [...txt.slice(sx).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    expect(entries.length).toBe(2 + 4 * 3);
    entries.forEach((off, i) => expect(txt.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(txt).toContain('/Size 15');
  });

  test('page sizes: Letter, A3, A5 and margins; portrait images get portrait pages', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 200, '#ff0000');
    expect(text(await pdf(page, { page: 'letter' }))).toContain('/MediaBox[0 0 612.00 792.00]');
    expect(text(await pdf(page, { page: 'a3' }))).toContain('/MediaBox[0 0 841.89 1190.55]');
    expect(text(await pdf(page, { page: 'a5' }))).toContain('/MediaBox[0 0 419.53 595.28]');
    const m = text(await pdf(page, { page: 'a4', margin: 36 }));
    expect(m).toContain('/MediaBox[0 0 595.28 841.89]');
    expect(m).toMatch(/q 3[0-9.]+ 0 0 [0-9.]+ [0-9.]+ [0-9.]+ cm/); // image scaled down inside the margins
    await exec(page, 'canvas_size', { w: 300, h: 100 });
    expect(text(await pdf(page, { page: 'letter' }))).toContain('/MediaBox[0 0 792.00 612.00]');
  });

  test('File › Export as PDF opens the dialog on PDF with its page options and downloads a .pdf', async ({ page }) => {
    await gotoLumen(page); await blank(page, 300, 200, '#336699');
    await page.click('[data-menu="File"]');
    await page.locator('[data-dd="File"] button', { hasText: 'Export as PDF' }).click();
    await expect(page.locator('.lm-fmt[data-f="pdf"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#xp')).toBeVisible();
    await expect(page.locator('#xm')).toBeVisible();
    await expect(page.locator('#xf')).toBeHidden();
    await page.check('#xall');
    await expect(page.locator('#xf')).toBeVisible(); // frame rate / length appear for the all-frames option
    await page.uncheck('#xall');
    await page.selectOption('#xp', 'a4');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xgo')]);
    expect(dl.suggestedFilename()).toMatch(/\.pdf$/);
    const path = await dl.path();
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(path);
    expect(buf.subarray(0, 8).toString('latin1')).toMatch(/^%PDF-1\.4/);
    expect(buf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });

  test('the command API exports a PDF data URL', async ({ page }) => {
    await gotoLumen(page); await blank(page, 100, 100, '#ffffff');
    const url = await exec(page, 'export', { format: 'pdf', page: 'a4' });
    expect(url.startsWith('data:application/pdf')).toBe(true);
    expect(Buffer.from(url.split(',')[1], 'base64').toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    const png = await exec(page, 'export', { format: 'png' });
    expect(png.startsWith('data:image/png')).toBe(true);
  });
});

test.describe('help', () => {
  test('the command list documents the new commands for Claude', async ({ page }) => {
    await gotoLumen(page);
    const cmds = Object.keys((await exec(page, 'help')).commands);
    for (const c of ['select_wand', 'select_rect', 'select_ellipse', 'select_poly', 'fill_selection', 'bucket', 'gradient', 'filter', 'rotate_canvas', 'flip_canvas', 'add_clip', 'remove_clip', 'selection_to_layer']) expect(cmds).toContain(c);
  });
});
