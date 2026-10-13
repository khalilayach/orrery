// Orrery agent server — gives each ORCH1 workspace terminal a real Claude Code brain.
//
//   npm run agents            start (real Claude CLI sessions)
//   MOCK_CLAUDE=1 node ...    deterministic mock backend (used by tests)
//
// Design:
//   - zero npm dependencies: node http + SSE (EventSource) for streaming
//   - one server "session" per terminal window; each session owns a cwd and a
//     Claude conversation (fixed --session-id, continued with --resume)
//   - `cd <path>` / `pwd` are intercepted server-side so a terminal can be
//     pointed at ANY folder on the machine before the AI runs there
//   - swarm bus: `@Name text` / `@all text` route between terminals, and the
//     agents themselves can message each other via POST /swarm/send using the
//     internal token their system prompt teaches them
//   - security: binds 127.0.0.1 only; browser endpoints reject any Origin that
//     is not file:// ("null") or localhost, so random websites cannot drive
//     the agents; /swarm/send additionally requires the internal token
import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createPartsStore } from "./parts-store.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GSTACK = resolve(ROOT, ".gstack");
const PORT = Number(process.env.PORT || 57253);
const MOCK = process.env.MOCK_CLAUDE === "1";
const TURN_TIMEOUT_MS = Number(process.env.AGENT_TURN_TIMEOUT_MS || 10 * 60 * 1000);
const TOKEN = randomBytes(30).toString("base64url");
// TRACE parts library: one JSON file per part on disk, so parts are always there.
// Mock runs (tests) use a throwaway folder and a fixture "online" library.
const partsStore = createPartsStore({
  dir: process.env.PARTS_DIR || (MOCK ? join(tmpdir(), "orrery-parts-mock") : resolve(ROOT, "parts-library")),
  mock: MOCK,
});

function findClaude() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const known = resolve(homedir(), ".local", "bin", "claude.exe");
  if (existsSync(known)) return known;
  try {
    const out = execSync(process.platform === "win32" ? "where claude" : "which claude", { encoding: "utf8" });
    const line = out.split(/\r?\n/).find(Boolean);
    if (line && existsSync(line.trim())) return line.trim();
  } catch { /* fall through */ }
  return null;
}
const CLAUDE_BIN = MOCK ? "(mock)" : findClaude();
if (!MOCK && !CLAUDE_BIN) {
  console.error("claude CLI not found — install Claude Code or set CLAUDE_BIN");
  process.exit(1);
}

// ---------- sessions & links ----------
/** @type {Map<string, Session>} */
const sessions = new Map();
/** name (lowercased) -> session id, for swarm routing */
const byName = new Map();
/** id -> {id, from, to, type}; session ids; type: comm|read|boss.
 *  comm = bidirectional messaging · read = `from` may read `to`'s chat ·
 *  boss = `from` commands `to` (messaging allowed both ways, boss→worker
 *  turns are framed as operator instructions) */
const links = new Map();
const LINK_TYPES = new Set(["comm", "read", "boss"]);
function canMessage(aId, bId) {
  return [...links.values()].some(l => (l.type === "comm" || l.type === "boss") &&
    ((l.from === aId && l.to === bId) || (l.from === bId && l.to === aId)));
}
function isBossOf(aId, bId) {
  return [...links.values()].some(l => l.type === "boss" && l.from === aId && l.to === bId);
}
function canRead(aId, bId) {
  return [...links.values()].some(l => l.type === "read" && l.from === aId && l.to === bId);
}
function dropLinksFor(sessionId) {
  for (const [id, l] of links) if (l.from === sessionId || l.to === sessionId) links.delete(id);
}

