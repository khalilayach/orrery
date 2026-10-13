// TRACE cart — everything you need to buy for the board, in one place.
//   • a cart button (top right) with the live total
//   • the cart view: every part with quantity, price at your order size, stock and a buy link
//   • a single-vendor check: can the whole board be bought from ONE place (LCSC / JLCPCB) so it ships once?
// Prices come from the parts you sourced (LCSC/JLCPCB catalog, USD). Shipping and tax are not included.
// Exposes window.TraceCart.
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = (n) => (n == null ? "—" : n < 0.1 ? "$" + (Math.round(n * 10000) / 10000) : "$" + (Math.round(n * 100) / 100).toFixed(2));
  const K = { ctx: null, btn: null, modal: null, open: false, boards: 1 };

  /** can this part be bought from LCSC? (its catalog id looks like C12345) */
  const onLcsc = (p) => !!(p.buy && /^C\d+$/.test(String(p.buy.id || "")));
  function report() {
    const b = K.ctx.board, boards = K.boards, bom = b.exec("bom", { boards });
    const parts = b.s.parts.filter((p) => !/^H/.test(p.ref) || p.buy);
    const sourced = parts.filter((p) => p.buy), unsourced = parts.filter((p) => !p.buy);
    const lcsc = sourced.filter(onLcsc), other = sourced.filter((p) => !onLcsc(p));
    const rows = bom.rows.map((r) => {
      const first = b.findPart(r.refs.split(",")[0]), buy = first && first.buy, need = r.qty * boards;
      return Object.assign({}, r, { need, basic: !!(buy && buy.basic), low: r.stock != null && r.stock < need, lcscOk: !!(buy && onLcsc(first)) });
    });
    const unique = rows.filter((r) => r.sourced).length;
    const extended = rows.filter((r) => r.sourced && r.lcscOk && !r.basic).length;
    return { boards, bom, rows, parts, sourced, unsourced, lcsc, other, unique, extended, pieces: rows.filter((r) => r.sourced).reduce((s, r) => s + r.need, 0), oneVendor: sourced.length > 0 && other.length === 0 && unsourced.length === 0, total: bom.total };
  }

  function updateButton() {
    if (!K.btn) return;
    const r = report();
    K.btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 11.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.2L21 7H6"/></svg><span class="tot">${r.sourced.length ? usd(r.total) : "Cart"}</span>${r.parts.length ? `<span class="cnt${r.unsourced.length ? " warn" : ""}" title="${r.unsourced.length ? r.unsourced.length + " parts still need a real part" : r.parts.length + " parts"}">${r.unsourced.length ? "!" : r.parts.length}</span>` : ""}`;
    K.btn.setAttribute("aria-label", `Cart: ${r.sourced.length ? usd(r.total) : "empty"}, ${r.parts.length} parts`);
    K.btn.dataset.cartbtn = String(r.total);
  }

  function draw() {
    if (!K.open) return;
    const r = report(), m = K.modal;
    const vendor = !r.parts.length ? "" :
      r.oneVendor ? `<div class="vend ok"><b>✓ One vendor: LCSC</b><span>All ${r.sourced.length} parts are in the LCSC catalog — one order, one shipment. They are also JLCPCB parts, so you can have the board built and the parts supplied in a single JLCPCB order.</span></div>`
      : r.unsourced.length ? `<div class="vend warn"><b>${r.unsourced.length} part${r.unsourced.length > 1 ? "s" : ""} still without a real part</b><span>${esc(r.unsourced.map((p) => p.ref).join(", "))} — pick them first so the vendor check is complete.</span></div>`
      : `<div class="vend warn"><b>Not everything is on LCSC</b><span>${esc(r.other.map((p) => p.ref + " (" + p.buy.mpn + ")").join(", "))} would need a second vendor and a second shipment. Pick an LCSC equivalent in Find parts to keep it to one order.</span></div>`;
    const missing = r.unsourced.length ? `<div class="miss"><div class="tr-h">NEEDS A REAL PART · ${r.unsourced.length}</div>${r.unsourced.map((p) => `<div class="mrow"><span><b>${esc(p.ref)}</b> ${esc(String(p.value))}</span><button class="tr-btn" data-cartfind="${esc(p.ref)}">Find</button></div>`).join("")}<button class="tr-btn ai" data-cartall="1">✦ Pick best for all ${r.unsourced.length}</button></div>` : "";
    const table = r.rows.filter((x) => x.sourced).length ? `<table class="ctab"><thead><tr><th>Part</th><th>Designators</th><th class="n">Qty</th><th class="n">Each</th><th class="n">Line</th><th>Stock</th><th></th></tr></thead><tbody>` +
      r.rows.filter((x) => x.sourced).map((x) => `<tr class="${x.low ? "low" : ""}"><td><b>${esc(x.mpn)}</b><i>${esc(x.pkg)}${x.basic ? " · basic" : ""} · ${esc(x.lcsc)}</i></td><td>${esc(x.refs)}</td><td class="n">${x.need}</td><td class="n">${usd(x.unit_price)}</td><td class="n"><b>${usd(x.line_total)}</b></td>` +
        `<td>${x.stock == null ? "—" : x.low ? `<span class="bad">only ${x.stock}</span>` : `<span class="good">${x.stock >= 1000 ? Math.round(x.stock / 1000) + "k" : x.stock}</span>`}</td><td>${x.url ? `<a class="tr-btn" href="${esc(x.url)}" target="_blank" rel="noopener">Buy ↗</a>` : ""}</td></tr>`).join("") + "</tbody></table>" : '<div class="empty">Nothing to buy yet — add parts, then pick real ones in <b>Find parts</b>.</div>';
    const ext = r.extended ? `<div class="note">${r.extended} unique part${r.extended > 1 ? "s are" : " is"} not a JLCPCB “basic” part. If you have the board assembled there, extended parts usually carry a small per-part setup fee.</div>` : "";
    const hadFocus = document.activeElement && document.activeElement.id === "trcartn";
    m.innerHTML = `<div class="tr-cartbox" role="document"><div class="tr-modalhead"><b>Cart</b><span class="st">${r.sourced.length} of ${r.parts.length} parts sourced</span><span class="sp"></span>` +
      `<label class="lab" for="trcartn">Boards</label><input id="trcartn" type="number" min="1" step="1" value="${r.boards}" aria-label="How many boards"><button class="tr-x" data-cartclose="1" aria-label="Close cart">×</button></div>` +
      `<div class="tr-cartbody"><div class="sum"><div><span>Total for ${r.boards} board${r.boards > 1 ? "s" : ""}</span><b data-carttotal="${r.total}">${usd(r.total)}</b></div><div><span>Unique parts</span><b>${r.unique}</b></div><div><span>Pieces</span><b>${r.pieces}</b></div></div>` +
      vendor + missing + table + ext +
      `<div class="acts"><button class="tr-btn" data-cartcopy="1"${r.sourced.length ? "" : " disabled"}>Copy LCSC list</button><button class="tr-btn" data-cartcsv="1"${r.sourced.length ? "" : " disabled"}>Download BOM (CSV)</button><button class="tr-btn gold" data-cartopen="1"${r.lcsc.length ? "" : " disabled"}>Open all on LCSC</button></div>` +
      `<div class="note small">Prices are USD from the LCSC / JLCPCB catalog when you chose each part, using the quantity price break for your order size. Shipping, duties and tax are added at checkout. Check stock and datasheets before ordering.</div></div></div>`;
    if (hadFocus) { const i = m.querySelector("#trcartn"); i.focus(); i.setSelectionRange && 0; }
  }

  function csv(r) {
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    return ["LCSC Part Number,Quantity,Comment,Designator,Footprint,Unit price (USD),Line total (USD)"].concat(r.rows.filter((x) => x.sourced).map((x) => [q(x.lcsc), x.need, q(x.mpn), q(x.refs), q(x.pkg), x.unit_price, x.line_total].join(","))).join("\r\n") + "\r\n";
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function setOpen(v) {
    K.open = v; K.modal.hidden = !v;
    if (v) draw();
    K.btn.setAttribute("aria-expanded", String(v));
  }
  function init(ctx) {
    K.ctx = ctx; K.btn = ctx.button; K.modal = ctx.modal;
    try { const n = Number(localStorage.getItem("trace-boards-v1")); if (n >= 1) K.boards = Math.floor(n); } catch (_) { /* private mode */ }
    K.btn.addEventListener("click", () => setOpen(!K.open));
    K.modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t === K.modal || t.closest("[data-cartclose]")) { setOpen(false); return; }
      const f = t.closest("[data-cartfind]");
      if (f) { setOpen(false); ctx.find(f.dataset.cartfind); return; }
      if (t.closest("[data-cartall]")) { setOpen(false); ctx.pickAll(); return; }
      if (t.closest("[data-cartcsv]")) { download("trace-cart.csv", csv(report())); return; }
      if (t.closest("[data-cartcopy]")) {
        const r = report(), text = r.rows.filter((x) => x.sourced).map((x) => x.lcsc + "\t" + x.need).join("\n");
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => ctx.toast("Copied " + r.rows.filter((x) => x.sourced).length + " LCSC part numbers with quantities"), () => ctx.toast("Could not copy — use Download BOM instead"));
        return;
      }
      if (t.closest("[data-cartopen]")) { for (const x of report().rows.filter((y) => y.sourced && y.lcscOk && y.url)) window.open(x.url, "_blank", "noopener"); }
    });
    K.modal.addEventListener("change", (e) => {
      if (e.target.id === "trcartn") { K.boards = Math.max(1, Math.floor(Number(e.target.value) || 1)); try { localStorage.setItem("trace-boards-v1", String(K.boards)); } catch (_) { /* ignore */ } draw(); updateButton(); }
    });
    K.modal.addEventListener("keydown", (e) => { if (e.key === "Escape") { setOpen(false); } e.stopPropagation(); });
    updateButton();
  }
  window.TraceCart = { init, update: () => { updateButton(); if (K.open) { const a = document.activeElement; if (!(a && a.id === "trcartn")) draw(); } }, open: () => setOpen(true), close: () => setOpen(false), report, get isOpen() { return K.open; } };
})();
