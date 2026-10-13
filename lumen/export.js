// LUMEN exporters — animated GIF (own LZW encoder), WebM video (MediaRecorder) and PDF
// (hand-built, embeds a JPEG). No dependencies. Exposes window.LumenExport.
(function () {
  "use strict";
  const { mk } = window.LumenEngine;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const blobOf = (cv, type, q) => new Promise((ok) => cv.toBlob(ok, type, q));

  // ---------- GIF ----------
  function medianCut(px, n) {
    let boxes = [px];
    while (boxes.length < n) {
      let bi = -1, best = 0;
      boxes.forEach((b, i) => { if (b.length > 1 && b.length > best) { best = b.length; bi = i; } });
      if (bi < 0) break;
      const b = boxes[bi];
      let mn = [255, 255, 255], mx = [0, 0, 0];
      for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
      const rg = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]], ch = rg.indexOf(Math.max(...rg));
      b.sort((p, q) => p[ch] - q[ch]);
      const mid = b.length >> 1;
      boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
    }
    return boxes.map((b) => {
      const s = [0, 0, 0]; for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
      return s.map((v) => Math.round(v / b.length));
    });
  }

  function lzw(indices, minCode) {
    const clear = 1 << minCode, eoi = clear + 1, out = [];
    let size = minCode + 1, next = eoi + 1, dict = new Map(), cur = 0, bits = 0;
    const emit = (c) => { cur |= c << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = (prefix << 8) | k, v = dict.get(key);
      if (v !== undefined) { prefix = v; continue; }
      emit(prefix);
      if (next === 4096) { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
      else { if (next >= 1 << size) size++; dict.set(key, next++); }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (bits > 0) out.push(cur & 255);
    return out;
  }

  /** frames: array of ImageData (same size). delayMs per frame. */
  function gifEncode(frames, w, h, delayMs) {
    const transparent = frames.some((f) => { for (let i = 3; i < f.data.length; i += 4 * 7) if (f.data[i] < 128) return true; return false; });
    const palSize = transparent ? 255 : 256, sample = [];
    const stride = Math.max(1, Math.floor((w * h * frames.length) / 30000));
    frames.forEach((f, fi) => { for (let i = 0; i < w * h; i += stride) { const k = i * 4; if (f.data[k + 3] >= 128) sample.push([f.data[k], f.data[k + 1], f.data[k + 2]]); } void fi; });
    let pal = sample.length ? medianCut(sample, palSize) : [[0, 0, 0]];
    while (pal.length < 256) pal.push([0, 0, 0]);
    const tIdx = transparent ? 255 : 0, cache = new Int16Array(32768).fill(-1);
    const nearest = (r, g, b) => {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (cache[key] >= 0) return cache[key];
      let bi = 0, bd = 1e9;
      for (let i = 0; i < palSize && i < pal.length; i++) { const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b, d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; bi = i; } }
      return (cache[key] = bi);
    };
    const out = [], u16 = (n) => out.push(n & 255, (n >> 8) & 255), str = (s) => { for (const c of s) out.push(c.charCodeAt(0)); };
    str("GIF89a"); u16(w); u16(h); out.push(0xf7, 0, 0);
    for (const p of pal) out.push(p[0], p[1], p[2]);
    out.push(0x21, 0xff, 11); str("NETSCAPE2.0"); out.push(3, 1, 0, 0, 0);
    const delay = Math.max(2, Math.round(delayMs / 10));
    for (const f of frames) {
      const idx = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) { const k = i * 4; idx[i] = f.data[k + 3] < 128 ? tIdx : nearest(f.data[k], f.data[k + 1], f.data[k + 2]); }
      out.push(0x21, 0xf9, 4, (2 << 2) | (transparent ? 1 : 0)); u16(delay); out.push(tIdx, 0);
      out.push(0x2c); u16(0); u16(0); u16(w); u16(h); out.push(0, 8);
      const data = lzw(idx, 8);
      for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(data[i + j]); }
      out.push(0);
    }
    out.push(0x3b);
    return new Blob([new Uint8Array(out)], { type: "image/gif" });
  }

  async function exportGif(doc, { scale = 1, fps = doc.fps, duration = doc.duration, onProgress } = {}) {
    const n = Math.max(1, Math.round(fps * duration)), frames = [];
    const w = Math.max(1, Math.round(doc.w * scale)), h = Math.max(1, Math.round(doc.h * scale));
    for (let i = 0; i < n; i++) {
      const c = doc.renderToCanvas(scale, (i / n) * duration);
      frames.push(c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height));
      if (onProgress) onProgress(i / n);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r));
    }
    return gifEncode(frames, w, h, 1000 / fps);
  }

  // ---------- WebM ----------
  async function exportWebM(doc, { scale = 1, fps = 24, duration = doc.duration, onProgress } = {}) {
    if (typeof MediaRecorder === "undefined") throw new Error("this browser cannot record video");
    const cv = mk(doc.w * scale, doc.h * scale), ctx = cv.getContext("2d");
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("WebM recording is not supported here");
    const rec = new MediaRecorder(cv.captureStream(fps), { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    const frame = (t) => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.scale(scale, scale); doc.render(ctx, t); };
    frame(0); rec.start();
    const n = Math.max(1, Math.round(fps * duration));
    for (let i = 0; i < n; i++) {
      frame((i / n) * duration);
      if (onProgress) onProgress(i / n);
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    rec.stop(); await stopped;
    return new Blob(chunks, { type: "video/webm" });
  }

  // ---------- PDF ----------
  // Hand-built PDF 1.4: one JPEG per page. Sizes are in points (1/72 in). "fit" makes the page exactly the
  // image at `dpi`; the named sizes centre the image on the sheet (landscape/portrait picked from the image).
  const PAGES = { a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], letter: [612, 792], legal: [612, 1008] };
  /** pages: [{ cv: canvas }] — returns a Blob of a valid multi-page PDF */
  async function buildPdf(pages, { page = "fit", quality = 0.92, dpi = 96, margin = 0 } = {}) {
    const enc = new TextEncoder(), parts = [], offs = [];
    let pos = 0;
    const push = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); pos += b.length; };
    const obj = (n, body) => { offs[n] = pos; push(`${n} 0 obj\n${body}\nendobj\n`); };
    const f = (n) => n.toFixed(2);
    const N = pages.length, total = 2 + N * 3;
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<</Type/Catalog/Pages 2 0 R>>");
    obj(2, `<</Type/Pages/Kids[${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}]/Count ${N}>>`);
    for (let i = 0; i < N; i++) {
      const cv = pages[i].cv, jpg = new Uint8Array(await (await blobOf(cv, "image/jpeg", quality)).arrayBuffer());
      let pw, ph, iw, ih, ox = 0, oy = 0;
      if (page === "fit" || !PAGES[page]) { pw = (cv.width * 72) / dpi; ph = (cv.height * 72) / dpi; iw = pw; ih = ph; }
      else {
        const land = cv.width > cv.height, [sw, sh] = PAGES[page]; pw = land ? sh : sw; ph = land ? sw : sh;
        const k = Math.min((pw - 2 * margin) / cv.width, (ph - 2 * margin) / cv.height); iw = cv.width * k; ih = cv.height * k; ox = (pw - iw) / 2; oy = (ph - ih) / 2;
      }
      const pn = 3 + i * 3, im = pn + 1, ct = pn + 2;
      obj(pn, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${f(pw)} ${f(ph)}]/Resources<</XObject<</Im0 ${im} 0 R>>>>/Contents ${ct} 0 R>>`);
      offs[im] = pos;
      push(`${im} 0 obj\n<</Type/XObject/Subtype/Image/Width ${cv.width}/Height ${cv.height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n`);
      push(jpg); push("\nendstream\nendobj\n");
      const content = `q ${f(iw)} 0 0 ${f(ih)} ${f(ox)} ${f(oy)} cm /Im0 Do Q`;
      obj(ct, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    }
    const xref = pos;
    let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= total; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n";
    push(x + `trailer\n<</Size ${total + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: "application/pdf" });
  }
  /** one page (the canvas as it is now), or every animation frame as its own page when allFrames is set */
  async function exportPdf(doc, { page = "fit", scale = 1, quality = 0.92, dpi = 96, margin = 0, allFrames = false, fps = doc.fps, duration = doc.duration, onProgress } = {}) {
    const flatten = doc.bg === "transparent" ? "#ffffff" : doc.bg, pages = [];
    if (!allFrames) pages.push({ cv: doc.renderToCanvas(scale, null, { flatten }) });
    else {
      const n = clamp(Math.round(fps * duration), 1, 600);
      for (let i = 0; i < n; i++) {
        pages.push({ cv: doc.renderToCanvas(scale, (i / n) * duration, { flatten }) });
        if (onProgress) onProgress(i / n);
        if (i % 4 === 3) await new Promise((r) => setTimeout(r));
      }
    }
    return buildPdf(pages, { page, quality, dpi, margin });
  }

  async function exportImage(doc, { format = "png", scale = 1, quality = 0.92 } = {}) {
    const type = format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    const cv = doc.renderToCanvas(scale, null, type === "image/jpeg" ? { flatten: doc.bg === "transparent" ? "#ffffff" : doc.bg } : {});
    return blobOf(cv, type, quality);
  }

  /** one entry point for every format → { blob, ext } */
  async function run(doc, opt) {
    const f = opt.format;
    if (f === "gif") return { blob: await exportGif(doc, opt), ext: "gif" };
    if (f === "webm") return { blob: await exportWebM(doc, opt), ext: "webm" };
    if (f === "pdf") return { blob: await exportPdf(doc, opt), ext: "pdf" };
    return { blob: await exportImage(doc, opt), ext: f };
  }

  window.LumenExport = { run, buildPdf, gifEncode, exportGif, exportWebM, exportPdf, exportImage, clamp };
})();
