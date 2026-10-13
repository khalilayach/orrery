// TRACE PCB rules + board shape.
//   • wire classes: named sets of trace width / clearance / via size, assigned to nets (Default, Power, …)
//     — new traces take their net's class automatically, DRC enforces the class clearance
//   • board outline: rounded corners; cutouts (round or rectangular holes and slots) you can add, move and resize
// Engine commands (so Claude and the CLI get them too) + the Rules tab UI. Exposes window.TraceRules.
(function (root) {
  "use strict";
  const T = root.TraceEngine, B = T.Board.prototype, { RULES } = T;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "class";

  // ---------- engine: classes ----------
  B.rulesState = function () {
    if (!this.s.rules) this.s.rules = { classes: [{ id: "default", name: "Default", width: 0.25, clearance: RULES.minGap, via_d: 0.8, via_drill: 0.4 }, { id: "power", name: "Power", width: 0.5, clearance: 0.2, via_d: 1.0, via_drill: 0.5 }], assign: {} };
    return this.s.rules;
  };
  B.classOf = function (net) {
    const R = this.rulesState(), id = R.assign[net] || "default";
    return R.classes.find((c) => c.id === id) || R.classes[0];
  };
  B.widthFor = function (net) { return this.classOf(net).width; };
  B.gapNeed = function (netA, netB) { return Math.max(RULES.minGap, this.classOf(netA).clearance, this.classOf(netB).clearance); };
  const findClass = (b, ref) => { const k = slug(ref), R = b.rulesState(); return R.classes.find((c) => c.id === k || slug(c.name) === k); };

  B.cmd_rule_class = function (a) {
    this.need(a, "name");
    const R = this.rulesState(), id = slug(a.name);
    let c = R.classes.find((x) => x.id === id);
    const num = (v, lo, hi, what) => { const n = Number(v); if (!(n >= lo && n <= hi)) throw new Error(`${what} must be ${lo}–${hi} mm`); return r3(n); };
    const next = { width: a.width !== undefined ? num(a.width, RULES.minTrace, 10, "width") : c ? c.width : 0.25, clearance: a.clearance !== undefined ? num(a.clearance, RULES.minGap, 5, "clearance") : c ? c.clearance : RULES.minGap,
      via_d: a.via_d !== undefined ? num(a.via_d, 0.3, 5, "via_d") : c ? c.via_d : 0.8, via_drill: a.via_drill !== undefined ? num(a.via_drill, 0.2, 4, "via_drill") : c ? c.via_drill : 0.4 };
    if (next.via_drill >= next.via_d) throw new Error("via_drill must be smaller than via_d");
    if (c) Object.assign(c, next, { name: String(a.name).slice(0, 30) }); else { c = Object.assign({ id, name: String(a.name).slice(0, 30) }, next); R.classes.push(c); }
    return { class: c, note: "new traces on nets assigned to this class use its width; DRC enforces its clearance" };
  };
  B.cmd_rule_class_delete = function (a) {
    this.need(a, "name");
    const R = this.rulesState(), c = findClass(this, a.name);
    if (!c) throw new Error(`no class "${a.name}"`);
    if (c.id === "default") throw new Error("the Default class cannot be deleted");
    R.classes = R.classes.filter((x) => x !== c);
    for (const n of Object.keys(R.assign)) if (R.assign[n] === c.id) delete R.assign[n];
    return { deleted: c.name };
  };
  B.cmd_rule_assign = function (a) {
    this.need(a, "net", "class");
    const R = this.rulesState(), c = findClass(this, a.class);
    if (!c) throw new Error(`no class "${a.class}" (have: ${R.classes.map((x) => x.name).join(", ")})`);
    const nets = String(a.net).split(",").map((x) => x.trim()).filter(Boolean), known = new Set(this.nets().map((n) => n.name)), bad = nets.filter((n) => !known.has(n));
    if (bad.length) throw new Error(`unknown net(s): ${bad.join(", ")} (nets: ${[...known].join(", ") || "none yet"})`);
    for (const n of nets) { if (c.id === "default") delete R.assign[n]; else R.assign[n] = c.id; }
    return { class: c.name, nets, note: "run apply_rules to re-width traces that already exist" };
  };
  B.cmd_apply_rules = function () {
    let n = 0;
    for (const t of this.s.traces) { const w = this.widthFor(t.net); if (Math.abs(t.width - w) > 1e-9) { t.width = w; n++; } }
    return { retraced: n };
  };
  // a new trace takes the width of its net's class unless width= is given
  const routeOrig = B.cmd_route;
  B.cmd_route = function (a, source) {
    const res = routeOrig.call(this, a, source);
    if (a.width === undefined) { const t = this.s.traces.find((x) => x.id === res.id), w = this.widthFor(res.net); if (t && w !== t.width) { t.width = w; res.width = w; res.length = this.traceLength(t); } res.class = this.classOf(res.net).name; }
    return res;
  };
  const viaOrig = B.cmd_add_via;
  B.cmd_add_via = function (a, source) {
    if (a.net && a.d === undefined && a.drill === undefined) { const c = this.classOf(a.net); a = Object.assign({}, a, { d: c.via_d, drill: c.via_drill }); }
    return viaOrig.call(this, a, source);
  };

  // ---------- engine: board outline + cutouts ----------
  B.cmd_set_outline = function (a) {
    const r = Number(a.radius === undefined ? 0 : a.radius), { w, h } = this.s.board;
    if (!(r >= 0 && r <= Math.min(w, h) / 2)) throw new Error(`corner radius must be 0–${r3(Math.min(w, h) / 2)} mm for a ${w}×${h} board`);
    this.s.outline = { radius: r3(r) };
    return { corner_radius: this.s.outline.radius };
  };
  B.cmd_add_cutout = function (a) {
    const shape = String(a.shape || "circle").toLowerCase(), { w, h } = this.s.board;
    if (!/^(circle|rect|slot)$/.test(shape)) throw new Error('shape must be circle, rect or slot');
    const x = a.x !== undefined ? Number(a.x) : w / 2, y = a.y !== undefined ? Number(a.y) : h / 2;
    const c = { id: this.nextId("cut"), shape, x: r3(x), y: r3(y) };
    if (shape === "circle") { c.d = r3(a.d !== undefined ? Number(a.d) : 3.2); if (!(c.d >= 0.5 && c.d <= Math.min(w, h))) throw new Error("diameter must be 0.5 mm up to the board size"); }
    else { c.w = r3(a.w !== undefined ? Number(a.w) : 10); c.h = r3(a.h !== undefined ? Number(a.h) : shape === "slot" ? 2 : 6); if (!(c.w >= 0.5 && c.h >= 0.5)) throw new Error("width and height must be at least 0.5 mm"); }
    if (c.x < 0 || c.y < 0 || c.x > w || c.y > h) throw new Error(`the cutout centre ${c.x}:${c.y} is off the ${w}×${h} board`);
    (this.s.cutouts = this.s.cutouts || []).push(c);
    return Object.assign({ note: "cut out of the board; DRC keeps copper " + RULES.edge + " mm away from its edge" }, c);
  };
  B.cmd_set_cutout = function (a) {
    this.need(a, "id");
    const c = (this.s.cutouts || []).find((x) => x.id === a.id);
    if (!c) throw new Error(`no cutout ${a.id}`);
    for (const k of ["x", "y", "d", "w", "h"]) if (a[k] !== undefined) { const n = Number(a[k]); if (!(n >= 0)) throw new Error(`${k} must be a number ≥ 0`); if (k in c) c[k] = r3(n); }
    return c;
  };
  // remove id=cut… works like every other object
  const removeOrig = B.cmd_remove;
  B.cmd_remove = function (a, source) {
    if (a.id && String(a.id).startsWith("cut")) {
      const i = (this.s.cutouts || []).findIndex((c) => c.id === a.id);
      if (i < 0) throw new Error(`nothing with id ${a.id}`);
      this.s.cutouts.splice(i, 1); return { removed: a.id };
    }
    return removeOrig.call(this, a, source);
  };
  // DRC: class clearance + copper too close to a cutout
  const drcOrig = B.cmd_drc;
  B.cmd_drc = function () {
    const res = drcOrig.call(this), G = T.geom;
    for (const t of this.s.traces) { const c = this.classOf(t.net); if (t.width < c.width - 1e-9) res.warnings.push({ rule: "class_width", msg: `trace ${t.id} (${t.net}) is ${t.width} mm but its class "${c.name}" asks for ${c.width} mm`, x: t.pts[0][0], y: t.pts[0][1] }); }
    // classes with bigger clearance than the global minimum
    const items = [];
    for (const p of this.s.parts) for (const q of this.pads(p)) items.push({ shape: q.shape === "circle" ? { t: "circ", x: q.x, y: q.y, r: q.w / 2 } : { t: "rect", x0: q.x - q.w / 2, y0: q.y - q.h / 2, x1: q.x + q.w / 2, y1: q.y + q.h / 2 }, net: q.net, layers: q.thru ? ["F.Cu", "B.Cu"] : ["F.Cu"], label: q.ref, grp: q.ref });
    for (const t of this.s.traces) for (let i = 1; i < t.pts.length; i++) items.push({ shape: { t: "seg", a: { x: t.pts[i - 1][0], y: t.pts[i - 1][1] }, b: { x: t.pts[i][0], y: t.pts[i][1] }, r: t.width / 2 }, net: t.net, layers: [t.layer], label: "trace " + t.id + " (" + t.net + ")", grp: t.id });
    const seen = new Set(res.errors.filter((e) => e.rule === "clearance").map((e) => e.msg));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], C = items[j];
      if (A.grp === C.grp || (A.net && A.net === C.net) || !A.layers.some((l) => C.layers.includes(l))) continue;
      const need = this.gapNeed(A.net, C.net);
      if (need <= RULES.minGap + 1e-9) continue;
      const g = G.gap(A.shape, C.shape);
      if (g.d >= RULES.minGap - 1e-9 && g.d < need - 1e-9) {
        const msg = `gap ${Math.max(0, g.d).toFixed(2)} mm < ${need} mm (net class) between ${A.label} and ${C.label}`;
        if (!seen.has(msg)) { seen.add(msg); res.errors.push({ rule: "class_clearance", msg, x: g.x, y: g.y }); }
      }
    }
    for (const cut of this.s.cutouts || []) {
      const shape = cut.shape === "circle" ? { t: "circ", x: cut.x, y: cut.y, r: cut.d / 2 } : { t: "rect", x0: cut.x - cut.w / 2, y0: cut.y - cut.h / 2, x1: cut.x + cut.w / 2, y1: cut.y + cut.h / 2 };
      const flagged = new Set();
      for (const it of items) {
        if (flagged.has(it.grp)) continue;
        const g = G.gap(it.shape, shape);
        if (g.d < RULES.edge - 1e-9) { flagged.add(it.grp); res.errors.push({ rule: "cutout", msg: `${it.label} is closer than ${RULES.edge} mm to cutout ${cut.id}`, x: g.x, y: g.y }); }
      }
      for (const p of this.s.parts) {
        const c = this.courtyard ? this.courtyard(p) : null;
        if (c && c.x0 < cut.x + (cut.w || cut.d) / 2 && c.x1 > cut.x - (cut.w || cut.d) / 2 && c.y0 < cut.y + (cut.h || cut.d) / 2 && c.y1 > cut.y - (cut.h || cut.d) / 2 && !flagged.has(p.ref) && !/^H/.test(p.ref))
          res.errors.push({ rule: "cutout_part", msg: `${p.ref} sits over cutout ${cut.id}`, x: p.x, y: p.y, refs: [p.ref] });
      }
    }
    res.ok = !res.errors.length && !res.warnings.length;
    return res;
  };
  // build{} can carry the board shape and wire classes too, so one validated call sets up the whole board
  B.buildExtras = function (spec, trial) {
    if (spec.outline) trial("outline", () => this.cmd_set_outline(spec.outline));
    for (const [i, c] of (spec.cutouts || []).entries()) trial("cutouts[" + i + "]", () => this.cmd_add_cutout(c));
    if (spec.rules) {
      for (const c of spec.rules.classes || []) trial("rule class " + (c.name || "?"), () => this.cmd_rule_class(c));
      for (const [net, cls] of Object.entries(spec.rules.assign || {})) trial("rule for net " + net, () => this.cmd_rule_assign({ net, class: cls }));
    }
  };
  const U = T.USAGE, M = T.MUTATING;
  U.rule_class = "rule_class name=<Power> [width=0.5] [clearance=0.2] [via_d=1.0] [via_drill=0.5]  — create/update a wire class (trace width, clearance, via size)";
  U.rule_class_delete = "rule_class_delete name=<Power>";
  U.rule_assign = "rule_assign net=<VBUS,+3V3> class=<Power>  — new traces on these nets use that class; DRC enforces its clearance";
  U.apply_rules = "apply_rules  — re-width every existing trace to its net's class";
  U.set_outline = "set_outline radius=<mm>  — rounded board corners";
  U.add_cutout = "add_cutout shape=circle|rect|slot [x= y=] [d= | w= h=]  — cut a hole or slot out of the board (x:y is the centre)";
  U.set_cutout = "set_cutout id=<cut1> [x= y= d= w= h=]  — move or resize a cutout";
  for (const c of ["rule_class", "rule_class_delete", "rule_assign", "apply_rules", "set_outline", "add_cutout", "set_cutout"]) M.add(c);

  // ---------- the Rules tab ----------
  const R = { ctx: null, root: null, sel: null };
  function render() {
    if (!R.root) return;
    const b = R.ctx.board, st = b.rulesState(), nets = b.nets();
    let h = '<div class="tr-lnote">A <b>wire class</b> is a named set of trace width, clearance and via size. Give your power nets the Power class and new traces on them come out wide automatically.</div>';
    h += st.classes.map((c) => {
      const used = Object.keys(st.assign).filter((n) => st.assign[n] === c.id);
      return `<div class="tr-rcls" data-cls="${esc(c.id)}"><div class="hd"><input data-rname value="${esc(c.name)}" aria-label="Class name" ${c.id === "default" ? "readonly" : ""}>${c.id === "default" ? '<span class="tag">default</span>' : `<button class="tr-x" data-rdel="${esc(c.id)}" aria-label="Delete class ${esc(c.name)}">×</button>`}</div>` +
        `<div class="kv"><div><label>WIDTH mm</label><input data-rk="width" type="number" step="0.05" min="${RULES.minTrace}" value="${c.width}"></div><div><label>CLEARANCE mm</label><input data-rk="clearance" type="number" step="0.05" min="${RULES.minGap}" value="${c.clearance}"></div>` +
        `<div><label>VIA ⌀ mm</label><input data-rk="via_d" type="number" step="0.1" value="${c.via_d}"></div><div><label>VIA DRILL</label><input data-rk="via_drill" type="number" step="0.05" value="${c.via_drill}"></div></div>` +
        `<div class="nets">${used.length ? used.map((n) => `<span class="chip">${esc(n)}</span>`).join("") : c.id === "default" ? '<span class="dim">every net without a class</span>' : '<span class="dim">no nets yet</span>'}</div></div>`;
    }).join("");
    h += '<button class="tr-btn" id="trraddcls">＋ Add class</button>';
    h += '<div class="tr-h" style="margin-top:14px">ASSIGN NETS</div>' + (nets.length ? nets.map((n) => `<div class="tr-rnet"><span class="mono">${esc(n.name)}</span><select data-rassign="${esc(n.name)}" aria-label="Class for ${esc(n.name)}">${st.classes.map((c) => `<option value="${esc(c.id)}"${(st.assign[n.name] || "default") === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>`).join("") : '<div class="tr-lnote">No nets yet — wire something in the Schematic.</div>');
    h += '<button class="tr-btn gold" id="trrapply" style="margin-top:10px;width:100%">Apply classes to existing traces</button>';
    h += '<div class="tr-h" style="margin-top:14px">BOARD SHAPE</div><div class="tr-rshape"><div><label>CORNER RADIUS mm</label><input id="trrrad" type="number" min="0" step="0.5" value="' + ((b.s.outline && b.s.outline.radius) || 0) + '"></div></div>' +
      '<div class="tr-rcut"><button class="tr-btn" data-addcut="circle">＋ Round hole</button><button class="tr-btn" data-addcut="rect">＋ Rectangle</button><button class="tr-btn" data-addcut="slot">＋ Slot</button></div>' +
      ((b.s.cutouts || []).length ? '<div class="tr-lnote">Drag a cutout on the PCB to move it; select it to change its size.</div>' : "");
    R.root.innerHTML = h;
  }
  function init(ctx) {
    R.ctx = ctx; R.root = ctx.root;
    const run = (cmd, args) => { try { return ctx.board.exec(cmd, args, "user"); } catch (e) { ctx.toast(e.message); return null; } };
    R.root.addEventListener("change", (e) => {
      const t = e.target, card = t.closest("[data-cls]");
      if (t.dataset.rk && card) { const c = ctx.board.rulesState().classes.find((x) => x.id === card.dataset.cls); if (c) { run("rule_class", { name: c.name, [t.dataset.rk]: Number(t.value) }); } render(); return; }
      if (t.dataset.rname !== undefined && card) { const c = ctx.board.rulesState().classes.find((x) => x.id === card.dataset.cls); if (c && t.value.trim()) { c.name = t.value.trim().slice(0, 30); ctx.board.emit({ type: "change", cmd: "rule_class" }); } return; }
      if (t.dataset.rassign) { run("rule_assign", { net: t.dataset.rassign, class: t.value }); render(); return; }
      if (t.id === "trrrad") { run("set_outline", { radius: Number(t.value) }); render(); }
    });
    R.root.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("#trraddcls")) { let n = 1; const names = new Set(ctx.board.rulesState().classes.map((c) => c.name)); while (names.has("Class " + n)) n++; run("rule_class", { name: "Class " + n, width: 0.3 }); render(); return; }
      const del = t.closest("[data-rdel]"); if (del) { run("rule_class_delete", { name: del.dataset.rdel }); render(); return; }
      if (t.closest("#trrapply")) { const r = run("apply_rules", {}); if (r) ctx.toast(r.retraced ? `Re-widthed ${r.retraced} trace${r.retraced > 1 ? "s" : ""}` : "Every trace already matches its class"); return; }
      const add = t.closest("[data-addcut]"); if (add) { const r = run("add_cutout", { shape: add.dataset.addcut }); if (r) ctx.selectCut(r.id); }
    });
    R.root.addEventListener("keydown", (e) => e.stopPropagation());
  }
  root.TraceRules = { init, render, select: (id) => R.ctx && R.ctx.selectCut(id) };
})(typeof window !== "undefined" ? window : globalThis);
