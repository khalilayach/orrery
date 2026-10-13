// TRACE parts finder — real, buyable parts with price, stock and buy links. No API key.
// Source: the open jlcsearch catalog (https://jlcsearch.tscircuit.com, the LCSC / JLCPCB parts list).
// Runs in the page AND in node (server/trace-cli.mjs `find_parts`), so Claude can use it too.
// Exposes TraceFinder: search(), recommendFor(), parseValue(), fmtOhms(), fmtFarads(), links(), pick().
(function (root) {
  "use strict";
  const BASE = root.TRACE_FINDER_BASE || "https://jlcsearch.tscircuit.com"; // overridable so tests can use a fixture catalog
  const CACHE_KEY = "trace-finder-v1";
  const TTL = 15 * 60 * 1000;

  // ---------- values: 330R 4k7 0R1 100nF 10uF 3.3V ----------
  const MULT = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1 };
  function parseValue(str) {
    const s = String(str == null ? "" : str).trim().replace(/Ω|ohms?|farads?|volts?/gi, (m) => (/^f/i.test(m) ? "F" : /^v/i.test(m) ? "V" : "R"));
    let m = s.match(/^(\d+)([RkKMGpnuµm])(\d+)$/); // 4k7, 0R1, 2u2
    if (m) return Number(m[1] + "." + m[3]) * MULT[m[2]];
    m = s.match(/^(\d+(?:\.\d+)?)\s*([pnuµmkKMG])?\s*([RFVAH])?$/);
    if (!m) return NaN;
    return Number(m[1]) * (m[2] ? MULT[m[2]] : 1);
  }
  const trim = (n) => String(Math.round(n * 1e6) / 1e6);
  function fmtOhms(o) {
    const letter = (n, L) => { const t = trim(n); return t.includes(".") ? t.replace(".", L) : t + L; }; // 4.7 → 4k7, 10 → 10k
    if (o >= 1e6) return letter(o / 1e6, "M");
    if (o >= 1e3) return letter(o / 1e3, "k");
    return letter(o, "R"); // 330 → 330R, 0.1 → 0R1
  }
  function fmtFarads(f) {
    if (f >= 1e-6) return trim(f * 1e6) + "uF";
    if (f >= 1e-9) return trim(f * 1e9) + "nF";
    return trim(f * 1e12) + "pF";
  }

  // ---------- understanding what was typed ----------
  const PKG = /\b(0201|0402|0603|0805|1206|1210|2512|SOT-?\d+(?:-\d+)?|SOIC-?\d+|TSSOP-?\d+|MSOP-?\d+|SOP-?\d+|QFN-?\d+|DFN-?\d+|LQFP-?\d+|TQFP-?\d+|DIP-?\d+|TO-?\d+[A-Z]?)\b/i;
  const COLORS = ["red", "green", "blue", "yellow", "white", "orange", "amber"];
  function intent(q, kind) {
    const text = String(q || "").trim(), low = text.toLowerCase();
    const out = { text, kind: kind || "", value: NaN, pkg: "", color: "", volts: NaN };
    const pk = text.match(PKG);
    if (pk) out.pkg = pk[1].toUpperCase();
    out.color = COLORS.find((c) => low.includes(c)) || "";
    if (!out.kind) {
      if (/\b(led)\b/.test(low)) out.kind = "led";
      else if (/\b(ldo|regulator|vreg)\b/.test(low)) out.kind = "regulator";
      else if (/\d\s*(pf|nf|uf|µf)\b|\bcap(acitor)?\b/.test(low)) out.kind = "capacitor";
      else if (/\d\s*(r|k|m)?\s*(ω|ohm)\b|\b\d+(\.\d+)?[rkm]\d*\b|\bresistor\b/.test(low) && !/\bpin\b/.test(low)) out.kind = "resistor";
      else if (/\b(mcu|stm32|esp32|atmega|attiny|rp2040|pic\d|msp430|microcontroller)\b/.test(low)) out.kind = "mcu";
      else if (/\bheader\b|\bpin\s*header\b/.test(low)) out.kind = "header";
    }
    const tokens = text.split(/\s+/).filter(Boolean).filter((t) => !pk || t.toUpperCase() !== pk[1].toUpperCase());
    if (out.kind === "regulator") { const v = text.match(/(\d+(?:\.\d+)?)\s*v\b/i); if (v) out.volts = Number(v[1]); }
    else for (const t of tokens) { const n = parseValue(t); if (Number.isFinite(n) && /\d/.test(t) && !/^\d{4}$/.test(t) || /^\d+[pnuµ]f$/i.test(t)) { out.value = n; break; } }
    return out;
  }

  // ---------- links: where to buy ----------
  function links(mpn, lcsc) {
    const q = encodeURIComponent(mpn || "");
    const o = { digikey: "https://www.digikey.com/en/products/result?keywords=" + q, mouser: "https://www.mouser.com/c/?q=" + q,
      datasheet: "https://www.google.com/search?q=" + encodeURIComponent((mpn || "") + " datasheet") };
    if (lcsc) { const c = /^C/i.test(String(lcsc)) ? lcsc : "C" + lcsc; o.lcsc = "https://www.lcsc.com/product-detail/" + c + ".html"; o.jlcpcb = "https://jlcpcb.com/parts/componentSearch?isSearch=true&searchTxt=" + c; }
    return o;
  }

  // ---------- normalise a catalog row → Part ----------
  const ledVf = { red: 2, orange: 2, amber: 2, yellow: 2.1, green: 2.1, blue: 3, white: 3.1 };
  function tiersOf(r) {
    if (typeof r.price === "string" && r.price) {
      const t = r.price.split(",").map((x) => { const m = x.match(/^(\d+)-(\d*):([\d.]+)$/); return m ? { min: +m[1], price: +m[3] } : null; }).filter(Boolean);
      if (t.length) return t;
    }
    const p = Number(r.price1 != null ? r.price1 : r.price);
    return Number.isFinite(p) ? [{ min: 1, price: p }] : [];
  }
  const SOT = { "SOT-23": 3, "SOT-23-3": 3, "SSOT-23": 3, "SOT-23-5": 5, "SOT-23-6": 6, "SOT-223": 4, "SOT-89": 3, "SOT-89-3": 3, "SOT-323": 3, "SOT-363": 6 };
  function sizeFor(pkg, pins) {
    const p = String(pkg || "").toUpperCase().replace(/[(,].*$/, "").trim();
    if (pins) return { pkg: p, pins };
    if (SOT[p]) return { pkg: p, pins: SOT[p] };
    const m = p.match(/^(?:TSSOP|SSOP|MSOP|SOIC|SOP|QFN|DFN|LQFP|TQFP|QFP|DIP|VQFN|VFQFN|UFQFPN)-?(\d+)/);
    return { pkg: p, pins: m ? Number(m[1]) : 0 };
  }
  function hintFor(kind, r, it) {
    const pkg = String(r.package || "");
    if (kind === "resistor" && r.resistance) return { type: "resistor", value: fmtOhms(r.resistance), elec: r.power_watts ? { pmax: r.power_watts > 5 ? r.power_watts / 1000 : r.power_watts } : {} };
    if (kind === "capacitor" && r.capacitance_farads) return { type: "capacitor", value: fmtFarads(r.capacitance_farads), elec: r.voltage_rating ? { vmax: r.voltage_rating } : {} };
    if (kind === "led") {
      const e = { imax: r.forward_current || 0.02 };
      if (r.forward_voltage) e.vf = r.forward_voltage;
      return { type: "led", value: r.color || it.color || "green", elec: e };
    }
    if (kind === "regulator") {
      const e = { vout: r.output_voltage_min, imax: r.output_current_max || undefined };
      if (r.dropout_voltage) e.dropout = r.dropout_voltage;
      if (r.input_voltage_max) e.vin_max = r.input_voltage_max;
      for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null) delete e[k];
      return { type: "ldo", value: r.mfr, elec: e };
    }
    if (kind === "mcu") {
      const e = {};
      if (r.supply_voltage_min) e.vdd_min = r.supply_voltage_min;
      if (r.supply_voltage_max) e.vdd_max = r.supply_voltage_max;
      return { type: "mcu", value: r.mfr, elec: e, generic_footprint: true };
    }
    // anything else: build a footprint from the package name
    const cat = String(r.category || "").toLowerCase() + " " + String(r.description || "").toLowerCase();
    const { pins } = sizeFor(pkg);
    const base = { label: String(r.mfr).slice(0, 40), value: String(r.mfr).slice(0, 24), pkg };
    if (/^(0201|0402|0603|0805|1206|1210|2512|SOD|SMA|SMB|SMC|DO-)/i.test(pkg) || /diode|fuse|ferrite|inductor|capacitor|resistor/.test(cat))
      return { create: Object.assign({ template: "two_pad", prefix: /diode|tvs|esd/.test(cat) ? "D" : /ferrite|inductor/.test(cat) ? "L" : /fuse/.test(cat) ? "F" : "X" }, base) };
    if (r.num_pins || /header/.test(cat)) return { create: Object.assign({ template: "header", pins: r.num_pins || 2, prefix: "J" }, base) };
    if (/qfn|qfp|dfn/i.test(pkg) && pins) return { create: Object.assign({ template: "quad", pins, prefix: "U" }, base) };
    if (/soic|sop|tssop|msop|dip|ssop/i.test(pkg) && pins) return { create: Object.assign({ template: "dual", pins, prefix: "U" }, base) };
    const even = (n) => (n % 2 ? n + 1 : n);
    if (/^S?SOT/i.test(pkg) && pins) return { create: Object.assign({ template: "dual", pins: even(pins), prefix: /transistor|bjt|mosfet/.test(cat) ? "Q" : "U" }, base), note: "approximate " + pkg + " footprint — check the datasheet" };
    return { create: Object.assign({ template: "dual", pins: even(pins || 8), prefix: "U" }, base), note: "approximate footprint from the package name — check the datasheet" };
  }
  function normalize(kind, r, it) {
    const tiers = tiersOf(r), price = tiers.length ? tiers[0].price : null, mpn = String(r.mfr || "");
    const specs = {};
    for (const k of ["resistance", "capacitance_farads", "voltage_rating", "power_watts", "tolerance_fraction", "color", "forward_current", "forward_voltage", "output_voltage_min", "output_current_max", "dropout_voltage", "input_voltage_max", "supply_voltage_min", "supply_voltage_max", "cpu_core", "num_pins", "pitch_mm"])
      if (r[k] !== undefined && r[k] !== null) specs[k] = r[k];
    return { id: "C" + r.lcsc, lcsc: r.lcsc, mpn, pkg: String(r.package || ""), desc: String(r.description || "").replace(/\s+/g, " ").slice(0, 160), category: r.category || "",
      kind: kind || "", stock: Number(r.stock) || 0, inStock: r.in_stock !== undefined ? !!r.in_stock : (Number(r.stock) || 0) > 0,
      price, tiers, basic: !!r.is_basic, preferred: !!r.is_preferred, specs, links: links(mpn, r.lcsc), hint: hintFor(kind, r, it) };
  }
  /** unit price for N pieces (uses the quantity price breaks) */
  function priceAt(part, qty) {
    let p = part.tiers.length ? part.tiers[0].price : part.price;
    for (const t of part.tiers || []) if (qty >= t.min) p = t.price;
    return p;
  }

  // ---------- network + cache ----------
  const mem = new Map();
  function lsGet() { try { return JSON.parse(root.localStorage.getItem(CACHE_KEY) || "{}"); } catch (_) { return {}; } }
  function lsPut(k, v) {
    try {
      const all = lsGet(); all[k] = { t: Date.now(), v };
      const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t).slice(0, 24);
      const keep = {}; for (const x of keys) keep[x] = all[x];
      root.localStorage.setItem(CACHE_KEY, JSON.stringify(keep));
    } catch (_) { /* full or private mode */ }
  }
  async function getJson(path) {
    const hit = mem.get(path);
    if (hit && Date.now() - hit.t < TTL) return hit.v;
    const disk = lsGet()[path];
    if (disk && Date.now() - disk.t < TTL) { mem.set(path, disk); return disk.v; }
    let res;
    try {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null, to = ctl && setTimeout(() => ctl.abort(), 15000);
      res = await root.fetch(BASE + path, ctl ? { signal: ctl.signal } : undefined);
      if (to) clearTimeout(to);
      if (!res.ok) throw new Error("catalog answered " + res.status);
      const v = await res.json();
      mem.set(path, { t: Date.now(), v }); lsPut(path, v);
      return v;
    } catch (e) {
      if (disk) return Object.assign({}, disk.v, { _stale: true }); // offline: last known answer
      throw new Error("can't reach the parts catalog (" + (e.name === "AbortError" ? "timed out" : e.message) + ") — check your internet connection");
    }
  }
  const rows = (j) => (j && j[Object.keys(j).find((k) => Array.isArray(j[k]))]) || [];

  // ---------- ranking ----------
  function relevance(r, tokens) {
    const mpn = String(r.mfr || "").toLowerCase(), rest = (String(r.description || "") + " " + String(r.category || "") + " " + String(r.subcategory || "") + " " + String(r.package || "")).toLowerCase();
    let s = 0;
    for (const t of tokens) { if (mpn.includes(t)) s += 3; else if (rest.includes(t)) s += 1; }
    return s;
  }
  function rank(list, tokensCount) {
    const ok = (p) => (p.inStock && p.stock >= 100 ? 2 : p.inStock ? 1 : 0); // a handful in stock is barely better than none
    return list.sort((a, b) =>
      ok(b) - ok(a) || (b._rel || 0) - (a._rel || 0) ||
      (b.basic ? 1 : 0) - (a.basic ? 1 : 0) || (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0) ||
      (a.price == null ? 1e9 : a.price) - (b.price == null ? 1e9 : b.price) || (b.stock - a.stock));
  }

  // ---------- the search ----------
  async function search(opts) {
    const o = typeof opts === "string" ? { q: opts } : opts || {};
    const it = intent(o.q, o.kind);
    if (o.value !== undefined && o.value !== "") { const n = typeof o.value === "number" ? o.value : parseValue(o.value); if (Number.isFinite(n)) it.value = n; }
    if (o.volts) it.volts = Number(o.volts);
    if (o.pkg) it.pkg = String(o.pkg).toUpperCase();
    const limit = o.limit || 12;
    let list = [], note = "", stale = false;
    const get = async (p) => { const j = await getJson(p); if (j._stale) stale = true; return rows(j); };
    const kind = it.kind;
    if (kind === "resistor" && Number.isFinite(it.value)) {
      list = (await get(`/resistors/list.json?resistance=${it.value}&package=${encodeURIComponent(it.pkg || "0603")}&limit=100`)).map((r) => normalize("resistor", r, it));
      note = `${fmtOhms(it.value)} resistors in ${it.pkg || "0603"}`;
    } else if (kind === "capacitor" && Number.isFinite(it.value)) {
      list = (await get(`/capacitors/list.json?capacitance=${it.value}&package=${encodeURIComponent(it.pkg || "0603")}&limit=100`)).map((r) => normalize("capacitor", r, it));
      note = `${fmtFarads(it.value)} capacitors in ${it.pkg || "0603"}`;
    } else if (kind === "led") {
      list = (await get(`/leds/list.json?color=${encodeURIComponent(it.color || "green")}&package=${encodeURIComponent(it.pkg || "0603")}&limit=100`)).map((r) => normalize("led", r, it));
      note = `${it.color || "green"} LEDs in ${it.pkg || "0603"}`;
    } else if (kind === "regulator") {
      const pk = it.pkg ? [it.pkg] : ["", "SOT-223", "SOT-89", "SOT-23-5", "SOT-23-3"];
      const sets = await Promise.all(pk.map((p) => get(`/ldos/list.json?${p ? "package=" + encodeURIComponent(p) + "&" : ""}limit=100`).catch(() => [])));
      const seen = new Set();
      for (const r of sets.flat()) {
        if (seen.has(r.lcsc)) continue; seen.add(r.lcsc);
        if (Number.isFinite(it.volts) && Math.abs((r.output_voltage_min || 0) - it.volts) > 0.06) continue;
        if (o.minCurrent && (r.output_current_max || 0) < o.minCurrent) continue;
        list.push(normalize("regulator", r, it));
      }
      note = Number.isFinite(it.volts) ? `${it.volts} V regulators` : "voltage regulators";
    } else if (kind === "mcu" && !/\w{4,}/.test(it.text.replace(/\b(mcu|microcontroller)\b/gi, ""))) {
      const raw = await get("/microcontrollers/list.json?limit=100");
      list = raw.filter((r) => !o.vdd || ((r.supply_voltage_min || 0) <= o.vdd && (r.supply_voltage_max || 99) >= o.vdd)).map((r) => normalize("mcu", r, it));
      note = "microcontrollers";
    } else {
      const text = it.text || "";
      if (!text) throw new Error("type what you are looking for, e.g. 100nF 0603, green LED, 3.3V LDO, AMS1117, STM32F103");
      const raw = await get(`/components/list.json?search=${encodeURIComponent(text)}&limit=100`);
      const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      list = raw.map((r) => { const p = normalize(kind || "", r, it); p._rel = relevance(r, tokens); return p; });
      const good = list.filter((p) => p._rel > 0);
      list = good.length ? good : list.slice(0, 6);
      note = `catalog matches for "${text}"`;
    }
    rank(list);
    const total = list.length;
    for (const p of list) delete p._rel;
    return { query: it.text, kind: kind || "any", note, total, stale, source: "jlcsearch — LCSC / JLCPCB catalog, prices in USD", results: list.slice(0, limit) };
  }

  /** what to search for to buy a part that is on the board (from its type + value) */
  function recommendFor(part) {
    const v = String(part.value || ""), t = String(part.type || "").toLowerCase();
    if (t === "resistor") return { kind: "resistor", value: v, pkg: "0603" };
    if (t === "capacitor") return { kind: "capacitor", value: v, pkg: "0603" };
    if (t === "led") return { kind: "led", q: v, pkg: "0603" };
    if (t === "ldo") return { kind: "regulator", volts: (part.elec && part.elec.vout) || 3.3, minCurrent: 0.3 };
    if (t === "mcu") return { kind: "mcu", vdd: 3.3 };
    if (t === "header") return { q: "pin header 2.54mm 1x6" };
    if (t === "usbc") return { q: "USB Type-C receptacle" };
    return { q: v || t };
  }
  /** the best sensible pick: in stock, JLCPCB-basic first, then cheapest */
  function pick(results) {
    return results.find((p) => p.inStock && p.stock >= 100) || results.find((p) => p.inStock) || null;
  }
  const api = { search, recommendFor, pick, parseValue, fmtOhms, fmtFarads, links, priceAt, intent, normalize, BASE };
  root.TraceFinder = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