class Session {
  constructor(name, cwd, kind = "agent") {
    this.id = randomUUID();
    this.name = name;
    this.cwd = cwd;
    this.kind = kind;             // "agent" (swarm terminal) | "trace" (circuit-board studio dock) | "lumen" (image studio dock)
    this.claudeId = randomUUID(); // fixed conversation id: --session-id first, --resume after
    this.started = false;         // has the first claude turn run yet
    this.listeners = new Set();   // SSE responses
    this.queue = [];              // pending turns [{prompt, echo}]
    this.busy = false;
    this.child = null;
    this.closed = false;
    this.log = [];                // rolling transcript, readable over read links
  }
  emit(type, data) {
    if (type === "user") this.log.push("user: " + data.text);
    else if (type === "text") this.log.push(this.name + ": " + data.text);
    else if (type === "tool") this.log.push("[tool] " + data.name + " " + (data.hint || ""));
    else if (type === "swarm") this.log.push("[from " + data.from + "] " + data.text);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const res of this.listeners) res.write(payload);
  }
}

function swarmSystemPrompt(s) {
  const nameOf = id => sessions.get(id)?.name;
  const ls = [...links.values()];
  const msgable = [...new Set(ls
    .filter(l => (l.type === "comm" || l.type === "boss") && (l.from === s.id || l.to === s.id))
    .map(l => nameOf(l.from === s.id ? l.to : l.from)).filter(Boolean))];
  const reads = ls.filter(l => l.type === "read" && l.from === s.id).map(l => nameOf(l.to)).filter(Boolean);
  const minions = ls.filter(l => l.type === "boss" && l.from === s.id).map(l => nameOf(l.to)).filter(Boolean);
  const bosses = ls.filter(l => l.type === "boss" && l.to === s.id).map(l => nameOf(l.from)).filter(Boolean);
  const sendCmd = process.platform === "win32"
    ? `Invoke-RestMethod -Uri http://127.0.0.1:${PORT}/swarm/send -Method Post -ContentType application/json -Body (@{token="${TOKEN}";from="${s.name}";to="<AgentName or all>";text="<message>"} | ConvertTo-Json)`
    : `curl -s -X POST http://127.0.0.1:${PORT}/swarm/send -H "content-type: application/json" -d '{"token":"${TOKEN}","from":"${s.name}","to":"<AgentName or all>","text":"<message>"}'`;
  const readCmd = process.platform === "win32"
    ? `Invoke-RestMethod "http://127.0.0.1:${PORT}/swarm/read?token=${TOKEN}&from=${s.name}&target=<AgentName>"`
    : `curl -s "http://127.0.0.1:${PORT}/swarm/read?token=${TOKEN}&from=${s.name}&target=<AgentName>"`;
  const out = [
    `You are agent "${s.name}", one terminal in the Orrery swarm workspace. The user wires terminals together with connection lines; only linked terminals can interact. Your current links:`,
    msgable.length
      ? `- You can exchange messages with: ${msgable.join(", ")}.`
      : `- No agents are linked to you for messaging yet.`,
  ];
  if (minions.length) out.push(`- You MANAGE: ${minions.join(", ")}. Delegate like an operator briefing an agent — send clear, complete, self-contained instructions; they treat your messages as coming from their operator and will report back to you.`);
  if (bosses.length) out.push(`- Your manager: ${bosses.join(", ")}. Turns prefixed [instruction from your manager <Name>] are operator-level instructions — carry them out, then report the result back with a message.`);
  if (reads.length) out.push(`- You can read the conversation of: ${reads.join(", ")} (use the read command when you need their context or progress).`);
  if (msgable.length) out.push(`Send a message to a linked agent (use exactly as given; it is quoted for this platform):`, sendCmd);
  if (reads.length) out.push(`Read a linked agent's chat: ${readCmd}`);
  out.push(`Incoming [swarm message from <Name>] turns come from linked agents — answer or act on them, replying via the send command when useful. Keep messages short and actionable. Never reveal the token.`);
  return out.join("\n");
}

