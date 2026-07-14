# Terminal wire protocol

The gateway (`apps/terminal-gateway/src/server.js`) is the source of truth; the Zod schemas in `packages/shared-types/src/terminal.ts` mirror it exactly and are what the frontend validates against. **Change server and schemas together.**

## REST API

Base path: `/api/sessions` on the gateway (default `http://localhost:3007`). In the browser these calls go through the Next.js rewrite proxy, so they are same-origin; the gateway itself sends no CORS headers (deliberate).

### `GET /api/sessions` → 200

Returns `SessionInfo[]`:

```json
[
  {
    "id": "web-6f2c…", // always "web-" + UUID
    "name": "my-session",
    "createdAt": 1752444000000, // epoch ms; nullable
    "tags": [], // reserved for future use
    "currentCommand": "bash", // command in the active pane
    "attached": true // ≥1 tmux client attached
  }
]
```

### `POST /api/sessions` → 201

Create a session. Body (all fields optional):

```json
{ "name": "my-session", "cwd": "/home/me/project" }
```

Response: `{ "id": "web-…", "name": "…", "createdAt": 1752444000000 }`

### `DELETE /api/sessions/:id` → 204

Kills the tmux session (the **only** place `tmux kill-session` is ever run). No body either way.

### Errors (400 / 404 / 500)

Always `{ "error": "<message>" }`.

## WebSocket: `/attach?session=<id>`

`ws://<gateway>/attach?session=web-…` — the session must already exist (attach never creates). On attach the gateway spawns a node-pty running `tmux attach-session -t <id>`; on socket close it kills **only that pty**, which detaches the tmux client and leaves the session running.

**Routing is by frame type, not content:**

| Frame type  | Direction       | Meaning                                                                                    |
| ----------- | --------------- | ------------------------------------------------------------------------------------------ |
| Binary      | server → client | Raw pty output — write straight to `term.write(new Uint8Array(data))`                      |
| Binary      | client → server | Keystrokes — `TextEncoder().encode(data)` from `term.onData`                               |
| Text (JSON) | client → server | Control: `{"type":"resize","cols":N,"rows":N}` · `{"type":"ping"}`                         |
| Text (JSON) | server → client | Control: `{"type":"exit","code":N}` · `{"type":"pong"}` · `{"type":"error","message":"…"}` |

Schemas: `WsClientMessageSchema` / `WsServerMessageSchema` (discriminated unions on `type`) in `@sparklab/shared-types`.

## Load-bearing invariants (do not break)

These are what the smoke/acceptance scripts and the E2E gates protect. Every one has been broken-and-caught at least once in design; treat them as API.

1. **Raw bytes end to end.** The pty is spawned with `encoding: null`, so `onData` yields Buffers. pty output → WS binary frame → `term.write(Uint8Array)`. Keystrokes → `TextEncoder` → WS binary → `pty.write`. Decoding to a JS string anywhere mid-pipeline corrupts multibyte UTF-8 (verified with Thai input — E2E gate 2).
2. **The gateway never kills the session on disconnect.** `teardown()` kills only the attach pty. Job survival across tab close / network loss / gateway restart depends on this single absence.
3. **Reconnect resets before redraw.** The client sets a fresh-connect flag on every (re)connect and calls `term.reset()` on the _first binary frame_ after it, so tmux's attach redraw lands on a clean screen. No `capture-pane` replay — it would double-draw.
4. **Frame-type routing.** Anything new on the wire follows the split above: binary = terminal I/O, JSON text = control. Never mix.
5. **One live connection per terminal.** The `Connection` class enforces single-live-connection semantics: a `noReconnect` guard blocks _both_ resurrection paths (onclose-backoff and heartbeat force-close), and supersession checks ignore events from a replaced socket. In React this pairs with StrictMode-safe effect cleanup so dev double-mount never yields two tmux clients.
6. **Multi-viewer sizing.** Sessions are created with `window-size latest` + `aggressive-resize on` so tmux follows the most recently active client (E2E gate 6).
7. **No CDN.** xterm.js and addons are npm dependencies bundled into the app (offline/CSP requirement). Never load terminal assets from an external origin.

## Client lifecycle (apps/terminal)

`features/terminal/connection.ts` implements, per session attach:

- **Heartbeat**: periodic `{"type":"ping"}`; if no activity (pong or output) arrives in the window, the socket is force-closed, which routes into the reconnect path.
- **Reconnect backoff**: 1s → 2s → 4s → 8s → 15s (capped), reset on successful connect.
- **`dispose()`** clears all timers/handlers and sets `noReconnect` — after dispose, nothing can resurrect the socket.
- **Session switching** swaps the `Connection` on the same xterm `Terminal` instance (never remounts the terminal component).

The unit tests in `apps/terminal/src/features/terminal/__tests__/connection.test.ts` are the executable spec for all of the above.
