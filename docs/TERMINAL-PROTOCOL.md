# Terminal wire protocol

The gateway (`apps/terminal-gateway/src/server.js`) is the source of truth; the Zod schemas in `packages/shared-types/src/terminal.ts` mirror it exactly and are what the frontend validates against. **Change server and schemas together.**

## REST API

Base path: `/api/sessions` on the gateway (default `http://localhost:3007`). In the browser these calls go through the Next.js rewrite proxy, so they are same-origin; the gateway itself sends no CORS headers (deliberate).

### `GET /api/sessions` → 200

Returns `SessionInfo[]`:

```json
[
  {
    "id": "local/web-6f2c…", // qualified as <serverId>/web-<UUID>
    "name": "my-session",
    "createdAt": 1752444000000, // epoch ms; nullable
    "tags": [], // reserved for future use
    "currentCommand": "bash", // command in the active pane
    "attached": true, // ≥1 tmux client attached
    "attachedClients": 1, // optional: count of attached tmux clients
    "lastActivity": 1752444000, // optional: last activity, epoch SECONDS (not ms)
    "org": "Sparklab", // optional/nullable organization metadata
    "project": "terminal", // optional/nullable; requires org
    "muted": false, // suppress job notifications
    "serverId": "local",
    "reachable": true, // whether the server answered this poll
    "alive": true // whether this tmux session exists
  }
]
```

`attachedClients` and `lastActivity` are optional in the schema (Phase 3 B2) so older gateways still validate; the UI shows a viewers badge when `attachedClients > 0`, else an idle-time badge from `lastActivity`.

`reachable` and `alive` are independent, backward-compatible status fields
(absence means `true`):

- `reachable:true, alive:true` is a live tmux session.
- `reachable:false` is a last-known row from an unreachable server. Its tmux
  state is unknown, so it must not be treated as ended or pruned.
- `reachable:true, alive:false` is a persisted **ended-session placeholder**:
  the server answered, but tmux no longer contains the metadata-tracked
  session (for example after a host reboot or an out-of-band kill). It remains
  in the list until explicit deletion. Runtime-only fields are empty/false and
  the push poll ignores the row.

This distinction is load-bearing: network failure must not masquerade as
process death, and process death must not silently remove the user's session
entry.

### `POST /api/sessions` → 201

Create a session. Body (all fields optional):

```json
{
  "name": "my-session",
  "cwd": "/home/me/project",
  "org": "Sparklab",
  "project": "terminal",
  "serverId": "local"
}
```

Response: `{ "id": "local/web-…", "name": "…", "createdAt": 1752444000000, "serverId": "local" }`

### `GET /api/sessions/:id/scrollback?lines=N` → 200

Captures the session's scrollback history via `tmux capture-pane -p -e -J -S -<N> -E -1` — ANSI escapes preserved (`-e`), wrapped lines joined (`-J`), and the visible screen excluded (`-E -1`): the response is history **only**. `lines` clamps to 1–10000, default 2000 (non-numeric values fall back to the default). Read-only; no state. Auth-guarded like all `/api/*`.

Response: `{ "lines": "<ANSI-colored text>" }` (`ScrollbackResponseSchema`). Unknown or malformed id → 404.

**Client sequencing contract** (`connection.ts`): the fetch starts before the WS opens. On the first binary frame after (re)connect the client calls `term.reset()`, writes the fetched history (trimmed by the last `term.rows` lines to reduce duplication with the redraw), **then** writes the frame — tmux's attach redraw stays the single painter of the visible screen and pushes the injected history into xterm's scrollback buffer. If the first frame beats the fetch, attach proceeds without history (accepted race).

### `GET /api/sessions/:id/git` → 200

Read-only VCS summary of the session's **current working directory**, for the mini footer below the terminal. Resolves the cwd via `tmux display-message -p '#{pane_current_path}'` (same as fs/list), then runs one `git -C <cwd> status --porcelain=v2 --branch` through the non-tmux exec seam (`serverCmd`, local or ssh — reusing the ControlMaster socket). An 8s timeout guards against a slow/huge repo stalling the poll. Scoped to the **active session only** — deliberately NOT folded into `GET /api/sessions`, which would run `git status` for every session on every server every 3s. Read-only; no state. Auth-guarded like all `/api/*`; GET is origin-exempt (matching scrollback).

