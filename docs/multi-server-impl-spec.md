# Multi-server ("Connected Servers") — implementation spec (MVP)

> **Status: code-validated spec, contract FROZEN (2026-07-15).** Implements the
> **MVP** section of `docs/MULTI-SERVER-PLAN.md` only (Option C: SSH + remote
> tmux). "Later" items — agent `server` arg, key-gen UI, Option B hub-and-spoke
> — are explicitly out of scope. The shared-types contract below is already
> implemented in `packages/shared-types`; **BE and FE must not edit that
> package.** UX reference: `docs/multi-server-ux-spec.md`.

This spec is written against the real code (`server.js` is 1138 lines at time of
writing), not the plan's prose. Where the plan and the code diverge it is
flagged as a **[surprise]**.

---

## 0. The two exec seams (both must become `ssh <host> …`)

The gateway does tmux work in exactly two places; both are per-server:

1. **Control seam — `tmux(args)` / `tmuxStdin(args, input)`** at
   `apps/terminal-gateway/src/server.js:270-280`
   (`execFileAsync("tmux", args)`). Used by `sessionExists`, `createSession`,
   `listSessions`, capture-pane (`/scrollback`, `/screen`), send-keys/paste
   (`/keys`), and the one `kill-session` (DELETE).
2. **Attach seam — the WS `wss.on("connection")` handler** at
   `server.js:1003-1133`, specifically `ptySpawn("tmux", ["attach-session",
"-t", sessionName], …)` at `server.js:1059`. This is a **second seam NOT
   routed through `tmux()`** — it spawns node-pty directly.

Both must gain a per-server prefix. Introduce a single helper:

```js
// server.js — new. Returns argv for execFile/ptySpawn.
// local  => ["tmux", ...tmuxArgs]
// ssh    => ["ssh", ...sshOpts, host, "tmux", ...tmuxArgs]      (control)
//        => ["ssh", "-t", ...sshOpts, host, "tmux", ...tmuxArgs] (attach; -t for a pty)
function serverExecArgv(server, tmuxArgs, { tty = false } = {}) { … }
```

- `sshOpts` include `-p <port>`, `-i <identityFile>`, and the ControlMaster
  multiplexing flags (§6). `host` is `user@host` when `user` is set.
- Control commands call `execFileAsync(argv[0], argv.slice(1))`; the attach
  handler calls `ptySpawn(argv[0], argv.slice(1), {encoding:null, …})`.
- For `type:"local"`, `serverExecArgv` returns the bare `tmux …` argv — **zero
  behavior change for the single-server path.**

`tmuxStdin` (used by `/keys` load-buffer) must pipe stdin through the ssh child
the same way it does through the tmux child today (`promise.child.stdin.end`).

---

## Deliverable 1 — the qualified-id contract (FROZEN)

### Format & backward-compat rule

- **Canonical wire id:** `<serverId>/web-<uuid>` (always qualified, even for
  local — the target host is never implicit).
- **tmux name:** unchanged, `web-<uuid>`, still validated by
  `ID_RE = /^web-[A-Za-z0-9-]+$/`.
- **Backward-compat:** a bare `web-<uuid>` (no `/`) means `serverId = "local"`.
  Parsers accept it; formatters always emit the qualified form. Old
  `?session=web-…` bookmarks and any pre-multi-server client keep working.

### Canonical parse/format helper (single source of truth)

Implemented in `packages/shared-types/src/terminal.ts`, exported from
`index.ts`:

```ts
export const LOCAL_SERVER_ID = "local";
export interface SessionRef {
  serverId: string;
  tmuxName: string;
}
export function parseSessionRef(ref: string): SessionRef; // splits on FIRST "/"; no "/" => local
export function formatSessionRef(serverId: string, tmuxName: string): string; // always "<id>/<name>"
export function normalizeSessionRef(ref: string): string; // parse ∘ format — bare→qualified
```

**[surprise] The gateway cannot import shared-types at runtime.** `server.js`
is plain dependency-free ESM run by node directly; shared-types is `.ts`
resolved via a TS-aware loader only (this is exactly why `server.js` already
duplicates `AGENT_NAMED_KEYS` as a plain `Set`). **BE must re-implement
`parseSessionRef`/`formatSessionRef` as a few plain-JS lines in `server.js`,
with a comment pointing at the canonical shared-types copy.** FE and
agent-service import the real helper.

