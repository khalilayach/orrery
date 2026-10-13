#!/usr/bin/env node
// trace-cli — how Claude (running as the TRACE dock agent) edits the live board.
//   node server/trace-cli.mjs <command> [key=value ...]
//   node server/trace-cli.mjs help | board | place type=resistor x=20 y=10 | route from=J1.D+ to=U1.1
//   node server/trace-cli.mjs search_parts q=soic-8 | import_part path=<from search>
//   node server/trace-cli.mjs find_parts q="330R 0603" | add_part q="green LED" pick=1   (real parts: price, stock, buy links)
// Talks to the local agent server, which relays board commands to the open TRACE page.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => { try { return readFileSync(resolve(ROOT, ".gstack", f), "utf8").trim(); } catch { return ""; } };
const port = process.env.TRACE_PORT || read("terminal-port") || "57253";
const token = process.env.TRACE_TOKEN || read("terminal-internal-token");
const BASE = `http://127.0.0.1:${port}`;
const [cmd, ...args] = process.argv.slice(2);
const kv = Object.fromEntries(args.map((a) => { const i = a.indexOf("="); return i < 1 ? [a, ""] : [a.slice(0, i).toLowerCase(), a.slice(i + 1)]; }));

// trace/finder.js is a browser/node dual script — evaluate it here so the CLI and the page share one implementation
function loadFinder() {
  const m = { exports: {} }, ctx = { fetch, AbortController, setTimeout, clearTimeout, module: m, console };
  ctx.globalThis = ctx;
  if (process.env.TRACE_FINDER_BASE) ctx.TRACE_FINDER_BASE = process.env.TRACE_FINDER_BASE;
  vm.runInNewContext(readFileSync(resolve(ROOT, "trace", "finder.js"), "utf8"), ctx);
  return m.exports;
}
const fail = (m) => { console.error("error: " + m); process.exit(1); };
async function post(cmdName, cmdArgs) {
  const r = await fetch(`${BASE}/trace/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, cmd: cmdName, args: cmdArgs }) });
  const j = await r.json();
  if (!j.ok) fail(j.error || r.status);
  return j.result;
}

if (!cmd) { console.error("usage: node server/trace-cli.mjs <command> [key=value ...]   (try: help)"); process.exit(2); }
try {
  let out;
  if (cmd === "search_parts") {
    if (!kv.q) fail("search_parts needs q=<text>, e.g. q=soic-8");
    const r = await fetch(`${BASE}/parts/search?q=${encodeURIComponent(kv.q)}`);
    const j = await r.json();
    if (!r.ok) fail(j.error);
    out = j.length ? j : { results: [], note: "nothing found — try a shorter / package-style query (soic-8, qfn-32, usb_c, 0603)" };
  } else if (cmd === "find_parts" || cmd === "add_part") {
    // real, buyable parts (LCSC/JLCPCB catalog, no API key): price, stock, buy links
    const F = loadFinder();
    if (!kv.q && !kv.kind) fail(`${cmd} needs q=<what you need>, e.g. q="330R 0603", q="green LED", q="3.3V LDO", q=ESP32-C3`);
    const res = await F.search({ q: kv.q, kind: kv.kind, value: kv.value, pkg: kv.pkg, volts: kv.volts, limit: Number(kv.limit) || 8 });
    const brief = (p, i) => ({ pick: i + 1, id: p.id, mpn: p.mpn, package: p.pkg, usd_each: p.price, in_stock: p.stock, jlcpcb_basic: p.basic, buy: p.links.lcsc, also: { digikey: p.links.digikey, mouser: p.links.mouser, datasheet: p.links.datasheet }, adds_to_board_as: p.hint.type || "new footprint: " + p.hint.create.template + (p.hint.note ? " (" + p.hint.note + ")" : "") });
    if (cmd === "find_parts") out = { searched: res.note, found: res.total, source: res.source, results: res.results.map(brief), next: "add_part q=\"<same query>\" pick=<n> [x= y=] places it on the board with its real price + ratings" };
    else {
      if (!res.results.length) fail("nothing found for that search — try different words");
      const chosen = kv.pick ? res.results[Number(kv.pick) - 1] : F.pick(res.results) || res.results[0];
      if (!chosen) fail("pick=" + kv.pick + " is out of range (1.." + res.results.length + ")");
      const h = chosen.hint;
      let type = h.type;
      if (h.create) {
        type = "found-" + chosen.id.toLowerCase();
        await post("create_part", ["id=" + type, "template=" + h.create.template, ...(h.create.pins ? ["pins=" + h.create.pins] : []), "label=" + h.create.label, "prefix=" + h.create.prefix, "value=" + h.create.value, "desc=" + chosen.mpn + " (" + chosen.pkg + ") — " + chosen.desc.slice(0, 80)]);
      }
      let x = Number(kv.x), y = Number(kv.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const b = await post("board", []);
        const free = (px, py) => !b.parts.some((q) => Math.hypot(q.x - px, q.y - py) < 9);
        x = b.board.w / 2; y = b.board.h / 2;
        search: for (let yy = 10; yy <= b.board.h - 8; yy += 10) for (let xx = 10; xx <= b.board.w - 8; xx += 12) if (free(xx, yy)) { x = xx; y = yy; break search; }
      }
      const placed = await post("place", ["type=" + type, "x=" + x, "y=" + y, "value=" + h.value]);
      const e = Object.entries(h.elec || {});
      if (e.length) await post("set_electrical", ["ref=" + placed.ref, ...e.map(([k, v]) => k + "=" + v)]);
      const src = await post("source", ["ref=" + placed.ref, "mpn=" + chosen.mpn, "id=" + chosen.id, "pkg=" + chosen.pkg, "stock=" + chosen.stock, "basic=" + (chosen.basic ? 1 : 0), ...(chosen.price !== null ? ["price=" + chosen.price] : []), "tiers=" + chosen.tiers.map((t) => t.min + "-:" + t.price).join(","), "desc=" + chosen.desc.slice(0, 120)]);
      out = { placed: placed.ref, as: chosen.mpn, package: chosen.pkg, usd_each: chosen.price, in_stock: chosen.stock, buy: chosen.links.lcsc, ratings_set: h.elec || {}, note: h.note || (h.generic_footprint ? "uses the generic MCU footprint — check the datasheet pinout" : ""), sourced: src };
    }
  } else if (cmd === "import_part") {
    if (!kv.path) fail("import_part needs path=<path from search_parts>");
    const r = await fetch(`${BASE}/parts/import?path=${encodeURIComponent(kv.path)}`);
    const j = await r.json();
    if (!r.ok) fail(j.error);
    out = await post("create_part", { def: j.def, id: kv.id || j.id });
  } else if (cmd === "build") {
    // the whole design in one validated, all-or-nothing call: build file=design.json  (or: build - < design.json)
    let text = "";
    if (kv.file) { try { text = readFileSync(resolve(process.cwd(), kv.file), "utf8"); } catch (e) { fail("cannot read " + kv.file + ": " + e.message); } }
    else if (args.includes("-")) { for await (const chunk of process.stdin) text += chunk; }
    else if (kv.json) text = kv.json;
    else fail("build needs file=<design.json> (or - to read JSON from stdin). Run help for the spec format.");
    let spec; try { spec = JSON.parse(text); } catch (e) { fail("the design is not valid JSON: " + e.message); }
    if (kv.dry) spec.dry = true;
    out = await post("build", { spec });
  } else out = await post(cmd, args);
  if (cmd === "circuit" && out && out.text) { console.log(out.text); process.exit(0); }
  if (cmd === "build" && out && out.summary) { const { summary, ...rest } = out; console.log(summary + "\n" + JSON.stringify(rest)); process.exit(0); }
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  fail("cannot reach the agent server on port " + port + " — is `npm run agents` running? (" + e.message + ")");
}
