# Kanban Board (pluggable HTML artifact) — Design & Implementation Plan

> Status: **implemented** (2026-07-27) via a role-based agent loop (BE/FE/SA/QA).
> Green: shared-types + agent-service + terminal typechecks; agent-service tests
> (53); gateway `test:kanban` (16 checks incl. move-splice, rev/409, concurrent
> writes, CSRF, bearer); a **live headless Chromium smoke** of `app.html` (create
> board + add card + move-via-dropdown, DOM + API asserted, zero console errors) —
> PASS. Two refinements landed vs the original draft
> below: (a) no write-mutex — every store mutator is synchronous so it is already
> atomic (registry.js-style); `rev` handles cross-client staleness. (b) `cards` is
> an ARRAY in the wire shape (with derived `columnId`), not the map sketched in §2.
> Interaction is **click-to-move via dropdown** (v1 choice), not drag-and-drop.
>
> Scope: a multi-board Kanban
> for software-development task tracking, owned end-to-end by the **gateway** (a new
> `kanban.json` sidecar + `/api/kanban/*` REST). The board **UI is a self-contained
> HTML artifact** loaded into a modal in the terminal web app via a same-origin
> sandboxed `<iframe>` — "pluggable" = the modal is a thin host seam that points an
> iframe at a swappable HTML document; swap the file, swap the artifact. The same REST
> API is callable by (a) the in-app agent (`apps/agent-service` tools) and (b) an
> external AI CLI (Claude/Codex) over plain HTTP.

A Kanban board is a set of ordered columns (Backlog → To Do → In Progress → Done by
default) holding cards. The feature ships **multi-board** (each board has a project
`name` + `tags`), a REST CRUD+move API, agent tools, and one embedded HTML board UI.
The five load-bearing operations the user named — **create, delete, move, list, get** —
are the API contract; everything else is in service of them.

---

## 0. Grounding (verified against source)

Every decision below anchors to an existing pattern in the repo (mirrors, not invents):

- **Sidecar store**: `apps/terminal-gateway/src/registry.js` (`servers.json`) and
  `src/metadata.js` (`data/sessions.json`) — module-level `store`, `load()` at module
  bottom, atomic `persist()` = `writeFileSync(TMP)` + `renameSync(TMP, FILE)`, missing/
  corrupt file → empty store (never crash), test override via env (`SERVERS_FILE`).
- **Routes**: `apps/terminal-gateway/src/server.js` — `handleApi(req,res,url)` is a flat
  if-ladder on `req.method` + `url.pathname.split("/").filter(Boolean)`. Origin/CSRF
  guard at top (`server.js:1385`) runs **only** for `POST/DELETE/PATCH/PUT` **and only
  when an `Origin` header is present**; `isAuthenticated(req)` gate (`server.js` ~1395)
  runs next. GET is Origin-exempt by not being in the method list. `readBody` caps at
  64 KB (`BODY_LIMIT`), `sendJson(res,code,obj)` writes JSON, 204 = bare
  `writeHead(204); end()`. Representative handler: `POST /api/servers` (`server.js:1640`).
- **Agent tools**: `apps/agent-service/src/tools.ts` — OpenAI `ChatCompletionTool[]`
  (`TOOLS`), `WRITE_TOOLS: Set<string>` gates approval, `describeCall()` produces the
  approval-card summary (a case per tool), `executeTool()` switch runs after approval and
  clamps dangerous input. Gateway calls go through `gateway-client.ts` singleton `gateway`
  (`call()` injects `gw_session` cookie + `origin` header on non-GET, one 401 re-login).
- **Shared types**: `packages/shared-types/src/terminal.ts` — `export const XSchema =
z.object({...})` + `export type X = z.infer<typeof XSchema>`, re-exported from
  `src/index.ts` in a grouped block with a comment banner.
- **Frontend proxy**: `apps/terminal/next.config.ts` rewrites `/api/:path*` →
  `${NEXT_PUBLIC_GATEWAY_URL}/api/:path*`, so the browser (and any same-origin iframe)
  reaches the gateway same-origin, carrying the app-origin `gw_session` cookie. **Verified.**
