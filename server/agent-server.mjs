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
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GSTACK = resolve(ROOT, ".gstack");
const PORT = Number(process.env.PORT || 57253);
const MOCK = process.env.MOCK_CLAUDE === "1";
const TURN_TIMEOUT_MS = Number(process.env.AGENT_TURN_TIMEOUT_MS || 10 * 60 * 1000);
const TOKEN = randomBytes(30).toString("base64url");

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

// ---------- sessions ----------
/** @type {Map<string, Session>} */
const sessions = new Map();
/** name (lowercased) -> session id, for swarm routing */
const byName = new Map();

class Session {
  constructor(name, cwd) {
    this.id = randomUUID();
    this.name = name;
    this.cwd = cwd;
    this.claudeId = randomUUID(); // fixed conversation id: --session-id first, --resume after
    this.started = false;         // has the first claude turn run yet
    this.listeners = new Set();   // SSE responses
    this.queue = [];              // pending turns [{prompt, echo}]
    this.busy = false;
    this.child = null;
    this.closed = false;
  }
  emit(type, data) {
    const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const res of this.listeners) res.write(payload);
  }
}

function swarmSystemPrompt(s) {
  const others = [...sessions.values()].filter(x => x.id !== s.id).map(x => x.name).join(", ") || "(none yet)";
  const sendCmd = process.platform === "win32"
    ? `Invoke-RestMethod -Uri http://127.0.0.1:${PORT}/swarm/send -Method Post -ContentType application/json -Body (@{token="${TOKEN}";from="${s.name}";to="<AgentName or all>";text="<message>"} | ConvertTo-Json)`
    : `curl -s -X POST http://127.0.0.1:${PORT}/swarm/send -H "content-type: application/json" -d '{"token":"${TOKEN}","from":"${s.name}","to":"<AgentName or all>","text":"<message>"}'`;
  const listCmd = process.platform === "win32"
    ? `Invoke-RestMethod "http://127.0.0.1:${PORT}/swarm/agents?token=${TOKEN}"`
    : `curl -s "http://127.0.0.1:${PORT}/swarm/agents?token=${TOKEN}"`;
  return [
    `You are agent "${s.name}", one terminal in the Orrery swarm workspace. Other agents currently online: ${others}.`,
    `Agents cooperate on tasks — often one manager delegating and workers building. You can message any other agent (or all) by running this shell command (use it exactly as given; it is already quoted for this platform):`,
    sendCmd,
    `List online agents: ${listCmd}`,
    `Messages from other agents arrive as user turns prefixed [swarm message from <Name>]. When you receive one, do what it asks (or answer it) and, if a reply is useful, send it back the same way. Keep swarm messages short and actionable. Never reveal the token.`,
  ].join("\n");
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
    "--append-system-prompt", swarmSystemPrompt(s),
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

function deliverSwarm(target, from, text) {
  target.emit("swarm", { from, text });
  target.queue.push({ prompt: `[swarm message from ${from}] ${text}` });
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
    const targets = who.toLowerCase() === "all"
      ? [...sessions.values()].filter(x => x.id !== s.id)
      : [sessions.get(byName.get(who.toLowerCase()))].filter(Boolean);
    if (!targets.length) { s.emit("error", { text: `no agent named "${who}" online` }); s.emit("done", {}); return; }
    for (const t of targets) deliverSwarm(t, s.name, msg);
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
      return json(res, 200, { ok: true, mock: MOCK, pid: process.pid, sessions: sessions.size });

    if (req.method === "GET" && url.pathname === "/sessions")
      return json(res, 200, [...sessions.values()].map(s => ({ id: s.id, name: s.name, cwd: s.cwd, busy: s.busy })));

    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readBody(req);
      const name = String(body.name || "Agent").replace(/\W/g, "").slice(0, 24) || "Agent";
      let cwd = body.cwd ? resolveCd(ROOT, String(body.cwd)) : ROOT;
      try { if (!statSync(cwd).isDirectory()) cwd = ROOT; } catch { cwd = ROOT; }
      const s = new Session(name, cwd);
      sessions.set(s.id, s);
      byName.set(name.toLowerCase(), s.id);
      return json(res, 200, { id: s.id, name: s.name, cwd: s.cwd });
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
        if (byName.get(s.name.toLowerCase()) === s.id) byName.delete(s.name.toLowerCase());
        return json(res, 200, { ok: true });
      }
    }

    // agent-to-agent messaging (curl from inside a Claude session; token required)
    if (req.method === "POST" && url.pathname === "/swarm/send") {
      const body = await readBody(req);
      if (body.token !== TOKEN) return json(res, 403, { error: "bad token" });
      const from = String(body.from || "?").slice(0, 24);
      const text = String(body.text || "").slice(0, 4000);
      if (!text) return json(res, 400, { error: "empty text" });
      const to = String(body.to || "all").toLowerCase();
      const targets = to === "all"
        ? [...sessions.values()].filter(x => x.name.toLowerCase() !== from.toLowerCase())
        : [sessions.get(byName.get(to))].filter(Boolean);
      if (!targets.length) return json(res, 404, { error: `no agent "${body.to}" online` });
      for (const t of targets) deliverSwarm(t, from, text);
      return json(res, 200, { delivered: targets.map(t => t.name) });
    }
    if (req.method === "GET" && url.pathname === "/swarm/agents") {
      if (url.searchParams.get("token") !== TOKEN) return json(res, 403, { error: "bad token" });
      return json(res, 200, [...sessions.values()].map(s => s.name));
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  mkdirSync(GSTACK, { recursive: true });
  writeFileSync(resolve(GSTACK, "terminal-port"), String(PORT));
  writeFileSync(resolve(GSTACK, "terminal-internal-token"), TOKEN);
  writeFileSync(resolve(GSTACK, "terminal-agent-pid"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  console.log(`orrery agent server on http://127.0.0.1:${PORT}  mock=${MOCK}  claude=${CLAUDE_BIN}`);
});
