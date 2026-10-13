// TRACE Schematic view — the circuit drawn the way an engineer reads it.
//   • real symbols: resistor, capacitor, LED, diode, inductor, op-amp, IC boxes with named pins
//   • power and ground are shown as portals (a net name / a ground symbol on the pin), not a tangle of wires
//   • signal wires are orthogonal; very long ones become net labels
//   • parts group into named blocks (sheets) with a datasheet icon
// Wires are logical connections stored on the board (board.s.links), so the analyser, the PCB view and
// Claude all see exactly what you see. Depends on trace/engine.js + electrical.js. Exposes window.TraceGraph.
(function () {
  "use strict";
  const { PARTS, defOf, elecOf } = window.TraceEngine;
  const NS = "http://www.w3.org/2000/svg";
  const ROW = 18, STUB = 14, GAP = 16, FOOT = 14;
  const LINE = "#d9d9d9", DIM = "#8a8a8a", TXT = "#ececec";
  const LV = { danger: "#ff5a5a", warning: "#ffb347", info: "#7fd4ff" };
  const SIG = { usb: "#b48cff", sig: "#d9d9d9", power: "#ff9d6a", gnd: "#8fb0c8" };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtV = (v) => (Math.round(v * 100) / 100) + " V";
  const DIRV = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] };

  const G = { ctx: null, root: null, svg: null, view: { x: 0, y: 0, w: 900, h: 560 }, sel: null, hlNet: null, wireDrag: null, drag: null, pan: null,
    nodes: [], wires: [], pins: {}, netKind: {}, raf: 0, toastT: 0, active: false, fitted: false };

  // ---------- the parts that appear in the schematic ----------
  const graphParts = () => G.ctx.board.s.parts.filter((p) => elecOf(p).kind !== "none" && defOf(p.type).pads.length);

  /** which pads sit on the left / right of an IC box */
  function sides(part) {
    const e = elecOf(part), pads = G.ctx.board.pads(part), L = [], R = [];
    if (e.kind === "connector" || e.kind === "source") return { L, R: pads };
    const rest = [];
    for (const pd of pads) {
      if (pd.role === "power_out") R.push(pd);
      else if (pd.role === "ground" || pd.role === "power_in") L.push(pd);
      else rest.push(pd);
    }
    const half = R.length ? rest.length : Math.ceil(rest.length / 2); // outputs already on the right: keep signals left
    rest.forEach((pd, i) => (i < half ? L : R).push(pd));
    return { L, R };
  }
  const label = (pd) => (pd.fn && pd.fn !== pd.n ? pd.fn : pd.n);

  /** symbol + size + pin positions (relative to the node's top-left) for one part */
  function shape(p) {
    const e = elecOf(p), pads = G.ctx.board.pads(p), t = p.type;
    if (t === "opamp") {
      const by = (fn) => pads.find((q) => q.fn === fn);
      const pins = [[by("IN+"), 0, 14, "L"], [by("IN-"), 0, 46, "L"], [by("OUT"), 100, 30, "R"], [by("V+"), 52, -14, "U"], [by("V-"), 52, 74, "D"]].filter((x) => x[0]);
      return { sym: "opamp", w: 112, h: 88, oy: 14, pins: pins.map(([pd, x, y, dir]) => ({ pd, x, y: y + 14, dir })) };
    }
    if (pads.length === 2) {
      const sym = { resistor: "res", capacitor: "cap", led: "led", diode: "diode", inductor: "ind" }[e.kind] || (t === "battery" ? "batt" : "box2");
      return { sym, w: 120, h: 64, oy: 0, pins: [{ pd: pads[0], x: 14, y: 0, dir: "U" }, { pd: pads[1], x: 14, y: 64, dir: "D" }] };
    }
    const s = sides(p), rows = Math.max(s.L.length, s.R.length, 1);
    const wl = Math.max(0, ...s.L.map((q) => label(q).length)) * 6.3, wr = Math.max(0, ...s.R.map((q) => label(q).length)) * 6.3;
    const bw = Math.max(110, Math.round(wl + wr + 44)), bh = rows * ROW + 16, ox = STUB + 4;
    const pins = [];
    s.L.forEach((pd, i) => pins.push({ pd, x: ox - STUB, y: 34 + 8 + i * ROW + ROW / 2 - 8 + 8, dir: "L", inner: true }));
    s.R.forEach((pd, i) => pins.push({ pd, x: ox + bw + STUB, y: 34 + 8 + i * ROW + ROW / 2 - 8 + 8, dir: "R", inner: true }));
    return { sym: "box", w: bw + 2 * (STUB + 4), h: 34 + bh, oy: 0, bw, bh, ox, top: 34, pins };
  }

  // ---------- connections (links + copper) ----------
  function padAt(x, y) {
    for (const q of G.ctx.board.allPads()) if (Math.abs(q.x - x) < 1e-3 && Math.abs(q.y - y) < 1e-3) return q.ref;
    return null;
  }
  function buildWires() {
    const b = G.ctx.board, W = [], pairKey = (a, c) => (a < c ? a + "|" + c : c + "|" + a), seen = new Map();
    for (const t of b.s.traces) {
      const a = padAt(t.pts[0][0], t.pts[0][1]), c = padAt(t.pts[t.pts.length - 1][0], t.pts[t.pts.length - 1][1]);
      if (!a || !c || a === c) continue;
      const w = { id: t.id, kind: "trace", a, b: c, net: t.net, routed: true };
      seen.set(pairKey(a, c), w); W.push(w);
    }
    const open = new Set(G.ctx.getSafe().unrouted_links || []);
    for (const l of b.s.links || []) {
      const k = pairKey(l.a, l.b);
      if (seen.has(k)) { seen.get(k).linkId = l.id; continue; } // copper already follows this wire
      const w = { id: l.id, kind: "link", a: l.a, b: l.b, net: l.net, routed: !open.has(l.id) };
      seen.set(k, w); W.push(w);
    }
    // pads that share a net name but are not wired directly: "implied" connections keep the picture complete
    const par = new Map(), find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const byNet = new Map();
    for (const q of b.allPads()) if (q.net) { par.set(q.ref, q.ref); if (!byNet.has(q.net)) byNet.set(q.net, []); byNet.get(q.net).push(q.ref); }
    for (const w of W) if (par.has(w.a) && par.has(w.b)) par.set(find(w.a), find(w.b));
    for (const [net, refs] of byNet) {
      const roots = new Map();
      for (const r of refs) if (!roots.has(find(r))) roots.set(find(r), r);
      const reps = [...roots.values()];
      for (let i = 1; i < reps.length; i++) W.push({ id: "i:" + net + ":" + reps[i], kind: "implied", a: reps[0], b: reps[i], net, routed: false });
    }
    return W;
  }
  /** is this net power, ground or an ordinary signal? (power/ground are drawn as portals) */
  function classify() {
    const b = G.ctx.board, by = new Map();
    for (const q of b.allPads()) if (q.net) { if (!by.has(q.net)) by.set(q.net, []); by.get(q.net).push(q); }
    const out = {};
    for (const [net, pads] of by) {
      const g = pads.some((q) => q.role === "ground") || /^(gnd|agnd|dgnd|vss|0v)$/i.test(net);
      const pw = pads.some((q) => q.role === "power_out") || /^(\+?\d+(\.\d+)?v\d*|v(bus|cc|dd|in|bat)\w*|pp\w*|\+\w+)$/i.test(net) || (pads.some((q) => q.role === "power_in") && pads.length > 1 && !pads.some((q) => q.role === "io"));
      out[net] = g && pw ? "short" : g ? "gnd" : pw ? "power" : "sig";
    }
    return out;
  }

  // ---------- layout: blocks side by side, big parts in a row, small parts under them ----------
  function autoLayout(force) {
    const parts = graphParts(), b = G.ctx.board, wires = buildWires();
    const todo = parts.filter((p) => force || p.gx === undefined);
    if (!todo.length) return;
    if (!force) { placeNew(parts, todo); return; } // parts that appear one by one never land on top of each other
    const adj = new Map(parts.map((p) => [p.ref, new Set()]));
    for (const w of wires) { const x = w.a.split(".")[0], y = w.b.split(".")[0]; if (adj.has(x) && adj.has(y) && x !== y) { adj.get(x).add(y); adj.get(y).add(x); } }
    const isSrc = (p) => { const e = elecOf(p); return e.kind === "connector" || e.kind === "source"; };
    const depth = new Map(), q = [];
    for (const p of parts) if (isSrc(p)) { depth.set(p.ref, 0); q.push(p.ref); }
    while (q.length) { const r = q.shift(); for (const n of adj.get(r)) if (!depth.has(n)) { depth.set(n, depth.get(r) + 1); q.push(n); } }
    const maxD = Math.max(0, ...depth.values());
    // groups: the named blocks, else one group per signal-flow step
    const groups = new Map();
    for (const p of todo) {
      const key = p.block ? "b:" + p.block : "d:" + (depth.has(p.ref) ? depth.get(p.ref) : maxD + 1);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    let cx = 0, cy = 0, rowH = 0;
    for (const list of groups.values()) {
      const big = list.filter((p) => shape(p).sym === "box" || shape(p).sym === "opamp"), small = list.filter((p) => !big.includes(p));
      let x = 0, h1 = 0;
      for (const p of big) { const s = shape(p); p.gx = cx + x; p.gy = cy + 64; x += s.w + 50; h1 = Math.max(h1, s.h); }
      let sx = 0;
      for (const p of small) { p.gx = cx + sx; p.gy = cy + 64 + (big.length ? h1 + 80 : 0); sx += 124; }
      const gw = Math.max(x, sx, 150), gh = 64 + (big.length ? h1 + 80 : 0) + (small.length ? 100 : 0);
      rowH = Math.max(rowH, gh); cx += gw + 80;
      if (cx > 820) { cx = 0; cy += rowH + 60; rowH = 0; }
    }
    if (force) b.emit({ type: "change", cmd: "graph_layout" });
  }

  /** put new parts in free space — next to the others of their block when there are any */
  function placeNew(parts, todo) {
    const placed = parts.filter((p) => p.gx !== undefined).map((p) => { const s = shape(p); return { p, x: p.gx, y: p.gy, w: s.w, h: s.h + 20 }; });
    const free = (x, y, w, h) => !placed.some((q) => x < q.x + q.w + 50 && x + w + 50 > q.x && y < q.y + q.h + 50 && y + h + 50 > q.y);
    const order = todo.slice().sort((a, b) => (shape(b).sym === "box" ? 1 : 0) - (shape(a).sym === "box" ? 1 : 0));
    for (const p of order) {
      const s = shape(p), mates = placed.filter((q) => p.block && q.p.block === p.block);
      let ax = 0, ay = 64;
      if (mates.length) { ax = Math.min(...mates.map((q) => q.x)); ay = Math.max(...mates.map((q) => q.y + q.h)) + 30; }
      let done = false;
      for (let ring = 0; ring < 60 && !done; ring++) for (let dx = 0; dx <= 1400 && !done; dx += 40) {
        const x = Math.round((ax + dx) / 10) * 10, y = Math.round((ay + ring * 40) / 10) * 10;
        if (free(x, y, s.w, s.h)) { p.gx = x; p.gy = y; placed.push({ p, x, y, w: s.w, h: s.h + 20 }); done = true; }
      }
      if (!done) { p.gx = 0; p.gy = 64 + placed.length * 120; placed.push({ p, x: p.gx, y: p.gy, w: s.w, h: s.h + 20 }); }
    }
  }

  function layoutModel() {
    const nodes = [], pins = {};
    for (const p of graphParts()) {
      if (p.gx === undefined) autoLayout(false);
      const sh = shape(p), node = { p, x: p.gx, y: p.gy, w: sh.w, h: sh.h + (p.buy ? FOOT : 0), sh, kind: elecOf(p).kind };
      nodes.push(node);
      for (const pn of sh.pins) pins[pn.pd.ref] = { pd: pn.pd, node, dir: pn.dir, side: pn.dir === "R" ? "R" : "L", x: node.x + pn.x, y: node.y + pn.y };
    }
    G.nodes = nodes; G.pins = pins; G.netKind = classify();
    G.wires = buildWires().filter((w) => pins[w.a] && pins[w.b] && (G.netKind[w.net] === undefined || G.netKind[w.net] === "sig" || G.netKind[w.net] === "short" || pins[w.a].pd.net !== pins[w.b].pd.net)); // power/ground are portals — except a wire that joins two different nets (that is a short, show it)
  }

  // ---------- geometry of a wire ----------
  function orthoPoints(a, b) {
    const da = DIRV[a.dir], db = DIRV[b.dir], s = [a.x + da[0] * GAP, a.y + da[1] * GAP], e = [b.x + db[0] * GAP, b.y + db[1] * GAP];
    const P = [[a.x, a.y], s];
    const horiz = (d) => d === "L" || d === "R";
    if (horiz(a.dir) && horiz(b.dir)) {
      if (a.dir === "R" && b.dir === "L" && e[0] >= s[0]) { const mx = (s[0] + e[0]) / 2; P.push([mx, s[1]], [mx, e[1]]); }
      else if (a.dir === "L" && b.dir === "R" && e[0] <= s[0]) { const mx = (s[0] + e[0]) / 2; P.push([mx, s[1]], [mx, e[1]]); }
      else if (a.dir === b.dir) { const mx = a.dir === "R" ? Math.max(s[0], e[0]) + GAP : Math.min(s[0], e[0]) - GAP; P.push([mx, s[1]], [mx, e[1]]); }
      else { const my = Math.abs(s[1] - e[1]) < 4 ? s[1] + 46 : (s[1] + e[1]) / 2; P.push([s[0], my], [e[0], my]); }
    } else if (!horiz(a.dir) && !horiz(b.dir)) {
      if (a.dir === "D" && b.dir === "U" && e[1] >= s[1]) { const my = (s[1] + e[1]) / 2; P.push([s[0], my], [e[0], my]); }
      else if (a.dir === "U" && b.dir === "D" && e[1] <= s[1]) { const my = (s[1] + e[1]) / 2; P.push([s[0], my], [e[0], my]); }
      else if (a.dir === b.dir) { const my = a.dir === "D" ? Math.max(s[1], e[1]) + GAP : Math.min(s[1], e[1]) - GAP; P.push([s[0], my], [e[0], my]); }
      else { const mx = Math.abs(s[0] - e[0]) < 4 ? s[0] + 46 : (s[0] + e[0]) / 2; P.push([mx, s[1]], [mx, e[1]]); }
    } else if (horiz(a.dir)) P.push([e[0], s[1]]);
    else P.push([s[0], e[1]]);
    P.push(e, [b.x, b.y]);
    return P.filter((p, i) => !i || Math.abs(p[0] - P[i - 1][0]) > 0.01 || Math.abs(p[1] - P[i - 1][1]) > 0.01);
  }
  const pathOf = (pts) => "M" + pts.map((p) => p[0] + " " + p[1]).join("L");
  const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  // ---------- symbols ----------
  function symbol(n) {
    const s = n.sh, p = n.p, c = (x, y) => `${x} ${y}`;
    const stroke = `stroke="${LINE}" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
    switch (s.sym) {
      case "res": return `<path d="M14 0V14L8 18L20 24L8 30L20 36L8 42L14 46V64" ${stroke}/>`;
      case "cap": return `<path d="M14 0V28M14 36V64M4 28H24M4 36H24" ${stroke}/>`;
      case "led": return `<path d="M14 0V20M14 44V64M5 20H23L14 36Z M5 36H23" ${stroke}/><path d="M26 24l5-5M26 30l5-5M31 19h-3.5M31 19v3.5" ${stroke} stroke-width="1"/>`;
      case "diode": return `<path d="M14 0V20M14 44V64M5 20H23L14 36Z M5 36H23" ${stroke}/>`;
      case "ind": return `<path d="M14 0V12a6 6 0 0 1 0 12a6 6 0 0 1 0 12a6 6 0 0 1 0 12V64" ${stroke}/>`;
      case "batt": return `<path d="M14 0V26M14 40V64M3 26H25M8 33H20M3 40H25" ${stroke}/>`;
      case "box2": return `<path d="M14 0V16M14 48V64" ${stroke}/><rect x="6" y="16" width="16" height="32" ${stroke}/>`;
      case "opamp": return `<path d="M18 14V74L86 44Z" ${stroke}/><path d="M52 0V29M52 88V59" ${stroke}/><path d="M0 28H18M0 60H18M86 44H100" ${stroke}/><text x="23" y="32" font-size="11" fill="${TXT}" font-family="monospace" pointer-events="none">+</text><text x="23" y="64" font-size="11" fill="${TXT}" font-family="monospace" pointer-events="none">−</text>`;
      default: return "";
    }
  }
  function groundSymbol(x, y, dir) {
    const rot = { D: 0, L: 90, U: 180, R: -90 }[dir];
    return `<g transform="translate(${x} ${y}) rotate(${rot})" pointer-events="none"><path d="M0 0V6M-8 6H8M-5 10H5M-2 14H2" stroke="${SIG.gnd}" stroke-width="1.4" fill="none" stroke-linecap="round"/></g>`;
  }
  function portal(x, y, dir, name) {
    const v = DIRV[dir], px = -v[1], py = v[0];
    const ex = x + v[0] * STUB, ey = y + v[1] * STUB;
    const bar = `M${ex + px * 7} ${ey + py * 7}L${ex - px * 7} ${ey - py * 7}`;
    const tx = dir === "L" ? ex - 6 : dir === "R" ? ex + 6 : ex, ty = dir === "U" ? ey - 7 : dir === "D" ? ey + 14 : ey + 3.5, an = dir === "L" ? "end" : dir === "R" ? "start" : "middle";
    return `<path d="M${x} ${y}L${ex} ${ey}${bar}" stroke="${SIG.power}" stroke-width="1.4" fill="none" stroke-linecap="round" pointer-events="none"/><text x="${tx}" y="${ty}" text-anchor="${an}" font-size="10.5" fill="${SIG.power}" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${esc(name)}</text>`;
  }

  // ---------- status colours ----------
  function worstFor(ref) {
    let w = null;
    for (const it of G.ctx.getSafe().issues) if (it.level !== "info" && it.refs && it.refs.includes(ref)) { if (it.level === "danger") return "danger"; w = "warning"; }
    for (const v of G.ctx.getDrc().errors) if (v.refs && v.refs.includes(ref)) return "danger";
    return w;
  }
  function netLevel(net, wire) {
    const S = G.ctx.getSafe();
    let w = null;
    for (const it of S.issues) {
      if (it.level === "info") continue;
      if (it.net && it.net === net) { if (it.level === "danger") return "danger"; w = "warning"; }
    }
    const qa = G.pins[wire.a], qb = G.pins[wire.b];
    if (qa && qb && qa.pd.net && qb.pd.net && qa.pd.net !== qb.pd.net) return "danger"; // this wire joins two different nets: it IS the short
    const pa = S.pads[wire.a], pb = S.pads[wire.b];
    if (pa && pb && pa.net !== pb.net && (pa.net.includes("+") || pb.net.includes("+"))) return "danger"; // a wire joining two named nets is the short itself
    return w;
  }
  const dsUrl = (p) => (p.buy && p.buy.url ? p.buy.url : "https://www.google.com/search?q=" + encodeURIComponent((p.buy ? p.buy.mpn : defOf(p.type).label + " " + p.value) + " datasheet"));
  const DOC = (x, y) => `<path d="M${x} ${y}h8l4 4v11h-12z M${x + 8} ${y}v4h4" fill="none" stroke="#bdbdbd" stroke-width="1.1" stroke-linejoin="round"/><path d="M${x + 3} ${y + 8}h6M${x + 3} ${y + 11}h6" stroke="#8a8a8a" stroke-width="1"/>`;

  // ---------- drawing ----------
  function draw() {
    G.raf = 0;
    if (!G.active || !G.svg || G.svg.getBoundingClientRect().width < 20) return;
    layoutModel(); syncAspect();
    const V = G.view, S = G.ctx.getSafe();
    G.svg.setAttribute("viewBox", `${V.x} ${V.y} ${V.w} ${V.h}`);
    let o = `<defs><pattern id="trgg" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#222"/></pattern></defs>` +
      `<rect x="${V.x}" y="${V.y}" width="${V.w}" height="${V.h}" fill="#0d0d0d"/><rect x="${V.x}" y="${V.y}" width="${V.w}" height="${V.h}" fill="url(#trgg)" data-bg="1"/>`;
    // block frames
    const blocks = new Map();
    for (const n of G.nodes) if (n.p.block) { if (!blocks.has(n.p.block)) blocks.set(n.p.block, []); blocks.get(n.p.block).push(n); }
    for (const [name, list] of blocks) {
      const x0 = Math.min(...list.map((n) => n.x)) - 26, y0 = Math.min(...list.map((n) => n.y)) - 64, x1 = Math.max(...list.map((n) => n.x + n.w)) + 26, y1 = Math.max(...list.map((n) => n.y + n.h)) + 26;
      o += `<g data-block="${esc(name)}"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="10" fill="none" stroke="#2a2a2a" stroke-dasharray="5 5" pointer-events="none"/>${DOC(x0 + 10, y0 + 9)}<text x="${x0 + 28}" y="${y0 + 20}" font-size="12.5" font-weight="600" fill="#cfcfcf" font-family="Inter,Segoe UI,sans-serif" pointer-events="none">${esc(name)}</text></g>`;
    }
    // wires (signal nets) under the nodes
    let wires = "", dels = "";
    for (const w of G.wires) {
      const A = G.pins[w.a], B = G.pins[w.b], pts = orthoPoints(A, B), d = pathOf(pts);
      const lvl = netLevel(w.net, w), sel = G.sel && G.sel.kind === "wire" && G.sel.id === w.id, hl = G.hlNet && G.hlNet === w.net;
      const usb = A.pd.role.startsWith("usb") || B.pd.role.startsWith("usb");
      const col = lvl === "danger" ? LV.danger : lvl === "warning" ? LV.warning : usb ? SIG.usb : SIG.sig;
      const sv = S.pads[w.a], title = `${w.net || "net"}${sv && sv.v ? " · " + fmtV(sv.v) : ""} · ${w.routed ? "routed on the PCB" : w.kind === "implied" ? "same net" : "not routed yet"}${lvl ? " · " + lvl.toUpperCase() : ""}`;
      const dash = w.kind === "implied" ? ' stroke-dasharray="3 4"' : "";
      const attrs = `class="tr-gw" data-wire="${esc(w.id)}" data-wirenet="${esc(w.net || "")}" data-level="${lvl || ""}" data-routed="${w.routed ? 1 : 0}" data-a="${esc(w.a)}" data-b="${esc(w.b)}" data-kind="${w.kind}"`;
      if (manhattan(A, B) > 520 && !sel) { // long: net labels at both ends instead of a wire across the sheet
        const lab = (P) => { const v = DIRV[P.dir], x = P.x + v[0] * STUB, y = P.y + v[1] * STUB, an = P.dir === "L" ? "end" : P.dir === "R" ? "start" : "middle"; return `<path d="M${P.x} ${P.y}L${x} ${y}" stroke="${col}" stroke-width="1.4"/><text x="${x + v[0] * 4}" y="${y + (P.dir === "U" ? -5 : P.dir === "D" ? 12 : 3.5)}" text-anchor="${an}" font-size="10.5" fill="${col}" font-family="IBM Plex Mono,Consolas,monospace">${esc(w.net)}</text>`; };
        wires += `<g ${attrs} data-label="1"><title>${esc(title)}</title>${lab(A)}${lab(B)}</g>`;
        continue;
      }
      wires += `<g ${attrs}><title>${esc(title)}</title><path d="${d}" fill="none" stroke="transparent" stroke-width="14" style="cursor:pointer"/>` +
        (sel || hl ? `<path d="${d}" fill="none" stroke="${col}" stroke-opacity=".28" stroke-width="8" pointer-events="none"/>` : "") +
        `<path class="wire" d="${d}" fill="none" stroke="${col}" stroke-width="${sel ? 2.4 : 1.4}" stroke-linejoin="round" stroke-linecap="round"${dash} pointer-events="none"/></g>`;
      if (sel) {
        let best = [pts[0], pts[1]], len = 0;
        for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (l > len) { len = l; best = [pts[i - 1], pts[i]]; } }
        const mx = (best[0][0] + best[1][0]) / 2, my = (best[0][1] + best[1][1]) / 2;
        dels += `<g data-del="${esc(w.id)}" style="cursor:pointer"><circle cx="${mx}" cy="${my}" r="10" fill="#2a1416" stroke="${LV.danger}" stroke-width="1.5"/><path d="M${mx - 3.5} ${my - 3.5}L${mx + 3.5} ${my + 3.5}M${mx + 3.5} ${my - 3.5}L${mx - 3.5} ${my + 3.5}" stroke="${LV.danger}" stroke-width="2" stroke-linecap="round"/><title>Delete wire (Del)</title></g>` +
          `<text x="${mx}" y="${my - 16}" text-anchor="middle" font-size="10.5" fill="${col}" font-family="monospace">${esc(w.net || "")}</text>`;
      }
    }
    o += wires;
    // nodes
    for (const n of G.nodes) {
      const p = n.p, s = n.sh, lv = worstFor(p.ref), rep = S.parts[p.ref], sel = G.sel && G.sel.kind === "node" && G.sel.id === p.ref;
      const d = defOf(p.type);
      o += `<g class="tr-gn" data-node="${esc(p.ref)}" data-level="${lv || ""}" transform="translate(${n.x} ${n.y})">`;
      o += `<rect x="-4" y="-4" width="${n.w + 8}" height="${n.h + 8}" fill="transparent" data-head="1" style="cursor:grab"/>`;
      if (s.sym === "box") {
        const stroke = lv ? LV[lv] : sel ? "#5fd0ff" : LINE;
        o += `<rect x="${s.ox}" y="${s.top}" width="${s.bw}" height="${s.bh}" rx="3" fill="#111" stroke="${stroke}" stroke-width="${lv || sel ? 1.8 : 1.3}"/>` +
          `<g data-ds="${esc(p.ref)}" style="cursor:pointer"><title>Open the datasheet for ${esc(p.buy ? p.buy.mpn : p.value)}</title>${DOC(s.ox, 0)}</g>` +
          `<text x="${s.ox + 20}" y="11" font-size="12" font-weight="600" fill="${TXT}" font-family="Inter,Segoe UI,sans-serif" pointer-events="none">${esc(String(p.buy ? p.buy.mpn : p.value && p.value !== d.value ? p.value : d.label).slice(0, 34))}</text>` +
          `<text x="${s.ox}" y="28" font-size="11.5" font-weight="700" fill="#cfcfcf" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${esc(p.ref)}</text>`;
        for (const pn of s.pins) {
          const left = pn.dir === "L", ex = left ? s.ox : s.ox + s.bw;
          o += `<path d="M${pn.x} ${pn.y}H${ex}" stroke="${LINE}" stroke-width="1.2" pointer-events="none"/>` +
            `<text x="${left ? ex + 5 : ex - 5}" y="${pn.y + 3.5}" text-anchor="${left ? "start" : "end"}" font-size="10" fill="#d0d0d0" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${esc(label(pn.pd))}</text>` +
            `<text x="${left ? pn.x + 3 : pn.x - 3}" y="${pn.y - 3}" text-anchor="${left ? "start" : "end"}" font-size="7.5" fill="${DIM}" font-family="monospace" pointer-events="none">${esc(pn.pd.n)}</text>`;
        }
      } else {
        const stroke = lv ? LV[lv] : sel ? "#5fd0ff" : LINE;
        o += `<g style="color:${stroke}">${symbol(n).replace(/stroke="#d9d9d9"/g, `stroke="${stroke}"`)}</g>`;
        const lx = s.sym === "opamp" ? 8 : 34, ly = s.sym === "opamp" ? -2 : 28;
        o += `<text x="${s.sym === "opamp" ? 30 : lx}" y="${s.sym === "opamp" ? -2 : ly - 4}" font-size="11.5" font-weight="700" fill="#cfcfcf" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${esc(p.ref)}</text>`;
        if (s.sym !== "opamp") o += `<text x="${lx}" y="${ly + 10}" font-size="10.5" fill="${DIM}" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none">${esc(String(p.value).slice(0, 14))}</text>`;
        else o += `<g data-ds="${esc(p.ref)}" style="cursor:pointer"><title>Open the datasheet</title>${DOC(0, -18)}</g>`;
      }
      if (p.buy) o += `<text x="${s.sym === "box" ? s.ox : 0}" y="${n.h + 3}" font-size="9.5" fill="#7fd0a8" font-family="IBM Plex Mono,Consolas,monospace" pointer-events="none" data-buy="1">${esc(p.buy.id || p.buy.mpn)}${p.buy.price == null ? "" : " · $" + (Math.round(p.buy.price * 10000) / 10000)}</text>`;
      if (lv) o += `<rect x="-6" y="-6" width="${n.w + 12}" height="${n.h + 12}" rx="6" fill="${LV[lv]}" fill-opacity=".05" stroke="${LV[lv]}" stroke-dasharray="4 3" pointer-events="none"/><g data-badge="${esc(p.ref)}"><circle cx="${n.w + 6}" cy="-6" r="7" fill="${LV[lv]}" stroke="#0d0d0d" stroke-width="1.5"/><text x="${n.w + 6}" y="-2.4" text-anchor="middle" font-size="10" font-weight="700" fill="#150909" pointer-events="none">!</text></g>`;
      else if (sel) o += `<rect x="-6" y="-6" width="${n.w + 12}" height="${n.h + 12}" rx="6" fill="none" stroke="#5fd0ff" stroke-dasharray="4 3" pointer-events="none"/>`;
      if (rep && rep.load !== undefined && rep.load > 0 && s.sym === "box") {
        const f = Math.min(1, rep.load), c = rep.load >= 1 ? LV.danger : rep.load >= 0.7 ? LV.warning : "#3fd0c0";
        o += `<rect x="${s.ox}" y="${s.top + s.bh + 4}" width="${s.bw}" height="2" rx="1" fill="#222"/><rect x="${s.ox}" y="${s.top + s.bh + 4}" width="${s.bw * f}" height="2" rx="1" fill="${c}"/>`;
      }
      o += "</g>";
    }
    // pins: portals for power / ground, the dots wires attach to
    for (const ref in G.pins) {
      const P = G.pins[ref], pd = P.pd, sp = S.pads[ref], net = pd.net, kind = net ? G.netKind[net] : "";
      const wired = G.wires.some((w) => w.a === ref || w.b === ref), portalled = kind === "gnd" || kind === "power";
      const linked = wired || portalled || (net && kind === "short");
      const tgt = G.wireDrag && G.wireDrag.over === ref, psel = G.sel && G.sel.kind === "pin" && G.sel.id === ref;
      let extra = "";
      if (kind === "gnd") { const v = DIRV[P.dir], ex = P.x + v[0] * STUB, ey = P.y + v[1] * STUB; extra = `<path d="M${P.x} ${P.y}L${ex} ${ey}" stroke="${SIG.gnd}" stroke-width="1.4" pointer-events="none"/>` + groundSymbol(ex, ey, P.dir === "U" ? "U" : P.dir === "L" ? "L" : P.dir === "R" ? "R" : "D"); }
      else if (kind === "power") extra = portal(P.x, P.y, P.dir, net);
      const title = `${ref} — ${pd.desc || pd.fn}${net ? " · net " + net : ""}${sp && sp.v ? " · " + fmtV(sp.v) : ""}`;
      o += `<g class="tr-gp" data-pin="${esc(ref)}" data-role="${pd.role}" data-linked="${linked ? 1 : 0}" data-netkind="${kind || ""}"${portalled ? ` data-portal="${esc(ref)}"` : ""} style="cursor:crosshair"><title>${esc(title)}</title>` +
        `<circle cx="${P.x}" cy="${P.y}" r="11" fill="transparent"/>` +
        `<circle cx="${P.x}" cy="${P.y}" r="${tgt ? 5.5 : psel ? 4.5 : 3}" fill="${linked || tgt ? (psel || tgt ? "#5fd0ff" : "#bdbdbd") : "#0d0d0d"}" stroke="${tgt || psel ? "#5fd0ff" : "#9a9a9a"}" stroke-width="1.3"/>${extra}</g>`;
    }
    o += dels;
    if (G.wireDrag) {
      const F = G.pins[G.wireDrag.from], over = G.wireDrag.over && G.pins[G.wireDrag.over];
      const target = over ? { x: over.x, y: over.y, dir: over.dir } : { x: G.wireDrag.x, y: G.wireDrag.y, dir: { L: "R", R: "L", U: "D", D: "U" }[F.dir] };
      o += `<path d="${pathOf(orthoPoints(F, target))}" fill="none" stroke="#5fd0ff" stroke-width="1.6" stroke-dasharray="5 4" pointer-events="none" data-preview="1"/>`;
    }
    G.svg.innerHTML = o;
    renderIssues();
    window.TraceFinderUI.refresh();
    if (G.ctx.onDraw) G.ctx.onDraw();
    G.root.querySelector(".tr-gempty").hidden = !!G.nodes.length;
  }
  function render() { if (G.active && !G.raf) G.raf = requestAnimationFrame(draw); }

  function renderIssues() {
    const S = G.ctx.getSafe(), box = G.root.querySelector(".tr-gissues");
    const real = S.issues.filter((i) => i.level !== "info"), info = S.issues.length - real.length;
    const lab = { safe: "Looks safe", warning: "Caution", danger: "DANGER", unknown: "Add a power source" }[S.level] || S.level;
    box.setAttribute("data-level", S.level);
    box.innerHTML = `<div class="hd"><span class="dot"></span><b>${lab}</b><span class="sm">${real.length ? real.length + " issue" + (real.length > 1 ? "s" : "") : esc(S.summary).slice(0, 60)}</span></div>` +
      real.map((i) => `<button class="tr-gi ${i.level}" data-gissue="${i.id}"><span class="ic">${i.level === "danger" ? "●" : "▲"}</span><span><span class="m">${esc(i.msg)}</span>${i.fix ? `<span class="f">Fix: ${esc(i.fix)}</span>` : ""}</span></button>`).join("") +
      (info ? `<div class="more">${info} note${info > 1 ? "s" : ""}: ${esc(S.issues.filter((i) => i.level === "info").map((i) => i.msg).join(" "))}</div>` : "");
  }

  // ---------- helpers ----------
  const toWorld = (e) => {
    const r = G.svg.getBoundingClientRect(), k = G.view.w / r.width;
    return { x: G.view.x + (e.clientX - r.left) * k, y: G.view.y + (e.clientY - r.top) * k };
  };
  function syncAspect() { const r = G.svg.getBoundingClientRect(); if (r.width) G.view.h = G.view.w * (r.height / r.width); }
  function fit() {
    layoutModel(); syncAspect();
    const r = G.svg.getBoundingClientRect(), asp = r.height / Math.max(1, r.width);
    if (r.width < 20 || r.height < 20) return false; // not on screen yet: try again when it is
    if (!G.nodes.length) { G.view = { x: -100, y: -60, w: 900, h: 900 * asp }; return true; }
    const x0 = Math.min(...G.nodes.map((n) => n.x)) - 60, x1 = Math.max(...G.nodes.map((n) => n.x + n.w)) + 60;
    const y0 = Math.min(...G.nodes.map((n) => n.y)) - 80, y1 = Math.max(...G.nodes.map((n) => n.y + n.h)) + 60;
    const w = Math.max(x1 - x0, (y1 - y0) / asp, 480);
    G.view = { w, h: w * asp, x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - (w * asp) / 2 };
    return true;
  }
  function toast(msg, bad) {
    const t = G.root.querySelector(".tr-gtoast");
    t.textContent = msg; t.hidden = false; t.className = "tr-gtoast" + (bad ? " bad" : "");
    clearTimeout(G.toastT); G.toastT = setTimeout(() => { t.hidden = true; }, 3800);
  }
  function exec(cmd, args) {
    try { return G.ctx.board.exec(cmd, args, "user"); }
    catch (e) { toast(e.message, true); G.ctx.put("e", "✕ " + e.message); return null; }
  }
  function addPart(type, value) {
    const b = G.ctx.board, r = exec("place", { type, auto: 1, value: value || undefined }); // a free spot on the PCB too
    if (!r) return null;
    const p = b.findPart(r.ref), sh = shape(p), c = { x: G.view.x + G.view.w / 2, y: G.view.y + G.view.h / 2 };
    let gx = Math.round((c.x - sh.w / 2) / 10) * 10, gy = Math.round((c.y - sh.h / 2) / 10) * 10;
    const hit = () => G.nodes.some((n) => gx < n.x + n.w + 24 && gx + sh.w + 24 > n.x && gy < n.y + n.h + 40 && gy + sh.h + 40 > n.y);
    for (let i = 0; i < 80 && hit(); i++) { gy += 40; if (i % 10 === 9) { gx += sh.w + 60; gy = Math.round((c.y - sh.h / 2) / 10) * 10; } }
    p.gx = gx; p.gy = gy; b.emit({ type: "change", cmd: "graph_move" });
    G.sel = { kind: "node", id: r.ref };
    render();
    return r.ref;
  }
  function deleteSel() {
    if (!G.sel) return false;
    if (G.sel.kind === "wire") {
      const w = G.wires.find((x) => x.id === G.sel.id);
      if (!w) return false;
      if (w.kind === "implied") { toast("That line only shows two pins share a net name — remove a pin from the net instead.", true); return true; }
      if (exec("disconnect", { id: w.id })) { if (w.linkId) exec("disconnect", { id: w.linkId }); G.sel = null; }
      return true;
    }
    if (G.sel.kind === "pin") { if (exec("unplug", { pad: G.sel.id })) { toast(G.sel.id + " is no longer on that net"); G.sel = null; } return true; }
    if (G.sel.kind === "node") { if (exec("remove", { ref: G.sel.id })) G.sel = null; return true; }
    return false;
  }
  function focusIssue(id) {
    const it = G.ctx.getSafe().issues.find((i) => i.id === id);
    if (!it) return;
    G.hlNet = it.net || null;
    const ref = (it.refs || []).find((r) => G.nodes.some((n) => n.p.ref === r));
    if (ref) {
      const n = G.nodes.find((q) => q.p.ref === ref);
      G.sel = { kind: "node", id: ref };
      G.view.x = n.x + n.w / 2 - G.view.w / 2; G.view.y = n.y + n.h / 2 - G.view.h / 2;
    } else if (it.net) {
      const w = G.wires.find((x) => x.net === it.net);
      if (w) { G.sel = { kind: "wire", id: w.id }; const a = G.pins[w.a]; G.view.x = a.x - G.view.w / 2; G.view.y = a.y - G.view.h / 2; }
    }
    render();
  }
  /** bring a part into view and select it (used by the Objects tree) */
  function focusPart(ref) {
    const n = G.nodes.find((q) => q.p.ref === ref);
    if (!n) return;
    G.sel = { kind: "node", id: ref };
    G.view.x = n.x + n.w / 2 - G.view.w / 2; G.view.y = n.y + n.h / 2 - G.view.h / 2;
    render();
  }

  // ---------- pointer / keys ----------
  function onDown(e) {
    if (e.button === 2) return;
    const t = e.target, w = toWorld(e);
    const del = t.closest("[data-del]");
    if (del) { G.sel = { kind: "wire", id: del.dataset.del }; deleteSel(); render(); return; }
    const ds = t.closest("[data-ds]");
    if (ds) { const p = G.ctx.board.findPart(ds.dataset.ds); if (p) window.open(dsUrl(p), "_blank", "noopener"); return; }
    const pin = t.closest("[data-pin]");
    if (pin) {
      G.svg.setPointerCapture(e.pointerId);
      G.wireDrag = { from: pin.dataset.pin, x: w.x, y: w.y, over: null, moved: false, portal: !!pin.dataset.portal }; render(); return;
    }
    const wire = t.closest("[data-wire]");
    if (wire) { G.sel = { kind: "wire", id: wire.dataset.wire }; G.hlNet = null; render(); return; }
    const node = t.closest("[data-node]");
    if (node) {
      const ref = node.dataset.node, p = G.ctx.board.findPart(ref);
      G.sel = { kind: "node", id: ref }; G.hlNet = null;
      G.svg.setPointerCapture(e.pointerId);
      G.drag = { ref, dx: w.x - p.gx, dy: w.y - p.gy, moved: false };
      render(); return;
    }
    G.sel = null; G.hlNet = null;
    G.svg.setPointerCapture(e.pointerId);
    G.pan = { cx: e.clientX, cy: e.clientY, vx: G.view.x, vy: G.view.y };
    render();
  }
  function onMove(e) {
    if (G.wireDrag) {
      const w = toWorld(e), under = document.elementFromPoint(e.clientX, e.clientY), pin = under && under.closest && under.closest("[data-pin]");
      if (Math.hypot(w.x - G.wireDrag.x, w.y - G.wireDrag.y) > 4) G.wireDrag.moved = true;
      G.wireDrag.x = w.x; G.wireDrag.y = w.y; G.wireDrag.over = pin && pin.dataset.pin !== G.wireDrag.from ? pin.dataset.pin : null;
      render();
    } else if (G.drag) {
      const w = toWorld(e), p = G.ctx.board.findPart(G.drag.ref);
      if (!p) return;
      p.gx = Math.round((w.x - G.drag.dx) / 10) * 10; p.gy = Math.round((w.y - G.drag.dy) / 10) * 10; G.drag.moved = true; render();
    } else if (G.pan) {
      const k = G.view.w / G.svg.getBoundingClientRect().width;
      G.view.x = G.pan.vx - (e.clientX - G.pan.cx) * k; G.view.y = G.pan.vy - (e.clientY - G.pan.cy) * k; render();
    }
  }
  function onUp(e) {
    try { G.svg.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    if (G.wireDrag) {
      const { over: to, from, moved, portal: wasPortal } = G.wireDrag;
      G.wireDrag = null;
      if (to) {
        const r = exec("connect", { a: from, b: to });
        if (r) { const k = G.netKind[r.net]; toast(`${from} → ${to} · net ${r.net}`); G.sel = null; void k; }
      } else if (!moved && wasPortal) G.sel = { kind: "pin", id: from }; // a click on a power/ground symbol selects it (Del removes it from the net)
      else if (!moved) G.sel = null;
      render();
    }
    if (G.drag) { const moved = G.drag.moved; G.drag = null; if (moved) G.ctx.board.emit({ type: "change", cmd: "graph_move" }); }
    G.pan = null;
  }
  function onWheel(e) {
    e.preventDefault();
    const w = toWorld(e), k = Math.exp(e.deltaY * 0.0015);
    const nw = Math.min(8000, Math.max(160, G.view.w * k)), f = nw / G.view.w;
    G.view.x = w.x - (w.x - G.view.x) * f; G.view.y = w.y - (w.y - G.view.y) * f; G.view.w = nw; syncAspect(); render();
  }
  function onKey(e) {
    if (!G.active) return false;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || "")) return false;
    if ((e.key === "Delete" || e.key === "Backspace") && deleteSel()) { e.preventDefault(); render(); return true; }
    if (e.key === "Escape" && (G.sel || G.wireDrag)) { G.sel = null; G.wireDrag = null; G.hlNet = null; render(); return true; }
    if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) { fit(); render(); return true; }
    return false;
  }

  // ---------- setup ----------
  const AI_PROMPT = "Read the circuit with `circuit`. Wire the schematic up logically: tie ground to ground, feed every power pin from a rail that matches its voltage rating (add a regulator if needed), put a current-limiting resistor in series with every LED, and connect signal pins sensibly. Send the whole result as ONE build spec (replace:true), check the problems it reports, fix them the same way, and tell me in plain English what you connected and why.";
  function init(ctx) {
    G.ctx = ctx; G.root = ctx.root;
    const types = Object.keys(PARTS).filter((k) => elecOf({ type: k, elec: undefined, value: "", ref: "X" }).kind !== "none");
    G.root.innerHTML =
      '<div class="tr-gbar"><label class="lab" for="trgadd">Add part</label><select id="trgadd" aria-label="Add part to the schematic"><option value="">＋ choose…</option>' +
      types.map((k) => `<option value="${k}">${esc(PARTS[k].label)}</option>`).join("") + '</select>' +
      '<span class="div"></span><button class="tr-btn" id="trgauto" title="Connect ground to ground, power to matching supplies, USB D+ to D+">Auto-wire</button>' +
      '<button class="tr-btn ai" id="trgai" title="Ask Claude to wire the whole circuit">✦ Ask Claude to wire it</button>' +
      '<span class="div"></span><button class="tr-btn gold" id="trgfindbtn" title="Find real parts with price and where to buy">Find parts</button><button class="tr-btn" id="trgbombtn" title="Bill of materials and total cost">BOM</button>' +
      '<span class="div"></span><button class="tr-btn" id="trglay">Auto layout</button><button class="tr-btn" id="trgfit">Fit (F)</button>' +
      '<span class="sp"></span><span class="tr-ghint">drag a pin onto another pin to wire · click a wire or a ground/power symbol, then Del · drag a part to move it</span></div>' +
      '<div class="tr-gbody"><div class="tr-gfind" id="trgfind" hidden></div>' + `<svg id="trgsvg" xmlns="${NS}" preserveAspectRatio="none" role="img" aria-label="Schematic"></svg>` +
      '<div class="tr-gissues" role="status" aria-live="polite"></div></div>' +
      '<div class="tr-gempty" hidden><b>The schematic is empty</b><span>Ask Claude to design a circuit, add a part from the Library, or load the Sample.</span></div>' +
      '<div class="tr-gtoast" hidden role="status"></div>';
    G.svg = G.root.querySelector("#trgsvg");
    const s = G.svg;
    s.addEventListener("pointerdown", onDown); s.addEventListener("pointermove", onMove); s.addEventListener("pointerup", onUp);
    s.addEventListener("pointercancel", onUp); s.addEventListener("wheel", onWheel, { passive: false });
    s.addEventListener("contextmenu", (e) => e.preventDefault());
    G.root.addEventListener("click", (e) => {
      const t = e.target;
      const issue = t.closest("[data-gissue]");
      if (issue) { focusIssue(issue.dataset.gissue); return; }
      if (t.closest("#trgauto")) {
        const r = exec("auto_wire", {});
        if (r) { toast(r.connected.length ? `Connected ${r.connected.length} wire${r.connected.length > 1 ? "s" : ""}` + (r.needs_a_human_or_claude.length ? ` · ${r.needs_a_human_or_claude.length} need a decision` : "") : "Nothing new to connect automatically", !r.connected.length); G.ctx.put("t", "⌁ auto-wire: " + (r.connected.join("; ") || "nothing to do")); }
      } else if (t.closest("#trgai")) { G.ctx.ask(AI_PROMPT); toast("Asked Claude to wire the circuit — watch the schematic"); }
      else if (t.closest("#trgfindbtn")) window.TraceFinderUI.toggle("find");
      else if (t.closest("#trgbombtn")) window.TraceFinderUI.toggle("bom");
      else if (t.closest("#trglay")) { autoLayout(true); fit(); render(); }
      else if (t.closest("#trgfit")) { fit(); render(); }
    });
    new ResizeObserver(() => { if (!G.active) return; if (!G.fitted && fit()) G.fitted = true; syncAspect(); render(); }).observe(G.svg); // first time it has a size (or the window changes)
    window.TraceFinderUI.init({ board: ctx.board, root: G.root.querySelector("#trgfind"), toast, getSafe: ctx.getSafe });
    G.root.querySelector("#trgadd").addEventListener("change", (e) => { if (e.target.value) addPart(e.target.value); e.target.value = ""; });
  }
  function show() { G.active = true; G.root.hidden = false; const go = (tries) => { if (!G.active) return; if (!G.fitted || !G.nodes.length) { if (fit()) G.fitted = true; else if (tries < 40) { requestAnimationFrame(() => go(tries + 1)); return; } } else syncAspect(); render(); }; requestAnimationFrame(() => go(0)); }
  function hide() { G.active = false; G.root.hidden = true; }

  window.TraceGraph = { init, show, hide, render, fit, onKey, addPart, focusPart, toast, autoLayout: () => { autoLayout(true); render(); }, get active() { return G.active; }, _G: G };
})();