- **Modal**: `components/file-explorer-dialog.tsx` (controlled `open`/`onOpenChange`,
  `@sparklab/ui` `Dialog*`, lucide icons `size-3.5`), opened from `terminal-shell.tsx`
  (ghost icon `Button` + `Tooltip`), flag in `store.ts` (ephemeral, NOT persisted),
  URL-synced via `useUrlFlagSync("explorer", …)`.

---

## 1. Architectural decisions (settled before implementation)

**D1 — Ownership: the gateway, not agent-service.** Kanban state is gateway-owned
(like sessions, servers, push): the browser reaches it same-origin via `/api`, the
gateway already enforces auth/Origin, and agent-service is an independent lifetime that
must not become the store of record. `agent-service` touches Kanban **only** as a REST
client (mirrors how it drives terminals), so the gateway stays the single enforcement
point.

**D2 — Storage: `data/kanban.json` sidecar, atomic write.** A new
`apps/terminal-gateway/src/kanban.js` sibling to `registry.js`/`metadata.js`. Lives under
`data/` (already `.gitignore`d wholesale) so no new gitignore entries are needed.
`KANBAN_FILE` env override for tests. No database — consistent with the repo's
"tmux/sidecars, no DB" ethos.

**D3 — Concurrency: single-writer serialization + per-board `rev` optimistic
concurrency.** This is the feature's crux: a human dragging a card while the in-app agent
**and** an external Codex CLI all call `move` on one file. Two independent mechanisms,
both required:

- **File integrity + no lost update in-process**: all `/api/kanban/*` **writes** run
  through a single in-process async mutex (a promise chain — `queue =
queue.then(work)`), so every read-modify-write-persist is atomic. Atomic rename
  alone (registry.js) prevents a _corrupt_ file but **not** an interleaved lost update;
  the mutex closes that gap.
- **Cross-client staleness**: every board carries a monotonic `rev` (integer, bumped on
  every mutation of that board). `move` (and other card mutations) accept the client's
  observed `rev`; a mismatch → **409 `stale`** with the current board so the client
  refetches and retries. This is what stops a drag based on a 10-second-old view from
  silently clobbering the agent's concurrent move.

**D4 — Single source of truth for ordering: `Column.cardIds[]` only.** A card record
carries **no** `columnId` and **no** `order` field — storing order twice guarantees
drift. The ordered `cardIds` array on each column is the sole authority; a card's column
is derived by scanning columns (boards are small). `GET` responses may _include_ a
derived `columnId` for consumer convenience, but it is never written.

**D5 — `move` is the crispest contract in the API.**
`POST /api/kanban/cards/:cardId/move` with body `{ boardId, toColumnId, toIndex, rev }`:

1. Load board; if `rev` ≠ board.rev → 409 `stale`.
2. Splice `cardId` out of whichever column's `cardIds` currently holds it (404 if none).
3. Clamp `toIndex` to `[0, target.cardIds.length]`; splice `cardId` in at `toIndex`.
4. Bump `board.rev`, set `updatedAt`, persist, return the full board.
   Moving within the same column is the same splice-out/splice-in (reorder). Exactly one
   write.

**D6 — "Pluggable" = one artifact behind one host seam, NOT a plugin framework.** The
board UI is a **single self-contained HTML file** at `apps/terminal/public/kanban/app.html`
(inline CSS+JS, zero external deps). A thin `KanbanDialog` renders
`<iframe src="/kanban/app.html" sandbox="allow-scripts allow-same-origin">`. Because the
iframe is same-origin to the Next app, its relative `fetch("/api/kanban/…")` calls carry
the app-origin `gw_session` cookie through the confirmed proxy — **no new auth surface,
no cross-origin, no CDN**. The "pluggable" property is delivered by this seam: point the
iframe at a different HTML file and you have a different artifact. A generalized
multi-artifact registry (host chrome, artifact manifest, tabs) is **explicitly deferred**
(§7) — building it now is gold-plating.

- **Honest note on `sandbox`**: `allow-scripts allow-same-origin` together provide
  essentially **no security boundary** (a same-origin frame can remove its own sandbox,
  and it is our own first-party code regardless). Its real value here is **DOM/CSS/JS
  isolation for pluggability** — the artifact can't collide with the app's global
  styles/scripts and vice-versa. We do not present it as a security control.