Response: `GitStatusResponseSchema`. When the cwd is not inside a git work tree (git exits 128, "not a git repository") the body is just `{ "isRepo": false }` and the footer renders nothing. Otherwise: `{ isRepo:true, branch, detached, ahead, behind, staged, unstaged, untracked, conflicted, changed }`. `branch` is the branch name, or the short oid on a detached HEAD (`detached:true`). `ahead`/`behind` come from `# branch.ab` (0 with no upstream). The per-bucket counts classify porcelain-v2 entry lines (`1`/`2` by the two-char XY field, `u` = conflicted, `?` = untracked) and **may overlap** (a file both staged and unstaged increments both); `changed` counts each entry line once (distinct changed files). Unknown/malformed id → 404. Tested by `test/git-endpoints.js` (`pnpm --filter @sparklab/terminal-gateway test:git`).

### `POST /api/sessions/:id/codex` → 200 / 400 / 503 / 504

Runs the **Codex CLI** as an agent tool. Resolves the session cwd (via `tmux display-message -p '#{pane_current_path}'`, same as fs/list and git) and runs `codex exec -C <cwd> --sandbox <mode> --skip-git-repo-check --color never -` on the session's own server through the non-tmux exec seam (`serverCmdStdin`, local or ssh — reusing the ControlMaster socket). The gateway stays the single enforcement point: it never runs Codex any other way.

Request body: `CodexRunRequestSchema` — `{ prompt, mode? }`. `prompt` (1–16384 chars) is piped via **stdin** (never argv, so the remote shell can't split it and it isn't in `ps`). `mode` is clamped to `read-only` (default, no file changes) or `workspace-write` (**writes** confined to the cwd); any other value (incl. `danger-full-access`) → `400`. Empty/missing prompt → `400`. The `--dangerously-bypass-*` flags are never emitted, and Codex is given no network. The sandbox governs writes/exec, **not read scope** — `-C <cwd>` sets the working root, not a read jail, so Codex can still read files the user can read outside the cwd (per-call approval is the control; treat output like any command output). On Linux/WSL2, the host that spawns Codex needs the `bubblewrap` (`bwrap`) distribution package for `workspace-write`; install it independently on every remote server. See [Getting started](GETTING-STARTED.md#codex-workspace-write-on-linux--wsl2). Codex's own auth lives in its `CODEX_HOME`; the child runs with a curated env and receives no gateway secrets. For local sessions, the trusted agent-service may pass its `AZURE_OPENAI_*` configuration in internal HTTP headers; the values are injected only into the Codex child environment and never placed in the request JSON or command argv. Remote sessions deliberately do not forward these values through SSH and must use credentials configured on the remote host.

Response: `CodexRunResponseSchema` — `{ mode, cwd, exitCode, output, truncated, durationMs }`. Returned with `200` even when Codex exits non-zero (so the agent can read the failure + code); `output` is combined stdout+stderr capped at 128 KB. Distinct transport errors: the binary missing → `503 { code:"codex_unavailable" }`; exceeding `CODEX_TIMEOUT_MS` (default 180s) → `504 { code:"codex_timeout" }`. Auth-guarded like all `/api/*`; the `POST` gets the Origin/CSRF check. Overridable via `CODEX_COMMAND` (a JSON array or plain path — used by tests to point at a stub). Unknown/malformed id → `404`. Invocation is **approved on every call** in the agent (a write tool; see `docs/AGENT-PROTOCOL.md`). Tested by `test/codex-endpoints.js` (`pnpm --filter @sparklab/terminal-gateway test:codex`).

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

### Scheduled terminal actions: `/api/terminal-actions`

One-shot, persisted delayed input for Agent Chat. These routes are authenticated
and mutating calls receive the standard Origin/CSRF check. The store is
`data/scheduled-terminal-actions.json` (override with
`SCHEDULED_TERMINAL_ACTIONS_FILE`) and is atomically rewritten on every state
transition.

- `POST /api/terminal-actions` accepts a `keys` action
  `{ "sessionId", "keys", "executeAt" }`, or an `input` action
  `{ "kind":"input", "sessionId", "text", "keys", "executeAt" }`.
  Both use the same 1–32 item named-key whitelist as `POST /keys`. Input text
  is a 1–4096 character single literal line, is typed before the keys, and is
  rejected unless `SCHEDULED_TERMINAL_ACTIONS_KEY` is configured as a base64
  32-byte key. The gateway AES-256-GCM encrypts it at rest and never returns it
  from the create or list response. `executeAt` must be a timezone-qualified
  ISO-8601 instant between one second and one year in the future. The target
  session must exist when the action is created. Returns `201` with the
  persisted action.
- `GET /api/terminal-actions` returns `{ "actions": [...] }`, including each
  action's `scheduled` / `executing` / `executed` / `failed` / `cancelled`
  status and any error.
- `DELETE /api/terminal-actions/:id` cancels only a still-`scheduled` action;
  an action that is executing or finished returns `404`.

The gateway checks due actions once per second, claims and persists each action
as `executing` before it injects its text (if any) and invokes `tmux send-keys`,
then records `executed` or `failed`. A missing session at fire time fails the action. If the gateway
crashes after claiming but before sending, the action is deliberately not
replayed: a lost delayed input is safer than a duplicate consequential key
press.

### `DELETE /api/sessions/:id` → 204

For a live session, kills tmux and removes its metadata; this remains the
**only** user-session path that runs `tmux kill-session`. For an ended-session
placeholder (`alive:false`), removes metadata only because no tmux process
exists. Deletion refuses to infer death while the server is unreachable. No
response body.

### Web Push endpoints: `/api/push/*`

Backs the "your job finished" notifications (full design in `docs/PUSH-NOTIFICATIONS-PLAN.md`). All three require auth like any `/api/*` route; the two `POST`s are state-changing and get the Origin/CSRF check automatically, the `GET` is origin-exempt (matching scrollback/git). Schemas: `PushSubscribeRequest`, `PushUnsubscribeRequest`, `VapidPublicKeyResponse`, `PushSubscribeResponse` in `packages/shared-types/src/terminal.ts`.

When VAPID keys are absent the feature is **not configured**: the gateway still boots and behaves identically, `GET vapid-public-key` reports `configured:false`, and `subscribe` returns `503`.

#### `GET /api/push/vapid-public-key` → 200

`{ "configured": true, "publicKey": "<base64url>" }` when VAPID is configured, else `{ "configured": false }` (no key). The client needs `publicKey` as the `applicationServerKey` for `pushManager.subscribe`.

#### `POST /api/push/subscribe` → 201 / 503

Body is a browser `PushSubscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`). Stored in the gitignored sidecar `push-subscriptions.json` (atomic write, deduped by `endpoint` — re-subscribe replaces). Returns `{ ok: true, count }`. `503` when push is not configured; `400` on a malformed subscription. The first stored subscription starts the poll loop.

