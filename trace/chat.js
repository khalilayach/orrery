// TRACE Copilot chat — the AI as a conversation, not a console.
//   • messages with markdown, tables and ```diagram blocks (block diagrams drawn as SVG)
//   • OPTIONS: a | b | c  → clickable suggestions;  Plan mode → "Approve & build"
//   • consecutive tool/result lines collapse into one "Worked · N steps" group
//   • the workflow stepper: Architecture → Schematic → Research → Layout → Review (derived from the board)
// ui.js owns the network; this file owns what the conversation looks like. Exposes window.TraceChat.
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const C = { log: null, ctx: null, group: null, last: null, mode: "plan", diagramText: "" };

  // ---------- markdown (the small subset the assistant uses) ----------
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function renderTable(rows) {
    const cells = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const head = cells(rows[0]), body = rows.slice(2).map(cells);
    return `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
      body.map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] || "")}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>";
  }
  function md(text) {
    const lines = String(text).replace(/\r/g, "").split("\n"), out = [];
    let i = 0, list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    while (i < lines.length) {
      const ln = lines[i];
      const fence = ln.match(/^```\s*(\w+)?/);
      if (fence) {
        closeList();
        const lang = (fence[1] || "").toLowerCase(), buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(lang === "diagram" ? diagramBlock(buf.join("\n")) : `<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        closeList();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        out.push(renderTable(rows));
        continue;
      }
      const h = ln.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const t = h[2].trim(), key = t.toLowerCase().replace(/[^a-z ]/g, "").trim(); out.push(`<h4 class="sec" data-sec="${esc(key)}">${inline(t)}</h4>`); i++; continue; }
      const ul = ln.match(/^\s*[-*•]\s+(.*)$/), ol = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const kind = ul ? "ul" : "ol";
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`); i++; continue;
      }
      if (!ln.trim()) { closeList(); i++; continue; }
      closeList();
      const para = [ln]; i++;
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    closeList();
    return out.join("");
  }

  // ---------- block diagrams: "A -> B -> C" lines → boxes and arrows ----------
  function parseDiagram(text) {
    const nodes = [], idx = new Map(), edges = [];
    const node = (name) => { name = name.trim(); if (!name) return -1; if (!idx.has(name)) { idx.set(name, nodes.length); nodes.push(name); } return idx.get(name); };
    for (const raw of String(text).split("\n")) {
      const line = raw.replace(/^[\s\-*•]+/, "").trim();
      if (!line) continue;
      const parts = line.split(/\s*(?:->|→|-->)\s*/);
      if (parts.length === 1) { node(parts[0]); continue; }
      for (let k = 1; k < parts.length; k++) { const a = node(parts[k - 1]), b = node(parts[k]); if (a >= 0 && b >= 0 && a !== b && !edges.some((e) => e[0] === a && e[1] === b)) edges.push([a, b]); }
    }
    return { nodes, edges };
  }
  function layoutDiagram(d) {
    const n = d.nodes.length, rank = new Array(n).fill(0);
    for (let pass = 0; pass < n; pass++) { let ch = false; for (const [a, b] of d.edges) if (rank[b] < rank[a] + 1 && rank[a] + 1 < n) { rank[b] = rank[a] + 1; ch = true; } if (!ch) break; }
    const rows = [];
    d.nodes.forEach((_, i) => { (rows[rank[i]] = rows[rank[i]] || []).push(i); });
    const W = (name) => Math.max(110, Math.min(220, name.length * 7.2 + 28)), H = 34, GX = 26, GY = 38;
    const rowW = rows.map((r) => (r || []).reduce((s, i) => s + W(d.nodes[i]) + GX, -GX));
    const total = Math.max(160, ...rowW), pos = [];
    rows.forEach((r, y) => { let x = (total - rowW[y]) / 2; for (const i of r || []) { const w = W(d.nodes[i]); pos[i] = { x, y: 12 + y * (H + GY), w, h: H }; x += w + GX; } });
    return { pos, w: total + 24, h: 24 + rows.length * (H + GY) - GY, off: 12 };
  }
  function diagramSvg(d) {
    const L = layoutDiagram(d);
    let o = `<svg class="tr-diagram" width="${Math.round(L.w)}" viewBox="0 0 ${L.w} ${L.h}" role="img" aria-label="Block diagram"><defs><marker id="dgar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8aa39a"/></marker></defs>`;
    for (const [a, b] of d.edges) {
      const A = L.pos[a], B = L.pos[b], x1 = A.x + A.w / 2 + L.off, y1 = A.y + A.h, x2 = B.x + B.w / 2 + L.off, y2 = B.y;
      if (y2 > y1) { const my = (y1 + y2) / 2; o += `<path d="M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2 - 1}" fill="none" stroke="#6f8179" stroke-width="1.4" marker-end="url(#dgar)"/>`; }
      else o += `<path d="M${A.x + A.w + L.off} ${A.y + A.h / 2}C${A.x + A.w + 30 + L.off} ${A.y + A.h / 2} ${B.x - 30 + L.off} ${B.y + B.h / 2} ${B.x + L.off} ${B.y + B.h / 2}" fill="none" stroke="#6f8179" stroke-width="1.4" marker-end="url(#dgar)"/>`;
    }
    d.nodes.forEach((name, i) => { const p = L.pos[i]; o += `<g data-dnode="${esc(name)}"><rect x="${p.x + L.off}" y="${p.y}" width="${p.w}" height="${p.h}" rx="5" fill="#f1f3f5" stroke="#b8c0c6"/><text x="${p.x + p.w / 2 + L.off}" y="${p.y + p.h / 2 + 4}" text-anchor="middle" font-size="12" fill="#1c2430" font-family="Inter,Segoe UI,sans-serif">${esc(name)}</text></g>`; });
    return o + "</svg>";
  }
  function diagramBlock(text) {
    const d = parseDiagram(text);
    if (!d.nodes.length) return "";
    C.diagramText = text.trim();
    if (C.ctx && C.ctx.board) { C.ctx.board.s.diagram = C.diagramText; if (C.ctx.onDiagram) setTimeout(C.ctx.onDiagram, 0); }
    return `<figure class="dg" data-nodes="${d.nodes.length}">${diagramSvg(d)}<figcaption>Block diagram · ${d.nodes.length} blocks <button class="tr-x" data-dgbig="1" title="Open larger" aria-label="Open diagram larger">⤢</button></figcaption></figure>`;
  }

  // ---------- messages ----------
  function scroll() { C.log.scrollTop = C.log.scrollHeight; }
  function closeGroup() { C.group = null; }
  function bubble(cls, html) {
    closeGroup();
    const d = document.createElement("div"); d.className = "msg " + cls; d.innerHTML = html; C.log.appendChild(d); scroll(); return d;
  }
  function splitOptions(text) {
    const m = String(text).match(/(?:^|\n)\s*OPTIONS:\s*(.+?)\s*$/i);
    if (!m) return { text, options: [] };
    return { text: String(text).slice(0, m.index).trimEnd(), options: m[1].split("|").map((s) => s.trim()).filter(Boolean).slice(0, 5) };
  }
  function activity(cls, text) {
    if (!C.group) {
      const det = document.createElement("details"); det.className = "msg act"; det.dataset.n = "0";
      det.innerHTML = '<summary><span class="spin"></span><b>Working</b><span class="cnt"></span></summary><div class="lines"></div>';
      C.log.appendChild(det); C.group = det;
    }
    const lines = C.group.querySelector(".lines"), l = document.createElement("div"); l.className = cls; l.textContent = text; lines.appendChild(l);
    const n = lines.children.length; C.group.dataset.n = String(n);
    C.group.querySelector(".cnt").textContent = ` · ${n} step${n > 1 ? "s" : ""}`;
    scroll(); return l;
  }
  /** the one entry point ui.js uses (same classes the old console used) */
  function put(cls, text) {
    if (!C.log) return null;
    if (cls === "u") { const t = String(text).replace(/^›\s*/, ""); return bubble("user", `<p>${inline(t).replace(/\n/g, "<br>")}</p>`); }
    if (cls === "a") {
      const { text: body, options } = splitOptions(text), d = bubble("ai", md(body) || "<p></p>");
      if (options.length) { const row = document.createElement("div"); row.className = "opts"; row.setAttribute("role", "group"); row.setAttribute("aria-label", "Suggested replies"); row.innerHTML = options.map((o) => `<button class="tr-opt" data-opt="${esc(o)}">${esc(o)}</button>`).join(""); d.appendChild(row); }
      C.last = d; return d;
    }
    if (cls === "t" || cls === "r") return activity(cls, text);
    if (cls === "e") return bubble("err", `<p>${inline(text)}</p>`);
    const d = document.createElement("div"); d.className = "msg meta"; d.textContent = text; C.log.appendChild(d); scroll(); return d;
  }
  /** a turn finished: in Plan mode offer to build; stop the group spinner */
  function turnDone() {
    for (const g of C.log.querySelectorAll("details.act")) g.classList.add("fin");
    closeGroup();
    C.log.querySelectorAll(".approve").forEach((e) => e.remove());
    if (C.mode === "plan" && C.last && C.last.isConnected && C.last === C.log.querySelector(".msg.ai:last-of-type")) {
      const row = document.createElement("div"); row.className = "approve";
      row.innerHTML = '<span>Happy with this plan?</span><button class="tr-btn gold" data-approve="1">Approve &amp; build</button><button class="tr-btn" data-replan="1">Keep planning</button>';
      C.last.appendChild(row); scroll();
    }
  }

  // ---------- the workflow stepper ----------
  const STEPS = [["arch", "Architecture"], ["sch", "Schematic"], ["res", "Research"], ["lay", "Layout"], ["rev", "Review"]];
  function stepState(b, drc, safe, review) {
    const parts = b.s.parts.filter((p) => !/^H/.test(p.ref)), links = b.s.links || [];
    const unrouted = (safe.unrouted_links || []).length;
    const done = {
      arch: !!b.s.diagram || parts.length > 0,
      sch: parts.length >= 2 && (links.length > 0 || b.s.traces.length > 0),
      res: parts.length > 0 && parts.every((p) => p.buy),
      lay: parts.length > 0 && (links.length > 0 || b.s.traces.length > 0) && unrouted === 0 && !drc.errors.length,
      rev: false,
    };
    done.rev = done.arch && done.sch && done.res && done.lay && safe.level === "safe" && !(review || []).some((f) => f.level !== "info");
    return done;
  }
  function renderSteps(state) {
    const el = C.ctx.stepsEl; if (!el) return;
    const done = stepState(C.ctx.board, state.drc, state.safe, state.review);
    let cur = STEPS.find(([id]) => !done[id]);
    el.innerHTML = STEPS.map(([id, label], i) => {
      const st = done[id] ? "done" : cur && cur[0] === id ? "current" : "todo";
      return `<button class="step ${st}" data-step="${id}" aria-label="${label}: ${st}"><span class="n">${st === "done" ? "✓" : i + 1}</span><span class="l">${label}</span></button>`;
    }).join('<span class="bar"></span>');
  }

  // ---------- diagram modal ----------
  function bigDiagram(text) {
    const d = parseDiagram(text);
    let m = document.getElementById("trdgmodal");
    if (!m) { m = document.createElement("div"); m.id = "trdgmodal"; m.className = "tr-modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-label", "Block diagram"); C.ctx.root.appendChild(m); m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-dgclose]")) m.hidden = true; }); }
    m.innerHTML = `<div class="tr-modalbox dgbox"><div class="tr-modalhead"><b>Architecture</b><span class="st">${d.nodes.length} blocks</span><span class="sp"></span><button class="tr-x" data-dgclose="1" aria-label="Close diagram">×</button></div><div class="dgbody">${diagramSvg(d)}</div></div>`;
    m.hidden = false;
  }

  function init(ctx) {
    C.ctx = ctx; C.log = ctx.log;
    try { C.mode = localStorage.getItem("trace-mode-v1") === "auto" ? "auto" : "plan"; } catch (_) { C.mode = "plan"; }
    C.log.addEventListener("click", (e) => {
      const t = e.target;
      const opt = t.closest("[data-opt]");
      if (opt) { ctx.send(opt.dataset.opt); return; }
      if (t.closest("[data-approve]")) { setMode("auto"); ctx.send("Approved — build it now, following your plan."); return; }
      if (t.closest("[data-replan]")) { ctx.focus(); return; }
      const big = t.closest("[data-dgbig]");
      if (big) { bigDiagram(C.diagramText); return; }
    });
  }
  function setMode(m) {
    C.mode = m === "auto" ? "auto" : "plan";
    try { localStorage.setItem("trace-mode-v1", C.mode); } catch (_) { /* private mode */ }
    if (C.ctx.onMode) C.ctx.onMode(C.mode);
  }
  window.TraceChat = { init, put, turnDone, renderSteps, setMode, md, parseDiagram, bigDiagram, get mode() { return C.mode; }, get diagram() { return C.diagramText || (C.ctx && C.ctx.board.s.diagram) || ""; }, STEPS, stepState };
})();
