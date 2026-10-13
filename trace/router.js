// TRACE router — turns the airwires into real copper, the way an engineer would.
//   autoroute    two-layer A* maze router: 45° traces, vias only when needed, wire classes (width / clearance),
//                board edge + cutout keep-outs, ground connected through a copper pour on the back layer
//   clear_routes rip up the traces and vias the router made (or all of them)
//   add_pour     a copper pour (ground plane) on a layer
//   suggest_rules / apply_suggested_rules   what width every net really needs (IPC-2221), as wire classes
//   explain_trace / explain_net             the exact settings behind a trace — what to set to get it
// Loaded after rules.js. Everything is engine-side so Claude, the CLI and the buttons all share it.
(function (root) {
  "use strict";
  const T = root.TraceEngine, B = T.Board.prototype, { RULES } = T, U = T.USAGE, M = T.MUTATING;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const up05 = (x) => Math.max(0.05, Math.ceil(x * 20 - 1e-9) / 20); // round a width up to the next 0.05 mm
  const RHO = 1.72e-8, T_CU = 35e-6; // copper resistivity (Ω·m) and 1 oz thickness (m)
  const isGndName = (n) => /^(gnd|agnd|dgnd|pgnd|vss|0v)\w*$/i.test(n);

  // ---------------------------------------------------------------- what kind of net is it?
  B.netInfo = function (name) {
    const pads = this.allPads().filter((q) => q.net === name);
    const ground = pads.some((q) => q.role === "ground") || isGndName(name);
    const power = !ground && (pads.some((q) => q.role === "power_out" || q.role === "power_in") || /^(\+?\d|v(bus|cc|dd|in|bat)|pp)/i.test(name));
    const usb = pads.some((q) => /^usb/.test(q.role));
    return { name, pads, ground, power, usb, kind: ground ? "ground" : power ? "power" : usb ? "usb" : "signal" };
  };

  // ---------------------------------------------------------------- wire classes from real current
  B.suggestRules = function () {
    const A = T.analyze(this), R = this.rulesState(), amps = new Map(), rows = [];
    for (const r of A.rails) for (const n of String(r.net).split(" + ")) amps.set(n, Math.max(amps.get(n) || 0, r.amps || 0));
    const def = R.classes.find((c) => c.id === "default") || R.classes[0];
    for (const n of this.nets()) {
      if (n.pads.length < 2) continue;
      const info = this.netInfo(n.name), i = amps.get(n.name) || 0, need = i > 0 ? T.widthFor(i * 1.25, 10) : 0; // 25 % headroom, 10 °C rise
      let width = def.width, why = "carries about " + (i >= 1 ? r3(i) + " A" : r3(i * 1000) + " mA") + " — the default width is enough";
      if (info.ground && info.pads.length > 3) why = "ground: a copper pour on the back layer carries it; each pin gets a short stub and a via";
      else if (need > def.width) { width = up05(need); why = `carries about ${i >= 1 ? r3(i) + " A" : r3(i * 1000) + " mA"}: IPC-2221 asks ≥ ${r3(need)} mm for a 10 °C rise with 25 % headroom`; }
      const cls = R.classes.filter((c) => c.width >= width - 1e-9).sort((x, y) => x.width - y.width)[0];
      rows.push({ net: n.name, kind: info.kind, amps: r3(i), needed_mm: r3(need), width_mm: cls ? cls.width : width, class: cls ? cls.name : "Power " + width + " mm", create: !cls, why });
    }
    return rows;
  };
  B.applySuggested = function (onlyUnassigned) {
    const R = this.rulesState(), made = [], set = [];
    for (const r of this.suggestRules()) {
      if (r.class === "Default" || r.width_mm <= (R.classes.find((c) => c.id === "default") || R.classes[0]).width + 1e-9) continue;
      if (onlyUnassigned && R.assign[r.net]) continue;
      if (r.create) { this.cmd_rule_class({ name: r.class, width: r.width_mm, clearance: 0.2, via_d: 0.8, via_drill: 0.4 }); made.push(r.class); }
      this.cmd_rule_assign({ net: r.net, class: r.class }); set.push(r.net + " → " + r.class);
    }
    return { classes_created: made, assigned: set };
  };
  B.cmd_suggest_rules = function () { const rows = this.suggestRules(); return { nets: rows, note: "apply with apply_suggested_rules — only nets that need more than the Default width are changed" }; };
  B.cmd_apply_suggested_rules = function () { const r = this.applySuggested(false); this.cmd_apply_rules(); return r; };

  // ---------------------------------------------------------------- pours + removing copper
  B.cmd_add_pour = function (a) {
    const layer = this.layerOf(a.layer || "B.Cu"), net = String(a.net || "GND"), known = this.nets().map((n) => n.name);
    if (!known.includes(net)) throw new Error(`no net "${net}" (nets: ${known.join(", ") || "none yet"})`);
    const Z = (this.s.zones = this.s.zones || []);
    let z = Z.find((x) => x.layer === layer && x.net === net);
    if (!z) { z = { id: this.nextId("z"), layer, net, clearance: Math.max(RULES.minGap, this.classOf(net).clearance) }; Z.push(z); }
    return { pour: z, note: `${net} copper fills the free area of ${layer}; every ${net} pin gets a via to it` };
  };
  const removeOrig = B.cmd_remove, clearOrig = B.cmd_clear;
  B.cmd_remove = function (a, source) {
    if (a.id && /^z\d+$/.test(String(a.id))) { const i = (this.s.zones || []).findIndex((z) => z.id === a.id); if (i < 0) throw new Error(`nothing with id ${a.id}`); this.s.zones.splice(i, 1); return { removed: a.id }; }
    return removeOrig.call(this, a, source);
  };
  B.cmd_clear = function () { const r = clearOrig.call(this); this.s.zones = []; return r; };
  B.cmd_clear_routes = function (a) {
    const all = a.all === true || a.all === 1 || a.all === "1" || a.all === "true", nets = a.net ? new Set(String(a.net).split(",").map((x) => x.trim())) : null;
    const keep = (o) => (!all && !o.auto) || (nets && !nets.has(o.net));
    const t0 = this.s.traces.length, v0 = this.s.vias.length;
    this.s.traces = this.s.traces.filter(keep); this.s.vias = this.s.vias.filter(keep);
    return { traces_removed: t0 - this.s.traces.length, vias_removed: v0 - this.s.vias.length, note: all ? "all copper removed" : "removed what the router made; traces you drew by hand stay" };
  };

  // ---------------------------------------------------------------- the maze router
  class Heap {
    constructor() { this.f = []; this.n = []; }
    get size() { return this.f.length; }
    push(f, n) { const F = this.f, N = this.n; let i = F.length; F.push(f); N.push(n); while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= F[i]) break; [F[p], F[i]] = [F[i], F[p]]; [N[p], N[i]] = [N[i], N[p]]; i = p; } }
    pop() {
      const F = this.f, N = this.n, top = N[0], lf = F.pop(), ln = N.pop();
      if (F.length) { F[0] = lf; N[0] = ln; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < F.length && F[l] < F[m]) m = l; if (r < F.length && F[r] < F[m]) m = r; if (m === i) break; [F[m], F[i]] = [F[i], F[m]]; [N[m], N[i]] = [N[i], N[m]]; i = m; } }
      return top;
    }
  }
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]; // 0..7, 45° apart
  const discCache = new Map();
  function disc(r) { // cell offsets within radius r (cells)
    const k = Math.round(r * 4); if (discCache.has(k)) return discCache.get(k);
    const R = k / 4, out = [], m = Math.ceil(R);
    for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) if (dx * dx + dy * dy <= R * R + 1e-9) out.push([dx, dy]);
    discCache.set(k, out); return out;
  }

  B.cmd_autoroute = function (a) {
    const t0 = Date.now(), b = this, { w: BW, h: BH } = this.s.board;
    const flag = (v, d) => (v === undefined ? d : !(v === 0 || v === "0" || v === false || v === "false" || v === "off"));
    const useVias = flag(a.vias, true), only = a.net ? new Set(String(a.net).split(",").map((x) => x.trim())) : null;
    const report = { routed: 0, failed: [], already: 0 };
    // 1. wire classes: nets that need more than the default width get their class automatically
    if (flag(a.classes, true)) report.classes = this.applySuggested(true);
    // 2. rip up the router's earlier work on the nets we are about to do (hand-drawn traces stay)
    if (flag(a.ripup, true)) this.cmd_clear_routes(only ? { net: [...only].join(",") } : {});
    // 3. a ground pour on the back layer when there is real ground to connect
    const infos = this.nets().filter((n) => n.pads.length >= 2).map((n) => this.netInfo(n.name));
    let pourNet = null;
    const pourOpt = a.pour === undefined ? "auto" : String(a.pour);
    if (pourOpt !== "off" && pourOpt !== "0") {
      const gnd = pourOpt !== "auto" ? infos.find((i) => i.name === pourOpt) : infos.filter((i) => i.ground).sort((x, y) => y.pads.length - x.pads.length)[0];
      if (gnd && (pourOpt !== "auto" || gnd.pads.length >= 3)) { this.cmd_add_pour({ net: gnd.name, layer: "B.Cu" }); pourNet = gnd.name; }
    }
    report.pour = pourNet;
    const zones = this.s.zones || [], pourZone = pourNet && zones.find((z) => z.net === pourNet && z.layer === "B.Cu");

    // the whole routing pass is one function so it can be repeated: a net that fails is routed FIRST in the next pass
    let gridUsed = 0;
    const attempt = (prio) => {
    // 4. the grid
    const g = Math.max(a.grid ? Number(a.grid) : 0.1, Math.sqrt((BW * BH) / 360000));
    gridUsed = g;
    const W = Math.floor(BW / g) + 1, H = Math.floor(BH / g) + 1, N = W * H, L = 2;
    const cix = (x) => Math.round(x / g), cell = (i, j) => j * W + i;
    const layerIdx = (n) => (n === "B.Cu" ? 1 : 0);

    // owners: net name (or a unique key for an unnamed pad) → cells per layer
    const occ = [new Map(), new Map()];
    const addOcc = (l, owner, c) => { let arr = occ[l].get(owner); if (!arr) occ[l].set(owner, (arr = [])); arr.push(c); };
    const gcount = new Map(); // radius(cells) → [Uint16Array, Uint16Array] counts of foreign-or-own copper within that radius
    const ensureG = (r) => {
      const k = Math.round(r * 4); if (gcount.has(k)) return gcount.get(k);
      const arrs = [new Uint16Array(N), new Uint16Array(N)], d = disc(r);
      for (let l = 0; l < L; l++) for (const cells of occ[l].values()) for (const c of cells) stampCount(arrs[l], c, d);
      gcount.set(k, arrs); return arrs;
    };
    function stampCount(arr, c, d) { const ci = c % W, cj = (c / W) | 0; for (const [dx, dy] of d) { const x = ci + dx, y = cj + dy; if (x >= 0 && y >= 0 && x < W && y < H) arr[y * W + x]++; } }

    const padCellOwner = new Map(); // layer*N+cell → pad ref (for ending traces on pad centres)
    const padInfo = new Map();       // ref → {pad, cells:[[l,c]], net}
    const rectCells = (x0, y0, x1, y1) => { const out = []; for (let j = Math.ceil(y0 / g - 1e-9); j <= Math.floor(y1 / g + 1e-9); j++) for (let i = Math.ceil(x0 / g - 1e-9); i <= Math.floor(x1 / g + 1e-9); i++) if (i >= 0 && j >= 0 && i < W && j < H) out.push(cell(i, j)); return out; };
    const discCells = (cx, cy, r) => { const out = [], R = r / g, ci = cix(cx), cj = cix(cy), m = Math.ceil(R) + 1; for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) { const x = ci + dx, y = cj + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue; if (Math.hypot(x * g - cx, y * g - cy) <= r + 1e-9) out.push(cell(x, y)); } return out; };

    // 5. existing copper: pads, traces, vias, cutouts
    for (const part of this.s.parts) for (const q of this.pads(part)) {
      const owner = q.net || "pad:" + q.ref;
      let cells = q.shape === "circle" ? discCells(q.x, q.y, q.w / 2) : rectCells(q.x - q.w / 2, q.y - q.h / 2, q.x + q.w / 2, q.y + q.h / 2);
      if (!cells.length) cells = [cell(Math.min(W - 1, Math.max(0, cix(q.x))), Math.min(H - 1, Math.max(0, cix(q.y))))];
      const layers = q.thru ? [0, 1] : [0], rec = { pad: q, cells: [], net: q.net };
      for (const l of layers) for (const c of cells) { addOcc(l, owner, c); rec.cells.push([l, c]); padCellOwner.set(l * N + c, q.ref); }
      padInfo.set(q.ref, rec);
    }
    const stampPolyline = (l, owner, pts, hw) => {
      const out = [];
      for (let k = 1; k < pts.length; k++) {
        const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], len = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(len / (g * 0.5)));
        for (let s = 0; s <= steps; s++) for (const c of discCells(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, hw)) out.push(c);
      }
      return out;
    };
    for (const t of this.s.traces) { const l = layerIdx(t.layer); for (const c of new Set(stampPolyline(l, t.net, t.pts, t.width / 2))) addOcc(l, t.net || "t:" + t.id, c); }
    for (const v of this.s.vias) for (const l of [0, 1]) for (const c of discCells(v.x, v.y, v.d / 2)) addOcc(l, v.net || "v:" + v.id, c);
    const cutGrow = (cut) => Math.max(0, RULES.edge - RULES.minGap) + 0.001;
    for (const cut of this.s.cutouts || []) {
      const cells = cut.shape === "circle" ? discCells(cut.x, cut.y, cut.d / 2 + cutGrow(cut)) : rectCells(cut.x - cut.w / 2 - cutGrow(cut), cut.y - cut.h / 2 - cutGrow(cut), cut.x + cut.w / 2 + cutGrow(cut), cut.y + cut.h / 2 + cutGrow(cut));
      for (const l of [0, 1]) for (const c of cells) addOcc(l, "cutout:" + cut.id, c);
    }

    // 6. which nets, in which order
    const classes = (net) => this.classOf(net);
    const netNames = new Set(this.nets().map((n) => n.name));
    const compsOf = (net) => { // connected groups of pads (through copper that already exists)
      const pads = this.allPads().filter((q) => q.net === net), par = pads.map((_, i) => i), find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const near = (q, t) => t.pts.some((p, k) => (k ? T.geom.gap({ t: "seg", a: { x: t.pts[k - 1][0], y: t.pts[k - 1][1] }, b: { x: p[0], y: p[1] }, r: t.width / 2 }, q.shape === "circle" ? { t: "circ", x: q.x, y: q.y, r: q.w / 2 } : { t: "rect", x0: q.x - q.w / 2, y0: q.y - q.h / 2, x1: q.x + q.w / 2, y1: q.y + q.h / 2 }).d <= 0.001 : false));
      for (const t of this.s.traces.filter((x) => x.net === net)) { const on = pads.map((q, i) => [q, i]).filter(([q]) => near(q, t)); for (let k = 1; k < on.length; k++) par[find(on[k][1])] = find(on[0][1]); }
      const groups = new Map(); pads.forEach((q, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(q); });
      return [...groups.values()];
    };
    const hpwl = (pads) => { const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y); return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys); };
    const jobs = infos.filter((i) => !only || only.has(i.name)).map((i) => ({ info: i, comps: compsOf(i.name) }));
    // the pour handles ground: through-hole ground pins are already on it, the rest need a via
    const todo = [];
    for (const j of jobs) {
      if (pourNet && j.info.name === pourNet) { const smd = j.info.pads.filter((q) => !q.thru); if (smd.length) todo.push({ kind: "pour", job: j, pads: smd }); continue; }
      if (j.comps.length > 1) todo.push({ kind: "net", job: j }); else report.already++;
    }
    todo.sort((x, y) => (x.kind === "pour" ? -1 : 0) - (y.kind === "pour" ? -1 : 0) || classes(y.job.info.name).width - classes(x.job.info.name).width || hpwl(x.job.info.pads) - hpwl(y.job.info.pads));

    // 7. A*
    const gS = [new Float32Array(N), new Float32Array(N)], par = [new Int32Array(N), new Int32Array(N)], seen = [new Int32Array(N), new Int32Array(N)], dirIn = [new Uint8Array(N), new Uint8Array(N)];
    let stamp = 0;
    const newTraces = [], newVias = [], failed = []; let routed = 0;
    const addCells = (l, owner, cells) => { for (const c of cells) { addOcc(l, owner, c); for (const [k, arrs] of gcount) stampCount(arrs[l], c, disc(k / 4)); } };

    function routeOne(net, sources, goalFn, hx, hy, maxExp, mode) {
      // sources: [[l,c]]; goalFn(l,c,viaArrived) → bool ; returns path [[l,c,viaAt?]] or null
      const cls = classes(net), hw = cls.width / 2, C = Math.max(cls.clearance, RULES.minGap);
      const rT = (C + hw) / g + 1, rV = (C + cls.via_d / 2) / g + 1, dT = ensureG(rT), dV = ensureG(rV);
      const ownT = [new Uint16Array(N), new Uint16Array(N)], ownV = [new Uint16Array(N), new Uint16Array(N)], ownCell = [new Uint8Array(N), new Uint8Array(N)];
      const eM = Math.ceil((RULES.edge + hw) / g), eV = Math.ceil((RULES.edge + cls.via_d / 2) / g);
      // copper of a net whose class demands MORE clearance than this one: keep the bigger distance from it too
      const extraT = [null, null], extraV = [null, null], dT2 = disc(1);
      for (let l = 0; l < L; l++) for (const [owner, cells] of occ[l]) {
        if (owner === net || !netNames.has(owner)) continue;
        const cy = Math.max(RULES.minGap, classes(owner).clearance); if (cy <= C + 1e-9) continue;
        if (!extraT[l]) { extraT[l] = new Uint8Array(N); extraV[l] = new Uint8Array(N); }
        const dt = disc((cy + hw) / g + 1), dv = disc((cy + cls.via_d / 2) / g + 1);
        for (const c of cells) { const ci = c % W, cj = (c / W) | 0; for (const [dx, dy] of dt) { const x = ci + dx, y = cj + dy; if (x >= 0 && y >= 0 && x < W && y < H) extraT[l][y * W + x] = 1; } for (const [dx, dy] of dv) { const x = ci + dx, y = cj + dy; if (x >= 0 && y >= 0 && x < W && y < H) extraV[l][y * W + x] = 1; } }
      }
      void dT2;
      for (let l = 0; l < L; l++) { const mine = occ[l].get(net) || []; for (const c of mine) { ownCell[l][c] = 1; stampCount(ownT[l], c, disc(rT)); stampCount(ownV[l], c, disc(rV)); } }
      const blockedT = (l, c) => { const i = c % W, j = (c / W) | 0; if (i < eM || j < eM || i > W - 1 - eM || j > H - 1 - eM) return true; return !ownCell[l][c] && (dT[l][c] - ownT[l][c] > 0 || (extraT[l] && extraT[l][c] === 1)); };
      const blockedV = (l, c) => { const i = c % W, j = (c / W) | 0; if (i < eV || j < eV || i > W - 1 - eV || j > H - 1 - eV) return true; return dV[l][c] - ownV[l][c] > 0 || (extraV[l] && extraV[l][c] === 1) || ownCell[l][c] === 1 && padCellOwner.has(l * N + c); };
      const viaCost = useVias ? 14 : Infinity, pourPen = pourZone ? 1.18 : 1;
      stamp++;
      const H_ = new Heap(), hs = (l, c) => { const dx = Math.abs((c % W) - hx), dy = Math.abs(((c / W) | 0) - hy); return (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)) * 0.999; };
      for (const [l, c] of sources) { if (seen[l][c] === stamp && gS[l][c] <= 0) continue; seen[l][c] = stamp; gS[l][c] = 0; par[l][c] = -1; dirIn[l][c] = 8; H_.push(hs(l, c), l * N + c); }
      let exp = 0;
      while (H_.size) {
        const s = H_.pop(), l = s >= N ? 1 : 0, c = s - l * N;
        if (goalFn(l, c, par[l][c] >= 0 && ((par[l][c] / N) | 0) !== l)) { const path = []; let cl = l, cc = c; while (cc >= 0) { path.push([cl, cc]); const p = par[cl][cc]; if (p < 0) break; cl = p >= N ? 1 : 0; cc = p - cl * N; } return path.reverse(); }
        if (++exp > maxExp) return null;
        const gc = gS[l][c], ci = c % W, cj = (c / W) | 0, din = dirIn[l][c];
        for (let d = 0; d < 8; d++) {
          const ni = ci + DIRS[d][0], nj = cj + DIRS[d][1];
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const nc = cell(ni, nj);
          if (blockedT(l, nc)) continue;
          if (d & 1) { if (blockedT(l, cell(ci + DIRS[d][0], cj)) || blockedT(l, cell(ci, cj + DIRS[d][1]))) continue; } // no squeezing diagonally between obstacles
          let step = (d & 1 ? SQ2 : 1) * (l === 1 ? pourPen : 1);
          if (din !== 8) { const turn = Math.min((d - din + 8) % 8, (din - d + 8) % 8); step += turn === 0 ? 0 : turn === 1 ? 0.35 : 1.2; }
          const ng = gc + step;
          if (seen[l][nc] !== stamp || ng < gS[l][nc] - 1e-6) { seen[l][nc] = stamp; gS[l][nc] = ng; par[l][nc] = l * N + c; dirIn[l][nc] = d; H_.push(ng + hs(l, nc), l * N + nc); }
        }
        if (viaCost < Infinity && !blockedV(l, c) && !blockedV(1 - l, c)) { // change layer here
          const o = 1 - l, ng = gc + viaCost;
          if (!blockedT(o, c) && (seen[o][c] !== stamp || ng < gS[o][c] - 1e-6)) { seen[o][c] = stamp; gS[o][c] = ng; par[o][c] = l * N + c; dirIn[o][c] = 8; H_.push(ng + hs(o, c), o * N + c); }
        }
      }
      return null;
    }
    const SQ2 = Math.SQRT2;

    // path → traces + vias (the ends sit exactly on pad centres so the connection is real)
    function emit(net, path, srcPad, dstPad, cls) {
      const pts = path.map(([l, c]) => ({ l, x: r3((c % W) * g), y: r3(((c / W) | 0) * g), c }));
      const runs = []; let cur = { l: pts[0].l, p: [[pts[0].x, pts[0].y]] };
      for (let k = 1; k < pts.length; k++) {
        const P = pts[k], Q = pts[k - 1];
        if (P.l !== Q.l) { runs.push(cur); newVias.push({ x: Q.x, y: Q.y, net, d: cls.via_d, drill: cls.via_drill, auto: true }); cur = { l: P.l, p: [[P.x, P.y]] }; }
        else cur.p.push([P.x, P.y]);
      }
      runs.push(cur);
      runs.forEach((run, ri) => {
        let p = run.p.filter((q, i) => !i || q[0] !== run.p[i - 1][0] || q[1] !== run.p[i - 1][1]);
        p = p.filter((q, i) => { if (i === 0 || i === p.length - 1) return true; const a0 = p[i - 1], b0 = p[i + 1]; return (q[0] - a0[0]) * (b0[1] - q[1]) - (q[1] - a0[1]) * (b0[0] - q[0]) !== 0; }); // keep only the corners
        if (ri === 0 && srcPad) p.unshift([srcPad.x, srcPad.y]);
        if (ri === runs.length - 1 && dstPad) p.push([dstPad.x, dstPad.y]);
        p = p.filter((q, i) => !i || Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) > 1e-6);
        if (p.length >= 2) newTraces.push({ net, layer: run.l ? "B.Cu" : "F.Cu", width: cls.width, pts: p, auto: true });
      });
    }
    const padAtCell = (l, c) => padInfo.get(padCellOwner.get(l * N + c));
    const record = (net, path, cls) => { // the new copper becomes an obstacle for the nets that follow
      const hw = cls.width / 2, byLayer = [[], []];
      path.forEach(([l, c]) => byLayer[l].push(...discCells((c % W) * g, ((c / W) | 0) * g, hw)));
      for (let l = 0; l < L; l++) addCells(l, net, [...new Set(byLayer[l])]);
      for (let k = 1; k < path.length; k++) if (path[k][0] !== path[k - 1][0]) { const c = path[k][1]; for (const l of [0, 1]) addCells(l, net, discCells((c % W) * g, ((c / W) | 0) * g, cls.via_d / 2)); }
    };

    const pri = (x) => (prio.has(x.job.info.name) ? 1 : 0);
    for (const item of todo.slice().sort((x, y) => (x.kind === "pour" ? -1 : 0) - (y.kind === "pour" ? -1 : 0) || pri(y) - pri(x) || classes(y.job.info.name).width - classes(x.job.info.name).width || hpwl(x.job.info.pads) - hpwl(y.job.info.pads))) {
      const net = item.job.info.name, cls = classes(net);
      if (item.kind === "pour") { // every surface-mount ground pin → a short stub and a via down to the pour
        for (const q of item.pads) {
          const rec = padInfo.get(q.ref), src = rec.cells.filter(([l]) => l === 0);
          const path = routeOne(net, src, (l, c, viaArr) => l === 1 && viaArr, cix(q.x), cix(q.y), 60000, "pour");
          if (!path) { failed.push({ net, from: q.ref, reason: "no room for a ground via near " + q.ref + " — free some space or move parts apart" }); continue; }
          emit(net, path, q, null, cls); record(net, path, cls); routed++;
        }
        continue;
      }
      // signal / power net: join its groups one by one (smallest group first), through copper that already exists
      let comps = item.job.comps.map((pads) => ({ pads, cells: pads.flatMap((q) => padInfo.get(q.ref).cells) }));
      let guard = 0;
      while (comps.length > 1 && guard++ < 200) {
        comps.sort((x, y) => x.pads.length - y.pads.length);
        const src = comps[0], others = comps.slice(1), goal = [new Set(), new Set()];
        for (const o of others) for (const [l, c] of o.cells) goal[l].add(c);
        // aim at the nearest pad of the other groups
        let best = null; for (const p of src.pads) for (const o of others) for (const q of o.pads) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (!best || d < best.d) best = { d, q }; }
        const path = routeOne(net, src.cells, (l, c) => goal[l].has(c), cix(best.q.x), cix(best.q.y), 400000, "net");
        if (!path) { failed.push({ net, from: src.pads[0].ref, to: best.q.ref, reason: "blocked — no clear path for " + cls.width + " mm copper (clearance " + cls.clearance + " mm) between " + src.pads[0].ref + " and " + best.q.ref }); break; }
        const first = padAtCell(path[0][0], path[0][1]), last = padAtCell(path[path.length - 1][0], path[path.length - 1][1]);
        emit(net, path, first && first.net === net ? first.pad : null, last && last.net === net ? last.pad : null, cls); record(net, path, cls); routed++;
        const hit = others.find((o) => o.cells.some(([l, c]) => l === path[path.length - 1][0] && c === path[path.length - 1][1])) || others[0];
        const newCells = path.map(([l, c]) => [l, c]);
        comps = comps.filter((x) => x !== src && x !== hit).concat([{ pads: src.pads.concat(hit.pads), cells: src.cells.concat(hit.cells, newCells) }]);
      }
    }

    return { newTraces, newVias, failed, routed };
    };
    let best = null; const prio = new Set();
    for (let pass = 0; pass < 3; pass++) {
      const r = attempt(prio);
      if (!best || r.failed.length < best.failed.length) best = r;
      if (!r.failed.length) break;
      for (const x of r.failed) prio.add(x.net);
    }
    const newTraces = best.newTraces, newVias = best.newVias;
    report.routed = best.routed; report.failed = best.failed; report.passes = Math.min(3, prio.size ? 1 + (best.failed.length ? 2 : 0) : 1);
    // 8. write the copper
    for (const t of newTraces) this.s.traces.push(Object.assign({ id: this.nextId("t") }, t, { pts: t.pts.map(([x, y]) => [r3(x), r3(y)]) }));
    for (const v of newVias) this.s.vias.push(Object.assign({ id: this.nextId("v") }, v));
    const drc = this.cmd_drc();
    return Object.assign(report, { traces_added: newTraces.length, vias_added: newVias.length, grid_mm: r3(gridUsed), seconds: r3((Date.now() - t0) / 1000), drc_errors: drc.errors.length, drc_first: drc.errors.slice(0, 3).map((e) => e.msg), note: report.failed.length ? report.failed.length + " connection(s) could not be routed — see failed[]; usually moving a part or widening the board fixes it" : "every connection has copper", _focus: { x: BW / 2, y: BH / 2, label: "autoroute" } });
  };

  // ---------------------------------------------------------------- "what settings give me exactly this trace?"
  B.specFor = function (net, widthNow, layerNow, lengthNow) {
    const A = T.analyze(this), cls = this.classOf(net), R = this.rulesState();
    const rail = A.rails.find((r) => String(r.net).split(" + ").includes(net)), amps = rail ? rail.amps || 0 : 0;
    const need = amps > 0 ? T.widthFor(amps, 10) : 0, rec = Math.max(cls.width, amps > 0 ? up05(T.widthFor(amps * 1.25, 10)) : cls.width);
    const info = this.netInfo(net), w = widthNow || cls.width, L = lengthNow || 0;
    const rMohm = L > 0 ? ((RHO * (L / 1000)) / ((w / 1000) * T_CU)) * 1000 : 0;
    const out = { net, kind: info.kind, class: cls.name, class_width_mm: cls.width, clearance_mm: Math.max(cls.clearance, RULES.minGap), via_d_mm: cls.via_d, via_drill_mm: cls.via_drill,
      current_a: r3(amps), min_width_for_current_mm: r3(need), recommended_width_mm: rec, width_now_mm: w, layer: layerNow || "F.Cu", copper: "1 oz (35 µm) outer layer",
      resistance_mohm: r3(rMohm), drop_mv: r3(rMohm * amps), margin: need > 0 ? r3(w / need) : null, ok_for_current: w + 1e-9 >= need, matches_class: Math.abs(w - cls.width) < 1e-9, notes: [], steps: [] };
    const pad0 = info.pads.reduce((m, q) => Math.min(m, q.w, q.h), Infinity);
    if (out.ok_for_current === false) out.notes.push(`TOO THIN: ${w} mm cannot carry ${out.current_a} A — IPC-2221 needs at least ${out.min_width_for_current_mm} mm (10 °C rise).`);
    if (isFinite(pad0) && w > pad0 + 1e-9) out.notes.push(`The trace (${w} mm) is wider than the narrowest pad on this net (${r3(pad0)} mm): neck it down to ${r3(Math.max(RULES.minTrace, Math.min(w, pad0)))} mm for the last 1 mm where it meets that pad.`);
    if (info.usb) out.notes.push("USB data pair: route D+ and D− side by side, same length (within 2 mm), same layer, 0.2–0.3 mm apart, no stubs. Keep them away from noisy power traces.");
    if (info.ground && this.s.zones && this.s.zones.some((z) => z.net === net)) out.notes.push("Ground is a copper pour on " + this.s.zones.find((z) => z.net === net).layer + ": each pin only needs a short stub + via — the pour carries the current.");
    if (info.power && amps === 0) out.notes.push("No current computed yet (no source connected) — the width above is only the class default.");
    out.steps = [`Layer: ${out.layer}`, `Width: ${out.recommended_width_mm} mm${out.recommended_width_mm !== cls.width ? " (more than class " + cls.name + " gives — raise the class)" : ` (class ${cls.name})`}`,
      `Clearance to other copper: ≥ ${out.clearance_mm} mm`, `Via: ⌀${out.via_d_mm} mm, drill ${out.via_drill_mm} mm`, "Corners: 45° (never 90°), no sharp spurs", `Command: rule_class name="${cls.name}" width=${out.recommended_width_mm} clearance=${out.clearance_mm}; rule_assign net=${net} class="${cls.name}"; apply_rules`];
    return out;
  };
  B.cmd_explain_trace = function (a) {
    this.need(a, "id");
    const t = this.s.traces.find((x) => x.id === a.id);
    if (!t) throw new Error(`no trace ${a.id}`);
    const len = this.traceLength(t), spec = this.specFor(t.net, t.width, t.layer, len);
    // how close is the nearest foreign copper? (the clearance this trace really has)
    let nearest = Infinity;
    const seg = (p, q, r) => ({ t: "seg", a: { x: p[0], y: p[1] }, b: { x: q[0], y: q[1] }, r });
    for (const o of this.s.traces) if (o.net !== t.net && o.layer === t.layer) for (let i = 1; i < t.pts.length; i++) for (let j = 1; j < o.pts.length; j++) nearest = Math.min(nearest, T.geom.gap(seg(t.pts[i - 1], t.pts[i], t.width / 2), seg(o.pts[j - 1], o.pts[j], o.width / 2)).d);
    for (const q of this.allPads()) if (q.net !== t.net && (q.thru || t.layer === "F.Cu")) for (let i = 1; i < t.pts.length; i++) nearest = Math.min(nearest, T.geom.gap(seg(t.pts[i - 1], t.pts[i], t.width / 2), q.shape === "circle" ? { t: "circ", x: q.x, y: q.y, r: q.w / 2 } : { t: "rect", x0: q.x - q.w / 2, y0: q.y - q.h / 2, x1: q.x + q.w / 2, y1: q.y + q.h / 2 }).d);
    spec.length_mm = r3(len); spec.nearest_clearance_mm = isFinite(nearest) ? r3(Math.max(0, nearest)) : null; spec.id = t.id; spec.router = !!t.auto;
    return spec;
  };
  B.cmd_explain_net = function (a) {
    this.need(a, "net");
    if (!this.nets().some((n) => n.name === a.net)) throw new Error(`no net "${a.net}"`);
    const info = this.netInfo(a.net), cls = this.classOf(a.net);
    return Object.assign(this.specFor(a.net, cls.width, "F.Cu", 0), { pads: info.pads.map((q) => q.ref), routed: this.s.traces.some((t) => t.net === a.net) });
  };

  U.autoroute = "autoroute [net=A,B] [vias=0] [pour=auto|off|<net>] [ripup=0] [classes=off] [grid=0.1]  — route every airwire with real copper: 45° traces, wire-class widths and clearances, vias only when needed, ground via a pour on B.Cu. Returns what failed and why.";
  U.clear_routes = "clear_routes [net=A,B] [all=1]  — remove the traces/vias the router made (all=1: every trace)";
  U.add_pour = "add_pour [net=GND] [layer=B.Cu]  — copper pour (ground plane); every pin of that net gets a via to it";
  U.suggest_rules = "suggest_rules  — the trace width every net really needs (from its current, IPC-2221) and which wire class fits";
  U.apply_suggested_rules = "apply_suggested_rules  — create/assign the wire classes suggest_rules proposes, then re-width existing traces";
  U.explain_trace = "explain_trace id=<t12>  — the exact settings behind a trace: class, width, clearance, via size, current, resistance, margin, notes";
  U.explain_net = "explain_net net=<VBUS>  — the settings a trace on this net should have";
  for (const c of ["autoroute", "clear_routes", "add_pour", "apply_suggested_rules"]) M.add(c);
})(typeof window !== "undefined" ? window : globalThis);
