# ORCH1 Terminal — Design Doc

_Office-hours session, 2026-07-03. Builder mode. Project: Orrery (`index.html`)._

## The idea

Clicking the **ORCH1** constellation no longer opens the pink detail panel. Instead the
camera **zooms into a black terminal window** — a real, custom-rendered Claude terminal that
runs on your Claude membership (like Claude Code), can read files in a working directory, and
lives inside the Orrery aesthetic. It's a **local-only personal tool**: it works when you run
Orrery on your own machine; the public/portfolio experience is out of scope for now.

## Decisions locked this session

| # | Decision | Why |
|---|----------|-----|
| D1 | **Real, local-only** (not cinematic-fake, not public backend) | Simplest honest path; kills every visitor-safety/cost/abuse problem. Only you use it. |
| D2 | **ORCH1 only.** EVE-NG keeps its pink panel; Orrery home is untouched | Smallest change; ORCH1 becomes the one "special" node. "All black / no glow" applies only inside the terminal view. |
| D3 | **Fully custom UI + Claude Agent SDK backend** | Every glyph dithers/glows/types like Orrery. Membership-auth risk is resolved (see below). |

## Architecture

Orrery stops being a double-clickable static file (locally) and runs through a tiny local server.

```
Browser (index.html, your custom canvas terminal)
        |  WebSocket (typed message stream)
        v
Local Node server  ──uses──>  @anthropic-ai/claude-agent-sdk
        |                            |
        |                     auth: your Claude membership
        |                     (Claude Code OAuth / CLAUDE_CODE_OAUTH_TOKEN)
        v
   working directory (e.g. your projects folder)  ← "files on my computer"
```

- **Auth = your membership, confirmed.** The Agent SDK is the Claude Code engine and inherits
  its auth. It uses your logged-in Claude Code subscription by default; for a persistent
  backend, mint a token with `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`.
  `ANTHROPIC_API_KEY` (pay-per-token) is only a fallback. **No per-message cost.**
- **"Linked to my files" = a working directory** you point the backend at, with Claude Code's
  normal permission prompts. Scoped cwd, not raw whole-disk access.
- **Streaming = token-level.** `query({ ..., includePartialMessages: true })` yields partial
  deltas you feed straight into the dithered typing animation. Tool-use and results arrive as
  typed events you can render as their own styled lines.

## The ORCH1 terminal — visual/interaction spec

- **Trigger:** click ORCH1 → repurpose the existing `startDive` camera zoom (`index.html:311`)
  to fly *into* the terminal window as it materializes. It grows from the node; it does not
  pop in.
- **The window:** a draggable, opaque black panel covering a large portion of the viewport but
  not all of it. The **main-page void shows around it, never through it.**
- **Inside the window, back to front:**
  1. opaque black base
  2. a **dimmer** copy of the void + dithering (reuse the WebGL shader / ASCII ramp, lower
     brightness than the home void), gently moving
  3. **CRT** scanline overlay (reuse `#crt`, tuned per-window)
  4. the text layer — every character rendered by you, so typing/glow/dither match Orrery
- **No page glow** in this view. Everything black.
- **Input:** you can type; Enter sends to the backend; responses stream back character-by-character.
- **Activate-Claude button:** placement + styling deferred to `/design-shotgun` (your call).

## Build plan (phased, so you always have something working)

1. **Terminal shell, faked.** Build the draggable black window, the dim inner void/dither/CRT
   layers, the zoom-in transition from ORCH1, and a custom text renderer with the typing
   animation. Wire input to a stubbed echo responder. Pure frontend — ship the *look* first.
2. **Local server + Agent SDK.** Stand up `node server.js` with a WebSocket, wire
   `@anthropic-ai/claude-agent-sdk` `query()` with `includePartialMessages`, authenticate via
   your membership, point it at a working directory. Swap the stub for real streamed responses.
