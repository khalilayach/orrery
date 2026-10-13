// LUMEN UI — the Darkroom editor: menus, toolbox, canvas, layers, properties, timeline, Claude dock.
// Depends on lumen/engine.js and lumen/export.js. Exposes: LUMEN (the live Doc), openLumen(),
// closeLumen(), lmEscape(), lmOpen.
(function () {
  "use strict";
  const { Doc, PRESETS, FONTS, BLENDS, ANIMS, SHAPES, FILTERS0, toLocal, corners, isRaster, mk } = window.LumenEngine;
  const doc = new Doc(1920, 1080, "#ffffff");
  window.LUMEN = doc;

  const API = "http://127.0.0.1:" + (new URLSearchParams(location.search).get("agents") || "57253");
  const STORE = "lumen-doc-v1";
  const SVGNS = "http://www.w3.org/2000/svg";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (n) => Math.round(n * 100) / 100;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const S = {
    open: false, built: false, tool: "move", zoom: 1, px: 0, py: 0, fg: "#f2a33a", bgc: "#ffffff",
    brush: { size: 24, hardness: 80, opacity: 1 }, shape: "rect", tol: 18, contiguous: true,
    crop: null, drag: null, space: false, t: 0, playing: false, tl: true, mutedClaude: false,
    shapeFill: "#f2a33a", marq: "rect", selMode: "replace", feather: 0, sampleAll: false, strength: 50, bTol: 24, grad: "linear", tlk: 1, loop: true, clip: null,
  };
  let el = {};

  // ---------- icons ----------
  const ICON = {
    move: '<path d="M5 3l14 7-6 2-2 6z"/>',
    crop: '<path d="M6 2v16h16M2 6h16v16"/>',
    brush: '<path d="M9 15c-2 0-3 1-3 3s-1 3-3 3c4 1 8 0 8-4M9 15l10-11 2 2-10 11"/>',
    eraser: '<path d="M4 16l9-10 7 7-6 6H8zM8 20h12"/>',
    text: '<path d="M5 5h14M12 5v14M9 19h6"/>',
    shape: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    wand: '<path d="M4 20L14 10M14 4v3M18 8h3M17 3l1 1M10 4l1 1"/>',
    pick: '<path d="M14 4l6 6M4 20l1-4 9-9 3 3-9 9z"/>',
    hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4a1.5 1.5 0 013 0v7M14 11V6a1.5 1.5 0 013 0v8c0 4-2 7-6 7s-5-3-6-6l-1-3a1.5 1.5 0 013-1l1 2"/>',
    zoom: '<circle cx="10" cy="10" r="6"/><path d="M15 15l5 5"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18M10 6a9 9 0 0112 6 13 13 0 01-3 3.5M6 7.5A13 13 0 002 12s4 7 10 7a9 9 0 004-1"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017-2"/>',
    play: '<path d="M7 4l13 8-13 8z"/>', pause: '<path d="M7 4v16M17 4v16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 16V4h12"/>',
    marquee: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2.4"/>',
    lasso: '<path d="M12 4c5 0 8 2 8 5s-3 5-8 5-8-2-8-5 3-5 8-5zM10 14c-2 2-1 4 1 5"/>',
    pencil: '<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>',
    bgerase: '<path d="M4 16l9-10 7 7-6 6H8zM8 20h12M9 11l4 4"/>',
    clone: '<path d="M8 20h8M12 20v-6M7 14h10l-1-6a4 4 0 00-8 0z"/>',
    blur: '<path d="M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z"/>',
    sharpen: '<path d="M12 4l8 14H4z"/>',
    smudge: '<path d="M5 17c3 0 4-3 7-3s4 3 7 3M5 11c3 0 4-3 7-3s4 3 7 3"/>',
    dodge: '<circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>',
    burn: '<path d="M12 3c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4 0-6 1-9z"/>',
    bucket: '<path d="M5 11l6-6 8 8-6 6zM19 16c1 1.5 1.5 2.5 1.5 3.5a1.5 1.5 0 01-3 0c0-1 .8-2 1.5-3.5zM3 21h8"/>',
    gradient: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18M3 8.5h18M3 15.5h18" opacity=".5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>', prev: '<path d="M18 5l-9 7 9 7zM6 5v14"/>', next: '<path d="M6 5l9 7-9 7zM18 5v14"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  };
  const svg = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
  const TOOLS = [
    ["move", "Move / select (V)", "v"], ["marquee", "Marquee select (M)", "m"], ["lasso", "Lasso select (L)", "l"], ["wand", "Magic select (W)", "w"],
    ["crop", "Crop canvas (C)", "c"], ["pick", "Eyedropper (I)", "i"], ["brush", "Brush (B)", "b"], ["pencil", "Pencil (N)", "n"],
    ["eraser", "Eraser (E)", "e"], ["bgerase", "Remove colour (K)", "k"], ["clone", "Clone stamp (S)", "s"], ["blur", "Blur brush (R)", "r"],
    ["sharpen", "Sharpen brush (A)", "a"], ["smudge", "Smudge (Y)", "y"], ["dodge", "Dodge, lighten (O)", "o"], ["burn", "Burn, darken (Q)", "q"],
    ["bucket", "Paint bucket (G)", "g"], ["gradient", "Gradient (J)", "j"], ["text", "Text (T)", "t"], ["shape", "Shape (U)", "u"],
    ["hand", "Pan (H)", "h"], ["zoom", "Zoom (Z)", "z"],
  ];
  const RETOUCH = new Set(["blur", "sharpen", "smudge", "dodge", "burn", "clone"]);
  const FILTER_UI = {
    blur: ["Blur", "Radius", 1, 60, 4], sharpen: ["Sharpen", "Amount %", 10, 300, 100], noise: ["Add noise", "Amount", 1, 100, 30], pixelate: ["Pixelate", "Block size", 2, 100, 12],
    posterize: ["Posterize", "Levels", 2, 16, 4], threshold: ["Threshold", "Level", 1, 254, 128], desaturate: ["Desaturate", "Amount %", 0, 100, 100], sepia: ["Sepia", "Amount %", 0, 100, 100],
    solarize: ["Solarize", "Level", 1, 254, 128], vignette: ["Vignette", "Strength %", 0, 100, 60], emboss: ["Emboss"], edges: ["Find edges"], invert: ["Invert colours"], auto_contrast: ["Auto contrast"],
  };
  const EMOJI = {
    Faces: "😀😁😂🤣😊😍😘😎🤩🥳😭😡😱🤔🙄😴🤯🥶🥵🤗🙃😇😈🤖👻💀",
    Hands: "👍👎👏🙌🙏💪👋🤝✌️🤞👌🫶☝️👉👈✊",
    Hearts: "❤️🧡💛💚💙💜🖤🤍💔💖💯💥✨⭐🌟🔥💧⚡🎉🎁",
    Nature: "🌞🌙☁️🌈🌸🌹🌻🌲🍀🍎🍕🍔🍟🍩☕🍺🐶🐱🦁🐼🦄🐝🦋",
    Objects: "📷🎬🎵🎮💡📱💻⌚🚗✈️🚀🏠🏆🎯🔔📌🔒🔑💰📈✅❌⚠️➡️",
  };

  // ---------- DOM ----------
  const $ = (s, r = el.root) => r.querySelector(s);
  const $$ = (s, r = el.root) => [...r.querySelectorAll(s)];
  const sel = () => doc.L();
  const status = (m) => { if (el.status) el.status.textContent = m; };

  function build() {
    const root = document.getElementById("lm");
    el.root = root;
    root.innerHTML = `
<div class="lm-menu">
  <span class="lm-logo">LUMEN</span>
  <div class="lm-menus">${["File", "Edit", "Select", "Image", "Filter", "Layer", "Animate"].map((m) => `<div class="lm-mwrap"><button class="lm-mbtn" data-menu="${m}" aria-haspopup="true" aria-expanded="false">${m}</button><div class="lm-dd" data-dd="${m}" role="menu"></div></div>`).join("")}</div>
  <span class="sp"></span>
  <span class="lm-file" id="lmfile"></span>
  <span class="sp"></span>
  <button class="lm-btn" id="lmnew">New</button>
  <button class="lm-btn gold" id="lmexport">Export</button>
  <button id="lmclose" class="lm-close" title="Close (Esc)">× close</button>
</div>
<div class="lm-opts" id="lmopts"></div>
<div class="lm-main">
  <div class="lm-tools" id="lmtools" role="toolbar" aria-label="Tools">
    ${TOOLS.map(([id, tip]) => `<button class="lm-tool" data-tool="${id}" title="${tip}" aria-label="${tip}" aria-pressed="false">${svg(id, 19)}</button>`).join("")}
    <div class="lm-swatch"><label class="bgs" title="Background colour"><input type="color" id="lmbg" value="#ffffff"><span class="fg" id="lmbgs" style="background:#ffffff"></span></label><label title="Foreground colour"><input type="color" id="lmfg" value="#f2a33a"><span class="fg" id="lmfgs"></span></label></div>
  </div>
  <div class="lm-centre">
    <div class="lm-stage" id="lmstage">
      <div class="lm-board" id="lmboard"><canvas id="lmcv"></canvas></div>
      <canvas id="lmov"></canvas>
      <div class="lm-empty" id="lmempty">Drop images here, paste a screenshot (Ctrl+V), or press T to add text</div>
    </div>
    <div class="lm-status"><span id="lmstatus">Ready</span><span class="sp"></span><span id="lmcoords">x 0  y 0</span>
      <button class="lm-mini" id="lmz-" aria-label="Zoom out">−</button><span id="lmzoom" class="lm-zoomv">100%</span><button class="lm-mini" id="lmz+" aria-label="Zoom in">+</button><button class="lm-mini" id="lmfit">Fit</button>
      <button class="lm-mini" id="lmtlt" aria-pressed="true">Timeline</button></div>
    <div class="lm-timeline" id="lmtimeline"></div>
  </div>
  <div class="lm-right">
    <section class="lm-panel"><div class="lm-h">LAYERS<span class="sp"></span>
      <button class="lm-ic" id="lmadd" title="Add paint layer" aria-label="Add paint layer">${svg("plus", 15)}</button>
      <button class="lm-ic" id="lmdup" title="Duplicate (Ctrl+D)" aria-label="Duplicate layer">${svg("copy", 15)}</button>
      <button class="lm-ic" id="lmup" title="Bring forward" aria-label="Bring layer forward">${svg("up", 15)}</button>
      <button class="lm-ic" id="lmdown" title="Send backward" aria-label="Send layer backward">${svg("down", 15)}</button>
      <button class="lm-ic" id="lmdel" title="Delete (Del)" aria-label="Delete layer">${svg("trash", 15)}</button></div>
      <div class="lm-layers" id="lmlayers" role="list"></div></section>
    <section class="lm-panel lm-props" id="props"></section>
    <section class="lm-panel lm-claude" id="lmclaude"></section>
  </div>
</div>
<div class="lm-modal" id="lmmodal" hidden></div>
<input type="file" id="lmfilein" accept="image/*,.lum" multiple hidden>`;
    for (const [k, s] of Object.entries({ stage: "#lmstage", board: "#lmboard", cv: "#lmcv", ov: "#lmov", opts: "#lmopts", layers: "#lmlayers", props: "#props", status: "#lmstatus", coords: "#lmcoords", zoom: "#lmzoom", timeline: "#lmtimeline", modal: "#lmmodal", filein: "#lmfilein", empty: "#lmempty", file: "#lmfile", claude: "#lmclaude" })) el[k] = $(s);
    el.ctx = el.cv.getContext("2d");
    wire();
    buildClaude();
  }

  // ---------- menus ----------
  const hasSel = () => doc.hasSel();
  const exe = (cmd, args) => { try { const r = doc.exec(cmd, args); return r; } catch (e) { status(e.message); } };
  const filterItems = () => Object.keys(FILTER_UI).map((k) => [FILTER_UI[k][0] + (FILTER_UI[k][1] ? "…" : ""), () => filterDialog(k), "", !sel() && !doc.layers.length]);
  const MENUS = {
    File: () => [["New project…", () => newDialog(), "Ctrl+N"], ["Open image / project…", () => el.filein.click(), "Ctrl+O"], ["Save project (.lum)", saveProject, "Ctrl+S"], ["Export…", exportDialog, "Ctrl+E"], ["Export as PDF…", () => exportDialog("pdf"), ""]],
    Edit: () => [["Undo", () => undo(), "Ctrl+Z", !doc.canUndo], ["Redo", () => redo(), "Ctrl+Y", !doc.canRedo], ["Duplicate layer", () => doc.exec("duplicate"), "Ctrl+D", !sel()], ["Delete layer", () => doc.exec("delete"), "Del", !sel()],
      ["Fill selection with foreground", () => exe("fill_selection", { color: S.fg }), "Alt+Backspace"], ["Fill selection with background", () => exe("fill_selection", { color: S.bgc }), "Ctrl+Backspace"], ["Clear selected pixels", () => exe("clear_selection"), "Del", !hasSel() || !sel()], ["Paste text / emoji…", emojiDialog, ""]],
    Select: () => [["All", () => exe("select_all"), "Ctrl+A"], ["Deselect", () => exe("deselect"), "Esc", !hasSel()], ["Inverse", () => exe("invert_selection"), "Ctrl+Shift+I", !hasSel()],
      ["Feather…", featherDialog, "", !hasSel()], ["Grow by 5 px", () => exe("expand", { px: 5 }), "", !hasSel()], ["Shrink by 5 px", () => exe("expand", { px: -5 }), "", !hasSel()],
      ["Layer via copy", () => exe("selection_to_layer"), "Ctrl+J", !hasSel() || !sel()], ["Layer via cut", () => exe("selection_to_layer", { cut: true }), "Ctrl+Shift+J", !hasSel() || !sel()], ["Crop to selection", () => { exe("crop_to_selection"); fit(); }, "", !hasSel()]],
    Image: () => [["Canvas size…", sizeDialog, ""], ["Fit canvas to window", fit, "Ctrl+0"], ["Rotate 90° clockwise", () => { exe("rotate_canvas", { deg: 90 }); fit(); }, ""], ["Rotate 90° counter-clockwise", () => { exe("rotate_canvas", { deg: 270 }); fit(); }, ""], ["Rotate 180°", () => exe("rotate_canvas", { deg: 180 }), ""],
      ["Flip canvas horizontal", () => exe("flip_canvas", { axis: "h" }), ""], ["Flip canvas vertical", () => exe("flip_canvas", { axis: "v" }), ""], ["Flatten image", () => doc.exec("flatten"), ""], ["Crop to canvas selection", () => setTool("crop"), "C"]],
    Filter: filterItems,
    Layer: () => [["New paint layer", () => doc.exec("add_draw"), ""], ["Rasterize", () => doc.exec("rasterize"), "", !sel()], ["Merge down", () => doc.exec("merge_down"), "", !sel()], ["Remove background", () => doc.exec("remove_bg"), "", !sel() || !isRaster(sel())], ["Center on canvas", () => doc.exec("align", { to: "center" }), "", !sel()], ["Fit to canvas", () => doc.exec("fit"), "", !sel()]],
    Animate: () => [["Play / pause", togglePlay, "Space"], ["Add effect at playhead", () => addClipAtPlayhead(), "", !sel()], ["Timeline settings…", timelineDialog, ""], ["Toggle timeline", () => toggleTimeline(), ""]],
  };
  function openMenu(name) {
    closeMenus();
    const dd = $(`[data-dd="${name}"]`), btn = $(`[data-menu="${name}"]`);
    dd.innerHTML = MENUS[name]().map(([l, , k, dis], i) => `<button role="menuitem" data-i="${i}" ${dis ? "disabled" : ""}><span>${l}</span><kbd>${k || ""}</kbd></button>`).join("");
    dd.classList.add("on"); btn.setAttribute("aria-expanded", "true");
    dd.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.disabled) return; closeMenus(); MENUS[name]()[+b.dataset.i][1](); };
  }
  function closeMenus() { $$(".lm-dd").forEach((d) => d.classList.remove("on")); $$(".lm-mbtn").forEach((b) => b.setAttribute("aria-expanded", "false")); }

  // ---------- modal ----------
  function modal(html, wide) {
    el.modal.hidden = false; el.modal.className = "lm-modal on" + (wide ? " wide" : "");
    el.modal.innerHTML = `<div class="lm-dialog" role="dialog" aria-modal="true">${html}</div>`;
    el.modal.onmousedown = (e) => { if (e.target === el.modal) closeModal(); };
    const f = el.modal.querySelector("input,select,button"); if (f) f.focus();
    return el.modal.firstElementChild;
  }
  function closeModal() { el.modal.hidden = true; el.modal.className = "lm-modal"; el.modal.innerHTML = ""; }
  const modalOpen = () => !el.modal.hidden;

  function newDialog() {
    let pick = "hd";
    const d = modal(`<h2>New project</h2><p class="mut">Pick a size, or enter your own. You can change it any time.</p>
      <div class="lm-presets">${PRESETS.map((p) => `<button class="lm-preset" data-p="${p.id}" aria-pressed="${p.id === pick}"><span class="pv"><i style="width:${Math.round((p.w / Math.max(p.w, p.h)) * 70)}px;height:${Math.round((p.h / Math.max(p.w, p.h)) * 70)}px"></i></span><b>${p.name}</b><em>${p.w} × ${p.h} px</em></button>`).join("")}</div>
      <div class="lm-row"><label>Width <input id="nw" type="number" min="1" max="12000" value="1920"></label><label>Height <input id="nh" type="number" min="1" max="12000" value="1080"></label>
      <label>Background <select id="nbg"><option value="#ffffff">White</option><option value="#000000">Black</option><option value="transparent">Transparent</option><option value="#101113">Charcoal</option></select></label></div>
      <div class="lm-actions"><button class="lm-btn" id="ncancel">Cancel</button><button class="lm-btn gold" id="ncreate">Create</button></div>`, true);
    d.onclick = (e) => {
      const b = e.target.closest(".lm-preset");
      if (b) { pick = b.dataset.p; const p = PRESETS.find((x) => x.id === pick); $("#nw", d).value = p.w; $("#nh", d).value = p.h; $$(".lm-preset", d).forEach((x) => x.setAttribute("aria-pressed", String(x === b))); }
      if (e.target.id === "ncancel") closeModal();
      if (e.target.id === "ncreate") { S.touched = true; doc.exec("new", { w: +$("#nw", d).value, h: +$("#nh", d).value, bg: $("#nbg", d).value }); closeModal(); fit(); status("New project"); }
    };
  }
  function sizeDialog() {
    const d = modal(`<h2>Canvas size</h2><div class="lm-row"><label>Width <input id="sw" type="number" value="${doc.w}"></label><label>Height <input id="sh" type="number" value="${doc.h}"></label>
      <label class="chk"><input id="ss" type="checkbox"> Scale content</label></div><div class="lm-actions"><button class="lm-btn" id="scancel">Cancel</button><button class="lm-btn gold" id="sok">Apply</button></div>`);
    d.onclick = (e) => { if (e.target.id === "scancel") closeModal(); if (e.target.id === "sok") { doc.exec("canvas_size", { w: +$("#sw", d).value, h: +$("#sh", d).value, scale: $("#ss", d).checked }); closeModal(); fit(); } };
  }
  function timelineDialog() {
    const d = modal(`<h2>Timeline</h2><div class="lm-row"><label>Length (s) <input id="td" type="number" min="0.5" max="120" step="0.5" value="${doc.duration}"></label><label>Frames / s <input id="tf" type="number" min="1" max="60" value="${doc.fps}"></label></div>
      <div class="lm-actions"><button class="lm-btn" id="tcancel">Cancel</button><button class="lm-btn gold" id="tok">Apply</button></div>`);
    d.onclick = (e) => { if (e.target.id === "tcancel") closeModal(); if (e.target.id === "tok") { doc.exec("duration", { seconds: +$("#td", d).value, fps: +$("#tf", d).value }); closeModal(); } };
  }

  function filterDialog(name) {
    const [title, label, min, max, def] = FILTER_UI[name];
    if (!label) { const r = exe("filter", { name }); if (r) status(title + " applied"); return; }
    const d = modal(`<h2>${title}</h2><p class="mut">${hasSel() ? "Applies inside the selection." : "Applies to the whole layer."} Text and shapes are rasterized first.</p>
      <label class="ps wide"><span>${label}</span><input id="fa" type="range" min="${min}" max="${max}" value="${def}"><output id="fo">${def}</output></label>
      <div class="lm-actions"><button class="lm-btn" id="fcancel">Cancel</button><button class="lm-btn gold" id="fok">Apply</button></div>`);
    $("#fa", d).oninput = (e) => ($("#fo", d).textContent = e.target.value);
    d.onclick = (e) => { if (e.target.id === "fcancel") closeModal(); if (e.target.id === "fok") { const r = exe("filter", { name, amount: +$("#fa", d).value }); closeModal(); if (r) status(title + " applied"); } };
  }
  function featherDialog() {
    const d = modal(`<h2>Feather selection</h2><label class="ps wide"><span>Radius px</span><input id="fr" type="range" min="1" max="100" value="8"><output id="fo">8</output></label>
      <div class="lm-actions"><button class="lm-btn" id="fcancel">Cancel</button><button class="lm-btn gold" id="fok">Apply</button></div>`);
    $("#fr", d).oninput = (e) => ($("#fo", d).textContent = e.target.value);
    d.onclick = (e) => { if (e.target.id === "fcancel") closeModal(); if (e.target.id === "fok") { exe("feather", { radius: +$("#fr", d).value }); closeModal(); } };
  }

  // ---------- emoji ----------
  function insertEmoji(ch, into) {
    const L = sel(), ta = $("#ptext");
    if (into && L && L.type === "text" && ta) {
      const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + ch + ta.value.slice(b);
      ta.setSelectionRange(a + ch.length, a + ch.length);
      doc.exec("set", { text: ta.value });
    } else doc.exec("add_text", { text: ch, size: Math.round(doc.h / 5), name: "Emoji" });
  }
  function emojiDialog(into) {
    into = into === true; // true only when opened from the text panel: then picks go into that text, otherwise they make a new layer
    const d = modal(`<h2>Emoji</h2><p class="mut">Copy an emoji from anywhere and paste it here, or pick one.</p>
      <div class="lm-row"><input id="epaste" class="grow" placeholder="Paste emoji or text here (Ctrl+V)" aria-label="Paste emoji or text"><button class="lm-btn gold" id="eadd">Add to canvas</button></div>
      <div class="lm-emoji">${Object.entries(EMOJI).map(([c, s]) => `<div class="eh">${c}</div><div class="eg">${[...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((g) => `<button data-e="${g.segment}" aria-label="${g.segment}">${g.segment}</button>`).join("")}</div>`).join("")}</div>
      <div class="lm-actions"><button class="lm-btn" id="eclose">Done</button></div>`, true);
    const inp = $("#epaste", d); inp.focus();
    const add = () => { if (inp.value.trim()) { insertEmoji(inp.value, into); inp.value = ""; } };
    d.onclick = (e) => { const b = e.target.closest("[data-e]"); if (b) { insertEmoji(b.dataset.e, into); } if (e.target.id === "eadd") add(); if (e.target.id === "eclose") closeModal(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") add(); };
  }

  // ---------- export ----------
  function download(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const fname = () => (doc.name || "lumen-project").replace(/[^\w-]+/g, "-");
  function exportDialog(startFmt) {
    const FORMATS = [["png", "PNG", "Lossless, transparency"], ["jpg", "JPG", "Small, photos"], ["webp", "WEBP", "Modern web"], ["gif", "GIF", "Animated loop"], ["webm", "WEBM", "Video"], ["pdf", "PDF", "Print-ready page"]];
    let fmt = typeof startFmt === "string" ? startFmt : "png";
    const d = modal(`<h2>Export</h2><div class="lm-fmts">${FORMATS.map(([id, n, note]) => `<button class="lm-fmt" data-f="${id}" aria-pressed="${id === fmt}"><b>${n}</b><span>${note}</span></button>`).join("")}</div>
      <div class="lm-row"><label>Scale <select id="xs"><option value="1">100% (${doc.w} × ${doc.h})</option><option value="0.5">50%</option><option value="2">200%</option><option value="0.25">25%</option></select></label>
      <label class="x-q">Quality <input id="xq" type="range" min="40" max="100" value="92"></label>
      <label class="x-a">Frames / s <input id="xf" type="number" min="1" max="60" value="${doc.fps}"></label>
      <label class="x-a">Seconds <input id="xd" type="number" min="0.5" max="120" step="0.5" value="${doc.duration}"></label>
      <label class="x-p">Page <select id="xp"><option value="fit">Fit to image</option><option value="a4">A4</option><option value="a3">A3</option><option value="a5">A5</option><option value="letter">US Letter</option><option value="legal">US Legal</option></select></label>
      <label class="x-p2">Margin (pt) <input id="xm" type="number" min="0" max="200" value="0"></label>
      <label class="x-p2 chk"><input id="xall" type="checkbox"> Every animation frame as a page</label></div>
      <div class="lm-note" id="xnote"></div>
      <div class="lm-actions"><button class="lm-btn" id="xcancel">Cancel</button><button class="lm-btn gold" id="xgo">Export</button></div>`);
    const sync = () => {
      d.dataset.f = fmt;
      $$(".x-q", d).forEach((x) => (x.hidden = !["jpg", "webp", "pdf"].includes(fmt)));
      $$(".x-p, .x-p2", d).forEach((x) => (x.hidden = fmt !== "pdf"));
      $$(".x-a", d).forEach((x) => (x.hidden = !(["gif", "webm"].includes(fmt) || (fmt === "pdf" && $("#xall", d) && $("#xall", d).checked))));
      $("#xnote", d).textContent = fmt === "gif" ? "Layer animations from the timeline are played into the GIF." : fmt === "webm" ? "Records in real time — a 4 second clip takes about 4 seconds." : fmt === "pdf" ? "Saves a real .pdf file you can print or send. Tick the box to turn the timeline into a multi-page PDF." : "";
    };
    sync();
    d.onclick = async (e) => {
      const b = e.target.closest(".lm-fmt");
      if (b) { fmt = b.dataset.f; $$(".lm-fmt", d).forEach((x) => x.setAttribute("aria-pressed", String(x === b))); sync(); }
      if (e.target.id === "xall") sync();
      if (e.target.id === "xcancel") closeModal();
      if (e.target.id === "xgo") {
        const go = e.target; go.disabled = true;
        const note = $("#xnote", d);
        try {
          const r = await window.LumenExport.run(doc, { format: fmt, scale: +$("#xs", d).value, quality: +$("#xq", d).value / 100, fps: +$("#xf", d).value, duration: +$("#xd", d).value, page: $("#xp", d).value, margin: +$("#xm", d).value || 0, allFrames: $("#xall", d).checked, onProgress: (p) => (note.textContent = "Rendering… " + Math.round(p * 100) + "%") });
          download(r.blob, fname() + "." + r.ext);
          status(`Exported ${fname()}.${r.ext} (${Math.round(r.blob.size / 1024)} KB)`);
          closeModal();
        } catch (err) { note.textContent = "Export failed: " + err.message; go.disabled = false; }
      }
    };
  }
  function saveProject() { download(new Blob([doc.toJSON()], { type: "application/json" }), fname() + ".lum"); status("Saved project"); }

  // ---------- files in ----------
  const readFile = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
  async function importFiles(files) {
    for (const f of files) {
      try {
        if (/\.lum$/i.test(f.name)) { await doc.load(await f.text()); fit(); status("Opened " + f.name); continue; }
        if (!f.type.startsWith("image/")) continue;
        const first = !doc.layers.length;
        const src = await readFile(f);
        if (first && !S.touched && doc.w === 1920 && doc.h === 1080) { // still the untouched default canvas (a size you chose is kept)
          // first image on an empty canvas: size the canvas to it
          const im = await window.LumenEngine.loadImage(src);
          doc.exec("new", { w: im.naturalWidth, h: im.naturalHeight, bg: "#ffffff" });
          fit();
        }
        await doc.exec("add_image", { src, name: f.name.replace(/\.\w+$/, ""), fit: "contain" });
        status("Added " + f.name);
      } catch (e) { status("Could not open " + f.name + ": " + e.message); }
    }
  }

  // ---------- view ----------
  function viewSize() { const r = el.stage.getBoundingClientRect(); return { w: r.width, h: r.height }; }
  function fit() {
    const v = viewSize(); if (!v.w) return;
    S.zoom = clamp(Math.min((v.w - 80) / doc.w, (v.h - 80) / doc.h), 0.02, 8);
    S.px = (v.w - doc.w * S.zoom) / 2; S.py = (v.h - doc.h * S.zoom) / 2;
    layoutView(); render();
  }
  function zoomAt(f, cx, cy) {
    const v = viewSize(); cx = cx ?? v.w / 2; cy = cy ?? v.h / 2;
    const nz = clamp(S.zoom * f, 0.02, 16), k = nz / S.zoom;
    S.px = cx - (cx - S.px) * k; S.py = cy - (cy - S.py) * k; S.zoom = nz;
    layoutView(); render();
  }
  function layoutView() {
    el.board.style.cssText = `width:${doc.w * S.zoom}px;height:${doc.h * S.zoom}px;transform:translate(${S.px}px,${S.py}px)`;
    el.board.classList.toggle("tr", doc.bg === "transparent");
    el.board.style.backgroundColor = doc.bg === "transparent" ? "" : doc.bg;
    el.zoom.textContent = Math.round(S.zoom * 100) + "%";
    const r = el.stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (el.ov.width !== Math.round(r.width * dpr)) { el.ov.width = Math.round(r.width * dpr); el.ov.height = Math.round(r.height * dpr); }
  }
  const toDoc = (cx, cy) => { const r = el.stage.getBoundingClientRect(); return { x: (cx - r.left - S.px) / S.zoom, y: (cy - r.top - S.py) / S.zoom }; };

  let raf = 0;
  function render() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  function draw() {
    if (!S.open) return;
    const dpr = devicePixelRatio || 1, ps = clamp(S.zoom * dpr, 0.02, 1);
    const cw = Math.max(1, Math.round(doc.w * ps)), ch = Math.max(1, Math.round(doc.h * ps));
    if (el.cv.width !== cw || el.cv.height !== ch) { el.cv.width = cw; el.cv.height = ch; }
    el.cv.style.width = doc.w * S.zoom + "px"; el.cv.style.height = doc.h * S.zoom + "px";
    const c = el.ctx; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cw, ch);
    c.scale(cw / doc.w, ch / doc.h);
    if (S.playing || S.t > 0 || S.scrub) doc.render(c, S.t, { noBg: true }); else doc.render(c, null, { noBg: true });
    drawOverlay();
    el.empty.hidden = doc.layers.length > 0;
  }

  // ---------- overlay: selection handles, crop ----------
  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  function handlePts(L) {
    const [a, b, c, d] = corners(L), mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const pts = { nw: a, n: mid(a, b), ne: b, e: mid(b, c), se: c, s: mid(c, d), sw: d, w: mid(d, a) };
    const top = pts.n, cx = (a.x + c.x) / 2, cy = (a.y + c.y) / 2, dx = top.x - cx, dy = top.y - cy, len = Math.hypot(dx, dy) || 1;
    pts.rot = { x: top.x + (dx / len) * 28 / S.zoom, y: top.y + (dy / len) * 28 / S.zoom };
    return pts;
  }
  const toScr = (p) => ({ x: S.px + p.x * S.zoom, y: S.py + p.y * S.zoom });
  function drawOverlay() {
    const dpr = devicePixelRatio || 1, c = el.ov.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, el.ov.width, el.ov.height);
    c.strokeStyle = "rgba(255,255,255,.18)"; c.lineWidth = 1; c.strokeRect(S.px + 0.5, S.py + 0.5, doc.w * S.zoom, doc.h * S.zoom);
    drawSelection(c);
    if (S.tool === "crop") {
      const r = S.crop || { x: 0, y: 0, w: doc.w, h: doc.h }, a = toScr(r), b = toScr({ x: r.x + r.w, y: r.y + r.h });
      c.fillStyle = "rgba(0,0,0,.55)";
      const bx = S.px, by = S.py, bw = doc.w * S.zoom, bh = doc.h * S.zoom;
      c.fillRect(bx, by, bw, a.y - by); c.fillRect(bx, b.y, bw, by + bh - b.y); c.fillRect(bx, a.y, a.x - bx, b.y - a.y); c.fillRect(b.x, a.y, bx + bw - b.x, b.y - a.y);
      c.strokeStyle = "#f2a33a"; c.lineWidth = 1.5; c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      c.fillStyle = "#f2a33a"; c.font = "11px ui-monospace,Consolas,monospace"; c.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}  — Enter to apply`, a.x + 4, a.y - 6);
      return;
    }
    const L = sel();
    if (!L || L.type === "draw" || !L.visible) return;
    const q = corners(L).map(toScr);
    c.strokeStyle = "#f2a33a"; c.lineWidth = 1.2; c.beginPath(); q.forEach((p, i) => c[i ? "lineTo" : "moveTo"](p.x, p.y)); c.closePath(); c.stroke();
    if (S.tool !== "move" || L.locked) return;
    const hp = handlePts(L), r = toScr(hp.rot), n = toScr(hp.n);
    c.beginPath(); c.moveTo(n.x, n.y); c.lineTo(r.x, r.y); c.stroke();
    c.fillStyle = "#101113"; c.strokeStyle = "#f2a33a";
    for (const k of [...HANDLES, "rot"]) { const p = toScr(hp[k]); c.beginPath(); if (k === "rot") c.arc(p.x, p.y, 5, 0, 7); else c.rect(p.x - 4.5, p.y - 4.5, 9, 9); c.fill(); c.stroke(); }
  }
  /** marching ants round the selection + live previews of the marquee, lasso, gradient and clone source */
  function drawSelection(c) {
    const ae = doc.antsEdge();
    if (ae) {
      const sc = S.zoom / ae.k, ph = Math.floor(performance.now() / 110) % 8, w = Math.max(1, sc);
      for (const dark of [true, false]) {
        c.fillStyle = dark ? "#000" : "#fff"; c.beginPath();
        for (let i = 0; i < ae.pts.length; i += 2) { const x = ae.pts[i], y = ae.pts[i + 1]; if ((((x + y + ph) >> 2) & 1) === (dark ? 1 : 0)) c.rect(S.px + x * sc, S.py + y * sc, w, w); }
        c.fill();
      }
    }
    const d = S.drag; c.save(); c.setLineDash([5, 4]); c.strokeStyle = "#fff"; c.lineWidth = 1;
    if (d && d.kind === "marq" && d.p) {
      const a = toScr({ x: Math.min(d.x0, d.p.x), y: Math.min(d.y0, d.p.y) }), b = toScr({ x: Math.max(d.x0, d.p.x), y: Math.max(d.y0, d.p.y) });
      c.beginPath(); if (S.marq === "ellipse") c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(1, (b.x - a.x) / 2), Math.max(1, (b.y - a.y) / 2), 0, 0, 7); else c.rect(a.x, a.y, b.x - a.x, b.y - a.y); c.stroke();
    }
    if (d && d.kind === "lasso") { c.beginPath(); d.pts.forEach((q, i) => { const s2 = toScr({ x: q[0], y: q[1] }); c[i ? "lineTo" : "moveTo"](s2.x, s2.y); }); c.stroke(); }
    if (d && d.kind === "grad" && d.p) { const a = toScr({ x: d.x0, y: d.y0 }), b = toScr(d.p); c.setLineDash([]); c.strokeStyle = "#f2a33a"; c.lineWidth = 2; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.fillStyle = S.fg; c.beginPath(); c.arc(a.x, a.y, 5, 0, 7); c.fill(); c.fillStyle = S.bgc; c.beginPath(); c.arc(b.x, b.y, 5, 0, 7); c.fill(); }
    if (S.tool === "clone" && S.cloneSrc) { const q = toScr(S.cloneSrc); c.setLineDash([]); c.strokeStyle = "#6fd39b"; c.beginPath(); c.moveTo(q.x - 9, q.y); c.lineTo(q.x + 9, q.y); c.moveTo(q.x, q.y - 9); c.lineTo(q.x, q.y + 9); c.stroke(); }
    c.restore();
  }
  function handleAt(L, cx, cy) {
    if (!L || L.locked || L.type === "draw") return null;
    const hp = handlePts(L), r = el.stage.getBoundingClientRect();
    for (const k of ["rot", ...HANDLES]) { const p = toScr(hp[k]); if (Math.hypot(r.left + p.x - cx, r.top + p.y - cy) <= 8) return k; }
    return null;
  }

  // ---------- pointer interaction ----------
  const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", rot: "crosshair" };
  function brushOpts(erase, pencil) { return { size: S.brush.size, hardness: pencil ? 100 : S.brush.hardness, opacity: S.brush.opacity, color: S.fg, erase }; }
  const rtOpts = (mode) => ({ mode, size: S.brush.size, hardness: S.brush.hardness, strength: S.strength / 100 });
  const selMode = (e) => (e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : S.selMode);
  function cloneOff(L, p) { const a = toLocal(L, S.cloneSrc.x, S.cloneSrc.y), b = toLocal(L, p.x, p.y); return { x: a.x - b.x, y: a.y - b.y }; }

  function ptrDown(e) {
    if (e.button === 1 || S.space || S.tool === "hand") { S.drag = { kind: "pan", sx: e.clientX, sy: e.clientY, px: S.px, py: S.py }; el.stage.setPointerCapture(e.pointerId); return; }
    if (e.button !== 0) return;
    S.touched = true;
    const p = toDoc(e.clientX, e.clientY), tool = S.tool;
    el.stage.setPointerCapture(e.pointerId);
    if (tool === "zoom") { zoomAt(e.altKey ? 0.5 : 2, e.clientX - el.stage.getBoundingClientRect().left, e.clientY - el.stage.getBoundingClientRect().top); return; }
    if (tool === "pick") { const c = doc.pixel(p.x, p.y); setFg(c.hex); return; }
    if (tool === "marquee") { S.drag = { kind: "marq", x0: p.x, y0: p.y, p, mode: selMode(e) }; return; }
    if (tool === "lasso") { S.drag = { kind: "lasso", pts: [[p.x, p.y]], mode: selMode(e) }; return; }
    if (tool === "wand") {
      const r = exe("select_wand", { x: p.x, y: p.y, tol: S.tol, contiguous: S.contiguous, all: S.sampleAll, mode: selMode(e), feather: S.feather });
      if (r !== undefined) status(r ? `Selected ${Math.round(r.w)} × ${Math.round(r.h)} px` : "Nothing selected"); return;
    }
    if (tool === "bucket") { const r = exe("bucket", { x: p.x, y: p.y, color: S.fg, tol: S.bTol, contiguous: S.contiguous }); if (r) status(`Filled ${r.filled} px`); return; }
    if (tool === "gradient") { S.drag = { kind: "grad", x0: p.x, y0: p.y, p }; return; }
    if (tool === "bgerase") {
      const L = doc.layers.slice().reverse().find((l) => isRaster(l) && l.visible && !l.locked && (l.type === "draw" || (() => { const q = toLocal(l, p.x, p.y); return q.x >= 0 && q.y >= 0 && q.x <= l.w && q.y <= l.h; })()));
      if (!L) { status("Click on an image or paint layer"); return; }
      doc.exec("select", { id: L.id });
      const r = doc.exec("remove_bg", { id: L.id, x: p.x, y: p.y, tol: S.tol, contiguous: S.contiguous });
      status(`Removed ${r.erasedPixels} pixels`); return;
    }
    if (tool === "text") {
      const hit = doc.hit(p.x, p.y);
      if (hit && hit.type === "text") { doc.exec("select", { id: hit.id }); setTimeout(() => { const t = $("#ptext"); if (t) { t.focus(); t.select(); } }, 0); return; }
      const id = doc.exec("add_text", { text: "Text", x: p.x, y: p.y, size: Math.round(doc.h / 12), color: S.fg });
      setTool("move"); setTimeout(() => { const t = $("#ptext"); if (t) { t.focus(); t.select(); } }, 0); void id; return;
    }
    if (tool === "shape") { S.drag = { kind: "shape", x0: p.x, y0: p.y, id: null, shift: e.shiftKey }; return; }
    if (tool === "crop") {
      const r = S.crop;
      if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) S.drag = { kind: "cropmove", x0: p.x, y0: p.y, r: { ...r } };
      else { S.crop = { x: p.x, y: p.y, w: 1, h: 1 }; S.drag = { kind: "cropnew", x0: p.x, y0: p.y }; }
      return;
    }
    if (tool === "brush" || tool === "eraser" || tool === "pencil" || RETOUCH.has(tool)) {
      let L = sel();
      const erase = tool === "eraser", rt = RETOUCH.has(tool);
      if (!L || !isRaster(L) || L.locked || !L.visible) {
        if (erase || rt) { status("Select an unlocked image or paint layer first"); return; }
        doc.exec("add_draw", { live: true }); L = sel();
      }
      if (tool === "clone") {
        if (e.altKey) { S.cloneSrc = p; status("Clone source set — now paint over the area to cover"); render(); return; }
        if (!S.cloneSrc) { status("Alt-click to pick the clone source first"); return; }
      }
      const st = doc.strokeStart(L, rt ? tool : "paint", tool === "clone" ? { off: cloneOff(L, p) } : {});
      S.drag = { kind: "paint", id: L.id, pts: [p], erase, tool, st };
      if (rt) doc.retouch(L, [p], rtOpts(tool), st); else doc.paintStroke(L, [p], brushOpts(erase, tool === "pencil"));
      doc.strokeClip(L, st, [p], S.brush.size); render(); return;
    }
    // move tool
    const L = sel(), h = handleAt(L, e.clientX, e.clientY);
    if (h) {
      const c = { x: L.x + L.w / 2, y: L.y + L.h / 2 };
      S.drag = { kind: h === "rot" ? "rotate" : "resize", h, id: L.id, o: { x: L.x, y: L.y, w: L.w, h: L.h, rot: L.rot, size: L.size }, c, a0: Math.atan2(p.y - c.y, p.x - c.x), r0: L.rot, shift: e.shiftKey };
      return;
    }
    const hit = doc.hit(p.x, p.y);
    if (hit) {
      if (doc.sel !== hit.id) { doc.exec("select", { id: hit.id }); }
      S.drag = { kind: "move", id: hit.id, x0: p.x, y0: p.y, ox: hit.x, oy: hit.y, moved: false };
    } else { doc.exec("select", { id: null }); }
  }

  function ptrMove(e) {
    const p = toDoc(e.clientX, e.clientY);
    el.coords.textContent = `x ${Math.round(p.x)}  y ${Math.round(p.y)}`;
    const d = S.drag;
    if (!d) {
      if (S.tool === "move") { const h = handleAt(sel(), e.clientX, e.clientY); el.stage.style.cursor = h ? CURSORS[h] : doc.hit(p.x, p.y) ? "move" : "default"; }
      return;
    }
    if (d.kind === "pan") { S.px = d.px + e.clientX - d.sx; S.py = d.py + e.clientY - d.sy; layoutView(); render(); return; }
    if (d.kind === "paint") {
      const L = doc.L(d.id); const last = d.pts[d.pts.length - 1]; d.pts.push(p);
      if (RETOUCH.has(d.tool)) doc.retouch(L, [last, p], rtOpts(d.tool), d.st); else doc.paintStroke(L, [last, p], brushOpts(d.erase, d.tool === "pencil"));
      doc.strokeClip(L, d.st, [last, p], S.brush.size); render(); return;
    }
    if (d.kind === "marq" || d.kind === "grad") { d.p = p; render(); return; }
    if (d.kind === "lasso") { const l = d.pts[d.pts.length - 1]; if (Math.hypot(p.x - l[0], p.y - l[1]) * S.zoom > 2) d.pts.push([p.x, p.y]); render(); return; }
    if (d.kind === "move") {
      const L = doc.L(d.id); let nx = d.ox + p.x - d.x0, ny = d.oy + p.y - d.y0;
      if (!e.altKey) { // snap centre and edges to the canvas
        const T = 6 / S.zoom, snap = (v, targets) => { for (const t of targets) if (Math.abs(v - t) < T) return t; return v; };
        nx = snap(nx + L.w / 2, [doc.w / 2]) - L.w / 2; ny = snap(ny + L.h / 2, [doc.h / 2]) - L.h / 2;
        nx = snap(nx, [0]); ny = snap(ny, [0]); nx = snap(nx + L.w, [doc.w]) - L.w; ny = snap(ny + L.h, [doc.h]) - L.h;
      }
      if (Math.abs(p.x - d.x0) + Math.abs(p.y - d.y0) > 1) d.moved = true;
      doc.exec("set", { id: L.id, x: Math.round(nx), y: Math.round(ny), live: true }); return;
    }
    if (d.kind === "rotate") {
      let r = d.r0 + ((Math.atan2(p.y - d.c.y, p.x - d.c.x) - d.a0) * 180) / Math.PI;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      doc.exec("set", { id: d.id, rot: Math.round(r * 10) / 10, live: true }); return;
    }
    if (d.kind === "resize") { resizeDrag(d, p, e.shiftKey); return; }
    if (d.kind === "shape") {
      let w = p.x - d.x0, h = p.y - d.y0;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      const x = Math.min(d.x0, d.x0 + w), y = Math.min(d.y0, d.y0 + h), W = Math.max(2, Math.abs(w)), H = Math.max(S.shape === "line" ? 2 : 2, Math.abs(h));
      if (!d.id) { if (Math.abs(w) < 3 && Math.abs(h) < 3) return; d.id = doc.exec("add_shape", { shape: S.shape, x, y, w: W, h: H, fill: S.shape === "line" ? "transparent" : S.shapeFill, stroke: S.shape === "line" ? S.fg : "#ffffff", strokeW: S.shape === "line" ? 8 : 0, live: true }); }
      else doc.exec("set", { id: d.id, x, y, w: W, h: S.shape === "line" ? doc.L(d.id).h : H, live: true });
      return;
    }
    if (d.kind === "cropnew") { S.crop = { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0) || 1, h: Math.abs(p.y - d.y0) || 1 }; clampCrop(); render(); return; }
    if (d.kind === "cropmove") { S.crop = { ...d.r, x: d.r.x + p.x - d.x0, y: d.r.y + p.y - d.y0 }; clampCrop(true); render(); }
  }
  function clampCrop(move) {
    const r = S.crop; if (!r) return;
    if (move) { r.x = clamp(r.x, 0, doc.w - r.w); r.y = clamp(r.y, 0, doc.h - r.h); }
    else { const x2 = clamp(r.x + r.w, 0, doc.w), y2 = clamp(r.y + r.h, 0, doc.h); r.x = clamp(r.x, 0, doc.w); r.y = clamp(r.y, 0, doc.h); r.w = Math.max(1, x2 - r.x); r.h = Math.max(1, y2 - r.y); }
  }

  function resizeDrag(d, p, shift) {
    const L = doc.L(d.id); if (!L) return;
    const o = d.o, a = (-o.rot * Math.PI) / 180, dx = p.x - d.c.x, dy = p.y - d.c.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); // pointer in the layer's own axes, from its centre
    const hx = d.h.includes("e") ? 1 : d.h.includes("w") ? -1 : 0, hy = d.h.includes("s") ? 1 : d.h.includes("n") ? -1 : 0;
    let w = o.w, h = o.h;
    // opposite edge stays fixed: new half-extent measured from the fixed edge
    if (hx) w = Math.max(4, hx * lx + o.w / 2);
    if (hy) h = Math.max(4, hy * ly + o.h / 2);
    const corner = hx && hy, keep = (corner && !shift) || L.type === "text";
    if (keep) { const k = Math.max(w / o.w, h / o.h); w = o.w * k; h = o.h * k; }
    if (L.type === "text") {
      const k = Math.max(0.05, w / o.w); const size = clamp(Math.round(o.size * k), 4, 4000);
      doc.exec("set", { id: L.id, size, live: true });
      const nl = doc.L(L.id); const cx = o.x + o.w / 2, cy = o.y + o.h / 2; // keep the anchored corner roughly in place
      const fx = hx ? (o.x + o.w / 2) - (hx * o.w) / 2 : cx, fy = hy ? (o.y + o.h / 2) - (hy * o.h) / 2 : cy;
      doc.exec("set", { id: L.id, x: Math.round(hx > 0 ? fx : hx < 0 ? fx - nl.w : cx - nl.w / 2), y: Math.round(hy > 0 ? fy : hy < 0 ? fy - nl.h : cy - nl.h / 2), live: true });
      return;
    }
    // new centre = fixed edge centre shifted half the new size, rotated back into doc space
    const fixed = { x: -hx * o.w / 2, y: -hy * o.h / 2 }; // local offset of the fixed point from old centre
    const nc = { x: fixed.x + (hx ? hx * w / 2 : 0) + (hx ? 0 : 0), y: fixed.y + (hy ? hy * h / 2 : 0) };
    const cxl = hx ? nc.x : 0, cyl = hy ? nc.y : 0;
    const cos = Math.cos(-a), sin = Math.sin(-a);
    const cx = d.c.x + cxl * cos - cyl * sin, cy = d.c.y + cxl * sin + cyl * cos;
    doc.exec("set", { id: L.id, w: Math.round(w), h: Math.round(h), x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), live: true });
  }

  function ptrUp() {
    const d = S.drag; S.drag = null;
    if (!d) return;
    if (["move", "rotate", "resize", "shape"].includes(d.kind)) {
      if (d.kind === "move" && !d.moved) return;
      if (d.kind === "shape" && !d.id) return;
      doc.commit(d.kind === "shape" ? "draw shape" : d.kind); if (d.kind === "shape") setTool("move");
    }
    if (d.kind === "paint") { const L = doc.L(d.id); if (L) doc.touch(L); doc.commit(d.erase ? "erase" : d.tool || "brush"); }
    if (d.kind === "marq") {
      const x = Math.min(d.x0, d.p.x), y = Math.min(d.y0, d.p.y), w = Math.abs(d.p.x - d.x0), h = Math.abs(d.p.y - d.y0);
      if (w * S.zoom < 3 && h * S.zoom < 3) { if (d.mode === "replace") exe("deselect"); }
      else exe(S.marq === "ellipse" ? "select_ellipse" : "select_rect", { x, y, w, h, mode: d.mode, feather: S.feather });
    }
    if (d.kind === "lasso") { if (d.pts.length >= 3) exe("select_poly", { points: d.pts, mode: d.mode, feather: S.feather }); else if (d.mode === "replace") exe("deselect"); }
    if (d.kind === "grad" && Math.hypot(d.p.x - d.x0, d.p.y - d.y0) * S.zoom > 3) exe("gradient", { x0: d.x0, y0: d.y0, x1: d.p.x, y1: d.p.y, from: S.fg, to: S.bgc, kind: S.grad });
    renderAll();
  }

  function applyCrop() {
    const r = S.crop; if (!r || r.w < 2 || r.h < 2) return;
    doc.exec("crop", { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    S.crop = null; setTool("move"); fit(); status(`Cropped to ${doc.w} × ${doc.h}`);
  }

  // ---------- tools / colour ----------
  function setTool(t) {
    if (t !== "crop") S.crop = null;
    S.tool = t;
    $$(".lm-tool").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
    el.stage.style.cursor = t === "hand" ? "grab" : !["move", "hand", "zoom", "text"].includes(t) ? "crosshair" : t === "zoom" ? "zoom-in" : t === "text" ? "text" : "default";
    renderOpts(); render();
  }
  function setBg(c) { S.bgc = c; $("#lmbg").value = c; $("#lmbgs").style.background = c; renderOpts(); }
  function setFg(c) { S.fg = c; $("#lmfg").value = c; $("#lmfgs").style.background = c; renderOpts(); }

  function renderOpts() {
    const t = S.tool, o = el.opts;
    const num = (id, label, v, min, max, step = 1) => `<label class="oi">${label}<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
    const chk = (id, label, v) => `<label class="oi chk"><input type="checkbox" id="${id}" ${v ? "checked" : ""}> ${label}</label>`;
    const modeSel = `<label class="oi">Mode <select id="osm">${[["replace", "New"], ["add", "Add (Shift)"], ["subtract", "Subtract (Alt)"], ["intersect", "Intersect"]].map(([v, n]) => `<option value="${v}" ${S.selMode === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>` + num("ofe", "Feather px", S.feather, 0, 200);
    let h = `<span class="otool">${(TOOLS.find((x) => x[0] === t) || [, t])[1].replace(/ \(.\)/, "")}</span>`;
    if (t === "brush" || t === "eraser") h += num("obs", "Size", S.brush.size, 1, 1000) + num("obh", "Hardness", S.brush.hardness, 0, 100) + num("obo", "Opacity %", Math.round(S.brush.opacity * 100), 1, 100) + (t === "brush" ? '<span class="oi">Colour: use the swatch</span>' : "");
    else if (t === "pencil") h += num("obs", "Size", S.brush.size, 1, 1000) + num("obo", "Opacity %", Math.round(S.brush.opacity * 100), 1, 100) + '<span class="oi">Hard-edged · colour: use the swatch</span>';
    else if (RETOUCH.has(t)) h += num("obs", "Size", S.brush.size, 1, 1000) + num("obh", "Hardness", S.brush.hardness, 0, 100) + (t === "clone" ? "" : num("ost", "Strength %", S.strength, 2, 100)) + `<span class="oi">${t === "clone" ? "Alt-click to set the source, then paint" : "Paint over the area · needs an image or paint layer"}</span>`;
    else if (t === "marquee") h += `<label class="oi">Shape <select id="omq"><option value="rect" ${S.marq === "rect" ? "selected" : ""}>Rectangle</option><option value="ellipse" ${S.marq === "ellipse" ? "selected" : ""}>Ellipse</option></select></label>` + modeSel + '<button class="lm-btn" id="osall">All</button><button class="lm-btn" id="osnone">None</button><button class="lm-btn" id="osinv">Invert</button>';
    else if (t === "lasso") h += modeSel + '<span class="oi">Drag a freehand outline · release to close</span>';
    else if (t === "wand") h += num("owt", "Tolerance %", S.tol, 0, 100) + chk("owc", "Contiguous", S.contiguous) + chk("owa", "Sample all layers", S.sampleAll) + modeSel + '<span class="oi">Click a colour to select it</span>';
    else if (t === "bgerase") h += num("owt", "Tolerance %", S.tol, 0, 100) + chk("owc", "Contiguous", S.contiguous) + '<span class="oi">Click a colour to erase it to transparent</span>';
    else if (t === "bucket") h += num("obt", "Tolerance %", S.bTol, 0, 100) + chk("owc", "Contiguous", S.contiguous) + '<span class="oi">Fills with the foreground colour · stays inside a selection</span>';
    else if (t === "gradient") h += `<label class="oi">Kind <select id="ogk"><option value="linear" ${S.grad === "linear" ? "selected" : ""}>Linear</option><option value="radial" ${S.grad === "radial" ? "selected" : ""}>Radial</option></select></label><span class="oi">Drag on the canvas · foreground → background colour</span>`;
    else if (t === "shape") h += `<label class="oi">Shape <select id="osh">${SHAPES.map((s) => `<option ${s === S.shape ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="oi">Fill <input type="color" id="osf" value="${S.shapeFill}"></label><span class="oi">Drag on the canvas · Shift keeps it square</span>`;
    else if (t === "crop") h += `<span class="oi">Drag a region · Enter to apply · Esc to cancel</span><button class="lm-btn" id="ocrop">Apply crop</button>`;
    else if (t === "text") h += '<span class="oi">Click the canvas to add text · double-click text to edit</span><button class="lm-btn" id="oemoji">Emoji…</button>';
    else if (t === "move") h += '<span class="oi">Click to select · drag handles to resize · top dot rotates · Alt disables snapping</span>';
    else if (t === "pick") h += '<span class="oi">Click anywhere to pick a colour</span>';
    else if (t === "hand") h += '<span class="oi">Drag to pan · hold Space with any tool</span>';
    else if (t === "zoom") h += '<span class="oi">Click to zoom in · Alt-click to zoom out · wheel also zooms</span>';
    o.innerHTML = h;
    const on = (id, fn) => { const x = $("#" + id); if (x) x.oninput = x.onchange = fn; };
    on("obs", (e) => (S.brush.size = clamp(+e.target.value || 1, 1, 1000))); on("obh", (e) => (S.brush.hardness = clamp(+e.target.value, 0, 100))); on("obo", (e) => (S.brush.opacity = clamp(+e.target.value, 1, 100) / 100));
    on("ost", (e) => (S.strength = clamp(+e.target.value, 2, 100)));
    on("osh", (e) => (S.shape = e.target.value)); on("osf", (e) => (S.shapeFill = e.target.value)); on("owt", (e) => (S.tol = clamp(+e.target.value, 0, 100))); on("owc", (e) => (S.contiguous = e.target.checked));
    on("owa", (e) => (S.sampleAll = e.target.checked)); on("obt", (e) => (S.bTol = clamp(+e.target.value, 0, 100))); on("ogk", (e) => (S.grad = e.target.value));
    on("omq", (e) => (S.marq = e.target.value)); on("osm", (e) => (S.selMode = e.target.value)); on("ofe", (e) => (S.feather = clamp(+e.target.value || 0, 0, 200)));
    const bt = (id, fn) => { const x = $("#" + id); if (x) x.onclick = fn; };
    bt("osall", () => exe("select_all")); bt("osnone", () => exe("deselect")); bt("osinv", () => exe("invert_selection"));
    const oc = $("#ocrop"); if (oc) oc.onclick = applyCrop;
    const oe = $("#oemoji"); if (oe) oe.onclick = emojiDialog;
  }

  // ---------- layers panel ----------
  function renderLayers() {
    const list = doc.layers.slice().reverse();
    el.layers.innerHTML = list.length ? list.map((l) => `<div class="lm-layer${l.id === doc.sel ? " act" : ""}${l.visible ? "" : " hid"}" role="listitem" draggable="true" data-id="${l.id}" aria-current="${l.id === doc.sel}">
      <button class="lm-ic" data-act="vis" aria-label="${l.visible ? "Hide" : "Show"} ${esc(l.name)}" aria-pressed="${l.visible}">${svg(l.visible ? "eye" : "eyeoff", 15)}</button>
      <span class="thumb t-${l.type}">${l.type === "text" ? "T" : l.type === "shape" ? "◆" : l.type === "draw" ? "✎" : ""}</span>
      <span class="nm" data-act="name">${esc(l.name)}</span><span class="kd">${l.type}</span>
      <button class="lm-ic" data-act="lock" aria-label="${l.locked ? "Unlock" : "Lock"} ${esc(l.name)}" aria-pressed="${l.locked}">${svg(l.locked ? "lock" : "unlock", 14)}</button></div>`).join("")
      : '<div class="lm-none">No layers yet</div>';
    $$(".lm-layer", el.layers).forEach((row) => {
      const l = doc.L(row.dataset.id), th = $(".thumb", row);
      if (l && isRaster(l) && l._cv) { const c = mk(34, 34), x = c.getContext("2d"), k = Math.min(34 / l._cv.width, 34 / l._cv.height); x.drawImage(l._cv, 0, 0, l._cv.width * k, l._cv.height * k); th.style.backgroundImage = `url(${c.toDataURL()})`; }
      else if (l && l.type === "shape") th.style.color = l.fill === "transparent" ? l.stroke : l.fill;
      else if (l && l.type === "text") th.style.color = l.color;
    });
    $("#lmundo-state") && 0;
  }

  // ---------- properties panel ----------
  const field = (id, label, v, extra = "") => `<label class="pf"><span>${label}</span><input id="${id}" type="number" value="${rnd(v)}" ${extra}></label>`;
  const slider = (id, label, v, min, max, step = 1, unit = "") => `<label class="ps"><span>${label}</span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${v}"><output>${rnd(v)}${unit}</output></label>`;
  /** what decides which fields the panel shows — while it is unchanged the panel is updated in place, so open
   *  sections stay open and a field you are tabbing into is not rebuilt out from under you */
  const propsSig = (L) => (L ? [L.id, L.type, L.shape, !!L.shadow, isRaster(L)].join("|") : `canvas|${doc.w}|${doc.h}|${doc.bg === "transparent"}`);
  function syncProps(L) {
    const set = (id, v) => { const x = $("#" + id); if (x && document.activeElement !== x && v !== undefined) x.value = v; };
    if (!L) { set("pbg", doc.bg === "transparent" ? "#ffffff" : doc.bg); return; }
    set("px", rnd(L.x)); set("py", rnd(L.y)); set("pw", rnd(L.w)); set("ph", rnd(L.h)); set("pr", rnd(L.rot));
    set("po", Math.round(L.opacity * 100)); const po = $("#po"); if (po && po.nextElementSibling) po.nextElementSibling.textContent = Math.round(L.opacity * 100) + "%";
    set("pb", L.blend);
    if (L.type === "text") {
      set("ptext", L.text); set("pfont", L.font); set("psize", rnd(L.size)); set("pcol", L.color); set("palign", L.align); set("pstk", L.stroke); set("pstkw", rnd(L.strokeW));
      for (const [id, k] of [["pbold", "bold"], ["pital", "italic"]]) { const b = $("#" + id); if (b) b.setAttribute("aria-pressed", String(!!L[k])); }
    }
    if (L.type === "shape") { set("pshape", L.shape); set("pfill", L.fill === "transparent" ? "#000000" : L.fill); set("pstroke", L.stroke); set("pstrokew", rnd(L.strokeW)); set("prad", rnd(L.radius)); }
    for (const k of Object.keys(FILTERS0)) { set("f_" + k, L.filters[k]); const x = $("#f_" + k); if (x && x.nextElementSibling) x.nextElementSibling.textContent = L.filters[k]; }
    if (L.shadow) { set("pshc", hex6(L.shadow.color)); set("pshb", rnd(L.shadow.blur)); set("pshx", rnd(L.shadow.x)); set("pshy", rnd(L.shadow.y)); }
    set("pan", L.anim.kind); set("pas", rnd(L.anim.start)); set("pae", rnd(L.anim.end)); set("ptol", S.tol);
    const nm = $(".lm-h .mut", el.props); if (nm) nm.textContent = L.name;
    bindProps(L); // handlers close over the layer object, which undo/redo replace
  }
  function renderProps() {
    const L = sel(), p = el.props, sig = propsSig(L);
    if (p.dataset.sig === sig && p.firstElementChild) { syncProps(L); return; }
    p.dataset.sig = sig;
    if (!L) {
      p.innerHTML = `<div class="lm-h">PROPERTIES</div><div class="lm-none">Canvas ${doc.w} × ${doc.h} px</div><div class="pgrid"><label class="pf"><span>Background</span><input id="pbg" type="color" value="${doc.bg === "transparent" ? "#ffffff" : doc.bg}"></label><label class="pf chk"><input id="pbgt" type="checkbox" ${doc.bg === "transparent" ? "checked" : ""}> Transparent</label></div>`;
      $("#pbg").oninput = (e) => doc.exec("bg", { color: e.target.value, live: true }); $("#pbg").onchange = () => doc.commit("background");
      $("#pbgt").onchange = (e) => doc.exec("bg", { color: e.target.checked ? "transparent" : $("#pbg").value });
      return;
    }
    const f = L.filters;
    let h = `<div class="lm-h">PROPERTIES<span class="sp"></span><span class="mut">${esc(L.name)}</span></div>`;
    h += `<details open><summary>Transform</summary><div class="pgrid">${field("px", "X", L.x)}${field("py", "Y", L.y)}${field("pw", "W", L.w, L.type === "text" ? "disabled" : "")}${field("ph", "H", L.h, L.type === "text" ? "disabled" : "")}${field("pr", "Rotate", L.rot)}
      <div class="pbtns"><button class="lm-mini" data-a="flipX">Flip H</button><button class="lm-mini" data-a="flipY">Flip V</button><button class="lm-mini" data-a="center">Centre</button><button class="lm-mini" data-a="fit">Fit</button></div></div></details>`;
    h += `<details open><summary>Appearance</summary>${slider("po", "Opacity", Math.round(L.opacity * 100), 0, 100, 1, "%")}<label class="pf"><span>Blend</span><select id="pb">${BLENDS.map((b) => `<option ${b === L.blend ? "selected" : ""}>${b}</option>`).join("")}</select></label></details>`;
    if (L.type === "text") h += `<details open><summary>Text</summary><textarea id="ptext" rows="2" aria-label="Text content">${esc(L.text)}</textarea>
      <div class="pgrid"><label class="pf"><span>Font</span><select id="pfont">${FONTS.map((x) => `<option ${x === L.font ? "selected" : ""}>${x}</option>`).join("")}</select></label>${field("psize", "Size", L.size, 'min="1"')}
      <label class="pf"><span>Colour</span><input id="pcol" type="color" value="${L.color}"></label><label class="pf"><span>Align</span><select id="palign">${["left", "center", "right"].map((x) => `<option ${x === L.align ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <label class="pf"><span>Outline</span><input id="pstk" type="color" value="${L.stroke}"></label>${field("pstkw", "Outline W", L.strokeW, 'min="0"')}
      <div class="pbtns"><button class="lm-mini" id="pbold" aria-pressed="${!!L.bold}">Bold</button><button class="lm-mini" id="pital" aria-pressed="${!!L.italic}">Italic</button><button class="lm-mini" id="pemoji">Emoji…</button></div></div></details>`;
    if (L.type === "shape") h += `<details open><summary>Shape</summary><div class="pgrid"><label class="pf"><span>Kind</span><select id="pshape">${SHAPES.map((x) => `<option ${x === L.shape ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <label class="pf"><span>Fill</span><input id="pfill" type="color" value="${L.fill === "transparent" ? "#000000" : L.fill}"></label><label class="pf"><span>Stroke</span><input id="pstroke" type="color" value="${L.stroke}"></label>${field("pstrokew", "Stroke W", L.strokeW, 'min="0"')}${L.shape === "rect" ? field("prad", "Radius", L.radius, 'min="0"') : ""}</div></details>`;
    if (isRaster(L)) h += `<details><summary>Background removal</summary><div class="pgrid">${field("ptol", "Tolerance %", S.tol, 'min="0" max="100"')}<div class="pbtns"><button class="lm-mini" data-a="removebg">Remove background</button></div></div></details>`;
    h += `<details><summary>Adjust</summary>${[["brightness", "Brightness", 0, 300], ["contrast", "Contrast", 0, 300], ["saturate", "Saturation", 0, 300], ["hue", "Hue", -180, 180], ["blur", "Blur", 0, 60], ["gray", "Grayscale", 0, 100], ["sepia", "Sepia", 0, 100], ["invert", "Invert", 0, 100]].map(([k, n, a, b]) => slider("f_" + k, n, f[k], a, b)).join("")}<div class="pbtns"><button class="lm-mini" data-a="resetfx">Reset</button></div></details>`;
    h += `<details><summary>Shadow</summary><label class="pf chk"><input id="psh" type="checkbox" ${L.shadow ? "checked" : ""}> Drop shadow</label>${L.shadow ? `<div class="pgrid"><label class="pf"><span>Colour</span><input id="pshc" type="color" value="${hex6(L.shadow.color)}"></label>${field("pshb", "Blur", L.shadow.blur, 'min="0"')}${field("pshx", "X", L.shadow.x)}${field("pshy", "Y", L.shadow.y)}</div>` : ""}</details>`;
    h += `<details open><summary>Animation</summary><label class="pf"><span>Effect</span><select id="pan">${ANIMS.map((x) => `<option ${x === L.anim.kind ? "selected" : ""}>${x}</option>`).join("")}</select></label><div class="pgrid">${field("pas", "Start (s)", L.anim.start, 'min="0" step="0.1"')}${field("pae", "End (s)", L.anim.end, 'min="0" step="0.1"')}</div></details>`;
    const wasOpen = new Map([...p.querySelectorAll("details")].map((d) => [d.querySelector("summary").textContent, d.open]));
    p.innerHTML = h;
    p.querySelectorAll("details").forEach((d) => { const k = d.querySelector("summary").textContent; if (wasOpen.has(k)) d.open = wasOpen.get(k); }); // keep sections as the user left them
    bindProps(L);
  }
  const hex6 = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : "#000000");

  function bindProps(L) {
    const num = (id, key, live = true) => { const x = $("#" + id); if (!x) return; x.oninput = () => { if (x.value === "" || isNaN(+x.value)) return; doc.exec("set", { id: L.id, [key]: +x.value, live: true }); }; x.onchange = () => doc.commit("edit " + key); };
    num("px", "x"); num("py", "y"); num("pw", "w"); num("ph", "h"); num("pr", "rot"); num("psize", "size"); num("pstkw", "strokeW"); num("pstrokew", "strokeW"); num("prad", "radius");
    const live = (id, fn) => { const x = $("#" + id); if (!x) return; x.oninput = () => { fn(x); }; x.onchange = () => doc.commit("edit"); };
    const setL = (o) => doc.exec("set", { id: L.id, ...o, live: true });
    live("po", (x) => { setL({ opacity: +x.value / 100 }); x.nextElementSibling.textContent = x.value + "%"; });
    const pb = $("#pb"); pb.onchange = () => doc.exec("set", { id: L.id, blend: pb.value });
    const t = $("#ptext"); if (t) { t.oninput = () => setL({ text: t.value, name: undefined }); t.onchange = () => { doc.exec("rename", { id: L.id, name: (t.value.split("\n")[0] || "Text").slice(0, 24), live: true }); doc.commit("edit text"); renderLayers(); }; }
    live("pcol", (x) => setL({ color: x.value })); live("pstk", (x) => setL({ stroke: x.value })); live("pfill", (x) => setL({ fill: x.value })); live("pstroke", (x) => setL({ stroke: x.value })); live("pshc", (x) => setL({ shadow: { color: x.value } }));
    for (const [id, key] of [["pfont", "font"], ["palign", "align"], ["pshape", "shape"]]) { const x = $("#" + id); if (x) x.onchange = () => doc.exec("set", { id: L.id, [key]: x.value }); }
    for (const [id, key] of [["pbold", "bold"], ["pital", "italic"]]) { const x = $("#" + id); if (x) x.onclick = () => doc.exec("set", { id: L.id, [key]: !L[key] }); }
    const pe = $("#pemoji"); if (pe) pe.onclick = () => emojiDialog(true);
    for (const k of Object.keys(FILTERS0)) live("f_" + k, (x) => { setL({ [k]: +x.value }); x.nextElementSibling.textContent = x.value; });
    const sh = $("#psh"); if (sh) sh.onchange = () => doc.exec("set", { id: L.id, shadow: sh.checked ? true : false });
    for (const [id, key] of [["pshb", "blur"], ["pshx", "x"], ["pshy", "y"]]) { const x = $("#" + id); if (x) { x.oninput = () => setL({ shadow: { [key]: +x.value } }); x.onchange = () => doc.commit("shadow"); } }
    const an = $("#pan"); if (an) an.onchange = () => { const a = doc.L(L.id).anim; doc.exec("animate", { id: L.id, kind: an.value, start: a.start, end: an.value !== "none" && a.end <= a.start ? a.start + 1 : a.end }); };
    num("pas", "start"); num("pae", "end");
    for (const id of ["pas", "pae"]) { const x = $("#" + id); if (x) { x.oninput = () => { doc.exec("animate", { id: L.id, [id === "pas" ? "start" : "end"]: +x.value, live: true }); renderTimeline(); }; } }
    const tol = $("#ptol"); if (tol) tol.oninput = () => (S.tol = clamp(+tol.value, 0, 100));
    el.props.onclick = (e) => {
      const b = e.target.closest("[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "flipX" || a === "flipY") doc.exec("set", { id: L.id, [a]: !L[a] });
      else if (a === "center") doc.exec("align", { id: L.id, to: "center" });
      else if (a === "fit") doc.exec("fit", { id: L.id });
      else if (a === "removebg") { const r = doc.exec("remove_bg", { id: L.id, tol: S.tol }); status(`Removed ${r.erasedPixels} background pixels`); }
      else if (a === "resetfx") doc.exec("set", { id: L.id, ...FILTERS0 });
    };
  }

  // ---------- timeline ----------
  // Every layer can carry several effect clips (the engine keeps the first in L.anim, the rest in L.fx).
  // Clips are dragged to move, dragged by their edges to retime, picked to edit in the inspector, and
  // added from the "+ Add effect" menu, by double-clicking a track, or from Animate › Add effect.
  const fmtT = (t) => t.toFixed(2) + "s";
  const NAME_W = 110, GUTTER = 14;
  const headLeft = (f) => `calc(${NAME_W}px + (100% - ${NAME_W + GUTTER}px) * ${f})`;
  function clipList(L) {
    const out = [];
    if (L.anim && L.anim.kind !== "none") out.push({ i: 0, c: L.anim });
    (L.fx || []).forEach((c, j) => out.push({ i: j + 1, c }));
    return out;
  }
  const clipOf = (ref) => { const L = ref && doc.L(ref.id); if (!L) return null; const hit = clipList(L).find((x) => x.i === ref.i); return hit ? { L, ...hit } : null; };
  function rulerTicks(D) {
    const pxPerSec = (700 * S.tlk) / D, step = [0.25, 0.5, 1, 2, 5, 10, 30].find((st) => pxPerSec * st >= 44) || 30, out = [];
    for (let t = 0; t <= D + 1e-6; t += step) out.push(`<i style="left:${(t / D) * 100}%">${+t.toFixed(2)}s</i>`);
    return out.join("");
  }
  const LANE = 20;
  /** a layer's track: clips that overlap in time are stacked in their own lanes so none hides another */
  function trackHtml(l, D) {
    const ends = []; // end time of the last clip in each lane
    const clips = clipList(l).map(({ i, c }) => {
      let lane = ends.findIndex((e) => e <= c.start + 1e-6); if (lane < 0) lane = ends.length;
      ends[lane] = c.end; return { i, c, lane };
    });
    const h = Math.max(1, ends.length) * LANE;
    return `<div class="tl-track" data-id="${l.id}" style="height:${h - 2}px">${clips.map(({ i, c, lane }) => `<div class="tl-clip${S.clip && S.clip.id === l.id && S.clip.i === i ? " sel" : ""}" data-id="${l.id}" data-i="${i}" style="top:${lane * LANE}px;height:${LANE - 4}px;left:${(c.start / D) * 100}%;width:${(Math.max(0.05, c.end - c.start) / D) * 100}%"><u data-edge="s"></u>${c.kind}<u data-edge="e"></u></div>`).join("")}</div>`;
  }
  function renderTimeline() {
    const tl = el.timeline;
    tl.hidden = !S.tl;
    $("#lmtlt").setAttribute("aria-pressed", String(S.tl));
    if (!S.tl) return;
    const D = doc.duration, L0 = sel();
    tl.innerHTML = `<div class="tl-bar">
        <button class="lm-btn" id="tlstop" title="Back to start" aria-label="Stop and go to start">${svg("stop", 14)}</button>
        <button class="lm-btn" id="tlprev" title="Previous frame" aria-label="Previous frame">${svg("prev", 14)}</button>
        <button class="lm-btn" id="tlplay" aria-label="${S.playing ? "Pause" : "Play"}">${svg(S.playing ? "pause" : "play", 14)}</button>
        <button class="lm-btn" id="tlnext" title="Next frame" aria-label="Next frame">${svg("next", 14)}</button>
        <span class="mono" id="tltime">${fmtT(S.t)} / ${fmtT(D)} · ${doc.fps} fps</span>
        <label class="chk"><input type="checkbox" id="tlloop" ${S.loop ? "checked" : ""}> Loop</label>
        <span class="sp"></span>
        <button class="lm-mini" id="tlz-" aria-label="Zoom timeline out">−</button><span class="mut">zoom</span><button class="lm-mini" id="tlz+" aria-label="Zoom timeline in">+</button>
        <select id="tladd" aria-label="Add an effect to the selected layer" ${L0 ? "" : "disabled"}><option value="">+ Add effect…</option>${ANIMS.filter((x) => x !== "none").map((x) => `<option>${x}</option>`).join("")}</select>
      </div>
      <div class="tl-insp" id="tlinsp"></div>
      <div class="tl-scroll" id="tlscroll"><div class="tl-inner" id="tlinner" style="width:${S.tlk * 100}%">
        <div class="tl-ruler" id="tlruler">${rulerTicks(D)}</div>
        ${doc.layers.slice().reverse().map((l) => `<div class="tl-row${l.id === doc.sel ? " act" : ""}" data-id="${l.id}"><span class="tl-name" title="${esc(l.name)}">${esc(l.name)}</span>${trackHtml(l, D)}</div>`).join("")}
        ${doc.layers.length ? "" : '<div class="lm-none" style="padding:10px 16px">Add a layer, then give it an effect to animate it.</div>'}
        <b class="tl-head" id="tlhead" style="left:${headLeft(S.t / D)}"></b>
      </div></div>`;
    renderInspector();
    $("#tlloop").onchange = (e) => (S.loop = e.target.checked);
    $("#tladd").onchange = (e) => { if (e.target.value) addClipAtPlayhead(e.target.value); e.target.value = ""; };
  }
  function renderInspector() {
    const box = $("#tlinsp"); if (!box) return;
    const k = clipOf(S.clip);
    if (!k) { box.innerHTML = `<span class="mut">${doc.layers.length ? "Click a clip to edit it · drag to move · drag its edges to retime · double-click a track to add an effect" : ""}</span>`; return; }
    box.innerHTML = `<span class="mut">${esc(k.L.name)}</span><label>Effect <select id="tlkind">${ANIMS.filter((x) => x !== "none").map((x) => `<option ${x === k.c.kind ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <label>Start <input id="tlstart" type="number" min="0" step="0.05" value="${rnd(k.c.start)}"></label><label>End <input id="tlend" type="number" min="0" step="0.05" value="${rnd(k.c.end)}"></label>
      <button class="lm-mini" id="tlcdel">Delete clip</button>`;
    const c = S.clip, set = (o) => { doc.exec("animate", { id: c.id, index: c.i, ...o }); };
    $("#tlkind").onchange = (e) => set({ kind: e.target.value });
    $("#tlstart").onchange = (e) => set({ start: Math.max(0, +e.target.value) });
    $("#tlend").onchange = (e) => set({ end: +e.target.value });
    $("#tlcdel").onclick = removeClip;
  }
  function removeClip() { const c = S.clip; if (!c) return; S.clip = null; try { doc.exec("remove_clip", { id: c.id, index: c.i }); } catch (e) { status(e.message); } }
  function addClipAtPlayhead(kind = "fade-in", at = S.t, id) {
    const L = id ? doc.L(id) : sel(); if (!L) { status("Select a layer first"); return; }
    const start = Math.min(Math.round(at * 20) / 20, Math.max(0, doc.duration - 0.1)), end = Math.min(doc.duration, start + 1);
    const r = exe("add_clip", { id: L.id, kind, start, end: Math.max(end, start + 0.1) });
    if (r) { S.clip = { id: L.id, i: r.index }; S.tlFocus = true; renderTimeline(); }
  }
  function setPlaying(on) {
    S.playing = on;
    if (on) S.scrub = true;
    if (on) { if (!S.loop && S.t >= doc.duration - 0.01) S.t = 0; S.t0 = performance.now() - S.t * 1000; tick(); } else render();
    const b = $("#tlplay"); if (b) { b.innerHTML = svg(S.playing ? "pause" : "play", 14); b.setAttribute("aria-label", S.playing ? "Pause" : "Play"); }
  }
  function togglePlay() { setPlaying(!S.playing); }
  function tick() {
    if (!S.playing || !S.open) return;
    const t = (performance.now() - S.t0) / 1000;
    if (S.loop) S.t = t % doc.duration;
    else if (t >= doc.duration) { S.t = doc.duration; updateHead(); draw(); setPlaying(false); return; }
    else S.t = t;
    updateHead(); draw();
    requestAnimationFrame(tick);
  }
  function seek(t) { S.t = clamp(t, 0, doc.duration); if (S.playing) S.t0 = performance.now() - S.t * 1000; updateHead(); draw(); }
  function updateHead() {
    const h = $("#tlhead"), t = $("#tltime");
    if (h) h.style.left = headLeft(S.t / doc.duration);
    if (t) t.textContent = `${fmtT(S.t)} / ${fmtT(doc.duration)} · ${doc.fps} fps`;
  }
  function toggleTimeline() { S.tl = !S.tl; renderTimeline(); requestAnimationFrame(() => { layoutView(); fit(); }); }
  function tlPointer(e) {
    S.tlFocus = true;
    const clip = e.target.closest(".tl-clip"), ruler = e.target.closest("#tlruler");
    if (ruler) {
      const scrub = (ev) => { const r = ruler.getBoundingClientRect(); S.playing = false; S.scrub = true; S.t = Math.round(clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1) * doc.duration * doc.fps) / doc.fps; updateHead(); draw(); }; // scrubbing snaps to whole frames
      scrub(e); const mv = (ev) => scrub(ev), up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); }; addEventListener("pointermove", mv); addEventListener("pointerup", up); return;
    }
    const row = e.target.closest(".tl-row");
    if (row && !clip) { if (doc.sel !== row.dataset.id) doc.exec("select", { id: row.dataset.id }); return; }
    if (!clip) return;
    const id = clip.dataset.id, idx = +clip.dataset.i, L = doc.L(id), track = clip.parentElement, edge = e.target.dataset.edge;
    const c0 = clipList(L).find((x) => x.i === idx).c, a0 = { start: c0.start, end: c0.end }, x0 = e.clientX;
    S.clip = { id, i: idx };
    if (doc.sel !== id) doc.exec("select", { id }); // re-renders; re-find the live clip element below
    $$(".tl-clip", el.timeline).forEach((x) => x.classList.toggle("sel", x.dataset.id === id && +x.dataset.i === idx));
    renderInspector();
    const live = $$(".tl-clip", el.timeline).find((x) => x.dataset.id === id && +x.dataset.i === idx) || clip;
    const wTrack = track.getBoundingClientRect().width;
    let moved = false;
    const mv = (ev) => {
      const dt = ((ev.clientX - x0) / wTrack) * doc.duration;
      let s0 = a0.start, en = a0.end;
      if (edge === "s") s0 = clamp(a0.start + dt, 0, a0.end - 0.1); else if (edge === "e") en = clamp(a0.end + dt, a0.start + 0.1, doc.duration); else { const len = a0.end - a0.start; s0 = clamp(a0.start + dt, 0, Math.max(0, doc.duration - len)); en = s0 + len; }
      s0 = Math.round(s0 * 20) / 20; en = Math.round(en * 20) / 20; moved = true;
      doc.exec("animate", { id, index: idx, start: s0, end: en, live: true });
      live.style.left = (s0 / doc.duration) * 100 + "%"; live.style.width = ((en - s0) / doc.duration) * 100 + "%";
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); if (moved) doc.commit("retime"); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  }
  function tlDouble(e) {
    const tr = e.target.closest(".tl-track"); if (!tr || e.target.closest(".tl-clip")) return;
    const r = tr.getBoundingClientRect();
    addClipAtPlayhead("fade-in", clamp((e.clientX - r.left) / r.width, 0, 1) * doc.duration, tr.dataset.id);
  }

  // ---------- Claude dock ----------
  let sess = null, es = null, bridge = null, thinking = null, chatLog = null, chatIn = null, ai = "idle", aiEdits = 0;
  function buildClaude() {
    el.claude.innerHTML = `<div class="lm-h cl">CLAUDE<span class="sp"></span><span class="lm-ai" id="lmai" data-s="idle">idle</span></div>
      <div class="cl-log" id="cllog" role="log" aria-live="polite"></div>
      <div class="cl-in"><input id="clin" placeholder="Ask Claude to edit… or /help" aria-label="Message Claude"><button class="lm-btn gold" id="clsend">Send</button></div>`;
    chatLog = $("#cllog"); chatIn = $("#clin");
    const send = () => { const v = chatIn.value.trim(); if (v) { chatIn.value = ""; chatSend(v); } };
    $("#clsend").onclick = send;
    chatIn.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") send(); if (e.key === "Escape") chatIn.blur(); };
  }
  function put(cls, text) { const d = document.createElement("div"); d.className = "m " + cls; d.textContent = text; chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight; return d; }
  function setAI(s) { ai = s; const a = $("#lmai"); if (a) { a.dataset.s = s; a.textContent = s === "working" ? `working · ${aiEdits} edit${aiEdits === 1 ? "" : "s"}` : s; } }
  async function chatSend(text) {
    put("u", text);
    if (text.startsWith("/")) { slash(text); return; }
    if (!sess) { put("e", "Claude is offline — run `npm run agents`. Slash commands still work: /help"); return; }
    aiEdits = 0; setAI("working");
    try { await fetch(API + "/session/" + sess + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); }
    catch (_) { put("e", "could not reach the agent server"); setAI("stopped"); }
  }
  function slash(text) {
    const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
    if (!cmd || cmd === "help") { put("m", "Commands: /state · /text Hello · /shape ellipse · /undo · /redo · /crop x y w h · /bg #hex · /<any command> key=value … (see /commands)"); return; }
    if (cmd === "commands") { put("m", Object.keys(doc.exec("help").commands).join(" · ")); return; }
    const args = {}; const pos = [];
    for (const r of rest) { const i = r.indexOf("="); if (i > 0) args[r.slice(0, i)] = r.slice(i + 1); else pos.push(r); }
    if (cmd === "text") args.text = args.text || pos.join(" ") || "Text";
    if (cmd === "shape") { args.shape = args.shape || pos[0]; }
    if (cmd === "bg" && pos[0]) args.color = pos[0];
    if (cmd === "crop" && pos.length >= 4) [args.x, args.y, args.w, args.h] = pos;
    const real = cmd === "text" ? "add_text" : cmd === "shape" ? "add_shape" : cmd;
    Promise.resolve().then(() => doc.exec(real, args)).then((r) => put("r", `${real} → ${summarize(r)}`)).catch((e) => put("e", "✕ " + e.message));
  }
  const summarize = (r) => { const s = typeof r === "string" ? r : JSON.stringify(r); return s.length > 140 ? s.slice(0, 140) + "…" : s; };
  const MUTATE = new Set(["add_text", "add_shape", "add_image", "add_draw", "set", "adjust", "animate", "delete", "duplicate", "reorder", "align", "fit", "remove_bg", "rasterize", "merge_down", "flatten", "crop", "canvas_size", "bg", "new", "clear", "rename", "duration", "undo", "redo", "fill_selection", "clear_selection", "selection_to_layer", "crop_to_selection", "bucket", "gradient", "filter", "flip_canvas", "rotate_canvas", "add_clip", "remove_clip"]);
  async function chatConnect() {
    if (sess || S.connecting) return; S.connecting = true;
    try {
      const r = await fetch(API + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "lumen", name: "LUMEN" }) });
      if (!r.ok) throw new Error("session failed");
      sess = (await r.json()).id;
      es = new EventSource(API + "/session/" + sess + "/events");
      es.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "hello") { put("m", "connected · Claude can edit this canvas"); return; }
        if (thinking) { thinking.remove(); thinking = null; }
        if (m.type === "meta" && m.text === "thinking…") { thinking = put("m", "thinking…"); setAI("working"); return; }
        if (m.type === "meta") put("m", m.text);
        else if (m.type === "text") put("a", m.text);
        else if (m.type === "tool") put("t", "▸ " + m.name + (m.hint ? ": " + m.hint : ""));
        else if (m.type === "error") put("e", "✕ " + m.text);
        else if (m.type === "done" && ai === "working") setAI("done");
      };
      bridge = new EventSource(API + "/lumen/events");
      bridge.onmessage = async (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type !== "cmd") return;
        let out;
        try {
          const res = await doc.exec(m.cmd, m.args);
          out = { id: m.id, ok: true, result: res };
          if (MUTATE.has(m.cmd)) { aiEdits++; setAI("working"); }
          if (m.cmd !== "state" && m.cmd !== "help") put("r", `⌁ ${m.cmd} → ${summarize(res)}`);
        } catch (e) { out = { id: m.id, ok: false, error: e.message }; put("e", `⌁ ${m.cmd} ✕ ${e.message}`); }
        fetch(API + "/lumen/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out) }).catch(() => {});
      };
    } catch (_) {
      put("m", "agent server offline — run `npm run agents` to let Claude edit the canvas. Slash commands work without it: try /help");
      setAI("offline");
    }
    S.connecting = false;
  }

  // ---------- wiring ----------
  let autosaveT = 0;
  function autosave() {
    clearTimeout(autosaveT);
    autosaveT = setTimeout(() => { try { localStorage.setItem(STORE, doc.toJSON()); } catch (_) { status("Too large to autosave — use File › Save project"); } }, 900);
  }
  function renderAll() {
    layoutView(); renderLayers(); renderProps(); renderTimeline(); render();
    $("#lmfile").textContent = `${doc.name || "untitled"} · ${doc.w} × ${doc.h} px`;
    const ud = $("#lmnew"); void ud;
  }
  function undo() { if (doc.undo()) renderAll(); }
  function redo() { if (doc.redo()) renderAll(); }

  function wire() {
    const r = el.root;
    r.querySelector("#lmclose").onclick = () => closeLumen();
    r.querySelector("#lmnew").onclick = newDialog;
    r.querySelector("#lmexport").onclick = exportDialog;
    r.querySelector("#lmtools").onclick = (e) => { const b = e.target.closest("[data-tool]"); if (b) setTool(b.dataset.tool); };
    r.querySelector("#lmfg").oninput = (e) => setFg(e.target.value);
    r.querySelector("#lmbg").oninput = (e) => setBg(e.target.value);
    setInterval(() => { if (S.open && doc.selMask && !modalOpen()) render(); }, 130); // marching ants
    r.querySelector(".lm-menus").onclick = (e) => { const b = e.target.closest(".lm-mbtn"); if (!b) return; const dd = $(`[data-dd="${b.dataset.menu}"]`); if (dd.classList.contains("on")) closeMenus(); else openMenu(b.dataset.menu); };
    r.addEventListener("pointerdown", (e) => { if (!e.target.closest(".lm-mwrap")) closeMenus(); });
    el.stage.addEventListener("pointerdown", ptrDown); el.stage.addEventListener("pointermove", ptrMove); el.stage.addEventListener("pointerup", ptrUp); el.stage.addEventListener("pointercancel", ptrUp);
    el.stage.addEventListener("dblclick", (e) => { const p = toDoc(e.clientX, e.clientY), h = doc.hit(p.x, p.y); if (h && h.type === "text") { doc.exec("select", { id: h.id }); setTimeout(() => { const t = $("#ptext"); if (t) { t.focus(); t.select(); } }, 0); } });
    el.stage.addEventListener("wheel", (e) => { e.preventDefault(); const rc = el.stage.getBoundingClientRect(); if (e.ctrlKey || e.metaKey || S.tool === "zoom") zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rc.left, e.clientY - rc.top); else { S.px -= e.deltaX; S.py -= e.deltaY; layoutView(); render(); } }, { passive: false });
    r.querySelector("#lmz-").onclick = () => zoomAt(1 / 1.25); r.querySelector("#lmz\\+").onclick = () => zoomAt(1.25); r.querySelector("#lmfit").onclick = fit;
    r.querySelector("#lmtlt").onclick = () => toggleTimeline();
    // layers
    r.querySelector("#lmadd").onclick = () => doc.exec("add_draw"); r.querySelector("#lmdup").onclick = () => sel() && doc.exec("duplicate");
    r.querySelector("#lmup").onclick = () => sel() && doc.exec("reorder", { dir: "up" }); r.querySelector("#lmdown").onclick = () => sel() && doc.exec("reorder", { dir: "down" });
    r.querySelector("#lmdel").onclick = () => sel() && doc.exec("delete");
    el.layers.addEventListener("click", (e) => {
      const row = e.target.closest(".lm-layer"); if (!row) return;
      const id = row.dataset.id, act = e.target.closest("[data-act]")?.dataset.act, L = doc.L(id);
      if (act === "vis") doc.exec("set", { id, visible: !L.visible }); else if (act === "lock") doc.exec("set", { id, locked: !L.locked }); else if (doc.sel !== id) doc.exec("select", { id }); // re-selecting would rebuild the rows and swallow a double-click rename
    });
    el.layers.addEventListener("dblclick", (e) => {
      const n = e.target.closest('[data-act="name"]'); if (!n) return;
      const id = n.closest(".lm-layer").dataset.id, inp = document.createElement("input"); inp.value = doc.L(id).name; inp.className = "rename"; n.replaceWith(inp); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); // caret at the end, so typing extends the name
      const fin = (ok) => { if (ok && inp.value.trim()) doc.exec("rename", { id, name: inp.value.trim() }); else renderLayers(); };
      inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") fin(true); if (ev.key === "Escape") fin(false); }; inp.onblur = () => fin(true);
    });
    let dragId = null;
    el.layers.addEventListener("dragstart", (e) => { const row = e.target.closest(".lm-layer"); if (row) { dragId = row.dataset.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); } });
    el.layers.addEventListener("dragover", (e) => { if (dragId) e.preventDefault(); });
    el.layers.addEventListener("drop", (e) => { const row = e.target.closest(".lm-layer"); if (!row || !dragId) return; e.preventDefault(); const to = doc.layers.findIndex((l) => l.id === row.dataset.id); doc.exec("reorder", { id: dragId, index: to }); dragId = null; });
    el.timeline.addEventListener("pointerdown", tlPointer);
    el.timeline.addEventListener("dblclick", tlDouble);
    el.timeline.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.id === "tlplay") togglePlay();
      else if (b.id === "tlstop") { setPlaying(false); S.scrub = false; seek(0); }
      else if (b.id === "tlprev") { setPlaying(false); S.scrub = true; seek(S.t - 1 / doc.fps); }
      else if (b.id === "tlnext") { setPlaying(false); S.scrub = true; seek(S.t + 1 / doc.fps); }
      else if (b.id === "tlz-") { S.tlk = Math.max(1, S.tlk / 1.5); renderTimeline(); }
      else if (b.id === "tlz+") { S.tlk = Math.min(12, S.tlk * 1.5); renderTimeline(); }
    });
    el.stage.addEventListener("pointerdown", () => (S.tlFocus = false), true);
    el.layers.addEventListener("pointerdown", () => (S.tlFocus = false), true);
    // files
    el.filein.onchange = () => { importFiles([...el.filein.files]); el.filein.value = ""; };
    el.stage.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
    el.stage.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); } });
    // doc events
    doc.on((kind) => { if (!S.open) return; if (kind === "selection") { render(); const b = doc.selBounds(); if (b) status(`Selection ${b.w} × ${b.h} px`); return; }
      if (kind === "live") { renderLayersLight(); render(); return; } if (kind === "commit" || kind === "restore" || kind === "select") { renderAll(); if (kind === "commit") autosave(); } });
    new ResizeObserver(() => { if (S.open) { layoutView(); render(); } }).observe(el.stage);
  }
  function renderLayersLight() { const L = sel(); if (!L) return; for (const [id, v] of [["px", L.x], ["py", L.y], ["pw", L.w], ["ph", L.h], ["pr", L.rot], ["psize", L.size]]) { const x = $("#" + id); if (x && document.activeElement !== x && v !== undefined) x.value = rnd(v); } }

  // ---------- keyboard / clipboard ----------
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  addEventListener("keydown", (e) => {
    if (!S.open) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (k === "escape") e.lmHandled = true; // index.html also listens for Esc — tell it this press is already dealt with
    if (modalOpen()) { if (k === "escape") closeModal(); return; }
    if (typing(e)) { if (k === "escape") e.target.blur(); return; }
    if (e.key === " ") { S.space = true; e.preventDefault(); el.stage.style.cursor = "grab"; return; }
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === "a") { e.preventDefault(); exe("select_all"); return; }
    if (mod && e.shiftKey && k === "i") { e.preventDefault(); exe("invert_selection"); return; }
    if (mod && k === "j") { e.preventDefault(); if (hasSel() && sel()) exe("selection_to_layer", { cut: e.shiftKey }); return; }
    if (mod && k === "backspace") { e.preventDefault(); exe("fill_selection", { color: S.bgc }); return; }
    if (e.altKey && k === "backspace") { e.preventDefault(); exe("fill_selection", { color: S.fg }); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod && k === "d") { e.preventDefault(); sel() && doc.exec("duplicate"); return; }
    if (mod && k === "s") { e.preventDefault(); saveProject(); return; }
    if (mod && k === "e") { e.preventDefault(); exportDialog(); return; }
    if (mod && k === "n") { e.preventDefault(); newDialog(); return; }
    if (mod && k === "o") { e.preventDefault(); el.filein.click(); return; }
    if (mod && (k === "0")) { e.preventDefault(); fit(); return; }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); zoomAt(1.25); return; }
    if (mod && k === "-") { e.preventDefault(); zoomAt(1 / 1.25); return; }
    if (mod) return;
    if (k === "enter" && S.tool === "crop") { applyCrop(); return; }
    if ((k === "delete" || k === "backspace") && S.clip && S.tlFocus) { e.preventDefault(); removeClip(); return; }
    if (k === "delete" || k === "backspace") {
      if (hasSel() && sel() && isRaster(sel())) { e.preventDefault(); exe("clear_selection"); return; }
      if (sel()) { e.preventDefault(); doc.exec("delete"); } return;
    }
    if (k.startsWith("arrow") && sel() && !sel().locked) { e.preventDefault(); const n = e.shiftKey ? 10 : 1, L = sel(); doc.exec("set", { x: L.x + (k === "arrowright" ? n : k === "arrowleft" ? -n : 0), y: L.y + (k === "arrowdown" ? n : k === "arrowup" ? -n : 0) }); return; }
    if (k === "[") { S.brush.size = Math.max(1, Math.round(S.brush.size * 0.85)); renderOpts(); return; }
    if (k === "]") { S.brush.size = Math.min(1000, Math.round(S.brush.size * 1.18) + 1); renderOpts(); return; }
    if (k === "escape") { lmEscape(); return; }
    const t = TOOLS.find((x) => x[2] === k); if (t) setTool(t[0]);
  });
  addEventListener("keyup", (e) => { if (e.key === " " && S.space) { S.space = false; setTool(S.tool); } });
  addEventListener("paste", async (e) => {
    if (!S.open || modalOpen()) return;
    if (typing(e) && !(e.target === chatIn && false)) return;
    const cd = e.clipboardData; if (!cd) return;
    const files = [...cd.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); await importFiles(files); return; }
    const txt = cd.getData("text/plain");
    if (txt && txt.trim()) { e.preventDefault(); S.touched = true; doc.exec("add_text", { text: txt.trim().slice(0, 500), size: Math.round(doc.h / (/\p{Extended_Pictographic}/u.test(txt) && txt.length < 8 ? 5 : 12)), color: S.fg === "#ffffff" ? "#111111" : "#111111" }); status("Pasted text"); }
  });

  // ---------- open / close ----------
  window.lmEscape = function () {
    if (modalOpen()) { closeModal(); return; }
    if (S.tool === "crop" && S.crop) { S.crop = null; render(); return; }
    if (hasSel()) { exe("deselect"); return; }
    if (S.playing) { togglePlay(); return; }
    closeLumen();
  };
  window.openLumen = function () {
    if (S.open) return;
    const root = document.getElementById("lm");
    if (!S.built) {
      build(); S.built = true;
      let saved = null; try { saved = localStorage.getItem(STORE); } catch (_) { /* private mode */ }
      const done = () => { setTool("move"); setFg(S.fg); setBg(S.bgc); renderAll(); };
      if (saved) doc.load(saved).then(done).catch(() => { doc.exec("new", { w: 1920, h: 1080 }); done(); });
      else { doc.exec("new", { w: 1920, h: 1080 }); done(); S.first = true; }
    }
    S.open = true;
    document.getElementById("ui").style.visibility = "hidden";
    root.style.display = "flex";
    requestAnimationFrame(() => { root.classList.add("on"); fit(); renderAll(); if (S.first && !doc.layers.length) { S.first = false; if (!/nodialog/.test(location.search)) newDialog(); } });
    history.replaceState(null, "", "#lumen");
    chatConnect();
  };
  window.closeLumen = function () {
    if (!S.open) return;
    S.open = false; S.playing = false;
    document.getElementById("ui").style.visibility = "";
    const root = document.getElementById("lm");
    root.classList.remove("on");
    setTimeout(() => { if (!S.open) root.style.display = "none"; }, 480);
    history.replaceState(null, "", "#");
    if (typeof endDive === "function") endDive();
  };
  Object.defineProperty(window, "lmOpen", { get: () => S.open });
  addEventListener("beforeunload", () => { if (sess) fetch(API + "/session/" + sess, { method: "DELETE", keepalive: true }).catch(() => {}); });
})();