**D7 — Kanban is global (gateway-scoped), not session/server-scoped.** Boards are not
tied to a tmux session or a connected server; they are the gateway's own task tracker.
So the header button is always enabled (no "active session / reachable server" gate,
unlike file-explorer/git).

**D8 — External-AI access: bearer token alongside cookie auth (recommended).** The user
called external callability "important." Cookie-jar-after-login is clunky for a Codex/
Claude CLI. So `/api/kanban/*` (only this prefix) additionally accepts
`Authorization: Bearer <KANBAN_API_TOKEN>` when the env var is set. CLI requests carry no
`Origin` header, so the CSRF guard is a no-op for them (it only fires when Origin is
present) — the bearer token is the auth. If `KANBAN_API_TOKEN` is unset, only cookie auth
works and the external path is simply unavailable (documented, not a silent failure).

**D9 — Agent approval policy: a deliberate, justified divergence.** The repo gates all
`WRITE_TOOLS` on approval and _coerces_ the most dangerous (`browser_act`, `run_codex`)
to one-time (no allow-always). Per-call approval on **every** `kanban_move` would make the
agent useless for its primary job (shuffling its own task board). So:

- **Reads** (`kanban_list`, `kanban_get`) — not in `WRITE_TOOLS`, auto.
- **Routine writes** (`kanban_create`, `kanban_add_card`, `kanban_update_card`,
  `kanban_move`) — in `WRITE_TOOLS`, approved but **allow-always permitted** (low
  friction; the blast radius is a JSON file the user can trivially edit/undo).
- **Board delete** (`kanban_delete`) — in the coerced **one-time** set, like
  `run_codex`: deleting a whole board is destructive and must be confirmed each time.
  This uses the existing two-tier mechanism unchanged; it is a policy choice, documented
  so it reads as a decision, not an oversight.

---

## 2. Data model (`data/kanban.json`)

```jsonc
{
  "boards": {
    "kb-<uuid>": {
      "id": "kb-<uuid>",
      "name": "Checkout revamp", // the project name
      "tags": ["frontend", "q3"],
      "rev": 7, // D3: bumped on every mutation of THIS board
      "createdAt": 1750000000000,
      "updatedAt": 1750000500000,
      "columns": [
        {
          "id": "col-<uuid>",
          "name": "Backlog",
          "cardIds": ["card-a", "card-b"],
        },
        { "id": "col-<uuid>", "name": "To Do", "cardIds": [] },
        { "id": "col-<uuid>", "name": "In Progress", "cardIds": ["card-c"] },
        { "id": "col-<uuid>", "name": "Done", "cardIds": [] },
      ],
      "cards": {
        // map by id; NO columnId / NO order (D4)
        "card-a": {
          "id": "card-a",
          "title": "…",
          "description": "…",
          "tags": [],
          "createdAt": 1750000000000,
          "updatedAt": 1750000000000,
        },
      },
    },
  },
}
```

`kanban.js` API (all mutators persist; the **server** wraps them in the D3 mutex — the
module itself stays synchronous like registry.js): `load()`, `listBoards()` →
summaries `{id,name,tags,rev,updatedAt,columnCount,cardCount}`, `getBoard(id)` → full
board (+ derived `columnId` per card), `createBoard({name,tags,columns?})`,
`updateBoard(id,{name?,tags?})`, `deleteBoard(id)`, `createCard(boardId,{title,description?,
tags?,columnId?})` (defaults to first column), `updateCard(boardId,cardId,{…})`,
`moveCard(boardId,cardId,{toColumnId,toIndex})`, `deleteCard(boardId,cardId)`. Default
columns seeded on create when none supplied: Backlog / To Do / In Progress / Done.

---

## 3. Backend endpoints (`/api/kanban/*` in `server.js`)

Placed as new branches in `handleApi`. Reads GET (Origin-exempt); writes carry the
Origin/CSRF guard automatically. Auth = existing `gw_session` cookie **or** (D8) bearer
token — a small `isKanbanAuthorized(req)` helper checked at the top of the kanban branch,
falling through to the standard cookie gate. **The mutex (D3) wraps every write branch.**

### Read routes (GET — Origin-exempt)

| Route                             | Returns                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `GET /api/kanban/boards`          | `{ boards: BoardSummary[] }` — **list**                 |
| `GET /api/kanban/boards/:boardId` | `Board` (full, columns+cards) — **get**; 404 if unknown |

