// TRACE parts finder panel (inside the Graph tab): search real parts, see price / stock / where to
// buy, add them to the diagram, and the bill of materials. Needs trace/finder.js + trace/graph.js.
(function () {
  "use strict";
  const F = window.TraceFinder;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = (n) => (n == null ? "—" : n < 0.1 ? "$" + (Math.round(n * 10000) / 10000) : "$" + (Math.round(n * 100) / 100).toFixed(2));
  const num = (n) => (n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
  const eSeries = (r) => { let best = r, d = Infinity; for (let m = 0.1; m <= 1e7; m *= 10) for (const e of E24) { const v = e * m; if (v >= r * 0.999 && v - r < d) { d = v - r; best = v; } } return Math.round(best * 100) / 100; };

  const S = { open: false, tab: "find", q: "", kind: "", res: null, busy: false, error: "", forRef: null, boards: 1, progress: "" };
  let C = null, root = null;

  const exec = (cmd, args) => { try { return C.board.exec(cmd, args, "user"); } catch (e) { C.toast(e.message, true); return null; } };
  const parts = () => C.board.s.parts.filter((p) => !/^H/.test(p.ref) || p.buy);
  const unsourced = () => parts().filter((p) => !p.buy);

  // ---------- actions ----------
  async function search(opts) {
    S.busy = true; S.error = ""; S.res = null; draw();
    try { S.res = await F.search(opts); } catch (e) { S.error = e.message; }
    S.busy = false; draw();
  }
  function applySource(ref, p) {
    const r = exec("source", { ref, mpn: p.mpn, id: p.id, pkg: p.pkg, stock: p.stock, basic: p.basic ? 1 : 0, price: p.price == null ? undefined : p.price, tiers: p.tiers, desc: p.desc });
    if (r && p.hint && p.hint.elec && Object.keys(p.hint.elec).length) exec("set_electrical", Object.assign({ ref }, p.hint.elec));
    return r;
  }
  function addToGraph(p) {
    const h = p.hint;
    let type = h.type;
    if (h.create) {
      type = "found-" + p.id.toLowerCase();
      if (!exec("create_part", { id: type, template: h.create.template, pins: h.create.pins, label: h.create.label, prefix: h.create.prefix, value: h.create.value, desc: `${p.mpn} (${p.pkg}) — ${p.desc.slice(0, 80)}` })) return;
    }
    const ref = window.TraceGraph.addPart(type, h.value);
    if (!ref) return;
    applySource(ref, p);
    C.toast(`Added ${ref} · ${p.mpn} · ${usd(p.price)} each · ${num(p.stock)} in stock` + (h.note ? " · " + h.note : ""));
    draw();
  }
  function useFor(ref, p) {
    const part = C.board.findPart(ref);
    if (!part) return;
    if (p.hint && p.hint.type === part.type && p.hint.value && /^(resistor|capacitor)$/.test(part.type) && p.hint.value !== part.value) exec("set_value", { ref, value: p.hint.value });
    if (applySource(ref, p)) { C.toast(`${ref} is now ${p.mpn} · ${usd(p.price)} · ${num(p.stock)} in stock`); S.forRef = null; draw(); }
  }
  async function sourceAll() {
    const todo = unsourced();
    if (!todo.length) { C.toast("Every part is already sourced"); return; }
    let ok = 0; const failed = [];
    for (let i = 0; i < todo.length; i++) {
      const part = todo[i];
      S.progress = `Finding parts… ${i + 1} / ${todo.length} (${part.ref})`; draw();
      try {
        const q = F.recommendFor(part), res = await F.search(Object.assign({ limit: 20 }, q)), best = F.pick(res.results);
        if (best) { useForQuiet(part.ref, best); ok++; } else failed.push(part.ref);
      } catch (e) { S.error = e.message; failed.push(part.ref); break; }
    }
    S.progress = "";
    C.toast(`Sourced ${ok} of ${todo.length} parts` + (failed.length ? ` · no match for ${failed.join(", ")}` : "") + ` · total ${usd(exec("bom", { boards: 1 }).total)}`, !!failed.length && !ok);
    draw();
  }
  function useForQuiet(ref, p) {
    const part = C.board.findPart(ref);
    if (p.hint && part && p.hint.type === part.type && /^(resistor|capacitor)$/.test(part.type) && p.hint.value !== part.value) exec("set_value", { ref, value: p.hint.value });
    applySource(ref, p);
  }
  // an LED with no series resistor: compute it and splice one in
  function ledFixes() {
    const A = C.getSafe(), out = [];
    for (const it of A.issues) {
      if (it.code !== "led_overcurrent") continue;
      for (const ref of it.refs || []) {
        const p = C.board.findPart(ref);
        if (!p || !/led/i.test(p.type)) continue;
        // the voltage that will drive the LED: the chip's supply if a chip pin drives it, else the voltage on the pin (a sagging overloaded pin would read too low)
        const pad = A.pads[ref + ".A"], link = (C.board.s.links || []).find((l) => l.a === ref + ".A" || l.b === ref + ".A"), other = link ? (link.a === ref + ".A" ? link.b : link.a).split(".")[0] : "", orep = A.parts[other];
        const v = orep && orep.kind === "ic" && orep.v > 0.5 ? orep.v : pad && pad.v > 0.5 ? pad.v : 5, vf = (p.elec && p.elec.vf) || ({ red: 2, green: 2.1, yellow: 2.1, blue: 3, white: 3.1 }[String(p.value).toLowerCase()] || 2.1);
        const r = eSeries(Math.max(47, (v - vf) / 0.008));
        out.push({ ref, pad: ref + ".A", value: F.fmtOhms(r), ma: Math.round(((v - vf) / r) * 1000 * 10) / 10 });
      }
    }
    return out;
  }
  async function addSeries(fix) {
    S.busy = true; draw();
    const r = exec("insert_series", { pad: fix.pad, type: "resistor", value: fix.value });
    if (r) {
      try { const res = await F.search({ kind: "resistor", value: fix.value, pkg: "0603", limit: 20 }), best = F.pick(res.results); if (best) { applySource(r.ref, best); } } catch (_) { /* resistor added, just not sourced */ }
      C.toast(`Added ${r.ref} (${fix.value}) in series with ${fix.pad} — about ${fix.ma} mA through the LED`);
    }
    S.busy = false; draw();
  }

  // ---------- BOM ----------
  function csv(rows) {
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    return ["Comment,Designator,Footprint,LCSC Part #,Quantity,Unit price (USD),Line total (USD),Link"].concat(rows.map((r) => [q(r.mpn || r.value), q(r.refs), q(r.pkg), q(r.lcsc), r.qty, r.unit_price == null ? "" : r.unit_price, r.line_total == null ? "" : r.line_total, q(r.url)].join(","))).join("\r\n") + "\r\n";
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- drawing ----------
  function card(p) {
    const forRef = S.forRef;
    return `<div class="tr-fc" data-part="${esc(p.id)}"><div class="r1"><b>${esc(p.mpn)}</b><span class="pr">${usd(p.price)}<i> each</i></span></div>` +
      `<div class="r2"><span>${esc(p.pkg)}</span><span class="${p.stock >= 100 ? "ok" : p.stock > 0 ? "low" : "out"}">${p.stock > 0 ? num(p.stock) + " in stock" : "out of stock"}</span>${p.basic ? '<span class="bs" title="JLCPCB basic part — no extra assembly fee">basic</span>' : ""}</div>` +
      `<div class="ds">${esc(p.desc)}</div>` +
      (p.tiers.length > 1 ? `<div class="tiers">${p.tiers.slice(0, 4).map((t) => `${t.min}+ ${usd(t.price)}`).join(" · ")}</div>` : "") +
      (p.hint.note ? `<div class="warn">${esc(p.hint.note)}</div>` : p.hint.generic_footprint ? '<div class="warn">uses the generic MCU footprint — check the datasheet pinout</div>' : "") +
      `<div class="act"><button class="tr-btn gold" data-add="${esc(p.id)}">Add to graph</button>${forRef ? `<button class="tr-btn" data-use="${esc(p.id)}">Use for ${esc(forRef)}</button>` : ""}</div>` +
      `<div class="lk"><a href="${esc(p.links.lcsc)}" target="_blank" rel="noopener">LCSC</a><a href="${esc(p.links.jlcpcb)}" target="_blank" rel="noopener">JLCPCB</a><a href="${esc(p.links.digikey)}" target="_blank" rel="noopener">DigiKey</a><a href="${esc(p.links.mouser)}" target="_blank" rel="noopener">Mouser</a><a href="${esc(p.links.datasheet)}" target="_blank" rel="noopener">Datasheet</a></div></div>`;
  }
  function drawFind() {
    const need = unsourced(), fixes = ledFixes();
    let h = `<div class="tr-fs"><input id="trfq" value="${esc(S.q)}" placeholder="330R · 100nF · green LED · 3.3V LDO · ESP32-C3" aria-label="Search real parts" spellcheck="false" autocomplete="off">` +
      `<select id="trfk" aria-label="Part kind">${[["", "Any"], ["resistor", "Resistor"], ["capacitor", "Capacitor"], ["led", "LED"], ["regulator", "Regulator"], ["mcu", "MCU"], ["header", "Header"]].map(([v, l]) => `<option value="${v}"${S.kind === v ? " selected" : ""}>${l}</option>`).join("")}</select>` +
      `<button class="tr-btn gold" id="trfgo"${S.busy ? " disabled" : ""}>Search</button></div>`;
    if (S.forRef) h += `<div class="tr-fnote">Choosing a part for <b>${esc(S.forRef)}</b> <button class="tr-x" data-clearfor="1" aria-label="Stop choosing for ${esc(S.forRef)}">×</button></div>`;
    if (fixes.length) h += `<div class="tr-fh">SUGGESTED FIXES</div>` + fixes.map((f) => `<div class="tr-frow fix"><span>${esc(f.ref)} has no current-limiting resistor</span><button class="tr-btn" data-series="${esc(f.pad)}|${esc(f.value)}|${f.ma}">Add ${esc(f.value)} resistor</button></div>`).join("");
    if (need.length) h += `<div class="tr-fh">NOT SOURCED YET · ${need.length}</div>` + need.map((p) => `<div class="tr-frow"><span><b>${esc(p.ref)}</b> ${esc(p.value)}</span><button class="tr-btn" data-findfor="${esc(p.ref)}">Find</button></div>`).join("") +
      `<button class="tr-btn ai" id="trfall"${S.busy || S.progress ? " disabled" : ""}>✦ Pick best for all ${need.length}</button>`;
    else if (parts().length) h += `<div class="tr-fok">✓ Every part is sourced · <a href="#" data-tab="bom">see the BOM</a></div>`;
    if (S.progress) h += `<div class="tr-fnote">${esc(S.progress)}</div>`;
    if (S.busy && !S.progress) h += `<div class="tr-fnote">Searching the LCSC / JLCPCB catalog…</div>`;
    if (S.error) h += `<div class="tr-ferr">${esc(S.error)}</div>`;
    if (S.res) {
      h += `<div class="tr-fh">${esc(S.res.note).toUpperCase()} · ${S.res.total} found${S.res.stale ? " · offline copy" : ""}</div>`;
      h += S.res.results.length ? S.res.results.map(card).join("") : '<div class="tr-fnote">Nothing matched. Try fewer words, a package like 0603, or a part number.</div>';
      h += `<div class="tr-fnote small">Prices in USD from the open LCSC / JLCPCB catalog. Check stock and datasheets before ordering.</div>`;
    } else if (!S.busy && !S.error) h += `<div class="tr-fnote">Search for any real part. Prices, stock and buy links come straight from the catalog — no account needed.</div>`;
    return h;
  }
  function drawBom() {
    const b = exec("bom", { boards: S.boards });
    if (!b) return "";
    let h = `<div class="tr-fs"><label for="trfb" class="lab">Boards</label><input id="trfb" type="number" min="1" step="1" value="${S.boards}" style="width:70px" aria-label="Number of boards"><span class="sp"></span><button class="tr-btn" id="trfcsv"${b.rows.length ? "" : " disabled"}>Export CSV</button></div>`;
    if (!b.rows.length) return h + '<div class="tr-fnote">No parts yet. Add parts in the graph or from the Find tab.</div>';
    h += `<div class="tr-bom">` + b.rows.map((r) => `<div class="tr-brow${r.sourced ? "" : " miss"}" data-bomrow="${esc(r.refs)}"><div class="a"><b>${esc(r.refs)}</b><span>×${r.qty}</span></div><div class="b">${esc(r.mpn || r.value + " · " + r.part)}${r.pkg ? " · " + esc(r.pkg) : ""}</div>` +
      `<div class="c">${r.sourced ? `<span>${usd(r.unit_price)} ea</span><b>${usd(r.line_total)}</b>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">buy ↗</a>` : ""}` : `<button class="tr-btn" data-findfor="${esc(r.refs.split(",")[0])}">Find</button>`}</div></div>`).join("") + `</div>`;
    h += `<div class="tr-btot"><span>Total for ${b.boards} board${b.boards > 1 ? "s" : ""}</span><b data-total="${b.total}">${usd(b.total)}</b></div><div class="tr-fnote small">${esc(b.note)}${b.unsourced.length ? "" : " · unit prices use the quantity price breaks"}. Parts only — no board, assembly or shipping.</div>`;
    if (b.unsourced.length) h += `<button class="tr-btn ai" id="trfall"${S.progress ? " disabled" : ""}>✦ Pick best for all ${b.unsourced.length} unsourced</button>`;
    if (S.progress) h += `<div class="tr-fnote">${esc(S.progress)}</div>`;
    return h;
  }
  function draw() {
    if (!root) return;
    const keep = root.querySelector(".tr-fbody");
    const top = keep ? keep.scrollTop : 0, focus = document.activeElement && document.activeElement.id;
    root.hidden = !S.open;
    root.parentNode.parentNode.classList.toggle("finder-open", S.open);
    if (!S.open) return;
    root.innerHTML = `<div class="tr-fhead"><button data-tab="find" aria-pressed="${S.tab === "find"}">Find parts</button><button data-tab="bom" aria-pressed="${S.tab === "bom"}">BOM</button><span class="sp"></span><button class="tr-x" data-close="1" aria-label="Close parts panel">×</button></div>` +
      `<div class="tr-fbody">${S.tab === "find" ? drawFind() : drawBom()}</div>`;
    const nb = root.querySelector(".tr-fbody"); nb.scrollTop = top;
    if (focus && root.querySelector("#" + focus)) { const e = root.querySelector("#" + focus); e.focus(); if (e.setSelectionRange && e.value) try { e.setSelectionRange(e.value.length, e.value.length); } catch (_) { /* number input */ } }
  }

  function runSearch() {
    const q = (root.querySelector("#trfq").value || "").trim(), kind = root.querySelector("#trfk").value;
    S.q = q; S.kind = kind;
    if (!q && !kind) { S.error = "Type what you are looking for, e.g. 100nF, green LED, 3.3V LDO or AMS1117."; draw(); return; }
    search({ q, kind: kind || undefined, limit: 12 });
  }
  function onClick(e) {
    const t = e.target, btn = t.closest("button,a[data-tab]");
    if (!btn) return;
    if (btn.dataset.tab) { e.preventDefault(); S.tab = btn.dataset.tab; draw(); return; }
    if (btn.dataset.close) { S.open = false; draw(); return; }
    if (btn.id === "trfgo") { runSearch(); return; }
    if (btn.id === "trfall") { sourceAll(); return; }
    if (btn.id === "trfcsv") { const b = exec("bom", { boards: S.boards }); if (b) download("trace-bom.csv", csv(b.rows)); return; }
    if (btn.dataset.clearfor) { S.forRef = null; draw(); return; }
    if (btn.dataset.add) { const p = S.res && S.res.results.find((x) => x.id === btn.dataset.add); if (p) addToGraph(p); return; }
    if (btn.dataset.use) { const p = S.res && S.res.results.find((x) => x.id === btn.dataset.use); if (p && S.forRef) useFor(S.forRef, p); return; }
    if (btn.dataset.series) { const [pad, value, ma] = btn.dataset.series.split("|"); addSeries({ pad, value, ma }); return; }
    if (btn.dataset.findfor) {
      const part = C.board.findPart(btn.dataset.findfor);
      if (!part) return;
      S.tab = "find"; S.forRef = part.ref;
      const rq = F.recommendFor(part);
      S.q = rq.q || part.value || ""; S.kind = rq.kind || "";
      search(Object.assign({ limit: 12 }, rq));
    }
  }

  function init(ctx) {
    C = ctx; root = ctx.root;
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "trfq") runSearch(); if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) e.stopPropagation(); });
    root.addEventListener("keyup", (e) => e.stopPropagation());
    root.addEventListener("change", (e) => {
      if (e.target.id === "trfb") { S.boards = Math.max(1, Math.floor(Number(e.target.value) || 1)); draw(); }
      if (e.target.id === "trfk") S.kind = e.target.value;
    });
  }
  function toggle(tab) {
    if (S.open && (!tab || S.tab === tab)) S.open = false;
    else { S.open = true; if (tab) S.tab = tab; }
    draw();
    const f = root.querySelector("#trfq"); if (f && S.open && S.tab === "find") f.focus();
  }
  function findFor(ref) {
    const part = C.board.findPart(ref);
    if (!part) return;
    S.open = true; S.tab = "find"; S.forRef = part.ref;
    const rq = F.recommendFor(part);
    S.q = rq.q || part.value || ""; S.kind = rq.kind || "";
    draw(); search(Object.assign({ limit: 12 }, rq));
  }
  window.TraceFinderUI = { init, toggle, draw, findFor, pickAll: () => sourceAll(), add: (p) => addToGraph(p), refresh: () => { if (S.open) draw(); }, get open() { return S.open; }, _S: S };
})();