#### `POST /api/push/unsubscribe` → 200

Body `{ endpoint }`. Removes that subscription (idempotent — `200` even if absent). Returns `{ ok: true, count }`. Removing the last subscription stops the poll loop.

#### `GET /api/push/settings` → 200 · `PUT /api/push/settings` → 200

Global push preferences (single-user), stored in the gitignored `push-settings.json` sidecar. Shape: `{ minDurationMs: number (0..86400000, default 30000), notifyOnStart: boolean (default false) }`. `GET` is auth-only (Origin-exempt); `PUT` is auth + Origin/CSRF-guarded (`PUT` is in the state-changing guard set) and accepts a **partial** patch (absent fields unchanged; bad types → `400`). `minDurationMs` gates the "finished" notification on job duration; `notifyOnStart` enables the one-time "still running after threshold" alert.

**`muted` on `PATCH /api/sessions/:id`.** The session PATCH additionally accepts `muted:boolean` (alongside name/org/project), persisted to the `sessions.json` sidecar and echoed in the response; `GET /api/sessions` rows carry `muted`. A muted session is skipped in the poll loop (server-side enforcement).

**Poll loop + SW push contract.** While ≥1 subscription exists AND VAPID is configured, the gateway polls `listSessions()` every `PUSH_POLL_INTERVAL_MS` (default 4s; env-overridable). Per reachable, live session it tracks `pane_current_command` (`""` = unknown, never a trigger) and times a job on shell→non-shell. Unreachable and `alive:false` rows are skipped, so an out-of-band tmux death cannot produce a false "job finished" push:

- **Finish** (non-shell→shell): unless the session is `muted` or the duration is below `minDurationMs`, it sends a Web Push (a `404`/`410` prunes the endpoint). The first poll after any (re)start only baselines and notifies nothing.
- **Still-running** (opt-in `notifyOnStart`): one alert when a timed job crosses `minDurationMs` while still running.