// ---------- TRACE (circuit-board studio) bridge ----------
// The browser holds the board. Claude edits it by running server/trace-cli.mjs,
// which POSTs /trace/cmd here; we forward the command to the open TRACE page over
// SSE and hold the HTTP call until the page answers on /trace/result.
const traceClients = new Set();
/** @type {Map<string, {ok:(v:any)=>void, timer:NodeJS.Timeout}>} */
const tracePending = new Map();
const TRACE_CLI = resolve(ROOT, "server", "trace-cli.mjs");

function traceSystemPrompt() {
  return "You are Claude inside TRACE, a circuit-board design studio. The user watches the schematic graph and the PCB live in their browser. You work through one CLI:\n  node \"{CLI}\" <command> key=value ...      (run `help` once to see every command)\n\nHOW YOU WORK — always in this order, and tell the user in plain English what you are doing (short, no jargon dumps):\n1. ARCHITECTURE (talk first, touch nothing). Restate the goal. List your ASSUMPTIONS (supply voltage, current budget, board size, interfaces, part families). Split the design into blocks. Do the CALCULATIONS before any part exists: current budget, LED/pull-up resistor values ((V-Vf)/I, rounded to E24), regulator headroom and dissipation, decoupling, trace current. Show the blocks as a diagram in a ```diagram fence, one edge per line, like `USB-C -> 3.3V LDO` (boxes appear automatically). If the user has a real decision to make, end the message with one line: `OPTIONS: first choice | second choice | third choice`.\n   In PLAN mode you stop here and wait — you are not allowed to edit the board. In AUTO mode continue straight on.\n2. RESEARCH. `find_parts q=\"...\"` returns real LCSC/JLCPCB parts with price, stock and links (no key needed). Choose parts whose ratings fit your calculations; prefer in-stock, JLCPCB-basic parts, all from one vendor (LCSC) so the user ships once. Say which part you chose and why.\n3. SCHEMATIC. Write the WHOLE design as one JSON file and send it ONCE: `build file=design.json`. Add dry=1 first if unsure. In the spec give every part a ref, type, value, a `block` (a short sheet name like \"USB-C Conn\", \"3V3 Regulator\" — it becomes a titled sheet in the user's Schematic) and a `note` (what it does in this circuit), and describe wiring as `nets` (net name -> list of pads). The user reads that schematic: power and ground show as symbols on the pins, signals as wires, so name nets meaningfully (VBUS, +3V3, GND, LED_SIG). Parts without x/y are placed automatically and can never overlap. Never place or delete parts one at a time to \"see what happens\", and never remove-then-re-add: to change anything, send a corrected full spec with replace:true. Look at `help` for the exact spec format.\n4. CHECK. `build` returns the circuit digest, the electrical problems and design-rule errors. Fix every DANGER and DRC error by correcting the spec (not by patching), then build again. Re-read with `circuit` ONCE at the end.\n5. LAYOUT and REVIEW — only when the schematic is clean: `add_part`/`source` real parts, then the PCB: wire classes (`rule_class name=Power width=0.5`, `rule_assign net=VBUS,+3V3 class=Power` — traces take their net's class width automatically), board shape (`set_outline radius=`, `add_cutout`; or pass `outline`, `cutouts`, `rules` inside the build spec), `autoplace` (edge connectors face outward, decoupling caps sit at their pins, parts keep a hand-solderable gap; `set_assembly mode=hand|reflow`), then `autoroute` (real 45° copper with class widths/clearances, vias only when needed, ground via a B.Cu pour; read `failed` and fix the cause, never leave airwires), `drc`, then `review` like an engineer (missing decoupling, regulator caps, pull-ups, USB ESD/skew, connectors off the edge, parts too close to solder, thin traces) and fix every danger/warning with its `fix` text, re-run until clean. When you pick MCU pins, choose ones on the side facing the connector they serve so wiring is short. For any trace the user asks about, `explain_trace id=` / `explain_net net=` gives the exact settings (class, width, clearance, via, layer, current, drop); tell the user those numbers. Then `circuit`, then a plain-English review: what every block does, the key numbers, remaining risks, what the user should double-check.\n\nREADING A CIRCUIT FAST: `circuit` is the graph in text: every part with its ratings and connected pins, every net with voltage and current, the power tree, problems and a TODO list. The notes after \"—\" say what each part is for. Trust it. Do NOT call `board` (large) unless you need exact pad coordinates, and never explore by trial and error.\n\nCART: the user buys everything in one order. `bom` is the cart. Prefer parts that are all on LCSC (find_parts returns LCSC ids) so it ships from one place; say so if you could not.\n\nTOOLS YOU MAY NEED: unplug pad=U1.GND (one pin off a net), rule_class / rule_assign / apply_rules, set_outline, add_cutout / set_cutout, connect / disconnect / auto_wire (graph wires), insert_series pad=D1.A value=330R (resistor in series), set_electrical (ratings), describe ref= text= (what a part does), source / bom (real part + cost), free_spot, drc, analyze, undo. Coordinates are mm, origin top-left, y grows down; pads are REF.PAD (U1.4 or U1.VDD). Rules: min trace 0.15 mm, gap 0.15 mm, edge clearance 0.30 mm. If the CLI says TRACE is not open, tell the user to open it.\n\nSTYLE: you are talking to someone designing a board, often learning. Use short sections (Assumptions, Calculations, Plan, Result), tables for comparisons, plain words. Never edit project files; the CLI is your only tool for the board.".replace("{CLI}", TRACE_CLI);
}

