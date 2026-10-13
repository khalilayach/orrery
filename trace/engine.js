// TRACE board engine — pure model (no DOM): parts, traces, vias, measurements,
// design-rule check and the command API shared by the UI, the dock slash
// commands and the real Claude agent (via server/trace-cli.mjs).
// Units are millimetres, origin top-left, y grows downward, rotation clockwise.
(function (root) {
  "use strict";

  const RULES = { minTrace: 0.15, minGap: 0.15, edge: 0.3 };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const pad = (n, x, y, w, h, o) =>
    Object.assign({ n, x, y, w, h, shape: "rect", fn: n, thru: false }, o || {});

  // plain-English meaning of each MCU pin, shown in the inspector
  const MCU_PIN_DESC = {
    USB_DP: "USB data + — from the USB connector", USB_DM: "USB data − — from the USB connector",
    GND: "Ground (0 V) — the return path for all current", VDD: "3.3 V power input for the chip",
    PA5: "General-purpose pin — drives the status LED",
  };
  const IO_DESC = "General-purpose I/O — software-controlled input or output";
  const MCU_ROLE = { USB_DP: "usb_dp", USB_DM: "usb_dm", GND: "ground", VDD: "power_in" };

  function mcuPads() {
    const f = ["USB_DP", "USB_DM", "GND", "VDD", "PA5", "PA6", "PA7", "PB0",
      "PB1", "PB2", "PB3", "PB4", "PA1", "PA2", "PA3", "PA4"];
    const L = [-2.4, -0.8, 0.8, 2.4], o = [], d = (i) => ({ fn: f[i], desc: MCU_PIN_DESC[f[i]] || IO_DESC, role: MCU_ROLE[f[i]] || "io" });
    for (let i = 0; i < 4; i++) o.push(pad(String(i + 1), -4.4, L[i], 1.8, 0.8, d(i)));      // left, top→bottom
    for (let i = 0; i < 4; i++) o.push(pad(String(i + 5), L[i], 4.4, 0.8, 1.8, d(4 + i)));   // bottom, left→right
    for (let i = 0; i < 4; i++) o.push(pad(String(i + 9), 4.4, -L[i], 1.8, 0.8, d(8 + i)));  // right, bottom→top
    for (let i = 0; i < 4; i++) o.push(pad(String(i + 13), -L[i], -4.4, 0.8, 1.8, d(12 + i))); // top, right→left
    return o;
  }
  function headerPads() {
    const o = [];
    for (let i = 0; i < 6; i++) o.push(pad(String(i + 1), 0, r3((i - 2.5) * 2.54), 1.7, 1.7, { shape: "circle", thru: true, role: "io", desc: "Breakout pin — connect a wire, sensor or programmer here" }));
    return o;
  }
  const TERM = "Terminal — either way round (not polarised)";

  const PARTS = {
    resistor: { label: "Resistor", prefix: "R", value: "330R", body: [3.8, 1.8],
      desc: "Resistor — limits current or sets a voltage. Value is in ohms (330R = 330 Ω).",
      elec: { kind: "resistor", pmax: 0.1 },
      pads: [pad("1", -1.5, 0, 1, 1.2, { desc: TERM, role: "passive" }), pad("2", 1.5, 0, 1, 1.2, { desc: TERM, role: "passive" })] },
    capacitor: { label: "Capacitor", prefix: "C", value: "100nF", body: [3.8, 1.8],
      desc: "Capacitor — stores a little charge. Placed next to a chip it smooths the power supply (decoupling) and filters noise.",
      elec: { kind: "capacitor", vmax: 16 },
      pads: [pad("1", -1.5, 0, 1, 1.2, { desc: TERM, role: "passive" }), pad("2", 1.5, 0, 1, 1.2, { desc: TERM, role: "passive" })] },
    led: { label: "LED", prefix: "D", value: "green", body: [3.8, 1.8],
      desc: "LED — a light that glows when current flows from A (anode) to K (cathode). Always needs a series resistor.",
      elec: { kind: "led", imax: 0.02, vr_max: 5 },
      pads: [pad("A", -1.5, 0, 1, 1.2, { desc: "Anode (+) — current enters here", role: "passive" }), pad("K", 1.5, 0, 1, 1.2, { desc: "Cathode (−) — current leaves toward ground", role: "passive" })] },
    ldo: { label: "3.3V LDO", prefix: "U", value: "3V3", body: [3, 1.8],
      desc: "3.3 V voltage regulator (LDO) — turns the 5 V from USB into a steady 3.3 V for the chips.",
      elec: { kind: "regulator", vout: 3.3, dropout: 0.25, vin_max: 6, imax: 0.6, iq: 0.000055, pmax: 0.4 },
      pads: [pad("IN", -0.95, 1.2, 0.8, 1, { desc: "Input — 5 V in", role: "power_in" }), pad("GND", 0.95, 1.2, 0.8, 1, { desc: "Ground (0 V)", role: "ground" }), pad("OUT", 0, -1.2, 0.8, 1, { desc: "Output — steady 3.3 V", role: "power_out" })] },
    mcu: { label: "MCU (QFP-16)", prefix: "U", value: "MCU", body: [8, 8],
      desc: "Microcontroller — the brain of the board. Runs your firmware, talks USB, and switches LEDs and other pins on and off.",
      elec: { kind: "ic", vdd_min: 1.8, vdd_max: 3.6, iq: 0.012, pin_imax: 0.008, pin_rout: 40 },
      pads: mcuPads() },
    usbc: { label: "USB-C", prefix: "J", value: "USB-C", body: [9, 8.6],
      desc: "USB-C connector — brings 5 V power and the USB data lines in from a cable.",
      elec: { kind: "source", vout: 5, imax: 0.5 },
      pads: [pad("D+", 3.2, -2.4, 1.6, 0.7, { desc: "USB data + (pairs with D−)", role: "usb_dp" }), pad("D-", 3.2, -0.8, 1.6, 0.7, { desc: "USB data − (pairs with D+)", role: "usb_dm" }),
        pad("GND", 3.2, 0.8, 1.6, 0.7, { desc: "Ground (0 V)", role: "ground" }), pad("VBUS", 3.2, 2.4, 1.6, 0.7, { desc: "5 V power from the USB cable (500 mA limit)", role: "power_out" })] },
    battery: { label: "Battery (3.7 V)", prefix: "BT", value: "3.7V", body: [5.6, 3],
      desc: "Battery — a 3.7 V lithium cell. The + pin supplies power, the − pin is ground.",
      elec: { kind: "source", vout: 3.7, imax: 1 },
      pads: [pad("+", -2.4, 0, 1.4, 2, { desc: "Positive terminal (+3.7 V)", role: "power_out" }), pad("-", 2.4, 0, 1.4, 2, { desc: "Negative terminal — ground (0 V)", role: "ground" })] },
    header: { label: "Header 1x6", prefix: "J", value: "HDR-1x6", body: [3, 15.9],
      desc: "Pin header — a row of through-hole pins for wiring in sensors, a programmer, or another board.",
      elec: { kind: "connector", pin_imax: 1 }, pads: headerPads() },
    opamp: { label: "Op-amp (SOT-23-5)", prefix: "U", value: "OPAMP", body: [2.9, 1.6],
      desc: "Operational amplifier — amplifies or buffers a signal. Its output follows the difference between the + and − inputs; a buffer wires OUT straight back to the − input.",
      elec: { kind: "ic", vdd_min: 3, vdd_max: 36, iq: 0.0015, pin_imax: 0.02 },
      pads: [pad("1", -0.95, 1.25, 0.6, 1, { fn: "OUT", desc: "Output", role: "io" }), pad("2", 0, 1.25, 0.6, 1, { fn: "V-", desc: "Negative supply — ground for a single-supply circuit", role: "ground" }),
        pad("3", 0.95, 1.25, 0.6, 1, { fn: "IN+", desc: "Non-inverting input (+)", role: "io" }), pad("4", 0.95, -1.25, 0.6, 1, { fn: "IN-", desc: "Inverting input (−)", role: "io" }),
        pad("5", -0.95, -1.25, 0.6, 1, { fn: "V+", desc: "Positive supply", role: "power_in" })] },
    hole: { label: "Mounting hole", prefix: "H", value: "M3", body: [0, 0],
      desc: "Mounting hole — a screw hole to fix the board to a case. Keep copper away from it.",
      elec: { kind: "none" },
      pads: [pad("1", 0, 0, 3.2, 3.2, { shape: "circle", thru: true, fn: "MH", desc: "Screw hole (no electrical connection)", role: "nc" })] },
  };

  // ---------- part definitions: built-ins + user/online parts (persisted by the server) ----------
  Object.values(PARTS).forEach((d) => { d.custom = false; });
  const MISSING = { label: "(missing part)", prefix: "X", value: "?", body: [4, 4], pads: [], missing: true };
  const defOf = (type) => PARTS[type] || Object.assign({}, MISSING, { label: type + " (missing)" });
  const num = (v, d) => (v === undefined || v === "" || v === null ? d : Number(v));

  // pad generators for the common package families
  const TEMPLATES = {
    two_pad(a) {
      const pitch = num(a.pitch, 3), pw = num(a.padw, 1), ph = num(a.padh, 1.2);
      return { pads: [pad("1", -pitch / 2, 0, pw, ph), pad("2", pitch / 2, 0, pw, ph)], body: [pitch + pw, Math.max(ph, 1.2) + 0.4] };
    },
    dual(a) {
      const N = num(a.pins, 8), pitch = num(a.pitch, 1.27), span = num(a.span, 5.4), pl = num(a.padl, 1.6), pw = num(a.padw, 0.6), n = N / 2;
      if (!Number.isInteger(n) || n < 1) throw new Error("dual needs an even pins= count");
      const o = [];
      for (let i = 0; i < n; i++) o.push(pad(String(i + 1), -span / 2, r3((i - (n - 1) / 2) * pitch), pl, pw));
      for (let i = 0; i < n; i++) o.push(pad(String(N - i), span / 2, r3((i - (n - 1) / 2) * pitch), pl, pw));
      return { pads: o, body: [r3(span - pl - 0.1), r3(n * pitch)] };
    },
    quad(a) {
      const N = num(a.pins, 16), pitch = num(a.pitch, 0.8), n = N / 4, pl = num(a.padl, 1.5), pw = num(a.padw, 0.5);
      if (!Number.isInteger(n) || n < 1) throw new Error("quad needs pins= divisible by 4");
      const span = num(a.span, r3(n * pitch + pl * 1.5)), o = [], p = (i) => r3((i - (n - 1) / 2) * pitch);
      for (let i = 0; i < n; i++) o.push(pad(String(i + 1), -span / 2, p(i), pl, pw));
      for (let i = 0; i < n; i++) o.push(pad(String(n + i + 1), p(i), span / 2, pw, pl));
      for (let i = 0; i < n; i++) o.push(pad(String(2 * n + i + 1), span / 2, -p(i), pl, pw));
      for (let i = 0; i < n; i++) o.push(pad(String(3 * n + i + 1), -p(i), -span / 2, pw, pl));
      return { pads: o, body: [r3(span - pl - 0.1), r3(span - pl - 0.1)] };
    },
    header(a) {
      const N = num(a.pins, 4), rows = num(a.rows, 1), pitch = num(a.pitch, 2.54), d = num(a.d, 1.7), o = [];
      if (rows !== 1 && rows !== 2) throw new Error("rows must be 1 or 2");
      const per = Math.ceil(N / rows);
      for (let i = 0; i < N; i++) {
        const r = rows === 1 ? 0 : i % 2, k = rows === 1 ? i : Math.floor(i / 2);
        o.push(pad(String(i + 1), rows === 1 ? 0 : r3((r - 0.5) * pitch), r3((k - (per - 1) / 2) * pitch), d, d, { shape: "circle", thru: true }));
      }
      return { pads: o, body: [r3(rows * pitch), r3(per * pitch)] };
    },
  };
  function customPads(spec) {
    return String(spec).split("/").filter(Boolean).map((t) => {
      const f = t.split(":");
      if (f.length < 5) throw new Error(`pad "${t}" must be name:x:y:w:h[:circle][:thru]`);
      const [n, x, y, w, h] = f, flags = f.slice(5);
      for (const v of [x, y, w, h]) if (!isFinite(Number(v))) throw new Error(`pad "${t}" has a non-numeric value`);
      return pad(n, Number(x), Number(y), Number(w), Number(h), { shape: flags.includes("circle") ? "circle" : "rect", thru: flags.includes("thru") });
    });
  }
  // ---- electrical model of a part: kind + limits + pad roles (see trace/electrical.js) ----
  const ELEC_KINDS = ["resistor", "capacitor", "led", "diode", "inductor", "regulator", "source", "load", "ic", "connector", "passive", "none"];
  const ROLES = ["power_in", "power_out", "ground", "io", "usb_dp", "usb_dm", "passive", "nc"];
  const ELEC_NUM = ["vmax", "imax", "pmax", "vf", "vr_max", "vout", "dropout", "vin_max", "iq", "iload", "vdd_min", "vdd_max", "pin_imax", "pin_rout", "r", "dcr"];
  function parseRoles(spec) {
    const o = {};
    for (const t of String(spec).split("/").filter(Boolean)) {
      const i = t.lastIndexOf(":");
      if (i < 1) throw new Error(`role "${t}" must be pad:role (roles: ${ROLES.join(", ")})`);
      const r = t.slice(i + 1).toLowerCase();
      if (!ROLES.includes(r)) throw new Error(`unknown pad role "${r}" (${ROLES.join(", ")})`);
      o[t.slice(0, i)] = r;
    }
    return o;
  }
  function sanitizeElec(e) {
    const o = {};
    if (!e || typeof e !== "object") return o;
    if (e.kind !== undefined) {
      if (!ELEC_KINDS.includes(String(e.kind))) throw new Error(`unknown kind "${e.kind}" (${ELEC_KINDS.join(", ")})`);
      o.kind = String(e.kind);
    }
    for (const k of ELEC_NUM) if (e[k] !== undefined && e[k] !== "") {
      const v = Number(e[k]);
      if (!isFinite(v) || v < 0) throw new Error(`${k} must be a number ≥ 0`);
      o[k] = v;
    }
    if (e.roles) o.roles = typeof e.roles === "string" ? parseRoles(e.roles) : e.roles;
    return o;
  }
  const elecFromArgs = (a) => sanitizeElec(a);

  // validate + clean a part definition (from templates, the CLI, online imports or disk)
  function normalizeDef(d) {
    if (!d || typeof d !== "object") throw new Error("part definition must be an object");
    if (!Array.isArray(d.pads) || !d.pads.length) throw new Error("part needs at least one pad");
    if (d.pads.length > 400) throw new Error("too many pads (max 400)");
    const seen = new Set();
    const pads = d.pads.map((p, i) => {
      const q = { n: String(p.n !== undefined && p.n !== "" ? p.n : "P" + (i + 1)), x: Number(p.x), y: Number(p.y), w: Number(p.w), h: Number(p.h) };
      for (const k of ["x", "y", "w", "h"]) if (!isFinite(q[k])) throw new Error(`pad ${q.n}: ${k} is not a number`);
      if (q.w <= 0 || q.h <= 0) throw new Error(`pad ${q.n}: size must be > 0`);
      let n = q.n, k = 2; while (seen.has(n)) n = q.n + "_" + k++;
      seen.add(n);
      return pad(n, r3(q.x), r3(q.y), r3(q.w), r3(q.h), { fn: String(p.fn || n), shape: p.shape === "circle" ? "circle" : "rect", thru: !!p.thru, desc: p.desc ? String(p.desc).slice(0, 160) : "", role: ROLES.includes(p.role) ? p.role : "" });
    });
    let body = Array.isArray(d.body) && d.body.length === 2 ? d.body.map(Number) : null;
    if (!body || body.some((v) => !isFinite(v) || v < 0)) {
      const w = Math.max(...pads.map((p) => Math.abs(p.x) + p.w / 2)) * 2, h = Math.max(...pads.map((p) => Math.abs(p.y) + p.h / 2)) * 2;
      body = [r3(w + 0.4), r3(h + 0.4)];
    }
    return {
      label: String(d.label || "Custom part").slice(0, 60), prefix: String(d.prefix || "X").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "X",
      value: String(d.value || d.label || "part").slice(0, 40), body: [r3(body[0]), r3(body[1])], pads,
      desc: d.desc ? String(d.desc).slice(0, 300) : "", elec: sanitizeElec(d.elec),
      source: d.source ? String(d.source).slice(0, 300) : "", custom: true,
    };
  }
  const safeId = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 64);

  const USAGE = {
    help: "help — this list",
    describe: "describe ref=<R1> text=<plain English: what this part does in THIS circuit> — or net=<VBUS> text=... ; empty text clears. Shown to the user in the inspector, tooltips and net list",
    board: "board — full board state: parts with pad coordinates + nets, traces, vias, measurements, DRC",
    parts_library: "parts_library — part types you can place, with pad names",
    place: "place type=<part id from list_parts> x=<mm> y=<mm> [rot=0|90|180|270] [ref=R1] [value=330R]",
    list_parts: "list_parts — every part type you can place (built-in + saved custom/online parts) with pad names",
    create_part: "create_part id=<name> label=<text> [desc=<what the part is/does>] prefix=<R|U|J..> template=<two_pad|dual|quad|header> [pins=8 pitch=1.27 span=5.4 padl=1.6 padw=0.6 rows=1 d=1.7 body=5x4] — or pads=<name:x:y:w:h[:circle][:thru]/...> for any footprint. Saved to disk permanently",
    delete_part: "delete_part id=<custom part id> — removes a saved custom part (not allowed while placed on the board)",
    search_parts: "search_parts q=<e.g. soic-8, usb_c, esp32> — find footprints online (KiCad library); CLI only",
    import_part: "import_part path=<result path from search_parts> [id=<name>] — download a footprint, add it to the library; CLI only",
    move: "move ref=<R1> x=<mm> y=<mm>  (or dx=,dy=) — attached trace ends follow the pads",
    rotate: "rotate ref=<R1> [rot=<abs deg> | by=90]",
    set_value: "set_value ref=<R1> value=<text>",
    remove: "remove ref=<R1> | id=<trace/via/measure id>",
    route: "route from=<R1.1 | x:y> to=<U1.4 | x:y> [points=x:y/x:y] [net=NAME] [width=0.25] [layer=F.Cu|B.Cu] [elbow=0]  — 45° routed copper trace",
    connect: "connect a=<J1.GND> b=<U1.GND> [net=NAME]  — logical wire between two pads (the Graph view); no copper needed. A wire between different nets is reported as a short",
    disconnect: "disconnect a=<pad> b=<pad> | id=<wire id>  — remove a logical wire (or a trace by id)",
    source: "source ref=<R1> mpn=<part number> [id=C14663] [price=0.0016 (USD each)] [stock=N] [pkg=0603] [url=...] [tiers=1-199:0.01,200-:0.008] [basic=1]  — record which real, buyable part this is (from find_parts); clear=1 removes it",
    bom: "bom [boards=1]  — bill of materials: grouped parts, unit/line prices for that many boards, total cost, which parts are still unsourced",
    insert_series: "insert_series pad=<D1.A> [type=resistor] [value=330R]  — splice a part in series with a wired pin (the fix for an LED with no resistor)",
    add_via: "add_via x=<mm> y=<mm> [net=NAME] [d=0.6] [drill=0.3]",
    set_trace: "set_trace id=<t1> [width=] [net=] [layer=]",
    measure: "measure from=<R1.1 | x:y> to=<U1.4 | x:y> — draws + returns dx, dy, distance (mm)",
    clear_measures: "clear_measures",
    drc: "drc — design rule check: min trace 0.15, min gap 0.15, edge clearance 0.30 (mm)",
    set_board: "set_board w=<mm> h=<mm>",
    clear: "clear — remove all parts/traces/vias",
    load_sample: "load_sample — the USB-C dev board demo",
    highlight: "highlight ref=<R1|U1.4> | net=<NAME> — point the user at something",
    undo: "undo", redo: "redo",
  };
  const MUTATING = new Set(["connect", "disconnect", "source", "insert_series", "place", "move", "rotate", "set_value", "remove", "route", "add_via",
    "set_trace", "measure", "clear_measures", "set_board", "clear", "load_sample", "describe"]);
  const NUMERIC = new Set(["x", "y", "dx", "dy", "rot", "by", "w", "h", "d", "drill", "width", "pins", "pitch", "span", "padl", "padw", "padh", "rows", ...ELEC_NUM]);

  // ---------- geometry for DRC ----------
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  function pdist(p, s) {
    if (s.t === "seg") return segDist(p, s.a, s.b) - s.r;
    if (s.t === "circ") return Math.hypot(p.x - s.x, p.y - s.y) - s.r;
    const dx = Math.max(s.x0 - p.x, 0, p.x - s.x1), dy = Math.max(s.y0 - p.y, 0, p.y - s.y1);
    return Math.hypot(dx, dy);
  }
  function samples(s, step) {
    if (s.t === "circ") return [{ x: s.x, y: s.y, r: s.r }];
    const out = [];
    const line = (a, b, r) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let i = 0; i <= n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n, r });
    };
    if (s.t === "seg") line(s.a, s.b, s.r);
    else {
      const c = [{ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y0 }, { x: s.x1, y: s.y1 }, { x: s.x0, y: s.y1 }];
      for (let i = 0; i < 4; i++) line(c[i], c[(i + 1) % 4], 0);
      out.push({ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2, r: 0 });
    }
    return out;
  }
  function gap(A, B) {
    let best = { d: Infinity, x: 0, y: 0 };
    for (const [S, T] of [[A, B], [B, A]])
      for (const p of samples(S, 0.1)) {
        const d = pdist(p, T) - p.r;
        if (d < best.d) best = { d, x: p.x, y: p.y };
      }
    return best;
  }
  function bbox(s) {
    if (s.t === "circ") return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
    if (s.t === "seg") return [Math.min(s.a.x, s.b.x) - s.r, Math.min(s.a.y, s.b.y) - s.r,
      Math.max(s.a.x, s.b.x) + s.r, Math.max(s.a.y, s.b.y) + s.r];
    return [s.x0, s.y0, s.x1, s.y1];
  }

  // straight run then a 45° diagonal into the target — the classic PCB elbow
  function elbow(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 1e-6 || ay < 1e-6 || Math.abs(ax - ay) < 1e-6) return [];
    if (ax > ay) return [{ x: r3(b.x - Math.sign(dx) * ay), y: a.y }];
    return [{ x: a.x, y: r3(b.y - Math.sign(dy) * ax) }];
  }

  class Board {
    constructor() {
      this.listeners = []; this.undoS = []; this.redoS = []; this._quiet = false;
      this.reset();
    }
    static parseKV(arr) {
      const o = {};
      for (const t of arr) {
        const i = String(t).indexOf("=");
        if (i < 1) throw new Error('expected key=value, got "' + t + '"');
        o[String(t).slice(0, i).toLowerCase()] = String(t).slice(i + 1);
      }
      return o;
    }
    reset(w = 60, h = 40) { this.s = { board: { w, h }, parts: [], traces: [], vias: [], links: [], measures: [], netNotes: {}, seq: 1 }; }
    on(fn) { this.listeners.push(fn); }
    emit(e) { for (const f of this.listeners) f(e); }
    // custom part definitions in use travel with the board so a saved/exported board
    // still renders when the library file is missing
    serialize() {
      const lib = {};
      for (const p of this.s.parts) if (PARTS[p.type] && PARTS[p.type].custom) lib[p.type] = PARTS[p.type];
      return JSON.stringify(Object.assign({}, this.s, { lib }));
    }
    load(json) {
      const s = typeof json === "string" ? JSON.parse(json) : json;
      if (!s || !s.board || !Array.isArray(s.parts) || !Array.isArray(s.traces)) throw new Error("not a TRACE board");
      if (s.lib) for (const [id, d] of Object.entries(s.lib)) if (!PARTS[id]) try { PARTS[id] = normalizeDef(d); } catch (_) { /* skip bad def */ }
      delete s.lib;
      this.s = Object.assign({ vias: [], links: [], measures: [], netNotes: {}, seq: 1 }, s);
      this.emit({ type: "change", cmd: "load" });
    }
    _push() { this.undoS.push(JSON.stringify(this.s)); if (this.undoS.length > 100) this.undoS.shift(); this.redoS.length = 0; }
    nextId(p) { return p + (this.s.seq++); }

    // ---------- lookups ----------
    findPart(ref) { const r = String(ref).toLowerCase(); return this.s.parts.find((p) => p.ref.toLowerCase() === r); }
    pads(part) {
      const d = defOf(part.type), th = (part.rot * Math.PI) / 180, c = Math.round(Math.cos(th)), s = Math.round(Math.sin(th));
      const swap = part.rot % 180 !== 0;
      return d.pads.map((p) => ({
        n: p.n, fn: p.fn, desc: p.desc || "", role: (part.elec && part.elec.roles && part.elec.roles[p.n]) || (d.elec && d.elec.roles && d.elec.roles[p.n]) || p.role || "", shape: p.shape, thru: p.thru,
        x: r3(part.x + p.x * c - p.y * s), y: r3(part.y + p.x * s + p.y * c),
        w: swap ? p.h : p.w, h: swap ? p.w : p.h,
        ref: part.ref + "." + p.n, net: (part.nets && part.nets[p.n]) || "",
      }));
    }
    padOf(part, name) {
      const q = String(name).toLowerCase();
      return this.pads(part).find((p) => p.n.toLowerCase() === q) || this.pads(part).find((p) => p.fn.toLowerCase() === q);
    }
    resolve(spec) {
      if (Array.isArray(spec)) return { x: Number(spec[0]), y: Number(spec[1]) };
      if (spec && typeof spec === "object" && "x" in spec) return { x: Number(spec.x), y: Number(spec.y) };
      const s = String(spec == null ? "" : spec).trim();
      const m = s.match(/^(-?\d+(?:\.\d+)?)[,:](-?\d+(?:\.\d+)?)$/);
      if (m) return { x: +m[1], y: +m[2] };
      const dot = s.indexOf("."), ref = dot < 0 ? s : s.slice(0, dot), pn = dot < 0 ? undefined : s.slice(dot + 1);
      const part = this.findPart(ref);
      if (!part) throw new Error(`unknown part or coordinates "${s}"`);
      if (pn === undefined) return { x: part.x, y: part.y, part };
      const pd = this.padOf(part, pn);
      if (!pd) throw new Error(`${part.ref} has no pad "${pn}" (pads: ${this.pads(part).map((p) => p.n).join(", ")})`);
      return { x: pd.x, y: pd.y, part, pad: pd };
    }
    allPads() { return this.s.parts.flatMap((p) => this.pads(p)); }
    nets() {
      const m = new Map();
      const get = (n) => { if (!m.has(n)) m.set(n, { name: n, note: (this.s.netNotes || {})[n] || "", pads: [], trace_length: 0 }); return m.get(n); };
      for (const pd of this.allPads()) if (pd.net) get(pd.net).pads.push(pd.ref);
      for (const t of this.s.traces) get(t.net).trace_length = r3(get(t.net).trace_length + this.traceLength(t));
      return [...m.values()];
    }
    traceLength(t) {
      let l = 0;
      for (let i = 1; i < t.pts.length; i++) l += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
      return r3(l);
    }

    // ---------- command dispatch ----------
    exec(cmd, args, source) {
      cmd = String(cmd || "").toLowerCase().replace(/-/g, "_");
      const fn = this["cmd_" + cmd];
      if (!fn) throw new Error(`unknown command "${cmd}" — run help`);
      const a = Array.isArray(args) ? Board.parseKV(args) : Object.assign({}, args || {});
      for (const k of Object.keys(a)) if (NUMERIC.has(k) && typeof a[k] === "string") {
        const n = Number(a[k]);
        if (!isFinite(n) || a[k].trim() === "") throw new Error(`${k} must be a number, got "${a[k]}"`);
        a[k] = n;
      }
      const mut = MUTATING.has(cmd) && !this._quiet;
      if (mut) this._push();
      let res;
      try { res = fn.call(this, a, source); } catch (e) { if (mut) this.undoS.pop(); throw e; }
      const f = res && res._focus;
      if (f) delete res._focus;
      if (mut) this.emit({ type: "change", cmd, source });
      if (f && source === "claude") this.emit({ type: "focus", x: f.x, y: f.y, label: f.label });
      return res;
    }
    need(a, ...keys) { for (const k of keys) if (a[k] === undefined || a[k] === "") throw new Error(`missing ${k}= (see help)`); }
    snapRot(v) {
      const r = ((Math.round(v) % 360) + 360) % 360;
      if (r % 90 !== 0) throw new Error("rot must be a multiple of 90");
      return r;
    }

    cmd_help() { return { units: "mm, origin top-left, y down, rot clockwise", commands: USAGE }; }
    cmd_list_parts() {
      return Object.entries(PARTS).map(([type, d]) => ({ type, label: d.label, prefix: d.prefix, custom: !!d.custom, desc: d.desc || "", source: d.source || "", body: d.body,
        pads: d.pads.map((p) => ({ n: p.n, fn: p.fn, desc: p.desc || "", x: p.x, y: p.y, w: p.w, h: p.h })) }));
    }
    cmd_parts_library() { return this.cmd_list_parts(); }
    cmd_create_part(a) {
      let d;
      if (a.def && typeof a.def === "object") d = a.def;
      else {
        this.need(a, "id");
        let base;
        if (a.pads) base = { pads: customPads(a.pads) };
        else if (a.template) {
          const t = TEMPLATES[String(a.template).toLowerCase()];
          if (!t) throw new Error(`unknown template "${a.template}" (${Object.keys(TEMPLATES).join(", ")}) — or pass pads=`);
          base = t(a);
        } else throw new Error("give template=<two_pad|dual|quad|header> or pads=name:x:y:w:h/...");
        if (a.body) {
          const m = String(a.body).match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
          if (!m) throw new Error("body must look like 5x4 (mm)");
          base.body = [Number(m[1]), Number(m[2])];
        }
        d = Object.assign({ label: a.label || a.id, prefix: a.prefix || "X", value: a.value || a.label || a.id, desc: a.desc || "", source: a.source || "created in TRACE" }, base);
      }
      const id = safeId(a.id || d.id || d.label);
      if (!id) throw new Error("part needs an id= (letters, digits, - _ .)");
      if (PARTS[id] && !PARTS[id].custom) throw new Error(`"${id}" is a built-in part — pick another id`);
      if (!(a.def && typeof a.def === "object")) d.elec = elecFromArgs(a); // kind= vmax= imax= roles=… on the command line
      const def = normalizeDef(d), existed = !!PARTS[id];
      PARTS[id] = def;
      this.emit({ type: "library", action: "create", id, def });
      return { id, label: def.label, prefix: def.prefix, pads: def.pads.length, body: def.body, updated: existed,
        pad_names: def.pads.slice(0, 40).map((p) => p.n), saved: "to the parts library on disk (when the agent server is running)" };
    }
    cmd_delete_part(a) {
      this.need(a, "id");
      const id = String(a.id).toLowerCase(), d = PARTS[id];
      if (!d) throw new Error(`no part "${a.id}"`);
      if (!d.custom) throw new Error(`"${id}" is built in and cannot be deleted`);
      const used = this.s.parts.filter((p) => p.type === id).map((p) => p.ref);
      if (used.length) throw new Error(`"${id}" is placed on the board as ${used.join(", ")} — remove those first`);
      delete PARTS[id];
      this.emit({ type: "library", action: "delete", id });
      return { deleted: id };
    }
    cmd_board() {
      const drc = this.cmd_drc();
      return {
        board: { w: this.s.board.w, h: this.s.board.h, units: "mm" }, rules: RULES,
        parts: this.s.parts.map((p) => ({ ref: p.ref, type: p.type, value: p.value, x: p.x, y: p.y, rot: p.rot,
          what_it_is: defOf(p.type).desc || "", what_it_does_here: p.note || "",
          pads: this.pads(p).map((q) => ({ n: q.n, fn: q.fn, desc: q.desc, x: q.x, y: q.y, net: q.net })) })),
        traces: this.s.traces.map((t) => ({ id: t.id, net: t.net, layer: t.layer, width: t.width,
          length: this.traceLength(t), points: t.pts })),
        vias: this.s.vias, links: this.s.links || [], nets: this.nets(), measures: this.s.measures,
        drc: { errors: drc.errors.length, warnings: drc.warnings.length },
      };
    }
    cmd_place(a) {
      this.need(a, "type", "x", "y");
      const type = String(a.type).toLowerCase(), d = PARTS[type];
      if (!d) throw new Error(`unknown part type "${a.type}" (${Object.keys(PARTS).join(", ")})`);
      let ref = a.ref ? String(a.ref) : "";
      if (ref && this.findPart(ref)) throw new Error(`ref ${ref} already exists`);
      if (!ref) { let n = 1; while (this.findPart(d.prefix + n)) n++; ref = d.prefix + n; }
      const part = { ref, type, x: r3(a.x), y: r3(a.y), rot: this.snapRot(a.rot || 0), value: a.value ? String(a.value) : d.value, nets: {} };
      this.s.parts.push(part);
      return { ref, x: part.x, y: part.y, rot: part.rot, pads: this.pads(part).map((p) => ({ n: p.n, fn: p.fn, x: p.x, y: p.y })),
        _focus: { x: part.x, y: part.y, label: "place " + ref } };
    }
    _reposition(part, mut) {
      const before = this.pads(part);
      mut(part);
      const after = this.pads(part);
      for (let i = 0; i < before.length; i++) {
        const o = before[i], n = after[i];
        for (const t of this.s.traces) {
          for (const k of [0, t.pts.length - 1]) {
            if (Math.abs(t.pts[k][0] - o.x) < 1e-6 && Math.abs(t.pts[k][1] - o.y) < 1e-6) t.pts[k] = [n.x, n.y];
          }
        }
      }
    }
    cmd_move(a) {
      this.need(a, "ref");
      const p = this.findPart(a.ref);
      if (!p) throw new Error(`no part ${a.ref}`);
      const x = a.x !== undefined ? a.x : p.x + (a.dx || 0), y = a.y !== undefined ? a.y : p.y + (a.dy || 0);
      if (a.x === undefined && a.y === undefined && a.dx === undefined && a.dy === undefined) throw new Error("missing x=,y= or dx=,dy=");
      this._reposition(p, (q) => { q.x = r3(x); q.y = r3(y); });
      return { ref: p.ref, x: p.x, y: p.y, _focus: { x: p.x, y: p.y, label: "move " + p.ref } };
    }
    cmd_rotate(a) {
      this.need(a, "ref");
      const p = this.findPart(a.ref);
      if (!p) throw new Error(`no part ${a.ref}`);
      const rot = this.snapRot(a.rot !== undefined ? a.rot : p.rot + (a.by === undefined ? 90 : a.by));
      this._reposition(p, (q) => { q.rot = rot; });
      return { ref: p.ref, rot, _focus: { x: p.x, y: p.y, label: "rotate " + p.ref } };
    }
    cmd_set_value(a) {
      this.need(a, "ref", "value");
      const p = this.findPart(a.ref);
      if (!p) throw new Error(`no part ${a.ref}`);
      p.value = String(a.value);
      return { ref: p.ref, value: p.value, _focus: { x: p.x, y: p.y, label: p.ref + " = " + p.value } };
    }
    cmd_remove(a) {
      if (a.ref) {
        const p = this.findPart(a.ref);
        if (!p) throw new Error(`no part ${a.ref}`);
        const pads = this.pads(p);
        const touching = (t) => [0, t.pts.length - 1].some((k) => pads.some((q) => Math.abs(t.pts[k][0] - q.x) < 1e-6 && Math.abs(t.pts[k][1] - q.y) < 1e-6));
        const gone = this.s.traces.filter(touching);
        this.s.traces = this.s.traces.filter((t) => !touching(t));
        this.s.links = (this.s.links || []).filter((l) => !l.a.startsWith(p.ref + ".") && !l.b.startsWith(p.ref + "."));
        this.s.parts = this.s.parts.filter((q) => q !== p);
        return { removed: p.ref, traces_removed: gone.length, _focus: { x: p.x, y: p.y, label: "remove " + p.ref } };
      }
      this.need(a, "id");
      for (const k of ["traces", "vias", "measures"]) {
        const i = this.s[k].findIndex((o) => o.id === a.id);
        if (i >= 0) { this.s[k].splice(i, 1); return { removed: a.id }; }
      }
      throw new Error(`nothing with id ${a.id}`);
    }
    // ---------- logical wiring (the graph view): a link says two pads are the same net, with or without copper ----------
    padRefOf(spec) {
      const r = this.resolve(spec);
      if (!r.pad) throw new Error(`"${spec}" is not a pad — use REF.PAD like U1.GND`);
      return r;
    }
    linked(a, b) { return (this.s.links || []).some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a)); }
    cmd_connect(a) {
      this.need(a, "a", "b");
      const A = this.padRefOf(a.a), B = this.padRefOf(a.b);
      if (A.pad.ref === B.pad.ref) throw new Error("a pad cannot be wired to itself");
      if (this.linked(A.pad.ref, B.pad.ref)) throw new Error(`${A.pad.ref} is already wired to ${B.pad.ref}`);
      let net = a.net ? String(a.net) : A.pad.net || B.pad.net;
      if (!net) {
        const named = [A.pad, B.pad].find((q) => /^(ground|power_out)$/.test(q.role) && q.fn);
        net = named ? named.fn : "";
        const used = new Set(this.nets().map((q) => q.name));
        if (!net || (used.has(net) && !this.nets().find((q) => q.name === net).pads.length)) { let n = 1; while (used.has("NET" + n)) n++; net = "NET" + n; }
      }
      for (const E of [A, B]) if (!E.pad.net) { E.part.nets = E.part.nets || {}; E.part.nets[E.pad.n] = net; }
      (this.s.links = this.s.links || []).push({ id: this.nextId("l"), a: A.pad.ref, b: B.pad.ref, net });
      return { a: A.pad.ref, b: B.pad.ref, net, note: "logical connection — route copper for it when you lay the board out" };
    }
    cmd_disconnect(a) {
      const ls = (this.s.links = this.s.links || []);
      let gone = [];
      if (a.id) {
        const i = ls.findIndex((l) => l.id === a.id);
        if (i >= 0) gone = ls.splice(i, 1);
        else { const j = this.s.traces.findIndex((t) => t.id === a.id); if (j < 0) throw new Error(`no wire ${a.id}`); const t = this.s.traces.splice(j, 1)[0]; gone = [{ trace: t.id }]; this._forgetNets(); return { removed: t.id }; }
      } else {
        this.need(a, "a", "b");
        const A = this.padRefOf(a.a).pad.ref, B = this.padRefOf(a.b).pad.ref;
        gone = ls.filter((l) => (l.a === A && l.b === B) || (l.a === B && l.b === A));
        if (!gone.length) throw new Error(`${A} and ${B} are not linked`);
        this.s.links = ls.filter((l) => !gone.includes(l));
      }
      this._forgetNets();
      return { removed: gone.map((l) => l.id || l.trace) };
    }
    // a pad that no longer touches any link or trace loses its net name
    _forgetNets() {
      const used = new Set();
      for (const l of this.s.links || []) { used.add(l.a); used.add(l.b); }
      for (const p of this.s.parts) for (const q of this.pads(p)) {
        if (!q.net || used.has(q.ref)) continue;
        const touched = this.s.traces.some((t) => [0, t.pts.length - 1].some((k) => Math.abs(t.pts[k][0] - q.x) < 1e-6 && Math.abs(t.pts[k][1] - q.y) < 1e-6));
        if (!touched) delete p.nets[q.n];
      }
    }
    // ---------- sourcing: which real part (price, stock, where to buy) a placed part is ----------
    cmd_source(a) {
      this.need(a, "ref");
      const p = this.findPart(a.ref);
      if (!p) throw new Error(`no part ${a.ref}`);
      if (a.clear === true || a.clear === "1" || a.clear === 1 || a.clear === "true") { delete p.buy; return { ref: p.ref, cleared: true }; }
      this.need(a, "mpn");
      const price = a.price === undefined || a.price === "" ? null : Number(a.price);
      if (price !== null && !(price >= 0)) throw new Error("price must be a number (USD for one piece)");
      let tiers = Array.isArray(a.tiers) ? a.tiers : [];
      if (typeof a.tiers === "string") tiers = a.tiers.split(",").map((x) => { const m = x.match(/^(\d+)-?\d*:([\d.]+)$/); return m ? { min: +m[1], price: +m[2] } : null; }).filter(Boolean);
      if (!tiers.length && price !== null) tiers = [{ min: 1, price }];
      p.buy = { id: a.id ? String(a.id) : "", mpn: String(a.mpn).slice(0, 60), pkg: a.pkg ? String(a.pkg) : "", price, tiers: tiers.slice(0, 12), stock: a.stock === undefined || a.stock === "" ? null : Number(a.stock),
        basic: a.basic === true || a.basic === "1" || a.basic === "true", url: a.url ? String(a.url) : (a.id ? "https://www.lcsc.com/product-detail/" + a.id + ".html" : ""), desc: a.desc ? String(a.desc).slice(0, 160) : "" };
      return { ref: p.ref, sourced_as: p.buy.mpn, price: p.buy.price, url: p.buy.url };
    }
    cmd_bom(a) {
      const boards = Math.max(1, Math.floor(Number(a.boards) || 1)), rows = new Map(), unsourced = [];
      const tierPrice = (b, qty) => { let pr = b.tiers && b.tiers.length ? b.tiers[0].price : b.price; for (const t of b.tiers || []) if (qty >= t.min) pr = t.price; return pr; };
      for (const p of this.s.parts) {
        const d = defOf(p.type);
        if (/^H/.test(d.prefix) && !p.buy) continue; // mounting holes are not bought
        const key = p.buy ? "b:" + (p.buy.id || p.buy.mpn) : "g:" + p.type + "|" + p.value;
        if (!rows.has(key)) rows.set(key, { refs: [], per_board: 0, value: p.value, type: d.label, buy: p.buy || null });
        const r = rows.get(key); r.refs.push(p.ref); r.per_board++;
        if (!p.buy) unsourced.push(p.ref);
      }
      let total = 0, sourced = 0;
      const out = [...rows.values()].map((r) => {
        const qty = r.per_board * boards, b = r.buy, unit = b && b.price !== null ? tierPrice(b, qty) : null, line = unit === null ? null : Math.round(unit * qty * 1e5) / 1e5;
        if (line !== null) { total += line; sourced += r.per_board; }
        return { refs: r.refs.join(","), qty: r.per_board, value: r.value, part: r.type, mpn: b ? b.mpn : "", lcsc: b ? b.id : "", pkg: b ? b.pkg : "", unit_price: unit, line_total: line, stock: b ? b.stock : null, url: b ? b.url : "", sourced: !!b };
      });
      return { boards, rows: out, total: Math.round(total * 1e4) / 1e4, currency: "USD", parts_sourced: sourced, unsourced, note: unsourced.length ? `${unsourced.length} part(s) not sourced yet — total is incomplete` : "all parts sourced" };
    }
    // put a part (default a resistor) in series with one pin: X—PIN becomes X—NEW.1, NEW.2—PIN
    cmd_insert_series(a) {
      this.need(a, "pad");
      const P = this.padRefOf(a.pad), ref = P.pad.ref, ls = this.s.links || [];
      const mine = ls.filter((l) => l.a === ref || l.b === ref);
      if (!mine.length) throw new Error(`${ref} is not wired to anything yet — connect it first`);
      const copper = this.s.traces.some((t) => [0, t.pts.length - 1].some((k) => Math.abs(t.pts[k][0] - P.pad.x) < 1e-6 && Math.abs(t.pts[k][1] - P.pad.y) < 1e-6));
      if (copper) throw new Error(`${ref} already has copper routed to it — delete that trace first, then insert the part`);
      const others = mine.map((l) => (l.a === ref ? l.b : l.a));
      const O = this.resolve(others[0]);
      let x = r3((P.part.x + O.x) / 2), y = r3((P.part.y + O.y) / 2);
      while (this.s.parts.some((q) => Math.hypot(q.x - x, q.y - y) < 6) && y < this.s.board.h - 4) y += 6;
      const placed = this.cmd_place({ type: a.type || "resistor", x: a.x !== undefined ? a.x : x, y: a.y !== undefined ? a.y : y, value: a.value || undefined });
      const NEW = this.findPart(placed.ref);
      this.s.links = ls.filter((l) => !mine.includes(l));
      if (P.part.nets) delete P.part.nets[P.pad.n]; // this side of the new part becomes its own net
      for (const o of others) this.cmd_connect({ a: o, b: NEW.ref + ".1" });
      const res = this.cmd_connect({ a: NEW.ref + ".2", b: ref });
      return { ref: NEW.ref, value: NEW.value, between: others.concat(ref), new_net_at_pin: res.net };
    }
    cmd_route(a) {
      this.need(a, "from", "to");
      const A = this.resolve(a.from), B = this.resolve(a.to);
      const via = [];
      if (a.points) for (const t of String(a.points).split("/").filter(Boolean)) via.push(this.resolve(t));
      const targets = [...via, B], pts = [{ x: A.x, y: A.y }];
      for (const T of targets) {
        const prev = pts[pts.length - 1];
        if (a.elbow !== 0 && a.elbow !== "0" && a.elbow !== false) for (const e of elbow(prev, T)) pts.push(e);
        pts.push({ x: r3(T.x), y: r3(T.y) });
      }
      const clean = pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-6);
      if (clean.length < 2) throw new Error("route start and end are the same point");
      const nA = A.pad ? A.pad.net : "", nB = B.pad ? B.pad.net : "";
      if (nA && nB && nA !== nB && !a.net) throw new Error(`would short nets ${nA} and ${nB} — pass net=${nA} only if you mean to merge`);
      if (a.net) for (const [n, w] of [[nA, A.pad && A.pad.ref], [nB, B.pad && B.pad.ref]])
        if (n && n !== a.net) throw new Error(`${w} is already on net ${n}, not ${a.net}`);
      let net = a.net ? String(a.net) : nA || nB;
      if (!net) { let n = 1; const used = new Set(this.nets().map((q) => q.name)); while (used.has("NET" + n)) n++; net = "NET" + n; }
      const layer = this.layerOf(a.layer);
      const width = a.width !== undefined ? a.width : 0.25;
      if (!(width > 0)) throw new Error("width must be > 0");
      for (const E of [A, B]) if (E.pad) { E.part.nets = E.part.nets || {}; E.part.nets[E.pad.n] = net; }
      const t = { id: this.nextId("t"), net, layer, width: r3(width), pts: clean.map((p) => [r3(p.x), r3(p.y)]) };
      this.s.traces.push(t);
      const mid = t.pts[Math.floor(t.pts.length / 2)];
      return { id: t.id, net, layer, width: t.width, length: this.traceLength(t), points: t.pts,
        _focus: { x: mid[0], y: mid[1], label: "route " + net } };
    }
    layerOf(v) {
      if (v === undefined || v === "") return "F.Cu";
      const s = String(v).toLowerCase();
      if (["f.cu", "f", "top", "front"].includes(s)) return "F.Cu";
      if (["b.cu", "b", "bottom", "back"].includes(s)) return "B.Cu";
      throw new Error('layer must be F.Cu or B.Cu');
    }
    cmd_add_via(a) {
      this.need(a, "x", "y");
      const v = { id: this.nextId("v"), x: r3(a.x), y: r3(a.y), net: a.net ? String(a.net) : "", d: a.d || 0.6, drill: a.drill || 0.3 };
      if (!(v.drill < v.d)) throw new Error("drill must be smaller than d");
      this.s.vias.push(v);
      return { id: v.id, _focus: { x: v.x, y: v.y, label: "via" } };
    }
    cmd_set_trace(a) {
      this.need(a, "id");
      const t = this.s.traces.find((q) => q.id === a.id);
      if (!t) throw new Error(`no trace ${a.id}`);
      if (a.width !== undefined) { if (!(a.width > 0)) throw new Error("width must be > 0"); t.width = r3(a.width); }
      if (a.net !== undefined && a.net !== "") t.net = String(a.net);
      if (a.layer !== undefined) t.layer = this.layerOf(a.layer);
      return { id: t.id, net: t.net, layer: t.layer, width: t.width, _focus: { x: t.pts[0][0], y: t.pts[0][1], label: "edit " + t.id } };
    }
    cmd_measure(a) {
      this.need(a, "from", "to");
      const A = this.resolve(a.from), B = this.resolve(a.to);
      const dx = r3(B.x - A.x), dy = r3(B.y - A.y), distance = r3(Math.hypot(dx, dy));
      this.s.measures.push({ id: this.nextId("m"), a: { x: r3(A.x), y: r3(A.y) }, b: { x: r3(B.x), y: r3(B.y) } });
      if (this.s.measures.length > 12) this.s.measures.shift();
      return { dx, dy, distance, unit: "mm", _focus: { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, label: distance.toFixed(2) + " mm" } };
    }
    cmd_clear_measures() { const n = this.s.measures.length; this.s.measures = []; return { cleared: n }; }
    cmd_set_board(a) {
      this.need(a, "w", "h");
      if (!(a.w >= 5 && a.w <= 300 && a.h >= 5 && a.h <= 300)) throw new Error("board size must be 5–300 mm");
      this.s.board = { w: r3(a.w), h: r3(a.h) };
      return { w: this.s.board.w, h: this.s.board.h };
    }
    cmd_clear() {
      const n = this.s.parts.length;
      this.s.parts = []; this.s.traces = []; this.s.vias = []; this.s.links = []; this.s.measures = []; this.s.netNotes = {};
      return { cleared_parts: n };
    }
    // plain-English notes: what a part (or net) is doing in THIS circuit
    cmd_describe(a) {
      const text = a.text === undefined ? "" : String(a.text).trim().slice(0, 400);
      if (a.net) {
        const name = String(a.net);
        if (!this.nets().some((q) => q.name === name)) throw new Error(`no net ${name}`);
        this.s.netNotes = this.s.netNotes || {};
        if (text) this.s.netNotes[name] = text; else delete this.s.netNotes[name];
        return { net: name, note: text, _focus: this.cmd_highlight({ net: name })._focus };
      }
      this.need(a, "ref");
      const p = this.findPart(a.ref);
      if (!p) throw new Error(`no part ${a.ref}`);
      if (text) p.note = text; else delete p.note;
      return { ref: p.ref, note: text, _focus: { x: p.x, y: p.y, label: p.ref + " noted" } };
    }
    cmd_highlight(a) {
      if (a.net) {
        const t = this.s.traces.find((q) => q.net === String(a.net));
        const pd = this.allPads().find((q) => q.net === String(a.net));
        const at = t ? { x: t.pts[0][0], y: t.pts[0][1] } : pd ? { x: pd.x, y: pd.y } : null;
        if (!at) throw new Error(`no net ${a.net}`);
        return { net: String(a.net), _focus: { x: at.x, y: at.y, label: "net " + a.net } };
      }
      this.need(a, "ref");
      const r = this.resolve(a.ref);
      return { x: r.x, y: r.y, _focus: { x: r.x, y: r.y, label: String(a.ref) } };
    }
    cmd_undo() { if (!this.undoS.length) throw new Error("nothing to undo"); this.redoS.push(JSON.stringify(this.s)); this.s = JSON.parse(this.undoS.pop()); this.emit({ type: "change", cmd: "undo" }); return { ok: true }; }
    cmd_redo() { if (!this.redoS.length) throw new Error("nothing to redo"); this.undoS.push(JSON.stringify(this.s)); this.s = JSON.parse(this.redoS.pop()); this.emit({ type: "change", cmd: "redo" }); return { ok: true }; }

    cmd_load_sample() {
      this.reset(60, 40);
      const run = (c, a) => this["cmd_" + c](a);
      for (const [x, y, ref] of [[3.5, 3.5, "H1"], [56.5, 3.5, "H2"], [3.5, 36.5, "H3"], [56.5, 36.5, "H4"]]) run("place", { type: "hole", x, y, ref });
      run("place", { type: "usbc", x: 3, y: 20, ref: "J1" });
      run("place", { type: "mcu", x: 30, y: 20, ref: "U1", value: "STM32G0" });
      run("place", { type: "ldo", x: 16, y: 30, ref: "U2" });
      run("place", { type: "capacitor", x: 22, y: 33, ref: "C1" });
      run("place", { type: "resistor", x: 30, y: 32, ref: "R1" });
      run("place", { type: "led", x: 37, y: 32, ref: "D1" });
      run("place", { type: "header", x: 54, y: 20, ref: "J2" });
      run("route", { from: "J1.D+", to: "U1.1", net: "USB_DP", width: 0.25 });
      run("route", { from: "J1.D-", to: "U1.2", net: "USB_DM", width: 0.25 });
      run("route", { from: "J1.GND", to: "U1.3", net: "GND", width: 0.4 });
      run("route", { from: "J1.VBUS", to: "U2.IN", net: "VBUS", width: 0.5 });
      run("route", { from: "U2.OUT", to: "U1.4", net: "+3V3", width: 0.4 });
      run("route", { from: "U2.OUT", to: "C1.1", net: "+3V3", width: 0.4 });
      run("route", { from: "U1.PA5", to: "R1.1", net: "LED_PA5" });
      run("route", { from: "R1.2", to: "D1.A", net: "LED_A" });
      run("route", { from: "U1.12", to: "J2.2", net: "IO1" });
      run("route", { from: "U1.11", to: "J2.3", net: "IO2" });
      run("route", { from: "U1.10", to: "J2.4", net: "IO3" });
      run("route", { from: "U1.9", to: "J2.5", net: "IO4" });
      // ground return on the bottom copper: vias at each ground pad + B.Cu traces joining them
      for (const g of ["J1.GND", "U2.GND", "C1.2", "D1.K"]) { const p = this.resolve(g); run("add_via", { x: p.x, y: p.y, net: "GND" }); }
      run("route", { from: "J1.GND", to: "U2.GND", net: "GND", width: 0.4, layer: "B.Cu" });
      run("route", { from: "U2.GND", to: "C1.2", net: "GND", width: 0.4, layer: "B.Cu" });
      run("route", { from: "C1.2", to: "D1.K", net: "GND", width: 0.4, layer: "B.Cu" });
      const note = (ref, text) => this.cmd_describe({ ref, text });
      note("J1", "Power + data in. Plug a USB cable here: it gives the board 5 V and lets the computer talk to the chip.");
      note("U1", "The main chip. Reads USB, blinks the LED on pin PA5, and brings four I/O lines out to the header.");
      note("U2", "Voltage regulator: turns the 5 V from USB (VBUS) into a steady 3.3 V (+3V3) that the chip needs.");
      note("C1", "Smooths the 3.3 V supply so the chip doesn't glitch when it suddenly draws more current.");
      note("R1", "Current limiter for the LED (330 Ω) — without it the LED would burn out.");
      note("D1", "Status LED. The chip's PA5 pin turns it on and off through R1.");
      note("J2", "Breakout header: four I/O lines from the chip so you can wire in sensors or a programmer.");
      for (const h of ["H1", "H2", "H3", "H4"]) note(h, "Mounting hole — screw the board to a case here.");
      this.s.netNotes = { VBUS: "5 V from the USB cable → goes to the regulator input.", "+3V3": "Regulated 3.3 V power rail → feeds the chip (and C1 smooths it).",
        GND: "Ground (0 V) — the return path for every current on the board.", USB_DP: "USB data + wire: connector → chip.", USB_DM: "USB data − wire: connector → chip.",
        LED_PA5: "Chip pin PA5 → R1: the signal that switches the LED.", LED_A: "R1 → LED anode (+): current to the LED.",
        IO1: "Chip I/O → header pin 2.", IO2: "Chip I/O → header pin 3.", IO3: "Chip I/O → header pin 4.", IO4: "Chip I/O → header pin 5." };
      return { parts: this.s.parts.length, traces: this.s.traces.length };
    }

    // ---------- design rule check ----------
    cmd_drc() {
      const { w, h } = this.s.board, items = [];
      for (const p of this.s.parts) for (const q of this.pads(p)) {
        const shape = q.shape === "circle" ? { t: "circ", x: q.x, y: q.y, r: q.w / 2 }
          : { t: "rect", x0: q.x - q.w / 2, y0: q.y - q.h / 2, x1: q.x + q.w / 2, y1: q.y + q.h / 2 };
        items.push({ shape, net: q.net, layers: q.thru ? ["F.Cu", "B.Cu"] : ["F.Cu"], label: q.ref, grp: q.ref });
      }
      for (const t of this.s.traces) for (let i = 1; i < t.pts.length; i++)
        items.push({ shape: { t: "seg", a: { x: t.pts[i - 1][0], y: t.pts[i - 1][1] }, b: { x: t.pts[i][0], y: t.pts[i][1] }, r: t.width / 2 },
          net: t.net, layers: [t.layer], label: "trace " + t.id + " (" + t.net + ")", grp: t.id });
      for (const v of this.s.vias)
        items.push({ shape: { t: "circ", x: v.x, y: v.y, r: v.d / 2 }, net: v.net, layers: ["F.Cu", "B.Cu"], label: "via " + v.id, grp: v.id });

      const errors = [], warnings = [];
      for (const t of this.s.traces) if (t.width < RULES.minTrace - 1e-9)
        errors.push({ rule: "min_trace", msg: `trace ${t.id} (${t.net}) is ${t.width} mm wide, minimum ${RULES.minTrace} mm`, x: t.pts[0][0], y: t.pts[0][1] });
      const seen = new Map();
      for (const it of items) {
        const b = bbox(it.shape);
        if (b[0] < RULES.edge - 1e-9 || b[1] < RULES.edge - 1e-9 || b[2] > w - RULES.edge + 1e-9 || b[3] > h - RULES.edge + 1e-9) {
          const key = "edge|" + it.grp;
          if (!seen.has(key)) {
            seen.set(key, 1);
            errors.push({ rule: "edge", msg: `${it.label} is closer than ${RULES.edge} mm to the board edge`, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });
          }
        }
      }
      const best = new Map();
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const A = items[i], B = items[j];
        if (A.grp === B.grp || (A.net && A.net === B.net)) continue;
        if (!A.layers.some((l) => B.layers.includes(l))) continue;
        const ba = bbox(A.shape), bb = bbox(B.shape), m = RULES.minGap;
        if (ba[0] > bb[2] + m || bb[0] > ba[2] + m || ba[1] > bb[3] + m || bb[1] > ba[3] + m) continue;
        const g = gap(A.shape, B.shape);
        if (g.d >= RULES.minGap - 1e-9) continue;
        const key = [A.label, B.label].sort().join(" | ");
        if (!best.has(key) || g.d < best.get(key).d)
          best.set(key, { d: g.d, x: g.x, y: g.y, A, B });
      }
      for (const v of best.values()) {
        const short = v.d <= 0;
        errors.push({ rule: short ? "short" : "clearance", x: v.x, y: v.y,
          msg: short ? `${v.A.label} overlaps ${v.B.label}` : `gap ${Math.max(0, v.d).toFixed(2)} mm < ${RULES.minGap} mm between ${v.A.label} and ${v.B.label}` });
      }
      return { errors, warnings, ok: !errors.length && !warnings.length };
    }
  }

  // used by the UI to load the persisted library without re-saving it
  const registerPart = (id, d) => { PARTS[safeId(id)] = normalizeDef(d); };
  root.TraceEngine = { Board, PARTS, RULES, USAGE, elbow, defOf, registerPart, normalizeDef, safeId, sanitizeElec, parseRoles, ELEC_KINDS, ROLES, ELEC_NUM,
    geom: { gap, bbox, pdist, segDist }, MUTATING };
})(typeof window !== "undefined" ? window : globalThis);