Payload is **generic** — `{ title, body, sessionId, tag, durationMs?, exitCode? }`, session name + status only, **never command output**. `title` is "✓ Job finished" / "✗ Job failed (exit N)" when the exit code is known (bash/zsh gateway-created sessions; captured via a session-scoped `@web_last_exit` shell hook), else neutral "Job finished". `exitCode`/`durationMs` are present only when known.

The service worker's `push` handler **always** calls `showNotification` — the ONE exception is a permission-safe omit when a focused, visible client already shows that `?session=<id>` (visible-client relaxation). It attaches `actions: [open, dismiss-all]` (sliced to `Notification.maxActions`; Chromium/Android only — iOS ignores them). `notificationclick`: `dismiss-all` closes all notifications; `open`/default focuses/opens the app at `?session=<id>`.

#### `POST /api/push/hook-notify` → 202 / 200 / 400 / 401 / 503

A **second, independent** push signal source for interactive `claude`/`codex` CLI sessions, closing the gap where the poll loop above stays silent for an entire session (no shell transition between turns). Full design record and install guide: `docs/HOOK-NOTIFICATIONS-SETUP.md`.

Auth is a **dedicated** bearer token, `HOOK_NOTIFY_TOKEN` — checked by its own predicate (`isHookNotifyAuthorized`), scoped to exactly this route, never folded into the broader `GATEWAY_API_TOKEN`/`KANBAN_API_TOKEN` artifact-bearer allowlist. No token configured → `401` always (feature inert). `503` when push is not configured (same as `subscribe`).

Body: `{ session: string, tool: "claude"|"codex", kind: "turn-finished"|"waiting-input", eventId?: string, detail?: string }`. `session` is a bare tmux name (or qualified `<serverId>/<tmuxName>`) — malformed/oversized fields, or an unknown `tool`/`kind` enum, → `400`. `detail` (≤64 chars) is accepted for logging/observability only and is **never** echoed into the push payload.

Session resolution is **fail-closed**, not a metadata trust: dead-session metadata persists indefinitely (`GET /api/sessions` can return `alive:false` rows forever), so the gateway confirms **liveness** with a targeted `tmux has-session` per metadata candidate matching the given name — zero live matches or more than one both return `200 { ok:false, reason:"unknown_session"|"ambiguous_session" }`, never a guess.

On a resolved session: `muted` (from the same `sessions.json` field as the poll loop) suppresses with `200 { ok:false, reason:"muted" }`; `minDurationMs`/`notifyOnStart` do **not** apply here (per-turn granularity is the point). Idempotent — `eventId` dedupes for 10 min (`200 { ok:false, reason:"duplicate" }` on repeat); absent `eventId` falls back to a 2s same-kind cooldown. A per-session rate limit (20/min) returns `200 { ok:false, reason:"rate_limited" }` beyond that. Success is `202 { ok:true, sessionId }`.

Payload is built from a **fixed template** plus the session's own name/org/project (user-assigned labels from `sessions.json`, never CLI content) — e.g. `{ title: "Claude finished", body: "Claude finished responding — my-session (work/backend).", sessionId, tag: "hook-<sessionId>" }`. No caller-supplied text (including `detail`) ever reaches the encrypted payload.

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

### Kanban endpoints: `/api/kanban/*`

A gateway-owned, multi-board task tracker (design: [`KANBAN-PLAN.md`](./KANBAN-PLAN.md)). State lives in a `data/kanban.json` sidecar (`src/kanban.js`, atomic write; every mutator is synchronous so a read-modify-write is atomic — no mutex, same as `registry.js`). **Ordering authority is `Column.cardIds[]` only** — a card's `columnId` is derived on GET and never persisted. Each board carries a monotonic `rev` for optimistic concurrency. Schemas: the `Kanban*` block in `packages/shared-types/src/terminal.ts`.

Auth: the existing `gw_session` cookie **or** a scoped `Authorization: Bearer <KANBAN_API_TOKEN>` (this prefix only — lets an external AI CLI drive boards without a cookie login; a CLI request carries no `Origin`, so the CSRF guard is a no-op for it). GET routes are Origin-exempt; state-changing routes get the Origin/CSRF check.

An MCP-server wrapper (dependency-free stdio) lives at `tools/kanban-mcp/` — it exposes these endpoints as MCP tools for Claude Code / Codex via the bearer token. See `tools/kanban-mcp/README.md` for the `claude mcp add` / `~/.codex/config.toml` setup.

#### `GET /api/kanban/boards` → 200

`{ "boards": KanbanBoardSummary[] }` where a summary is `{id,name,tags,rev,createdAt,updatedAt,columnCount,cardCount}`.