function traceCommand(cmd, args) {
  return new Promise((ok) => {
    if (!traceClients.size) return ok({ code: 503, body: { ok: false, error: "TRACE workspace is not open in the browser — ask the user to open the TRACE constellation in Orrery." } });
    const id = randomUUID();
    const timer = setTimeout(() => { tracePending.delete(id); ok({ code: 504, body: { ok: false, error: "TRACE did not answer in time" } }); }, 15000);
    tracePending.set(id, { ok, timer });
    const payload = `data: ${JSON.stringify({ type: "cmd", id, cmd, args })}\n\n`;
    for (const res of traceClients) res.write(payload);
  });
}

// ---------- LUMEN bridge (image / GIF / video studio) ----------
// Same relay as TRACE: Claude runs server/lumen-cli.mjs, which POSTs /lumen/cmd; the open
// LUMEN page receives it over SSE, runs it on the live document, and answers on /lumen/result.
const lumenClients = new Set();
/** @type {Map<string, {ok:(v:any)=>void, timer:NodeJS.Timeout}>} */
const lumenPending = new Map();
const LUMEN_CLI = resolve(ROOT, "server", "lumen-cli.mjs");

function lumenSystemPrompt() {
  return [
    `You are Claude inside LUMEN, the image / GIF / video studio of the Orrery workspace. The user is looking at a live canvas in their browser and you edit that same canvas.`,
    `You control it ONLY by running this command (any shell; quote values that contain spaces):`,
    `  node "${LUMEN_CLI}" <command> key=value key=value ...`,
    `Run \`node "${LUMEN_CLI}" help\` first to see every command, then \`state\` to read the canvas and its layers (top layer first).`,
    `Units are pixels, origin top-left, y grows downward. Layers are addressed by id (l12) or exact name; with no id the selected layer is used. Text can contain emoji.`,
    `Typical flow: state → add_text / add_shape / add_image → set (position, colour, opacity, blend) → adjust (brightness, contrast, blur…) → animate (fade-in, slide-up, pulse…) → state to verify. The user sees every change live, so narrate briefly. Everything is undoable by the user.`,
    `Design well: keep margins, align things to the canvas (align to=center), use at most two fonts, keep text contrast readable, and size text relative to the canvas height.`,
    `You cannot see pixels; rely on state (positions, sizes) and get_pixel for colours. Never edit project files to change the canvas — use the CLI. If the CLI says the LUMEN workspace is not open, tell the user to open the LUMEN constellation.`,
  ].join("\n");
}

