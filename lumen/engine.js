// LUMEN engine — the document model, layer rendering, history and command API.
// No DOM beyond <canvas>. Exposes window.LumenEngine = { COMMANDS, done, newLayer, norm, clipsOf, Doc, PRESETS, FONTS, BLENDS, ANIMS, ... }.
// Every edit goes through Doc.exec(cmd, args) so the UI, tests and Claude share one path.
(function () {
  "use strict";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (n, d = 2) => { const k = Math.pow(10, d); return Math.round(n * k) / k; };
  let UID = 0, VER = 0;
  const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const cloneCv = (src) => { const c = mk(src.width, src.height); c.getContext("2d").drawImage(src, 0, 0); return c; };

  const FILTERS0 = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0, gray: 0, sepia: 0, invert: 0 };
  const BLENDS = ["source-over", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"];
  const FONTS = ["Segoe UI", "Arial", "Georgia", "Impact", "Trebuchet MS", "Verdana", "Times New Roman", "Courier New", "Comic Sans MS", "system-ui"];
  const EMOJI_STACK = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  const SHAPES = ["rect", "ellipse", "triangle", "star", "line"];
  const ANIMS = ["none", "fade-in", "fade-out", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "pulse", "spin", "bounce", "wiggle"];
  const PRESETS = [
    { id: "billboard", name: "Billboard 48-sheet", w: 6000, h: 2000, cat: "Billboard" },
    { id: "ig-post", name: "Instagram post", w: 1080, h: 1080, cat: "Social" },
    { id: "yt-thumb", name: "YouTube thumbnail", w: 1280, h: 720, cat: "Social" },
    { id: "story", name: "Story / Reel", w: 1080, h: 1920, cat: "Social" },
    { id: "a4", name: "A4 poster", w: 2480, h: 3508, cat: "Print" },
    { id: "hd", name: "HD video", w: 1920, h: 1080, cat: "Video" },
    { id: "gif", name: "Looping GIF", w: 800, h: 600, cat: "GIF" },
    { id: "4k", name: "4K video", w: 3840, h: 2160, cat: "Video" },
  ];

  // ---------- helpers ----------
  const filterStr = (f) => {
    const p = [];
    if (f.brightness !== 100) p.push(`brightness(${f.brightness}%)`);
    if (f.contrast !== 100) p.push(`contrast(${f.contrast}%)`);
    if (f.saturate !== 100) p.push(`saturate(${f.saturate}%)`);
    if (f.hue) p.push(`hue-rotate(${f.hue}deg)`);
    if (f.blur) p.push(`blur(${f.blur}px)`);
    if (f.gray) p.push(`grayscale(${f.gray}%)`);
    if (f.sepia) p.push(`sepia(${f.sepia}%)`);
    if (f.invert) p.push(`invert(${f.invert}%)`);
    return p.join(" ");
  };
  const isRaster = (L) => L.type === "image" || L.type === "draw";
  const ease = (p) => 1 - Math.pow(1 - p, 3);

  function newLayer(type, o) {
    return Object.assign({
      id: "l" + (++UID), name: type, type, visible: true, locked: false, opacity: 1, blend: "source-over",
      x: 0, y: 0, w: 100, h: 100, rot: 0, flipX: false, flipY: false,
      filters: { ...FILTERS0 }, shadow: null, anim: { kind: "none", start: 0, end: 1 },
    }, o);
  }

  const mctx = mk(1, 1).getContext("2d");
  const fontStr = (L) => `${L.italic ? "italic " : ""}${L.bold ? "700 " : "400 "}${L.size}px "${L.font}", ${EMOJI_STACK}`;
  function layoutText(L) {
    mctx.font = fontStr(L);
    const lines = String(L.text).split("\n");
    let mw = 0;
    for (const s of lines) mw = Math.max(mw, mctx.measureText(s).width);
    L._lh = L.size * L.lineH;
    L._lines = lines;
    L.w = Math.ceil(mw + L.size * 0.2 + (L.strokeW || 0) * 2);
    L.h = Math.ceil(L._lh * lines.length + L.size * 0.1 + (L.strokeW || 0) * 2);
  }

  function oneAnim(an, t) {
    const n = { a: 1, dx: 0, dy: 0, s: 1, r: 0 };
    if (t == null || !an || an.kind === "none") return n;
    const dur = Math.max(0.05, an.end - an.start);
    const p = clamp((t - an.start) / dur, 0, 1), e = ease(p);
    const ph = Math.max(0, t - an.start);
    switch (an.kind) {
      case "fade-in": n.a = e; break;
      case "fade-out": n.a = 1 - e; break;
      case "slide-left": n.dx = (1 - e) * 300; n.a = e; break;
      case "slide-right": n.dx = -(1 - e) * 300; n.a = e; break;
      case "slide-up": n.dy = (1 - e) * 300; n.a = e; break;
      case "slide-down": n.dy = -(1 - e) * 300; n.a = e; break;
      case "zoom-in": n.s = Math.max(0.001, e); n.a = e; break;
      case "pulse": if (t >= an.start && t <= an.end) n.s = 1 + 0.08 * Math.sin(ph * Math.PI * 2); break;
      case "spin": if (t >= an.start) n.r = ((ph / dur) * 360) % 360; break;
      case "bounce": if (t >= an.start && t <= an.end) n.dy = -Math.abs(Math.sin(ph * Math.PI * 2)) * 40; break;
      case "wiggle": if (t >= an.start && t <= an.end) n.r = Math.sin(ph * Math.PI * 4) * 6; break;
    }
    return n;
  }
  /** every clip on a layer: the main one (L.anim) first, then any extras (L.fx) */
  const clipsOf = (L) => [L.anim, ...(L.fx || [])].filter(Boolean);
  function animAt(L, t) {
    const n = { a: 1, dx: 0, dy: 0, s: 1, r: 0 };
    if (t == null) return n;
    for (const an of clipsOf(L)) { const m = oneAnim(an, t); n.a *= m.a; n.dx += m.dx; n.dy += m.dy; n.s *= m.s; n.r += m.r; }
    return n;
  }

  function starPath(ctx, w, h) {
    const cx = 0, cy = 0, R = Math.min(w, h) / 2, r = R * 0.45;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? r : R;
      ctx[i ? "lineTo" : "moveTo"](cx + Math.cos(a) * rad * (w / Math.min(w, h)), cy + Math.sin(a) * rad * (h / Math.min(w, h)));
    }
    ctx.closePath();
  }

  function paintContent(ctx, L) {
    const w = L.w, h = L.h;
    if (isRaster(L)) { if (L._cv) ctx.drawImage(L._cv, -w / 2, -h / 2, w, h); return; }
    if (L.type === "text") {
      ctx.font = fontStr(L); ctx.textBaseline = "top";
      ctx.textAlign = L.align; ctx.fillStyle = L.color;
      const sx = L.align === "left" ? -w / 2 + L.size * 0.1 + L.strokeW : L.align === "right" ? w / 2 - L.size * 0.1 - L.strokeW : 0;
      L._lines.forEach((s, i) => {
        const y = -h / 2 + L.strokeW + L.size * 0.05 + i * L._lh;
        if (L.strokeW > 0) { ctx.lineWidth = L.strokeW * 2; ctx.strokeStyle = L.stroke; ctx.lineJoin = "round"; ctx.strokeText(s, sx, y); }
        ctx.fillText(s, sx, y);
      });
      return;
    }
    if (L.type === "shape") {
      ctx.fillStyle = L.fill; ctx.strokeStyle = L.stroke; ctx.lineWidth = L.strokeW; ctx.lineJoin = "round"; ctx.lineCap = "round";
      const sw = L.strokeW / 2;
      if (L.shape === "rect") {
        const r = clamp(L.radius, 0, Math.min(w, h) / 2);
        ctx.beginPath();
        if (r > 0) ctx.roundRect(-w / 2 + sw, -h / 2 + sw, w - L.strokeW, h - L.strokeW, r); else ctx.rect(-w / 2 + sw, -h / 2 + sw, w - L.strokeW, h - L.strokeW);
      } else if (L.shape === "ellipse") { ctx.beginPath(); ctx.ellipse(0, 0, Math.max(0.1, w / 2 - sw), Math.max(0.1, h / 2 - sw), 0, 0, Math.PI * 2); }
      else if (L.shape === "triangle") { ctx.beginPath(); ctx.moveTo(0, -h / 2 + sw); ctx.lineTo(w / 2 - sw, h / 2 - sw); ctx.lineTo(-w / 2 + sw, h / 2 - sw); ctx.closePath(); }
      else if (L.shape === "star") starPath(ctx, w - L.strokeW, h - L.strokeW);
      else if (L.shape === "line") { ctx.beginPath(); ctx.moveTo(-w / 2 + sw, 0); ctx.lineTo(w / 2 - sw, 0); ctx.strokeStyle = L.stroke; ctx.lineWidth = Math.max(1, L.strokeW); ctx.stroke(); return; }
      if (L.fill && L.fill !== "transparent") ctx.fill();
      if (L.strokeW > 0) ctx.stroke();
    }
  }

  function drawLayer(ctx, L, t) {
    if (!L.visible) return;
    const an = animAt(L, t);
    if (an.a <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = clamp(L.opacity * an.a, 0, 1);
    ctx.globalCompositeOperation = L.blend;
    const f = filterStr(L.filters);
    if (f) ctx.filter = f;
    if (L.shadow) { ctx.shadowColor = L.shadow.color; ctx.shadowBlur = L.shadow.blur; ctx.shadowOffsetX = L.shadow.x; ctx.shadowOffsetY = L.shadow.y; }
    ctx.translate(L.x + L.w / 2 + an.dx, L.y + L.h / 2 + an.dy);
    ctx.rotate(((L.rot + an.r) * Math.PI) / 180);
    ctx.scale((L.flipX ? -1 : 1) * an.s, (L.flipY ? -1 : 1) * an.s);
    paintContent(ctx, L);
    ctx.restore();
  }

  /** point (doc space) → layer box space (0..w, 0..h) */
  function toLocal(L, x, y) {
    const dx = x - (L.x + L.w / 2), dy = y - (L.y + L.h / 2), a = (-L.rot * Math.PI) / 180;
    const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
    return { x: (L.flipX ? -rx : rx) + L.w / 2, y: (L.flipY ? -ry : ry) + L.h / 2 };
  }
  function corners(L) {
    const cx = L.x + L.w / 2, cy = L.y + L.h / 2, a = (L.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [[-L.w / 2, -L.h / 2], [L.w / 2, -L.h / 2], [L.w / 2, L.h / 2], [-L.w / 2, L.h / 2]].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
  }

  // ---------- flood erase ----------
  function floodErase(cv, seeds, tolPct, contiguous) {
    const w = cv.width, h = cv.height, ctx = cv.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h), d = img.data, thr = (tolPct / 100) * 441.7;
    const seen = new Uint8Array(w * h);
    let erased = 0;
    for (const [sx, sy] of seeds) {
      const px = clamp(Math.round(sx), 0, w - 1), py = clamp(Math.round(sy), 0, h - 1);
      const o = (py * w + px) * 4, r0 = d[o], g0 = d[o + 1], b0 = d[o + 2];
      const close = (i) => { const k = i * 4; const dr = d[k] - r0, dg = d[k + 1] - g0, db = d[k + 2] - b0; return d[k + 3] > 0 && Math.sqrt(dr * dr + dg * dg + db * db) <= thr; };
      if (!contiguous) {
        for (let i = 0; i < w * h; i++) if (!seen[i] && close(i)) { seen[i] = 1; d[i * 4 + 3] = 0; erased++; }
        continue;
      }
      const stack = [py * w + px];
      if (seen[stack[0]] || !close(stack[0])) continue;
      seen[stack[0]] = 1;
      while (stack.length) {
        const i = stack.pop(); d[i * 4 + 3] = 0; erased++;
        const x = i % w, y = (i / w) | 0;
        if (x > 0 && !seen[i - 1] && close(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
        if (x < w - 1 && !seen[i + 1] && close(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && !seen[i - w] && close(i - w)) { seen[i - w] = 1; stack.push(i - w); }
        if (y < h - 1 && !seen[i + w] && close(i + w)) { seen[i + w] = 1; stack.push(i + w); }
      }
    }
    ctx.putImageData(img, 0, 0);
    return erased;
  }

  function loadImage(src) {
    return new Promise((ok, bad) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => bad(new Error("could not load image"));
      im.src = src;
    });
  }
  function imageToCanvas(im, maxSide = 8192) {
    const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    const c = mk(im.naturalWidth * k, im.naturalHeight * k);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    return c;
  }

  const NUM_KEYS = new Set(["x", "y", "w", "h", "rot", "opacity", "size", "lineH", "strokeW", "radius", "brightness", "contrast", "saturate", "hue", "blur", "gray", "sepia", "invert", "tol", "scale", "quality", "fps", "duration", "start", "end", "t", "index", "cx", "cy", "cw", "ch", "dpi"]);
  function norm(a) {
    const o = {};
    for (const k in a) {
      let v = a[k];
      if (typeof v === "string") {
        if (NUM_KEYS.has(k) && v.trim() !== "" && !isNaN(Number(v))) v = Number(v);
        else if (v === "true") v = true; else if (v === "false") v = false;
      }
      o[k] = v;
    }
    return o;
  }

  // ---------- the document ----------
  class Doc {
    constructor(w = 1920, h = 1080, bg = "#ffffff") {
      this.w = w; this.h = h; this.bg = bg; this.duration = 4; this.fps = 12;
      this.layers = []; this.sel = null; this.hist = []; this.hi = -1; this.store = new Map();
      this.listeners = [];
      this.commit("new");
    }
    on(fn) { this.listeners.push(fn); }
    emit(kind, label) { for (const f of this.listeners) f(kind, label); }

    // ----- lookup -----
    L(ref) {
      const key = ref ?? this.sel;
      if (key == null) return null;
      return this.layers.find((l) => l.id === key) || this.layers.find((l) => l.name === key) || null;
    }
    need(ref) { const L = this.L(ref); if (!L) throw new Error("no such layer: " + (ref ?? "(nothing selected)")); return L; }
    hit(x, y) {
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const L = this.layers[i];
        if (!L.visible || L.locked || L.type === "draw") continue;
        const p = toLocal(L, x, y);
        if (p.x < 0 || p.y < 0 || p.x > L.w || p.y > L.h) continue;
        if (L.type === "image" && L._cv) {
          const px = clamp(Math.floor((p.x / L.w) * L._cv.width), 0, L._cv.width - 1), py = clamp(Math.floor((p.y / L.h) * L._cv.height), 0, L._cv.height - 1);
          if (L._cv.getContext("2d", { willReadFrequently: true }).getImageData(px, py, 1, 1).data[3] < 12) continue;
        }
        return L;
      }
      return null;
    }

    // ----- history -----
    plain(l) {
      const o = {};
      for (const k in l) if (k[0] !== "_") o[k] = l[k];
      if (isRaster(l)) o.ver = l._ver;
      return o;
    }
    meta() { return JSON.stringify({ w: this.w, h: this.h, bg: this.bg, duration: this.duration, fps: this.fps, sel: this.sel, layers: this.layers.map((l) => this.plain(l)) }); }
    touch(L) { L._ver = ++VER; L._src = null; }
    commit(label) {
      if (this._restoring) return;
      for (const l of this.layers) if (isRaster(l) && l._cv && !this.store.has(l._ver)) this.store.set(l._ver, cloneCv(l._cv));
      this.hist.length = this.hi + 1;
      this.hist.push({ label, meta: this.meta(), vers: this.layers.filter(isRaster).map((l) => l._ver) });
      this.hi++;
      while (this.hist.length > 30) { this.hist.shift(); this.hi--; }
      const keep = new Set(); for (const h of this.hist) for (const v of h.vers) keep.add(v);
      for (const k of [...this.store.keys()]) if (!keep.has(k)) this.store.delete(k);
      this.emit("commit", label);
    }
    restore(entry) {
      const m = JSON.parse(entry.meta);
      this.w = m.w; this.h = m.h; this.bg = m.bg; this.duration = m.duration; this.fps = m.fps; this.sel = m.sel;
      this.layers = m.layers.map((o) => {
        const L = Object.assign({}, o);
        if (isRaster(L)) { L._ver = L.ver; delete L.ver; L._cv = cloneCv(this.store.get(L._ver)); }
        if (L.type === "text") layoutText(L);
        return L;
      });
      if (this.sel && !this.L(this.sel)) this.sel = null;
      this.emit("restore");
    }
    undo() { if (this.hi > 0) { this.hi--; this.restore(this.hist[this.hi]); return true; } return false; }
    redo() { if (this.hi < this.hist.length - 1) { this.hi++; this.restore(this.hist[this.hi]); return true; } return false; }
    get canUndo() { return this.hi > 0; }
    get canRedo() { return this.hi < this.hist.length - 1; }

    // ----- rendering -----
    render(ctx, t = null, opts = {}) {
      if (!opts.noBg && this.bg !== "transparent") { ctx.fillStyle = this.bg; ctx.fillRect(0, 0, this.w, this.h); }
      for (const L of this.layers) drawLayer(ctx, L, t);
    }
    renderToCanvas(scale = 1, t = null, opts = {}) {
      const c = mk(this.w * scale, this.h * scale), ctx = c.getContext("2d");
      if (opts.flatten) { ctx.fillStyle = opts.flatten; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.scale(scale, scale);
      this.render(ctx, t, opts);
      return c;
    }
    pixel(x, y) {
      const c = this.renderToCanvas(1);
      const d = c.getContext("2d").getImageData(clamp(Math.round(x), 0, c.width - 1), clamp(Math.round(y), 0, c.height - 1), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3], hex: "#" + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("") };
    }

    // ----- serialization -----
    toJSON() {
      return JSON.stringify({
        lumen: 1, w: this.w, h: this.h, bg: this.bg, duration: this.duration, fps: this.fps, sel: this.sel,
        layers: this.layers.map((l) => {
          const o = this.plain(l); delete o.ver;
          if (isRaster(l)) { if (!l._src) l._src = l._cv.toDataURL("image/png"); o.src = l._src; }
          return o;
        }),
      });
    }
    async load(json) {
      const m = typeof json === "string" ? JSON.parse(json) : json;
      if (!m || !m.lumen) throw new Error("not a LUMEN project");
      this.w = m.w; this.h = m.h; this.bg = m.bg; this.duration = m.duration || 4; this.fps = m.fps || 12; this.sel = m.sel || null;
      const out = [];
      for (const o of m.layers) {
        const L = Object.assign({}, o);
        if (isRaster(L)) { const im = await loadImage(L.src); L._cv = imageToCanvas(im); L._ver = ++VER; L._src = L.src; delete L.src; }
        if (L.type === "text") layoutText(L);
        out.push(L);
      }
      this.layers = out;
      if (this.sel && !this.L(this.sel)) this.sel = null;
      this.hist = []; this.hi = -1; this.store.clear();
      this.commit("open");
      this.emit("restore");
    }

    // ----- helpers for commands -----
    add(L, a, label) {
      this.layers.push(L); this.sel = L.id;
      if (a.name) L.name = a.name;
      if (!a.live) this.commit(label);
      else this.emit("live");
      return L;
    }
    centre(L, a) {
      L.x = a.x != null ? a.x : Math.round((this.w - L.w) / 2);
      L.y = a.y != null ? a.y : Math.round((this.h - L.h) / 2);
    }
    rasterize(ids, name) {
      const list = this.layers.filter((l) => ids.includes(l.id));
      const cv = mk(this.w, this.h), ctx = cv.getContext("2d");
      for (const l of list) drawLayer(ctx, { ...l, visible: true }, null);
      const first = this.layers.indexOf(list[0]);
      const L = newLayer("image", { name, x: 0, y: 0, w: this.w, h: this.h, _cv: cv, _ver: ++VER });
      this.layers = this.layers.filter((l) => !ids.includes(l.id));
      this.layers.splice(Math.min(first, this.layers.length), 0, L);
      return L;
    }
    resizeBitmap(L, nw, nh, ox, oy, scale) {
      const c = mk(nw, nh), ctx = c.getContext("2d");
      if (scale) ctx.drawImage(L._cv, 0, 0, nw, nh); else ctx.drawImage(L._cv, ox, oy);
      L._cv = c; L.w = nw; L.h = nh; L.x = 0; L.y = 0; this.touch(L);
    }

    // ----- brush (called by the UI while painting) -----
    paintStroke(L, pts, br) {
      if (!isRaster(L) || !L._cv) return;
      const sx = L._cv.width / L.w, sy = L._cv.height / L.h;
      const ctx = L._cv.getContext("2d");
      ctx.save();
      ctx.globalCompositeOperation = br.erase ? "destination-out" : "source-over";
      ctx.globalAlpha = br.opacity;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      const loc = pts.map((p) => { const q = toLocal(L, p.x, p.y); return { x: q.x * sx, y: q.y * sy }; });
      const size = br.size * ((sx + sy) / 2);
      ctx.strokeStyle = br.color; ctx.fillStyle = br.color; ctx.lineWidth = size;
      if (br.hardness < 100) { ctx.shadowColor = br.erase ? "#000" : br.color; ctx.shadowBlur = size * (1 - br.hardness / 100) * 0.6; }
      if (loc.length === 1) { ctx.beginPath(); ctx.arc(loc[0].x, loc[0].y, size / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(loc[0].x, loc[0].y); for (let i = 1; i < loc.length; i++) ctx.lineTo(loc[i].x, loc[i].y); ctx.stroke(); }
      ctx.restore();
    }

    // ----- command API -----
    exec(cmd, args = {}) {
      const fn = COMMANDS[cmd];
      if (!fn) throw new Error(`unknown command "${cmd}" — try: help`);
      return fn.call(this, norm(args || {}));
    }
    describe() {
      return {
        canvas: { w: this.w, h: this.h, bg: this.bg }, duration: this.duration, fps: this.fps, selected: this.sel,
        layers: this.layers.map((l) => {
          const o = { id: l.id, name: l.name, type: l.type, visible: l.visible, locked: l.locked, x: rnd(l.x), y: rnd(l.y), w: rnd(l.w), h: rnd(l.h), rot: rnd(l.rot), opacity: rnd(l.opacity), blend: l.blend };
          if (l.type === "text") Object.assign(o, { text: l.text, font: l.font, size: l.size, color: l.color });
          if (l.type === "shape") Object.assign(o, { shape: l.shape, fill: l.fill, stroke: l.stroke });
          if (l.anim.kind !== "none") o.anim = l.anim;
          if (l.fx && l.fx.length) o.fx = l.fx;
          const f = {}; for (const k in l.filters) if (l.filters[k] !== FILTERS0[k]) f[k] = l.filters[k];
          if (Object.keys(f).length) o.filters = f;
          return o;
        }).reverse(), // top layer first, like the panel
      };
    }
  }

  const SET_BASIC = ["name", "visible", "locked", "opacity", "blend", "x", "y", "w", "h", "rot", "flipX", "flipY"];
  const SET_TEXT = ["text", "font", "size", "color", "bold", "italic", "align", "lineH", "stroke", "strokeW"];
  const SET_SHAPE = ["shape", "fill", "stroke", "strokeW", "radius"];

  function applyProps(L, a) {
    for (const k of SET_BASIC) if (a[k] !== undefined) L[k] = a[k];
    L.opacity = clamp(L.opacity, 0, 1);
    if (!BLENDS.includes(L.blend)) L.blend = "source-over";
    if (L.type === "text") {
      for (const k of SET_TEXT) if (a[k] !== undefined) L[k] = a[k];
      L.text = String(L.text); L.size = clamp(L.size, 1, 4000);
      layoutText(L); // text boxes always hug their text, so w/h follow size
    }
    if (L.type === "shape") for (const k of SET_SHAPE) if (a[k] !== undefined) L[k] = a[k];
    if (L.type === "shape" && !SHAPES.includes(L.shape)) L.shape = "rect";
    for (const k in FILTERS0) if (a[k] !== undefined) L.filters[k] = a[k];
    if (a.filters) Object.assign(L.filters, a.filters);
    if (a.shadow !== undefined) L.shadow = a.shadow === false || a.shadow === null ? null : Object.assign({ color: "rgba(0,0,0,.5)", blur: 12, x: 4, y: 4 }, L.shadow || {}, a.shadow === true ? {} : a.shadow);
    if (a.anim !== undefined) L.anim = Object.assign({}, L.anim, typeof a.anim === "string" ? { kind: a.anim } : a.anim);
    if (a.animKind !== undefined) L.anim.kind = a.animKind;
    if (a.start !== undefined) L.anim.start = a.start;
    if (a.end !== undefined) L.anim.end = a.end;
    if (!ANIMS.includes(L.anim.kind)) L.anim.kind = "none";
  }

  const done = (d, a, label, ret) => { if (!a.live) d.commit(label); else d.emit("live"); return ret; };

  const COMMANDS = {
    help() {
      return {
        info: "Canvas origin is top-left, units are pixels. Layer ref = id or exact name (default: selected).",
        commands: {
          state: "read the whole document (always run first)",
          new: "w= h= bg=#fff|transparent  start a blank project",
          add_text: "text= x= y= size= color= font= bold= italic= align=left|center|right stroke= strokeW=  (emoji work)",
          add_shape: "shape=rect|ellipse|triangle|star|line x= y= w= h= fill= stroke= strokeW= radius=",
          add_image: "src=<data/blob/same-origin url> name= fit=contain|cover|none",
          add_draw: "an empty paint layer",
          set: "id= then any of: name visible locked opacity blend x y w h rot flipX flipY text font size color bold italic align stroke strokeW shape fill radius brightness contrast saturate hue blur gray sepia invert shadow= anim=<kind> start= end=",
          adjust: "id= brightness= contrast= saturate= hue= blur= gray= sepia= invert=  (100 = unchanged for the first three)",
          select: "id=", delete: "id=", duplicate: "id=", rename: "id= name=",
          reorder: "id= dir=up|down|top|bottom", align: "id= to=left|hcenter|right|top|vcenter|bottom|center", fit: "id= mode=contain|cover",
          remove_bg: "id= tol=0-100 [x= y= contiguous=true]  erase a background colour from an image/paint layer",
          crop: "x= y= w= h=  crop the canvas", canvas_size: "w= h= scale=true|false", bg: "color=#hex|transparent",
          merge_down: "id=", flatten: "", rasterize: "id=  turn text/shape into pixels",
          animate: "id= kind=" + ANIMS.join("|") + " start= end=", duration: "seconds= fps=",
          undo: "", redo: "", get_pixel: "x= y=", export: "format=png|jpg|webp scale=  returns a data URL",
        },
      };
    },
    state() { return this.describe(); },
    new(a) {
      this.w = clamp(a.w || 1920, 1, 12000); this.h = clamp(a.h || 1080, 1, 12000); this.bg = a.bg || "#ffffff";
      this.layers = []; this.sel = null; this.hist = []; this.hi = -1; this.store.clear();
      this.commit("new"); this.emit("restore");
      return this.describe();
    },
    clear(a) { return COMMANDS.new.call(this, { w: this.w, h: this.h, bg: this.bg, ...a }); },
    bg(a) { this.bg = a.color || "#ffffff"; return done(this, a, "background", this.bg); },
    add_text(a) {
      const L = newLayer("text", { name: "Text", text: String(a.text ?? "Text"), font: a.font || FONTS[0], size: a.size || Math.round(this.h / 10), color: a.color || "#111111", bold: !!a.bold, italic: !!a.italic, align: a.align || "left", lineH: a.lineH || 1.2, stroke: a.stroke || "#000000", strokeW: a.strokeW || 0 });
      layoutText(L); this.centre(L, a);
      applyProps(L, { opacity: a.opacity, rot: a.rot });
      if (a.shadow) applyProps(L, { shadow: a.shadow });
      L.name = a.name || String(L.text).split("\n")[0].slice(0, 24) || "Text";
      return this.add(L, a, "add text").id;
    },
    add_shape(a) {
      const shape = SHAPES.includes(a.shape) ? a.shape : "rect";
      const L = newLayer("shape", { name: a.name || shape[0].toUpperCase() + shape.slice(1), shape, fill: a.fill || (shape === "line" ? "transparent" : "#f2a33a"), stroke: a.stroke || (shape === "line" ? "#f2a33a" : "#ffffff"), strokeW: a.strokeW ?? (shape === "line" ? 6 : 0), radius: a.radius || 0, w: Math.max(2, a.w || this.w / 4), h: Math.max(shape === "line" ? 2 : 2, a.h || (shape === "line" ? 6 : this.h / 4)) });
      this.centre(L, a); applyProps(L, { opacity: a.opacity, rot: a.rot });
      return this.add(L, a, "add shape").id;
    },
    add_draw(a) {
      const L = newLayer("draw", { name: a.name || "Paint", w: this.w, h: this.h, _cv: mk(this.w, this.h), _ver: ++VER });
      return this.add(L, a, "add paint layer").id;
    },
    async add_image(a) {
      if (!a.src) throw new Error("add_image needs src=<data url or blob url>");
      const im = await loadImage(a.src);
      const cv = imageToCanvas(im);
      const L = newLayer("image", { name: a.name || "Image", _cv: cv, _ver: ++VER });
      const fit = a.fit || "contain";
      let k = 1;
      if (fit === "contain") k = Math.min(this.w / cv.width, this.h / cv.height, 1);
      else if (fit === "cover") k = Math.max(this.w / cv.width, this.h / cv.height);
      L.w = Math.round(cv.width * k); L.h = Math.round(cv.height * k);
      this.centre(L, a);
      return this.add(L, a, "add image").id;
    },
    set(a) {
      const L = this.need(a.id);
      applyProps(L, a);
      return done(this, a, "edit " + L.name, a.live ? true : this.describe().layers.find((l) => l.id === L.id));
    },
    adjust(a) { return COMMANDS.set.call(this, a); },
    animate(a) {
      const L = this.need(a.id), i = a.index | 0;
      if (i > 0) { // an extra clip (L.fx[i-1]) — the timeline can stack several effects on one layer
        const c = (L.fx || [])[i - 1]; if (!c) throw new Error("no such clip: " + i);
        if (a.kind !== undefined && ANIMS.includes(a.kind)) c.kind = a.kind;
        if (a.start !== undefined) c.start = Math.max(0, a.start);
        if (a.end !== undefined) c.end = Math.max(c.start + 0.05, a.end);
        return done(this, a, "animate", c);
      }
      applyProps(L, { anim: { kind: a.kind ?? L.anim.kind, start: a.start ?? L.anim.start, end: a.end ?? L.anim.end } }); return done(this, a, "animate", L.anim);
    },
    add_clip(a) { // stack another effect on a layer: kind= start= end=
      const L = this.need(a.id), kind = ANIMS.includes(a.kind) && a.kind !== "none" ? a.kind : "fade-in";
      const start = Math.max(0, a.start ?? 0), end = Math.max(start + 0.05, a.end ?? start + 1);
      if (L.anim.kind === "none") { L.anim = { kind, start, end }; return done(this, a, "add clip", { index: 0 }); }
      L.fx = L.fx || []; L.fx.push({ kind, start, end });
      return done(this, a, "add clip", { index: L.fx.length });
    },
    remove_clip(a) { // index= (0 = the main clip)
      const L = this.need(a.id), i = a.index | 0;
      if (i > 0) { if (!(L.fx || [])[i - 1]) throw new Error("no such clip: " + i); L.fx.splice(i - 1, 1); }
      else if (L.fx && L.fx.length) L.anim = L.fx.shift();
      else L.anim = { kind: "none", start: 0, end: 1 };
      return done(this, a, "remove clip", true);
    },
    duration(a) { if (a.seconds) this.duration = clamp(a.seconds, 0.5, 120); if (a.fps) this.fps = clamp(Math.round(a.fps), 1, 60); return done(this, a, "timeline", { duration: this.duration, fps: this.fps }); },
    rename(a) { const L = this.need(a.id); L.name = String(a.name || L.name); return done(this, a, "rename", L.name); },
    select(a) { this.sel = a.id == null ? null : this.need(a.id).id; this.emit("select"); return this.sel; },
    delete(a) { const L = this.need(a.id); this.layers = this.layers.filter((l) => l !== L); if (this.sel === L.id) this.sel = this.layers.length ? this.layers[this.layers.length - 1].id : null; return done(this, a, "delete layer", true); },
    duplicate(a) {
      const L = this.need(a.id), C = Object.assign({}, L, { id: "l" + (++UID), name: L.name + " copy", x: L.x + 20, y: L.y + 20, filters: { ...L.filters }, anim: { ...L.anim }, fx: (L.fx || []).map((c) => ({ ...c })), shadow: L.shadow ? { ...L.shadow } : null });
      if (isRaster(L)) { C._cv = cloneCv(L._cv); C._ver = ++VER; C._src = null; }
      if (L.type === "text") C._lines = L._lines.slice();
      this.layers.splice(this.layers.indexOf(L) + 1, 0, C); this.sel = C.id;
      return done(this, a, "duplicate", C.id);
    },
    reorder(a) {
      const L = this.need(a.id), i = this.layers.indexOf(L), n = this.layers.length;
      let j = a.index != null ? clamp(a.index, 0, n - 1) : a.dir === "up" ? i + 1 : a.dir === "down" ? i - 1 : a.dir === "top" ? n - 1 : a.dir === "bottom" ? 0 : i;
      j = clamp(j, 0, n - 1);
      this.layers.splice(i, 1); this.layers.splice(j, 0, L);
      return done(this, a, "reorder", j);
    },
    align(a) {
      const L = this.need(a.id), to = a.to || "center";
      if (["left"].includes(to)) L.x = 0; if (["right"].includes(to)) L.x = this.w - L.w;
      if (["hcenter", "center"].includes(to)) L.x = Math.round((this.w - L.w) / 2);
      if (to === "top") L.y = 0; if (to === "bottom") L.y = this.h - L.h;
      if (["vcenter", "center"].includes(to)) L.y = Math.round((this.h - L.h) / 2);
      return done(this, a, "align", { x: L.x, y: L.y });
    },
    fit(a) {
      const L = this.need(a.id), ar = L.w / L.h, mode = a.mode || "contain";
      const k = mode === "cover" ? Math.max(this.w / L.w, this.h / L.h) : Math.min(this.w / L.w, this.h / L.h);
      if (L.type === "text") { L.size = clamp(Math.round(L.size * k), 1, 4000); layoutText(L); } else { L.w = Math.round(L.w * k); L.h = Math.round(L.h * k); }
      L.x = Math.round((this.w - L.w) / 2); L.y = Math.round((this.h - L.h) / 2); void ar;
      return done(this, a, "fit", { w: L.w, h: L.h });
    },
    remove_bg(a) {
      const L = this.need(a.id);
      if (!isRaster(L)) throw new Error("remove_bg works on image or paint layers — use rasterize first for text/shapes");
      const sx = L._cv.width / L.w, sy = L._cv.height / L.h, tol = a.tol ?? 18;
      let seeds;
      if (a.x != null && a.y != null) { const p = toLocal(L, a.x, a.y); seeds = [[p.x * sx, p.y * sy]]; }
      else seeds = [[0, 0], [L._cv.width - 1, 0], [0, L._cv.height - 1], [L._cv.width - 1, L._cv.height - 1]];
      const n = floodErase(L._cv, seeds, tol, a.contiguous !== false);
      this.touch(L);
      return done(this, a, "remove background", { erasedPixels: n });
    },
    rasterize(a) {
      const L = this.need(a.id); if (isRaster(L)) return L.id;
      const R = this.rasterize([L.id], L.name); this.sel = R.id;
      return done(this, a, "rasterize", R.id);
    },
    merge_down(a) {
      const L = this.need(a.id), i = this.layers.indexOf(L);
      if (i < 1) throw new Error("nothing below to merge into");
      const R = this.rasterize([L.id, this.layers[i - 1].id], this.layers[i - 1].name + " merged"); this.sel = R.id;
      return done(this, a, "merge down", R.id);
    },
    flatten(a) {
      if (!this.layers.length) return null;
      const R = this.rasterize(this.layers.map((l) => l.id), "Flattened"); this.sel = R.id;
      return done(this, a, "flatten", R.id);
    },
    crop(a) {
      const x = Math.round(clamp(a.x ?? 0, 0, this.w - 1)), y = Math.round(clamp(a.y ?? 0, 0, this.h - 1));
      const w = Math.round(clamp(a.w ?? this.w - x, 1, this.w - x)), h = Math.round(clamp(a.h ?? this.h - y, 1, this.h - y));
      for (const L of this.layers) { if (L.type === "draw") this.resizeBitmap(L, w, h, -x, -y, false); else { L.x -= x; L.y -= y; } }
      this.w = w; this.h = h;
      return done(this, a, "crop", { w, h });
    },
    canvas_size(a) {
      const w = Math.round(clamp(a.w || this.w, 1, 12000)), h = Math.round(clamp(a.h || this.h, 1, 12000));
      const kx = w / this.w, ky = h / this.h;
      for (const L of this.layers) {
        if (L.type === "draw") this.resizeBitmap(L, w, h, 0, 0, !!a.scale);
        else if (a.scale) { L.x *= kx; L.y *= ky; L.w *= kx; L.h *= ky; if (L.type === "text") { L.size = clamp(Math.round(L.size * Math.min(kx, ky)), 1, 4000); layoutText(L); } }
      }
      this.w = w; this.h = h;
      return done(this, a, "canvas size", { w, h });
    },
    undo() { return this.undo(); },
    redo() { return this.redo(); },
    get_pixel(a) { return this.pixel(a.x || 0, a.y || 0); },
    async export(a) {
      const fmt = a.format === "jpg" || a.format === "jpeg" ? "image/jpeg" : a.format === "webp" ? "image/webp" : "image/png";
      const c = this.renderToCanvas(a.scale || 1, a.t ?? null, fmt === "image/jpeg" ? { flatten: this.bg === "transparent" ? "#ffffff" : this.bg } : {});
      return c.toDataURL(fmt, a.quality ?? 0.92);
    },
  };

  window.LumenEngine = { COMMANDS, done, newLayer, norm, clipsOf, Doc, PRESETS, FONTS, BLENDS, ANIMS, SHAPES, FILTERS0, EMOJI_STACK, mk, cloneCv, drawLayer, toLocal, corners, layoutText, isRaster, loadImage, filterStr, animAt };
})();
