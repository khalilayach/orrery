// TRACE placer — puts parts where an engineer would, so the wiring is short and the board can be soldered.
//   • connectors and switches go on the board edge, facing outward (the USB-C mouth points out of the board)
//   • decoupling / load capacitors sit right at the IC pin they serve
//   • related parts end up near each other (force-directed on the real nets), nothing touches, with room for an iron
//   • 2-pin parts are turned whichever way gives the shortest wiring
// `autoplace` removes the copper that was routed before (positions change); run `autoroute` afterwards.
(function (root) {
  "use strict";
  const T = root.TraceEngine, B = T.Board.prototype, { RULES, defOf, PARTS } = T, U = T.USAGE, M = T.MUTATING;
  const r2 = (n) => Math.round(n * 100) / 100;
  const isGnd = (n) => /^(gnd|agnd|dgnd|pgnd|vss|0v)\w*$/i.test(n || "");
  const rng = (seed) => { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

  B.assemblyGap = function () { return (this.s.assembly || "hand") === "reflow" ? 0.5 : 0.9; }; // mm kept between parts: room for an iron by hand
  B.cmd_set_assembly = function (a) {
    const m = String(a.mode || "").toLowerCase();
    if (m !== "hand" && m !== "reflow") throw new Error("mode must be hand (soldering iron) or reflow (hot air / oven / assembly service)");
    this.s.assembly = m;
    return { assembly: m, min_gap_mm: this.assemblyGap(), note: m === "hand" ? "parts keep ≥ 0.9 mm apart and the review flags packages that are hard to hand-solder" : "tighter spacing; the review still flags parts with pads hidden under the body" };
  };

  B.cmd_autoplace = function (a) {
    const b = this, { w: BW, h: BH } = this.s.board, gap = a.gap !== undefined ? Number(a.gap) : this.assemblyGap(), rand = rng(Number(a.seed) || 7);
    const pinned = new Set(String(a.pin || "").split(",").map((x) => x.trim()).filter(Boolean));
    const parts = this.s.parts.filter((p) => !/^H\d/.test(p.ref) && p.type !== "hole");
    if (!parts.length) throw new Error("nothing to place");
    const margin = RULES.edge + 0.4;
    const pos = new Map(parts.map((p) => [p.ref, { x: p.x, y: p.y, rot: p.rot }]));
    const free = parts.filter((p) => !pinned.has(p.ref));
    const ext = (p, rot) => b.courtyard({ type: p.type, rot, ref: p.ref, x: 0, y: 0, nets: {} }, {});          // courtyard relative to the part origin
    const box = (p, at) => { const e = ext(p, at.rot); return { x0: at.x + e.x0, y0: at.y + e.y0, x1: at.x + e.x1, y1: at.y + e.y1 }; };
    const inside = (c) => c.x0 >= margin - 1e-6 && c.y0 >= margin - 1e-6 && c.x1 <= BW - margin + 1e-6 && c.y1 <= BH - margin + 1e-6;
    const overlap = (A, C, m) => A.x0 < C.x1 + m && A.x1 > C.x0 - m && A.y0 < C.y1 + m && A.y1 > C.y0 - m;
    const kindOf = (p) => T.elecOf(p).kind;

    // nets as lists of {ref, pad}
    const partByRef = new Map(this.s.parts.map((p) => [p.ref, p]));
    const nets = new Map();
    for (const p of parts) for (const q of this.pads(p)) if (q.net) { if (!nets.has(q.net)) nets.set(q.net, []); nets.get(q.net).push({ ref: p.ref, pad: q }); }
    const offCache = new Map();
    const padOffs = (p, rot) => { const k = p.type + "|" + rot; if (!offCache.has(k)) offCache.set(k, this.pads({ type: p.type, ref: p.ref, x: 0, y: 0, rot, nets: p.nets })); return offCache.get(k); };
    const padAt = (p, at) => padOffs(p, at.rot).map((q) => Object.assign({}, q, { x: q.x + at.x, y: q.y + at.y }));
    const wlOver = (netMap) => { // half-perimeter wirelength, ground/power weighted down
      let tot = 0;
      for (const [net, list] of netMap) {
        if (list.length < 2) continue;
        const xs = [], ys = [];
        for (const it of list) { const p = partByRef.get(it.ref), at = pos.get(it.ref) || { x: p.x, y: p.y, rot: p.rot }, q = padOffs(p, at.rot).find((z) => z.n === it.pad.n); xs.push(q.x + at.x); ys.push(q.y + at.y); }
        const v = (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) * (isGnd(net) ? 0.15 : 1); tot += v; if (wlOver.detail) wlOver.detail.push([net, r2(v)]);
      }
      return tot;
    };
    let netsLive = nets;                       // the nets as the optimiser sees them (satellite capacitors are left out until they are placed)
    const wl = () => wlOver(netsLive);
    const before = wlOver(nets), report = { edge: {}, anchored: [], rotated: [] };

    // 1. connectors on the edge, facing outward
    const isRF = (p) => !!defOf(p.type).keepout || /esp32|wroom|mini-1|nrf52|antenna/i.test(defOf(p.type).label + " " + p.value + " " + ((p.buy && p.buy.mpn) || ""));
    const edgePart = (p) => ["connector", "source"].includes(kindOf(p)) || /^(J|SW|BT|P)\d/.test(p.ref) || isRF(p);
    const side = new Map();
    const edgeParts = free.filter(edgePart);
    const rotFor = (p, sd) => (isRF(p) ? 0 : p.type === "usbc" ? { left: 0, top: 90, right: 180, bottom: 270 }[sd] : p.type === "header" || p.type === "battery" ? (sd === "left" || sd === "right" ? 0 : 90) : pos.get(p.ref).rot);
    for (const p of edgeParts.filter(isRF)) { // an RF module sits on the top edge, antenna end pointing out of the board
      const at = pos.get(p.ref), e = ext(p, 0);
      pos.set(p.ref, { rot: 0, x: Math.min(BW - margin - e.x1, Math.max(margin - e.x0, BW / 2)), y: margin - e.y0 }); side.set(p.ref, "top"); report.edge[p.ref] = "top";
    }
    const edgeSet = new Set(edgeParts.map((p) => p.ref));

    // spread: use the board — the clusters keep their shape but spread out to fill it, which leaves room to route and to solder
    const spread = () => {
      const core = live.filter((p) => !edgeSet.has(p.ref) && !pinned.has(p.ref));
      if (core.length < 2) return;
      const bs = core.map((p) => box(p, pos.get(p.ref))), x0 = Math.min(...bs.map((q) => q.x0)), x1 = Math.max(...bs.map((q) => q.x1)), y0 = Math.min(...bs.map((q) => q.y0)), y1 = Math.max(...bs.map((q) => q.y1));
      const edgeW = [...side.values()].some((v) => v === "left") ? 9 : 0, edgeE = [...side.values()].some((v) => v === "right") ? 9 : 0, edgeN = [...side.values()].some((v) => v === "top") ? 9 : 0, edgeS = [...side.values()].some((v) => v === "bottom") ? 9 : 0;
      const ax0 = margin + 1 + edgeW, ax1 = BW - margin - 1 - edgeE, ay0 = margin + 1 + edgeN, ay1 = BH - margin - 1 - edgeS;
      const kx = Math.min(1.12, Math.max(1, ((ax1 - ax0) * 0.92) / Math.max(1, x1 - x0))), ky = Math.min(1.12, Math.max(1, ((ay1 - ay0) * 0.92) / Math.max(1, y1 - y0)));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, tx = (ax0 + ax1) / 2, ty = (ay0 + ay1) / 2;
      for (const p of core) { const at = pos.get(p.ref), e = ext(p, at.rot); at.x = Math.min(BW - margin - e.x1, Math.max(margin - e.x0, tx + (at.x - cx) * kx)); at.y = Math.min(BH - margin - e.y1, Math.max(margin - e.y0, ty + (at.y - cy) * ky)); }
    };
    // satellites: capacitors that belong to an IC / regulator pin — placed after the big parts have settled
    const capsAll = free.filter((p) => this.pads(p).length === 2 && (kindOf(p) === "capacitor" || /^C\d/.test(p.ref)));
    const hostsOf = (c) => {
      const nets2 = this.pads(c).map((q) => q.net), gNet = nets2.find((n) => n && (isGnd(n) || this.netInfo(n).ground)), pNet = nets2.find((n) => n && n !== gNet);
      if (!pNet) return [];
      return (nets.get(pNet) || []).filter((it) => it.ref !== c.ref && ["ic", "regulator"].includes(kindOf(this.findPart(it.ref))));
    };
    const satellites = new Set(capsAll.filter((c) => hostsOf(c).length).map((c) => c.ref));
    const live = parts.filter((p) => !satellites.has(p.ref));           // parts that take part in the relaxation
    netsLive = new Map([...nets].map(([k, v]) => [k, v.filter((it) => !satellites.has(it.ref))]));
    // 2. build the layout part by part: the one most connected to what is already placed goes next, at the legal spot with the shortest wiring
    const movers = free.filter((p) => !edgeSet.has(p.ref) && !satellites.has(p.ref));
    const placed = new Set([...pinned, ...[...side.keys()]]);
    const netsOf = new Map(parts.map((p) => [p.ref, []]));
    for (const [net, list] of netsLive) { const refs = [...new Set(list.map((l) => l.ref))]; if (refs.length > 1) for (const r of refs) netsOf.get(r).push(net); }
    const padXY = (it, cand) => { const p = partByRef.get(it.ref), at = cand && cand.ref === it.ref ? cand.at : pos.get(it.ref), q = padOffs(p, at.rot).find((z) => z.n === it.pad.n); return [q.x + at.x, q.y + at.y]; };
    const costOf = (ref, at) => { // wiring of this part's nets to the parts placed so far
      let tot = 0; const cand = { ref, at };
      for (const net of netsOf.get(ref)) {
        const pts = netsLive.get(net).filter((it) => it.ref === ref || placed.has(it.ref)).map((it) => padXY(it, cand));
        if (pts.length < 2) continue;
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        tot += (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) * (isGnd(net) ? 0.15 : 1);
      }
      return tot;
    };
    const pull = (ref) => { // where the already-placed parts it talks to are
      const xs = [], ys = [];
      for (const net of netsOf.get(ref)) for (const it of netsLive.get(net)) if (it.ref !== ref && placed.has(it.ref)) { const q = padXY(it); xs.push(q[0]); ys.push(q[1]); }
      return xs.length ? { x: xs.reduce((u, v) => u + v, 0) / xs.length, y: ys.reduce((u, v) => u + v, 0) / ys.length, n: xs.length } : null;
    };
    const room = 1.4;                          // extra breathing room while building the layout: the satellite capacitors and the traces need space beside the pins
    const legalNow = (p, q) => { const c = box(p, q); if (!inside(c)) return false; for (const o of parts) if (o.ref !== p.ref && placed.has(o.ref) && overlap(c, box(o, pos.get(o.ref)), gap + room)) return false; return true; };
    const placeBest = (p) => {
      let target = null; // a satellite capacitor wants to be near its supply pin, whatever the bounding box of the net says
      if (satellites.has(p.ref)) { const hs = hostsOf(p).sort((x, y) => (y.pad.role === "power_in" ? 1 : 0) - (x.pad.role === "power_in" ? 1 : 0)); if (hs.length) { const q = padXY(hs[0]); target = { x: q[0], y: q[1] }; } }
      const want = target || pull(p.ref) || { x: BW / 2, y: BH / 2 }, rots = this.pads(p).length === 2 ? [0, 90, 180, 270] : [pos.get(p.ref).rot];
      let best = null;
      for (let R = 4; R <= Math.max(BW, BH) * 1.2 && !best; R += 6) {
        for (let dy = -R; dy <= R; dy += 0.5) for (let dx = -R; dx <= R; dx += 0.5) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < R - 6 && R > 4) continue; // only the new ring
          for (const rot of rots) {
            const q = { x: Math.round((want.x + dx) * 4) / 4, y: Math.round((want.y + dy) * 4) / 4, rot };
            if (!legalNow(p, q)) continue;
            const v = target ? Math.hypot(dx, dy) * 3 + costOf(p.ref, q) * 0.1 : costOf(p.ref, q) + 0.02 * Math.hypot(dx, dy);
            if (!best || v < best.v) best = { v, q };
          }
        }
      }
      if (!best) throw new Error(`there is no room for ${p.ref} on a ${BW}×${BH} mm board — make the board bigger (set_board)`);
      pos.set(p.ref, best.q); placed.add(p.ref);
    };
    const used = new Map(), anchoredSet = new Set(), anchoredHost = new Map(), sat = [...satellites].map((r) => this.findPart(r));
    const legalTight = (p, q) => { const c = box(p, q); if (!inside(c)) return false; for (const o of parts) if (o.ref !== p.ref && placed.has(o.ref) && overlap(c, box(o, pos.get(o.ref)), gap)) return false; return true; };
    const anchorSat = (c, onlyHost) => { // put capacitor c right beside the supply pin it serves
      if (anchoredSet.has(c.ref)) return true;
      const hosts = hostsOf(c).filter((h) => !onlyHost || h.ref === onlyHost).sort((x, y) => (y.pad.role === "power_in" ? 1 : 0) - (x.pad.role === "power_in" ? 1 : 0) || (used.get(x.pad.ref) || 0) - (used.get(y.pad.ref) || 0));
      for (const it of hosts) {
        const hp = partByRef.get(it.ref), hat = pos.get(hp.ref), hq = padAt(hp, hat).find((z) => z.n === it.pad.n), hc = box(hp, hat);
        let dx = hq.x - (hc.x0 + hc.x1) / 2, dy = hq.y - (hc.y0 + hc.y1) / 2; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
        for (let r = 0.2; r <= 7; r += 0.4) for (const rot of [0, 90]) for (const off of [0, 1.1, -1.1, 2.2, -2.2, 3.3, -3.3]) {
          const ec = ext(c, rot), half = Math.max(ec.x1 - ec.x0, ec.y1 - ec.y0) / 2, nx = -dy, ny = dx;
          const at = { x: Math.round((hq.x + dx * (half + r + hq.w / 2) + nx * off) * 4) / 4, y: Math.round((hq.y + dy * (half + r + hq.h / 2) + ny * off) * 4) / 4, rot };
          if (legalTight(c, at)) { pos.set(c.ref, at); placed.add(c.ref); anchoredSet.add(c.ref); anchoredHost.set(c.ref, it.ref); used.set(it.pad.ref, (used.get(it.pad.ref) || 0) + 1); report.anchored.push(c.ref + " → " + it.pad.ref); return true; }
        }
      }
      return false;
    };
    const anchorFor = (hostRef) => { for (const c of sat) if (hostsOf(c).some((h) => h.ref === hostRef)) anchorSat(c, hostRef); };
    for (const ref of [...placed]) anchorFor(ref);  // the pinned parts and the RF module are already there
    const left = movers.slice();
    while (left.length) {
      left.sort((x, y) => (pull(y.ref) ? pull(y.ref).n : -1) - (pull(x.ref) ? pull(x.ref).n : -1) || (box(y, pos.get(y.ref)).x1 - box(y, pos.get(y.ref)).x0) * (box(y, pos.get(y.ref)).y1 - box(y, pos.get(y.ref)).y0) - (box(x, pos.get(x.ref)).x1 - box(x, pos.get(x.ref)).x0) * (box(x, pos.get(x.ref)).y1 - box(x, pos.get(x.ref)).y0));
      const next = left.shift(); placeBest(next); anchorFor(next.ref);
    }
    // every edge part (connectors, switches, headers) picks the side and the spot along it with the shortest wiring; a second pass lets them settle
    const placeEdge = (p, onlySide) => {
      if ([...anchoredHost.values()].includes(p.ref)) { placed.add(p.ref); return; } // a part that already carries its capacitors stays where it is
      const sides = onlySide ? [onlySide] : ["left", "right", "top", "bottom"], was = pos.get(p.ref); let best = null;
      placed.delete(p.ref);
      for (const sd of sides) {
        const rot = rotFor(p, sd), e = ext(p, rot), horizontal = sd === "top" || sd === "bottom";
        const fx = sd === "left" ? margin - e.x0 : sd === "right" ? BW - margin - e.x1 : 0, fy = sd === "top" ? margin - e.y0 : sd === "bottom" ? BH - margin - e.y1 : 0, mid = (horizontal ? BW : BH) / 2;
        for (let t = 0; t <= (horizontal ? BW : BH); t += 0.5) {
          const q = horizontal ? { x: t, y: fy, rot } : { x: fx, y: t, rot };
          if (!legalNow(p, q)) continue;
          const v = costOf(p.ref, q) + 0.004 * Math.abs(t - mid) + (side.get(p.ref) === sd ? 0 : 0.3);
          if (!best || v < best.v - 1e-9) best = { v, q, sd };
        }
      }
      if (!best) { pos.set(p.ref, was); throw new Error(`there is no room on the edge for ${p.ref} — make the board bigger (set_board)`); }
      pos.set(p.ref, best.q); side.set(p.ref, best.sd); report.edge[p.ref] = best.sd; placed.add(p.ref);
    };
    const edgeOrder = edgeParts.filter((p) => !isRF(p)).sort((x, y) => (netsOf.get(y.ref).length || 0) - (netsOf.get(x.ref).length || 0));
    for (const p of edgeOrder) placeEdge(p);
    for (let pass = 0; pass < 2; pass++) for (const p of edgeParts) placeEdge(p, side.get(p.ref));
    // make the layout legal (nothing overlaps, everything inside, room for the iron) before optimising: the optimiser only takes legal moves
    const legalise = (list) => {
      const order = list.slice().sort((x, y) => { const ax = box(x, pos.get(x.ref)), ay = box(y, pos.get(y.ref)); return (ay.x1 - ay.x0) * (ay.y1 - ay.y0) - (ax.x1 - ax.x0) * (ax.y1 - ax.y0); });
      const done = [];
      for (const p of order) {
        let at = pos.get(p.ref);
        const ok = (q) => { const c = box(p, q); return inside(c) && !done.some((o) => overlap(c, o.c, gap)); };
        if (!ok(at)) {
          let found = null;
          for (let r = 0.5; r < Math.max(BW, BH) && !found; r += 0.5) for (let k = 0; k < 24 && !found; k++) { const ang = (k / 24) * Math.PI * 2, q = { x: Math.round((at.x + Math.cos(ang) * r) * 4) / 4, y: Math.round((at.y + Math.sin(ang) * r) * 4) / 4, rot: at.rot }; if (ok(q)) found = q; }
          if (!found) throw new Error(`there is no room for ${p.ref} on a ${BW}×${BH} mm board — make the board bigger (set_board)`);
          pos.set(p.ref, found); at = found;
        }
        done.push({ ref: p.ref, c: box(p, at) });
      }
      return done;
    };
    legalise(live);
    // refine: simulated annealing on the real wirelength; a move is only taken when nothing overlaps and everything stays on the board
    {
      const hostsWithCaps = new Set(anchoredHost.values()), liveAll = parts.filter((p) => !satellites.has(p.ref) || anchoredSet.has(p.ref));
      const sa = live.filter((p) => !pinned.has(p.ref) && !hostsWithCaps.has(p.ref));
      const t0 = Date.now(), budget = Number(a.seconds) > 0 ? Number(a.seconds) * 1000 : 1500, iters2 = Number(a.moves) || 6000;
      let cost = wl(), T0 = Math.max(0.5, cost * 0.004), acc = 0, tried = 0; const cost0 = cost;
      const legal = (p, q) => { const c = box(p, q); if (!inside(c)) return false; for (const o of liveAll) if (o.ref !== p.ref && overlap(c, box(o, pos.get(o.ref)), gap + room * 0.6)) return false; return true; };
      for (let it = 0; it < iters2 && Date.now() - t0 < budget && sa.length > 1; it++) {
        const Tmp = T0 * (1 - it / iters2), p = sa[Math.floor(rand() * sa.length)], old = pos.get(p.ref);
        let q;
        const r = rand();
        if (edgeSet.has(p.ref)) { const sd = side.get(p.ref), j = (rand() - 0.5) * 12 * (1 - it / iters2) + (rand() - 0.5); q = sd === "left" || sd === "right" ? { x: old.x, y: old.y + j, rot: old.rot } : { x: old.x + j, y: old.y, rot: old.rot }; }
        else if (r < 0.22 && sa.length > 2) { // swap two parts
          const o = sa[Math.floor(rand() * sa.length)]; if (o === p || edgeSet.has(o.ref)) continue;
          const oo = pos.get(o.ref), np = { x: oo.x, y: oo.y, rot: old.rot }, no = { x: old.x, y: old.y, rot: oo.rot };
          pos.set(p.ref, np); pos.set(o.ref, no);
          if (legal(p, np) && legal(o, no)) { const c2 = wl(); if (c2 < cost || rand() < Math.exp((cost - c2) / Math.max(Tmp, 1e-6))) { cost = c2; continue; } }
          pos.set(p.ref, old); pos.set(o.ref, oo); continue;
        }
        else if (r < 0.34 && this.pads(p).length === 2) q = { x: old.x, y: old.y, rot: (old.rot + 90) % 360 };
        else { const rad = 0.5 + 9 * (1 - it / iters2); q = { x: old.x + (rand() - 0.5) * 2 * rad, y: old.y + (rand() - 0.5) * 2 * rad, rot: old.rot }; }
        const e = ext(p, q.rot); q.x = Math.min(BW - margin - e.x1, Math.max(margin - e.x0, q.x)); q.y = Math.min(BH - margin - e.y1, Math.max(margin - e.y0, q.y));
        if (edgeSet.has(p.ref)) { const sd = side.get(p.ref); if (sd === "left" || sd === "right") q.x = old.x; else q.y = old.y; }
        pos.set(p.ref, q); tried++;
        if (legal(p, q)) { const c2 = wl(); if (c2 < cost || rand() < Math.exp((cost - c2) / Math.max(Tmp, 1e-6))) { cost = c2; acc++; continue; } }
        pos.set(p.ref, old);
      }
      report.annealing = { cost_before: r2(cost0), cost_after: r2(cost), moves_tried: tried, moves_taken: acc };
    }
    // 3. capacitors that found no seat beside their pin: the best legal spot for their wiring
    const anchored = anchoredSet;
    netsLive = nets;
    for (const c of sat.filter((q) => !anchoredSet.has(q.ref))) { placed.delete(c.ref); placeBest(c); }

    netsLive = nets; // the satellites are placed now: count them again
    // 4. legalise again with the satellites in
    const settled = legalise(parts);

    // 5. turn 2-pin parts the way that shortens the wiring
    for (const p of free.filter((q) => this.pads(q).length === 2 && !anchored.has(q.ref) && !edgeSet.has(q.ref))) {
      const at0 = pos.get(p.ref); let best = { at: at0, v: wl() };
      for (const rot of [0, 90, 180, 270]) { if (rot === at0.rot) continue; const cand = { x: at0.x, y: at0.y, rot }; pos.set(p.ref, cand); const c = box(p, cand); const ok = inside(c) && !settled.some((o) => o.ref !== p.ref && overlap(c, o.c, gap)); const v = ok ? wl() : Infinity; if (v < best.v - 1e-6) best = { at: cand, v }; }
      pos.set(p.ref, best.at); if (best.at.rot !== at0.rot) { report.rotated.push(p.ref); const i = settled.findIndex((o) => o.ref === p.ref); if (i >= 0) settled[i].c = box(p, best.at); }
    }

    // 6. write it down (the old copper no longer fits the new positions)
    const keep = a.keep === true || a.keep === 1 || a.keep === "1";
    let ripped = null;
    if (!keep) ripped = this.cmd_clear_routes({ all: 1 });
    let moved = 0;
    for (const p of parts) { const at = pos.get(p.ref); if (Math.abs(at.x - p.x) > 1e-6 || Math.abs(at.y - p.y) > 1e-6 || at.rot !== p.rot) { moved++; if (keep) this._reposition(p, () => { p.x = at.x; p.y = at.y; p.rot = at.rot; }); else { p.x = Math.round(at.x * 1000) / 1000; p.y = Math.round(at.y * 1000) / 1000; p.rot = at.rot; } } }
    wlOver.detail = []; const after = wlOver(nets); report.longest_nets = wlOver.detail.sort((x, y) => y[1] - x[1]).slice(0, 5).map(([n, v]) => n + " " + v + " mm"); wlOver.detail = null;
    return Object.assign(report, { moved, wirelength_before_mm: r2(before), wirelength_after_mm: r2(after), copper_removed: ripped, min_gap_mm: gap, note: "run autoroute next — the old copper was removed because the parts moved", _focus: { x: BW / 2, y: BH / 2, label: "autoplace" } });
  };
  U.autoplace = "autoplace [pin=U1,J1] [gap=0.9] [keep=1] [seed=7]  — engineer-style placement: connectors on the edge facing out, decoupling caps at their IC pin, related parts together, room for a soldering iron. Removes old copper (keep=1 drags it along instead). Then run autoroute.";
  U.set_assembly = "set_assembly mode=hand|reflow  — hand: ≥0.9 mm between parts and hard-to-solder packages are flagged; reflow: tighter";
  M.add("autoplace"); M.add("set_assembly");
})(typeof window !== "undefined" ? window : globalThis);