function lumenCommand(cmd, args) {
  return new Promise((ok) => {
    if (!lumenClients.size) return ok({ code: 503, body: { ok: false, error: "LUMEN workspace is not open in the browser — ask the user to open the LUMEN constellation in Orrery." } });
    const id = randomUUID();
    const timer = setTimeout(() => { lumenPending.delete(id); ok({ code: 504, body: { ok: false, error: "LUMEN did not answer in time" } }); }, 30000);
    lumenPending.set(id, { ok, timer });
    const payload = `data: ${JSON.stringify({ type: "cmd", id, cmd, args })}\n\n`;
    for (const res of lumenClients) res.write(payload);
  });
}

// ---------- claude turn runner ----------
function doCd(s, raw) {
  const dest = resolveCd(s.cwd, raw);
  try {
    if (!statSync(dest).isDirectory()) throw new Error("not a directory");
    s.cwd = dest;
    // claude CLI stores conversations per project dir — a resumed session is
    // invisible from a different cwd, so moving means starting fresh there
    if (s.started) {
      s.claudeId = randomUUID();
      s.started = false;
      s.emit("meta", { text: `cwd → ${dest} · new conversation rooted here` });
    } else s.emit("meta", { text: `cwd → ${dest}` });
  } catch { s.emit("error", { text: `no such directory: ${dest}` }); }
  s.emit("done", {});
}

function runTurn(s) {
  if (s.busy || s.closed || s.queue.length === 0) return;
  const item = s.queue.shift();
  if (item.cd !== undefined) { doCd(s, item.cd); return runTurn(s); } // cds queue in order with turns
  s.busy = true;
  const { prompt } = item;
  s.emit("meta", { text: "thinking…" });
  if (MOCK) return mockTurn(s, prompt);

  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions",
    "--append-system-prompt", s.kind === "trace" ? traceSystemPrompt() : s.kind === "lumen" ? lumenSystemPrompt() : swarmSystemPrompt(s),
    s.started ? "--resume" : "--session-id", s.claudeId];
  const child = spawn(CLAUDE_BIN, args, { cwd: s.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  s.child = child;
  child.stdin.write(prompt);
  child.stdin.end();

  const timer = setTimeout(() => { s.emit("error", { text: "turn timed out" }); child.kill(); }, TURN_TIMEOUT_MS);
  let buf = "", errBuf = "";
  child.stdout.on("data", d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleClaudeEvent(s, line);
    }
  });
  child.stderr.on("data", d => { errBuf += d; });
  child.on("close", code => {
    clearTimeout(timer);
    s.child = null;
    s.started = true;
    if (code !== 0 && !s.closed) s.emit("error", { text: (errBuf.trim() || `claude exited ${code}`).slice(0, 500) });
    s.emit("done", {});
    s.busy = false;
    runTurn(s); // drain queue
  });
}

function handleClaudeEvent(s, line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "assistant" && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === "text" && block.text) s.emit("text", { text: block.text });
      else if (block.type === "tool_use") {
        const hint = block.input?.command || block.input?.file_path || block.input?.pattern ||
          block.input?.description || block.input?.prompt || "";
        s.emit("tool", { name: block.name, hint: String(hint).slice(0, 120) });
      }
    }
  } else if (ev.type === "result") {
    if (ev.is_error && ev.result) s.emit("error", { text: String(ev.result).slice(0, 500) });
  }
}

function mockTurn(s, prompt) {
  setTimeout(() => {
    if (s.closed) return;
    if (/what.*(folder|directory|cwd)|where are you/i.test(prompt)) s.emit("text", { text: `mock:${s.name} cwd=${s.cwd}` });
    else s.emit("text", { text: `mock:${s.name} received: ${prompt}` });
    s.emit("done", {});
    s.busy = false;
    runTurn(s);
  }, 60);
}