### Every id touchpoint traced, with the exact change

**Gateway (`server.js`):**

| #   | Location                                                                                                                 | Today                                                                                                                  | Change                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `handleApi` routing `server.js:482-513`                                                                                  | `parts = pathname.split("/")`; path params are bare `web-…`                                                            | For `/api/sessions/:ref/*`, `parts[2]` is `decodeURIComponent`-ed then `parseSessionRef`-ed → `{serverId, tmuxName}`. The `%2F` in the qualified id does **not** create an extra path segment, so all existing `parts.length === 3/4` checks stay correct. Look up `serverId` in the registry → the server record; 404 if unknown.                                           |
| 2   | `ID_RE.test(id)` guards in `/scrollback` (`:613`), `/screen` (`:662`), `/keys` (`:723`), PATCH (`:817`), DELETE (`:907`) | validates the whole path param                                                                                         | validate `tmuxName` (the parsed part) against `ID_RE`; validate `serverId` against the registry. Reject unknown server with 404.                                                                                                                                                                                                                                             |
| 3   | `sessionExists(name)` `server.js:282`                                                                                    | `tmux(["has-session","-t",name])`                                                                                      | `sessionExists(server, tmuxName)` → run over that server's exec argv.                                                                                                                                                                                                                                                                                                        |
| 4   | `createSession(id, cwd)` `server.js:294`                                                                                 | local `tmux new-session`                                                                                               | `createSession(server, tmuxName, cwd)`; run every `tmux …` through `serverExecArgv(server, …)`.                                                                                                                                                                                                                                                                              |
| 5   | POST `/api/sessions` `server.js:521-590`                                                                                 | ignores server; returns `{id:"web-…"}`                                                                                 | read `body.serverId ?? "local"`, validate against registry (400 if unknown); create on that server; return `id = formatSessionRef(serverId, tmuxName)`, `serverId`.                                                                                                                                                                                                          |
| 6   | `listSessions()` `server.js:314-353`                                                                                     | one local `tmux ls`; `metadata.pruneToExisting(liveIds)`                                                               | iterate **all registered servers** (§Deliverable 2). Per-server `tmux ls` over its exec argv, **error-isolated**. Each session `id = formatSessionRef(serverId, name)`, plus `serverId` and `reachable:true`. Unreachable servers contribute last-known entries with `reachable:false`. **Prune metadata only within reachable servers' namespaces** (see [surprise] below). |
| 7   | `/scrollback` `:632`, `/screen` `:681-693`, `/keys` `:769/:775/:777/:803`                                                | `tmux([...,"-t",id])`                                                                                                  | `-t tmuxName`, run over the parsed server's exec argv.                                                                                                                                                                                                                                                                                                                       |
| 8   | DELETE `/api/sessions/:id` `:917` — the ONE kill                                                                         | `tmux(["kill-session","-t",id])`                                                                                       | `kill-session -t tmuxName` over the parsed server's exec argv. **Stays the single kill site.** `metadata.remove(qualifiedId)`.                                                                                                                                                                                                                                               |
| 9   | WS attach `server.js:1026-1064`                                                                                          | `sessionName = ?session` (bare); `ID_RE.test`; `sessionExists`; `ptySpawn("tmux",["attach-session","-t",sessionName])` | parse `?session` via `parseSessionRef`; validate serverId (registry) + tmuxName (`ID_RE`); `sessionExists(server, tmuxName)`; `ptySpawn(...serverExecArgv(server, ["attach-session","-t",tmuxName], {tty:true}))`. On unknown server / ssh spawn failure, send `{type:"error"}` then close (the client reconnect loop in `connection.ts` already handles this shape).        |

**[surprise] `?server=` param is NOT used.** The plan offered "a `?server=`
param on `/attach`" as an alternative. We instead carry the **qualified id in
the existing `session` param** — `connection.ts:94` already does
`?session=${encodeURIComponent(this.sessionId)}`, and `encodeURIComponent` turns
`local/web-…` into `local%2Fweb-…`, which `url.searchParams.get("session")`
decodes back cleanly. This means **`connection.ts` needs no change** beyond
`sessionId` now being the qualified id. One seam, not two.

