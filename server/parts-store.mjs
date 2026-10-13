// TRACE parts library — one JSON file per part on disk (so parts are always there),
// plus online footprint search/import against the KiCad footprint library on GitHub.
// Mock mode (tests) uses a built-in fixture "online" library so nothing hits the network.
import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { kicadToPart } from "./kicad.mjs";

const PART_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const safeId = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 64);
const KICAD_REPO = "KiCad/kicad-footprints";
const norm = (s) => s.toLowerCase().replace(/[_\-.()/\\]+/g, " ");

const fixture = (name, pads, court) =>
  `(footprint "${name}" (layer "F.Cu") (descr "${name.startsWith("SOIC") ? "SOIC, 8 Pin (wide plastic package for ICs)" : name}") (tags "${name.startsWith("SOIC") ? "SOIC SO" : ""}") (fp_rect (start ${-court[0]} ${-court[1]}) (end ${court[0]} ${court[1]}) (layer "F.CrtYd"))\n${pads}\n)`;
const soic = (side, n0) => [0, 1, 2, 3].map((i) =>
  `(pad "${side < 0 ? i + 1 : 8 - i}" smd roundrect (at ${side * 2.475} ${(-1.905 + i * 1.27).toFixed(3)}) (size 1.95 0.6) (layers "F.Cu"))`).join("\n");
const MOCK_FOOTPRINTS = {
  "Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod":
    fixture("SOIC-8_3.9x4.9mm_P1.27mm", soic(-1) + "\n" + soic(1), [3.7, 2.9]),
  "Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod": fixture("R_0603_1608Metric",
    '(pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu"))\n(pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu"))', [1.48, 0.73]),
  "Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod": fixture("PinHeader_1x02_P2.54mm_Vertical",
    '(pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu"))\n(pad "2" thru_hole oval (at 0 2.54 90) (size 1.7 1.7) (drill 1) (layers "*.Cu"))', [1.8, 1.8]),
};

export function createPartsStore({ dir, mock }) {
  const file = (id) => join(dir, id + ".json");

  function list() {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch { /* skip corrupt file */ }
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  function validate(p) {
    if (!p || !PART_ID.test(String(p.id || ""))) return "bad part id (a-z 0-9 _ . -)";
    if (!Array.isArray(p.pads) || !p.pads.length || p.pads.length > 400) return "part needs 1–400 pads";
    for (const q of p.pads) for (const k of ["x", "y", "w", "h"]) if (!Number.isFinite(Number(q[k]))) return "pad " + q.n + ": bad " + k;
    if (!Array.isArray(p.body) || p.body.length !== 2) return "bad body";
    return "";
  }
  function save(p) {
    const bad = validate(p);
    if (bad) throw Object.assign(new Error(bad), { code: 400 });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(p.id), JSON.stringify(p, null, 2));
    return file(p.id);
  }
  function remove(id) {
    if (!PART_ID.test(id)) throw Object.assign(new Error("bad part id"), { code: 400 });
    try { unlinkSync(file(id)); } catch { throw Object.assign(new Error("no such part"), { code: 404 }); }
  }

  let treeCache = null;
  async function tree() {
    if (mock) return Object.keys(MOCK_FOOTPRINTS);
    if (treeCache) return treeCache;
    const cacheFile = join(dir, ".cache", "kicad-tree.json");
    let stale = null;
    try {
      stale = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (Date.now() - statSync(cacheFile).mtimeMs < 7 * 864e5) return (treeCache = stale);
    } catch { /* no cache yet */ }
    try {
      const r = await fetch(`https://api.github.com/repos/${KICAD_REPO}/git/trees/master?recursive=1`,
        { headers: { "user-agent": "orrery-trace", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("GitHub answered " + r.status);
      const j = await r.json();
      const paths = j.tree.filter((t) => t.type === "blob" && t.path.endsWith(".kicad_mod")).map((t) => t.path);
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(paths));
      return (treeCache = paths);
    } catch (e) {
      if (stale) return (treeCache = stale); // offline, but we have searched before
      throw new Error("online part search unavailable: " + e.message);
    }
  }
  async function search(q) {
    const toks = norm(String(q || "")).split(/\s+/).filter(Boolean);
    if (!toks.length) throw new Error("empty search");
    const hits = [];
    for (const path of await tree()) {
      const hay = norm(path);
      if (!toks.every((t) => hay.includes(t))) continue;
      const name = path.split("/").pop().replace(/\.kicad_mod$/, "");
      hits.push({ path, name, library: path.split("/")[0].replace(/\.pretty$/, ""), score: name.length - (norm(name).startsWith(toks[0]) ? 20 : 0) });
    }
    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, 40).map(({ path, name, library }) => ({ path, name, library }));
  }
  async function importFootprint(path) {
    if (!(await tree()).includes(path)) throw new Error("unknown footprint path — use a path from search_parts");
    let text;
    if (mock) text = MOCK_FOOTPRINTS[path];
    else {
      const r = await fetch(`https://raw.githubusercontent.com/${KICAD_REPO}/master/${path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: { "user-agent": "orrery-trace" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("download failed: " + r.status);
      text = await r.text();
    }
    const base = path.split("/").pop().replace(/\.kicad_mod$/, "");
    return { id: safeId(base), def: kicadToPart(text, "KiCad footprint library · " + path) };
  }
  return { list, save, remove, search, importFootprint, dir };
}
