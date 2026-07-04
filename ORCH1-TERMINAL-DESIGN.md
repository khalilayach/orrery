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