#### `GET /api/kanban/boards/:boardId` → 200

Full `KanbanBoard`: `{id,name,tags,rev,createdAt,updatedAt, columns:[{id,name,cardIds[]}], cards:[{id,title,description,tags,columnId,createdAt,updatedAt}]}`. Unknown board → `404`.

#### `POST /api/kanban/boards` → 201

Body (`CreateBoardRequest`): `{name, tags?, columns?}`. Omitting `columns` seeds Backlog / To Do / In Progress / Done. Returns the created board.

#### `PATCH /api/kanban/boards/:boardId` → 200

Body (`UpdateBoardRequest`): `{name?, tags?}` (at least one). Returns the board.

#### `DELETE /api/kanban/boards/:boardId` → 204

#### `POST /api/kanban/boards/:boardId/cards` → 201

Body (`CreateCardRequest`): `{title, description?, tags?, columnId?}` — defaults to the first column. Returns the created card (with its derived `columnId`).

#### `PATCH /api/kanban/cards/:cardId` → 200

Body (`UpdateCardRequest`): `{boardId, title?, description?, tags?}` (at least one field beyond `boardId`).

#### `POST /api/kanban/cards/:cardId/move` → 200 / 409

Body (`MoveCardRequest`): `{boardId, toColumnId, toIndex, rev}`. Splices the card out of whichever column holds it and into the target at the clamped index — exactly one write. A stale `rev` → `409 { "error": "stale", "board": <current board> }` so the client can reconcile and retry with the fresh `rev`. Unknown card/column → `404`.

#### `DELETE /api/kanban/cards/:cardId?boardId=<id>` → 204

`boardId` via query string or JSON body.

### Notes endpoints: `/api/notes/*`

A gateway-owned, OneNote-style hierarchical note tool (design:
[`NOTES-TOOL-PLAN.md`](./NOTES-TOOL-PLAN.md)), a **separate** artifact from
Kanban/PM. Notebook → Section → Page, each page a Markdown document, with
optional subpages (`parentId`). Storage is **split** (D2, unlike Kanban's
single whole-file rewrite): the tree — notebooks, sections, page metadata, and
the ordering arrays — lives in `data/notes.json` (`src/notes.js`, atomic
write, synchronous mutators ⇒ atomic, no mutex); each page **body** is one
`data/notes-pages/<pageId>.md` file, also written atomically. `load()` sweeps
any `.md` no longer referenced by the tree (crash-safety: create writes the
body then splices the tree; delete splices the tree then unlinks the body —
either order leaves at worst a harmless orphan file, never a dangling tree
reference). **Ordering authority (D5) is `Section.pageIds[]` only** — a page's
`sectionId` and indent `depth` are derived on GET and never persisted;
`parentId` is a pure containment/indent edge, not an order. Moving a page
moves its whole subtree contiguously.

**Two independent revisions (D3)**: `page.rev` bumps only on that page's
title/body change (`PATCH /api/notes/pages/:id`); `notebook.rev` bumps on any
structural change — section add/rename/reorder/delete, page add/move/delete
(`sections/:id/move`, `pages/:id/move`). A page-body edit never conflicts with
an unrelated structural move, and vice versa. **A page-body 409 is surfaced,
never auto-retried** (D4) — unlike a structural move, which callers MAY retry
once, a body `PATCH` is a blind overwrite and a silent retry against a fresh
`rev` would discard whatever the other writer just saved.

Auth: the existing `gw_session` cookie **or** the shared artifact bearer
(`GATEWAY_API_TOKEN`, legacy `KANBAN_API_TOKEN` fallback — same token already
used by `/api/kanban/*` and `/api/pm/*`, no new token needed). GET routes are
Origin-exempt; state-changing routes get the Origin/CSRF check.

An MCP-server wrapper (dependency-free stdio) lives at `tools/notes-mcp/` — it
exposes these endpoints as MCP tools for Claude Code / Codex via the bearer
token. See `tools/notes-mcp/README.md` for the `claude mcp add` /
`~/.codex/config.toml` setup.

#### `GET /api/notes/notebooks` → 200

`{ "notebooks": NotesNotebookSummary[] }` where a summary is
`{id,name,tags,rev,updatedAt,sectionCount,pageCount}`.

#### `GET /api/notes/notebooks/:nbId` → 200

