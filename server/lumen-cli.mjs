#!/usr/bin/env node
// lumen-cli — how Claude (running as the LUMEN dock agent) edits the live canvas.
//   node server/lumen-cli.mjs <command> [key=value ...]
//   node server/lumen-cli.mjs help | state | add_text text="Summer Sale" size=180 | animate id=l3 kind=fade-in start=0 end=1
// Talks to the local agent server, which relays commands to the open LUMEN page.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => { try { return readFileSync(resolve(ROOT, ".gstack", f), "utf8").trim(); } catch { return ""; } };
const port = process.env.LUMEN_PORT || read("terminal-port") || "57253";
const token = process.env.LUMEN_TOKEN || read("terminal-internal-token");
const BASE = `http://127.0.0.1:${port}`;
const [cmd, ...args] = process.argv.slice(2);
const kv = Object.fromEntries(args.map((a) => { const i = a.indexOf("="); return i < 1 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)]; }));

const fail = (m) => { console.error("error: " + m); process.exit(1); };
if (!cmd) { console.error("usage: node server/lumen-cli.mjs <command> [key=value ...]   (try: help)"); process.exit(2); }
try {
  const r = await fetch(`${BASE}/lumen/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, cmd, args: kv }) });
  const j = await r.json();
  if (!j.ok) fail(j.error || r.status);
  console.log(JSON.stringify(j.result, null, 1));
} catch (e) {
  fail("cannot reach the agent server on port " + port + " — is `npm run agents` running? (" + e.message + ")");
}
