# Claude Web Terminal — Design

## Goals (Requirements)

1. **Jobs must not die when the web terminal is closed** — closing the tab, closing the browser, or losing network connectivity must not stop any running process.
2. **Reopening the web restores the session seamlessly** — the user sees the output they missed while disconnected plus the current screen state, then live streaming resumes in real time.
3. Multi-session (multiple terminals can be open) and multi-viewer (multiple tabs can watch the same session).

## Core Insight: Decouple Three Lifetimes

The problem with typical web terminals is that the PTY is tied to the WebSocket — when the WS closes, the PTY is killed and the job dies. This design separates the system into three layers that fail independently:

```
Browser (xterm.js)          ← dies most often (tab closed, network drop)
   │ WebSocket
Web Gateway (Node.js)       ← can die (deploy, crash) without killing jobs
   │ PTY attach/detach
tmux server (per user)      ← the real owner of processes, hardest to kill
   └── session: shell + jobs
```

## Architecture

```
┌──────────────┐   WebSocket    ┌─────────────────────┐
│   Browser    │◄──────────────►│    Web Gateway      │
│   xterm.js   │  in/out/resize │  Node.js + node-pty │
└──────────────┘                └─────────┬───────────┘
                                          │ pty: tmux attach -t <id>
                                ┌─────────▼───────────┐
                                │    tmux server      │
                                │ ┌─────────────────┐ │
                                │ │ session: web-a1 │ │  ← bash + npm run dev
                                │ │ session: web-b2 │ │  ← bash + long build
                                │ └─────────────────┘ │
                                └─────────────────────┘
```

### Why tmux as the session backend (instead of writing a custom PTY manager)

| Concern | tmux backend | Custom PTY manager |
|---|---|---|
| Jobs survive browser close | ✅ | ✅ (doable) |
| Jobs survive **web server restart/deploy** | ✅ for free | ❌ requires a separate daemon |
| Scrollback / redraw of previous screen | ✅ built-in | Must build a ring buffer yourself |
| Full-screen apps (vim, htop) restore correctly | ✅ tmux keeps screen state | Very hard (requires server-side terminal emulation) |
| Dependency | tmux must be installed | Pure Node |

→ **Choose tmux**, because "survives web server restarts" and "correctly redraws vim/htop" are the expensive features tmux gives you for free.

## Main Flows

### 1. Create a session
```
POST /api/sessions  { name?, cwd?, cmd? }
→ gateway: tmux new-session -d -s web-<uuid> -c <cwd>
→ set tmux options: history-limit 50000, status off
→ respond { sessionId }
```

### 2. Attach (open the web / reconnect)
```
WS /api/sessions/:id/attach
→ gateway spawns PTY: tmux attach-session -t <id>
→ before live streaming: replay scrollback
     tmux capture-pane -t <id> -p -e -S -50000   (-e = keep ANSI colors)
   send as a single "replay" message → xterm.js write
→ then pipe raw PTY output → WS
```

### 3. Web closed / network drop
```
WS close → gateway kills only the PTY client (tmux detach)
→ the tmux session and all jobs inside keep running — nothing dies
```

### 4. Web gateway dies (deploy/crash)
```
The tmux server is an independent process → sessions remain intact
New gateway boots → tmux list-sessions → instantly knows every existing session
(No DB needed for session state — tmux is the source of truth)
```

## WebSocket Protocol

Binary frames for terminal data (fast, no encoding) + JSON control messages:

```
Client → Server
  binary                      → keyboard input (piped straight into the PTY)
  {"type":"resize","cols":C,"rows":R}
  {"type":"ping"}

Server → Client
  binary                      → PTY output (written straight to xterm)
  {"type":"replay-start"} ... binary ... {"type":"replay-end"}
  {"type":"exit","code":N}    → the shell in the session exited (user typed exit)
  {"type":"pong"}
```

### Resize with multiple viewers
By default tmux shrinks to the smallest of all connected clients → set
`window-size latest` + `aggressive-resize on` = use the most recently active client's size (same behavior as the VS Code terminal).

## REST API

```
POST   /api/sessions            create a new session
GET    /api/sessions            list (from tmux list-sessions + metadata)
GET    /api/sessions/:id        detail (created, last-attached, running cmd)
DELETE /api/sessions/:id        tmux kill-session (always confirm first — this one actually kills jobs)
WS     /api/sessions/:id/attach
```

Metadata tmux can't hold (user-assigned names, tags) → store in a small SQLite/JSON file next to the gateway, keyed by session id.

## Frontend

- **xterm.js** + addons: `fit` (resize to container), `webgl` (performance), `web-links`
- Reconnect logic: WS onclose → exponential backoff (1s, 2s, 4s… cap 15s) → re-attach → replay arrives automatically → **clear the terminal before writing the replay** to avoid duplicated output
- Heartbeat ping every 20–30s to keep idle proxies (nginx/CF) from silently dropping the connection
- Session tab list in a sidebar: show every session with status (attached/detached, whether a job is running — from `pane_current_command`)

## Security (minimum required from the MVP onward)

- A terminal is full remote code execution → **never expose it without authentication**
- Auth: session cookie / token verified at WS upgrade (a short-lived token in a query param is fine)
- Enforce WSS/HTTPS
- Run the gateway as a least-privilege user; for serious multi-user setups → separate tmux server per user (dedicated socket: `-S /run/webterm/<user>.sock`)
- Rate-limit session creation + cap the number of sessions per user

## Edge Cases

- **Session GC**: sessions detached longer than N days with no child processes running → notify before cleanup (never auto-kill silently — "jobs don't die" is the whole selling point)
- **Server reboot**: tmux does not survive a reboot — surviving that requires container/VM checkpointing, which is out of scope; just tell users plainly that sessions are lost on machine reboot
- **Very large replay**: cap capture at ~50k lines, send as a single chunk before opening the live stream
- **Binary-unsafe output**: always pipe raw bytes, never decode to string mid-pipeline (prevents corrupting multi-byte UTF-8 sequences)

## Tech Stack Summary

| Layer | Choice |
|---|---|
| Frontend | xterm.js + fit/webgl addons; vanilla or React |
| Transport | WebSocket (ws library), binary frames |
| Gateway | Node.js + node-pty |
| Session backend | tmux (`new-session -d`, `attach`, `capture-pane`) |
| Metadata | SQLite or JSON file |
| Deploy | systemd service (gateway) — the tmux server lives outside the gateway's unit |

## Implementation Plan

1. **Phase 1 (MVP)**: create/attach/detach a single session, replay via capture-pane, automatic reconnect — proves the core selling point immediately
2. **Phase 2**: multi-session + tab UI, session list/kill, metadata store
3. **Phase 3**: auth, HTTPS/WSS, rate limiting, per-user isolation
4. **Phase 4**: polish — job status in the tab list, GC with notification, mobile layout