Full `NotesNotebook`: `{id,name,tags,rev,createdAt,updatedAt, sections:[{id,name,pageIds[],createdAt,updatedAt}], pages:[{id,title,tags,parentId,rev,createdAt,updatedAt,sectionId,depth}]}` — `pages` is a **flat** array in render order (section order, then each section's `pageIds` order); `sectionId`/`depth` are derived, never persisted. No bodies. Unknown notebook → `404`.

#### `GET /api/notes/notebooks/:nbId/pages/:pageId` → 200

`NotesPageContent` — the page's tree metadata plus its Markdown `body` (read
from the `.md` file) and current `rev`. Unknown notebook/page → `404`.

#### `GET /api/notes/search?q=…&limit=…` → 200

`{ "results": NotesSearchHit[] }` — case-insensitive substring over titles and
bodies (`{notebookId,notebookName,sectionId,pageId,title,snippet}`); `limit`
defaults to 20, clamped 1–100; an empty `q` returns no results.

#### `POST /api/notes/notebooks` → 201

Body (`CreateNotebookRequest`): `{name, tags?}`. Seeds one section "Notes" +
one empty "Untitled page" (OneNote-like first open). Returns the created
notebook.

#### `PATCH /api/notes/notebooks/:nbId` → 200

Body (`UpdateNotebookRequest`): `{name?, tags?}` (at least one). Returns the
notebook (structural `rev` bumped).

#### `DELETE /api/notes/notebooks/:nbId` → 204

Deletes the notebook and every page body in it.

#### `POST /api/notes/notebooks/:nbId/sections` → 201

Body (`CreateSectionRequest`): `{name}`. Appended at the end. Returns the
notebook.

#### `PATCH /api/notes/sections/:secId` → 200

Body (`UpdateSectionRequest`): `{notebookId, name}`. Returns the notebook.

#### `POST /api/notes/sections/:secId/move` → 200 / 409

Body (`MoveSectionRequest`): `{notebookId, toIndex, rev}` — `rev` is the
**notebook** revision. A stale `rev` → `409 { "error": "stale", "notebook": <current notebook> }`.

#### `DELETE /api/notes/sections/:secId?notebookId=<id>&mode=<block|cascade>` → 204 / 422

`notebookId` and `mode` via query string or JSON body. `mode:"block"`
(default) rejects a non-empty section with `422 { "error": "..." }`;
`mode:"cascade"` deletes the section and every page (+ body) in it.

#### `POST /api/notes/notebooks/:nbId/pages` → 201

Body (`CreatePageRequest`): `{sectionId, title?, parentId?, body?}`. When
`parentId` is set the page joins the parent's section automatically (an
explicit conflicting `sectionId` → `400`); a `parentId` cycle → `400`. Returns
the created `NotesPageContent`.

#### `PATCH /api/notes/pages/:pageId` → 200 / 409

Body (`UpdatePageRequest`): `{notebookId, title?, body?, tags?, rev}` (at
least one of `title`/`body`/`tags`; `rev` is **required** — the **page**
revision). A stale `rev` → `409 { "error": "stale", "page": <current page, body included> }`.
**Never auto-retried by any client** (D4) — the caller must show the conflict
and let a human decide to reload or explicitly overwrite with the fresh `rev`.

#### `POST /api/notes/pages/:pageId/append` → 200

Body (`AppendPageRequest`): `{notebookId, markdown}`. Server-atomic: appends
`"\n\n"+markdown` to the existing body and bumps `page.rev`. **No `rev`
required** — additive, cannot clobber a concurrent edit.

#### `POST /api/notes/pages/:pageId/move` → 200 / 409 / 400

Body (`MovePageRequest`): `{notebookId, toSectionId, toIndex, toParentId?, rev}`
— `rev` is the **notebook** revision. The page and its whole subtree move as
one contiguous run (D5). A stale `rev` → `409 { "error": "stale", "notebook": <current notebook> }`;
a `toParentId` that would create a cycle → `400`.

#### `DELETE /api/notes/pages/:pageId?notebookId=<id>&mode=<orphan|cascade>` → 204

`notebookId` and `mode` via query string or JSON body. `mode:"orphan"`
(default) promotes the deleted page's children to its own parent (their
bodies survive); `mode:"cascade"` deletes the whole subtree (+ bodies).

Errors: `400` malformed/validation/cycle, `401` unauthorized, `403` forbidden
origin, `404` unknown notebook/section/page, `409` `stale` (+ the current
`page`/`notebook`), `422` a non-empty `block`-mode section delete, `413` body
too large.

### Project-management endpoints: `/api/pm/*`