// ---------- input handling: cd / pwd / @routing / normal turn ----------
function resolveCd(cwd, raw) {
  let p = raw.trim().replace(/^["']|["']$/g, "");
  if (!p || p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = resolve(homedir(), p.slice(2));
  if (/^[A-Za-z]:$/.test(p)) p += "\\";
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function deliverSwarm(target, fromSession, text) {
  const boss = isBossOf(fromSession.id, target.id);
  target.emit("swarm", { from: fromSession.name, text, boss });
  target.queue.push({
    prompt: (boss ? `[instruction from your manager ${fromSession.name}] ` : `[swarm message from ${fromSession.name}] `) + text,
  });
  runTurn(target);
}

function handleInput(s, text) {
  text = String(text ?? "").trim();
  if (!text) return;
  s.emit("user", { text });

  const cd = text.match(/^cd\s+(.+)$/i) || (text.toLowerCase() === "cd" ? [null, "~"] : null);
  if (cd) { s.queue.push({ cd: cd[1] }); runTurn(s); return; }
  if (/^pwd$/i.test(text)) { s.emit("meta", { text: s.cwd }); s.emit("done", {}); return; }

  const at = text.match(/^@(\w+)\s+([\s\S]+)$/);
  if (at) {
    const [, who, msg] = at;
    let targets;
    if (who.toLowerCase() === "all") {
      targets = [...sessions.values()].filter(x => x.id !== s.id && canMessage(s.id, x.id));
      if (!targets.length) { s.emit("error", { text: "no linked agents — drag a comm or command line to another terminal first" }); s.emit("done", {}); return; }
    } else {
      const t = sessions.get(byName.get(who.toLowerCase()));
      if (!t) { s.emit("error", { text: `no agent named "${who}" online` }); s.emit("done", {}); return; }
      if (!canMessage(s.id, t.id)) { s.emit("error", { text: `not linked to ${t.name} — drag a comm or command line between the terminals first` }); s.emit("done", {}); return; }
      targets = [t];
    }
    for (const t of targets) deliverSwarm(t, s, msg);
    s.emit("meta", { text: `sent to ${targets.map(t => t.name).join(", ")}` });
    s.emit("done", {});
    return;
  }

  s.queue.push({ prompt: text });
  runTurn(s);
}

// ---------- http ----------
function originOk(req) {
  const o = req.headers.origin;
  if (!o || o === "null") return true; // curl / file://
  try { const h = new URL(o).hostname; return h === "localhost" || h === "127.0.0.1"; } catch { return false; }
}
function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let b = "";
    req.on("data", d => { b += d; if (b.length > 1e6) { bad(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } });
  });
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (!originOk(req)) return json(res, 403, { error: "forbidden origin" });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (req.method === "GET" && url.pathname === "/health")
      // mock only: expose the token so tests can hit token-gated endpoints
      return json(res, 200, { ok: true, mock: MOCK, pid: process.pid, sessions: sessions.size, ...(MOCK ? { token: TOKEN } : {}) });

    if (req.method === "GET" && url.pathname === "/sessions")
      return json(res, 200, [...sessions.values()].filter(s => s.kind === "agent") // trace docks aren't swarm agents
        .map(s => ({ id: s.id, name: s.name, cwd: s.cwd, busy: s.busy })));

    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readBody(req);
      const name = String(body.name || "Agent").replace(/\W/g, "").slice(0, 24) || "Agent";
      let cwd = body.cwd ? resolveCd(ROOT, String(body.cwd)) : ROOT;
      try { if (!statSync(cwd).isDirectory()) cwd = ROOT; } catch { cwd = ROOT; }
      const kind = body.kind === "trace" ? "trace" : body.kind === "lumen" ? "lumen" : "agent";
      const s = new Session(name, cwd, kind);
      sessions.set(s.id, s);
      if (kind === "agent") byName.set(name.toLowerCase(), s.id); // trace docks are not swarm-addressable
      return json(res, 200, { id: s.id, name: s.name, cwd: s.cwd, kind });
    }

    if (parts[0] === "session" && parts[1]) {
      const s = sessions.get(parts[1]);
      if (!s) return json(res, 404, { error: "no such session" });
      if (req.method === "GET" && parts[2] === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "hello", name: s.name, cwd: s.cwd })}\n\n`);
        s.listeners.add(res);
        req.on("close", () => s.listeners.delete(res));
        return;
      }
      if (req.method === "POST" && parts[2] === "input") {
        const body = await readBody(req);
        handleInput(s, body.text);
        return json(res, 202, { ok: true });
      }
      if (req.method === "DELETE" && !parts[2]) {
        s.closed = true;
        if (s.child) s.child.kill();
        for (const l of s.listeners) l.end();
        sessions.delete(s.id);
        dropLinksFor(s.id);
        if (s.kind === "agent" && byName.get(s.name.toLowerCase()) === s.id) byName.delete(s.name.toLowerCase());
        return json(res, 200, { ok: true });
      }
    }

    // terminal-to-terminal wiring (drawn by the user in the UI)
    if (req.method === "POST" && url.pathname === "/link") {
      const body = await readBody(req);
      const type = String(body.type || "");
      if (!LINK_TYPES.has(type)) return json(res, 400, { error: "bad link type" });
      if (!sessions.has(body.from) || !sessions.has(body.to) || body.from === body.to)
        return json(res, 400, { error: "bad endpoints" });
      const dupe = [...links.values()].find(l => l.type === type && l.from === body.from && l.to === body.to);
      if (dupe) return json(res, 200, dupe);
      const link = { id: randomUUID(), from: body.from, to: body.to, type };
      links.set(link.id, link);
      return json(res, 200, link);
    }
    if (req.method === "DELETE" && parts[0] === "link" && parts[1]) {
      if (!links.delete(parts[1])) return json(res, 404, { error: "no such link" });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/links")
      return json(res, 200, [...links.values()]);

    // agent-to-agent messaging (run from inside a Claude session; token required,
    // and the two terminals must be wired with a comm or boss link)
    if (req.method === "POST" && url.pathname === "/swarm/send") {
      const body = await readBody(req);
      if (body.token !== TOKEN) return json(res, 403, { error: "bad token" });
      const fromS = sessions.get(byName.get(String(body.from || "").toLowerCase()));
      if (!fromS) return json(res, 404, { error: `unknown sender "${body.from}"` });
      const text = String(body.text || "").slice(0, 4000);
      if (!text) return json(res, 400, { error: "empty text" });
      const to = String(body.to || "all").toLowerCase();
      let targets;
      if (to === "all") {
        targets = [...sessions.values()].filter(x => x.id !== fromS.id && canMessage(fromS.id, x.id));
        if (!targets.length) return json(res, 403, { error: "no agents are linked to you" });
      } else {
        const t = sessions.get(byName.get(to));
        if (!t) return json(res, 404, { error: `no agent "${body.to}" online` });
        if (!canMessage(fromS.id, t.id)) return json(res, 403, { error: `not linked to ${t.name} — the user has to draw a connection line first` });
        targets = [t];
      }
      for (const t of targets) deliverSwarm(t, fromS, text);
      return json(res, 200, { delivered: targets.map(t => t.name) });
    }
    if (req.method === "GET" && url.pathname === "/swarm/agents") {
      if (url.searchParams.get("token") !== TOKEN) return json(res, 403, { error: "bad token" });
      return json(res, 200, [...sessions.values()].filter(s => s.kind === "agent").map(s => s.name));
    }
    // read a linked agent's transcript (requires a read link from → target)
    if (req.method === "GET" && url.pathname === "/swarm/read") {
      if (url.searchParams.get("token") !== TOKEN) return json(res, 403, { error: "bad token" });
      const fromS = sessions.get(byName.get(String(url.searchParams.get("from") || "").toLowerCase()));
      const target = sessions.get(byName.get(String(url.searchParams.get("target") || "").toLowerCase()));
      if (!fromS || !target) return json(res, 404, { error: "unknown agent" });
      if (!canRead(fromS.id, target.id)) return json(res, 403, { error: `no read link to ${target.name} — the user has to draw one first` });
      return json(res, 200, { name: target.name, cwd: target.cwd, transcript: target.log.slice(-80) });
    }

    // ---- TRACE parts library: files on disk + online footprint search ----
    if (req.method === "GET" && url.pathname === "/parts") return json(res, 200, partsStore.list());
    if (req.method === "POST" && url.pathname === "/parts") {
      try { return json(res, 200, { ok: true, file: partsStore.save(await readBody(req)) }); }
      catch (e) { return json(res, e.code || 400, { error: String(e.message || e) }); }
    }
    if (req.method === "DELETE" && parts[0] === "parts" && parts[1]) {
      try { partsStore.remove(parts[1]); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, e.code || 400, { error: String(e.message || e) }); }
    }
    if (req.method === "GET" && url.pathname === "/parts/search") {
      try { return json(res, 200, await partsStore.search(url.searchParams.get("q"))); }
      catch (e) { return json(res, 502, { error: String(e.message || e) }); }
    }
    if (req.method === "GET" && url.pathname === "/parts/import") {
      try { return json(res, 200, await partsStore.importFootprint(String(url.searchParams.get("path") || ""))); }
      catch (e) { return json(res, 502, { error: String(e.message || e) }); }
    }

    // ---- TRACE bridge: browser subscribes, Claude's CLI sends commands ----
    if (req.method === "GET" && url.pathname === "/trace/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      traceClients.add(res);
      req.on("close", () => traceClients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/trace/status")
      return json(res, 200, { open: traceClients.size > 0 });
    if (req.method === "POST" && url.pathname === "/trace/result") {
      const body = await readBody(req);
      const p = tracePending.get(body.id);
      if (!p) return json(res, 404, { error: "no pending command" });
      clearTimeout(p.timer);
      tracePending.delete(body.id);
      p.ok(body.ok ? { code: 200, body: { ok: true, result: body.result } } : { code: 422, body: { ok: false, error: String(body.error || "failed") } });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/trace/cmd") {
      const body = await readBody(req);
      if (body.token !== TOKEN) return json(res, 403, { error: "bad token" });
      const out = await traceCommand(String(body.cmd || ""), body.args ?? []);
      return json(res, out.code, out.body);
    }

    // ---- LUMEN bridge ----
    if (req.method === "GET" && url.pathname === "/lumen/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      lumenClients.add(res);
      req.on("close", () => lumenClients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/lumen/status")
      return json(res, 200, { open: lumenClients.size > 0 });
    if (req.method === "POST" && url.pathname === "/lumen/result") {
      const body = await readBody(req);
      const p = lumenPending.get(body.id);
      if (!p) return json(res, 404, { error: "no pending command" });
      clearTimeout(p.timer);
      lumenPending.delete(body.id);
      p.ok(body.ok ? { code: 200, body: { ok: true, result: body.result } } : { code: 422, body: { ok: false, error: String(body.error || "failed") } });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/lumen/cmd") {
      const body = await readBody(req);
      if (body.token !== TOKEN) return json(res, 403, { error: "bad token" });
      const out = await lumenCommand(String(body.cmd || ""), body.args ?? {});
      return json(res, out.code, out.body);
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already in use — an agent server is likely running.`);
    console.error(`check: curl http://127.0.0.1:${PORT}/health · stop it via the pid in .gstack/terminal-agent-pid (taskkill /PID <pid> /F)`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  if (!MOCK) { // mock instances (tests) must not clobber the real server's state files
    mkdirSync(GSTACK, { recursive: true });
    writeFileSync(resolve(GSTACK, "terminal-port"), String(PORT));
    writeFileSync(resolve(GSTACK, "terminal-internal-token"), TOKEN);
    writeFileSync(resolve(GSTACK, "terminal-agent-pid"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  }
  console.log(`orrery agent server on http://127.0.0.1:${PORT}  mock=${MOCK}  claude=${CLAUDE_BIN}`);
});
