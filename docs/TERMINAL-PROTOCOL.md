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

## Authentication

Token auth, cookie sessions, origin allowlist, rate limiting. Schemas live in `packages/shared-types/src/auth.ts` (including `WS_CLOSE_UNAUTHORIZED = 4001`).

**Open mode:** when `GATEWAY_AUTH_TOKEN` is unset, auth and origin checks are fully disabled. The gateway refuses to start tokenless on a non-loopback `HOST` (`process.exit(1)`).

### Auth endpoints (no session cookie required)

| Method | Path               | Success                                                                                                  | Errors                                                                                                                                                 |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/auth/login`  | `204` + `Set-Cookie: gw_session=<sid>` (HttpOnly, SameSite=Strict, Path=/; +Secure when `TRUST_PROXY=1`) | `401` (invalid token) · `429` + `Retry-After` header (5 attempts/min/IP, fixed window) · `400` (malformed body / missing token) · `413` (body > 64 KB) |
| `POST` | `/api/auth/logout` | `204` (clears cookie)                                                                                    | --                                                                                                                                                     |
| `GET`  | `/api/auth/me`     | `200 { "authenticated": true }`                                                                          | `401 { "error": "unauthorized" }`                                                                                                                      |

All other `/api/*` routes require a valid `gw_session` cookie (or open mode) and return `401` without one.

### Origin allowlist

`ALLOWED_ORIGINS` env (comma-separated; default `http://localhost:3000,http://localhost:3007`). Checked on:

- **WS upgrade** (`/attach`): disallowed or absent Origin -> `403` pre-handshake (raw `HTTP/1.1 403 Forbidden` on the socket, no WebSocket frame). Skipped in open mode.
- **Mutating REST** (`POST`/`DELETE` on `/api/*`): disallowed Origin header (when present) -> `403 { "error": "forbidden origin" }`. Skipped in open mode.

### WebSocket auth and limits

- **Unauthenticated `/attach`**: handshake completes, server sends a JSON error frame `{"type":"error","message":"unauthorized"}`, then closes with code **4001**. The client must treat 4001 as `noReconnect` -- do not backoff-retry against a 401.
- **Connection cap**: concurrent WS connections are capped at `MAX_WS_CONNECTIONS` (default 32). Over-cap connections receive a JSON error frame `{"type":"error","message":"too many connections"}` and close code **1013** (Try Again Later).
- **Body cap**: all HTTP request bodies are capped at 64 KB (`413` if exceeded).
- **Timeout guards**: `headersTimeout=30s`, `requestTimeout=60s`.

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