A Kanban-first PM suite (design: [`PM-TOOL-PLAN.md`](./PM-TOOL-PLAN.md), extended by [`PM-ARTIFACT-ENHANCEMENTS-PLAN.md`](./PM-ARTIFACT-ENHANCEMENTS-PLAN.md) — **implemented**, 2026-07-28), a **separate** artifact from Kanban. State in `data/pm.json` (`src/pm.js`, synchronous mutators ⇒ atomic, no mutex) plus a **separate collaboration sidecar** `src/pm-collab.js` (append-only JSONL for comments/activity + attachment blobs + a bounded notification JSON — never inline in `pm.json`, so comment/attachment volume never bloats the whole-file rewrite). Like Kanban: `Column.taskIds[]` is the sole ordering/status authority (`columnId` derived on GET). Auth: cookie **or** the shared bearer (`GATEWAY_API_TOKEN` / legacy `KANBAN_API_TOKEN`). GET Origin-exempt; writes Origin/CSRF-checked. Schemas: the `Pm*` block in `shared-types/src/terminal.ts`.

**Issue model**: each task carries a derived issue **key** (`project.key` + a per-project monotonic `number`, e.g. `PAY-43`; `key`/`number` are the authority, the string is never persisted), a `type` (`epic|story|task|bug|subtask`, default `task`), a `reporter` (the creating actor — see Actors below), a `parentId` (containment edge, separate from `dependsOn`; enforced against a fixed matrix: Epic has no parent, Story/Task/Bug may parent under an Epic or be root, Subtask **requires** a parent that is a Story/Task/Bug — max depth 3), and `watchers[]` (auto-populated: reporter + assignee + commenters). Assignee stays a **single** field (multi-assignee was evaluated and deliberately deferred — watchers cover "involve others"). Deleting a task **orphans** its children (`parentId→null`; an orphaned Subtask is promoted to `type:"task"` since a parentless Subtask is invalid) and scrubs the id from every other task's `dependsOn` **and** `parentId`.

**Actors**: there is no multi-user login; a small advisory `actorOf(req)` labels "who did this" for `reporter`/comment `author`/activity `actor` — `user:<GATEWAY_AUTH_USER>` for a cookie session, `client:<X-PM-Actor header>` or `client:bearer` for the scoped bearer. This is **not** a trust boundary (auth is still the cookie/bearer itself), just a label.

**Custom columns / WIP / transitions**: columns are no longer fixed after project creation. A column carries an optional `wipLimit` (int ≥1 or `null`) and `transitions` (allowed destination column ids, or `null` = unrestricted). Moving a task **cross-column** into an at-limit column, or to a destination not in the source's `transitions`, is rejected — see the error-code table below. Same-column reorder is exempt from both checks. Deleting a non-empty column requires `mode=relocate&toColumnId=` (splices its tasks onto the target) or is blocked (`mode=block`, the default); the last remaining column can't be deleted.

**Collaboration**: comments (edit = new record same id, delete = tombstone; append-only, never rewritten in place), an append-only project **activity/audit log** (every mutating action — task/column CRUD, comments, attachments, watch/unwatch — emits one record `{id,ts,actor,verb,target:{type,id},taskId?,summary}`; `taskId` is carried explicitly so sub-resource-scoped verbs like `attached`/`detached` — whose `target` points at the attachment, not the task — can still be filtered per-task), attachments (opaque on-disk blob name, original filename is metadata-only so path traversal is structurally impossible; size-capped, `nosniff` on download), and **in-app notifications** (durable primary channel, recipient = watchers minus the acting actor; **Web Push is best-effort only** — if configured via `push.js`, a bare `{projectId,taskId,summary}` payload is sent, **never** a comment body, and a push failure is swallowed and never rolls back the triggering mutation).