### Write routes (state-changing — Origin-checked + mutex-serialized)

| Route                                    | Body                                      | Result                                                   |
| ---------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `POST /api/kanban/boards`                | `{name, tags?, columns?}`                 | 201 `Board` — **create**                                 |
| `PATCH /api/kanban/boards/:boardId`      | `{name?, tags?}`                          | 200 `Board`                                              |
| `DELETE /api/kanban/boards/:boardId`     | —                                         | 204 — **delete**                                         |
| `POST /api/kanban/boards/:boardId/cards` | `{title, description?, tags?, columnId?}` | 201 `Card`                                               |
| `PATCH /api/kanban/cards/:cardId`        | `{boardId, title?, description?, tags?}`  | 200 `Card`                                               |
| `POST /api/kanban/cards/:cardId/move`    | `{boardId, toColumnId, toIndex, rev}`     | 200 `Board` — **move** (D5); 409 `stale` on rev mismatch |
| `DELETE /api/kanban/cards/:cardId`       | `{boardId}` (query or body)               | 204                                                      |

Errors: 400 malformed/validation, 401 unauthorized, 403 forbidden origin, 404 unknown
board/card/column, 409 `{error:"stale", board}` on rev mismatch, 413 body too large.

### Zod schemas — add to `packages/shared-types/src/terminal.ts`

`KanbanCardSchema`, `KanbanColumnSchema`, `KanbanBoardSchema`, `KanbanBoardSummarySchema`,
`KanbanListResponseSchema`, `CreateBoardRequestSchema`, `UpdateBoardRequestSchema`,
`CreateCardRequestSchema`, `UpdateCardRequestSchema`, `MoveCardRequestSchema`
(`{boardId, toColumnId, toIndex: z.number().int().min(0), rev: z.number().int()}`), plus
`type` aliases; re-export from `src/index.ts` under a `// REST: Kanban /api/kanban/*`
banner.

---

## 4. AI access

### 4a. In-app agent (`apps/agent-service/src/tools.ts` + `gateway-client.ts`)