**[surprise] metadata prune must become per-server.** `metadata.js` keys records
by session id and `pruneToExisting(liveIds)` drops any key not in `liveIds`
(`metadata.js:74`). With multi-server, `listSessions` only sees live ids from
_reachable_ servers; a global prune would wipe metadata (name/org/project) for
every session on an unreachable server. **BE must:** (a) key metadata by the
**qualified id** (`local/web-…`; migrate bare keys as local on load), and
(b) prune only within the namespaces of servers that actually responded —
pass the reachable-server set, never prune an unreachable server's namespace.
The sidecar thereby doubles as the "last-known" cache that feeds the
`reachable:false` entries.

**Frontend:**

| Location                                     | Change                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-fallback.ts` `resolveActiveSession` | Compare by qualified id (already string-equality on `s.id`). No structural change — BUT the list now contains unreachable sessions (`reachable:false`), which keeps the active id valid instead of falling back. **Additionally the caller must filter nothing** — do not drop `reachable:false` rows before this runs, or a flaky link falls back the active session. |
| `store.ts` `activeSessionId`                 | Now holds the qualified id. No type change (still `string \| null`). Persisted value from a pre-multi-server session is bare → normalize on read (below).                                                                                                                                                                                                              |
| `use-session-url-sync.ts` `:36-37`           | On mount, `setActiveSessionId(normalizeSessionRef(fromUrl))` so a bare `?session=web-…` bookmark matches the now-qualified list ids. Write path (`:43`) unchanged (writes the qualified id).                                                                                                                                                                           |
| `connection.ts` `:94`                        | No change — passes `this.sessionId` (qualified) through `encodeURIComponent`. Confirm `sessionId` is sourced from the qualified `activeSessionId`.                                                                                                                                                                                                                     |
| `use-sessions.ts`                            | No change to fetch/parse (Zod schema is backward-compatible). Row keys/DELETE/PATCH already `encodeURIComponent(id)` — qualified id round-trips as a single path segment.                                                                                                                                                                                              |

**[surprise] There is no frontend `pruneToExisting`/`upsert`.** The task
description implied a store-side prune; in reality the frontend "prune" is
entirely (a) the sidebar rendering whatever `useSessions` (TanStack Query,
`refetchInterval:3000`) returns, and (b) `resolveActiveSession` falling the
active id back when it's absent from the list. So **the wire contract keeping
unreachable sessions in the list (Deliverable 2) is the whole protection** — no
store prune logic to change, only the "don't filter `reachable:false` rows out"
rule above and the URL normalization.

**Agent-service — confirmed no changes for MVP, nothing breaks:**

- `gateway-client.ts` `listSessions`/`readScreen`/`sendKeys`/`createSession`
  pass `sessionId` opaquely and already `encodeURIComponent` it
  (`:125,:133`) → qualified ids round-trip.
- `tools.ts`: `list_sessions` returns `s.id` (now qualified) to the model; the
  model echoes it back to `read_screen`/`type_text`/etc.; the gateway parses.
  `create_session` sends no `serverId` → implicit `"local"` (correct: the
  `server` arg is a "Later" item). No `serverId` field is added to any tool.
- **Confirmed:** with the implicit-`local` default, every agent path works
  against a qualified-id gateway with zero code change.

---

## Deliverable 2 — "unreachable ≠ dead": the frozen wire representation

**Decision:** `GET /api/sessions` stays a **flat array** (top-level shape
unchanged, backward-compatible). Each entry gains `serverId` and `reachable`.
A **reachable** server contributes its live `tmux ls` rows (`reachable:true`).
An **unreachable** server contributes its **last-known rows reconstructed from
the metadata sidecar** (`reachable:false`) — they are **never omitted and never
pruned**. Per-server reachability is _also_ authoritatively exposed by
`GET /api/servers`, so the FE can grey a whole group header even if that server
had no known sessions.

**Why this shape:** last-known sessions must not vanish on a flaky link (that
would strand `resolveActiveSession` and blank the sidebar). The sidecar already
persists name/org/project keyed by id, so it is the natural "last-known" source;
`reachable:false` is the single bit the FE needs to render greyed
(`bg-muted-foreground`) without treating it as destructive. `attached`,
`currentCommand`, and `lastActivity` are unknowable while unreachable → the
gateway sends `attached:false`, `currentCommand:""`, `lastActivity:null` for
those rows (the FE keys its greying off `reachable`, not these).

### `GET /api/sessions` — mixed reachable/unreachable example

```json
[
  {
    "id": "local/web-1a2b",
    "name": "build",
    "createdAt": 1720000000000,
    "tags": [],
    "currentCommand": "pnpm",
    "attached": true,
    "attachedClients": 1,
    "lastActivity": 1720000500,
    "org": "acme",
    "project": "web",
    "serverId": "local",
    "reachable": true
  },
  {
    "id": "build01/web-9f8e",
    "name": "long-running-job",
    "createdAt": 1719990000000,
    "tags": [],
    "currentCommand": "",
    "attached": false,
    "attachedClients": 0,
    "lastActivity": null,
    "org": null,
    "project": null,
    "serverId": "build01",
    "reachable": false
  }
]
```

### `GET /api/servers`

```json
[
  {
    "id": "local",
    "name": "This machine",
    "type": "local",
    "reachability": "ok",
    "lastProbeAt": null
  },
  {
    "id": "build01",
    "name": "Build server",
    "type": "ssh",
    "host": "10.0.0.12",
    "user": "deploy",
    "port": 22,
    "reachability": "unreachable",
    "lastProbeAt": 1720000600000
  }
]
```

- `identityFile` is **omitted** from the response (no MVP edit UI; not a secret,
  but no reason to expose). `local` is always first and always `reachability:"ok"`.
- Reachability is a **cached** `ssh <host> true` probe (TTL, e.g. 10–15 s), so
  the 3 s session poll doesn't fire an ssh probe per server per tick.

### FE prune-logic change (contract the FE must honor)

- **Never filter or prune `reachable:false` rows** before `resolveActiveSession`
  or before rendering. They render greyed with an "unreachable" affordance
  (`bg-muted-foreground`, never destructive-red).
- Group-header status dot: drive off `GET /api/servers` `reachability`
  (`ok` → normal, `unreachable` → grey). This lets a server with zero known
  sessions still show as a greyed, present group.

### Other server endpoints (frozen)

- `POST /api/servers` — body `CreateServerRequest`; 201 → `ServerInfo`. `type`
  is forced to `"ssh"` (you cannot add `local`). Behind the existing cookie auth
  - Origin check like all state-changing REST.
- `DELETE /api/servers/:id` — 204; `local` is 400 (undeletable).
- `POST /api/servers/test` — body `CreateServerRequest` (probe **without**
  saving, for the dialog's "Test connection"); 200 → `TestServerResponse`
  `{reachability, error?}`. (`POST /api/servers/:id/test` may also be offered
  for an already-saved server; same response shape.)

---

## Deliverable 3 — shared-types (DONE, frozen)

`pnpm --filter @sparklab/shared-types typecheck` → **passes** (no `build`
script; `typecheck` = `tsc --noEmit`).

Added to `packages/shared-types/src/terminal.ts` (+ re-exported from `index.ts`):

- **Qualified-id helpers:** `LOCAL_SERVER_ID`, `SessionRef` (interface),
  `parseSessionRef`, `formatSessionRef`, `normalizeSessionRef`.
- **Server registry:** `ServerIdSchema`/`ServerId`,
  `ServerTypeSchema`/`ServerType` (`"local"|"ssh"`),
  `ServerReachabilitySchema`/`ServerReachability` (`"ok"|"unreachable"`),
  `ServerInfoSchema`/`ServerInfo`, `ListServersResponseSchema`/
  `ListServersResponse`, `CreateServerRequestSchema`/`CreateServerRequest`,
  `CreateServerResponseSchema`/`CreateServerResponse`,
  `TestServerRequestSchema`/`TestServerRequest`,
  `TestServerResponseSchema`/`TestServerResponse`.
- **Extended (all additions optional — backward-compatible, mirroring the
  `org`/`project` precedent):** `CreateSessionRequest.serverId?`;
  `CreateSessionResponse.serverId?`; `SessionInfo.serverId?` +
  `SessionInfo.reachable?`.

No existing field changed type. Only field _values_ change (`id` now qualified);
the Zod schema stays `z.string()`.

---

## Deliverable 4 — file-by-file work split (disjoint directories)

BE works entirely under `apps/terminal-gateway/`; FE entirely under
`apps/terminal/`. **Disjoint — safe to run concurrently.** Neither edits
`packages/shared-types` (frozen) or `apps/agent-service` (no MVP change).

### Backend (BE) — `apps/terminal-gateway/`

- [ ] `src/registry.js` (new): load/persist `servers.json` next to `.env`
      (atomic write like `metadata.js`); always inject the `local` entry;
      `list()`, `get(id)`, `add(entry)`, `remove(id)`. Validate ids
      (no `/`, unique). Key-based ssh only; never store passwords.
- [ ] `src/server.js` — add plain-JS `parseSessionRef`/`formatSessionRef`
      (comment: canonical copy in shared-types) and `serverExecArgv(server,
    tmuxArgs, {tty})` with ControlMaster/ControlPersist flags (§6).
- [ ] `src/server.js` — thread `(serverId, tmuxName)` through both exec seams
      and all six REST handlers per the Deliverable-1 table (control seam +
      WS-attach pty spawn).
- [ ] `src/server.js` `listSessions()` — iterate all servers, per-server
      error isolation, reachable-probe cache, emit `serverId`+`reachable`,
      reconstruct unreachable servers' last-known rows from the sidecar.
- [ ] `src/metadata.js` — key by qualified id; migrate bare keys→local on load;
      `pruneToExisting` scoped to the reachable-server set only.
- [ ] `src/server.js` `handleApi` — new routes: `GET /api/servers`,
      `POST /api/servers`, `DELETE /api/servers/:id`, `POST /api/servers/test`
      (auth + Origin guards like existing CRUD).
- [ ] `.env.example` — document ControlPersist / known_hosts expectations;
      note `servers.json` location (do **not** touch `.env`).
- [ ] `test/acceptance-multi-server.*` (new): "job on a remote keeps counting
      while the gateway restarts", using a second tmux server on a separate
      socket (`tmux -L`) reached via localhost ssh — per the plan's MVP
      acceptance. Wire a `pnpm --filter @sparklab/terminal-gateway`
      script for it.

### Frontend (FE) — `apps/terminal/`

- [ ] `src/features/terminal/hooks/use-servers.ts` (new): TanStack Query for
      `GET /api/servers` + mutations for POST/DELETE/test.
- [ ] `src/features/terminal/hooks/use-session-url-sync.ts`: normalize the
      mount-read value with `normalizeSessionRef`.
- [ ] `src/features/terminal/session-fallback.ts` / its caller in
      `components/terminal-shell.tsx`: do not filter `reachable:false` rows;
      confirm qualified-id equality holds end-to-end.
- [ ] `src/features/terminal/grouping.ts` + `components/session-sidebar.tsx`:
      top-level grouping by server (header row + status dot from
      `reachability`), then the existing org→project tree beneath; greyed
      `reachable:false` rows (`bg-muted-foreground`, never destructive-red);
      per-server "New session" passing `serverId`.
- [ ] `src/features/terminal/hooks/use-sessions.ts`: `CreateSessionParams`
      gains `serverId?`; forward it in the POST body.
- [ ] Add-server dialog + Servers settings tab (`?settings=servers`): add
      `"servers"` to `SETTINGS_SECTIONS` in `store.ts`; build the form (name,
      host, user, port, key path) with a "Test connection" button hitting
      `POST /api/servers/test`.
- [ ] `connection.ts`: verify `sessionId` is the qualified `activeSessionId`
      (no code change expected; confirm end-to-end).

---

## 6. SSH multiplexing (wire it, don't over-engineer)

Add to every ssh invocation (control + attach):

```
-o ControlMaster=auto
-o ControlPath=<gateway-runtime-dir>/cm-%r@%h:%p
-o ControlPersist=60s
-o StrictHostKeyChecking=accept-new
```

so all execs and the attach reuse one TCP+auth handshake per server. **Note:**
localhost-ssh testing (the acceptance harness) won't exercise real latency, so
don't tune timeouts against it — just confirm the flags are present and the
socket is created. Per-server error isolation (a dead host must never fail the
whole `GET /api/sessions`) is mandatory from day one.

---

## 7. Password auth (added — departure from key-only original plan)

**What changed:** the original plan said "key-based only, no stored passwords."
At implementation, per-server password auth was added as an opt-in for hosts
that only allow password login. This section documents the final wire/code
contract.

### Mechanism — OpenSSH askpass (NOT sshpass)

`sshpass` is not universally installed and passes the secret on the command
line (visible to `ps`). Instead the gateway uses OpenSSH's built-in askpass
protocol:

1. At gateway startup a helper script is written to
   `$TMPDIR/gw-ssh-cm/askpass.sh` (same directory as the ControlMaster
   sockets, mode `0700`). Its content:
   ```sh
   #!/bin/sh
   printf '%s\n' "$GW_SSH_PASSWORD"
   ```
2. Every ssh child (control exec AND the WS-attach pty spawn) for a
   password-auth server receives two extra env vars — via `sshEnvFor()` /
   `childEnvFor()`, never in argv:
   - `SSH_ASKPASS` — the path to the helper above.
   - `SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4) — forces askpass even with a
     controlling terminal (which node-pty provides for the attach path).
   - `GW_SSH_PASSWORD` — the plaintext password from the server record.