| Method + route                                      | Body                                                                                                                                        | Result                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/pm/projects`                              | —                                                                                                                                           | `{projects: PmProjectSummary[]}`                                                                  |
| `GET /api/pm/projects/:id`                          | —                                                                                                                                           | full `PmProject` (columns[+wipLimit/transitions], sprints, tasks[+derived columnId/key]); 404     |
| `GET /api/pm/projects/:id/tree`                     | —                                                                                                                                           | derived Epic→Story→Subtask forest; 404 unknown project                                            |
| `POST /api/pm/projects`                             | `{name, key?, tags?, columns?}`                                                                                                             | 201 project (key derived-unique from name if omitted; explicit collision → 409 `key_taken`)       |
| `PATCH /api/pm/projects/:id`                        | `{name?, key?, tags?}`                                                                                                                      | 200 project                                                                                       |
| `DELETE /api/pm/projects/:id`                       | —                                                                                                                                           | 204 (cascades: purges all comments/activity/attachments for the project)                          |
| `POST /api/pm/projects/:id/tasks`                   | `{title, description?, type?, assignee?, reporter?, priority?, labels?, startDate?, dueDate?, sprintId?, parentId?, columnId?, dependsOn?}` | 201 task; hierarchy violation → **422** `{error, reason}`                                         |
| `PATCH /api/pm/tasks/:id`                           | `{projectId, …field, type?, parentId?, dependsOn?}`                                                                                         | 200 task; **cycle/hierarchy → 400/422**                                                           |
| `POST /api/pm/tasks/:id/move`                       | `{projectId, toColumnId, toIndex, rev}`                                                                                                     | 200 project / **409** `{error:"stale", project}` / **422** `wip_exceeded`\|`transition_forbidden` |
| `DELETE /api/pm/tasks/:id?projectId=`               | —                                                                                                                                           | 204 (scrubs `dependsOn`+`parentId`; cascades: purges the task's comments/attachments)             |
| `POST /api/pm/projects/:id/sprints`                 | `{name, startDate?, endDate?}`                                                                                                              | 201 sprint                                                                                        |
| `PATCH /api/pm/sprints/:id`                         | `{projectId, name?, startDate?, endDate?}`                                                                                                  | 200 sprint                                                                                        |
| `DELETE /api/pm/sprints/:id?projectId=`             | —                                                                                                                                           | 204 (affected tasks → `sprintId:null`)                                                            |
| `POST /api/pm/projects/:id/columns`                 | `{name, index?, wipLimit?, transitions?}`                                                                                                   | 201 project                                                                                       |
| `PATCH /api/pm/columns/:colId`                      | `{projectId, name?, wipLimit?, transitions?}`                                                                                               | 200 project                                                                                       |
| `POST /api/pm/columns/:colId/move`                  | `{projectId, toIndex, rev}`                                                                                                                 | 200 project / **409** `{error:"stale", project}`                                                  |
| `DELETE /api/pm/columns/:colId?…mode=&toColumnId=`  | —                                                                                                                                           | 204 / **409** `column_not_empty` / **400** `last_column`                                          |
| `GET/POST /api/pm/tasks/:id/comments?projectId=`    | `{body}` (POST)                                                                                                                             | 201 comment / `{comments:[...]}`                                                                  |
| `PATCH/DELETE /api/pm/comments/:id`                 | `{projectId, taskId, body?}`                                                                                                                | 200 comment / 204 tombstone                                                                       |
| `GET /api/pm/projects/:id/activity?limit=&before=`  | —                                                                                                                                           | `{activity:[...]}` (reverse-chronological)                                                        |
| `GET/POST /api/pm/tasks/:id/attachments?projectId=` | raw bytes (POST, `X-Filename`/`Content-Type` headers, NOT JSON)                                                                             | 201 metadata / **413** over cap / `{attachments:[...]}`                                           |
| `GET/DELETE /api/pm/attachments/:id?projectId=`     | —                                                                                                                                           | stream w/ `Content-Disposition`+`nosniff` / 204                                                   |
| `POST /api/pm/tasks/:id/watch\|unwatch?projectId=`  | —                                                                                                                                           | 200 task (idempotent — safe to call redundantly)                                                  |
| `GET /api/pm/notifications?unread=1`                | —                                                                                                                                           | `{notifications:[...]}` for the calling actor                                                     |
| `POST /api/pm/notifications/read`                   | `{ids?, all?}`                                                                                                                              | 200 `{updated:N}`                                                                                 |

Priority ∈ `low|medium|high|urgent`; type ∈ `epic|story|task|bug|subtask`; dates are epoch ms (day-level) or null. Task/column `move` are `rev`-guarded (409 on stale — the **only** code the agent retries, once); **422** (`wip_exceeded`, `transition_forbidden`, `hierarchy_invalid`) is a distinct, deliberately non-retried rejection class — see [`AGENT-PROTOCOL.md`](./AGENT-PROTOCOL.md). Field/dependency/sprint/comment/column-rename edits are last-writer-wins (v1). An MCP wrapper lives at `tools/pm-mcp/` (see its README) mirroring every read/write tool below.

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
