// TRACE UI — the interactive board canvas, panels and the Claude dock.
// Depends on trace/engine.js (window.TraceEngine). Exposes: TRACE (the live
// Board), openTrace(), closeTrace(), trEscape(), trOpen.
(function () {
  "use strict";
  const { Board, PARTS, RULES, USAGE, defOf, registerPart } = window.TraceEngine;
  const board = new Board();
  window.TRACE = board;

  const API = "http://127.0.0.1:" + (new URLSearchParams(location.search).get("agents") || "57253");
  const STORE = "trace-board-v1";
  const COL = { fcu: "#e0894a", bcu: "#4a9fd6", gold: "#e3b04b", mask: "#0e5a3a", bare: "#1a2a20",
    silk: "#e8efe9", claude: "#ff7ac8", meas: "#7fd4ff", bad: "#ff5a5a" };
  const SVGNS = "http://www.w3.org/2000/svg";

  const S = {
    open: false, built: false, tool: "select", layer: "F.Cu", width: 0.25, grid: 0.25, net: "",
    partType: "resistor", sel: null, view: { x: -8, y: -8, w: 76, h: 56 },
    vis: { fcu: true, bcu: true, silk: true, mask: true, dims: true, safe: true },
    cursor: null, route: null, meas: null, drag: null, pan: null, space: false,
    mark: null, hlNet: null, drc: { errors: [], warnings: [] }, rot: 0,
    tab: "board", safe: { level: "unknown", summary: "", issues: [], rails: [], parts: {}, traces: {}, pads: {}, counts: { danger: 0, warning: 0, info: 0 } }, elecOpen: false,
  };
  let el = {}; // cached DOM
  const rnd3 = (n) => Math.round(n * 1000) / 1000;
  const snap = (v) => rnd3(Math.round(v / S.grid) * S.grid);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

  // ---------- DOM ----------
  const ICON = {
    select: '<path d="M5 3l14 8-6 2-3 6z"/>',
    place: '<rect x="6" y="6" width="12" height="12"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
    route: '<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M7 19h6l4-8V7"/>',
    measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  };
  const TOOLS = [["select", "Select (V)"], ["place", "Place part (P)"], ["route", "Route trace (W)"], ["measure", "Measure (M)"]];

  function build() {
    const root = document.getElementById("tr");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "TRACE circuit board studio");
    root.innerHTML =
      '<div class="tr-menu"><span class="tr-logo">TRACE</span><span class="tr-file">usb-dev-board.trace · Orrery constellation 03</span><span class="sp"></span>' +
      '<button class="tr-cart" id="trcart" aria-haspopup="dialog" aria-expanded="false" title="Cart — everything to buy, from one vendor"></button><button id="trclose">× close</button></div>' +
      '<div class="tr-modal tr-cartmodal" id="trcartmodal" hidden role="dialog" aria-label="Cart"></div>' +
      '<div class="tr-tools">' +
      TOOLS.map((t) => `<button class="tr-tb" data-tool="${t[0]}" aria-label="${t[1]}" title="${t[1]}" aria-pressed="false"><svg viewBox="0 0 24 24">${ICON[t[0]]}</svg></button>`).join("") +
      '<span class="div"></span><span class="lab">Width</span><input id="trwidth" type="number" step="0.05" min="0.05" value="" placeholder="class" title="Trace width — leave empty to use the wire class of the net (Rules tab)" style="width:74px" aria-label="Trace width mm">' +
      '<span class="lab">Net</span><input id="trnet" placeholder="auto" style="width:84px" aria-label="Net name for new traces">' +
      '<span class="lab">Grid</span><select id="trgrid" aria-label="Grid mm"><option>0.05</option><option>0.1</option><option selected>0.25</option><option>0.5</option><option>1</option></select>' +
      '<span class="div"></span><button class="tr-btn" id="trundo">Undo</button><button class="tr-btn" id="trredo">Redo</button>' +
      '<span class="sp"></span><button class="tr-btn" id="trnew">New</button><button class="tr-btn" id="trsample">Sample</button>' +
      '<button class="tr-btn" id="trplace" title="Engineer-style placement: connectors on the edge, decoupling caps at their pins, room for an iron">Auto-place</button><button class="tr-btn gold" id="trroute" title="Route every airwire with real copper (wire classes, vias, ground pour)">Auto-route</button><button class="tr-btn" id="trreviewbtn" title="Engineer review: what would a senior engineer fix?">Review</button><button class="tr-btn" id="trdrcbtn">Run DRC</button><button class="tr-btn gold" id="trexport">Export</button></div>' +
      '<div class="tr-main">' +
      '<aside class="tr-left"><div class="tr-ltabs" role="tablist" aria-label="Library and objects"><button role="tab" data-ltab="library" aria-selected="true">Library</button><button role="tab" data-ltab="objects" aria-selected="false">Objects</button><button role="tab" data-ltab="rules" id="trltab-rules" aria-selected="false" hidden>Rules</button></div>' +
      '<div class="tr-lpane" id="trlp-library"><div class="tr-lsearch"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="trlibq" placeholder="Keyword or part number" aria-label="Search parts" spellcheck="false" autocomplete="off"></div><div id="trlibres"></div><div id="trparts"></div></div>' +
      '<div class="tr-lpane" id="trlp-objects" hidden><div id="trtree" role="tree"></div><div class="pcbonly"><div class="tr-h">LAYERS</div><div id="trlayers"></div></div><div class="tr-h" style="margin-top:12px">NET LIST</div><div id="trnets"></div></div>' +
      '<div class="tr-lpane" id="trlp-rules" hidden></div></aside>' +
      '<section class="tr-center"><div class="tr-vtabs" role="tablist" aria-label="TRACE views">' +
      '<button role="tab" data-vtab="graph" aria-selected="true">Schematic <kbd>S</kbd></button>' +
      '<button role="tab" data-vtab="code" aria-selected="false">Code <kbd>C</kbd></button>' +
      '<button role="tab" data-vtab="board" aria-selected="false">PCB <kbd>B</kbd></button><span class="sp"></span><span class="vtab-note" id="trvnote"></span></div>' +
      '<div class="tr-graph" id="trgraph" hidden></div><div class="tr-graph" id="trcode" hidden></div>' +
      '<div class="tr-stage" id="trstage"><svg id="trsvg" xmlns="' + SVGNS + '" preserveAspectRatio="none" role="img" aria-label="PCB layout"></svg>' +
      '<div class="tr-scan"></div><div class="tr-ai" id="trai" data-state="idle" role="status" aria-live="polite"></div>' +
      '<div class="tr-stagebadge" id="trbadge"></div><div class="tr-hint" id="trhint"></div><div class="tr-tip" id="trtip" hidden></div></div>' +
      '</section>' +
      '<aside class="tr-right"><div class="tr-rtabs" role="tablist" aria-label="Side panel"><button role="tab" data-rtab="copilot" aria-selected="true">Copilot</button><button role="tab" data-rtab="inspect" aria-selected="false">Inspect <i id="trissuecount" hidden></i></button></div>' +
      '<div class="tr-rpane" id="trpane-copilot"><div class="tr-dock"><div class="tr-dockhead"><span class="dot" id="trdot"></span><b>Claude</b><span class="st" id="trst">offline</span><span class="sp"></span>' +
      '<div class="tr-mode" role="radiogroup" aria-label="AI mode"><button role="radio" data-mode="plan" aria-checked="true" title="Plan: Claude explains assumptions, calculations and a plan and waits for your OK. It cannot edit the board.">Plan</button><button role="radio" data-mode="auto" aria-checked="false" title="Auto: Claude plans and builds without waiting.">Auto</button></div></div>' +
      '<div class="tr-steps" id="trsteps" role="list" aria-label="Design workflow"></div>' +
      '<div class="tr-log" id="trlog" role="log" aria-live="polite"></div>' +
      '<div class="tr-chips" id="trchips"></div>' +
      '<div class="tr-compose"><textarea id="trin" rows="2" placeholder="Describe what you want to build…   (or /place type=resistor x=20 y=10)" spellcheck="false" autocomplete="off" aria-label="Message Claude"></textarea><button class="tr-send" id="trsend" aria-label="Send message" title="Send (Enter)">↑</button></div></div></div>' +
      '<div class="tr-rpane" id="trpane-inspect" hidden><div><div class="tr-h">INSPECTOR</div><div id="trinsp"></div></div>' +
      '<div><div class="tr-h">ENGINEER REVIEW</div><div id="trreview"></div></div>' +
      '<div><div class="tr-h">ELECTRICAL SAFETY</div><div id="trsafe"></div></div>' +
      '<div><div class="tr-h">BOARD</div><div id="trboard"></div></div>' +
      '<div><div class="tr-h">DRC</div><div id="trdrc"></div></div>' +
      '<div><div class="tr-h">MEASUREMENTS</div><div id="trmeas"></div></div></div></aside></div>' +
      '<div class="tr-status" id="trstatus"></div>' +
      '<div class="tr-modal" id="trmodal" hidden role="dialog" aria-label="Parts library"><div class="tr-modalbox">' +
      '<div class="tr-modalhead"><b>Parts library</b><span class="st">every part here is saved to a file on your computer</span><span class="sp"></span><button class="tr-x" id="trmodalclose" aria-label="Close parts library">×</button></div>' +
      '<div class="tr-tabs"><button data-tab="online" aria-pressed="true">Find online</button><button data-tab="create" aria-pressed="false">Create part</button></div>' +
      '<div id="trtab-online"><div class="tr-srch"><input id="trsq" placeholder="package or part, e.g. soic-8, usb c receptacle, esp32" aria-label="Search footprints online" spellcheck="false" autocomplete="off"><button class="tr-btn gold" id="trsgo">Search</button></div>' +
      '<div class="tr-note">Searches the open KiCad footprint library on GitHub. Ask Claude too — it can look up datasheet dimensions and build the part for you.</div><div id="trsr" class="tr-results"></div></div>' +
      '<div id="trtab-create" hidden><div class="tr-form">' +
      '<div><label for="trpl">NAME</label><input id="trpl" placeholder="e.g. SOIC-8 flash chip"></div><div><label for="trpp">REF PREFIX</label><input id="trpp" value="U" maxlength="3"></div>' +
      '<div><label for="trpt">TEMPLATE</label><select id="trpt"><option value="two_pad">2-pad (R/C/LED)</option><option value="dual" selected>Dual row (SOIC/TSSOP)</option><option value="quad">Quad (QFP/QFN)</option><option value="header">Pin header</option><option value="custom">Custom pads…</option></select></div>' +
      '<div><label for="trpins">PINS</label><input id="trpins" type="number" min="1" value="8"></div>' +
      '<div><label for="trpitch">PITCH mm</label><input id="trpitch" type="number" step="0.01" placeholder="auto"></div><div><label for="trpspan">ROW SPAN mm</label><input id="trpspan" type="number" step="0.1" placeholder="auto"></div>' +
      '<div><label for="trpbody">BODY WxH mm</label><input id="trpbody" placeholder="auto e.g. 5x4"></div>' +
      '<div class="wide"><label for="trpdesc">DESCRIPTION — what does this part do?</label><input id="trpdesc" placeholder="e.g. 128 Mbit flash chip that stores the firmware"></div>' +
      '<div class="wide" id="trpadswrap" hidden><label for="trppads">PADS name:x:y:w:h[:circle][:thru] separated by /</label><input id="trppads" placeholder="1:-1.5:0:1:1.2/2:1.5:0:1:1.2"></div>' +
      '</div><div class="tr-formfoot"><button class="tr-btn gold" id="trpcreate">Create &amp; save part</button><span class="tr-note" id="trpmsg"></span></div></div>' +
      '</div></div>';
    for (const id of ["trsvg", "trstage", "trbadge", "trhint", "trlog", "trin", "trdot", "trst", "trlayers", "trparts", "trnets",
      "trinsp", "trboard", "trdrc", "trmeas", "trstatus", "trchips", "trwidth", "trnet", "trgrid", "trai", "trmodal", "trsq", "trsr", "trpmsg", "trtip", "trsafe", "trgraph", "trcode", "trsteps", "trreview"]) el[id] = document.getElementById(id);
    // list panels only touch the DOM when their content changed: a re-render between mouse-down and mouse-up (blurring a search box fires "change") would swallow the click
    const innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    for (const id of ["trlayers", "trparts", "trnets", "trdrc", "trmeas"]) Object.defineProperty(el[id], "innerHTML", { configurable: true, get() { return innerDesc.get.call(this); }, set(v) { if (this._h !== v) { innerDesc.set.call(this, v); this._h = v; } } });
    el.dock = root.querySelector(".tr-dock");
    window.TraceGraph.init({ board, root: document.getElementById("trgraph"), getSafe: () => S.safe, getDrc: () => S.drc, put, ask: (t) => { el.trin.value = t; dockSend(); } });
    el.root = root;
    window.TraceChat.init({ root: el.root, log: el.trlog, board, stepsEl: el.trsteps, send: sendText, focus: () => el.trin.focus(), onMode: updateMode,
      onDiagram: () => window.TraceChat.renderSteps({ drc: S.drc, safe: S.safe }) });
    updateMode(window.TraceChat.mode);
    window.TraceCart.init({ button: document.getElementById("trcart"), modal: document.getElementById("trcartmodal"), board, toast: (m) => { window.TraceGraph.toast(m); put("m", m); },
      find: (ref) => { setTab("graph"); window.TraceFinderUI.findFor(ref); }, pickAll: () => { setTab("graph"); window.TraceFinderUI.pickAll(); } });
    window.TracePanel.init({ board, root: el.root.querySelector(".tr-left"), tab: () => S.tab, getSafe: () => S.safe, getDrc: () => S.drc, getSel: () => S.sel, getHlNet: () => S.hlNet,
      selectPart: (ref) => { S.sel = { kind: "part", id: ref }; if (S.tab === "graph") window.TraceGraph.focusPart(ref); else { const p = board.findPart(ref); if (p) mark(p.x, p.y, ref, COL.claude); } renderInspector(); renderPanels(); render(); },
      hlNet: (name) => { S.hlNet = S.hlNet === name ? null : name; render(); window.TraceGraph.render(); },
      addReal: (p) => window.TraceFinderUI.add(p), filterLibrary: () => renderPanels() });
    window.TraceRules.init({ board, root: document.getElementById("trlp-rules"), toast: (m) => put("m", m), selectCut: (id) => { S.sel = { kind: "cut", id }; setTab("board"); renderPanels(); render(); } });
    el.trchips.innerHTML = ["Design a USB-powered 3.3 V sensor board", "Add a status LED with the right resistor", "Review my circuit for mistakes", "Draw the architecture"]
      .map((t) => `<button class="tr-chip">${t}</button>`).join("");
    wire();
    S.built = true;
    window.TraceCode.init({ board, root: document.getElementById("trcode"), ask: sendText });
    let t0 = "graph"; try { t0 = localStorage.getItem("trace-tab-v1") || "graph"; } catch (_) { /* private mode */ }
    setTab(t0 === "board" || t0 === "code" ? t0 : "graph"); // Schematic is the first tab and the default
  }

  // ---------- geometry helpers ----------
  const PX = () => S.view.w / Math.max(1, el.trsvg.clientWidth);
  function toWorld(e) {
    const r = el.trsvg.getBoundingClientRect(), k = S.view.w / r.width;
    return { x: S.view.x + (e.clientX - r.left) * k, y: S.view.y + (e.clientY - r.top) * k };
  }
  function fit() {
    const r = el.trsvg.getBoundingClientRect(), asp = r.height / Math.max(1, r.width), { w, h } = board.s.board;
    if (r.width < 20 || r.height < 20) { S.needFit = true; return; } // the PCB tab is not on screen yet — fit when it is
    const vw = Math.max(w + 16, (h + 18) / asp);
    S.view = { w: vw, h: vw * asp, x: w / 2 - vw / 2, y: h / 2 - (vw * asp) / 2 };
  }
  function syncAspect() {
    const r = el.trsvg.getBoundingClientRect();
    if (r.width) S.view.h = S.view.w * (r.height / r.width);
  }
  function bounds(p) {
    const [bw, bh] = defOf(p.type).body, swap = p.rot % 180 !== 0;
    let w = swap ? bh : bw, h = swap ? bw : bh;
    for (const q of board.pads(p)) { w = Math.max(w, 2 * Math.abs(q.x - p.x) + q.w); h = Math.max(h, 2 * Math.abs(q.y - p.y) + q.h); }
    return { w, h };
  }
  function nearestPad(pt, tol) {
    let best = null, bd = Infinity;
    for (const q of board.allPads()) {
      const d = Math.hypot(pt.x - q.x, pt.y - q.y), lim = Math.max(q.w, q.h) / 2 + tol;
      if (d <= lim && d < bd) { bd = d; best = q; }
    }
    return best;
  }
  // snap candidate for route/measure: pad center → via → part center → board corner → grid
  function snapPoint(pt, wantParts) {
    const tol = 8 * PX();
    const pd = nearestPad(pt, tol);
    if (pd) return { x: pd.x, y: pd.y, pad: pd };
    for (const v of board.s.vias) if (Math.hypot(pt.x - v.x, pt.y - v.y) < Math.max(v.d, tol)) return { x: v.x, y: v.y };
    if (wantParts) {
      for (const p of board.s.parts) if (Math.hypot(pt.x - p.x, pt.y - p.y) < tol * 1.5) return { x: p.x, y: p.y };
      for (const c of [[0, 0], [board.s.board.w, 0], [0, board.s.board.h], [board.s.board.w, board.s.board.h]])
        if (Math.hypot(pt.x - c[0], pt.y - c[1]) < tol * 1.5) return { x: c[0], y: c[1] };
    }
    return { x: snap(pt.x), y: snap(pt.y) };
  }
  const coord = (p) => (p.pad ? p.pad.ref : rnd3(p.x) + ":" + rnd3(p.y));

  // ---------- rendering ----------
  function partSvg(p, ghost) {
    const d = defOf(p.type), [bw, bh] = d.body;
    let g = `<g ${ghost ? 'opacity=".6" pointer-events="none"' : `data-ref="${p.ref}"`} transform="translate(${p.x} ${p.y}) rotate(${p.rot})">`;
    if (bw && S.vis.silk) g += `<rect x="${-bw / 2}" y="${-bh / 2}" width="${bw}" height="${bh}" rx=".3" fill="#111815" fill-opacity=".55" stroke="${COL.silk}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
    for (const q of d.pads) {
      g += q.shape === "circle"
        ? (p.type === "hole"
          ? `<circle cx="${q.x}" cy="${q.y}" r="${q.w / 2 + 0.5}" fill="none" stroke="${COL.gold}" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="${q.x}" cy="${q.y}" r="${q.w / 2}" fill="#0b100e"/>`
          : `<circle cx="${q.x}" cy="${q.y}" r="${q.w / 2}" fill="${COL.gold}"/><circle cx="${q.x}" cy="${q.y}" r="${q.w / 5}" fill="#0b100e"/>`)
        : `<rect x="${q.x - q.w / 2}" y="${q.y - q.h / 2}" width="${q.w}" height="${q.h}" fill="${COL.gold}"/>`;
    }
    if (p.type === "mcu") g += `<circle cx="-3" cy="-3" r=".45" fill="${COL.silk}"/>`;
    return g + "</g>";
  }
  function traceD(t) { return "M" + t.pts.map((q) => q[0] + " " + q[1]).join("L"); }
  function elbowPts(a, b) { return [a, ...TraceEngine.elbow(a, b), b]; }

  function pill(x, y, text, col, px, bg) {
    const w = text.length * px * 6.8 + px * 12, h = px * 18;
    return `<g class="tr-claude"><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg || "#0b100e"}" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      `<text x="${x}" y="${y + px * 4}" fill="${col}" font-size="${px * 11}" text-anchor="middle" font-family="IBM Plex Mono,Consolas,monospace">${esc(text)}</text></g>`;
  }
  function dim(a, b, label, col, off, px) {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, ux = dx / L, uy = dy / L;
    const A = { x: a.x + nx * off, y: a.y + ny * off }, B = { x: b.x + nx * off, y: b.y + ny * off }, t = px * 6;
    // vector-effect is not inherited, so every path carries it (1px lines at any zoom)
    const VE = 'vector-effect="non-scaling-stroke"';
    const tick = (P) => `<path ${VE} d="M${P.x - ux * t - nx * t} ${P.y - uy * t - ny * t}L${P.x + ux * t + nx * t} ${P.y + uy * t + ny * t}" />`;
    return `<g stroke="${col}" stroke-width="1" fill="none" class="tr-dim">` +
      (off ? `<path ${VE} d="M${a.x} ${a.y}L${A.x + nx * Math.sign(off) * px * 4} ${A.y + ny * Math.sign(off) * px * 4}M${b.x} ${b.y}L${B.x + nx * Math.sign(off) * px * 4} ${B.y + ny * Math.sign(off) * px * 4}" stroke-dasharray="3 3" opacity=".6"/>` : "") +
      `<path ${VE} d="M${A.x} ${A.y}L${B.x} ${B.y}"/>${tick(A)}${tick(B)}</g>` +
      pill((A.x + B.x) / 2, (A.y + B.y) / 2, label, col, px);
  }

  let rafPending = false;
  /** every DRC error + electrical issue, grouped per part (outline + badge) or per spot (badge only) */
  function problemMarks(px) {
    const groups = new Map(); // key → {x,y,box,level,msgs}
    const add = (key, x, y, level, msg, ref) => {
      if (!groups.has(key)) groups.set(key, { x, y, level, msgs: [], ref });
      const g = groups.get(key); g.msgs.push(msg);
      if (level === "danger") g.level = "danger";
    };
    for (const v of S.drc.errors) {
      if (v.refs) for (const r of v.refs) { const p = board.findPart(r); if (p) add("p:" + r, p.x, p.y, "danger", v.msg, r); }
      else add("d:" + Math.round(v.x * 4) + "," + Math.round(v.y * 4), v.x, v.y, "danger", v.msg, "");
    }
    if (S.vis.safe) for (const it of S.safe.issues) {
      if (it.level === "info") continue;
      const refs = (it.refs || []).filter((r) => board.findPart(r));
      if (refs.length) for (const r of refs) { const p = board.findPart(r); add("p:" + r, p.x, p.y, it.level, it.msg, r); }
      else if (it.x != null) add("s:" + Math.round(it.x * 4) + "," + Math.round(it.y * 4), it.x, it.y, it.level, it.msg, "");
    }
    for (const f of S.review || []) {
      if (f.level === "info" || f.code === "drc" || f.code === "power_pin_open" && false) continue;
      const refs = (f.refs || []).filter((r) => board.findPart(r));
      if (refs.length) for (const r of refs.slice(0, 1)) { const p = board.findPart(r); add("p:" + r, p.x, p.y, f.level, f.msg, r); }
      else if (f.x != null && f.y != null) add("s:" + Math.round(f.x * 4) + "," + Math.round(f.y * 4), f.x, f.y, f.level, f.msg, "");
    }
    let o = "";
    for (const [key, g] of groups) {
      const col = g.level === "danger" ? COL.bad : "#ffb347", n = g.msgs.length, title = esc(g.msgs.join("\n"));
      let bx = g.x, by = g.y;
      if (g.ref) {
        const p = board.findPart(g.ref), c = board.courtyard ? board.courtyard(p) : null;
        if (c) {
          o += `<rect data-drc="1" data-mark="${esc(g.ref)}" x="${c.x0}" y="${c.y0}" width="${c.x1 - c.x0}" height="${c.y1 - c.y0}" rx="${px * 3}" fill="${col}" fill-opacity=".07" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
          bx = c.x1; by = c.y0;
        }
      }
      o += `<g data-safe="${g.level}" data-drc="1" data-badge="${esc(g.ref || key)}" style="cursor:pointer"><title>${title}</title><circle cx="${bx}" cy="${by}" r="${px * 7}" fill="${col}" stroke="#0b100e" stroke-width="1.5" vector-effect="non-scaling-stroke"/><text x="${bx}" y="${by + px * 3.6}" text-anchor="middle" font-size="${px * 10}" font-weight="700" fill="#150909" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${n > 1 ? n : "!"}</text></g>`;
    }
    return o;
  }
  // links drawn in the Graph that no trace joins yet → dashed "airwires" on the board
  function ratsnest() {
    const open = new Set(S.safe.unrouted_links || []), out = []; // the analyser knows which wires still have no copper
    for (const l of board.s.links || []) {
      if (!open.has(l.id)) continue;
      try { const A = board.resolve(l.a), B = board.resolve(l.b); out.push({ id: l.id, net: l.net, x1: A.x, y1: A.y, x2: B.x, y2: B.y }); } catch (_) { /* part removed */ }
    }
    return out;
  }
  function render() {
    if (!S.open) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; draw(); });
  }
  function draw() {
    if (!S.open) return;
    const px = PX(), { w, h } = board.s.board, V = S.view, now = performance.now();
    el.trsvg.setAttribute("viewBox", `${V.x} ${V.y} ${V.w} ${V.h}`);
    let o = `<defs><pattern id="trg" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#1b2521" stroke-width="1" vector-effect="non-scaling-stroke"/></pattern>` +
      `<pattern id="trg5" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5 0H0V5" fill="none" stroke="#25322c" stroke-width="1" vector-effect="non-scaling-stroke"/></pattern></defs>`;
    o += `<rect x="${V.x}" y="${V.y}" width="${V.w}" height="${V.h}" fill="#0b100e"/>`;
    if (1 / px > 3) o += `<rect x="${V.x}" y="${V.y}" width="${V.w}" height="${V.h}" fill="url(#trg)"/>`;
    o += `<rect x="${V.x}" y="${V.y}" width="${V.w}" height="${V.h}" fill="url(#trg5)"/>`;
    o += `<rect x="0" y="0" width="${w}" height="${h}" rx="${Math.max(1, (board.s.outline && board.s.outline.radius) || 0)}" fill="${S.vis.mask ? COL.mask : COL.bare}" stroke="${COL.gold}" stroke-width="2" vector-effect="non-scaling-stroke" data-board="1"/>`;
    for (const c of board.s.cutouts || []) {
      const on = S.sel && S.sel.kind === "cut" && S.sel.id === c.id, st = `fill="#0b100e" stroke="${on ? "#fff" : COL.gold}" stroke-width="${on ? 2 : 1.4}" ${on ? "" : 'stroke-dasharray="4 3" '}vector-effect="non-scaling-stroke" style="cursor:move"`;
      o += `<g data-cut="${c.id}"><title>Cutout ${c.id} — drag to move</title>` + (c.shape === "circle" ? `<circle cx="${c.x}" cy="${c.y}" r="${c.d / 2}" ${st}/>` : `<rect x="${c.x - c.w / 2}" y="${c.y - c.h / 2}" width="${c.w}" height="${c.h}" rx="${c.shape === "slot" ? Math.min(c.w, c.h) / 2 : 0.3}" ${st}/>`) + "</g>";
    }
    for (const z of board.s.zones || []) {
      if (!(z.layer === "B.Cu" ? S.vis.bcu : S.vis.fcu)) continue;
      const col = z.layer === "B.Cu" ? COL.bcu : COL.fcu, cl = z.clearance, rad = Math.max(1, (board.s.outline && board.s.outline.radius) || 0);
      o += `<g data-pour="${z.id}" pointer-events="none"><title>${esc(z.net)} copper pour on ${z.layer} — every ${esc(z.net)} pin connects to it</title><rect x="0.3" y="0.3" width="${w - 0.6}" height="${h - 0.6}" rx="${rad}" fill="${col}" fill-opacity=".2" stroke="${col}" stroke-opacity=".5" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="2 3"/>`;
      const halo = S.vis.mask ? COL.mask : COL.bare;
      for (const t of board.s.traces) if (t.layer === z.layer && t.net !== z.net) o += `<path d="${traceD(t)}" fill="none" stroke="${halo}" stroke-width="${t.width + 2 * cl}" stroke-linecap="round" stroke-linejoin="round"/>`;
      for (const v of board.s.vias) if (v.net !== z.net) o += `<circle cx="${v.x}" cy="${v.y}" r="${v.d / 2 + cl}" fill="${halo}"/>`;
      for (const p of board.s.parts) for (const q of board.pads(p)) if (q.net !== z.net && (q.thru || z.layer === "F.Cu")) o += q.shape === "circle" ? `<circle cx="${q.x}" cy="${q.y}" r="${q.w / 2 + cl}" fill="${halo}"/>` : `<rect x="${q.x - q.w / 2 - cl}" y="${q.y - q.h / 2 - cl}" width="${q.w + 2 * cl}" height="${q.h + 2 * cl}" fill="${halo}"/>`;
      for (const c of board.s.cutouts || []) o += c.shape === "circle" ? `<circle cx="${c.x}" cy="${c.y}" r="${c.d / 2 + 0.5}" fill="${halo}"/>` : `<rect x="${c.x - c.w / 2 - 0.5}" y="${c.y - c.h / 2 - 0.5}" width="${c.w + 1}" height="${c.h + 1}" fill="${halo}"/>`;
      o += "</g>";
    }
    // ratsnest (airwires) under the copper: clicking copper must never hit an airwire first
    for (const l of ratsnest()) o += `<line data-rat="${l.id}" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="transparent" stroke-width="${px * 9}" style="cursor:pointer"/><line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" data-ratvis="${S.sel && S.sel.kind === "rat" && S.sel.id === l.id ? 1 : 0}" stroke="${COL.gold}" stroke-width="1.4" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" opacity=".85" pointer-events="none"><title>${esc(l.net)}: wired in the Graph, not routed yet</title></line>`;
    const fa = S.layer === "F.Cu" ? 1 : 0.5, ba = S.layer === "B.Cu" ? 1 : 0.5;
    const trLayer = (layer, vis, color, alpha) => {
      if (!vis) return "";
      let s = "";
      for (const t of board.s.traces) if (t.layer === layer) {
        const sf = S.vis.safe && S.safe.traces[t.id];
        if (sf && sf.status !== "ok") s += `<path data-safe-trace="${sf.status}" d="${traceD(t)}" fill="none" stroke="${sf.status === "danger" ? COL.bad : "#ffb347"}" stroke-opacity=".6" stroke-width="${t.width + 0.55}" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
        const hl = S.hlNet && t.net === S.hlNet;
        if (hl) s += `<path d="${traceD(t)}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="${t.width + 0.7}" stroke-linejoin="round" stroke-linecap="round"/>`;
        s += `<path d="${traceD(t)}" fill="none" stroke="${color}" stroke-opacity="${alpha}" stroke-width="${t.width}" stroke-linejoin="round" stroke-linecap="round"/>`;
        if (S.tool === "select") s += `<path data-trace="${t.id}" d="${traceD(t)}" fill="none" stroke="transparent" stroke-width="${Math.max(t.width, 12 * px)}" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
      return s;
    };
    o += `<g class="tr-bcu">${trLayer("B.Cu", S.vis.bcu, COL.bcu, ba)}</g>`;
    o += `<g class="tr-fcu">${trLayer("F.Cu", S.vis.fcu, COL.fcu, fa)}</g>`;
    for (const v of board.s.vias)
      o += `<g data-via="${v.id}"><circle cx="${v.x}" cy="${v.y}" r="${v.d / 2}" fill="${COL.gold}"/><circle cx="${v.x}" cy="${v.y}" r="${v.drill / 2}" fill="#0b100e"/></g>`;
    for (const p of board.s.parts) o += partSvg(p);
    if (S.vis.silk) for (const p of board.s.parts) {
      const b = bounds(p);
      o += `<text x="${p.x}" y="${p.y + b.h / 2 + 1.5}" fill="${COL.silk}" font-size="1.15" text-anchor="middle" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${esc(p.ref)}</text>`;
    }
    // selection
    const sel = S.sel;
    if (sel && sel.kind === "part") {
      const p = board.findPart(sel.id);
      if (p) { const b = bounds(p); o += `<rect class="tr-sel" x="${p.x - b.w / 2 - 0.5}" y="${p.y - b.h / 2 - 0.5}" width="${b.w + 1}" height="${b.h + 1}" fill="none" stroke="#fff" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" pointer-events="none"/>`; }
    } else if (sel && sel.kind === "trace") {
      const t = board.s.traces.find((q) => q.id === sel.id);
      if (t) o += `<path class="tr-sel" d="${traceD(t)}" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="${Math.max(0.15, t.width * 0.3)}" stroke-dasharray="${px * 5} ${px * 4}" pointer-events="none"/>`;
    } else if (sel && sel.kind === "via") {
      const v = board.s.vias.find((q) => q.id === sel.id);
      if (v) o += `<circle class="tr-sel" cx="${v.x}" cy="${v.y}" r="${v.d / 2 + 0.3}" fill="none" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    }
    // problem markers: a dashed outline around the part that has the problem + a small numbered badge (no big circles hiding the board)
    o += problemMarks(px);
    // dimensions
    if (S.vis.dims) {
      o += dim({ x: 0, y: 0 }, { x: w, y: 0 }, fmt(w) + " mm", COL.meas, -px * 26, px);
      o += dim({ x: w, y: 0 }, { x: w, y: h }, fmt(h) + " mm", COL.meas, -px * 26, px);
    }
    for (const m of board.s.measures) {
      const on = S.sel && S.sel.kind === "meas" && S.sel.id === m.id;
      o += `<g data-meas="${m.id}"${on ? ' data-selected="1"' : ""}><line x1="${m.a.x}" y1="${m.a.y}" x2="${m.b.x}" y2="${m.b.y}" stroke="transparent" stroke-width="${px * 12}" style="cursor:pointer"/>` + (on ? `<line x1="${m.a.x}" y1="${m.a.y}" x2="${m.b.x}" y2="${m.b.y}" stroke="#fff" stroke-opacity=".5" stroke-width="${px * 5}" pointer-events="none"/>` : "") +
      dim(m.a, m.b, fmt(Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y)) + " mm", COL.meas, 0, px) +
        `<circle cx="${m.a.x}" cy="${m.a.y}" r="${px * 3}" fill="${COL.meas}"/><circle cx="${m.b.x}" cy="${m.b.y}" r="${px * 3}" fill="${COL.meas}"/></g>`;
    }
    // in-progress interactions
    const cur = S.cursor;
    if (S.tool === "place" && cur) o += partSvg({ type: S.partType, x: snap(cur.x), y: snap(cur.y), rot: S.rot, ref: "" }, true);
    if (S.route && cur) {
      const st = S.route, end = snapPoint(cur, false);
      const chain = [st.origin, ...st.pts.map((q) => q)];
      let path = [chain[0]];
      for (let i = 1; i < chain.length; i++) path.push(...elbowPts(chain[i - 1], chain[i]).slice(1));
      path.push(...elbowPts(chain[chain.length - 1], end).slice(1));
      o += `<path d="M${path.map((q) => q.x + " " + q.y).join("L")}" fill="none" stroke="${S.layer === "F.Cu" ? COL.fcu : COL.bcu}" stroke-opacity=".75" stroke-width="${S.width || 0.25}" stroke-dasharray="${px * 6} ${px * 4}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
      o += `<circle cx="${end.x}" cy="${end.y}" r="${px * 5}" fill="none" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
    }
    if (S.meas && cur) {
      const end = snapPoint(cur, true);
      o += dim(S.meas.a, end, fmt(Math.hypot(end.x - S.meas.a.x, end.y - S.meas.a.y)) + " mm", "#fff", 0, px);
    }
    if (S.tool === "measure" && cur && !S.meas) { const e = snapPoint(cur, true); o += `<circle cx="${e.x}" cy="${e.y}" r="${px * 5}" fill="none" stroke="${COL.meas}" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>`; }
    // claude presence / focus marks
    if (S.mark) {
      const age = now - S.mark.t, a = Math.max(0, 1 - age / 2600);
      if (a > 0) {
        o += `<g class="tr-claude" opacity="${a.toFixed(2)}"><circle cx="${S.mark.x}" cy="${S.mark.y}" r="${px * (14 + (age / 2600) * 10)}" fill="none" stroke="${S.mark.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
          `<path d="M${S.mark.x} ${S.mark.y}l${px * 11} ${px * 4}l${-px * 4.5} ${px * 1.5}l${-px * 1.5} ${px * 4.5}z" fill="${S.mark.color}"/></g>` +
          pill(S.mark.x + px * 44, S.mark.y + px * 22, S.mark.label, S.mark.color, px).replace('class="tr-claude"', `class="tr-claude" opacity="${a.toFixed(2)}"`);
        setTimeout(render, 120);
      } else S.mark = null;
    }
    el.trsvg.innerHTML = o;
    el.trbadge.textContent = S.layer + " · " + Math.round((1 / px) * 10) / 10 + " px/mm";
  }

  // ---------- electrical safety: formatting, panel, inspector blocks, report ----------
  const fmtA = (a) => (Math.abs(a) >= 1 ? a.toFixed(2) + " A" : (a * 1000).toFixed(Math.abs(a) * 1000 >= 10 ? 0 : 1) + " mA");
  const fmtV = (v) => (Math.round(v * 100) / 100) + " V";
  const fmtW = (w) => (w >= 1 ? w.toFixed(2) + " W" : (w * 1000).toFixed(w * 1000 >= 10 ? 0 : 1) + " mW");
  const GLYPH = { danger: "●", warning: "▲", info: "i" };
  const ELEC_FIELDS = { resistor: ["pmax"], capacitor: ["vmax"], led: ["vf", "imax"], diode: ["vf", "imax"], inductor: ["imax", "dcr"],
    regulator: ["vout", "dropout", "vin_max", "imax", "iq", "pmax"], source: ["vout", "imax"], load: ["iload"],
    ic: ["vdd_min", "vdd_max", "iq", "pin_imax"], connector: ["pin_imax"], passive: [], none: [] };
  const ELEC_UNIT = { pmax: "W", vmax: "V", vf: "V", imax: "A", dcr: "Ω", vout: "V", dropout: "V", vin_max: "V", iq: "A", iload: "A", vdd_min: "V", vdd_max: "V", pin_imax: "A" };
  function runSafety() {
    try { S.safe = board.exec("analyze"); }
    catch (e) { put("e", "✕ safety check failed: " + e.message); }
  }
  function renderReview() {
    const R = S.review || [], bad = R.filter((f) => f.level !== "info"), cnt = document.getElementById("trissuecount");
    if (cnt) { cnt.hidden = !bad.length; cnt.textContent = String(bad.length); cnt.style.background = R.some((f) => f.level === "danger") ? "#ff5a5a" : "#ffb347"; }
    const lastRoute = S.lastRoute ? `<div class="tr-rvroute ${S.lastRoute.failed.length ? "warn" : "ok"}"><b>Last auto-route</b> · ${S.lastRoute.routed} connection${S.lastRoute.routed === 1 ? "" : "s"} routed · ${S.lastRoute.vias} vias · ${S.lastRoute.seconds}s${S.lastRoute.failed.length ? `<div class="fl">${S.lastRoute.failed.map((x) => "✕ " + esc(x.reason)).join("<br>")}</div>` : ""}</div>` : "";
    const head = !R.length ? '<div class="tr-rvok">✓ Nothing an engineer would flag.</div>' : `<div class="tr-rvhd ${R.some((f) => f.level === "danger") ? "danger" : bad.length ? "warning" : "ok"}"><b>${R.some((f) => f.level === "danger") ? "Not ready" : bad.length ? "Almost there" : "Looks ready"}</b><span>${R.filter((f) => f.level === "danger").length} danger · ${R.filter((f) => f.level === "warning").length} warnings · ${R.filter((f) => f.level === "info").length} notes</span></div>`;
    const cats = { power: "Power pins", decoupling: "Decoupling", supply: "Supply", interface: "Interfaces", layout: "Layout", soldering: "Soldering", connectivity: "Connectivity", routing: "Routing" };
    let h = lastRoute + head;
    for (const [cat, label] of Object.entries(cats)) {
      const list = R.filter((f) => f.cat === cat);
      if (!list.length) continue;
      h += `<div class="tr-rvcat">${label}</div>` + list.map((f) => `<button class="tr-rv ${f.level}" data-rv="${f.id}"><span class="ic">${f.level === "danger" ? "●" : f.level === "warning" ? "▲" : "i"}</span><span><span class="m">${esc(f.msg)}</span>${f.fix ? `<span class="f">${esc(f.fix)}</span>` : ""}</span></button>`).join("");
    }
    el.trreview.innerHTML = h;
  }
  function focusReview(id) {
    const f = (S.review || []).find((x) => x.id === id);
    if (!f) return;
    if (f.net) S.hlNet = f.net;
    const ref = (f.refs || [])[0];
    if (ref && board.findPart(ref)) S.sel = { kind: "part", id: ref };
    if (f.x != null && S.tab === "board") mark(f.x, f.y, f.code, f.level === "danger" ? COL.bad : "#ffb347");
    if (S.tab === "graph" && ref) window.TraceGraph.focusPart(ref);
    renderPanels(); render();
  }
  function renderSafety() {
    const A = S.safe, lv = A.level;
    const label = { safe: "Looks safe", warning: "Caution", danger: "DANGER", unknown: "Add a power source to check" }[lv] || lv;
    let h = `<div class="tr-safe ${lv}" data-level="${lv}"><div class="hd"><span class="dot"></span><b>${label}</b></div><div class="sm">${esc(A.summary)}</div></div>`;
    h += A.issues.map((i) => `<button class="tr-issue ${i.level}" data-issue="${i.id}"><span class="ic">${GLYPH[i.level]}</span><span><span class="m">${esc(i.msg)}</span>${i.fix ? `<span class="f">Fix: ${esc(i.fix)}</span>` : ""}</span></button>`).join("");
    const rails = A.rails.filter((r) => r.volts > 0.05 && r.net).sort((a, b) => b.volts - a.volts).slice(0, 8);
    if (rails.length) h += '<div class="tr-h" style="margin:10px 0 4px">POWER RAILS</div>' + rails.map((r) => `<div class="tr-line"><span>${esc(r.net)}</span><span>${fmtV(r.volts)} · ${fmtA(r.amps)}</span></div>`).join("");
    h += '<button class="tr-btn" id="trreport" style="margin-top:8px">Download safety report</button>' +
      '<div class="tr-note" style="margin-top:6px">Rule-of-thumb DC screening (not a simulation). Always check datasheets before building.</div>';
    el.trsafe.innerHTML = h;
  }
  function gauge(frac) {
    const lvl = frac >= 1 ? "danger" : frac >= 0.7 ? "warning" : "ok";
    return `<div class="tr-gauge ${lvl}" data-load="${lvl}"><i style="width:${Math.min(100, Math.round(frac * 100))}%"></i></div><div class="tr-gaugel">${Math.round(frac * 100)}% of its limit</div>`;
  }
  function nowBlock(p) {
    const st = S.safe.parts[p.ref];
    if (!st) return "";
    const vLabel = { resistor: "Voltage across", led: "Voltage across", diode: "Voltage across", capacitor: "Voltage across", regulator: "Output", source: "Output", ic: "Supply", load: "Supply" }[st.kind] || "Voltage";
    let h = '<div class="tr-desc" data-now="1"><div class="k">RIGHT NOW</div>';
    if (st.i !== undefined && st.kind !== "capacitor") h += `<div class="tr-line"><span>Current</span><span>${fmtA(st.i)}</span></div>`;
    if (st.v !== undefined) h += `<div class="tr-line"><span>${vLabel}</span><span>${fmtV(st.v)}</span></div>`;
    if (st.vin !== undefined) h += `<div class="tr-line"><span>Input</span><span>${fmtV(st.vin)}</span></div>`;
    if (st.p !== undefined && st.p > 0) h += `<div class="tr-line"><span>Heat / power</span><span>${fmtW(st.p)}</span></div>`;
    if (st.load) h += gauge(st.load);
    return h + "</div>";
  }
  function elecBlock(p) {
    const e = window.TraceEngine.elecOf(p), fields = ELEC_FIELDS[e.kind] || [];
    const kinds = window.TraceEngine.ELEC_KINDS;
    return `<details class="tr-elec" ${S.elecOpen ? "open" : ""}><summary>Electrical limits (${esc(e.kind)})</summary><div class="tr-kv">` +
      `<div class="wide"><label for="inselk">TYPE — how the safety check treats it</label><select id="inselk" data-elec="kind">${kinds.map((k) => `<option ${k === e.kind ? "selected" : ""}>${k}</option>`).join("")}</select></div>` +
      fields.map((k) => `<div><label for="inse_${k}">${k.toUpperCase()} (${ELEC_UNIT[k]})</label><input id="inse_${k}" data-elec="${k}" type="number" step="any" min="0" value="${e[k] !== undefined ? e[k] : ""}" placeholder="not set"></div>`).join("") +
      "</div></details>";
  }
  function pinsBlock(p) {
    const roles = window.TraceEngine.ROLES;
    return '<div class="tr-h" style="margin:10px 0 4px">PINS</div><div style="max-height:190px;overflow:auto">' + board.pads(p).map((q) => {
      const st = S.safe.pads[q.ref], live = st && st.net ? `${fmtV(st.v)}${Math.abs(st.i) > 1e-6 ? " · " + fmtA(st.i) : ""}` : "";
      return `<div class="tr-pad"><div class="tr-line"><span>${esc(q.n)}${q.fn !== q.n ? " · " + esc(q.fn) : ""}</span><span>${esc(q.net || "—")}</span></div>` +
        `<div class="tr-padm"><select data-role="${esc(q.n)}" aria-label="Role of pin ${esc(q.n)}">${roles.map((r) => `<option ${r === (q.role || "passive") ? "selected" : ""}>${r}</option>`).join("")}</select><span>${live}</span></div>` +
        (q.desc ? `<div class="tr-padd">${esc(q.desc)}</div>` : "") + "</div>";
    }).join("") + "</div>";
  }
  function reportText() {
    const A = S.safe, L = [], bd = board.s.board;
    L.push("TRACE electrical safety report", "================================", "Board: " + bd.w + " x " + bd.h + " mm · " + board.s.parts.length + " parts · " + board.s.traces.length + " traces", "", "VERDICT: " + A.level.toUpperCase(), A.summary, "");
    if (A.issues.length) { L.push("ISSUES"); for (const i of A.issues) { L.push(" [" + i.level.toUpperCase() + "] " + i.msg); if (i.fix) L.push("     fix: " + i.fix); } L.push(""); }
    L.push("POWER RAILS"); for (const r of A.rails.filter((r) => r.volts > 0.05 && r.net)) L.push(" " + r.net.padEnd(12) + fmtV(r.volts).padEnd(9) + fmtA(r.amps));
    L.push("", "PARTS (operating point)");
    for (const [ref, st] of Object.entries(A.parts)) L.push(" " + ref.padEnd(6) + (st.i !== undefined ? fmtA(st.i).padEnd(10) : "".padEnd(10)) + (st.v !== undefined ? fmtV(st.v).padEnd(9) : "".padEnd(9)) + (st.load ? Math.round(st.load * 100) + "% of limit" : ""));
    L.push("", "TRACES carrying current");
    for (const [id, t] of Object.entries(A.traces)) if (t.i > 0.001) L.push(" " + id.padEnd(5) + t.net.padEnd(10) + (t.width + " mm").padEnd(9) + fmtA(t.i) + " (safe to " + fmtA(t.limit) + ")");
    L.push("", A.disclaimer || "", "Generated " + new Date().toISOString());
    return L.join("\n");
  }
  function downloadText(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- panels ----------
  function renderPanels() {
    // layers
    const LY = [["fcu", "F.Cu", COL.fcu, "F.Cu"], ["bcu", "B.Cu", COL.bcu, "B.Cu"], ["silk", "Silkscreen", COL.silk], ["mask", "Solder mask", "#2f8f5f"], ["dims", "Dimensions", COL.meas], ["safe", "Safety overlay", "#ffb347"]];
    el.trlayers.innerHTML = LY.map(([k, n, c, lay]) =>
      `<div class="tr-row ${lay && S.layer === lay ? "act" : ""}" ${lay ? `data-layer="${lay}" role="button" tabindex="0"` : ""}><span class="sw" style="background:${c}"></span><span>${n}</span>` +
      `<button class="eye tr-x" data-vis="${k}" aria-pressed="${S.vis[k]}" aria-label="Toggle ${n}">${S.vis[k] ? "show" : "hide"}</button></div>`).join("");
    el.trparts.innerHTML =
      '<div class="tr-partsbar"><button class="tr-btn" id="trnewpart">＋ New part</button><button class="tr-btn" id="trfindpart">Find online</button></div>' +
      window.TracePanel.localMatches().map(([k, d]) =>
        `<div class="tr-prow"><button class="tr-row ${S.tool === "place" && S.partType === k ? "act" : ""}" data-part="${k}" title="${esc(d.desc || d.source || d.label)}"><span>${esc(d.label)}</span><span class="mono">${d.custom ? "◆ " : ""}${esc(d.prefix)}</span></button>` +
        (d.custom ? `<button class="tr-x" data-delpart="${esc(k)}" aria-label="Delete part ${esc(d.label)}" title="Delete from library">×</button>` : "") + "</div>" +
        (S.tool === "place" && S.partType === k && d.desc ? `<div class="tr-netnote">${esc(d.desc)}</div>` : "")).join("");
    const nets = board.nets();
    el.trnets.innerHTML = nets.length ? nets.map((n) =>
      `<button class="tr-row ${S.hlNet === n.name ? "act" : ""}" data-net="${esc(n.name)}" title="${esc(n.note || n.name)}"><span style="font-family:var(--mono)">${esc(n.name)}</span><span class="mono">${(() => { const r = S.safe.rails.find((q) => q.net === n.name); return r ? fmtV(r.volts) + " · " : ""; })()}${n.pads.length} pads</span></button>` +
        (S.hlNet === n.name && n.note ? `<div class="tr-netnote">${esc(n.note)}</div>` : "")).join("")
      : '<div style="color:#7f8c86;font-size:12px;padding:4px 7px">no nets yet — route a trace</div>';
    // board
    el.trboard.innerHTML = `<div class="tr-kv"><div><label for="trbw">W mm</label><input id="trbw" type="number" step="1" value="${board.s.board.w}"></div><div><label for="trbh">H mm</label><input id="trbh" type="number" step="1" value="${board.s.board.h}"></div></div>` +
      `<div class="tr-line" style="margin-top:6px"><span>Layers</span><span>2 · 1.6 mm</span></div><div class="tr-line"><span>Rules</span><span>${RULES.minTrace}/${RULES.minGap}/${RULES.edge}</span></div>`;
    // measurements
    el.trmeas.innerHTML = board.s.measures.length
      ? board.s.measures.map((m) => `<div class="tr-line"><span style="color:${COL.meas}">${fmt(Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y))} mm</span><span>Δ${fmt(m.b.x - m.a.x)}, ${fmt(m.b.y - m.a.y)} <button class="tr-x" data-rmmeas="${m.id}" aria-label="Remove measurement">×</button></span></div>`).join("") +
        '<button class="tr-btn" id="trclrmeas" style="margin-top:6px">Clear all</button>'
      : '<div style="color:#7f8c86;font-size:12px">Use the Measure tool (M)</div>';
    renderInspector();
    renderReview();
    renderSafety();
    renderDrc();
    renderStatus();
    window.TracePanel.render();
  }
  /** "TRACE SPEC": the exact settings that produce this trace, and whether it meets them */
  function specBlock(get, net) {
    let sp; try { sp = get(); } catch (e) { return ""; }
    const row = (k, v, bad) => `<div class="tr-line${bad ? " bad" : ""}"><span>${k}</span><span>${v}</span></div>`;
    const tooThin = sp.ok_for_current === false;
    return `<div class="tr-spec" data-spec-net="${esc(net)}"><div class="tr-h">TRACE SPEC · what gives exactly this trace</div>` +
      row("Wire class", esc(sp.class)) + row("Width to use", `<b>${sp.recommended_width_mm} mm</b>${sp.width_now_mm !== undefined && sp.width_now_mm !== sp.recommended_width_mm && sp.id ? ` (now ${sp.width_now_mm})` : ""}`, sp.id && sp.width_now_mm + 1e-9 < sp.recommended_width_mm) +
      (sp.current_a > 0 ? row("Current", `${fmtA(sp.current_a)} → needs ≥ ${sp.min_width_for_current_mm} mm${sp.margin ? ` · ${sp.margin}× margin` : ""}`, tooThin) : row("Current", "not computed yet")) +
      row("Clearance", `≥ ${sp.clearance_mm} mm${sp.nearest_clearance_mm != null ? ` (nearest now ${sp.nearest_clearance_mm} mm)` : ""}`, sp.nearest_clearance_mm != null && sp.nearest_clearance_mm + 1e-6 < sp.clearance_mm) +
      row("Layer · copper", `${esc(sp.layer)} · 1 oz (35 µm)`) + row("Via", `⌀${sp.via_d_mm} mm, drill ${sp.via_drill_mm} mm`) +
      (sp.length_mm ? row("Resistance", `${sp.resistance_mohm} mΩ · drop ${sp.drop_mv} mV`) : "") +
      (sp.notes.length ? `<ul class="notes">${sp.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "") +
      `<div class="act"><button class="tr-btn" data-spec="apply" title="Create/adjust the wire class so every trace on this net gets these settings">Use this spec for the net</button><button class="tr-btn" data-spec="copy">Copy settings</button></div></div>`;
  }
  function specApply(net) {
    let sp; try { sp = board.exec("explain_net", { net }); } catch (e) { return; }
    const rec = sp.recommended_width_mm;
    if (sp.class === "Default" && rec > sp.class_width_mm + 1e-9) { const name = "Power " + rec + " mm"; run("rule_class", { name, width: rec, clearance: Math.max(sp.clearance_mm, 0.2) }); run("rule_assign", { net, class: name }); }
    else run("rule_class", { name: sp.class, width: rec });
    const r = run("apply_rules"); if (r) put("m", `⌁ ${net}: traces now follow the class (${r.retraced} re-widthed)`);
  }
  function renderInspector() {
    const selKey = S.sel ? S.sel.kind + ":" + S.sel.id : "";
    if (selKey && selKey !== S.lastSel && S.built) setRTab("inspect"); // picking something shows its properties
    S.lastSel = selKey;
    const sel = S.sel;
    let h = '<div style="color:#7f8c86;font-size:12px">Nothing selected</div>';
    if (sel && sel.kind === "part") {
      const p = board.findPart(sel.id);
      if (p) {
        h = `<div class="tr-card"><div class="tr-line"><span>${esc(p.ref)}</span><span>${esc(defOf(p.type).label)}</span></div>` +
          `<div class="tr-desc"><div class="k">WHAT IT IS</div>${esc(defOf(p.type).desc || "No description for this part yet.")}</div>` +
          `<div class="tr-desc"><div class="k"><label for="insnote">WHAT IT DOES HERE</label></div><textarea id="insnote" data-ins="note" rows="3" placeholder="Say what this part does in your circuit… (Claude fills this in too)">${esc(p.note || "")}</textarea></div>` +
          nowBlock(p) + elecBlock(p) +
          `<div class="tr-kv" style="margin-top:6px">` +
          `<div><label for="insv">VALUE</label><input id="insv" data-ins="value" value="${esc(p.value)}"></div><div><label for="insr">ROT</label><select id="insr" data-ins="rot">${[0, 90, 180, 270].map((r) => `<option ${r === p.rot ? "selected" : ""}>${r}</option>`).join("")}</select></div>` +
          `<div><label for="insx">X mm</label><input id="insx" data-ins="x" type="number" step="0.25" value="${p.x}"></div><div><label for="insy">Y mm</label><input id="insy" data-ins="y" type="number" step="0.25" value="${p.y}"></div></div>` +
          pinsBlock(p) +
          `<button class="tr-btn" id="insdel" style="margin-top:8px">Delete part</button></div>`;
      }
    } else if (sel && sel.kind === "cut") {
      const c = (board.s.cutouts || []).find((q) => q.id === sel.id);
      if (c) h = `<div class="tr-card"><div class="tr-line"><span>Cutout ${esc(c.id)}</span><span>${esc(c.shape)}</span></div><div class="tr-kv" style="margin-top:6px">` +
        `<div><label for="insx">X mm</label><input id="insx" data-ins="x" type="number" step="0.25" value="${c.x}"></div><div><label for="insy">Y mm</label><input id="insy" data-ins="y" type="number" step="0.25" value="${c.y}"></div>` +
        (c.shape === "circle" ? `<div><label for="insd">DIAMETER</label><input id="insd" data-ins="d" type="number" step="0.1" value="${c.d}"></div>` : `<div><label for="insw2">WIDTH</label><input id="insw2" data-ins="w" type="number" step="0.5" value="${c.w}"></div><div><label for="insh2">HEIGHT</label><input id="insh2" data-ins="h" type="number" step="0.5" value="${c.h}"></div>`) +
        `</div><button class="tr-btn" id="insdel" style="margin-top:8px">Delete cutout</button></div>`;
    } else if (sel && sel.kind === "meas") {
      const m = board.s.measures.find((q) => q.id === sel.id);
      if (m) h = `<div class="tr-card"><div class="tr-line"><span>Ruler ${esc(m.id)}</span><span style="color:${COL.meas}">${fmt(Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y))} mm</span></div><div class="tr-line"><span>Δx, Δy</span><span>${fmt(m.b.x - m.a.x)}, ${fmt(m.b.y - m.a.y)}</span></div><button class="tr-btn" id="insdel" style="margin-top:8px">Delete ruler</button></div>`;
    } else if (sel && sel.kind === "trace") {
      const t = board.s.traces.find((q) => q.id === sel.id);
      if (t) h = `<div class="tr-card"><div class="tr-line"><span>${esc(t.id)}</span><span>${esc(t.net)}</span></div><div class="tr-kv" style="margin-top:6px">` +
        `<div><label for="insw">WIDTH mm</label><input id="insw" data-ins="width" type="number" step="0.05" value="${t.width}"></div><div><label for="insl">LAYER</label><select id="insl" data-ins="layer"><option ${t.layer === "F.Cu" ? "selected" : ""}>F.Cu</option><option ${t.layer === "B.Cu" ? "selected" : ""}>B.Cu</option></select></div></div>` +
        (() => { const tr = S.safe.traces[t.id]; return tr ? `<div class="tr-line" style="margin-top:6px"><span>Carries</span><span>${fmtA(tr.i)}</span></div><div class="tr-line"><span>Safe up to</span><span>${fmtA(tr.limit)}</span></div>${tr.limit ? gauge(tr.i / tr.limit) : ""}` : ""; })() +
        `<div class="tr-line" style="margin-top:6px"><span>Length</span><span>${fmt(board.traceLength(t))} mm</span></div>` + specBlock(() => board.exec("explain_trace", { id: t.id }), t.net) + `<button class="tr-btn" id="insdel" style="margin-top:8px">Delete trace</button></div>`;
    } else if (sel && sel.kind === "rat") {
      const l = (board.s.links || []).find((q) => q.id === sel.id);
      if (l) h = `<div class="tr-card"><div class="tr-line"><span>Not routed yet</span><span>${esc(l.net)}</span></div><div class="tr-note" style="margin:6px 0">${esc(l.a)} ↔ ${esc(l.b)} is connected in the Schematic but has no copper.</div>` + specBlock(() => board.exec("explain_net", { net: l.net }), l.net) + `<button class="tr-btn gold" id="insroute" data-net="${esc(l.net)}" style="margin-top:8px">Route this net with these settings</button></div>`;
    } else if (sel && sel.kind === "via") {
      const v = board.s.vias.find((q) => q.id === sel.id);
      if (v) h = `<div class="tr-card"><div class="tr-line"><span>${esc(v.id)}</span><span>via ${esc(v.net || "—")}</span></div><div class="tr-line"><span>d / drill</span><span>${v.d} / ${v.drill}</span></div><button class="tr-btn" id="insdel" style="margin-top:8px">Delete via</button></div>`;
    }
    el.trinsp.innerHTML = h;
  }
  function renderDrc() {
    const n = S.drc.errors.length;
    el.trdrc.innerHTML = n
      ? `<div class="tr-drcbad"><b>${n} error${n > 1 ? "s" : ""}</b>${S.drc.errors.slice(0, 8).map((v, i) => `<button class="tr-viol" data-viol="${i}">${esc(v.msg)}</button>`).join("")}</div>`
      : '<div class="tr-drcok">DRC clean · 0 errors</div>';
  }
  function renderStatus() {
    const c = S.cursor, n = S.drc.errors.length;
    el.trstatus.innerHTML = `<span>X <b>${c ? fmt(c.x) : "—"}</b></span><span>Y <b>${c ? fmt(c.y) : "—"}</b></span><span>mm</span>` +
      `<span>PARTS <b>${board.s.parts.length}</b></span><span>NETS <b>${board.nets().length}</b></span><span>TRACES <b>${board.s.traces.length}</b></span><span class="sp"></span>` +
      `<span class="${S.safe.level === "danger" ? "bad" : S.safe.level === "warning" ? "warn" : S.safe.level === "safe" ? "good" : ""}" data-safe-status="${S.safe.level}">SAFETY: ${S.safe.level === "danger" ? S.safe.counts.danger + " danger" + (S.safe.counts.danger > 1 ? "s" : "") : S.safe.level === "warning" ? S.safe.counts.warning + " warning" + (S.safe.counts.warning > 1 ? "s" : "") : S.safe.level === "safe" ? "ok" : "—"}</span>` +
      `<span class="${n ? "bad" : "good"}">${n ? n + " DRC error" + (n > 1 ? "s" : "") : "DRC clean"}</span><span>tool <b>${S.tool}</b></span><span>layer <b>${S.layer}</b></span>`;
    for (const b of document.querySelectorAll("#tr [data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === S.tool));
    const hint = { select: "click to select · drag a part to move · R rotate · Del delete", place: `click to place ${defOf(S.partType).label} — ${defOf(S.partType).desc || ""}  (R rotate · Esc cancel)`,
      route: S.route ? "click to add a corner · click a pad to finish · double-click to end here · V via · Esc cancel" : "click a pad (or empty copper) to start a trace",
      measure: S.meas ? "click the second point" : "click two points to measure (snaps to pads & part centers)" }[S.tool];
    el.trhint.textContent = hint;
  }

  // ---------- state sync ----------
  let saveTimer = 0;
  // the debounced autosave is flushed when the tab is hidden/closed so the last edit is never lost
  function saveNow() { clearTimeout(saveTimer); saveTimer = 0; try { localStorage.setItem(STORE, board.serialize()); } catch (_) { /* private mode */ } }
  addEventListener("pagehide", () => { if (S.built && saveTimer) saveNow(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && S.built && saveTimer) saveNow(); });
  function afterChange() {
    if (!S.built) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 200);
    if (S.sel && S.sel.kind === "part" && !board.findPart(S.sel.id)) S.sel = null;
    if (S.sel && S.sel.kind === "trace" && !board.s.traces.some((t) => t.id === S.sel.id)) S.sel = null;
    if (S.sel && S.sel.kind === "meas" && !board.s.measures.some((t) => t.id === S.sel.id)) S.sel = null;
    if (S.sel && S.sel.kind === "cut" && !(board.s.cutouts || []).some((t) => t.id === S.sel.id)) S.sel = null;
    if (S.sel && S.sel.kind === "via" && !board.s.vias.some((t) => t.id === S.sel.id)) S.sel = null;
    S.drc = board.exec("drc");
    runSafety();
    try { S.review = board.review(S.safe, S.drc); } catch (e) { S.review = []; }
    if (S.sel && S.sel.kind === "rat" && !(S.safe.unrouted_links || []).includes(S.sel.id)) S.sel = null;
    renderPanels();
    render();
    window.TraceChat.renderSteps({ drc: S.drc, safe: S.safe, review: S.review });
    window.TraceCart.update();
    if (S.tab === "graph") window.TraceGraph.render();
    if (S.tab === "code") window.TraceCode.draw();
  }
  board.on((e) => {
    if (e.type === "change") { afterChange(); return; }
    if (e.type === "focus") { mark(e.x, e.y, e.label, COL.claude); }
  });
  function mark(x, y, label, color) { S.mark = { x, y, label, color: color || COL.claude, t: performance.now() }; render(); }

  // ---------- run a command from the UI (errors go to the dock) ----------
  function run(cmd, args, source) {
    try { return board.exec(cmd, args, source || "user"); }
    catch (e) { put("e", "✕ " + e.message); return null; }
  }
  function updateMode(m) {
    for (const b of el.root.querySelectorAll("[data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === m));
    el.dock.dataset.aimode = m;
    el.trin.placeholder = m === "plan" ? "Describe what you want — I'll plan it with you first…" : "Describe what you want — I'll build it…";
  }
  function setRTab(t) {
    S.rtab = t;
    for (const b of el.root.querySelectorAll("[data-rtab]")) b.setAttribute("aria-selected", String(b.dataset.rtab === t));
    document.getElementById("trpane-copilot").hidden = t !== "copilot";
    document.getElementById("trpane-inspect").hidden = t !== "inspect";
    if (t === "copilot") { const l = el.trlog; l.scrollTop = l.scrollHeight; }
  }
  function onStep(id) {
    if (id === "sch") setTab("graph");
    else if (id === "res") { setTab("graph"); window.TraceFinderUI.toggle("find"); }
    else if (id === "lay") setTab("board");
    else if (id === "arch") { setRTab("copilot"); sendText("Show me the architecture: assumptions, calculations and a block diagram for what we are building."); }
    else if (id === "rev") { setRTab("copilot"); sendText("Do the final review: read the circuit, check every block, and tell me the key numbers, risks and what I should double-check."); }
  }
  function setTab(t) {
    if (t !== "board" && t !== "graph" && t !== "code") return;
    S.tab = t; S.route = null; S.meas = null; S.drag = null;
    el.root.classList.toggle("tab-graph", t === "graph");
    el.trstage.hidden = t !== "board";
    for (const b of el.root.querySelectorAll("[data-vtab]")) b.setAttribute("aria-selected", String(b.dataset.vtab === t));
    if (t === "graph") window.TraceGraph.show(); else window.TraceGraph.hide();
    if (t === "code") window.TraceCode.show(); else window.TraceCode.hide();
    window.TracePanel.render();
    if (t === "board") requestAnimationFrame(() => { if (S.needFit) { S.needFit = false; fit(); } syncAspect(); render(); });
    try { localStorage.setItem("trace-tab-v1", t); } catch (_) { /* private mode */ }
    renderPanels(); render();
  }
  function setTool(t) {
    S.tool = t; S.route = null; S.meas = null; S.drag = null;
    renderPanels(); render();
  }

  // ---------- pointer / keyboard ----------
  function finishRoute(toPt, wp) {
    const st = S.route;
    S.route = null;
    const res = run("route", { from: st.fromSpec, to: coord(toPt), points: wp.map((q) => q.x + ":" + q.y).join("/") || undefined,
      width: S.width || undefined, layer: S.layer, net: st.net || S.net || undefined });
    if (res) { put("t", `⌁ route ${st.fromSpec} → ${coord(toPt)} · ${res.net} · ${fmt(res.length)} mm`); }
    renderStatus(); render();
    return res;
  }
  function onDown(e) {
    const w = toWorld(e);
    if (e.button === 1 || (S.space && e.button === 0)) { startPan(e); return; }
    if (e.button !== 0) return;
    el.trin.blur();
    if (S.tool === "select") {
      const ratEl = e.target.closest && e.target.closest("[data-rat]"), cutEl = e.target.closest && e.target.closest("[data-cut]"), ruler = e.target.closest && e.target.closest("[data-meas]"), part = e.target.closest && e.target.closest("[data-ref]"), tr = e.target.closest && e.target.closest("[data-trace]"), via = e.target.closest && e.target.closest("[data-via]");
      if (part) {
        const p = board.findPart(part.dataset.ref);
        S.sel = { kind: "part", id: p.ref };
        S.drag = { ref: p.ref, ox: w.x - p.x, oy: w.y - p.y, snap: JSON.stringify(board.s), moved: false };
        el.trsvg.setPointerCapture(e.pointerId);
      } else if (ratEl && !tr && !via && !ruler) { S.sel = { kind: "rat", id: ratEl.dataset.rat };
      } else if (cutEl && !ruler) {
        const c = (board.s.cutouts || []).find((q) => q.id === cutEl.dataset.cut);
        S.sel = { kind: "cut", id: c.id };
        S.cdrag = { id: c.id, ox: w.x - c.x, oy: w.y - c.y, snap: JSON.stringify(board.s), moved: false };
        el.trsvg.setPointerCapture(e.pointerId);
      } else if (ruler) S.sel = { kind: "meas", id: ruler.dataset.meas };
      else if (via) S.sel = { kind: "via", id: via.dataset.via };
      else if (tr) S.sel = { kind: "trace", id: tr.dataset.trace };
      else { S.sel = null; startPan(e); }
      renderInspector(); render(); return;
    }
    if (S.tool === "place") {
      const res = run("place", { type: S.partType, x: snap(w.x), y: snap(w.y), rot: S.rot });
      if (res) { S.sel = { kind: "part", id: res.ref }; put("t", `⌁ place ${S.partType} ${res.ref} @ ${res.x}, ${res.y}`); renderInspector(); }
      return;
    }
    if (S.tool === "route") {
      const pt = snapPoint(w, false);
      if (!S.route) { S.route = { fromSpec: coord(pt), origin: { x: pt.x, y: pt.y }, pts: [], net: "" }; renderStatus(); render(); return; }
      if (e.detail >= 2) { // double-click: end at the last corner
        if (!S.route.pts.length) { S.route = null; renderStatus(); render(); return; }
        const wp = S.route.pts.slice(), last = wp.pop();
        finishRoute({ x: last.x, y: last.y }, wp); return;
      }
      if (pt.pad && coord(pt) !== S.route.fromSpec) { finishRoute(pt, S.route.pts); return; }
      S.route.pts.push({ x: pt.x, y: pt.y }); render(); return;
    }
    if (S.tool === "measure") {
      const pt = snapPoint(w, true);
      if (!S.meas) { S.meas = { a: pt }; renderStatus(); render(); return; }
      const res = run("measure", { from: coord(S.meas.a), to: coord(pt) });
      S.meas = null;
      if (res) put("r", `⌁ measure → ${fmt(res.distance)} mm  (Δx ${fmt(res.dx)}, Δy ${fmt(res.dy)})`);
      renderStatus();
    }
  }
  // hover tooltip: what this part is, what it does here, and which pin the cursor is on
  function nowTip(p) {
    const st = S.safe.parts[p.ref];
    if (!st || (st.i === undefined && st.v === undefined)) return "";
    const bits = [];
    if (st.i !== undefined && st.kind !== "capacitor") bits.push(fmtA(st.i));
    if (st.v !== undefined) bits.push(fmtV(st.v));
    return bits.length ? `<div class="now">now: ${bits.join(" · ")}${st.load ? " · " + Math.round(st.load * 100) + "% of limit" : ""}</div>` : "";
  }
  function showTip(e, w) {
    const part = !S.drag && !S.pan && e.target.closest && e.target.closest("[data-ref]");
    const p = part && board.findPart(part.dataset.ref);
    if (!p) { el.trtip.hidden = true; return; }
    const d = defOf(p.type), pd = nearestPad(w, 0.15);
    const own = pd && pd.ref.startsWith(p.ref + ".") ? pd : null;
    el.trtip.innerHTML = `<b>${esc(p.ref)}</b> · ${esc(d.label)}${p.value && p.value !== d.value ? " · " + esc(p.value) : ""}<br>${esc(p.note || d.desc || "")}${nowTip(p)}` +
      (own ? `<div class="pin">pin ${esc(own.n)}${own.fn !== own.n ? " (" + esc(own.fn) + ")" : ""}${own.net ? " · net " + esc(own.net) : ""}${own.desc ? "<br>" + esc(own.desc) : ""}</div>` : "");
    const r = el.trstage.getBoundingClientRect();
    el.trtip.hidden = false;
    el.trtip.style.left = Math.min(e.clientX - r.left + 16, r.width - 290) + "px";
    el.trtip.style.top = Math.min(e.clientY - r.top + 16, r.height - el.trtip.offsetHeight - 8) + "px";
  }
  function onMove(e) {
    const w = toWorld(e);
    S.cursor = w;
    showTip(e, w);
    if (S.pan) {
      const k = PX();
      S.view.x = S.pan.vx - (e.clientX - S.pan.sx) * k; S.view.y = S.pan.vy - (e.clientY - S.pan.sy) * k;
    } else if (S.cdrag) {
      const nx = snap(w.x - S.cdrag.ox), ny = snap(w.y - S.cdrag.oy), c = (board.s.cutouts || []).find((q) => q.id === S.cdrag.id);
      if (c && (nx !== c.x || ny !== c.y)) { S.cdrag.moved = true; c.x = nx; c.y = ny; }
    } else if (S.drag) {
      const p = board.findPart(S.drag.ref);
      const nx = snap(w.x - S.drag.ox), ny = snap(w.y - S.drag.oy);
      if (p && (nx !== p.x || ny !== p.y)) {
        S.drag.moved = true;
        board._quiet = true;
        try { board.exec("move", { ref: p.ref, x: nx, y: ny }); } finally { board._quiet = false; }
      }
    }
    renderStatus(); render();
  }
  function onUp(e) {
    if (S.cdrag) { const d = S.cdrag; S.cdrag = null; if (d.moved) { board.undoS.push(d.snap); board.redoS.length = 0; board.emit({ type: "change", cmd: "set_cutout", source: "user" }); } }
    if (S.pan) { S.pan = null; el.trsvg.style.cursor = ""; }
    if (S.drag) {
      const d = S.drag; S.drag = null;
      if (d.moved) { board.undoS.push(d.snap); board.redoS.length = 0; board.emit({ type: "change", cmd: "move", source: "user" }); }
    }
    try { el.trsvg.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
  }
  function startPan(e) {
    S.pan = { sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y };
    el.trsvg.style.cursor = "grabbing";
    try { el.trsvg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }
  function onWheel(e) {
    e.preventDefault();
    const w = toWorld(e), f = Math.pow(1.0015, e.deltaY), nw = Math.max(5, Math.min(700, S.view.w * f)), k = nw / S.view.w;
    S.view.x = w.x - (w.x - S.view.x) * k; S.view.y = w.y - (w.y - S.view.y) * k; S.view.w = nw;
    syncAspect(); render();
  }
  function typing(e) { const t = e.target; return t && ((t.tagName === "INPUT" && !/^(checkbox|radio|button)$/.test(t.type)) || t.tagName === "TEXTAREA" || t.tagName === "SELECT"); }
  function onKey(e) {
    if (!S.open) return;
    if (S.tab === "graph" && window.TraceGraph.onKey(e)) return;
    if (e.key === " " && !typing(e)) { S.space = true; e.preventDefault(); return; }
    if (typing(e)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); run(e.shiftKey ? "redo" : "undo"); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); run("redo"); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "b") { setTab("board"); return; }
    if (k === "g" || k === "s") { setTab("graph"); return; }
    if (k === "c") { setTab("code"); return; }
    if (S.tab !== "board") return; // board tools only work on the Board tab
    if (k === "v" && S.route) { routeVia(); return; }
    if (k === "v") setTool("select");
    else if (k === "p") setTool("place");
    else if (k === "w") setTool("route");
    else if (k === "m") setTool("measure");
    else if (k === "1") { S.layer = "F.Cu"; renderPanels(); render(); }
    else if (k === "2") { S.layer = "B.Cu"; renderPanels(); render(); }
    else if (k === "f") { fit(); render(); }
    else if (k === "r") {
      if (S.tool === "place") { S.rot = (S.rot + 90) % 360; render(); }
      else if (S.sel && S.sel.kind === "part") run("rotate", { ref: S.sel.id });
    } else if (k === "delete" || k === "backspace" || k === "x") deleteSel();
    else if (k === "enter" && S.route && S.route.pts.length) { const wp = S.route.pts.slice(), last = wp.pop(); finishRoute(last, wp); }
  }
  function deleteSel() {
    if (!S.sel && S.tool === "measure" && board.s.measures.length) { run("remove", { id: board.s.measures[board.s.measures.length - 1].id }); return; } // Del in the ruler tool removes the last ruler
    if (!S.sel) return;
    if (S.sel.kind === "part") run("remove", { ref: S.sel.id }); else run("remove", { id: S.sel.id });
  }
  // V while routing: end this trace here, drop a via, continue on the other layer
  function routeVia() {
    const st = S.route, cur = S.cursor; if (!cur) return;
    const pt = snapPoint(cur, false);
    const res = finishRoute({ x: pt.x, y: pt.y }, st.pts);
    if (!res) return;
    run("add_via", { x: pt.x, y: pt.y, net: res.net });
    S.layer = S.layer === "F.Cu" ? "B.Cu" : "F.Cu";
    S.route = { fromSpec: pt.x + ":" + pt.y, origin: { x: pt.x, y: pt.y }, pts: [], net: res.net };
    put("m", "⌁ via placed · now routing on " + S.layer);
    renderPanels(); render();
  }
  window.trEscape = function () {
    if (window.TraceCart.isOpen) { window.TraceCart.close(); return; } // Esc closes the cart first, not the whole studio
    if (!el.trmodal.hidden) { closeModal(); return; }
    // step down: cancel in-progress route/measure → back to the select tool → deselect → close
    if (S.route || S.meas) { S.route = null; S.meas = null; renderStatus(); render(); return; }
    if (S.tool !== "select") { setTool("select"); return; }
    if (S.sel) { S.sel = null; renderPanels(); render(); return; }
    closeTrace();
  };

  function wire() {
    const svg = el.trsvg;
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("pointerleave", () => { el.trtip.hidden = true; S.cursor = null; renderStatus(); render(); });
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("contextmenu", (e) => { e.preventDefault(); if (S.route || S.meas) { S.route = null; S.meas = null; renderStatus(); render(); } });
    addEventListener("keydown", onKey);
    addEventListener("keyup", (e) => { if (e.key === " ") S.space = false; });
    new ResizeObserver(() => { if (S.open) { if (S.needFit && el.trsvg.clientWidth > 20) { S.needFit = false; fit(); } syncAspect(); render(); } }).observe(el.trstage);
    el.root.addEventListener("click", (e) => {
      const t = e.target.closest("button,[data-layer]"); if (!t) return;
      if (t.dataset.rtab) setRTab(t.dataset.rtab);
      else if (t.dataset.mode) window.TraceChat.setMode(t.dataset.mode);
      else if (t.id === "trsend") dockSend();
      else if (t.dataset.step) onStep(t.dataset.step);
      else if (t.dataset.vtab) setTab(t.dataset.vtab);
      else if (t.dataset.tool) setTool(t.dataset.tool);
      else if (t.dataset.vis) { S.vis[t.dataset.vis] = !S.vis[t.dataset.vis]; renderPanels(); render(); e.stopPropagation(); }
      else if (t.dataset.layer) { S.layer = t.dataset.layer; renderPanels(); render(); }
      else if (t.dataset.part) {
        if (S.tab === "graph") { const r = window.TraceGraph.addPart(t.dataset.part); if (r) put("t", "⌁ added " + r + " to the schematic"); }
        else { S.partType = t.dataset.part; S.tool = "place"; S.rot = 0; S.route = null; renderPanels(); render(); }
      }
      else if (t.dataset.net && t.id !== "insroute") { S.hlNet = S.hlNet === t.dataset.net ? null : t.dataset.net;
        const nn = S.hlNet && board.nets().find((q) => q.name === S.hlNet); if (nn && nn.note) put("m", "◇ " + nn.name + " — " + nn.note); setTimeout(() => { S.hlNet = null; render(); renderPanels(); }, 3000); renderPanels(); render(); }
      else if (t.dataset.viol) { const v = S.drc.errors[+t.dataset.viol]; if (v) mark(v.x, v.y, v.rule, COL.bad); }
      else if (t.dataset.rmmeas) run("remove", { id: t.dataset.rmmeas });
      else if (t.id === "trclrmeas") run("clear_measures");
      else if (t.id === "trclose") closeTrace();
      else if (t.id === "trundo") run("undo");
      else if (t.id === "trredo") run("redo");
      else if (t.id === "trnew") { run("clear"); S.sel = null; }
      else if (t.id === "trsample") { run("load_sample"); S.sel = null; fit(); render(); }
      else if (t.id === "trplace") { const r = run("autoplace", {}); if (r) { put("m", `⌁ auto-place: ${r.moved} parts moved · wiring ${r.wirelength_before_mm} → ${r.wirelength_after_mm} mm · ${r.anchored.length} decoupling caps at their pins${Object.keys(r.edge).length ? " · " + Object.entries(r.edge).map(([k, v]) => k + " on the " + v + " edge").join(", ") : ""}`); fit(); render(); } }
      else if (t.id === "trroute" || t.id === "insroute") {
        put("m", "⌁ routing…"); const net = t.dataset.net;
        setTimeout(() => { const r = run("autoroute", net ? { net } : {}); if (!r) return; S.lastRoute = { routed: r.routed, failed: r.failed, vias: r.vias_added, seconds: r.seconds }; put(r.failed.length ? "e" : "m", `⌁ auto-route: ${r.routed} connection${r.routed === 1 ? "" : "s"} routed · ${r.vias_added} vias${r.pour ? " · " + r.pour + " pour on B.Cu" : ""} · ${r.drc_errors} DRC errors · ${r.seconds}s${r.failed.length ? " · " + r.failed.length + " could not be routed: " + r.failed.map((x) => x.reason).join("; ") : ""}`); renderReview(); }, 30);
      }
      else if (t.id === "trreviewbtn") { S.review = board.review(S.safe, S.drc); setRTab("inspect"); renderReview(); const bad = S.review.filter((x) => x.level !== "info"); put(bad.some((x) => x.level === "danger") ? "e" : "m", `⌁ review: ${bad.length ? bad.length + " thing" + (bad.length > 1 ? "s" : "") + " an engineer would fix — see Inspect → Engineer review" : "nothing an engineer would flag"}`); }
      else if (t.dataset.rv) focusReview(t.dataset.rv);
      else if (t.dataset.spec === "apply") { const card = t.closest("[data-spec-net]"); if (card) specApply(card.dataset.specNet); }
      else if (t.dataset.spec === "copy") { const card = t.closest("[data-spec-net]"); if (card) { let sp; try { sp = board.exec("explain_net", { net: card.dataset.specNet }); } catch (_) { return; } (navigator.clipboard ? navigator.clipboard.writeText(sp.steps.join("\n")) : Promise.reject()).then(() => put("m", "⌁ trace settings copied"), () => put("m", sp.steps.join(" · "))); } }
      else if (t.id === "trdrcbtn") { S.drc = board.exec("drc"); renderPanels(); render(); put("r", S.drc.errors.length ? `⌁ drc: ${S.drc.errors.length} error(s)` : "⌁ drc: clean"); }
      else if (t.id === "trexport") exportJson();
      else if (t.id === "insdel") deleteSel();
      else if (t.dataset.issue) {
        const it = S.safe.issues.find((q) => q.id === t.dataset.issue);
        if (it) {
          if (it.trace) S.sel = { kind: "trace", id: it.trace };
          else if (it.ref && board.findPart(String(it.ref).split(".")[0])) S.sel = { kind: "part", id: board.findPart(String(it.ref).split(".")[0]).ref };
          if (it.x != null) mark(it.x, it.y, it.code, it.level === "danger" ? COL.bad : "#ffb347");
          renderInspector(); render();
        }
      }
      else if (t.id === "trreport") { downloadText("trace-safety-report.txt", reportText()); put("m", "⌁ saved trace-safety-report.txt"); }
      else if (t.id === "trnewpart") openModal("create");
      else if (t.id === "trfindpart") openModal("online");
      else if (t.id === "trmodalclose") closeModal();
      else if (t.dataset.tab) showTab(t.dataset.tab);
      else if (t.id === "trsgo") onlineSearch();
      else if (t.dataset.import) importOnline(t.dataset.import, t);
      else if (t.id === "trpcreate") createFromForm();
      else if (t.dataset.delpart) { const r = run("delete_part", { id: t.dataset.delpart }); if (r) put("m", "◆ removed " + r.deleted + " from the parts library"); if (S.partType === t.dataset.delpart) S.partType = "resistor"; }
      else if (t.classList.contains("tr-chip")) { el.trin.value = t.textContent; dockSend(); }
    });
    el.root.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.elec && S.sel && S.sel.kind === "part") {
        const args = { ref: S.sel.id };
        if (t.dataset.elec === "kind") args.kind = t.value; else { if (t.value === "") return; args[t.dataset.elec] = t.value; }
        run("set_electrical", args); return;
      }
      if (t.dataset.role && S.sel && S.sel.kind === "part") { run("set_electrical", { ref: S.sel.id, roles: t.dataset.role + ":" + t.value }); return; }
      if (t.id === "trpt") { document.getElementById("trpadswrap").hidden = t.value !== "custom"; return; }
      if (t.id === "trwidth") S.width = t.value.trim() === "" ? null : Math.max(0.05, Number(t.value) || 0.25);
      else if (t.id === "trnet") S.net = t.value.trim();
      else if (t.id === "trgrid") S.grid = Number(t.value);
      else if (t.id === "trbw" || t.id === "trbh") run("set_board", { w: Number(document.getElementById("trbw").value), h: Number(document.getElementById("trbh").value) });
      else if (t.dataset.ins && S.sel) {
        const k = t.dataset.ins, id = S.sel.id;
        if (S.sel.kind === "part") {
          if (k === "value") run("set_value", { ref: id, value: t.value });
          else if (k === "note") run("describe", { ref: id, text: t.value });
          else if (k === "rot") run("rotate", { ref: id, rot: Number(t.value) });
          else run("move", { ref: id, [k]: Number(t.value) });
        } else if (S.sel.kind === "trace") run("set_trace", { id, [k]: k === "width" ? Number(t.value) : t.value });
        else if (S.sel.kind === "cut") run("set_cutout", { id, [k]: Number(t.value) });
      }
      renderPanels();
    });
    el.trin.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { el.trin.blur(); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dockSend(); }
    });
    el.trin.addEventListener("input", () => { el.trin.style.height = "auto"; el.trin.style.height = Math.min(140, el.trin.scrollHeight) + "px"; });
    el.root.addEventListener("toggle", (e) => { if (e.target.classList && e.target.classList.contains("tr-elec")) S.elecOpen = e.target.open; }, true);
    // keys typed in a field never reach the board shortcuts or the page-level Esc
    el.root.addEventListener("keydown", (e) => {
      if (!typing(e)) return;
      e.stopPropagation();
      if (e.target.id === "trsq" && e.key === "Enter") onlineSearch();
      if (e.key === "Escape") { e.target.blur(); if (!el.trmodal.hidden) closeModal(); }
    });
  }
  function exportJson() {
    const blob = new Blob([JSON.stringify({ format: "trace-board", version: 1, board: board.s.board, parts: board.s.parts, traces: board.s.traces, vias: board.s.vias, safety: { level: S.safe.level, summary: S.safe.summary, issues: S.safe.issues.map((i) => ({ level: i.level, msg: i.msg, fix: i.fix })), rails: S.safe.rails } }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "trace-board.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    put("m", "⌁ exported trace-board.json");
  }

  // ---------- parts library: persistence on disk (via the agent server) + modal ----------
  const LIBKEY = "trace-parts-v1";
  const libLocal = () => { try { return JSON.parse(localStorage.getItem(LIBKEY) || "{}"); } catch (_) { return {}; } };
  const libStore = (o) => { try { localStorage.setItem(LIBKEY, JSON.stringify(o)); } catch (_) { /* private mode */ } };
  const jpost = (path, body) => fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  board.on((e) => {
    if (e.type !== "library") return;
    const L = libLocal();
    if (e.action === "create") {
      L[e.id] = e.def; libStore(L);
      jpost("/parts", Object.assign({ id: e.id }, e.def)).then((r) => { if (!r.ok) throw 0; put("m", "◆ saved " + e.id + " to the parts library (file on disk)"); })
        .catch(() => put("m", "◆ " + e.id + " kept in this browser only — start `npm run agents` to save it to disk"));
    } else {
      delete L[e.id]; libStore(L);
      fetch(API + "/parts/" + encodeURIComponent(e.id), { method: "DELETE" }).catch(() => {});
    }
    if (S.built) { renderPanels(); render(); }
  });
  async function libLoad() {
    const local = libLocal();
    let server = [], ok = false;
    try { const r = await fetch(API + "/parts"); if (r.ok) { server = await r.json(); ok = true; } } catch (_) { /* offline */ }
    const have = new Set(server.map((p) => p.id));
    for (const p of server) { try { registerPart(p.id, p); local[p.id] = p; } catch (_) { /* skip bad file */ } }
    for (const [id, d] of Object.entries(local)) if (!PARTS[id]) { try { registerPart(id, d); } catch (_) { /* skip */ } }
    if (ok) for (const [id, d] of Object.entries(local)) if (!have.has(id) && PARTS[id]) jpost("/parts", Object.assign({ id }, d)).catch(() => {});
    libStore(local);
    if (S.built) { renderPanels(); render(); }
  }
  function openModal(tab) { el.trmodal.hidden = false; showTab(tab || "online"); (tab === "create" ? document.getElementById("trpl") : el.trsq).focus(); }
  function closeModal() { el.trmodal.hidden = true; }
  function showTab(t) {
    document.getElementById("trtab-online").hidden = t !== "online";
    document.getElementById("trtab-create").hidden = t !== "create";
    for (const b of el.trmodal.querySelectorAll("[data-tab]")) b.setAttribute("aria-pressed", String(b.dataset.tab === t));
  }
  async function onlineSearch() {
    const q = el.trsq.value.trim();
    if (!q) return;
    el.trsr.innerHTML = '<div class="tr-note">Searching the KiCad footprint library…</div>';
    try {
      const r = await fetch(API + "/parts/search?q=" + encodeURIComponent(q)), j = await r.json();
      if (!r.ok) throw new Error(j.error);
      el.trsr.innerHTML = j.length
        ? j.map((h) => `<div class="tr-res"><div><b>${esc(h.name)}</b><span>${esc(h.library)}</span></div><button class="tr-btn" data-import="${esc(h.path)}">Import</button></div>`).join("")
        : '<div class="tr-note">Nothing found. Try a package-style query: soic-8, qfn-32, 0603, usb c, pin header 1x04.</div>';
    } catch (e) {
      el.trsr.innerHTML = `<div class="tr-note bad">${esc(/fetch|Failed/i.test(e.message) ? "Can't reach the agent server — run `npm run agents`, then search again." : e.message)}</div>`;
    }
  }
  async function importOnline(path, btn) {
    btn.disabled = true; btn.textContent = "…";
    try {
      const r = await fetch(API + "/parts/import?path=" + encodeURIComponent(path)), j = await r.json();
      if (!r.ok) throw new Error(j.error);
      const res = run("create_part", { def: j.def, id: j.id });
      if (!res) throw new Error("could not add part");
      btn.textContent = "✓ Added";
      put("r", `⌁ imported ${res.id} · ${res.pads} pads · body ${res.body[0]}×${res.body[1]} mm`);
    } catch (e) { btn.disabled = false; btn.textContent = "Import"; put("e", "✕ import failed: " + e.message); }
  }
  function createFromForm() {
    const v = (id) => document.getElementById(id).value.trim(), tpl = v("trpt");
    const label = v("trpl");
    if (!label) { el.trpmsg.textContent = "Give the part a name."; el.trpmsg.className = "tr-note bad"; return; }
    const a = { id: window.TraceEngine.safeId(label), label, prefix: v("trpp") || "U" };
    if (v("trpdesc")) a.desc = v("trpdesc");
    if (tpl === "custom") a.pads = v("trppads"); else a.template = tpl;
    for (const [k, id] of [["pins", "trpins"], ["pitch", "trpitch"], ["span", "trpspan"], ["body", "trpbody"]]) if (v(id)) a[k] = v(id);
    if (tpl === "two_pad") delete a.pins;
    const res = run("create_part", a);
    if (res) { el.trpmsg.textContent = `✓ ${res.label}: ${res.pads} pads — saved. Find it in PARTS.`; el.trpmsg.className = "tr-note"; }
    else { el.trpmsg.textContent = "Couldn't create — see the message in the dock."; el.trpmsg.className = "tr-note bad"; }
  }

  // ---------- AI activity: working / finished animation ----------
  let aiState = "idle", aiTimer = 0, aiEdits = 0, aiErr = false;
  const MUTATE = new Set(["place", "move", "rotate", "set_value", "remove", "route", "add_via", "set_trace", "measure", "clear_measures", "set_board", "clear", "load_sample", "create_part", "delete_part", "describe", "set_electrical"]);
  function setAI(state) {
    if (!S.built) return;
    clearTimeout(aiTimer);
    aiState = state;
    const st = el.trstage;
    st.classList.toggle("ai-working", state === "working");
    st.classList.toggle("ai-done", state === "done");
    el.dock.classList.toggle("working", state === "working");
    el.trdot.classList.toggle("busy", state === "working");
    el.trai.dataset.state = state;
    const n = aiEdits ? ` · ${aiEdits} edit${aiEdits > 1 ? "s" : ""}` : "";
    el.trai.innerHTML = state === "working" ? `<span class="spin"></span><span>Claude is working<span class="dots"></span>${n}</span>`
      : state === "done" ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path class="tick" d="M5 12.5l4.5 4.5L19 7"/></svg><span>Claude finished${n}</span>`
      : state === "stopped" ? `<span>✕ Claude stopped${n}</span>` : "";
    if (state === "working") setConn(true, "working…");
    if (state === "done" || state === "stopped") { setConn(!!sess, "connected · can read & edit this board"); aiTimer = setTimeout(() => setAI("idle"), 3600); }
  }
  window.trSetAI = setAI; // also handy for tests / demos

  // ---------- dock: slash commands + real Claude ----------
  function put(cls, text) { return window.TraceChat.put(cls, text); }
  const isEdit = (cmd, args) => { const c = String(cmd).toLowerCase().replace(/-/g, "_"); if (c === "build") { const sp = args && (args.spec || args); return !(sp && (sp.dry || sp.dry === 1)); } return window.TraceEngine.MUTATING.has(c) || c === "add_part" || c === "undo" || c === "redo"; };
  function summarize(cmd, r) {
    if (!r) return "ok";
    if (cmd === "place") return `${r.ref} @ ${r.x}, ${r.y}`;
    if (cmd === "route") return `${r.net} · ${r.length} mm`;
    if (cmd === "measure") return `${r.distance} mm`;
    if (cmd === "drc") return r.errors.length ? r.errors.length + " error(s)" : "clean";
    if (cmd === "analyze" || cmd === "safety") return r.level + " · " + r.counts.danger + " danger, " + r.counts.warning + " warning";
    return "ok";
  }
  function slash(line) {
    const tok = line.slice(1).trim().split(/\s+/), cmd = tok[0];
    if (!cmd) return;
    if (cmd === "help") { put("m", Object.values(USAGE).join("\n")); return; }
    const res = run(cmd, tok.slice(1), "user");
    if (res === null) return;
    if (cmd === "analyze" || cmd === "safety") {
      put(res.level === "danger" ? "e" : res.level === "warning" ? "r" : "m", "⚡ " + res.summary);
      for (const i of res.issues) put(i.level === "danger" ? "e" : i.level === "warning" ? "r" : "m", "  " + GLYPH[i.level] + " " + i.msg + (i.fix ? "  → " + i.fix : ""));
      return;
    }
    const text = cmd === "board" || cmd === "parts_library" ? JSON.stringify(res) : JSON.stringify(res);
    put("r", "⌁ " + cmd + " → " + (text.length > 700 ? text.slice(0, 700) + "…" : text));
  }
  let sess = null, es = null, bridge = null, thinking = null, chatTried = false;
  // what Claude is told about the current mode with every message (the user never sees this)
  function modeNote() {
    return window.TraceChat.mode === "plan"
      ? "\n\n(TRACE mode: PLAN. You may NOT edit the board. Reply with: Assumptions, Calculations, a block diagram, the Plan, and OPTIONS if I must choose. Then wait for my approval.)"
      : "\n\n(TRACE mode: AUTO. Follow your workflow and build it; tell me your assumptions as you go.)";
  }
  function sendText(t) { el.trin.value = t; dockSend(); }
  function dockSend() {
    const v = el.trin.value.trim(); if (!v) return;
    el.trin.value = ""; el.trin.style.height = "";
    put("u", "› " + v);
    if (v[0] === "/") { slash(v); return; }
    if (!sess) { put("e", "agent server offline — run `npm run agents`, reopen TRACE, then ask Claude. (slash commands like /place work offline)"); return; }
    aiEdits = 0; aiErr = false; setAI("working");
    fetch(API + "/session/" + sess + "/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: v + modeNote() }) })
      .catch(() => { put("e", "✕ send failed — is the agent server still running?"); setAI("stopped"); });
  }
  function setConn(on, text) { el.trdot.classList.toggle("on", on); el.trst.textContent = text; }
  async function chatConnect() {
    if (chatTried) return; chatTried = true;
    try {
      const r = await fetch(API + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "TRACE", kind: "trace" }) });
      if (!r.ok) throw new Error("session failed");
      const j = await r.json(); sess = j.id;
      es = new EventSource(API + "/session/" + sess + "/events");
      es.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "hello") { setConn(true, "connected · can read & edit this board"); put("m", "connected · Claude can now place, route, measure and check this board"); return; }
        if (thinking) { thinking.remove(); thinking = null; }
        if (m.type === "meta" && m.text === "thinking…") { thinking = put("m", "thinking…"); if (aiState !== "working") { aiEdits = 0; aiErr = false; } setAI("working"); return; }
        if (m.type === "meta") put("m", m.text);
        else if (m.type === "text") put("a", m.text);
        else if (m.type === "tool") put("t", "▸ " + m.name + (m.hint ? ": " + m.hint : ""));
        else if (m.type === "error") { put("e", "✕ " + m.text); aiErr = true; }
        else if (m.type === "done") { window.TraceChat.turnDone(); if (aiState === "working") { setAI(aiErr ? "stopped" : "done"); aiErr = false; } }
      };
      bridge = new EventSource(API + "/trace/events");
      bridge.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type !== "cmd") return;
        let out;
        try {
          if (window.TraceChat.mode === "plan" && isEdit(m.cmd, m.args)) { const pe = new Error("PLAN MODE — you may not change the board yet. Present your assumptions, calculations, diagram and plan in chat (end with an OPTIONS line if the user must choose) and wait for approval. Read-only commands, find_parts and build with dry=1 are allowed."); pe.plan = true; throw pe; }
          const res = board.exec(m.cmd, m.args, "claude");
          out = { id: m.id, ok: true, result: res };
          if (MUTATE.has(m.cmd)) { aiEdits++; if (aiState === "working") setAI("working"); }
          if (m.cmd !== "board" && m.cmd !== "help" && m.cmd !== "parts_library") put("r", `⌁ ${m.cmd} ${Array.isArray(m.args) ? m.args.join(" ") : ""} → ${summarize(m.cmd, res)}`);
        } catch (e) { out = { id: m.id, ok: false, error: e.message }; if (e.plan) put("m", `plan mode: held back ${m.cmd} until you approve`); else put("r", `⌁ ${m.cmd} ✕ ${e.message}`); }
        fetch(API + "/trace/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out) }).catch(() => {});
      };
    } catch (_) {
      setConn(false, "offline");
      put("m", "agent server offline — run `npm run agents` to let Claude edit boards. Slash commands work without it: try /help");
    }
  }

  // ---------- open / close ----------
  window.openTrace = function () {
    if (S.open) return;
    const root = document.getElementById("tr");
    if (!S.built) {
      build();
      try { const saved = localStorage.getItem(STORE); if (saved) board.load(saved); else board.exec("load_sample"); }
      catch (_) { board.exec("load_sample"); }
      board.undoS.length = 0;
      put("m", "TRACE · circuit board studio. Draw with the tools on the left, or ask Claude below.");
    }
    S.open = true;
    document.getElementById("ui").style.visibility = "hidden";
    root.style.display = "flex";
    renderPanels();
    libLoad();
    requestAnimationFrame(() => { fit(); S.drc = board.exec("drc"); runSafety(); renderPanels(); render(); root.classList.add("on"); });
    history.replaceState(null, "", "#trace");
    chatConnect();
  };
  window.closeTrace = function () {
    if (!S.open) return;
    S.open = false; S.route = null; S.meas = null;
    document.getElementById("ui").style.visibility = "";
    const root = document.getElementById("tr");
    root.classList.remove("on");
    setTimeout(() => { if (!S.open) root.style.display = "none"; }, 480);
    history.replaceState(null, "", "#");
    if (typeof endDive === "function") endDive();
  };
  Object.defineProperty(window, "trOpen", { get: () => S.open });
  addEventListener("beforeunload", () => {
    if (sess) fetch(API + "/session/" + sess, { method: "DELETE", keepalive: true }).catch(() => {});
  });
})();
