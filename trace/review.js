// TRACE engineer review — the checks a senior engineer does before sending a board out, beyond voltage and current.
//   power pins   every supply and ground pin connected; decoupling capacitors close to the pins they serve
//   supply       regulator input / output capacitors; USB, I²C, reset pins done properly
//   layout       connectors on the edge facing out, crystals with load capacitors, antenna keep-out, ground pour
//   soldering    parts too close for an iron, pads hidden under the body, tiny packages, fine pitch
// Each finding says what is wrong, why it matters, and the fix. `review` returns them; the UI lists them.
(function (root) {
  "use strict";
  const T = root.TraceEngine, B = T.Board.prototype, { RULES, defOf } = T, U = T.USAGE;
  const r1 = (n) => Math.round(n * 10) / 10;
  const isGnd = (n) => /^(gnd|agnd|dgnd|pgnd|vss|0v)\w*$/i.test(n || "");
  const GND_PIN = /^(gnd|vss|agnd|dgnd|ep|pad|thermal)/i, PWR_PIN = /^(vdd|vcc|v\+|3v3|5v|vbus|vin|avdd|dvdd|vddio|vbat)/i;
  const SIDE_ROT = { left: 0, top: 90, right: 180, bottom: 270 };

  B.review = function (A, drcRes) {
    const b = this, S = this.s, { w: BW, h: BH } = S.board, out = [];
    A = A || T.analyze(this); drcRes = drcRes || this.cmd_drc();
    const mode = S.assembly || "hand", hand = mode === "hand";
    let seq = 0;
    const add = (level, cat, code, msg, fix, extra) => out.push(Object.assign({ id: "r" + ++seq, level, cat, code, msg, fix: fix || "", refs: [], net: "" }, extra || {}));
    const kind = (p) => T.elecOf(p).kind;
    const padsOf = (p) => b.pads(p);
    const parts = S.parts.filter((p) => !/^H\d/.test(p.ref) && p.type !== "hole");
    const cap = (p) => kind(p) === "capacitor" || /^C\d/.test(p.ref);
    const capValue = (p) => { const v = T.parseValue(String(p.value)); return Number.isFinite(v) ? v : null; };
    const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y);
    const netPads = new Map();
    for (const q of b.allPads()) if (q.net) { if (!netPads.has(q.net)) netPads.set(q.net, []); netPads.get(q.net).push(q); }
    const partOf = (ref) => b.findPart(ref.split(".")[0]);
    const body = (p) => { const c = b.courtyard(p); return { x0: c.x0 + 0.25, y0: c.y0 + 0.25, x1: c.x1 - 0.25, y1: c.y1 - 0.25 }; };

    // ---- 1. every supply and ground pin connected
    for (const p of parts) {
      if (!["ic", "regulator"].includes(kind(p))) continue;
      const pads = padsOf(p), gnd = pads.filter((q) => !q.net && (q.role === "ground" || GND_PIN.test(q.fn || ""))), pwr = pads.filter((q) => !q.net && (q.role === "power_in" || PWR_PIN.test(q.fn || "")));
      const hasAny = pads.some((q) => q.net);
      if (!hasAny) continue; // a part nothing is wired to yet is reported by the analyser
      if (pwr.length) add("danger", "power", "power_pin_open", `${p.ref}: supply pin${pwr.length > 1 ? "s" : ""} ${pwr.slice(0, 5).map((q) => q.fn || q.n).join(", ")}${pwr.length > 5 ? "…" : ""} ${pwr.length > 1 ? "are" : "is"} not connected.`, "Every supply pin of a chip must be tied to its supply rail — a floating supply pin makes the chip behave unpredictably.", { refs: [p.ref], x: pwr[0].x, y: pwr[0].y });
      if (gnd.length) add(gnd.length > 2 ? "warning" : "info", "power", "ground_pin_open", `${p.ref}: ${gnd.length} ground pin${gnd.length > 1 ? "s" : ""} not connected (${gnd.slice(0, 4).map((q) => q.fn || q.n).join(", ")}${gnd.length > 4 ? "…" : ""}).`, "Tie every ground pin to GND — they carry return current and heat away. On a ground pour just add a via beside each.", { refs: [p.ref], x: gnd[0].x, y: gnd[0].y });
    }

    // ---- 2. decoupling capacitors: present and close
    for (const p of parts) {
      if (!["ic", "regulator"].includes(kind(p))) continue;
      const seenNets = new Set();
      for (const q of padsOf(p).filter((z) => z.net && (z.role === "power_in" || PWR_PIN.test(z.fn || "")))) {
        if (seenNets.has(q.net)) continue; seenNets.add(q.net);
        const onNet = (netPads.get(q.net) || []).map((z) => ({ z, part: partOf(z.ref) })).filter((c) => c.part && c.part.ref !== p.ref && cap(c.part));
        for (const c of onNet) { const other = padsOf(c.part).find((y) => y.ref !== c.z.ref); if (other && !other.net) add("warning", "decoupling", "cap_open", `${c.part.ref} is on ${q.net} but its other pin isn't connected to anything.`, "A decoupling capacitor needs its second pin on GND, otherwise it does nothing.", { refs: [c.part.ref], net: q.net, x: other.x, y: other.y }); }
        const caps = onNet.filter((c) => { const other = padsOf(c.part).find((y) => y.ref !== c.z.ref); return other && other.net && (isGnd(other.net) || b.netInfo(other.net).ground); });
        const mine = padsOf(p).filter((z) => z.net === q.net);
        if (!caps.length) { add("warning", "decoupling", "decoupling_missing", `${p.ref} has no decoupling capacitor on ${q.net}.`, "Put a 100 nF ceramic capacitor from " + q.net + " to GND within 3 mm of the supply pin — it supplies the fast current spikes the chip draws.", { refs: [p.ref], net: q.net, x: q.x, y: q.y }); continue; }
        let best = null; for (const c of caps) for (const m of mine) { const d = dist(c.z, m); if (!best || d < best.d) best = { d, c, m }; }
        if (best.d > 4) add("warning", "decoupling", "decoupling_far", `${best.c.part.ref} is ${r1(best.d)} mm from ${p.ref}'s ${best.m.fn || best.m.n} pin — too far to decouple it.`, "Decoupling only works close to the pin (the trace inductance defeats it): move it within 3 mm — Auto-place does this for you.", { refs: [best.c.part.ref, p.ref], net: q.net, x: best.c.z.x, y: best.c.z.y });
        else if (best.d > 3) add("info", "decoupling", "decoupling_far", `${best.c.part.ref} is ${r1(best.d)} mm from ${p.ref}'s ${best.m.fn || best.m.n} pin — a little far.`, "Ideally within 3 mm.", { refs: [best.c.part.ref, p.ref], net: q.net, x: best.c.z.x, y: best.c.z.y });
      }
    }

    // ---- 3. regulator capacitors
    for (const p of parts.filter((x) => kind(x) === "regulator")) {
      const side = (role) => { const q = padsOf(p).find((z) => z.role === role && z.net); if (!q) return null; const caps = (netPads.get(q.net) || []).map((z) => partOf(z.ref)).filter((c) => c && c.ref !== p.ref && cap(c)); return { q, caps, total: caps.reduce((s, c) => s + (capValue(c) || 0), 0) }; };
      const inn = side("power_in"), outp = side("power_out");
      if (inn && inn.total < 0.9e-6) add("warning", "supply", "reg_input_cap", `${p.ref}'s input (${inn.q.net}) has ${inn.caps.length ? "only " + r1(inn.total * 1e6) + " µF" : "no capacitor"}.`, "Add ≥ 1 µF (10 µF is typical) close to the input pin — it keeps the regulator stable when the supply is noisy.", { refs: [p.ref], net: inn.q.net, x: inn.q.x, y: inn.q.y });
      if (outp && outp.total < 0.9e-6) add("warning", "supply", "reg_output_cap", `${p.ref}'s output (${outp.q.net}) has ${outp.caps.length ? "only " + r1(outp.total * 1e6) + " µF" : "no capacitor"}.`, "Most regulators oscillate without ≥ 1 µF (often 10 µF) on the output — check the datasheet and add it right at the output pin.", { refs: [p.ref], net: outp.q.net, x: outp.q.x, y: outp.q.y });
    }

    // ---- 4. interfaces that need parts around them
    const resistorsTo = (net) => (netPads.get(net) || []).map((z) => partOf(z.ref)).filter((c) => c && (kind(c) === "resistor" || /^R\d/.test(c.ref)));
    const toPower = (r) => padsOf(r).some((z) => z.net && (b.netInfo(z.net).power));
    for (const [net, pads] of netPads) {
      if (/(^|_)(sda|scl)$/i.test(net) || pads.some((z) => /^(sda|scl)$/i.test(z.fn || ""))) {
        if (pads.length >= 2 && !resistorsTo(net).some(toPower)) add("warning", "interface", "i2c_pullup", `${net} (I²C) has no pull-up resistor.`, "I²C lines are open-drain: add a 4.7 kΩ resistor from SDA and from SCL to the supply (2.2 kΩ for fast buses).", { net, x: pads[0].x, y: pads[0].y });
      }
    }
    for (const p of parts.filter((x) => ["ic", "regulator"].includes(kind(x)))) for (const q of padsOf(p)) {
      if (/^(en|nrst|reset|rst|chip_pu|nreset)$/i.test(q.fn || "")) {
        const others = (netPads.get(q.net) || []).filter((z) => z.ref !== q.ref);
        if (!q.net) add("warning", "interface", "reset_floating", `${p.ref}'s ${q.fn} pin is not connected.`, "A floating enable / reset pin makes the chip start (or not) at random: pull it to the supply with ~10 kΩ and add a 100 nF capacitor to GND for a clean power-up.", { refs: [p.ref], x: q.x, y: q.y });
        else if (!others.length) add("warning", "interface", "reset_floating", `${p.ref}'s ${q.fn} pin only connects to itself.`, "Pull it to the supply with ~10 kΩ (and 100 nF to GND).", { refs: [p.ref], net: q.net, x: q.x, y: q.y });
      }
    }
    const usbNets = [...netPads].filter(([, pads]) => pads.some((z) => /^usb/.test(z.role)));
    if (usbNets.length) {
      const prot = parts.some((p) => ["diode"].includes(kind(p)) && /tvs|esd|usblc|prtr|d_/i.test(p.value + " " + defOf(p.type).label + " " + ((p.buy && p.buy.desc) || "")));
      if (!prot) add("info", "interface", "usb_esd", "The USB lines have no ESD protection.", "Add a USB TVS/ESD diode array (e.g. USBLC6-2SC6) right at the connector — USB ports take static zaps from fingers and cables.", { net: usbNets[0][0], x: usbNets[0][1][0].x, y: usbNets[0][1][0].y });
      const len = (net) => S.traces.filter((t) => t.net === net).reduce((s, t) => s + b.traceLength(t), 0);
      const dp = usbNets.find(([, pads]) => pads.some((z) => z.role === "usb_dp")), dm = usbNets.find(([, pads]) => pads.some((z) => z.role === "usb_dm"));
      if (dp && dm && S.traces.some((t) => t.net === dp[0]) && S.traces.some((t) => t.net === dm[0])) {
        const ld = len(dp[0]), lm = len(dm[0]);
        if (Math.abs(ld - lm) > 2) add("warning", "interface", "usb_skew", `USB D+ (${r1(ld)} mm) and D− (${r1(lm)} mm) differ by ${r1(Math.abs(ld - lm))} mm.`, "Route the pair side by side with equal length (within 2 mm) and the same number of vias, otherwise the signal edges arrive at different times.", { net: dp[0], x: dp[1][0].x, y: dp[1][0].y });
      }
      for (const p of parts.filter((x) => ["connector", "source"].includes(kind(x)))) for (const q of padsOf(p).filter((z) => /^cc[12]?$/i.test(z.fn || ""))) {
        if (!(resistorsTo(q.net).length)) add("warning", "interface", "usb_cc", `${p.ref}'s ${q.fn} pin has no 5.1 kΩ pull-down.`, "A USB-C power source only supplies 5 V when each CC pin has a 5.1 kΩ resistor to ground.", { refs: [p.ref], x: q.x, y: q.y });
      }
    }

    // ---- 5. crystals
    for (const p of parts.filter((x) => /^Y\d/.test(x.ref) || /crystal|xtal|oscillator/i.test(defOf(x.type).label + " " + x.value))) {
      const pads = padsOf(p);
      for (const q of pads) {
        const loaded = (netPads.get(q.net) || []).map((z) => partOf(z.ref)).some((c) => c && c.ref !== p.ref && cap(c));
        if (q.net && !loaded) add("warning", "layout", "crystal_load", `${p.ref} pin ${q.n} has no load capacitor.`, "A crystal needs a small capacitor (typically 10–22 pF, check its datasheet) from each pin to GND to oscillate at the right frequency.", { refs: [p.ref], net: q.net, x: q.x, y: q.y });
      }
      const mcu = parts.find((m) => kind(m) === "ic" && pads.some((q) => q.net && padsOf(m).some((z) => z.net === q.net)));
      if (mcu && dist(p, mcu) > 15) add("warning", "layout", "crystal_far", `${p.ref} is ${r1(dist(p, mcu))} mm from ${mcu.ref}.`, "Keep the crystal within ~10 mm of the chip with short, equal traces and no other signals between.", { refs: [p.ref, mcu.ref], x: p.x, y: p.y });
    }

    // ---- 6. connectors on the edge, facing outward
    for (const p of parts.filter((x) => x.type === "usbc" || /^J\d/.test(x.ref) && kind(x) === "source")) {
      const c = b.courtyard(p), d = { left: c.x0, right: BW - c.x1, top: c.y0, bottom: BH - c.y1 }, nearest = Object.keys(d).sort((x, y) => d[x] - d[y])[0];
      if (d[nearest] > 2.5) add("warning", "layout", "connector_edge", `${p.ref} is ${r1(d[nearest])} mm from the board edge.`, "A connector has to sit at the edge so a cable (and the case opening) can reach it — Auto-place puts it there.", { refs: [p.ref], x: p.x, y: p.y });
      else if (p.type === "usbc" && !Object.keys(d).some((k) => d[k] <= d[nearest] + 1.5 && p.rot === SIDE_ROT[k])) add("warning", "layout", "connector_facing", `${p.ref}'s opening faces into the board, not out of the ${nearest} edge.`, `Rotate it to ${SIDE_ROT[nearest]}° so the cable plugs in from outside.`, { refs: [p.ref], x: p.x, y: p.y });
    }

    // ---- 7. antenna keep-out (RF modules)
    for (const p of parts.filter((x) => defOf(x.type).keepout || /esp32|wroom|mini-1|nrf52|antenna/i.test(defOf(x.type).label + " " + x.value + " " + ((x.buy && x.buy.mpn) || "")))) {
      const c = body(p), kz = defOf(p.type).keepout, depth = (kz && kz.depth) || 6;
      const zone = { x0: c.x0, x1: c.x1, y0: c.y0 - depth, y1: c.y0 }; // the antenna end of a module is its "top" (−y) side
      const intr = parts.filter((o) => o.ref !== p.ref && ((q) => q.x0 < zone.x1 && q.x1 > zone.x0 && q.y0 < zone.y1 && q.y1 > zone.y0)(b.courtyard(o))), tr = S.traces.filter((t) => t.pts.some(([x, y]) => x > zone.x0 && x < zone.x1 && y > zone.y0 && y < zone.y1));
      if (intr.length || tr.length) add("warning", "layout", "antenna_keepout", `Copper or parts sit in the antenna area of ${p.ref}${intr.length ? ": " + intr.slice(0, 4).map((o) => o.ref).join(", ") : ""}.`, `Keep ${depth} mm in front of the antenna free of parts, traces and ground pour, with the antenna at the board edge — otherwise the radio range collapses.`, { refs: [p.ref].concat(intr.map((o) => o.ref)), x: p.x, y: zone.y0 });
    }

    // ---- 8. the ground plane
    const gndNet = [...netPads].find(([n, pads]) => isGnd(n) && pads.length >= 4);
    if (gndNet && !(S.zones || []).some((z) => z.net === gndNet[0])) add("info", "layout", "no_ground_pour", `${gndNet[0]} has ${gndNet[1].length} pins but there is no ground pour.`, "A ground plane on the back layer shortens every return path and cuts noise: run autoroute (it adds one) or add_pour net=" + gndNet[0] + ".", { net: gndNet[0] });

    // ---- 9. soldering: can a person actually do this?
    const bodies = parts.map((p) => ({ p, c: body(p) }));
    const gapBetween = (A, C) => { const dx = Math.max(A.x0 - C.x1, C.x0 - A.x1, 0), dy = Math.max(A.y0 - C.y1, C.y0 - A.y1, 0); return Math.hypot(dx, dy); };
    const tooClose = hand ? 0.5 : 0.25;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const g = gapBetween(bodies[i].c, bodies[j].c);
      if (g > 0 && g < tooClose) add("warning", "soldering", "too_close", `${bodies[i].p.ref} and ${bodies[j].p.ref} are only ${r1(g * 10) / 10} mm apart.`, hand ? "There is no room for an iron tip or tweezers (and rework is nearly impossible). Keep ≥ 0.9 mm between parts — Auto-place does." : "Keep ≥ 0.5 mm between parts for the pick-and-place and for inspection.", { refs: [bodies[i].p.ref, bodies[j].p.ref], x: (bodies[i].p.x + bodies[j].p.x) / 2, y: (bodies[i].p.y + bodies[j].p.y) / 2 });
    }
    for (const p of parts) {
      const c = body(p), under = padsOf(p).filter((q) => !q.thru && q.x > c.x0 + 0.9 && q.x < c.x1 - 0.9 && q.y > c.y0 + 0.9 && q.y < c.y1 - 0.9);
      if (under.length >= 2 && ["ic", "regulator"].includes(kind(p))) add(hand ? "warning" : "info", "soldering", "pads_under_body", `${p.ref} has ${under.length} pads under its body.`, hand ? "You cannot reach those pads with a soldering iron. Use hot air with solder paste, a reflow oven, or an assembly service — or choose a version of the part with pins on the outside." : "Reflow only (solder paste + oven/hot air); inspect with X-ray or trust the paste stencil.", { refs: [p.ref], x: p.x, y: p.y });
      const pkg = String((p.buy && p.buy.pkg) || "").toUpperCase();
      if (hand && /^(0201|0402)/.test(pkg)) add("warning", "soldering", "tiny_package", `${p.ref} is a ${pkg} package.`, "0402 and smaller are very hard to solder by hand: choose 0603 or 0805 (same price, same stock).", { refs: [p.ref], x: p.x, y: p.y });
      const ps = padsOf(p); let pitch = Infinity;
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (!ps[i].thru) pitch = Math.min(pitch, dist(ps[i], ps[j]));
      if (hand && pitch < 0.62 && ps.length > 4) add("info", "soldering", "fine_pitch", `${p.ref} has a ${r1(pitch * 10) / 10} mm pad pitch.`, "Fine pitch needs flux, a fine tip and a steady hand (drag soldering) — or use a coarser package (SOIC / TSSOP).", { refs: [p.ref], x: p.x, y: p.y });
    }

    // ---- 10. connectivity sanity
    for (const [net, pads] of netPads) if (pads.length === 1 && !/^(nc|n\/c|unused)/i.test(net)) add("warning", "connectivity", "single_pin_net", `Net ${net} only reaches one pin (${pads[0].ref}).`, "A net with one pin goes nowhere: connect it to something or remove it.", { refs: [pads[0].ref.split(".")[0]], net, x: pads[0].x, y: pads[0].y });
    const open = (A.unrouted_links || []).length;
    if (open && S.traces.length) add("warning", "routing", "unrouted", `${open} connection${open > 1 ? "s" : ""} still have no copper.`, "Run Auto-route (or route them by hand) and then run the review again.", {});
    // traces that are thinner than their net needs (the settings behind every trace are in the inspector)
    for (const t of S.traces) { const tr = A.traces[t.id]; if (tr && tr.status === "danger") add("danger", "routing", "trace_too_thin", `Trace ${t.id} (${t.net}) is ${t.width} mm but carries ${tr.i} A (safe up to ${tr.limit} A).`, "Click the trace to see the width it needs — then assign the net to a wider wire class (Rules tab) and run apply_rules.", { net: t.net, x: t.pts[0][0], y: t.pts[0][1] }); }
    for (const e of drcRes.errors.slice(0, 6)) add("danger", "routing", "drc", e.msg, "Design-rule error: fix it before ordering the board.", { refs: e.refs || [], x: e.x, y: e.y });

    const rank = { danger: 0, warning: 1, info: 2 };
    out.sort((x, y) => rank[x.level] - rank[y.level]);
    out.forEach((f, i) => { f.id = "r" + (i + 1); });
    return out;
  };
  B.cmd_review = function () {
    const f = this.review(), c = { danger: 0, warning: 0, info: 0 };
    for (const x of f) c[x.level]++;
    return { verdict: c.danger ? "NOT READY — fix the dangers first" : c.warning ? "Almost: " + c.warning + " thing" + (c.warning > 1 ? "s" : "") + " an engineer would fix" : "Looks ready to order", counts: c, assembly: this.s.assembly || "hand", findings: f.map(({ id, level, cat, code, msg, fix, refs, net }) => ({ id, level, cat, code, msg, fix, refs, net })) };
  };
  U.review = "review  — engineer's design review: power pins, decoupling distance, regulator caps, I²C/reset/USB/crystal details, connector placement, antenna keep-out, ground pour, and whether it can really be soldered. Every finding has a fix.";
})(typeof window !== "undefined" ? window : globalThis);