Add `gateway-client.ts` methods (`listBoards`, `getBoard`, `createBoard`, `deleteBoard`,
`moveCard`, `addCard`, `updateCard`) using the existing `call()` primitive. Add tools:
`kanban_list`, `kanban_get`, `kanban_create`, `kanban_delete`, `kanban_move`,
`kanban_add_card`, `kanban_update_card`. Wire `WRITE_TOOLS` / coerced-one-time set per
**D9**, add a `describeCall()` case + `executeTool()` case for each. `kanban_move`'s
executor fetches the current board first to supply `rev` (so the model needn't track it),
retrying once on 409.

### 4b. External AI (Claude/Codex CLI) — plain REST (D8)

Documented in `docs/TERMINAL-PROTOCOL.md`. Example:

```bash
curl -s -H "Authorization: Bearer $KANBAN_API_TOKEN" \
  https://<host>/api/kanban/boards
curl -s -X POST -H "Authorization: Bearer $KANBAN_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Refactor auth","tags":["backend"]}' \
  https://<host>/api/kanban/boards
```

---

## 5. Frontend

### 5a. Store (`features/terminal/store.ts`)

Add `kanbanOpen: boolean` + `setKanbanOpen(open)`, initialized `false`, **excluded from
persist** (mirror `explorerOpen`/`settingsOpen`).

### 5b. Header button (`components/terminal-shell.tsx`)

Ghost icon `Button` (lucide `SquareKanban`, `size-3.5`) beside the Browse-files button, in
a `Tooltip` ("Kanban board"). **Always enabled** (D7). `onClick={() => setKanbanOpen(true)}`.
Sync `?kanban` via `useUrlFlagSync("kanban", kanbanOpen, setKanbanOpen)`.

### 5c. Host modal (`components/kanban-dialog.tsx`)

Thin controlled `Dialog` (`open`/`onOpenChange`), a large `DialogContent`
(e.g. `max-w-6xl h-[80vh]`) whose body is a single iframe:

```tsx
<iframe
  src="/kanban/app.html"
  title="Kanban board"
  sandbox="allow-scripts allow-same-origin" // D6: isolation, not a security boundary
  className="h-full w-full border-0"
/>
```

No React board logic in the app — the board lives in the artifact. Mounted once in
`terminal-shell.tsx`.

### 5d. The artifact (`apps/terminal/public/kanban/app.html`)

One self-contained file: inline `<style>` + `<script>`, no imports. Behavior:
board switcher (list from `GET /api/kanban/boards`), "New board" (name + tags),
column view with cards, native HTML5 drag-and-drop → `POST …/cards/:id/move` carrying the
board's current `rev` (refetch + retry once on 409), add/edit/delete card, delete board
(confirm). Palette hardcoded to mirror DESIGN.md (`#2b2622` canvas, `#f7f5f0` ink, Inter)
— a **documented exception** to the "use Tailwind tokens" rule because the artifact is an
isolated document with no access to the app's theme tokens.

---

## 6. Phased implementation checklist

1. **Backend** (lowest interpretation risk — do first): `kanban.js` store, shared-types
   schemas, `/api/kanban/*` routes + mutex + rev + bearer token.
2. **Gateway test** `test/kanban-endpoints.js` (`test:kanban`) — see §7 below. Gate before UI.
3. **Agent tools** — `gateway-client.ts` methods, `tools.ts` (D9), `describeCall`,
   `executeTool`, `tools.test.ts` cases.
4. **Frontend** — store slice, header button, `kanban-dialog.tsx`, URL flag.
5. **Artifact** `public/kanban/app.html` — the interactive board. **Checkpoint with the
   user before this step** (the UI is where interpretation risk lives).
6. Docs: `docs/TERMINAL-PROTOCOL.md` (+ `docs/AGENT-PROTOCOL.md`) kanban section; update
   `CLAUDE.md` status + Layout.

## 7. Testing (`apps/terminal-gateway/test/kanban-endpoints.js`, run `test:kanban`)

Standalone node script (repo convention: real gateway, `throw` asserts, PASS/FAIL). Cases:
board+card CRUD; **move splice correctness** (out of source, into target at exact index,
cross-column and same-column reorder); **rev/409** (stale move rejected, fresh move
accepted); **concurrent-write serialization** (fire N simultaneous moves, assert final
state is consistent and no card lost/duplicated); CSRF (missing/foreign Origin → 403 on
writes, GET exempt); **bearer token** (valid token no-cookie → 200; bad token → 401);
404s for unknown board/card/column; 413 oversized body. Plus `tools.test.ts` assertions
for the new tools' schemas + approval tiers (D9).

## 8. Deliberately deferred (post-v1)

- **Multi-artifact registry / host chrome** (D6) — tabs, artifact manifest, arbitrary
  pluggable artifacts. v1 ships exactly one artifact behind the seam.
- Card assignees, due dates, comments, attachments, activity log.
- WIP limits, swimlanes, custom column reordering UI, board archiving.
- Real-time push of board changes to open viewers (v1 refetches on focus / after own
  writes; the `rev`/409 loop keeps writers correct without live sync).
- Per-board / per-user access control (v1: any authenticated user sees all boards).

## 9. Open decisions worth confirming before build

- **D8 bearer token** — implement now (recommended, user said external access is
  important) or defer and ship cookie-only?
- **Column editing in v1** — ship rename/add/delete column, or fix the 4 defaults for v1
  and defer column editing? (Plan currently seeds 4 fixed columns; column-mutation routes
  are not in §3.)

## Critical files

- `apps/terminal-gateway/src/kanban.js` — **new** store (mirrors `registry.js`).
- `apps/terminal-gateway/src/server.js` — `/api/kanban/*` branches + mutex + `isKanbanAuthorized`.
- `apps/terminal-gateway/test/kanban-endpoints.js` — **new** `test:kanban`.
- `packages/shared-types/src/terminal.ts` + `index.ts` — Kanban schemas/types.
- `apps/agent-service/src/tools.ts`, `gateway-client.ts` — agent tools (D9).
- `apps/terminal/src/features/terminal/components/kanban-dialog.tsx` — **new** host modal.
- `apps/terminal/public/kanban/app.html` — **new** the pluggable board artifact.
- `apps/terminal/src/features/terminal/{store.ts,components/terminal-shell.tsx}` — flag + button.
