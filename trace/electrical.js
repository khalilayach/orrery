// TRACE electrical safety analysis — what the geometric DRC cannot see.
//
// 1. Connectivity comes from the COPPER (pads, trace ends, vias that touch), not from net
//    labels, so broken nets, shorts and label conflicts are found for real.
// 2. A DC model of the board is solved (modified nodal analysis): ideal supplies, linear
//    regulators, resistors, LEDs (piecewise-linear), and MCU pins in both worst cases
//    (every pin driven high / every pin driven low).
// 3. From the solution it checks: part ratings, LED current, resistor power, regulator
//    dropout + heat, supply current limits, missing/mismatched power & ground, USB D+/D−
//    swaps, and trace/via current capacity (IPC-2221).
// This is a steady-state safety screen with rule-of-thumb ratings, NOT a simulator or a
// replacement for checking a real design against datasheets before building it.
(function (root) {
  "use strict";
  const T = root.TraceEngine;
  const { geom, defOf, USAGE, Board, sanitizeElec, parseRoles } = T;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const fmtA = (a) => (Math.abs(a) >= 1 ? a.toFixed(2) + " A" : (a * 1000).toFixed(a * 1000 >= 10 ? 0 : 1) + " mA");
  const fmtV = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "") + " V";
  const fmtW = (w) => (w >= 1 ? w.toFixed(2) + " W" : (w * 1000).toFixed(w * 1000 >= 10 ? 0 : 1) + " mW");

  // ---------- values: 330R, 4k7, 0R1, 4.7k, 100nF, 10uF, 1M ----------
  const MULT = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, r: 1, R: 1 };
  function parseValue(str) {
    const s = String(str == null ? "" : str).trim().replace(/Ω|ohms?/gi, "R").replace(/\s+/g, "");
    let m = s.match(/^(\d+)([pnuµmkKMGrR])(\d+)([FfHhVvAaWw]?)$/); // 4k7, 0R1, 2u2
    if (m) return Number(m[1] + "." + m[3]) * MULT[m[2]];
    m = s.match(/^(\d*\.?\d+)([pnuµmkKMGrR]?)([FfHhVvAaWw]?)$/);
    if (m) return Number(m[1]) * (m[2] ? MULT[m[2]] : 1);
    return NaN;
  }
  const LED_VF = [[/\bir\b|infrared/, 1.3], [/red/, 1.9], [/orange/, 2.0], [/yellow|amber/, 2.1], [/green/, 2.1], [/blue/, 3.0], [/white/, 3.1], [/\buv\b/, 3.3]];
  const ledVf = (value, e) => {
    if (e.vf) return e.vf;
    const v = String(value || "").toLowerCase();
    for (const [re, vf] of LED_VF) if (re.test(v)) return vf;
    return 2.0;
  };

  // ---------- trace current capacity: IPC-2221, outer layer, 1 oz copper ----------
  const COPPER_MIL = 1.378; // 35 µm
  const ampacity = (widthMm, dT = 10) => 0.048 * Math.pow(dT, 0.44) * Math.pow((widthMm / 0.0254) * COPPER_MIL, 0.725);
  const widthFor = (amps, dT = 10) => Math.pow(amps / (0.048 * Math.pow(dT, 0.44)), 1 / 0.725) / COPPER_MIL * 0.0254;
  const VIA_AMPS = 1.0; // a plated 0.3 mm drill via, conservative

  // ---------- electrical model of a part ----------
  function elecOf(part) {
    const d = defOf(part.type), pre = String(d.prefix || "X").toUpperCase();
    let base = d.elec && d.elec.kind ? d.elec : null, guessed = false;
    if (!base) {
      guessed = true;
      const txt = (d.label + " " + part.value + " " + part.type).toLowerCase();
      const kind = { R: "resistor", C: "capacitor", L: "inductor", J: "connector", H: "none", Y: "passive" }[pre]
        || (pre === "D" ? (/led/.test(txt) ? "led" : "diode") : pre === "U" ? "ic" : "passive");
      base = Object.assign({ kind }, d.elec || {});
    }
    const e = Object.assign({}, base, part.elec || {});
    if (e.roles || (part.elec && part.elec.roles) || (d.elec && d.elec.roles))
      e.roles = Object.assign({}, d.elec && d.elec.roles, part.elec && part.elec.roles);
    e.guessed = guessed && !(part.elec && part.elec.kind);
    return e;
  }

  function analyze(b) {
    const S = b.s, issues = [];
    const add = (level, code, msg, fix, loc, extra) => {
      issues.push(Object.assign({ level, code, msg, fix: fix || "", x: loc ? loc.x : null, y: loc ? loc.y : null }, extra || {}));
    };
    const parts = S.parts.map((p) => ({ p, e: elecOf(p), pads: b.pads(p) }));
    const padByRef = new Map();
    for (const q of parts) for (const pd of q.pads) padByRef.set(pd.ref, pd);

    // ---------- 1. copper connectivity ----------
    const uIdx = new Map(), uInfo = [], items = [];
    const unit = (id, info) => { if (!uIdx.has(id)) { uIdx.set(id, uInfo.length); uInfo.push(Object.assign({ id }, info)); } return uIdx.get(id); };
    for (const q of parts) for (const pd of q.pads) {
      const u = unit(pd.ref, { type: "pad", label: pd.net, x: pd.x, y: pd.y, ref: pd.ref });
      const shape = pd.shape === "circle" ? { t: "circ", x: pd.x, y: pd.y, r: pd.w / 2 }
        : { t: "rect", x0: pd.x - pd.w / 2, y0: pd.y - pd.h / 2, x1: pd.x + pd.w / 2, y1: pd.y + pd.h / 2 };
      items.push({ u, shape, layers: pd.thru ? ["F.Cu", "B.Cu"] : ["F.Cu"] });
    }
    for (const t of S.traces) {
      const u = unit(t.id, { type: "trace", label: t.net, x: t.pts[0][0], y: t.pts[0][1], trace: t });
      for (let i = 1; i < t.pts.length; i++)
        items.push({ u, layers: [t.layer], shape: { t: "seg", a: { x: t.pts[i - 1][0], y: t.pts[i - 1][1] }, b: { x: t.pts[i][0], y: t.pts[i][1] }, r: t.width / 2 } });
    }
    for (const v of S.vias) {
      const u = unit(v.id, { type: "via", label: v.net, x: v.x, y: v.y, via: v });
      items.push({ u, layers: ["F.Cu", "B.Cu"], shape: { t: "circ", x: v.x, y: v.y, r: v.d / 2 } });
    }
    for (const z of S.zones || []) {
      const u = unit(z.id, { type: "zone", label: z.net, x: S.board.w / 2, y: S.board.h / 2, zone: z });
      items.push({ u, layers: [z.layer], shape: { t: "rect", x0: 0, y0: 0, x1: S.board.w, y1: S.board.h }, zone: z.net });
    }
    for (const it of items) it.bb = geom.bbox(it.shape);
    const par = uInfo.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const adj = uInfo.map(() => new Set());
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.u === B.u || !A.layers.some((l) => B.layers.includes(l))) continue;
      if (A.zone !== undefined || B.zone !== undefined) { // a pour only touches copper that belongs to its own net (everything else is cleared away from it)
        const Z = A.zone !== undefined ? A : B, O = Z === A ? B : A;
        if (O.zone !== undefined || uInfo[O.u].label !== Z.zone) continue;
        if (geom.gap(A.shape, B.shape).d <= 0.001) { par[find(A.u)] = find(B.u); adj[A.u].add(B.u); adj[B.u].add(A.u); }
        continue;
      }
      if (A.bb[0] > B.bb[2] + 0.01 || B.bb[0] > A.bb[2] + 0.01 || A.bb[1] > B.bb[3] + 0.01 || B.bb[1] > A.bb[3] + 0.01) continue;
      if (geom.gap(A.shape, B.shape).d <= 0.001) { par[find(A.u)] = find(B.u); adj[A.u].add(B.u); adj[B.u].add(A.u); }
    }
    // logical wires drawn in the Graph view join pads even where no copper exists yet
    const copperRoot = uInfo.map((_, i) => find(i)), unrouted = [];
    for (const l of S.links || []) {
      const a = uIdx.get(l.a), b = uIdx.get(l.b);
      if (a === undefined || b === undefined) continue;
      if (copperRoot[a] !== copperRoot[b]) unrouted.push(l);
      par[find(a)] = find(b);
    }
    const nodes = new Map(); // root → node
    uInfo.forEach((u, i) => {
      const r = find(i);
      if (!nodes.has(r)) nodes.set(r, { id: r, units: [], labels: new Set(), pads: [] });
      const n = nodes.get(r);
      n.units.push(i);
      if (u.label) n.labels.add(u.label);
      if (u.type === "pad") n.pads.push(u.ref);
    });
    let anon = 0;
    for (const n of nodes.values()) {
      n.labelsArr = [...n.labels];
      n.name = n.labelsArr.length ? n.labelsArr.join(" + ") : (n.pads.length > 1 || n.units.length > 1 ? "N" + (++anon) : "");
      const first = uInfo[n.units[0]];
      n.x = first.x; n.y = first.y;
    }
    const nodeOfUnit = (id) => nodes.get(find(uIdx.get(id)));
    const nodeOfPad = (ref) => (uIdx.has(ref) ? nodeOfUnit(ref).id : null);

    // label conflicts (copper short between differently-named nets) and broken nets
    for (const n of nodes.values()) if (n.labelsArr.length > 1)
      add("danger", "net_short", `Nets ${n.labelsArr.join(" and ")} are wired together — that is a short circuit.`,
        "Remove the wire (or the copper) that joins them: look for a graph wire between the two nets, a trace crossing a pad, or overlapping traces.", n, { net: n.labelsArr[0] });
    const byLabel = new Map();
    for (const n of nodes.values()) for (const l of n.labelsArr) { if (!byLabel.has(l)) byLabel.set(l, []); byLabel.get(l).push(n); }
    for (const [label, ns] of byLabel) if (ns.length > 1) {
      const where = ns.map((n) => n.pads.slice(0, 3).join("/") || "a trace").join(" | ");
      add("danger", "net_open", `Net ${label} is broken into ${ns.length} separate pieces (${where}) — the copper does not connect all the way.`,
        "Route the missing connection (or fix a trace that stops short of its pad).", ns[1], { net: label });
    }

    // ---------- 2. sources, ground reference ----------
    const fixed = new Map(); // node id → {v, by}
    const refNodes = new Set();
    const sources = [], regs = [], ics = [], loads = [], leds = [], resistors = [], caps = [];
    const roleOf = (q, role) => q.pads.filter((pd) => pd.role === role);
    for (const q of parts) {
      const k = q.e.kind;
      if (k === "source") sources.push(q);
      else if (k === "regulator") regs.push(q);
      else if (k === "ic") ics.push(q);
      else if (k === "load") loads.push(q);
      else if (k === "led" || k === "diode") leds.push(q);
      else if (k === "resistor" || k === "inductor") resistors.push(q);
      else if (k === "capacitor") caps.push(q);
    }
    const sourceOut = [];
    for (const q of sources) {
      const outs = roleOf(q, "power_out"), gnds = roleOf(q, "ground");
      if (!outs.length || !gnds.length) { add("warning", "source_roles", `${q.p.ref} is marked as a power source but has no power_out / ground pad roles, so it is ignored.`, "Set pad roles with set_electrical roles=+:power_out/-:ground", q.p); continue; }
      for (const g of gnds) refNodes.add(nodeOfPad(g.ref));
      sourceOut.push({ q, outs, gnds });
    }
    for (const s of sourceOut) for (const o of s.outs) {
      const n = nodeOfPad(o.ref), v = s.q.e.vout || 0;
      if (refNodes.has(n)) { add("danger", "supply_short", `${s.q.p.ref}: the supply output ${o.ref} is connected straight to ground — a dead short that would destroy the supply or start a fire.`, "Remove the copper joining the power pin to ground.", o, { ref: s.q.p.ref }); continue; }
      const f = fixed.get(n);
      if (f && Math.abs(f.v - v) > 0.01) { add("danger", "supply_conflict", `Two supplies (${f.by} at ${fmtV(f.v)} and ${s.q.p.ref} at ${fmtV(v)}) are wired to the same net.`, "Never join two different supplies directly; use one source per rail.", o, { ref: s.q.p.ref }); continue; }
      fixed.set(n, { v, by: s.q.p.ref });
    }
    // linear regulators propagate a (sagging) output voltage
    const regInfo = [];
    for (const q of regs) {
      const pin = roleOf(q, "power_in")[0], pout = roleOf(q, "power_out")[0], pg = roleOf(q, "ground")[0];
      if (!pin || !pout || !pg) { add("warning", "reg_roles", `${q.p.ref} is a regulator but needs power_in / power_out / ground pad roles to be analysed.`, "set_electrical ref=" + q.p.ref + " roles=IN:power_in/OUT:power_out/GND:ground", q.p); continue; }
      regInfo.push({ q, pin, pout, pg, nIn: nodeOfPad(pin.ref), nOut: nodeOfPad(pout.ref), nG: nodeOfPad(pg.ref) });
    }
    for (let it = 0; it < 8; it++) {
      let changed = false;
      for (const r of regInfo) {
        const f = fixed.get(r.nIn);
        if (!f || !refNodes.has(r.nG)) continue;
        const vo = r.q.e.vout || 3.3, dr = r.q.e.dropout || 0.25;
        const veff = f.v >= vo + dr ? vo : Math.max(0, f.v - dr);
        r.vin = f.v; r.veff = veff;
        const cur = fixed.get(r.nOut);
        if (refNodes.has(r.nOut)) continue;
        if (!cur) { fixed.set(r.nOut, { v: veff, by: r.q.p.ref }); changed = true; }
        else if (cur.by === r.q.p.ref && Math.abs(cur.v - veff) > 1e-9) { cur.v = veff; changed = true; }
        else if (cur.by !== r.q.p.ref && Math.abs(cur.v - veff) > 0.01)
          add("danger", "supply_conflict", `${r.q.p.ref}'s output (${fmtV(veff)}) is wired to another supply at ${fmtV(cur.v)}.`, "Give each regulator its own output rail.", r.pout, { ref: r.q.p.ref });
      }
      if (!changed) break;
    }
    if (!sourceOut.length && parts.length)
      add("info", "no_source", "There is no power source on the board (add a USB-C connector or battery), so voltages and currents can't be checked yet.", "", null);

    // ---------- 3. circuit elements ----------
    const els = [];
    for (const q of resistors) {
      const two = q.pads.slice(0, 2);
      if (two.length < 2) continue;
      let r;
      if (q.e.kind === "inductor") r = q.e.dcr || 0.1;
      else { r = q.e.r || parseValue(q.p.value); if (!(r >= 0)) { add("warning", "bad_value", `${q.p.ref}: can't read the value "${q.p.value}" as ohms (try 330R, 4k7, 10k).`, "Set the value, e.g. set_value ref=" + q.p.ref + " value=330R", q.p); continue; } }
      els.push({ t: "R", a: nodeOfPad(two[0].ref), b: nodeOfPad(two[1].ref), r: Math.max(r, 1e-3), q, pa: two[0], pb: two[1] });
    }
    for (const q of leds) {
      const A = q.pads.find((p) => p.n.toUpperCase() === "A") || q.pads[0], K = q.pads.find((p) => p.n.toUpperCase() === "K") || q.pads[1];
      if (!A || !K || A === K) continue;
      const diode = q.e.kind === "diode";
      els.push({ t: "D", a: nodeOfPad(A.ref), b: nodeOfPad(K.ref), vf: diode ? (q.e.vf || 0.7) : ledVf(q.p.value, q.e), rd: diode ? 0.5 : 5, q, pa: A, pb: K });
    }
    const icInfo = [];
    for (const q of ics) {
      const vdd = roleOf(q, "power_in")[0], gnd = roleOf(q, "ground")[0];
      icInfo.push({ q, vdd, gnd, nV: vdd ? nodeOfPad(vdd.ref) : null, nG: gnd ? nodeOfPad(gnd.ref) : null, io: roleOf(q, "io"), rout: q.e.pin_rout || 40 });
    }

    // ---------- 4. DC solve (two worst-case scenarios for MCU pins) ----------
    function solveScenario(sc) {
      const elems = [];
      for (const e of els) if (e.a !== e.b) elems.push(e.t === "R" ? { a: e.a, b: e.b, g: 1 / e.r, src: e } : { a: e.a, b: e.b, g: 1 / e.rd, vf: e.vf, led: true, src: e });
      for (const ic of icInfo) {
        if (!ic.vdd || !ic.gnd || !fixed.has(ic.nV) || !refNodes.has(ic.nG)) continue;
        for (const p of ic.io) {
          const pn = nodeOfPad(p.ref); if (pn == null) continue;
          const a = sc === "H" ? ic.nV : pn, bb = sc === "H" ? pn : ic.nG;
          if (a !== bb) elems.push({ a, b: bb, g: 1 / ic.rout, pin: { ic, pad: p, sc } });
        }
      }
      const unknown = [], idx = new Map();
      for (const e of elems) for (const n of [e.a, e.b]) if (!fixed.has(n) && !refNodes.has(n) && !idx.has(n)) { idx.set(n, unknown.length); unknown.push(n); }
      const Vn = new Map();
      for (const [n, f] of fixed) Vn.set(n, f.v);
      for (const n of refNodes) Vn.set(n, 0);
      const ledOn = elems.map(() => false);
      const volt = (n) => (Vn.has(n) ? Vn.get(n) : 0);
      for (let iter = 0; iter < 60; iter++) {
        const N = unknown.length;
        if (N) {
          const G = Array.from({ length: N }, () => new Float64Array(N + 1));
          for (let i = 0; i < N; i++) G[i][i] += 1e-9; // keeps floating nodes solvable (they sit at 0 V)
          elems.forEach((e, k) => {
            if (e.led && !ledOn[k]) return;
            const ia = idx.get(e.a), ib = idx.get(e.b), g = e.g, ic = e.led ? g * e.vf : 0;
            if (ia !== undefined) { G[ia][ia] += g; G[ia][N] += ic; if (ib !== undefined) G[ia][ib] -= g; else G[ia][N] += g * volt(e.b); }
            if (ib !== undefined) { G[ib][ib] += g; G[ib][N] -= ic; if (ia !== undefined) G[ib][ia] -= g; else G[ib][N] += g * volt(e.a); }
          });
          for (let c = 0; c < N; c++) { // gaussian elimination, partial pivoting
            let p = c; for (let r = c + 1; r < N; r++) if (Math.abs(G[r][c]) > Math.abs(G[p][c])) p = r;
            [G[c], G[p]] = [G[p], G[c]];
            const d = G[c][c] || 1e-12;
            for (let r = c + 1; r < N; r++) { const f = G[r][c] / d; if (f) for (let k = c; k <= N; k++) G[r][k] -= f * G[c][k]; }
          }
          const x = new Float64Array(N);
          for (let r = N - 1; r >= 0; r--) { let s = G[r][N]; for (let k = r + 1; k < N; k++) s -= G[r][k] * x[k]; x[r] = s / (G[r][r] || 1e-12); }
          unknown.forEach((n, i) => Vn.set(n, x[i]));
        }
        let changed = false;
        elems.forEach((e, k) => {
          if (!e.led) return;
          const fwd = volt(e.a) - volt(e.b);
          if (!ledOn[k] && fwd > e.vf + 1e-9) { ledOn[k] = true; changed = true; }
          else if (ledOn[k] && (fwd - e.vf) / (1 / e.g) < -1e-12) { ledOn[k] = false; changed = true; }
        });
        if (!changed) break;
      }
      const cur = elems.map((e, k) => (e.led ? (ledOn[k] ? Math.max(0, (volt(e.a) - volt(e.b) - e.vf) * e.g) : 0) : (volt(e.a) - volt(e.b)) * e.g));
      // pad currents (positive = flowing from the net INTO the part)
      const padI = new Map(), regI = new Map();
      const addI = (m, ref, i) => m.set(ref, (m.get(ref) || 0) + i);
      const sink = new Map(); // ic → total sinking current
      elems.forEach((e, k) => {
        const i = cur[k];
        if (e.pin) { const pr = e.pin.pad.ref; if (e.pin.sc === "H") addI(padI, pr, -i); else { addI(padI, pr, i); sink.set(e.pin.ic, (sink.get(e.pin.ic) || 0) + i); } }
        else { addI(padI, e.src.pa.ref, i); addI(padI, e.src.pb.ref, -i); }
      });
      for (const ic of icInfo) {
        if (!ic.vdd || !ic.gnd || !fixed.has(ic.nV) || !refNodes.has(ic.nG)) continue;
        const iq = ic.q.e.iq || 0;
        let src = 0; elems.forEach((e, k) => { if (e.pin && e.pin.ic === ic && e.pin.sc === "H") src += cur[k]; });
        addI(padI, ic.vdd.ref, iq + src);
        addI(padI, ic.gnd.ref, -(iq + (sink.get(ic) || 0)));
      }
      for (const q of loads) {
        const pin = roleOf(q, "power_in")[0], pg = roleOf(q, "ground")[0], il = q.e.iload || 0;
        if (!pin || !pg) continue;
        if (volt(nodeOfPad(pin.ref)) > 0.5 && refNodes.has(nodeOfPad(pg.ref))) { addI(padI, pin.ref, il); addI(padI, pg.ref, -il); }
      }
      const loadAt = (n) => { let s = 0; for (const ref of nodes.get(n).pads) { const a = padI.get(ref), c = regI.get(ref); s += (a || 0) + (c || 0); } return s; };
      const regOut = new Map();
      for (let it = 0; it < 8; it++) {
        for (const r of regInfo) {
          if (!fixed.has(r.nIn) || !refNodes.has(r.nG)) continue;
          regI.delete(r.pout.ref);
          const iout = Math.max(0, loadAt(r.nOut)), iq = r.q.e.iq || 0;
          regOut.set(r.q, iout);
          regI.set(r.pin.ref, iout + iq); regI.set(r.pout.ref, -iout); regI.set(r.pg.ref, -iq);
        }
      }
      const srcOut = new Map(), share = (s) => sourceOut.filter((t) => t.outs.some((o) => nodeOfPad(o.ref) === nodeOfPad(s.outs[0].ref))).length || 1;
      for (const s of sourceOut) srcOut.set(s.q, Math.max(0, loadAt(nodeOfPad(s.outs[0].ref))) / share(s)); // all loads first…
      for (const s of sourceOut) { const i = srcOut.get(s.q); regI.set(s.outs[0].ref, -i); for (const g of s.gnds) regI.set(g.ref, i / s.gnds.length); } // …then book the supply side
      const all = new Map(padI);
      for (const [k, v] of regI) all.set(k, (all.get(k) || 0) + v);
      let stress = 0; for (const v of all.values()) stress += Math.abs(v);
      return { sc, elems, cur, Vn, volt, padI: all, regOut, srcOut, sink, stress };
    }
    const hasPins = icInfo.some((ic) => ic.io.length && ic.vdd && fixed.has(ic.nV));
    const scenarios = hasPins ? [solveScenario("H"), solveScenario("L")] : [solveScenario("H")];
    const main = scenarios.reduce((m, s) => (s.stress > m.stress ? s : m), scenarios[0]);
    const scWord = { H: "driven high", L: "driven low" };

    // ---------- 5. per-scenario safety checks (worst scenario per issue wins) ----------
    const cand = new Map();
    const note = (key, score, level, code, msg, fix, loc, extra) => {
      const c = cand.get(key);
      if (!c || score > c.score) cand.set(key, { score, level, code, msg, fix, loc, extra });
    };
    for (const sc of scenarios) {
      const volt = sc.volt, pinNote = hasPins && icInfo.some((ic) => ic.io.length) ? ` (worst case: MCU pins ${scWord[sc.sc]})` : "";
      sc.elems.forEach((e, k) => {
        const i = sc.cur[k];
        if (!e.src || e.pin) return;
        const q = e.src.q, ref = q.p.ref;
        if (e.led && e.src.q.e.kind === "led") {
          const imax = q.e.imax || 0.02, va = volt(e.a), vk = volt(e.b), vr = q.e.vr_max || 5;
          if (vk - va > vr) note("rev|" + ref, vk - va, "danger", "led_reverse", `${ref} has ${fmtV(vk - va)} across it the wrong way round — more than its ${fmtV(vr)} reverse limit; it can be destroyed.`, "Flip the LED (anode toward the positive side).", q.p, { ref });
          else if (vk - va > 0.3) note("back|" + ref, 1, "warning", "led_backwards", `${ref} is connected backwards, so it will never light.`, "Swap the LED's anode (A) and cathode (K) connections.", q.p, { ref });
          else if (i > imax) {
            const anodeFixed = fixed.has(e.a);
            const fix = anodeFixed ? `Add a series resistor of at least ${Math.ceil((va - e.vf) / (0.75 * imax))} Ω.` : `Increase the series resistor about ${(i / (0.75 * imax)).toFixed(1)}× (current falls as resistance rises).`;
            note("ledi|" + ref, i / imax, "danger", "led_overcurrent", `${ref} would carry ${fmtA(i)} — more than its ${fmtA(imax)} limit${anodeFixed ? " (no current-limiting resistor)" : ""}${pinNote}. It will overheat and burn out.`, fix, q.p, { ref });
          } else if (i > 0.8 * imax) note("ledi|" + ref, i / imax, "warning", "led_current_high", `${ref} carries ${fmtA(i)} — close to its ${fmtA(imax)} limit${pinNote}.`, "A slightly larger resistor would keep it safely below the limit.", q.p, { ref });
          else if (i < 1e-6 && va - vk > 0.2 && va - vk < e.vf) note("dark|" + ref, 0.5, "info", "led_dark", `${ref} will not light: only ${fmtV(va - vk)} is available across it but it needs about ${fmtV(e.vf)}.`, "Power it from a higher voltage or use a lower-voltage LED colour.", q.p, { ref });
        } else if (e.led) {
          const imax = q.e.imax || 1;
          if (i > imax) note("diodei|" + ref, i / imax, "danger", "diode_overcurrent", `${ref} carries ${fmtA(i)}, above its ${fmtA(imax)} rating.`, "Reduce the current or use a bigger diode.", q.p, { ref });
        } else {
          const r = e.src.r, p = i * i * r, pmax = q.e.pmax || 0.1;
          if (q.e.kind === "inductor") { const imx = q.e.imax || 0.5; if (i > imx) note("indi|" + ref, i / imx, "danger", "inductor_overcurrent", `${ref} carries ${fmtA(i)} but is rated ${fmtA(imx)}.`, "Use an inductor with a higher current rating.", q.p, { ref }); return; }
          if (p > pmax) note("rp|" + ref, p / pmax, "danger", "resistor_overpower", `${ref} dissipates ${fmtW(p)} but is rated ${fmtW(pmax)} — it will overheat${pinNote}.`, `Use a higher resistance or a ${p <= 0.25 ? "¼ W" : p <= 0.5 ? "½ W" : "higher-power"} resistor.`, q.p, { ref });
          else if (p > 0.7 * pmax) note("rp|" + ref, p / pmax, "warning", "resistor_power_high", `${ref} dissipates ${fmtW(p)} of its ${fmtW(pmax)} rating.`, "Leave more margin: pick a higher-power resistor.", q.p, { ref });
        }
      });
      for (const q of caps) {
        const two = q.pads.slice(0, 2); if (two.length < 2) continue;
        const v = Math.abs(volt(nodeOfPad(two[0].ref)) - volt(nodeOfPad(two[1].ref)));
        const m = String(q.p.value).match(/(\d+(?:\.\d+)?)\s*V\b/i), vmax = m ? Number(m[1]) : q.e.vmax || 16;
        if (v > vmax) note("cap|" + q.p.ref, v / vmax, "danger", "cap_overvoltage", `${q.p.ref} sees ${fmtV(v)} but is rated ${fmtV(vmax)} — it can fail short or burst.`, "Use a capacitor with a higher voltage rating (e.g. add 25V to the value).", q.p, { ref: q.p.ref });
        else if (v > 0.8 * vmax) note("cap|" + q.p.ref, v / vmax, "warning", "cap_margin", `${q.p.ref} runs at ${fmtV(v)} of its ${fmtV(vmax)} rating — little safety margin.`, "Pick a capacitor rated at least 2× the working voltage.", q.p, { ref: q.p.ref });
      }
      for (const r of regInfo) {
        const ref = r.q.p.ref, vin = r.vin, e = r.q.e;
        if (!fixed.has(r.nIn)) { note("regin|" + ref, 9, "danger", "reg_unpowered", `${ref} has no input power: its IN pin is not connected to a supply.`, "Route the 5 V (or battery) rail to the IN pin.", r.pin, { ref }); continue; }
        if (!refNodes.has(r.nG)) { note("regg|" + ref, 9, "danger", "reg_no_ground", `${ref}'s GND pin is not connected to the supply ground, so it can't regulate.`, "Connect the GND pin to the ground net (use vias and the bottom layer if needed).", r.pg, { ref }); continue; }
        const iout = sc.regOut.get(r.q) || 0, vo = e.vout || 3.3, dr = e.dropout || 0.25, vmaxin = e.vin_max || 6;
        if (vin > vmaxin) note("regv|" + ref, vin / vmaxin, "danger", "reg_overvoltage", `${ref} is fed ${fmtV(vin)} but its input is rated ${fmtV(vmaxin)} — it will be destroyed.`, "Feed it from a lower voltage or pick a regulator with a higher input rating.", r.pin, { ref });
        if (vin < vo + dr) note("regd|" + ref, 1, "warning", "reg_dropout", `${ref} needs at least ${fmtV(vo + dr)} in to make ${fmtV(vo)}; with ${fmtV(vin)} the output sags to about ${fmtV(r.veff)}.`, "Use a higher input voltage or a lower-dropout regulator.", r.pout, { ref });
        const imax = e.imax || 0.6;
        if (iout > imax) note("regi|" + ref, iout / imax, "danger", "reg_overcurrent", `${ref} would supply ${fmtA(iout)} but is rated ${fmtA(imax)}.`, "Reduce the load or use a bigger regulator.", r.pout, { ref });
        else if (iout > 0.8 * imax) note("regi|" + ref, iout / imax, "warning", "reg_current_high", `${ref} supplies ${fmtA(iout)} of its ${fmtA(imax)} limit.`, "Leave more headroom.", r.pout, { ref });
        const pw = (vin - r.veff) * iout + vin * (e.iq || 0), pmax = e.pmax || 0.4;
        if (pw > pmax) note("regp|" + ref, pw / pmax, "danger", "reg_overheat", `${ref} turns ${fmtW(pw)} into heat (it drops ${fmtV(vin - r.veff)} at ${fmtA(iout)}) — above its ~${fmtW(pmax)} limit; it will overheat.`, "Lower the load current, drop the input voltage, or use a switching regulator.", r.q.p, { ref });
        else if (pw > 0.7 * pmax) note("regp|" + ref, pw / pmax, "warning", "reg_warm", `${ref} dissipates ${fmtW(pw)} as heat (limit ~${fmtW(pmax)}).`, "Keep an eye on temperature; add copper area for cooling.", r.q.p, { ref });
      }
      for (const ic of icInfo) {
        const ref = ic.q.p.ref, e = ic.q.e;
        if (!ic.vdd || !ic.gnd) { note("icroles|" + ref, 0, "info", "ic_roles", `${ref}: its power/ground pins aren't marked, so it can't be checked yet.`, `set_electrical ref=${ref} roles=VDD:power_in/GND:ground vdd_min=… vdd_max=…`, ic.q.p, { ref }); continue; }
        if (!fixed.has(ic.nV)) { note("icpow|" + ref, 9, "danger", "ic_unpowered", `${ref}'s power pin (${ic.vdd.ref}) is not connected to any supply — the chip will not run.`, "Route a supply rail to the power pin.", ic.vdd, { ref }); continue; }
        if (!refNodes.has(ic.nG)) { note("icgnd|" + ref, 9, "danger", "ic_no_ground", `${ref}'s ground pin (${ic.gnd.ref}) is not connected to the supply ground.`, "Connect it to the ground net.", ic.gnd, { ref }); continue; }
        const vdd = fixed.get(ic.nV).v;
        if (e.vdd_max && vdd > e.vdd_max) note("icv|" + ref, vdd / e.vdd_max, "danger", "ic_overvoltage", `${ref} is powered with ${fmtV(vdd)} but its maximum is ${fmtV(e.vdd_max)} — it will be damaged.`, "Power it from a regulated lower rail.", ic.vdd, { ref });
        else if (e.vdd_min && vdd < e.vdd_min) note("icv|" + ref, 5, "danger", "ic_undervoltage", `${ref} gets only ${fmtV(vdd)}; it needs at least ${fmtV(e.vdd_min)} to run.`, "Check the regulator and the supply path.", ic.vdd, { ref });
        if (e.guessed && !e.vdd_max) note("icunk|" + ref, 0, "info", "ic_unknown", `${ref}: electrical limits aren't set, so its voltage/current can't be verified.`, `set_electrical ref=${ref} vdd_min=… vdd_max=… iq=… pin_imax=…`, ic.q.p, { ref });
        const pmaxI = e.pin_imax || 0.008;
        for (const p of ic.io) {
          const pn = nodeOfPad(p.ref); if (pn == null) continue;
          const vp = sc.volt(pn);
          if (vp > vdd + 0.3 + 1e-9) note("pinv|" + p.ref, vp / (vdd + 0.3), "danger", "pin_overvoltage", `${p.ref} (${p.fn}) sees ${fmtV(vp)} but the chip runs at ${fmtV(vdd)} — pins tolerate at most about ${fmtV(vdd + 0.3)}. It can be damaged.`, "Use a level shifter or a voltage divider.", p, { ref: p.ref });
          const ip = Math.abs(sc.padI.get(p.ref) || 0);
          if (ip > pmaxI) note("pini|" + p.ref, ip / pmaxI, "danger", "pin_overcurrent", `${p.ref} (${p.fn}) would ${(sc.padI.get(p.ref) || 0) < 0 ? "source" : "sink"} ${fmtA(ip)} when ${scWord[sc.sc]} — its limit is ${fmtA(pmaxI)}. Probably shorted to a rail.`, "Add a series resistor or fix the short on that pin.", p, { ref: p.ref });
          else if (ip > 0.8 * pmaxI) note("pini|" + p.ref, ip / pmaxI, "warning", "pin_current_high", `${p.ref} (${p.fn}) carries ${fmtA(ip)} when ${scWord[sc.sc]}, near its ${fmtA(pmaxI)} limit.`, "Use a larger series resistor, or drive the load through a transistor.", p, { ref: p.ref });
        }
      }
      for (const s of sourceOut) {
        const ref = s.q.p.ref, i = sc.srcOut.get(s.q) || 0, imax = s.q.e.imax || 0.5;
        if (i > imax) note("src|" + ref, i / imax, "danger", "supply_overload", `${ref} would have to supply ${fmtA(i)} but can only give ${fmtA(imax)} — the supply will shut down, brown out or overheat.`, "Reduce what the board draws (smaller LEDs/loads) or use a stronger supply.", s.outs[0], { ref });
        else if (i > 0.8 * imax) note("src|" + ref, i / imax, "warning", "supply_near_limit", `${ref} supplies ${fmtA(i)} of its ${fmtA(imax)} limit.`, "Leave more headroom.", s.outs[0], { ref });
      }
      for (const n of nodes.values()) {
        const v = sc.volt(n.id);
        if (v > 48) note("hv|" + n.id, v / 48, "danger", "high_voltage", `Net ${n.name || "?"} is at ${fmtV(v)}. TRACE's rules are for low-voltage boards only (clearances for this voltage aren't checked) — not safe to build as-is.`, "Keep this tool to ≤ 30 V designs or get a high-voltage review.", n, { net: n.name });
        else if (v > 30) note("hv|" + n.id, v / 30, "warning", "voltage_30", `Net ${n.name || "?"} is at ${fmtV(v)}, above the 30 V low-voltage range; spacing/creepage rules are not checked above 30 V.`, "Check clearances manually.", n, { net: n.name });
      }
    }
    for (const [key, c] of cand) add(c.level, c.code, c.msg, c.fix, c.loc, c.extra);

    // ---------- 6. connectivity-level checks ----------
    for (const ic of icInfo) { if (!ic.vdd || !ic.gnd) continue; } // (handled per scenario)
    // USB data lines: D+ must meet D+, never D−
    for (const n of nodes.values()) {
      const dp = n.pads.filter((r) => padByRef.get(r).role === "usb_dp"), dm = n.pads.filter((r) => padByRef.get(r).role === "usb_dm");
      if (dp.length && dm.length) add("danger", "usb_swapped", `USB D+ (${dp[0]}) is wired to D− (${dm[0]}) — USB will not work (shorted or crossed data lines).`, "Connect D+ to D+ and D− to D−.", padByRef.get(dp[0]), { net: n.name });
    }
    // parts that connect to nothing
    for (const q of parts) {
      if (q.e.kind === "none" || !q.pads.length) continue;
      if (q.pads.every((pd) => nodeOfUnit(pd.ref).units.length === 1))
        add("info", "unconnected_part", `${q.p.ref} (${defOf(q.p.type).label}) isn't connected to anything yet.`, "", q.p, { ref: q.p.ref });
    }
    if (unrouted.length)
      add("info", "unrouted", `${unrouted.length} wire${unrouted.length === 1 ? " is" : "s are"} drawn in the Graph but not routed as copper on the board yet.`, "Switch to the Board tab and route them (dashed lines show where).", null);

    // ---------- 7. trace / via current capacity ----------
    const traceI = new Map();
    for (const sc of scenarios) {
      for (const n of nodes.values()) {
        const us = n.units;
        const inNode = new Set(us);
        const padCur = (i) => (uInfo[i].type === "pad" ? sc.padI.get(uInfo[i].ref) || 0 : 0);
        let total = 0; for (const i of us) { const c = padCur(i); if (c > 0) total += c; }
        for (const i of us) {
          const t = uInfo[i].type; if (t === "pad") continue;
          // remove this trace/via and see how the copper falls apart: current through it = pad current on one side
          const seen = new Set([i]), comps = [];
          for (const nb of adj[i]) {
            if (!inNode.has(nb) || seen.has(nb)) continue;
            const comp = [], stack = [nb]; seen.add(nb);
            while (stack.length) { const u = stack.pop(); comp.push(u); for (const w of adj[u]) if (inNode.has(w) && !seen.has(w)) { seen.add(w); stack.push(w); } }
            comps.push(comp);
          }
          let cur;
          if (comps.length > 1) cur = Math.max(...comps.map((c) => Math.abs(c.reduce((s, u) => s + padCur(u), 0))));
          else if (comps.length === 1 && [...adj[i]].filter((w) => inNode.has(w)).length >= 2) cur = total; // sits on a loop: assume all of the net's current (conservative)
          else cur = 0; // a dead-end stub carries nothing
          traceI.set(uInfo[i].id, Math.max(traceI.get(uInfo[i].id) || 0, cur));
        }
      }
    }
    const traceReport = {};
    for (const t of S.traces) {
      const i = traceI.get(t.id) || 0, i10 = ampacity(t.width, 10), i40 = ampacity(t.width, 40);
      traceReport[t.id] = { net: t.net, i: r3(i), limit: r3(i10), width: t.width, status: i > i40 ? "danger" : i > i10 ? "warning" : "ok" };
      if (i > i40) add("danger", "trace_overheat", `Trace ${t.id} (${t.net}, ${t.width} mm) carries ${fmtA(i)} — far beyond what that width handles (${fmtA(i10)} for a 10 °C rise). It will get very hot and can burn the board.`, `Widen it to at least ${widthFor(i, 10).toFixed(2)} mm.`, { x: t.pts[0][0], y: t.pts[0][1] }, { net: t.net, trace: t.id });
      else if (i > i10) add("warning", "trace_hot", `Trace ${t.id} (${t.net}, ${t.width} mm) carries ${fmtA(i)}; ${t.width} mm is good for ${fmtA(i10)} at a 10 °C rise, so it will run warm.`, `Widen it to about ${widthFor(i, 10).toFixed(2)} mm.`, { x: t.pts[0][0], y: t.pts[0][1] }, { net: t.net, trace: t.id });
    }
    for (const v of S.vias) {
      const i = traceI.get(v.id) || 0;
      if (i > VIA_AMPS) add("warning", "via_current", `Via ${v.id} (${v.net || "?"}) carries ${fmtA(i)}; one small via is good for about ${fmtA(VIA_AMPS)}.`, "Add several vias in parallel.", v, { net: v.net });
    }

    // ---------- 8. reports ----------
    const volt = main.volt;
    const rails = [];
    for (const n of nodes.values()) {
      if (!n.pads.length || n.units.length < 2) continue; // skip pads that connect to nothing
      const v = volt(n.id), sum = n.pads.reduce((s, r) => s + Math.max(0, main.padI.get(r) || 0), 0);
      rails.push({ net: n.name, volts: r3(v), amps: r3(sum), pads: n.pads.length, source: fixed.get(n.id) ? fixed.get(n.id).by : "", ground: refNodes.has(n.id) });
    }
    const partsRep = {};
    const rep = (ref, o) => { partsRep[ref] = Object.assign(partsRep[ref] || {}, o); };
    main.elems.forEach((e, k) => {
      if (!e.src || e.pin) return;
      const ref = e.src.q.p.ref, i = main.cur[k];
      if (!e.led) rep(ref, { i: r3(i), v: r3(main.volt(e.a) - main.volt(e.b)), p: r3(i * i * e.src.r), limitP: e.src.q.e.pmax || 0.1, kind: e.src.q.e.kind });
      else rep(ref, { i: r3(i), v: r3(main.volt(e.a) - main.volt(e.b)), p: r3(i * (e.vf + i * e.src.rd)), limitI: e.src.q.e.imax || (e.src.q.e.kind === "diode" ? 1 : 0.02), kind: e.src.q.e.kind });
    });
    for (const q of caps) { const two = q.pads.slice(0, 2); if (two.length === 2) rep(q.p.ref, { v: r3(Math.abs(volt(nodeOfPad(two[0].ref)) - volt(nodeOfPad(two[1].ref)))), i: 0, limitV: (String(q.p.value).match(/(\d+(?:\.\d+)?)\s*V\b/i) || [])[1] ? Number(String(q.p.value).match(/(\d+(?:\.\d+)?)\s*V\b/i)[1]) : q.e.vmax || 16, kind: "capacitor" }); }
    for (const r of regInfo) { const iout = main.regOut.get(r.q) || 0; if (r.vin !== undefined) rep(r.q.p.ref, { i: r3(iout), v: r3(r.veff), vin: r3(r.vin), p: r3((r.vin - r.veff) * iout + r.vin * (r.q.e.iq || 0)), limitI: r.q.e.imax || 0.6, limitP: r.q.e.pmax || 0.4, kind: "regulator" }); }
    for (const ic of icInfo) if (ic.vdd) rep(ic.q.p.ref, { i: r3(main.padI.get(ic.vdd.ref) || 0), v: r3(volt(ic.nV)), kind: "ic", limitV: ic.q.e.vdd_max || undefined });
    for (const s of sourceOut) rep(s.q.p.ref, { i: r3(main.srcOut.get(s.q) || 0), v: s.q.e.vout, limitI: s.q.e.imax || 0.5, kind: "source" });
    for (const q of loads) { const pin = roleOf(q, "power_in")[0]; if (pin) rep(q.p.ref, { i: r3(main.padI.get(pin.ref) || 0), v: r3(volt(nodeOfPad(pin.ref))), kind: "load" }); }
    const padsRep = {};
    for (const [ref, pd] of padByRef) { const n = nodeOfUnit(ref); padsRep[ref] = { net: n.name, v: r3(volt(n.id)), i: r3(main.padI.get(ref) || 0) }; }
    for (const ref of Object.keys(partsRep)) {
      const o = partsRep[ref], lim = o.limitI ? Math.abs(o.i) / o.limitI : o.limitP ? o.p / o.limitP : o.limitV ? Math.abs(o.v) / o.limitV : 0;
      o.load = r3(lim);
    }
    const issuesSorted = issues.sort((a, b) => ({ danger: 0, warning: 1, info: 2 }[a.level] - { danger: 0, warning: 1, info: 2 }[b.level]));
    const refRe = new Set(S.parts.map((p) => p.ref));
    issuesSorted.forEach((it, i) => { it.id = "e" + (i + 1); it.refs = [...new Set((it.msg.match(/\b[A-Z]{1,3}[0-9]+(?![A-Za-z0-9_])/g) || []).filter((r) => refRe.has(r)))]; });
    const counts = { danger: 0, warning: 0, info: 0 };
    for (const it of issuesSorted) counts[it.level]++;
    const level = counts.danger ? "danger" : counts.warning ? "warning" : sourceOut.length ? "safe" : "unknown";
    const usb = sourceOut.map((s) => ({ ref: s.q.p.ref, volts: s.q.e.vout, amps: r3(main.srcOut.get(s.q) || 0), limit: s.q.e.imax || 0.5 }));
    const summary = level === "safe" ? "No electrical problems found. " + usb.map((u) => `${u.ref} supplies ${fmtA(u.amps)} of ${fmtA(u.limit)}.`).join(" ")
      : level === "unknown" ? "Add a power source (USB-C or battery) to check voltages and currents."
      : `${counts.danger} danger${counts.danger === 1 ? "" : "s"}, ${counts.warning} warning${counts.warning === 1 ? "" : "s"}${counts.info ? `, ${counts.info} note${counts.info === 1 ? "" : "s"}` : ""} — fix the dangers before building.`;
    return {
      unrouted_links: unrouted.map((l) => l.id),
      level, summary, counts, issues: issuesSorted, rails, parts: partsRep, traces: traceReport, pads: padsRep, supplies: usb,
      worst_case: hasPins ? "MCU pins evaluated both driven high and driven low; the worse case is shown" : "",
      disclaimer: "Steady-state DC screening with rule-of-thumb ratings (IPC-2221 trace heating, typical part limits). Not a simulation: check the real datasheets before building.",
    };
  }

  // ---------- commands ----------
  Board.prototype.cmd_analyze = function () { return analyze(this); };
  Board.prototype.cmd_safety = Board.prototype.cmd_analyze;
  Board.prototype.cmd_set_electrical = function (a) {
    const keys = Object.keys(a).filter((k) => !["ref", "type", "text"].includes(k));
    if (!keys.length) throw new Error("nothing to set — pass kind=, vmax=, imax=, pmax=, vf=, vout=, iq=, vdd_min=, vdd_max=, pin_imax=, roles=NAME:role/… (see help)");
    const patch = sanitizeElec(a);
    if (a.ref) {
      const p = this.findPart(a.ref);
      if (!p) throw new Error(`no part ${a.ref}`);
      const oldRoles = (p.elec && p.elec.roles) || {};
      p.elec = Object.assign({}, p.elec, patch);
      if (patch.roles) p.elec.roles = Object.assign({}, oldRoles, patch.roles); // new roles add to / override the old ones
      return { ref: p.ref, electrical: p.elec, _focus: { x: p.x, y: p.y, label: p.ref + " ratings" } };
    }
    if (a.type) {
      const d = T.PARTS[String(a.type).toLowerCase()];
      if (!d) throw new Error(`no part type ${a.type}`);
      if (!d.custom) throw new Error(`"${a.type}" is built in — set ratings on a placed part with ref= instead`);
      const oldR = (d.elec && d.elec.roles) || {};
      d.elec = Object.assign({}, d.elec, patch);
      if (patch.roles) d.elec.roles = Object.assign({}, oldR, patch.roles);
      this.emit({ type: "library", action: "create", id: String(a.type).toLowerCase(), def: d });
      return { type: a.type, electrical: d.elec };
    }
    throw new Error("give ref=<R1> (this part on the board) or type=<custom part id>");
  };
  T.MUTATING.add("set_electrical");

  // ---------- auto_wire: ground to ground, supply to the pins that need it, USB D+ to D+ ----------
  T.Board.prototype.cmd_auto_wire = function (a) {
    const done = [], skipped = [];
    const ps = this.s.parts.map((p) => ({ p, e: elecOf(p), pads: this.pads(p) }));
    const link = (A, B, why) => {
      if (this.linked(A.ref, B.ref)) return;
      try { this.cmd_connect({ a: A.ref, b: B.ref }); done.push(A.ref + " ↔ " + B.ref + " (" + why + ")"); } catch (e) { skipped.push(e.message); }
    };
    const roleOf = (q, r) => q.pads.filter((pd) => pd.role === r);
    // ground: tie every ground pad to the first one (a star around the supply's ground)
    const grounds = ps.flatMap((q) => roleOf(q, "ground"));
    const src = ps.find((q) => q.e.kind === "source" || q.e.kind === "connector" && roleOf(q, "power_out").length) || ps[0];
    const g0 = (src && roleOf(src, "ground")[0]) || grounds[0];
    for (const g of grounds) if (g0 && g.ref !== g0.ref) link(g0, g, "ground");
    // supplies: each power_in pin takes the lowest rail that is still inside its limits
    const rails = [];
    for (const q of ps) {
      if (q.e.kind === "regulator") for (const o of roleOf(q, "power_out")) rails.push({ pad: o, v: q.e.vout, by: q.p.ref, reg: q });
      else if (q.e.kind === "source" || q.e.kind === "connector") for (const o of roleOf(q, "power_out")) rails.push({ pad: o, v: q.e.vout !== undefined ? q.e.vout : 5, by: q.p.ref });
    }
    for (const q of ps) for (const pin of roleOf(q, "power_in")) {
      const lo = q.e.kind === "regulator" ? 0 : q.e.vdd_min || 0, hi = q.e.kind === "regulator" ? q.e.vin_max || 99 : q.e.vdd_max || 99;
      const ok = rails.filter((r) => r.by !== q.p.ref && r.v >= lo && r.v <= hi && !(r.reg && r.reg === q)).sort((x, y) => (q.e.kind === "regulator" ? y.v - x.v : x.v - y.v));
      if (ok[0]) link(ok[0].pad, pin, ok[0].v + " V supply");
      else if (rails.length) skipped.push(`${pin.ref} needs ${lo}–${hi} V but no rail on the board fits (add a regulator)`);
    }
    // USB data
    const dps = ps.flatMap((q) => roleOf(q, "usb_dp")), dms = ps.flatMap((q) => roleOf(q, "usb_dm"));
    for (const list of [dps, dms]) for (let i = 1; i < list.length; i++) link(list[0], list[i], "USB data");
    return { connected: done, needs_a_human_or_claude: skipped, next: "run analyze, then wire signals (LED resistors, IO pins) with connect" };
  };
  T.USAGE.auto_wire = "auto_wire — connects ground to ground, each power pin to a suitable supply rail, and USB D+/D−; returns what it connected and what still needs deciding";
  T.MUTATING.add("auto_wire");
  USAGE.analyze = "analyze — electrical safety check: voltages, currents, part ratings, trace heating, shorts, missing power/ground. Returns issues (danger/warning/info) with fixes";
  USAGE.set_electrical = "set_electrical ref=<U3>|type=<custom id> [kind=ic|resistor|led|regulator|source|load|connector…] [vmax= imax= pmax= vf= vout= dropout= vin_max= iq= iload= vdd_min= vdd_max= pin_imax=] [roles=VDD:power_in/GND:ground/…] — tell the analyser what a part can handle (roles: power_in power_out ground io usb_dp usb_dm passive nc)";

  T.elecOf = elecOf; T.parseValue = parseValue; T.ampacity = ampacity; T.widthFor = widthFor; T.analyze = analyze; T.parseRoles = parseRoles;
})(typeof window !== "undefined" ? window : globalThis);
