// LUMEN tools — selections (marquee / lasso / magic select), fills, gradients, filters, canvas
// transforms and the retouch brushes (blur, sharpen, smudge, dodge, burn, clone).
// Extends LumenEngine: adds methods to Doc and commands to the shared command API, so the UI,
// the tests and Claude all reach them through doc.exec(...). Load after engine.js.
(function () {
  "use strict";
  const E = window.LumenEngine;
  const { Doc, COMMANDS, done, newLayer, mk, cloneCv, isRaster, toLocal, drawLayer, layoutText } = E;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? d : Number(v));

  // ---------- doc space <-> layer bitmap space ----------
  /** make ctx draw in doc coordinates onto a layer bitmap (handles move, scale, rotate, flip) */
  function docToLayer(ctx, L) {
    const sx = L._cv.width / L.w, sy = L._cv.height / L.h;
    ctx.scale(sx, sy); ctx.translate(L.w / 2, L.h / 2);
    ctx.scale(L.flipX ? -1 : 1, L.flipY ? -1 : 1); ctx.rotate((-L.rot * Math.PI) / 180);
    ctx.translate(-(L.x + L.w / 2), -(L.y + L.h / 2));
  }
  /** the selection as an alpha mask the size of a layer's bitmap */
  function layerMask(doc, L) {
    const cv = mk(L._cv.width, L._cv.height), c = cv.getContext("2d");
    docToLayer(c, L); c.drawImage(doc.selMask, 0, 0);
    return cv;
  }
  /** run fn(canvas) on a layer's bitmap, keeping the result only inside the selection */
  function maskedEdit(doc, L, fn) {
    const cv = L._cv;
    if (!doc.selMask) { fn(cv); doc.touch(L); return; }
    const before = cloneCv(cv); fn(cv);
    const m = layerMask(doc, L), c = cv.getContext("2d");
    const nw = cloneCv(cv), nc = nw.getContext("2d"); nc.globalCompositeOperation = "destination-in"; nc.drawImage(m, 0, 0);
    const bc = before.getContext("2d"); bc.globalCompositeOperation = "destination-out"; bc.drawImage(m, 0, 0);
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = "copy"; c.drawImage(before, 0, 0);
    c.globalCompositeOperation = "source-over"; c.drawImage(nw, 0, 0); c.restore();
    doc.touch(L);
  }
  /** the layer a pixel tool should work on: the selected raster layer, a rasterized text/shape, or a fresh paint layer */
  function pixelTarget(doc, a) {
    let L = doc.L(a.id);
    if (L && !isRaster(L)) { COMMANDS.rasterize.call(doc, { id: L.id, live: true }); L = doc.L(); }
    if (!L) { COMMANDS.add_draw.call(doc, { live: true }); L = doc.L(); }
    if (L.locked) throw new Error("layer is locked: " + L.name);
    return L;
  }

  // ---------- selection ----------
  Doc.prototype.hasSel = function () { return !!this.selMask; };
  /** bounding box of the selection in doc px, or null when nothing is selected */
  Doc.prototype.selBounds = function () {
    if (!this.selMask) return null;
    const k = Math.min(1, 512 / Math.max(this.w, this.h)), w = Math.max(1, Math.round(this.w * k)), h = Math.max(1, Math.round(this.h * k));
    const t = mk(w, h), c = t.getContext("2d", { willReadFrequently: true }); c.drawImage(this.selMask, 0, 0, w, h);
    const d = c.getImageData(0, 0, w, h).data; let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    return { x: Math.floor(x0 / k), y: Math.floor(y0 / k), w: Math.min(this.w, Math.ceil((x1 + 1) / k)) - Math.floor(x0 / k), h: Math.min(this.h, Math.ceil((y1 + 1) / k)) - Math.floor(y0 / k) };
  };
  Doc.prototype.setSel = function (cv) {
    this.selMask = cv; this._ants = null;
    if (cv && !this.selBounds()) this.selMask = null; // an empty selection is no selection
    this.selVer = (this.selVer || 0) + 1;
    this.emit("selection");
  };
  /** merge a freshly painted shape into the selection. paint(ctx) must fill opaque shapes in doc space. */
  function combine(doc, paint, mode) {
    const nm = mk(doc.w, doc.h), c = nm.getContext("2d");
    c.fillStyle = "#000";
    if (mode === "add" && doc.selMask) c.drawImage(doc.selMask, 0, 0);
    if (mode === "subtract") { if (!doc.selMask) return; c.drawImage(doc.selMask, 0, 0); c.globalCompositeOperation = "destination-out"; paint(c); }
    else if (mode === "intersect") {
      if (!doc.selMask) return;
      const t = mk(doc.w, doc.h); paint(t.getContext("2d")); c.drawImage(doc.selMask, 0, 0); c.globalCompositeOperation = "destination-in"; c.drawImage(t, 0, 0);
    } else paint(c);
    doc.setSel(nm);
  }
  const modeOf = (a) => (["add", "subtract", "intersect"].includes(a.mode) ? a.mode : "replace");
  const featherBy = (doc, r) => {
    if (!doc.selMask || r <= 0) return;
    const nm = mk(doc.w, doc.h), c = nm.getContext("2d"); c.filter = `blur(${r}px)`; c.drawImage(doc.selMask, 0, 0); doc.setSel(nm);
  };

  // flood fill over RGBA data, tolerance on RGBA distance. returns a Uint8Array flag per pixel
  function floodFlags(d, w, h, sx, sy, tolPct, contiguous) {
    const o0 = (sy * w + sx) * 4, r0 = d[o0], g0 = d[o0 + 1], b0 = d[o0 + 2], a0 = d[o0 + 3], thr = (tolPct / 100) * 510, thr2 = thr * thr;
    const flags = new Uint8Array(w * h);
    const close = (i) => { const k = i * 4, dr = d[k] - r0, dg = d[k + 1] - g0, db = d[k + 2] - b0, da = d[k + 3] - a0; return dr * dr + dg * dg + db * db + da * da <= thr2; };
    if (!contiguous) { for (let i = 0; i < w * h; i++) if (close(i)) flags[i] = 1; return flags; }
    const stack = [sy * w + sx]; flags[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0 && !flags[i - 1] && close(i - 1)) { flags[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !flags[i + 1] && close(i + 1)) { flags[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !flags[i - w] && close(i - w)) { flags[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !flags[i + w] && close(i + w)) { flags[i + w] = 1; stack.push(i + w); }
    }
    return flags;
  }
  const flagsToCanvas = (flags, w, h) => {
    const cv = mk(w, h), c = cv.getContext("2d"), img = c.createImageData(w, h);
    for (let i = 0; i < flags.length; i++) if (flags[i]) img.data[i * 4 + 3] = 255;
    c.putImageData(img, 0, 0); return cv;
  };
  /** the pixels magic select looks at: the active layer in doc space, or the whole composite */
  function sampleCanvas(doc, a) {
    const cv = mk(doc.w, doc.h), c = cv.getContext("2d");
    const L = a.all ? null : doc.L(a.id);
    if (!L) { if (doc.bg !== "transparent") { c.fillStyle = doc.bg; c.fillRect(0, 0, doc.w, doc.h); } for (const l of doc.layers) drawLayer(c, l, null); }
    else drawLayer(c, { ...L, visible: true, opacity: 1, blend: "source-over", filters: L.filters, shadow: null, anim: { kind: "none", start: 0, end: 1 }, fx: [] }, null);
    return cv;
  }

  Object.assign(COMMANDS, {
    select_all(a) { const m = mk(this.w, this.h), c = m.getContext("2d"); c.fillRect(0, 0, this.w, this.h); this.setSel(m); return this.selBounds(); },
    deselect() { if (this.selMask) this.setSel(null); return true; },
    invert_selection() {
      const m = mk(this.w, this.h), c = m.getContext("2d"); c.fillRect(0, 0, this.w, this.h);
      if (this.selMask) { c.globalCompositeOperation = "destination-out"; c.drawImage(this.selMask, 0, 0); }
      this.setSel(m); return this.selBounds();
    },
    select_rect(a) {
      const x = num(a.x, 0), y = num(a.y, 0), w = num(a.w, this.w), h = num(a.h, this.h);
      combine(this, (c) => c.fillRect(x, y, w, h), modeOf(a)); if (a.feather) featherBy(this, num(a.feather, 0)); return this.selBounds();
    },
    select_ellipse(a) {
      const x = num(a.x, 0), y = num(a.y, 0), w = num(a.w, this.w), h = num(a.h, this.h);
      combine(this, (c) => { c.beginPath(); c.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2); c.fill(); }, modeOf(a)); if (a.feather) featherBy(this, num(a.feather, 0)); return this.selBounds();
    },
    select_poly(a) {
      let pts = a.points; if (typeof pts === "string") pts = JSON.parse(pts);
      if (!Array.isArray(pts) || pts.length < 3) throw new Error("select_poly needs points=[[x,y],…] with at least 3 points");
      combine(this, (c) => { c.beginPath(); pts.forEach((p, i) => c[i ? "lineTo" : "moveTo"](p[0], p[1])); c.closePath(); c.fill(); }, modeOf(a)); if (a.feather) featherBy(this, num(a.feather, 0)); return this.selBounds();
    },
    /** magic select: x= y= tol=0-100 contiguous=true all=true (sample every layer) mode=replace|add|subtract */
    select_wand(a) {
      const src = sampleCanvas(this, a), w = src.width, h = src.height;
      const px = clamp(Math.round(num(a.x, 0)), 0, w - 1), py = clamp(Math.round(num(a.y, 0)), 0, h - 1);
      const d = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      const flags = floodFlags(d, w, h, px, py, num(a.tol, 18), a.contiguous !== false);
      const mk2 = flagsToCanvas(flags, w, h);
      combine(this, (c) => c.drawImage(mk2, 0, 0), modeOf(a));
      if (a.feather) featherBy(this, num(a.feather, 0));
      return this.selBounds();
    },
    feather(a) { featherBy(this, num(a.radius, 4)); return this.selBounds(); },
    /** grow (px>0) or shrink (px<0) the selection edge */
    expand(a) {
      if (!this.selMask) throw new Error("nothing is selected");
      const px = Math.round(num(a.px, 4)), nm = mk(this.w, this.h), c = nm.getContext("2d");
      if (px > 0) { for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2; c.drawImage(this.selMask, Math.cos(t) * px, Math.sin(t) * px); } c.drawImage(this.selMask, 0, 0); }
      else { c.drawImage(this.selMask, 0, 0); c.globalCompositeOperation = "destination-out"; const inv = mk(this.w, this.h), ic = inv.getContext("2d"); ic.fillRect(0, 0, this.w, this.h); ic.globalCompositeOperation = "destination-out"; ic.drawImage(this.selMask, 0, 0); for (let i = 0; i < 16; i++) { const t = (i / 16) * Math.PI * 2; c.drawImage(inv, Math.cos(t) * -px, Math.sin(t) * -px); } }
      this.setSel(nm); return this.selBounds();
    },
    selection() { return this.selBounds(); },
    crop_to_selection(a) {
      const b = this.selBounds(); if (!b) throw new Error("nothing is selected");
      this.setSel(null); return COMMANDS.crop.call(this, { ...a, x: b.x, y: b.y, w: b.w, h: b.h });
    },
    /** fill the selection (or the whole layer) with color= */
    fill_selection(a) {
      const L = pixelTarget(this, a), col = a.color || "#000000";
      maskedEdit(this, L, (cv) => { const c = cv.getContext("2d"); c.save(); c.globalAlpha = clamp(num(a.opacity, 1), 0, 1); c.fillStyle = col; c.fillRect(0, 0, cv.width, cv.height); c.restore(); });
      return done(this, a, "fill", L.id);
    },
    /** erase the pixels inside the selection on the selected layer */
    clear_selection(a) {
      const L = this.need(a.id); if (!isRaster(L)) COMMANDS.rasterize.call(this, { id: L.id, live: true });
      const T = this.L(); if (T.locked) throw new Error("layer is locked: " + T.name);
      maskedEdit(this, T, (cv) => { const c = cv.getContext("2d"); c.save(); c.globalCompositeOperation = "destination-out"; c.fillRect(0, 0, cv.width, cv.height); c.restore(); });
      return done(this, a, "clear selection", T.id);
    },
    /** copy (or cut=true) the selected pixels of the layer onto a new layer — Photoshop's "layer via copy / cut" */
    selection_to_layer(a) {
      const b = this.selBounds(); if (!b) throw new Error("nothing is selected");
      const src = this.need(a.id), flat = mk(this.w, this.h), fc = flat.getContext("2d");
      drawLayer(fc, { ...src, visible: true, opacity: 1, blend: "source-over", shadow: null, anim: { kind: "none", start: 0, end: 1 }, fx: [] }, null);
      fc.globalCompositeOperation = "destination-in"; fc.drawImage(this.selMask, 0, 0);
      const out = mk(b.w, b.h); out.getContext("2d").drawImage(flat, -b.x, -b.y);
      const L = newLayer("image", { name: (src.name || "Layer") + (a.cut ? " cut" : " copy"), x: b.x, y: b.y, w: b.w, h: b.h, _cv: out });
      this.touch(L);
      if (a.cut) {
        const T = isRaster(src) ? src : (COMMANDS.rasterize.call(this, { id: src.id, live: true }), this.L());
        maskedEdit(this, T, (cv) => { const c = cv.getContext("2d"); c.save(); c.globalCompositeOperation = "destination-out"; c.fillRect(0, 0, cv.width, cv.height); c.restore(); });
      }
      const at = this.layers.indexOf(this.L(a.id) || src) + 1;
      this.layers.splice(Math.max(at, 0) || this.layers.length, 0, L); this.sel = L.id;
      return done(this, a, a.cut ? "cut to layer" : "copy to layer", L.id);
    },
    /** paint bucket: x= y= color= tol= contiguous= */
    bucket(a) {
      const L = pixelTarget(this, a), cv = L._cv, q = toLocal(L, num(a.x, 0), num(a.y, 0));
      const px = clamp(Math.round((q.x / L.w) * cv.width), 0, cv.width - 1), py = clamp(Math.round((q.y / L.h) * cv.height), 0, cv.height - 1);
      let filled = 0;
      maskedEdit(this, L, (c2) => {
        const c = c2.getContext("2d", { willReadFrequently: true }), img = c.getImageData(0, 0, c2.width, c2.height), d = img.data;
        const flags = floodFlags(d, c2.width, c2.height, px, py, num(a.tol, 24), a.contiguous !== false);
        const tmp = mk(1, 1).getContext("2d"); tmp.fillStyle = a.color || "#000000"; tmp.fillRect(0, 0, 1, 1); const f = tmp.getImageData(0, 0, 1, 1).data;
        const op = clamp(num(a.opacity, 1), 0, 1);
        for (let i = 0; i < flags.length; i++) if (flags[i]) { const k = i * 4; d[k] = d[k] * (1 - op) + f[0] * op; d[k + 1] = d[k + 1] * (1 - op) + f[1] * op; d[k + 2] = d[k + 2] * (1 - op) + f[2] * op; d[k + 3] = Math.max(d[k + 3], 255 * op); filled++; }
        c.putImageData(img, 0, 0);
      });
      return done(this, a, "bucket fill", { filled });
    },
    /** gradient: x0= y0= x1= y1= from= to= kind=linear|radial (to may be "transparent") */
    gradient(a) {
      const L = pixelTarget(this, a), x0 = num(a.x0, 0), y0 = num(a.y0, 0), x1 = num(a.x1, this.w), y1 = num(a.y1, this.h);
      const from = a.from || "#000000", to = a.to || "#ffffff";
      maskedEdit(this, L, (cv) => {
        const c = cv.getContext("2d"); c.save(); docToLayer(c, L);
        const g = a.kind === "radial" ? c.createRadialGradient(x0, y0, 0, x0, y0, Math.max(1, Math.hypot(x1 - x0, y1 - y0))) : c.createLinearGradient(x0, y0, x1, y1);
        const stop = (col) => (col === "transparent" ? "rgba(0,0,0,0)" : col);
        const fromT = from === "transparent", toT = to === "transparent";
        // fade to/from transparent keeps the visible end's colour so the ramp doesn't go grey
        g.addColorStop(0, fromT && !toT ? hexAlpha(to) : stop(from)); g.addColorStop(1, toT && !fromT ? hexAlpha(from) : stop(to));
        c.globalAlpha = clamp(num(a.opacity, 1), 0, 1); c.fillStyle = g; c.fillRect(-1e5, -1e5, 2e5 + this.w, 2e5 + this.h); c.restore();
      });
      return done(this, a, "gradient", L.id);
    },
    /** filter: name= amount= — blur sharpen noise pixelate emboss edges posterize threshold invert desaturate sepia solarize vignette auto_contrast */
    filter(a) {
      const name = String(a.name || ""); if (!FILTERS[name]) throw new Error(`unknown filter "${name}" — try: ${Object.keys(FILTERS).join(", ")}`);
      const L = pixelTarget(this, a), amount = num(a.amount, FILTERS[name].def);
      maskedEdit(this, L, (cv) => {
        const c = cv.getContext("2d", { willReadFrequently: true }), W = cv.width, H = cv.height;
        if (FILTERS[name].canvas) { FILTERS[name].canvas(c, W, H, amount); return; }
        const img = c.getImageData(0, 0, W, H); FILTERS[name].run(img, W, H, amount); c.putImageData(img, 0, 0);
      });
      return done(this, a, "filter " + name, L.id);
    },
    flip_canvas(a) {
      const h = (a.axis || "h") !== "v", W = this.w, H = this.h;
      for (const L of this.layers) {
        if (L.type === "draw") { const t = cloneCv(L._cv), c = L._cv.getContext("2d"); c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, t.width, t.height); c.translate(h ? t.width : 0, h ? 0 : t.height); c.scale(h ? -1 : 1, h ? 1 : -1); c.drawImage(t, 0, 0); c.restore(); this.touch(L); continue; }
        if (h) { L.x = W - (L.x + L.w); L.flipX = !L.flipX; } else { L.y = H - (L.y + L.h); L.flipY = !L.flipY; }
        L.rot = -L.rot;
      }
      this.setSel(null);
      return done(this, a, "flip canvas", { w: W, h: H });
    },
    rotate_canvas(a) {
      const deg = (((Math.round(num(a.deg, 90) / 90) * 90) % 360) + 360) % 360; if (!deg) return { w: this.w, h: this.h };
      const W = this.w, H = this.h, quarter = deg === 90 || deg === 270, nW = quarter ? H : W, nH = quarter ? W : H;
      for (const L of this.layers) {
        if (L.type === "draw") {
          const t = cloneCv(L._cv), n = mk(quarter ? t.height : t.width, quarter ? t.width : t.height), c = n.getContext("2d");
          c.translate(n.width / 2, n.height / 2); c.rotate((deg * Math.PI) / 180); c.drawImage(t, -t.width / 2, -t.height / 2);
          L._cv = n; L.w = nW; L.h = nH; L.x = 0; L.y = 0; this.touch(L); continue;
        }
        const cx = L.x + L.w / 2, cy = L.y + L.h / 2; let nx, ny;
        if (deg === 90) { nx = H - cy; ny = cx; } else if (deg === 180) { nx = W - cx; ny = H - cy; } else { nx = cy; ny = W - cx; }
        L.x = nx - L.w / 2; L.y = ny - L.h / 2; L.rot = (L.rot + deg) % 360;
      }
      this.w = nW; this.h = nH; this.setSel(null);
      return done(this, a, "rotate canvas", { w: nW, h: nH });
    },
  });
  function hexAlpha(col) { // the same colour at zero alpha (rgba) when it is a #rrggbb, else transparent black
    const m = /^#([0-9a-f]{6})$/i.exec(col || ""); if (!m) return "rgba(0,0,0,0)";
    const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},0)`;
  }

  // selection edits ride along with every state change that resizes the canvas
  for (const name of ["new", "crop", "canvas_size"]) {
    const orig = COMMANDS[name];
    COMMANDS[name] = function (a) { if (this.selMask) { this.selMask = null; this._ants = null; this.selVer = (this.selVer || 0) + 1; } return orig.call(this, a); };
  }

  // undo/redo can change the canvas size, so a selection from the other size can't survive it
  const baseRestore = Doc.prototype.restore;
  Doc.prototype.restore = function (entry) {
    const w = this.w, h = this.h;
    baseRestore.call(this, entry);
    if (this.selMask && (w !== this.w || h !== this.h)) { this.selMask = null; this._ants = null; this.selVer = (this.selVer || 0) + 1; }
  };

  // ---------- filters ----------
  function boxBlur(d, w, h, r, passes = 3) {
    if (r < 1) return;
    const tmp = new Uint8ClampedArray(d.length);
    for (let p = 0; p < passes; p++) { blurPass(d, tmp, w, h, r, true); blurPass(tmp, d, w, h, r, false); }
  }
  function blurPass(src, dst, w, h, r, horiz) {
    const len = horiz ? w : h, lines = horiz ? h : w, sStep = horiz ? 4 : w * 4, lStep = horiz ? w * 4 : 4, win = 2 * r + 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lStep;
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[base + clamp(i, 0, len - 1) * sStep + c];
        for (let i = 0; i < len; i++) {
          dst[base + i * sStep + c] = acc / win;
          acc += src[base + clamp(i + r + 1, 0, len - 1) * sStep + c] - src[base + clamp(i - r, 0, len - 1) * sStep + c];
        }
      }
    }
  }
  const lum = (d, k) => 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
  function convolve(img, w, h, kern, bias = 0, div = 1) {
    const s = new Uint8ClampedArray(img.data), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const k = (clamp(y + j, 0, h - 1) * w + clamp(x + i, 0, w - 1)) * 4, f = kern[(j + 1) * 3 + i + 1]; r += s[k] * f; g += s[k + 1] * f; b += s[k + 2] * f; }
      const o = (y * w + x) * 4; d[o] = r / div + bias; d[o + 1] = g / div + bias; d[o + 2] = b / div + bias;
    }
  }
  const FILTERS = {
    blur: { def: 4, run(img, w, h, n) { boxBlur(img.data, w, h, Math.max(1, Math.round(n / 1.7)), 3); } },
    sharpen: { def: 100, run(img, w, h, n) { const o = new Uint8ClampedArray(img.data); boxBlur(img.data, w, h, 2, 2); const d = img.data, k = n / 100 * 1.5; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = o[i + c] + (o[i + c] - d[i + c]) * k; for (let i = 3; i < d.length; i += 4) d[i] = o[i]; } },
    noise: { def: 30, run(img, w, h, n) { const d = img.data; for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; const v = (Math.random() + Math.random() + Math.random() - 1.5) * n * 1.7; d[i] += v; d[i + 1] += v; d[i + 2] += v; } } },
    pixelate: { def: 12, run(img, w, h, n) { const s = Math.max(2, Math.round(n)), d = img.data, o = new Uint8ClampedArray(d); for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) { const k = (Math.min(h - 1, y + (s >> 1)) * w + Math.min(w - 1, x + (s >> 1))) * 4; for (let j = y; j < Math.min(h, y + s); j++) for (let i = x; i < Math.min(w, x + s); i++) { const t = (j * w + i) * 4; d[t] = o[k]; d[t + 1] = o[k + 1]; d[t + 2] = o[k + 2]; d[t + 3] = o[k + 3]; } } } },
    emboss: { def: 100, run(img, w, h) { convolve(img, w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 128); } },
    edges: { def: 100, run(img, w, h) { convolve(img, w, h, [-1, -1, -1, -1, 8, -1, -1, -1, -1], 0); const d = img.data; for (let i = 0; i < d.length; i += 4) { const v = 255 - lum(d, i) * 2; d[i] = d[i + 1] = d[i + 2] = v; } } },
    posterize: { def: 4, run(img, w, h, n) { const L = Math.max(2, Math.round(n)) - 1, d = img.data; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.round((d[i + c] / 255) * L) * (255 / L); } },
    threshold: { def: 128, run(img, w, h, n) { const d = img.data; for (let i = 0; i < d.length; i += 4) { const v = lum(d, i) >= n ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } } },
    invert: { def: 100, run(img) { const d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } } },
    desaturate: { def: 100, run(img, w, h, n) { const d = img.data, k = clamp(n, 0, 100) / 100; for (let i = 0; i < d.length; i += 4) { const v = lum(d, i); for (let c = 0; c < 3; c++) d[i + c] += (v - d[i + c]) * k; } } },
    sepia: { def: 100, run(img, w, h, n) { const d = img.data, k = clamp(n, 0, 100) / 100; for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; d[i] += (0.393 * r + 0.769 * g + 0.189 * b - r) * k; d[i + 1] += (0.349 * r + 0.686 * g + 0.168 * b - g) * k; d[i + 2] += (0.272 * r + 0.534 * g + 0.131 * b - b) * k; } } },
    solarize: { def: 128, run(img, w, h, n) { const d = img.data; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) if (d[i + c] > n) d[i + c] = 255 - d[i + c]; } },
    auto_contrast: { def: 100, run(img) { const d = img.data; let lo = 255, hi = 0; for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; const v = lum(d, i); if (v < lo) lo = v; if (v > hi) hi = v; } if (hi <= lo) return; const k = 255 / (hi - lo); for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = (d[i + c] - lo) * k; } },
    vignette: { def: 60, canvas(c, W, H, n) { const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${clamp(n, 0, 100) / 100})`); c.save(); c.globalCompositeOperation = "source-atop"; c.fillStyle = g; c.fillRect(0, 0, W, H); c.restore(); } },
  };

  // ---------- retouch brushes ----------
  /** per-stroke state: a before-snapshot + layer mask when a selection must restrain the stroke */
  Doc.prototype.strokeStart = function (L, kind, opt = {}) {
    const st = { kind };
    if (this.selMask) { st.before = cloneCv(L._cv); st.mask = layerMask(this, L); }
    if (kind === "clone") { st.snap = cloneCv(L._cv); st.off = opt.off || { x: 0, y: 0 }; }
    return st;
  };
  /** after a dab: put back whatever the stroke changed outside the selection (only the touched box is rewritten) */
  Doc.prototype.strokeClip = function (L, st, pts, size) {
    if (!st || !st.mask) return;
    const sx = L._cv.width / L.w, sy = L._cv.height / L.h, loc = pts.map((p) => toLocal(L, p.x, p.y));
    const pad = size * 1.6 * Math.max(sx, sy) + 4;
    const x0 = clamp(Math.floor(Math.min(...loc.map((p) => p.x * sx)) - pad), 0, L._cv.width), y0 = clamp(Math.floor(Math.min(...loc.map((p) => p.y * sy)) - pad), 0, L._cv.height);
    const x1 = clamp(Math.ceil(Math.max(...loc.map((p) => p.x * sx)) + pad), 0, L._cv.width), y1 = clamp(Math.ceil(Math.max(...loc.map((p) => p.y * sy)) + pad), 0, L._cv.height);
    const w = x1 - x0, h = y1 - y0; if (w < 1 || h < 1) return;
    const crop = (cv) => { const t = mk(w, h); t.getContext("2d").drawImage(cv, x0, y0, w, h, 0, 0, w, h); return t; };
    const m = crop(st.mask), cur = crop(L._cv), bef = crop(st.before);
    const cc = cur.getContext("2d"); cc.globalCompositeOperation = "destination-in"; cc.drawImage(m, 0, 0);
    const bc = bef.getContext("2d"); bc.globalCompositeOperation = "destination-out"; bc.drawImage(m, 0, 0);
    const c = L._cv.getContext("2d"); c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(x0, y0, w, h); c.drawImage(bef, x0, y0); c.drawImage(cur, x0, y0); c.restore();
  };
  /** modes: blur sharpen smudge dodge burn clone. pts are doc-space points; br = { size, hardness, strength(0-1) } */
  Doc.prototype.retouch = function (L, pts, br, st) {
    if (!isRaster(L) || !L._cv) return;
    const cv = L._cv, ctx = cv.getContext("2d", { willReadFrequently: true }), sx = cv.width / L.w, sy = cv.height / L.h, scale = (sx + sy) / 2;
    const r = Math.max(1, (br.size * scale) / 2), step = Math.max(1, r / 3), strength = clamp(br.strength ?? 0.5, 0.02, 1), hard = clamp((br.hardness ?? 50) / 100, 0, 1);
    const loc = pts.map((p) => { const q = toLocal(L, p.x, p.y); return { x: q.x * sx, y: q.y * sy }; });
    const stamp = (cx, cy) => {
      const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r)), x1 = Math.min(cv.width, Math.ceil(cx + r)), y1 = Math.min(cv.height, Math.ceil(cy + r)), w = x1 - x0, h = y1 - y0;
      if (w < 1 || h < 1) return;
      const img = ctx.getImageData(x0, y0, w, h), d = img.data, o = new Uint8ClampedArray(d);
      let src = null;
      if (br.mode === "clone") { const sc = st.snap.getContext("2d", { willReadFrequently: true }); const sxp = Math.round(x0 + st.off.x * sx), syp = Math.round(y0 + st.off.y * sy); src = sc.getImageData(clamp(sxp, 0, cv.width - 1), clamp(syp, 0, cv.height - 1), Math.min(w, cv.width - clamp(sxp, 0, cv.width - 1)), Math.min(h, cv.height - clamp(syp, 0, cv.height - 1))); src.dx = sxp - clamp(sxp, 0, cv.width - 1); src.dy = syp - clamp(syp, 0, cv.height - 1); }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const dist = Math.hypot(x0 + i + 0.5 - cx, y0 + j + 0.5 - cy) / r; if (dist > 1) continue;
        const fall = dist < hard ? 1 : 1 - (dist - hard) / Math.max(0.001, 1 - hard), wgt = clamp(fall, 0, 1) * strength, k = (j * w + i) * 4;
        if (br.mode === "blur" || br.mode === "sharpen") {
          let ar = 0, ag = 0, ab = 0, n = 0;
          for (let b = -1; b <= 1; b++) for (let a2 = -1; a2 <= 1; a2++) { const ii = clamp(i + a2, 0, w - 1), jj = clamp(j + b, 0, h - 1), kk = (jj * w + ii) * 4; ar += o[kk]; ag += o[kk + 1]; ab += o[kk + 2]; n++; }
          ar /= n; ag /= n; ab /= n;
          if (br.mode === "blur") { d[k] = o[k] + (ar - o[k]) * wgt; d[k + 1] = o[k + 1] + (ag - o[k + 1]) * wgt; d[k + 2] = o[k + 2] + (ab - o[k + 2]) * wgt; }
          else { d[k] = o[k] + (o[k] - ar) * wgt * 2; d[k + 1] = o[k + 1] + (o[k + 1] - ag) * wgt * 2; d[k + 2] = o[k + 2] + (o[k + 2] - ab) * wgt * 2; }
        } else if (br.mode === "dodge") { const f = 1 + 0.35 * wgt; d[k] = o[k] * f + 12 * wgt; d[k + 1] = o[k + 1] * f + 12 * wgt; d[k + 2] = o[k + 2] * f + 12 * wgt; }
        else if (br.mode === "burn") { const f = 1 - 0.35 * wgt; d[k] = o[k] * f; d[k + 1] = o[k + 1] * f; d[k + 2] = o[k + 2] * f; }
        else if (br.mode === "smudge") {
          if (st.carry && st.carry[j * w + i]) { const c = st.carry[j * w + i], m = wgt * 0.85; d[k] = o[k] + (c[0] - o[k]) * m; d[k + 1] = o[k + 1] + (c[1] - o[k + 1]) * m; d[k + 2] = o[k + 2] + (c[2] - o[k + 2]) * m; d[k + 3] = o[k + 3] + (c[3] - o[k + 3]) * m; }
        } else if (br.mode === "clone" && src) {
          const si = i + src.dx, sj = j + src.dy; if (si < 0 || sj < 0 || si >= src.width || sj >= src.height) continue;
          const sk = (sj * src.width + si) * 4, m = clamp(fall, 0, 1); for (let c = 0; c < 4; c++) d[k + c] = o[k + c] + (src.data[sk + c] - o[k + c]) * m;
        }
      }
      if (br.mode === "smudge") { // remember the pixels under the brush so the next dab drags them along
        const c = []; for (let q = 0; q < w * h; q++) c.push([d[q * 4], d[q * 4 + 1], d[q * 4 + 2], d[q * 4 + 3]]);
        st.carry = c; st.carryW = w;
      }
      ctx.putImageData(img, x0, y0);
    };
    for (let s = 0; s < loc.length; s++) {
      const a = loc[s], b = loc[s + 1] || null;
      if (!b) { if (loc.length === 1) stamp(a.x, a.y); continue; }
      const len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(len / step));
      for (let i = 1; i <= n; i++) stamp(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
    }
  };

  // ---------- Select-menu / selection overlay helper: the marching-ants edge, drawn once per selection change ----------
  /** a small canvas holding the selection outline (1px edges) — the UI scales it over the board */
  Doc.prototype.antsEdge = function () {
    if (!this.selMask) return null;
    if (this._ants && this._ants.ver === this.selVer) return this._ants;
    const k = Math.min(1, 900 / Math.max(this.w, this.h)), w = Math.max(1, Math.round(this.w * k)), h = Math.max(1, Math.round(this.h * k));
    const t = mk(w, h), c = t.getContext("2d", { willReadFrequently: true }); c.drawImage(this.selMask, 0, 0, w, h);
    const d = c.getImageData(0, 0, w, h).data, on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127;
    const pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y) && (!on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1))) pts.push(x, y);
    this._ants = { ver: this.selVer, k, w, h, pts }; return this._ants;
  };

  // ---------- help ----------
  const baseHelp = COMMANDS.help;
  COMMANDS.help = function () {
    const h = baseHelp.call(this);
    Object.assign(h.commands, {
      select_all: "", deselect: "", invert_selection: "", select_rect: "x= y= w= h= mode=replace|add|subtract|intersect feather=", select_ellipse: "x= y= w= h= mode= feather=",
      select_poly: "points=[[x,y],…] mode=", select_wand: "x= y= tol=0-100 contiguous=true all=false mode=  (magic select by colour)", feather: "radius=", expand: "px=  (negative shrinks)", selection: "bounds of the selection or null",
      crop_to_selection: "", fill_selection: "color= opacity=", clear_selection: "erase pixels inside the selection", selection_to_layer: "cut=true|false  (layer via copy / cut)",
      bucket: "x= y= color= tol= contiguous=", gradient: "x0= y0= x1= y1= from= to= kind=linear|radial", filter: "name=" + Object.keys(FILTERS).join("|") + " amount=",
      flip_canvas: "axis=h|v", rotate_canvas: "deg=90|180|270", add_clip: "id= kind= start= end=  (stack another animation on a layer)", remove_clip: "id= index=",
      export: "format=png|jpg|webp|pdf scale=  returns a data URL",
    });
    return h;
  };
  // export as PDF over the command API too (returns a data URL)
  const baseExport = COMMANDS.export;
  COMMANDS.export = async function (a) {
    if (a.format !== "pdf") return baseExport.call(this, a);
    if (!window.LumenExport) throw new Error("PDF export is not loaded");
    const r = await window.LumenExport.run(this, { format: "pdf", scale: a.scale || 1, quality: a.quality ?? 0.92, page: a.page || "fit" });
    return await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(r.blob); });
  };

  E.FILTERS = FILTERS; E.layerMask = layerMask; E.maskedEdit = maskedEdit; E.docToLayer = docToLayer;
})();
