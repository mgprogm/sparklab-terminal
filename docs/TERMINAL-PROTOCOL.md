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
    "attached": true, // ≥1 tmux client attached
    "attachedClients": 1, // optional: count of attached tmux clients
    "lastActivity": 1752444000 // optional: last activity, epoch SECONDS (not ms)
  }
]
```

`attachedClients` and `lastActivity` are optional in the schema (Phase 3 B2) so older gateways still validate; the UI shows a viewers badge when `attachedClients > 0`, else an idle-time badge from `lastActivity`.

### `POST /api/sessions` → 201

Create a session. Body (all fields optional):

```json
{ "name": "my-session", "cwd": "/home/me/project" }
```

Response: `{ "id": "web-…", "name": "…", "createdAt": 1752444000000 }`

### `GET /api/sessions/:id/scrollback?lines=N` → 200

Captures the session's scrollback history via `tmux capture-pane -p -e -J -S -<N> -E -1` — ANSI escapes preserved (`-e`), wrapped lines joined (`-J`), and the visible screen excluded (`-E -1`): the response is history **only**. `lines` clamps to 1–10000, default 2000 (non-numeric values fall back to the default). Read-only; no state. Auth-guarded like all `/api/*`.

Response: `{ "lines": "<ANSI-colored text>" }` (`ScrollbackResponseSchema`). Unknown or malformed id → 404.

**Client sequencing contract** (`connection.ts`): the fetch starts before the WS opens. On the first binary frame after (re)connect the client calls `term.reset()`, writes the fetched history (trimmed by the last `term.rows` lines to reduce duplication with the redraw), **then** writes the frame — tmux's attach redraw stays the single painter of the visible screen and pushes the injected history into xterm's scrollback buffer. If the first frame beats the fetch, attach proceeds without history (accepted race).

### `GET /api/sessions/:id/git` → 200

Read-only VCS summary of the session's **current working directory**, for the mini footer below the terminal. Resolves the cwd via `tmux display-message -p '#{pane_current_path}'` (same as fs/list), then runs one `git -C <cwd> status --porcelain=v2 --branch` through the non-tmux exec seam (`serverCmd`, local or ssh — reusing the ControlMaster socket). An 8s timeout guards against a slow/huge repo stalling the poll. Scoped to the **active session only** — deliberately NOT folded into `GET /api/sessions`, which would run `git status` for every session on every server every 3s. Read-only; no state. Auth-guarded like all `/api/*`; GET is origin-exempt (matching scrollback).

Response: `GitStatusResponseSchema`. When the cwd is not inside a git work tree (git exits 128, "not a git repository") the body is just `{ "isRepo": false }` and the footer renders nothing. Otherwise: `{ isRepo:true, branch, detached, ahead, behind, staged, unstaged, untracked, conflicted, changed }`. `branch` is the branch name, or the short oid on a detached HEAD (`detached:true`). `ahead`/`behind` come from `# branch.ab` (0 with no upstream). The per-bucket counts classify porcelain-v2 entry lines (`1`/`2` by the two-char XY field, `u` = conflicted, `?` = untracked) and **may overlap** (a file both staged and unstaged increments both); `changed` counts each entry line once (distinct changed files). Unknown/malformed id → 404. Tested by `test/git-endpoints.js` (`pnpm --filter @sparklab/terminal-gateway test:git`).

### `GET /api/sessions/:id/screen?history=N` → 200

Agent-facing, read-only **plain-text** capture of the visible screen (deliberately no `-e` — this feeds an LLM, not a terminal) via `tmux capture-pane -p -J`, plus cursor/size/mode metadata from one `tmux display-message` call. `history` clamps to 0–2000, default 0 (visible screen only; non-numeric values fall back to the default); when > 0 the capture also includes up to N lines of scrollback above the visible screen (`-S -N`). Auth-guarded like all `/api/*`.

Response (`ScreenResponseSchema`):

```json
{
  "screen": "plain text, wrapped lines joined",
  "cursor": { "x": 0, "y": 3 }, // 0-based col/row in the visible pane
  "size": { "cols": 80, "rows": 24 },
  "altScreen": false, // true inside vim/htop/less (alternate screen)
  "currentCommand": "bash" // command in the active pane
}
```

Unknown or malformed id → 404.

### `POST /api/sessions/:id/keys` → 204

Agent-facing input injection (`SendKeysRequestSchema`). The body is exactly **one** of two shapes:

- `{ "text": "echo hi" }` (1–10000 chars) — typed **literally** and guaranteed to never execute: no implicit Enter. Single-line text ≤ 200 chars goes through `tmux send-keys -l --`; longer or multiline text is staged with `tmux load-buffer` and delivered via `tmux paste-buffer -d -p` (**bracketed paste**), so embedded newlines arrive as a paste, not as typed commands.
- `{ "keys": ["Enter"] }` (1–32 items) — named keys sent via `tmux send-keys` (no `-l`). Every item must be in the whitelist (`AgentNamedKeySchema`, duplicated as a plain Set in the gateway): `Enter Escape Tab Space BSpace Up Down Left Right Home End PageUp PageDown DC C-c C-d C-z C-l C-u C-r`. Anything else → 400 before tmux is touched.

Executing a command is therefore always two explicit calls: `{text}` then `{keys:["Enter"]}`. Success: `204` (no body). Unknown session → 404; both-or-neither shape, out-of-range lengths, or a non-whitelisted key → 400. Origin-checked like all mutating REST. This endpoint only ever sends input — it can never kill a session.

### `DELETE /api/sessions/:id` → 204

Kills the tmux session (the **only** place `tmux kill-session` is ever run). No body either way.

### Web Push endpoints: `/api/push/*`

Backs the "your job finished" notifications (full design in `docs/PUSH-NOTIFICATIONS-PLAN.md`). All three require auth like any `/api/*` route; the two `POST`s are state-changing and get the Origin/CSRF check automatically, the `GET` is origin-exempt (matching scrollback/git). Schemas: `PushSubscribeRequest`, `PushUnsubscribeRequest`, `VapidPublicKeyResponse`, `PushSubscribeResponse` in `packages/shared-types/src/terminal.ts`.

When VAPID keys are absent the feature is **not configured**: the gateway still boots and behaves identically, `GET vapid-public-key` reports `configured:false`, and `subscribe` returns `503`.

#### `GET /api/push/vapid-public-key` → 200

`{ "configured": true, "publicKey": "<base64url>" }` when VAPID is configured, else `{ "configured": false }` (no key). The client needs `publicKey` as the `applicationServerKey` for `pushManager.subscribe`.

#### `POST /api/push/subscribe` → 201 / 503

Body is a browser `PushSubscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`). Stored in the gitignored sidecar `push-subscriptions.json` (atomic write, deduped by `endpoint` — re-subscribe replaces). Returns `{ ok: true, count }`. `503` when push is not configured; `400` on a malformed subscription. The first stored subscription starts the poll loop.

#### `POST /api/push/unsubscribe` → 200

Body `{ endpoint }`. Removes that subscription (idempotent — `200` even if absent). Returns `{ ok: true, count }`. Removing the last subscription stops the poll loop.

**Poll loop + SW push contract.** While ≥1 subscription exists AND VAPID is configured, the gateway polls `listSessions()` every ~4s. On a session's `pane_current_command` transitioning from a real non-shell command to a shell (reachable rows only; `""` is treated as unknown, never a trigger), it sends a Web Push to every stored subscription; a `404`/`410` from the push service prunes that endpoint. The first poll after any (re)start only establishes a baseline and notifies nothing. The payload is **generic** — `{ title, body, sessionId, tag }`, session name only, never command output. The service worker's `push` handler **always** calls `showNotification` (silent pushes get permission revoked on iOS/Chrome); `notificationclick` focuses/opens the app at `?session=<id>`.

### File-explorer endpoints: `GET|POST|PATCH|DELETE /api/sessions/:id/fs/*`

Six routes that browse and manage the filesystem of whichever server the session lives on (local or a registered remote over SSH). Every route runs the standard `parseSessionRef` + `ID_RE` + `registry.get` + `sessionExists` guard — unknown or malformed session id → `404` on all of them. The underlying commands go through the non-tmux exec seam `serverCmdArgv`/`serverCmd`/`serverCmdStdin` (siblings of `serverExecArgv`, added alongside these routes). Schemas for all request/response shapes live in `packages/shared-types/src/terminal.ts` (`FsEntry`, `FsListResponse`, `FsReadResponse`, `FsMkdirRequest/Response`, `FsRenameRequest/Response`, `FsDeleteResponse`, `FsUploadResponse`).

**Origin/CSRF gating** follows the same split as all other `/api/*` routes: GET requests are origin-exempt (matching scrollback); POST, PATCH, and DELETE get the Origin check automatically via `handleApi`.

**Load-bearing safety invariant:** every path is **one shell-quoted argv token** — never string-concatenated into a command. Every command terminates option parsing with `--`. Directory listings use NUL-delimited `find -printf` records so filenames containing spaces, quotes, or newlines survive the round trip intact.

#### `GET /api/sessions/:id/fs/list?path=<abs>&showHidden=0` → 200

Lists one directory. `path` omitted → gateway resolves the session cwd via `tmux display-message -p '#{pane_current_path}'` and lists that. `path` must be an absolute string if supplied, else `400`. `showHidden=1` includes dotfiles (default omits them). Listing is capped at 5000 entries; `truncated: true` when exceeded.

Response (`FsListResponse`):

```json
{
  "path": "/home/me/project",
  "entries": [
    {
      "name": "src",
      "type": "dir",
      "size": 4096,
      "mtime": 1752444000000,
      "mode": "755"
    },
    {
      "name": "README.md",
      "type": "file",
      "size": 1234,
      "mtime": 1752444000000,
      "mode": "644"
    }
  ],
  "truncated": false
}
```

`mtime` is Unix epoch **milliseconds** (find's `%T@` seconds × 1000). `type` is one of `"file" | "dir" | "symlink" | "other"`; symlinks carry an additional `symlinkTarget` string. `size` is the entry's own byte size. Not-a-dir or nonexistent `path` → `404`; permission denied → `403`; else `502`.

#### `GET /api/sessions/:id/fs/read?path=<abs>` → 200

Text preview of a file, capped at **256 KB**. Binary detection: a NUL byte anywhere in the read buffer → `binary: true`, `content` omitted (client should offer Download instead). Bytes read > cap → `truncated: true`, content is the first 256 KB.

Response (`FsReadResponse`):

```json
{
  "path": "/home/me/project/README.md",
  "size": 1234,
  "binary": false,
  "truncated": false,
  "encoding": "utf-8",
  "content": "# Project…"
}
```

Binary files: `{ "path": "…", "size": 4096000, "binary": true, "truncated": false, "encoding": null }` (no `content`). Not found → `404`; permission denied → `403`.

#### `GET /api/sessions/:id/fs/download?path=<abs>` → 200

Streams the file as raw bytes — no 256 KB cap. Response headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<basename>"`. The gateway pipes the child-process (or SSH) stdout directly to the HTTP response without buffering, so large binaries and remote files are safe. Not found → `404`.

#### `POST /api/sessions/:id/fs/upload?path=<abs-dest-file>` → 200

Streams the **raw request body** to the destination path via `tee -- <path>` (overwrites). Bypasses the normal 64 KB body cap; enforces a separate **8 MB upload cap** — excess → `413`. Response (`FsUploadResponse`):

```json
{ "path": "/home/me/project/data.bin", "size": 4096000 }
```

Permission denied → `403`; else `502`.

#### `POST /api/sessions/:id/fs/mkdir` → 201

Creates a single directory (no `-p`; parent must exist). Body (`FsMkdirRequest`): `{ "path": "/home/me/project/newdir" }`. Directory already exists → `409`. Response (`FsMkdirResponse`): `{ "path": "…" }`. Permission denied → `403`.

#### `PATCH /api/sessions/:id/fs/entry` → 200

Rename or move an entry. Body (`FsRenameRequest`): `{ "from": "/home/me/a", "to": "/home/me/b", "overwrite": false }`. `to` already exists and `overwrite` is falsy → `409`. Response (`FsRenameResponse`): `{ "from": "…", "to": "…" }`. Source not found → `404`; permission denied → `403`.

#### `DELETE /api/sessions/:id/fs/entry?path=<abs>&recursive=0` → 200

Deletes a file or directory. A non-empty directory requires `recursive=1` (client must show a strong confirm before setting this). Response (`FsDeleteResponse`): `{ "path": "…" }`. Not found → `404`; permission denied → `403`; non-empty dir without `recursive=1` → `502`.

### Errors (400 / 404 / 500)

Always `{ "error": "<message>" }`.

## Authentication

Token auth, cookie sessions, origin allowlist, rate limiting. Schemas live in `packages/shared-types/src/auth.ts` (including `WS_CLOSE_UNAUTHORIZED = 4001`).

**Open mode:** when no auth credentials (`GATEWAY_AUTH_USER` + `GATEWAY_AUTH_PASSWORD_HASH`/`GATEWAY_AUTH_PASSWORD`) are set, auth and origin checks are fully disabled. The gateway refuses to start credential-less on a non-loopback `HOST` (`process.exit(1)`).

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
3. **Reconnect resets before redraw; scrollback goes behind it, never on top.** The client sets a fresh-connect flag on every (re)connect and calls `term.reset()` on the _first binary frame_ after it, so tmux's attach redraw lands on a clean screen. Scrollback history is injected between the reset and that first frame (see the scrollback endpoint above) — tmux's redraw remains the single painter of the visible screen. Naive `capture-pane` replay _on top of_ the redraw remains forbidden — it double-draws.
4. **Frame-type routing.** Anything new on the wire follows the split above: binary = terminal I/O, JSON text = control. Never mix.
5. **One live connection per terminal.** The `Connection` class enforces single-live-connection semantics: a `noReconnect` guard blocks _both_ resurrection paths (onclose-backoff and heartbeat force-close), and supersession checks ignore events from a replaced socket. In React this pairs with StrictMode-safe effect cleanup so dev double-mount never yields two tmux clients.
6. **Multi-viewer sizing.** Sessions are created with `window-size latest` + `aggressive-resize on` so tmux follows the most recently active client (E2E gate 6).
7. **No CDN.** xterm.js and addons are npm dependencies bundled into the app (offline/CSP requirement). Never load terminal assets from an external origin.

## Client lifecycle (apps/terminal)

`features/terminal/connection.ts` implements, per session attach:

- **Scrollback fetch**: each `connect()` kicks off the scrollback fetch before opening the WS; the result is injected on the first binary frame (see the scrollback endpoint above).
- **Heartbeat**: periodic `{"type":"ping"}`; if no activity (pong or output) arrives in the window, the socket is force-closed, which routes into the reconnect path.
- **Reconnect backoff**: 1s → 2s → 4s → 8s → 15s (capped), reset on successful connect.
- **`dispose()`** clears all timers/handlers and sets `noReconnect` — after dispose, nothing can resurrect the socket.
- **Session switching** swaps the `Connection` on the same xterm `Terminal` instance (never remounts the terminal component).

The unit tests in `apps/terminal/src/features/terminal/__tests__/connection.test.ts` are the executable spec for all of the above.