3. `sshOptsFor()` switches to `BatchMode=no` + `PreferredAuthentications=password`
   - `PubkeyAuthentication=no` + `NumberOfPasswordPrompts=1` when a password is
     set, so ssh goes straight to the askpass helper in a single attempt.
4. After the first successful connect the ControlMaster socket carries all
   subsequent execs and the WS-attach pty, so the password is only consumed
   once per server per `ControlPersist` window (60 s).

Key-based servers are completely unaffected: their `sshOptsFor()` keeps
`BatchMode=yes`, no askpass env is injected, and the `identityFile` / `-i`
flag is still added when set.

### Wire contract (`GET /api/servers`)

- `ServerInfo.authMethod`: `"key"` or `"password"` — indicates which method is
  configured. The password itself is **never returned** in any response.
- `CreateServerRequest.password`: optional string. When present and non-empty
  the gateway stores it in `servers.json` and uses password auth for that
  server. When absent (or empty) the server is key-based.
- `CreateServerResponse` is the `ServerInfo` shape — includes `authMethod`,
  never `password`.

### Storage

The password is stored **plaintext in `servers.json`** (gitignored, gateway
host only). The `registry.js` `sanitize()` function reads it on load and
`list()` / `get()` return it in the internal server record (used by
`childEnvFor` on the gateway), but the `GET /api/servers` response builder
strips it before serializing to JSON. The `add()` function in `registry.js`
persists it via `persist()` (atomic rename). There is no encryption at rest;
the gitignored file is the only access control.

### `shellQuote` remote-arg fix (bug also fixed in this workstream)

When tmux args are passed over ssh, sshd runs them through a remote shell that
re-splits on whitespace and interprets metacharacters. A `-F "#{a}\t#{b}"`
format string (spaces/tabs), a `send-keys` text arg, or a path with spaces
would have broken silently. `shellQuote(arg)` wraps each token in POSIX
single-quotes (escaping embedded single-quotes as `'\''`) before joining into
the remote command string. The local path is unchanged (execFile receives
argv directly, no shell expansion).

### Test

`apps/terminal-gateway/test/servers-password-auth.js` (npm script
`test:servers-password`) asserts:

- Password is stored in `servers.json` after `POST /api/servers`.
- `GET /api/servers` does NOT return the password field.
- `authMethod` is reported as `"password"`.
- The connect is non-interactive (no prompt needed).
- Live login (optional): gated on `GW_TEST_SSH_HOST` + `GW_TEST_SSH_PASSWORD`
  env vars; skipped when absent.
