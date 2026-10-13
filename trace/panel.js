// TRACE left panel — Library | Objects | Rules.
//   Library : search bar over your parts library AND the live LCSC/JLCPCB catalog; click to add
//   Objects : the hierarchy of what is on the board (Root → components by block → nets → pins)
//   Rules   : net classes (wire width / clearance) for the PCB — see rules.js
// ui.js still fills #trparts / #trnets / #trlayers (kept so the old hooks keep working); this file owns the
// frame around them, the search and the tree. Exposes window.TracePanel.
(function () {
  "use strict";
  const { PARTS, defOf, elecOf } = window.TraceEngine;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const usd = (n) => (n == null ? "" : "$" + (n < 0.1 ? Math.round(n * 10000) / 10000 : (Math.round(n * 100) / 100).toFixed(2)));
  const P = { ctx: null, root: null, tab: "library", q: "", online: null, busy: false, err: "", timer: 0, open: { root: true, comps: true, nets: false, outline: true }, seq: 0 };

  function setTab(t) {
    P.tab = t;
    for (const b of P.root.querySelectorAll("[data-ltab]")) b.setAttribute("aria-selected", String(b.dataset.ltab === t));
    for (const k of ["library", "objects", "rules"]) P.root.querySelector("#trlp-" + k).hidden = k !== t;
    render();
  }

  // ---------- library ----------
  function localMatches() {
    const q = P.q.trim().toLowerCase();
    return Object.entries(PARTS).filter(([k, d]) => !d.missing && (!q || (k + " " + d.label + " " + (d.desc || "") + " " + (d.value || "")).toLowerCase().includes(q)));
  }
  function renderLibrary() {
    const box = P.root.querySelector("#trlibres"), q = P.q.trim();
    let h = "";
    if (q.length >= 2) {
      h += `<div class="tr-h">REAL PARTS · LCSC / JLCPCB</div>`;
      if (P.busy) h += '<div class="tr-lnote">Searching the catalog…</div>';
      else if (P.err) h += `<div class="tr-lerr">${esc(P.err)}</div>`;
      else if (P.online) {
        h += P.online.results.length ? P.online.results.slice(0, 8).map((p) =>
          `<div class="tr-lcard" data-real="${esc(p.id)}"><div class="t"><b>${esc(p.mpn)}</b><span class="pr">${usd(p.price)}</span></div><div class="s">${esc(p.pkg)} · ${p.stock > 0 ? (p.stock >= 1000 ? Math.round(p.stock / 1000) + "k" : p.stock) + " in stock" : "out of stock"}${p.basic ? " · basic" : ""}</div><div class="d">${esc(p.desc)}</div><div class="a"><button class="tr-btn gold" data-addreal="${esc(p.id)}">Add</button><a href="${esc(p.links.lcsc)}" target="_blank" rel="noopener">LCSC ↗</a><a href="${esc(p.links.datasheet)}" target="_blank" rel="noopener">Datasheet ↗</a></div></div>`).join("")
          : '<div class="tr-lnote">No real parts matched. Try a part number or fewer words.</div>';
      }
      h += '<div class="tr-h">YOUR LIBRARY</div>';
    }
    if (box._h !== h) { box.innerHTML = h; box._h = h; } // only touch the DOM when something changed — a re-render between mouse-down and mouse-up would eat the click
  }
  function search() {
    const q = P.q.trim();
    clearTimeout(P.timer);
    P.online = null; P.err = "";
    if (q.length < 2) { P.busy = false; renderLibrary(); return; }
    P.busy = true; renderLibrary();
    const my = ++P.seq;
    P.timer = setTimeout(async () => {
      try { const r = await window.TraceFinder.search({ q, limit: 8 }); if (my !== P.seq) return; P.online = r; P.err = ""; }
      catch (e) { if (my !== P.seq) return; P.err = e.message; }
      P.busy = false; renderLibrary();
    }, 380);
  }

  // ---------- objects tree ----------
  function problemLevel(ref) {
    const S = P.ctx.getSafe();
    let w = "";
    for (const it of S.issues) if (it.level !== "info" && it.refs && it.refs.includes(ref)) { if (it.level === "danger") return "danger"; w = "warning"; }
    for (const v of P.ctx.getDrc().errors) if (v.refs && v.refs.includes(ref)) return "danger";
    return w;
  }
  function renderTree() {
    const b = P.ctx.board, parts = b.s.parts, sel = P.ctx.getSel(), box = P.root.querySelector("#trtree");
    const row = (lvl, key, label, extra, o) => {
      o = o || {};
      const arrow = o.kids ? `<span class="ar">${P.open[key] ? "▾" : "▸"}</span>` : '<span class="ar"></span>';
      return `<div class="tr-trow${o.sel ? " sel" : ""}${o.lv ? " " + o.lv : ""}" style="padding-left:${6 + lvl * 14}px" ${o.kids ? `data-tt="${esc(key)}"` : ""} ${o.part ? `data-tpart="${esc(o.part)}"` : ""} ${o.net ? `data-tnet="${esc(o.net)}"` : ""} role="treeitem"${o.kids ? ` aria-expanded="${!!P.open[key]}"` : ""}>${arrow}<span class="lb">${label}</span><span class="ex">${extra || ""}</span></div>`;
    };
    let h = row(0, "root", "<b>Root</b>", "", { kids: true });
    if (P.open.root) {
      const blocks = new Map();
      for (const p of parts) { const k = p.block || ""; if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(p); }
      h += row(1, "comps", "Components", parts.length, { kids: true });
      if (P.open.comps) {
        for (const [blk, list] of blocks) {
          let lvl = 2;
          if (blk) { h += row(2, "blk:" + blk, esc(blk), list.length, { kids: true }); lvl = 3; if (P.open["blk:" + blk] === undefined) P.open["blk:" + blk] = true; if (!P.open["blk:" + blk]) continue; }
          for (const p of list) h += row(lvl, "p:" + p.ref, `<b>${esc(p.ref)}</b> ${esc(String(p.value).slice(0, 18))}`, p.buy ? "✓" : "", { part: p.ref, sel: sel && sel.kind === "part" && sel.id === p.ref, lv: problemLevel(p.ref) });
        }
      }
      const nets = b.nets();
      h += row(1, "nets", "Nets", nets.length, { kids: true });
      if (P.open.nets) for (const n of nets) {
        h += row(2, "n:" + n.name, esc(n.name), n.pads.length, { kids: true, net: n.name, sel: P.ctx.getHlNet() === n.name });
        if (P.open["n:" + n.name]) for (const pad of n.pads) h += row(3, "np:" + pad, esc(pad), "", { part: pad.split(".")[0] });
      }
      if (P.ctx.tab() === "board") {
        h += row(1, "outline", "Board outline", `${b.s.board.w}×${b.s.board.h}`, { kids: true });
        if (P.open.outline) {
          const cuts = b.s.cutouts || [];
          h += row(2, "cuts", "Cutouts &amp; holes", cuts.length, { kids: true });
          if (P.open.cuts) for (const c of cuts) h += row(3, "c:" + c.id, esc(c.id) + " " + esc(c.shape), c.shape === "circle" ? "⌀" + c.d : c.w + "×" + c.h, { cut: c.id });
        }
      }
    }
    if (box._h !== h) { box.innerHTML = h; box._h = h; }
  }

  function render() {
    if (!P.root) return;
    P.root.querySelector("#trltab-rules").hidden = P.ctx.tab() !== "board";
    if (P.tab === "rules" && P.ctx.tab() !== "board") { setTab("library"); return; }
    P.root.querySelector(".pcbonly").hidden = P.ctx.tab() !== "board";
    if (P.tab === "objects") renderTree();
    if (P.tab === "library") renderLibrary();
    if (P.tab === "rules" && window.TraceRules) window.TraceRules.render();
  }

  function init(ctx) {
    P.ctx = ctx; P.root = ctx.root;
    P.root.addEventListener("click", (e) => {
      const t = e.target;
      const tab = t.closest("[data-ltab]");
      if (tab) { setTab(tab.dataset.ltab); return; }
      const add = t.closest("[data-addreal]");
      if (add) { const p = P.online && P.online.results.find((x) => x.id === add.dataset.addreal); if (p) { ctx.addReal(p); } return; }
      const tt = t.closest("[data-tt]");
      if (tt && !t.closest("[data-tpart]")) { const k = tt.dataset.tt; P.open[k] = !P.open[k]; if (tt.dataset.tnet) ctx.hlNet(tt.dataset.tnet); renderTree(); return; }
      const tp = t.closest("[data-tpart]");
      if (tp) { ctx.selectPart(tp.dataset.tpart); return; }
      const cut = t.closest("[data-cut]");
      if (cut && window.TraceRules) { window.TraceRules.select(cut.dataset.cut); }
    });
    P.root.addEventListener("input", (e) => { if (e.target.id === "trlibq") { P.q = e.target.value; search(); ctx.filterLibrary(); } });
    P.root.addEventListener("keydown", (e) => { if (e.target.id === "trlibq") { e.stopPropagation(); if (e.key === "Escape") { e.target.value = ""; P.q = ""; search(); ctx.filterLibrary(); e.target.blur(); } } });
  }
  window.TracePanel = { init, render, setTab, matches: () => P.q.trim().toLowerCase(), get tab() { return P.tab; }, localMatches, _P: P };
})();