3. **Tool-call rendering + polish.** Render tool-use/tool-result events as their own Orrery-styled
   lines. Tune the dither/CRT/glow balance. Run `/design-shotgun` for the activate button.

## Open questions (not blocking)

- Activate-Claude button placement/style → `/design-shotgun`.
- Exact working directory the terminal opens in (your projects folder? the Orrery repo?).
- Whether the terminal persists conversation across zoom-out/zoom-in, or resets each dive.

## The assignment

Before writing terminal code: **spike the auth in 15 minutes.** In a scratch folder,
`npm i @anthropic-ai/claude-agent-sdk`, make sure you're logged into Claude Code (`claude`),
and run a minimal `query({ prompt: "say hi", options: { includePartialMessages: true } })`
Node script. Confirm it streams a reply **without** an `ANTHROPIC_API_KEY` set — i.e. that it's
really running on your membership. If that works, Phase 2 is de-risked and the whole design holds.
If it demands a key, check the current SDK README's auth section (or `claude setup-token`)
before building anything else.

---

# Phase 2 — SHIPPED: real Claude Code terminals (2026-07-05)

Implementation landed. Instead of the Agent SDK, the backend shells out to the installed
`claude` CLI (`-p --output-format stream-json`), which runs on the local login — no API key.

## Running it

```
npm run agents     # start the backend (http://127.0.0.1:57253)
# then open index.html and dive into ORCH1 (or open index.html#orch1)
```

Every summoned terminal is a live Claude Code session. Type into the input line at the
bottom of a window. Without the server running, terminals degrade to an offline notice.

## Terminal commands

| input               | effect |
|---------------------|--------|
| any text            | a real Claude turn, streamed back (tool calls shown as `▸ Bash: …` lines) |
| `cd <path>` / `cd ~`| repoint this terminal at ANY folder on the machine; the agent reads/writes there (starts a fresh conversation rooted in that folder) |
| `pwd`               | show the terminal's current folder |
| `@Name message`     | message another terminal (requires a comm or boss wire) |
| `@all message`      | broadcast to every wired terminal |

## Swarm — wired by hand

Terminals only interact when you wire them together. Every window has three port dots on
its right edge; drag a dot onto another terminal to draw a wire (click a wire to cut it):

| dot | wire | meaning |
|-----|------|---------|
| blue `comm` | white line | both agents can message each other |
| teal `read` | dashed cyan arrow | the source agent can read the target's chat (`/swarm/read`) |
| amber `boss` | amber arrow | source commands target: its messages arrive as `[instruction from your manager X]` operator-level orders; the worker reports back |

All routing — user-typed `@Name`/`@all` and agent-initiated `POST /swarm/send` — is
gated by these links server-side (comm or boss allows messaging; read is read-only).
Each session's system prompt is rebuilt every turn from the current wiring, so agents
always know who they can talk to, who they manage, and who their manager is. The
internal token regenerates each server start (`.gstack/terminal-internal-token`).

## Architecture

- `server/agent-server.mjs` — zero-dependency Node HTTP + SSE server, 127.0.0.1 only.
  One session per terminal window: fixed `--session-id` first turn, `--resume` after,
  spawned in the session's cwd. Sequential turn queue per session, parallel across sessions.
- Security: rejects non-localhost/file Origins (drive-by websites can't puppet the agents);
  `/swarm/send` requires the internal token. **Sessions run with
  `--dangerously-skip-permissions`** — the UI can't answer permission prompts, so agents
  act autonomously. Only summon agents on work you'd let Claude do unattended.
- Frontend: each `.ws-win` opens an `EventSource`; events render as styled lines
  (user `›`, assistant, tool `▸`, swarm `⇄`, errors). Port override for tests: `?agents=<port>`.
- Tests: `tests/agent-terminals.spec.js` runs against a `MOCK_CLAUDE=1` instance on :57312
  (started automatically by Playwright's webServer) — deterministic, no API spend.
