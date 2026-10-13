// KiCad footprint (.kicad_mod) → TRACE part definition.
// Zero dependencies: a tiny S-expression reader plus pad / courtyard extraction.

export function parseSexpr(text) {
  const out = [[]];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "(") { const l = []; out[out.length - 1].push(l); out.push(l); i++; }
    else if (c === ")") { if (out.length > 1) out.pop(); i++; }
    else if (c === '"') {
      let j = i + 1, s = "";
      while (j < n && text[j] !== '"') { if (text[j] === "\\") j++; s += text[j]; j++; }
      out[out.length - 1].push(s); i = j + 1;
    } else if (/\s/.test(c)) i++;
    else {
      let j = i;
      while (j < n && !/[\s()]/.test(text[j])) j++;
      out[out.length - 1].push(text.slice(i, j)); i = j;
    }
  }
  return out[0][0] || [];
}

const sub = (node, key) => node.find((x) => Array.isArray(x) && x[0] === key);
const subs = (node, key) => node.filter((x) => Array.isArray(x) && x[0] === key);
const r3 = (v) => Math.round(v * 1000) / 1000;

function guessPrefix(name) {
  const n = name.toLowerCase();
  if (/^r[_-]|resistor/.test(n)) return "R";
  if (/^c[_-]|capacitor|^cp[_-]/.test(n)) return "C";
  if (/^led|^d[_-]|diode/.test(n)) return "D";
  if (/^l[_-]|inductor/.test(n)) return "L";
  if (/connector|pin(header|socket)|usb|jack|terminal|header/.test(n)) return "J";
  if (/crystal|osc/.test(n)) return "Y";
  if (/switch|button|^sw/.test(n)) return "SW";
  return "U";
}

/** @returns {{label:string,prefix:string,value:string,body:number[],pads:object[],source:string}} */
export function kicadToPart(text, source = "") {
  const root = parseSexpr(text);
  if (!Array.isArray(root) || (root[0] !== "footprint" && root[0] !== "module")) throw new Error("not a KiCad footprint");
  const name = String(root[1] || "footprint");
  const pads = [];
  for (const p of subs(root, "pad")) {
    const type = p[2], shape = p[3], at = sub(p, "at"), size = sub(p, "size");
    if (!at || !size) continue;
    let w = Number(size[1]), h = Number(size[2]);
    const rot = Number(at[3] || 0);
    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
    const thru = type === "thru_hole" || type === "np_thru_hole";
    const round = shape === "circle" || (shape === "oval" && Math.abs(w - h) < 1e-6);
    let n = String(p[1] || "");
    if (!n) n = "MH" + (pads.length + 1);
    if (!(w > 0) || !(h > 0) || !isFinite(Number(at[1])) || !isFinite(Number(at[2]))) continue;
    pads.push({ n, fn: n, x: r3(Number(at[1])), y: r3(Number(at[2])), w: r3(w), h: r3(h), shape: round ? "circle" : "rect", thru });
  }
  if (!pads.length) throw new Error("footprint has no pads");
  // body = courtyard extents (symmetrised around the origin)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (pt) => { if (!pt) return; const x = Number(pt[1]), y = Number(pt[2]); if (isFinite(x) && isFinite(y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } };
  for (const k of ["fp_line", "fp_rect", "fp_circle", "fp_poly"]) for (const e of subs(root, k)) {
    const layer = sub(e, "layer");
    if (!layer || layer[1] !== "F.CrtYd") continue;
    grow(sub(e, "start")); grow(sub(e, "end")); grow(sub(e, "center"));
    const pts = sub(e, "pts"); if (pts) for (const q of pts) if (Array.isArray(q) && q[0] === "xy") grow(q);
  }
  let body;
  if (isFinite(x0)) body = [r3(2 * Math.max(Math.abs(x0), Math.abs(x1))), r3(2 * Math.max(Math.abs(y0), Math.abs(y1)))];
  else {
    const w = Math.max(...pads.map((p) => Math.abs(p.x) + p.w / 2)) * 2, h = Math.max(...pads.map((p) => Math.abs(p.y) + p.h / 2)) * 2;
    body = [r3(w + 0.4), r3(h + 0.4)];
  }
  // KiCad footprints carry a human description + tags — surface them as the part's "what it is"
  const descr = sub(root, "descr"), tags = sub(root, "tags");
  const desc = [descr && descr[1], tags && tags[1] && "tags: " + tags[1]].filter(Boolean).join(" · ").slice(0, 300);
  return { label: name.replace(/_/g, " "), prefix: guessPrefix(name), value: name, body, pads, desc, source };
}
