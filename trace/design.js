// TRACE design layer — what makes the AI fast and safe.
//   • courtyards + part-overlap DRC        (parts can no longer sit inside other parts)
//   • free_spot / place auto=1 / move guard (collision-aware placement for Claude)
//   • build   — one atomic, validated "whole design" command: parts + nets, nothing half-done
//   • circuit — a compact text digest of the whole circuit, so the AI reads it in one call
// Loaded after engine.js and electrical.js. Adds methods to Board.prototype.
(function (root) {
  "use strict";
  const T = root.TraceEngine, B = T.Board.prototype, { defOf, PARTS, RULES } = T;
  const r2 = (n) => Math.round(n * 100) / 100;
  const COURT = 0.25; // extra clearance around every part body (mm)

  // ---------- courtyards ----------
  /** bounding box of a part's body + pads (+ margin). `at` lets us test a hypothetical position. */
  B.courtyard = function (part, at) {
    const d = defOf(part.type), p = at ? Object.assign({}, part, at) : part, swap = p.rot % 180 !== 0;
    const bw = swap ? d.body[1] : d.body[0], bh = swap ? d.body[0] : d.body[1];
    let x0 = p.x - bw / 2, x1 = p.x + bw / 2, y0 = p.y - bh / 2, y1 = p.y + bh / 2;
    for (const q of this.pads(p)) { x0 = Math.min(x0, q.x - q.w / 2); x1 = Math.max(x1, q.x + q.w / 2); y0 = Math.min(y0, q.y - q.h / 2); y1 = Math.max(y1, q.y + q.h / 2); }
    return { x0: x0 - COURT, y0: y0 - COURT, x1: x1 + COURT, y1: y1 + COURT };
  };
  const hit = (a, b, m) => a.x0 < b.x1 + (m || 0) - 1e-9 && a.x1 > b.x0 - (m || 0) + 1e-9 && a.y0 < b.y1 + (m || 0) - 1e-9 && a.y1 > b.y0 - (m || 0) + 1e-9;
  const inside = (c, w, h) => c.x0 >= RULES.edge && c.y0 >= RULES.edge && c.x1 <= w - RULES.edge && c.y1 <= h - RULES.edge;
  /** what is in the way at this place (empty list = free) */
  B.blockers = function (part, at, ignoreRef) {
    const c = this.courtyard(part, at), { w, h } = this.s.board, out = [];
    if (!inside(c, w, h)) out.push("the board edge");
    for (const o of this.s.parts) if (o.ref !== ignoreRef && o.ref !== part.ref && hit(c, this.courtyard(o))) out.push(o.ref);
    return out;
  };
  /** nearest free spot for a part: spirals out from `near`, leaving a little routing room between parts */
  B.findSpot = function (type, rot, near, ignoreRef) {
    const { w, h } = this.s.board, probe = { ref: "?", type, x: 0, y: 0, rot: rot || 0, nets: {} };
    const n0 = near || { x: w / 2, y: h / 2 };
    const free = (x, y) => {
      const c = this.courtyard(probe, { x, y }), pad = { x0: c.x0 - 0.5, y0: c.y0 - 0.5, x1: c.x1 + 0.5, y1: c.y1 + 0.5 };
      if (!inside(c, w, h)) return false;
      return !this.s.parts.some((o) => o.ref !== ignoreRef && hit(pad, this.courtyard(o)));
    };
    for (let r = 0; r <= Math.max(w, h); r += 1) {
      const pts = [];
      if (r === 0) pts.push([0, 0]);
      else for (let i = -r; i <= r; i++) pts.push([i, -r], [i, r], [-r, i], [r, i]);
      pts.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
      for (const [dx, dy] of pts) {
        const x = Math.round((n0.x + dx) * 2) / 2, y = Math.round((n0.y + dy) * 2) / 2;
        if (free(x, y)) return { x, y };
      }
    }
    return null;
  };
  B.cmd_free_spot = function (a) {
    this.need(a, "type");
    if (!PARTS[String(a.type).toLowerCase()]) throw new Error(`unknown part type "${a.type}"`);
    const near = a.near ? this.resolve(a.near) : undefined, s = this.findSpot(String(a.type).toLowerCase(), a.rot || 0, near);
    if (!s) throw new Error("the board is full — make it bigger (set_board) or remove something");
    return s;
  };
  T.USAGE.free_spot = "free_spot type=<mcu> [near=x:y|U1] [rot=0]  — nearest position where that part fits without touching anything";

  // placement guard: Claude (source \"claude\") may never put a part on top of another one
  const placeOrig = B.cmd_place, moveOrig = B.cmd_move;
  B.cmd_place = function (a, source) {
    const type = String(a.type || "").toLowerCase();
    if (a.auto && PARTS[type]) {
      const near = a.near ? this.resolve(a.near) : a.x !== undefined && a.y !== undefined ? { x: Number(a.x), y: Number(a.y) } : undefined;
      const s = this.findSpot(type, a.rot || 0, near);
      if (!s) throw new Error("the board is full — make it bigger (set_board) or remove something");
      a = Object.assign({}, a, { x: s.x, y: s.y });
    }
    if ((source === "claude" || a.check) && PARTS[type] && a.x !== undefined && a.y !== undefined) {
      const bl = this.blockers({ ref: "?", type, rot: this.snapRot(a.rot || 0), nets: {} }, { x: Number(a.x), y: Number(a.y) });
      if (bl.length) {
        const s = this.findSpot(type, a.rot || 0, { x: Number(a.x), y: Number(a.y) });
        throw new Error(`cannot place ${type} at ${a.x}:${a.y} — it would overlap ${bl.join(", ")}.` + (s ? ` Nearest free spot: x=${s.x} y=${s.y} (or pass auto=1 and let TRACE choose).` : ""));
      }
    }
    return placeOrig.call(this, a, source);
  };
  B.cmd_move = function (a, source) {
    if (source === "claude" && a.ref && a.x !== undefined && a.y !== undefined) {
      const p = this.findPart(a.ref);
      if (p) {
        const bl = this.blockers(p, { x: Number(a.x), y: Number(a.y) }, p.ref);
        if (bl.length) { const s = this.findSpot(p.type, p.rot, { x: Number(a.x), y: Number(a.y) }, p.ref); throw new Error(`cannot move ${p.ref} to ${a.x}:${a.y} — it would overlap ${bl.join(", ")}.` + (s ? ` Nearest free spot: x=${s.x} y=${s.y}.` : "")); }
      }
    }
    return moveOrig.call(this, a, source);
  };
  T.USAGE.place = T.USAGE.place.replace("— ", "— add auto=1 (instead of x/y) to let TRACE pick a free spot; Claude's placements that overlap another part are rejected with the nearest free spot. ");

  // ---------- DRC: parts on top of parts ----------
  const drcOrig = B.cmd_drc;
  B.cmd_drc = function () {
    const res = drcOrig.call(this), ps = this.s.parts, cs = ps.map((p) => this.courtyard(p));
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const A = cs[i], C = cs[j];
      const dx = Math.min(A.x1, C.x1) - Math.max(A.x0, C.x0), dy = Math.min(A.y1, C.y1) - Math.max(A.y0, C.y0);
      if (dx > 0.05 && dy > 0.05)
        res.errors.push({ rule: "part_overlap", msg: `${ps[i].ref} and ${ps[j].ref} overlap by ${r2(Math.min(dx, dy))} mm — parts are on top of each other`, x: Math.max(A.x0, C.x0) + dx / 2, y: Math.max(A.y0, C.y0) + dy / 2, refs: [ps[i].ref, ps[j].ref] });
    }
    res.ok = !res.errors.length && !res.warnings.length;
    return res;
  };

  // ---------- circuit digest ----------
  const volts = (v) => (v === undefined || v === null ? "" : r2(v) + "V");
  const amps = (a) => (Math.abs(a) >= 1 ? r2(a) + "A" : r2(a * 1000) + "mA");
  function digest(b) {
    const S = b.s, A = T.analyze(b), drc = b.cmd_drc(), links = S.links || [];
    const L = [];
    const unrouted = (A.unrouted_links || []).length;
    L.push(`BOARD ${S.board.w}x${S.board.h}mm · ${S.parts.length} parts · ${links.length} wires (${unrouted} not routed) · ${S.traces.length} traces · SAFETY ${A.level.toUpperCase()}${A.counts.danger ? " (" + A.counts.danger + " danger)" : ""}${A.counts.warning ? " (" + A.counts.warning + " warn)" : ""} · DRC ${drc.errors.length} errors`);
    // parts, with only their connected pins
    L.push("PARTS  (ref type value [ratings] @x,y  pin→net …)");
    for (const p of S.parts) {
      const e = T.elecOf(p), d = defOf(p.type);
      if (e.kind === "none") { L.push(` ${p.ref} ${d.label} @${p.x},${p.y}`); continue; }
      const rate = [e.vout !== undefined && "out " + volts(e.vout), e.vin_max && "in≤" + volts(e.vin_max), e.vdd_min !== undefined && e.vdd_max !== undefined && "vdd " + volts(e.vdd_min) + "–" + volts(e.vdd_max), e.vmax && "≤" + volts(e.vmax), e.imax && "≤" + amps(e.imax), e.pmax && "≤" + amps(e.pmax).replace("A", "W").replace("mA", "mW"), e.vf && "vf " + volts(e.vf)].filter(Boolean).join(" ");
      const pins = b.pads(p).filter((q) => q.net).map((q) => `${q.fn && q.fn !== q.n ? q.fn : q.n}→${q.net}`).join(" ");
      const idle = b.pads(p).filter((q) => !q.net).length;
      L.push(` ${p.ref} ${d.label} "${p.value}" [${e.kind}${rate ? " " + rate : ""}] @${p.x},${p.y}  ${pins || "(unconnected)"}${idle && pins ? `  (+${idle} pins unused)` : ""}${p.buy ? `  ✓${p.buy.id || p.buy.mpn}${p.buy.price != null ? " $" + p.buy.price : ""}` : ""}${p.note ? `  — ${p.note}` : ""}`);
    }
    const blocks = new Map();
    for (const p of S.parts) if (p.block) { if (!blocks.has(p.block)) blocks.set(p.block, []); blocks.get(p.block).push(p.ref); }
    if (blocks.size) L.push("BLOCKS  " + [...blocks].map(([k, v]) => k + ": " + v.join(",")).join(" · "));
    // nets, with the voltage/current the solver found
    L.push("NETS  (name volts current: pads)");
    const byNet = new Map();
    for (const q of b.allPads()) if (q.net) { if (!byNet.has(q.net)) byNet.set(q.net, []); byNet.get(q.net).push(q.ref); }
    const rail = new Map(A.rails.map((r) => [r.net, r]));
    for (const [n, pads] of byNet) { const r = rail.get(n) || [...rail.values()].find((x) => x.net.split(" + ").includes(n)); L.push(` ${n}${r && r.volts ? " " + volts(r.volts) : ""}${r && r.amps ? " " + amps(r.amps) : ""}: ${pads.join(" ")}`); }
    // power tree
    const srcs = A.supplies || [];
    if (srcs.length) L.push("POWER  " + srcs.map((s) => `${s.ref} ${volts(s.volts)} (${amps(s.amps)} of ${amps(s.limit)})`).join(" ; ") + (S.parts.filter((p) => T.elecOf(p).kind === "regulator").map((p) => ` → ${p.ref} ${volts(T.elecOf(p).vout)}`).join("")));
    // issues + to-do
    const real = A.issues.filter((i) => i.level !== "info");
    L.push(real.length ? "PROBLEMS" : "PROBLEMS none");
    for (const i of real) L.push(` ${i.level === "danger" ? "DANGER" : "warn"} ${i.code}: ${i.msg}${i.fix ? "  → " + i.fix : ""}`);
    for (const e of drc.errors) L.push(` DRC ${e.rule}: ${e.msg}`);
    const rev = (b.review ? b.review(A, drc) : []).filter((f) => f.level !== "info" && f.code !== "drc");
    if (rev.length) { L.push("REVIEW  " + rev.length + " thing" + (rev.length > 1 ? "s" : "") + " an engineer would fix:"); for (const f of rev.slice(0, 8)) L.push(" " + (f.level === "danger" ? "DANGER" : "warn") + " " + f.code + ": " + f.msg + "  → " + f.fix.split(". ")[0]); if (rev.length > 8) L.push(" … " + (rev.length - 8) + " more (run review)"); }
    const todo = [];
    const nosrc = S.parts.filter((p) => !p.buy && !/^H/.test(p.ref)).map((p) => p.ref);
    if (nosrc.length) todo.push("source real parts for " + nosrc.join(","));
    if (unrouted) todo.push(`route copper for ${unrouted} wires`);
    for (const p of S.parts) {
      const e = T.elecOf(p);
      if (e.kind === "ic" || e.kind === "regulator") {
        const pin = b.pads(p).find((q) => q.role === "power_in" && q.net);
        if (pin && !S.parts.some((c) => T.elecOf(c).kind === "capacitor" && b.pads(c).some((q) => q.net === pin.net))) todo.push(`${p.ref} has no decoupling capacitor on ${pin.net}`);
      }
      if (e.kind === "led" && !real.some((i) => i.code === "led_overcurrent") && !b.pads(p).some((q) => q.net)) todo.push(`${p.ref} is not wired`);
    }
    for (const i of A.issues) if (i.level === "info" && i.code === "unconnected_part") todo.push(i.msg.replace(/ isn't connected to anything yet\./, " is not wired"));
    L.push(todo.length ? "TODO  " + todo.join(" · ") : "TODO nothing — ready for review");
    return { text: L.join("\n"), safety: A.level, danger: A.counts.danger, warnings: A.counts.warning, drc_errors: drc.errors.length, unrouted, todo };
  }
  B.cmd_circuit = function () { return digest(this); };
  T.USAGE.circuit = "circuit  — THE way to read the board: one compact text digest of parts (with ratings + connected pins), nets (volts/current), power tree, problems and to-do. Use this instead of `board`.";
  T.digest = digest;

  // take ONE pin off its net without breaking the rest of the net (schematic: delete a power/ground portal)
  B.cmd_unplug = function (a) {
    this.need(a, "pad");
    const P = this.padRefOf(a.pad), ref = P.pad.ref, ls = this.s.links || [];
    const mine = ls.filter((l) => l.a === ref || l.b === ref);
    if (!mine.length) throw new Error(`${ref} is not wired to anything`);
    const others = [...new Set(mine.map((l) => (l.a === ref ? l.b : l.a)))], net = mine[0].net;
    this.s.links = ls.filter((l) => !mine.includes(l));
    for (let i = 1; i < others.length; i++) if (!this.linked(others[0], others[i])) this.s.links.push({ id: this.nextId("l"), a: others[0], b: others[i], net });
    if (P.part.nets) delete P.part.nets[P.pad.n];
    this._forgetNets();
    return { unplugged: ref, kept_wired: others };
  };
  T.USAGE.unplug = "unplug pad=<U1.GND>  — take one pin off its net (the other pins stay connected)";
  T.MUTATING.add("unplug");

  // ---------- build: the whole design in one validated, all-or-nothing command ----------
  /* spec = { replace?, dry?, board?:{w,h}, auto_wire?,
       parts:[{ ref?, type, value?, x?, y?, rot?, block?, note?, elec?:{}, buy?:{mpn,id,pkg,price,stock,tiers,url}, create?:{id,template,pins,label,prefix} }],
       nets:{ NAME:["U1.VDD","C1.1"] }, wires:[["J1.GND","U1.GND"]] } */
  B.cmd_build = function (a, source) {
    let spec = a.spec !== undefined ? a.spec : a.json;
    if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch (e) { throw new Error("build: spec is not valid JSON — " + e.message); } }
    if (!spec || typeof spec !== "object") throw new Error("build needs spec={...} (see help build)");
    const before = JSON.stringify(this.s), errors = [], placed = [], note = (m) => errors.push(m);
    const dry = !!(spec.dry || a.dry);
    const trial = (label, fn) => { try { return fn(); } catch (e) { note(`${label}: ${e.message}`); return null; } };
    try {
      if (spec.replace) this.cmd_clear();
      if (spec.board) trial("board", () => this.cmd_set_board({ w: spec.board.w, h: spec.board.h }));
      const list = Array.isArray(spec.parts) ? spec.parts : [];
      if (!list.length && !spec.replace && !spec.nets && !spec.wires) note("spec has no parts, nets or wires");
      // blocks get their own region so related parts end up together
      const blocks = [...new Set(list.map((p) => p.block || ""))], { w, h } = this.s.board;
      const anchor = (blk) => { const i = Math.max(0, blocks.indexOf(blk || "")); return { x: Math.round(((i + 0.5) / blocks.length) * w), y: Math.round(h / 2) }; };
      list.forEach((sp, i) => {
        const tag = `parts[${i}]${sp.ref ? " " + sp.ref : ""}`;
        if (sp.create) trial(tag + " create", () => this.cmd_create_part(Object.assign({ id: sp.create.id || sp.type }, sp.create)));
        const type = String(sp.type || "").toLowerCase();
        if (!PARTS[type]) { note(`${tag}: unknown part type "${sp.type}" (known: ${Object.keys(PARTS).filter((k) => !PARTS[k].missing).join(", ")})`); return; }
        const args = { type, rot: sp.rot || 0, value: sp.value, ref: sp.ref };
        let at = sp.x !== undefined && sp.y !== undefined ? { x: Number(sp.x), y: Number(sp.y) } : null;
        const probe = { ref: sp.ref || "?", type, rot: this.snapRot(sp.rot || 0), nets: {} };
        if (at) {
          const bl = this.blockers(probe, at, null);
          if (bl.length) { const s = this.findSpot(type, sp.rot || 0, at); note(`${tag}: ${at.x}:${at.y} would overlap ${bl.join(", ")}` + (s ? ` — free spot x=${s.x} y=${s.y} (or leave x/y out)` : "")); return; }
        } else {
          at = this.findSpot(type, sp.rot || 0, anchor(sp.block));
          if (!at) { note(`${tag}: the board is full — enlarge it with board:{w,h}`); return; }
        }
        const r = trial(tag, () => placedOrigCall(this, Object.assign(args, at)));
        if (!r) return;
        placed.push({ ref: r.ref, type, value: this.findPart(r.ref).value, x: at.x, y: at.y, block: sp.block || "" });
        const part = this.findPart(r.ref);
        if (sp.note) part.note = String(sp.note).slice(0, 240);
        if (sp.block) part.block = String(sp.block).slice(0, 40); // schematic sheet / group name
        if (sp.elec) trial(tag + " elec", () => this.cmd_set_electrical(Object.assign({ ref: r.ref }, sp.elec)));
        if (sp.buy) trial(tag + " buy", () => this.cmd_source(Object.assign({ ref: r.ref }, sp.buy)));
      });
      if (spec.auto_wire) trial("auto_wire", () => this.cmd_auto_wire({}));
      const pairs = [];
      for (const [name, pads] of Object.entries(spec.nets || {})) {
        if (!Array.isArray(pads) || pads.length < 2) { note(`net ${name}: give a list of at least 2 pads`); continue; }
        for (let k = 1; k < pads.length; k++) pairs.push([pads[0], pads[k], name]);
      }
      for (const w of spec.wires || []) pairs.push([w[0], w[1], w[2]]);
      for (const [x, y, name] of pairs) {
        const ref1 = this.safeRef(x), ref2 = this.safeRef(y);
        if (ref1 && ref1 === ref2) { /* same part: allowed (e.g. tie two pins) */ }
        if (this.linked && this.linked(this.resolveOrNull(x), this.resolveOrNull(y))) continue;
        trial(`wire ${x} ↔ ${y}`, () => this.cmd_connect({ a: x, b: y, net: name }));
      }
      if (this.buildExtras) this.buildExtras(spec, trial); // board shape + wire classes (rules.js)
    } catch (e) { note("unexpected: " + e.message); }
    if (errors.length) {
      this.s = JSON.parse(before);
      throw new Error(`BUILD REJECTED — nothing was changed. Fix these ${errors.length} problem(s) and send the whole spec again:\n - ` + errors.join("\n - "));
    }
    const report = digest(this);
    const out = { ok: true, dry, placed, summary: report.text, safety: report.safety, danger: report.danger, warnings: report.warnings, drc_errors: report.drc_errors, todo: report.todo,
      next: report.danger || report.drc_errors ? "there are problems — read PROBLEMS, then send a corrected full spec with replace:true (do not patch with remove/place)" : "design is consistent — review it, then source parts and layout" };
    if (dry) { this.s = JSON.parse(before); out.note = "dry run — nothing was placed"; return out; }
    this.undoS.push(before); if (this.undoS.length > 100) this.undoS.shift(); this.redoS.length = 0;
    this.emit({ type: "change", cmd: "build", source });
    return out;
  };
  function placedOrigCall(b, args) { return placeOrig.call(b, args, "build"); }
  B.resolveOrNull = function (spec) { try { return this.resolve(spec).pad ? this.resolve(spec).pad.ref : null; } catch (_) { return null; } };
  B.safeRef = function (spec) { try { return this.resolve(spec).part.ref; } catch (_) { return null; } };
  // `linked` expects pad refs; guard null
  const linkedOrig = B.linked;
  B.linked = function (a, b) { return a && b ? linkedOrig.call(this, a, b) : false; };
  T.USAGE.build = "build spec={…} | file=plan.json (CLI)  — validate and place a WHOLE design at once, all-or-nothing. spec: {replace?, dry?, board?:{w,h}, parts:[{ref,type,value,block?,x?,y?,rot?,note?,elec?,buy?}], nets:{GND:[\"J1.GND\",\"U1.GND\"]}, wires:[[a,b]], auto_wire?, outline?:{radius}, cutouts?:[{shape,x,y,d|w,h}], rules?:{classes:[{name,width,clearance}],assign:{VBUS:\"Power\"}}}. Parts without x/y are auto-placed (grouped by block, never overlapping). Returns the circuit digest. To change a design send a new full spec with replace:true.";
  // build manages its own undo entry (so a rejected build leaves no trace), so it is not in MUTATING
})(typeof window !== "undefined" ? window : globalThis);
