# PM Artifact — Enhancements Design & Implementation Plan

> Status: **implemented** (design 2026-07-28; built, reviewed, and independently
> verified 2026-07-28). This plan **extends the existing PM artifact**
> (`docs/PM-TOOL-PLAN.md`) in place — same gateway-owned sidecar, same `/api/pm/*`
> surface, same sandboxed-iframe artifact, same agent tools and MCP server. It is
> **not** a new product, a new service, or a rewrite. Every decision here builds on
> the settled decisions **D1–D12** in `docs/PM-TOOL-PLAN.md` and is cited by number
> rather than restated. **Every design decision in this document (P1–P6, OD1–OD10)
> was implemented as written**, with deviations recorded in §13 below.
>
> Scope — three feature clusters requested, all shipped:
>
> 1. **Custom workflow / columns** — add/rename/reorder/delete status; behaviour of
>    issues in a deleted status; allowed transitions; per-status WIP limit + over-limit
>    behaviour.
> 2. **Collaboration** — comments, activity history / audit trail, attachments,
>    watchers, notifications.
> 3. **Issue model** — `PROJ-123` issue keys (project key / sequence / uniqueness /
>    concurrency); types Epic/Story/Task/Bug/Subtask; reporter; single-owner vs
>    multi-assignee analysis + recommendation; Epic→Story→Subtask hierarchy +
>    validation.
>
> **§13 (new) is the implementation status/evidence record** — read it for what
> shipped, exact test counts, files touched, and every deviation with its reason.
> `apps/terminal/public/pm/app.html` **was** extended as part of implementation;
> the pre-existing uncommitted work already in that file at the time (an 8-line
> `.timeline` CSS block from another author) was verified byte-identical-preserved
> at every step and remains intact underneath the new code (see §13.5).

---

## 0. Grounding — current implementation (verified against source)

Anchors the plan builds on (all under `apps/terminal-gateway`, `apps/agent-service`,
`apps/terminal`, `packages/shared-types`, `tools/pm-mcp`):

| Layer       | File                                                                                                | Shape today                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store       | `src/pm.js`                                                                                         | Module `store={projects:{}}`; `load()` adopts `parsed.projects` wholesale; **`persist()` = `writeFileSync(JSON.stringify(store))` of the WHOLE store** (atomic tmp+rename); every mutator fully **synchronous** ⇒ read-modify-write is atomic, **no mutex** (D2); per-project `rev` (D3); `Column.taskIds[]` is the sole status/order authority (D4); `shapeTask`/`shapeProject` rebuild the GET wire-shape **field-by-field**. |
| Routes      | `src/server.js` `handlePm()` (≈1196–1411)                                                           | REST under `/api/pm/*`; coded-error→HTTP mapper (`not_found`→404, `stale`→409, else 400); auth = cookie **or** shared bearer `isArtifactBearerAuthorized` (`GATEWAY_API_TOKEN‖KANBAN_API_TOKEN`, D10); GET Origin-exempt, writes get the Origin/CSRF guard (server.js ≈1844).                                                                                                                                                   |
| Schemas     | `packages/shared-types/src/terminal.ts` `Pm*` block (826–976)                                       | Zod: `PmTask/PmColumn/PmSprint/PmProject(+Summary)`, `Create/Update*Request`, `MoveTaskRequest`.                                                                                                                                                                                                                                                                                                                                |
| Agent tools | `apps/agent-service/src/tools.ts`                                                                   | 8 `pm_*` tools; `WRITE_TOOLS` (6 writes) + `ONE_TIME_TOOLS` (`pm_delete_project`); `describeCall`; `executeTool`; `gateway-client.ts` methods. Approval per D12.                                                                                                                                                                                                                                                                |
| MCP         | `tools/pm-mcp/server.mjs`                                                                           | Dep-free stdio JSON-RPC clone of `kanban-mcp`; 8 tools mirroring the agent set; bearer `GATEWAY_API_TOKEN‖KANBAN_API_TOKEN`, `PM_BASE_URL‖KANBAN_BASE_URL`.                                                                                                                                                                                                                                                                     |
| Artifact    | `apps/terminal/public/pm/app.html`                                                                  | Vanilla JS, zero external requests, `textContent`-only DOM. Four live views: Board / List / Sprints / Timeline-Gantt (the header comment claiming "Timeline is a placeholder" is **stale** — Timeline is fully implemented). Fixed columns, no column UI. Edit-task modal exposes title/desc/assignee/priority/start/due/labels/sprint/dependsOn.                                                                               |
| Host        | `pm-dialog.tsx` (iframe), `store.ts` `pmOpen`, `terminal-shell.tsx` button + `useUrlFlagSync("pm")` | Thin seam; all logic in `app.html`.                                                                                                                                                                                                                                                                                                                                                                                             |
| Tests       | `test/pm-endpoints.js` (`test:pm`, 14 checks / 39 asserts), `tools.test.ts` PM section (9 tests)    | Real gateway on :3992, `PM_FILE` temp override, proves D10 legacy bearer, CSRF, cycle→400, move/rev/409, dep-scrub, sprint orthogonality.                                                                                                                                                                                                                                                                                       |

**Reusable in-repo patterns cited below (not reinvented):**

- **Append-only JSONL per id** → `apps/agent-service/src/history.ts` (`<id>.jsonl` in
  `data/`, `safeChatId()` sanitizer, `appendMessages()`). The model for **comments**
  and **activity/audit**.
- **Blob upload discipline** → `server.js` fs routes: `FS_UPLOAD_CAP` (8 MB) separate
  from `BODY_LIMIT`, streamed to `tee --`, NUL-safe path handling, no traversal. The
  model for **attachments**.
- **Bounded atomic JSON sidecar** → `src/registry.js` / `src/push.js` (atomic write,
  dedup, prune). The model for the **in-app notification store** (needs read-state).
- **Web Push broadcast** → `src/push.js` `isConfigured()` + `sendToAll(payload)`
  (single subscriber pool, prunes 404/410). The optional delivery channel for
  **watcher notifications**.

---

## 1. Cross-cutting constraints & principles (read before any cluster)

These govern all three clusters; each cluster section assumes them.

**P1 — Storage split is mandatory (the architectural crux).** `pm.json` is rewritten
in full on every mutation. Comments, activity/audit, attachment bytes, and
notifications therefore **must not live inline in `pm.json`** — inline growth makes
every comment rewrite the whole project and defeats retention. Collaboration data
lives in **separate stores** (JSONL append logs + a blob dir + one bounded
notification JSON), keyed by project/task id. `pm.json` gains only small scalar
fields (issue number, type, parentId, reporter, per-column `wipLimit`/`transitions`,
project `key`/`seq`).

**P2 — Single-user auth today; design to an actor model, not RBAC.** The gateway is
single-user (`authSessions` → one `GATEWAY_AUTH_USER`); `assignee` is free text.
There are exactly **three actor channels**: the **human** (cookie session), the
**in-app agent** (approval-gated), and an **external bearer/MCP client** (token). All
"who did this" fields (`reporter`, comment `author`, activity `actor`, watcher
`recipient`) carry an **actor string** drawn from these channels for forward-compat.
"Roles/permissions" in this doc are a **forward-looking capability abstraction**
mapped onto actors (§2 permission table); they are **not** a new login/RBAC system.
Per-recipient notification targeting is moot under single-user but the schema carries
`recipient` anyway so multi-user is a later, additive change.

**P3 — "Indexes" = in-memory maps, not a DB.** There is no database. Any "index"
below is an in-memory lookup map rebuilt on read (like the existing `columnOf` in
`shapeProject`) or a small counter on the project. State that explicitly wherever an
index is mentioned.

**P4 — Additive & backward-compatible only.** New fields are optional with safe
defaults; existing routes/tools keep their contracts; existing `pm.json` files load
unchanged and are migrated lazily (§8). No field is renamed or removed. This is what
makes the rollout separately deployable and rollback-safe.

**P5 — Error-code discipline (load-bearing for the agent retry path).** The agent's
`pm_move_task` auto-retries **once** on `409 {error:"stale"}` (tools.ts ≈1117). Any
**new** rejection (WIP exceeded, transition forbidden, hierarchy invalid) MUST use a
**distinct** code — **`422`** with a specific `error` slug — so it is **never** blindly
retried. The `handlePm` coded-error mapper is extended: `wip_exceeded` /
`transition_forbidden` / `hierarchy_invalid` → **422**; `stale` stays **409**;
`not_found` → 404; `cycle`/validation → 400. `gateway-client.movePmTask` treats any
non-409 error as a hard `GatewayError` (no retry) — confirm in the client change.

**P6 — Artifact invariants preserved.** The artifact stays a single self-contained
file: zero external requests, `textContent`-only DOM, same-origin `/api/pm/*` fetches,
sandbox `allow-scripts allow-same-origin allow-forms allow-modals`. Attachments are
served **same-origin + authed** from the gateway (never a third-party URL).

---

## 2. Permission / role rules (actor-mapped, forward-looking)

Capabilities are named now so the model is stable; today they all resolve to "the
single human = full", "agent = same but every write is approval-gated", "bearer =
full API, no UI". No enforcement table beyond auth exists in v1 — this is the
abstraction future multi-user work slots into.

| Capability                                        | Human (cookie) | In-app agent                      | External bearer/MCP |
| ------------------------------------------------- | -------------- | --------------------------------- | ------------------- |
| View project / read comments / activity           | ✅             | ✅ (auto)                         | ✅                  |
| Comment, watch/unwatch                            | ✅             | ✅ (approval-gated write)         | ✅                  |
| Edit task / move / manage attachments             | ✅             | ✅ (approval-gated)               | ✅                  |
| Administer workflow (columns / WIP / transitions) | ✅             | ✅ (approval-gated; see §3 tools) | ✅                  |
| Destroy (delete project / column-with-tasks)      | ✅             | ✅ **one-time** approval          | ✅                  |

Actor string derivation (server-side, for `reporter`/`author`/`actor`): cookie →
`user:<GATEWAY_AUTH_USER>`; agent → `agent`; bearer → `client:<label>` where label is
an optional `X-PM-Actor` request header (validated, ≤64 chars, else `client:bearer`).
This is the single new inbound identity signal and it is **advisory** (never a trust
boundary — auth is still cookie/bearer).

---

## CLUSTER 1 — Custom workflow / columns

### 3.1 Gap analysis

| Capability           | Today                                     | Desired                                               |
| -------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Column set           | Fixed 4 seeded at create (D9); no edit UI | Add / rename / reorder / delete columns per project   |
| Deleted-column tasks | N/A (can't delete)                        | Defined behaviour: block-if-nonempty **or** relocate  |
| Transitions          | Any task → any column (free move)         | Optional per-column **allowed-transitions** allowlist |
| WIP limits           | None                                      | Optional per-column `wipLimit` + over-limit behaviour |

### 3.2 Functional requirements

- **FR1** Create a column (name, inserted at index); rename; reorder; delete.
- **FR2** Column delete has an explicit, chosen policy for the tasks it holds (D9
  deferred this precisely to avoid the ambiguity — we now resolve it, §3.5).
- **FR3** Optional `wipLimit:int|null` per column. A move/create that would push a
  column's task count **above** its limit is **rejected 422 `wip_exceeded`** (hard
  block — see §3.6 for the soft-warn alternative, an open decision).
- **FR4** Optional per-column `transitions:string[]|null` = allowed **destination**
  column ids. `null` = unrestricted (today's behaviour, the default). A move to a
  disallowed destination → **422 `transition_forbidden`**.
- **FR5** All column mutations bump `rev` and go through the synchronous mutator path
  (atomic, no mutex).

**Non-goals (Cluster 1):** custom per-task status independent of columns; swimlanes;
column-level colour theming; automation rules ("when moved to Done, set…"); global
workflow templates shared across projects (each project owns its columns — matches D1).

### 3.3 Schema changes (`PmColumn`, in `pm.json` — small scalars, P1-safe)

```jsonc
{ "id":"col-…", "name":"In Progress", "taskIds":[…],
  "wipLimit": 3,                       // NEW: int ≥1, or null (default null = no limit)
  "transitions": ["col-done","col-…"]  // NEW: allowed destination col ids, or null = any
}
```

Zod `PmColumnSchema` gains `wipLimit: z.number().int().min(1).nullable().default(null)`
and `transitions: z.array(z.string()).nullable().default(null)`. `columnId` derivation
and `taskIds[]` authority (D4) are unchanged.

### 3.4 API contracts (new routes in `handlePm`)

| Route                                                                       | Body                                          | Result                    |
| --------------------------------------------------------------------------- | --------------------------------------------- | ------------------------- |
| `POST /api/pm/projects/:id/columns`                                         | `{name, index?, wipLimit?, transitions?}`     | 201 project               |
| `PATCH /api/pm/columns/:colId`                                              | `{projectId, name?, wipLimit?, transitions?}` | 200 project               |
| `POST /api/pm/columns/:colId/move`                                          | `{projectId, toIndex, rev}`                   | 200 project / 409 `stale` |
| `DELETE /api/pm/columns/:colId?projectId=&mode=block\|relocate&toColumnId=` | —                                             | 204 / 409 `stale` / 422   |

- Column **reorder** is `rev`-guarded exactly like task move (high-contention, D3).
- Column **rename / wipLimit / transitions** edits are last-writer-wins (like task
  field edits, D3) — low contention, no `rev`.
- New `pm.js` mutators: `createColumn`, `updateColumn`, `moveColumn(expectedRev)`,
  `deleteColumn(mode,toColumnId)`.

### 3.5 Column-delete behaviour (resolving the D9 deferral)

Two modes, caller-selected via `?mode=`:

- **`block` (default, recommended):** if the column holds ≥1 task → **409
  `column_not_empty`** (a _precondition_ failure; distinct slug, but 409 class since
  it's "state conflict, resolve then retry"). Empty column → deleted, spliced out of
  `project.columns`.
- **`relocate`:** requires `toColumnId`; **splice** the deleted column's `taskIds`
  onto the **end** of the target column's `taskIds` (preserving order), then remove the
  column. Because `Column.taskIds[]` is the sole position authority (D4), relocation is
  purely an array splice — no task record changes. Reject 400 if `toColumnId` is the
  column being deleted or unknown.

A project must always retain **≥1 column** (deleting the last column → 400
`last_column`).

### 3.6 Transition & WIP enforcement — concurrency & error cases

Enforcement lives in `moveTask` (and `createTask` for WIP-on-create), inside the
synchronous mutator, **after** the `rev` check but **before** the splice:

1. `rev` mismatch → **409 `stale`** (unchanged; agent retries once).
2. WIP: if `target !== source` and `wipLimit != null` and
   `target.taskIds.length >= wipLimit` → **422 `wip_exceeded`** `{column, limit, current}`.
   (Same-column reorder never trips WIP.)
3. Transition: if `source.transitions != null` and `toColumnId ∉ source.transitions`
   → **422 `transition_forbidden`** `{from, to, allowed}`.
4. Otherwise splice + `touch(p)` + persist.

**Concurrency:** two moves into a WIP-limited column race only within the single
gateway process; because each `moveTask` is one synchronous read-check-write, the
second sees the first's updated `taskIds.length` — the limit cannot be exceeded by
interleaving. The 422s are **not** `rev` conflicts, so the agent's 409-retry path is
**not** triggered (P5); the agent surfaces them verbatim and must re-plan (e.g. move
something out of Done first).

**Backfill:** existing columns get `wipLimit:null`, `transitions:null` ⇒ behaviour
identical to today (§8 migration, idempotent).

### 3.7 Agent / MCP tool changes

Add three approval-gated **write** tools (both `tools.ts` and `tools/pm-mcp`), all
allow-always eligible (routine admin, not destructive) **except** column delete:

- `pm_add_column {project_id, name, index?, wip_limit?, transitions?}` — WRITE.
- `pm_update_column {project_id, column_id, name?, wip_limit?, transitions?}` — WRITE.
- `pm_delete_column {project_id, column_id, mode?, to_column_id?}` — WRITE **+
  ONE_TIME** (can strand/relocate many tasks; coerce per-call like `pm_delete_project`).
- Column reorder: expose via `pm_update_column`? No — reorder is `rev`-guarded; add
  `pm_move_column {project_id, column_id, to_index}` (WRITE, auto-manages `rev`,
  retries once on 409, mirroring `pm_move_task`).

`pm_move_task` gains no new params but its executor must surface 422 (`wip_exceeded` /
`transition_forbidden`) as an error string without retry (P5). `describeCall` +
`executeTool` cases; `tools.test.ts` asserts the new WRITE/ONE_TIME membership and the
"422 not retried" behaviour. Protocol tables in `AGENT-PROTOCOL.md` updated.

### 3.8 UX flows (future `app.html` edits)

- **Board column header** (`renderColumn` ≈1330) gains: a WIP badge `N/limit` (turns
  `--destructive` at/over limit), a ⋯ menu → Rename / Set WIP limit / Set allowed
  transitions / Move left-right / Delete. A **"+ Add column"** affordance at the end of
  the board row.
- **Move dropdown** (`renderCard` ≈1401) filters destinations to `source.transitions`
  when set; a WIP-full destination is shown disabled with a tooltip.
- On a 422 the existing `#banner` (`showBanner` ≈1007) shows the reason
  ("In Progress is at its WIP limit (3)"); no optimistic state change is committed.
- **Delete column** uses the existing `window.confirm` pattern; if non-empty it offers
  relocate-target selection before calling the API with `mode=relocate`.
- Permissions: all human-full today; agent edits arrive via approval cards.

### 3.9 Acceptance criteria (verifiable)

- AC1 `POST …/columns` inserts at `index`, bumps `rev`, returns the project with the
  new column; created with `wipLimit/transitions` echoed.
- AC2 `PATCH …/columns/:id` renames and sets `wipLimit`/`transitions`; unrelated
  columns unchanged.
- AC3 `POST …/columns/:id/move` with correct `rev` reorders; stale `rev` → 409 `stale`.
- AC4 Delete empty column → 204; delete non-empty with `mode=block` → 409
  `column_not_empty`; with `mode=relocate&toColumnId=X` → 204 and X gains the tasks in
  original order; deleting the last remaining column → 400 `last_column`.
- AC5 Move into a column at its `wipLimit` → 422 `wip_exceeded`; same-column reorder at
  limit → 200. Create into a full column → 422.
- AC6 Move to a destination not in `source.transitions` → 422 `transition_forbidden`;
  `transitions:null` allows any move.
- AC7 Agent `pm_move_task` does **not** retry a 422 (unit test asserts a single gateway
  call); it **does** retry a 409 `stale` once (existing behaviour preserved).
- AC8 A legacy `pm.json` (no `wipLimit`/`transitions`) loads and behaves exactly as
  today; migration adds the null fields idempotently.

---

## CLUSTER 2 — Collaboration (comments · activity/audit · attachments · watchers · notifications)

### 4.1 Gap analysis

All five are **entirely absent** today (confirmed: no markup, state, or `/api/pm`
call). Every capability here is net-new and, per **P1**, lands in **separate stores**.

### 4.2 Storage architecture (the heart of this cluster)

```
data/pm.json                                  # unchanged shape + small task scalars
data/pm-activity/<projectId>.jsonl            # append-only audit log (never mutated)
data/pm-comments/<projectId>.jsonl            # append-only; edits/deletes = tombstone records
data/pm-attachments/<projectId>/index.jsonl   # attachment metadata (append + tombstone)
data/pm-attachments/<projectId>/<attId>       # opaque blob (bytes; original name only in metadata)
data/pm-notifications.json                     # bounded atomic JSON WITH read-state (recipient-keyed)
```

- **Comments & activity → JSONL append** (mirrors `history.ts`): O(1) writes,
  bounded per-write cost, natural retention by rotation. Read = stream + fold
  (materialize current state, drop tombstoned). `projectId` sanitized like
  `safeChatId`. A new `src/pm-collab.js` module owns these (async fs; **not** the
  synchronous `pm.js` mutex-free store — different concurrency story, see §4.7).
- **Attachments → blob dir + metadata JSONL** (mirrors fs-upload): bytes streamed to a
  content-addressable/opaque file under `FS_UPLOAD_CAP` (8 MB, configurable
  `PM_ATTACHMENT_CAP`); metadata (`id, taskId, filename, size, contentType, actor,
createdAt`) appended to `index.jsonl`. **Bytes never touch `pm.json`.**
- **Notifications → bounded atomic JSON** (mirrors `registry.js`/`push.js`): needs
  mutable **read-state**, so a small capped store (default 500 most-recent, older
  pruned) is simpler than JSONL+cursor. Recipient-keyed for forward-compat.

`pm.json` gains **no** collaboration bytes — only, on the task, small derived-free
scalars already covered in Cluster 3 (and nothing from this cluster). Per-task
comment/attachment **counts** shown on cards are computed at read time by the collab
module (cheap fold), returned via an augmented GET (§4.5), never persisted (avoids a
second source of truth).

### 4.3 Comments — model, retention, edit/delete

Record (JSONL): `{id, taskId, author, body(≤8192), createdAt, updatedAt?, editedFrom?,
deleted?, mentions:[actor…]}`. Edit → append a new record with same `id` +
`updatedAt`; delete → append `{id, deleted:true}`. Read materializes latest-per-id,
skipping deleted. `@mention` parse extracts actor tokens for notification fan-out.
**Retention:** comments are content — kept indefinitely; rotation only for pathological
size (`PM_COMMENTS_MAX_BYTES`, then archive-rotate `<projectId>.1.jsonl`). Author =
actor string (P2). Security: `body` is `textContent`-rendered in the artifact (no
HTML), same XSS-safe path as everything else (P6).

### 4.4 Activity / audit trail — model, emission, retention

Record: `{id, ts, actor, verb, target:{type:"task|column|sprint|project|comment|
attachment|watcher", id}, summary, before?, after?}`. **Emitted server-side by the
mutators** (not the client) so the audit is authoritative and the agent/bearer/human
all produce identical entries. Verbs: `created|updated|moved|deleted|commented|
attached|detached|watched|unwatched|column_added|column_deleted|wip_set|
transition_set|assigned|reporter_set|parented|type_changed`. Append-only, **never
edited or deleted** (audit integrity). **Retention:** age + size rotation
(`PM_ACTIVITY_RETENTION_DAYS` default 365, `PM_ACTIVITY_MAX_BYTES` rotate). Read =
reverse-chronological, paginated (`?limit=&before=`).

> Emission seam: `pm.js` mutators are synchronous; activity writes are async fs. To
> keep `pm.js` mutex-free and synchronous (D2), mutators **return an event descriptor**
> and the **route layer** (`handlePm`) does the async `pm-collab.appendActivity()`
> after a successful mutation. This keeps the audit-write off the atomic store path.

### 4.5 Attachments — upload / download / security

- `POST /api/pm/tasks/:id/attachments?projectId=` — raw body (like fs-upload; bypasses
  `BODY_LIMIT`, capped at `PM_ATTACHMENT_CAP`); `X-Filename` header carries the
  original name (sanitized, NUL/traversal-stripped like the fs routes); Content-Type
  sniffed/validated; streamed to the blob file. 201 metadata.
- `GET /api/pm/attachments/:attId?projectId=` — **authed, same-origin** (cookie or
  bearer); streams bytes with `Content-Disposition: attachment; filename="…"` (sanitized)
  and a conservative `Content-Type`; **Origin-exempt GET** like other reads. Never a
  redirect to an external host (P6).
- `DELETE /api/pm/attachments/:attId?projectId=` — append tombstone to `index.jsonl`
  and **unlink** the blob. 204.
- **Security:** size cap; filename sanitization identical to fs routes; blob filename is
  the opaque `attId` (original name only in metadata) so path traversal is impossible;
  content served with `X-Content-Type-Options: nosniff`; no execution context (artifact
  shows a download link / image preview only via `<img src>` to the same-origin authed
  route). **Retention:** attachments deleted with their task (cascade on `deleteTask`)
  and with the project (cascade on `deleteProject`) — blobs unlinked, metadata
  tombstoned; orphan-sweep on load is optional (open decision §9).

### 4.6 Watchers & notifications — delivery + read-state

- **Watchers** live on the task as a small array `watchers:[actor…]` in `pm.json`
  (small scalar list, P1-safe) — auto-added: reporter, assignee, and anyone who
  comments; explicit watch/unwatch toggles. This is the **recipient set**.
- **Events that notify** watchers (minus the actor who caused it): task assigned,
  commented, `@mentioned` (mention notifies even non-watchers), moved/status-changed,
  due-date-passed (optional, poll-based like push.js job-finish), attachment added.
- **Delivery — two channels, in-app is primary:**
  1. **In-app notification store** (`data/pm-notifications.json`, bounded/atomic):
     records `{id, recipient, event, taskId, projectId, summary, createdAt, readAt?}`.
     **Read-state** = `readAt`. `GET /api/pm/notifications?unread=1`, `POST
/api/pm/notifications/read {ids|all}`. A bell affordance in the artifact toolbar
     shows unread count. This is authoritative and works with the tab open.
  2. **Web Push (optional, best-effort):** reuse `push.js` `isConfigured()` +
     `sendToAll(payload)` gated on the single user (P2). Payload carries only
     `{projectId, taskId, summary}` — **never** comment bodies (transits FCM/Apple, same
     rule as the existing job-finished push). If push unconfigured, in-app still works.
- **Per-recipient targeting** is moot under single-user (broadcast = the one user), but
  the store is recipient-keyed so multi-user is a later additive change (P2).
- **Retention:** notifications pruned to the newest `PM_NOTIFICATIONS_MAX` (default 500)
  and/or older than `PM_NOTIFICATIONS_RETENTION_DAYS`.

### 4.7 Concurrency for the collab stores

- JSONL appends are **append-only** → concurrent writers don't corrupt state (each
  record is a full line; readers fold). Use `appendFile` (atomic per small write on
  local fs) — no whole-file rewrite, no mutex needed. Ordering across actors is by the
  record `ts`/append order.
- The notification JSON is a bounded atomic-rewrite store; because collab writes happen
  in the **async route layer** (not the synchronous `pm.js` path), a tiny in-module
  serialization (a promise chain / write queue in `pm-collab.js`) prevents lost updates
  to the notification file. State this explicitly — it is the one place a mutex-like
  guard is warranted, and it is **outside** `pm.js` so D2 is untouched.

### 4.8 Agent / MCP tool changes

- `pm_add_comment {project_id, task_id, body}` — WRITE, allow-always.
- `pm_list_comments {project_id, task_id}` — read (auto). _(no comment edit/delete tool
  — human-only, mirroring "no card/task delete tool" precedent.)_
- `pm_list_activity {project_id, limit?, before?}` — read (auto).
- `pm_watch_task` / `pm_unwatch_task {project_id, task_id}` — WRITE, allow-always.
- Attachments via agent: **read/list only** (`pm_list_attachments`, auto); **no upload
  tool** (binary upload through an agent is out of scope — humans attach in the UI).
- Notifications: **no agent tools** (notifications are a human affordance).
- `AGENT-PROTOCOL.md` / `TERMINAL-PROTOCOL.md` tables extended; `tools.test.ts` asserts
  read vs write tiers.

### 4.9 UX flows (future `app.html` edits)

- **Task edit modal** (markup ≈806–869) gains tabs/sections: **Details** (today's
  fields) · **Comments** (list + add box, `@mention` autocomplete over known actors) ·
  **Attachments** (drop/upload input → `POST …/attachments`; list with download links &
  delete) · **Activity** (reverse-chron audit) · a **Watch/Unwatch** toggle + watcher
  chips.
- **Card** (`renderCard` ≈1351) gains small count badges: 💬N (comments), 📎N
  (attachments), 👁 if watched — counts from the augmented GET (§4.2).
- **Toolbar** gains a **bell** with unread count → a dropdown of recent notifications;
  clicking one opens the task; marks read.
- All content `textContent`-rendered; attachments preview via same-origin authed `<img>`
  only for image content-types; everything else is a download link.
- Permissions: human full; agent comment/watch arrive via approval cards; bearer/MCP
  same API.

### 4.10 Acceptance criteria (verifiable)

- AC9 `POST …/tasks/:id/comments` appends a record; `GET` returns it; edit appends a new
  record read as the current body; delete tombstones it (not returned). `pm.json`
  byte-size does **not** grow with comment count (proves P1).
- AC10 Every mutating route writes exactly one activity record with the correct
  `actor`/`verb`/`target`; audit is append-only (a delete route never removes prior
  activity).
- AC11 Upload ≤ cap → 201 metadata + a blob file exists; download returns the exact
  bytes with a sanitized `Content-Disposition`; over-cap → 413; a filename with
  `../`/NUL/newline round-trips safely and cannot escape the blob dir.
- AC12 Deleting a task cascades: its comments/attachments/activity-target are handled
  per policy (blobs unlinked); deleting a project removes/rotates all four sidecar
  files for that project.
- AC13 Assigning/commenting/mentioning creates in-app notifications for the correct
  recipients (minus the actor); `GET ?unread=1` and `POST …/read` flip read-state;
  count reflects it. With push configured, a push is sent carrying no comment body.
- AC14 Concurrent comment appends from two actors both persist (no lost line); two
  concurrent notification writes don't lose one (write-queue guard).
- AC15 Retention: exceeding the activity size/age bound rotates the log without data
  loss of recent entries; notifications prune to the cap.

---

## CLUSTER 3 — Issue model (keys · types · reporter · assignee · hierarchy)

### 5.1 Gap analysis

| Capability | Today                            | Desired                                                 |
| ---------- | -------------------------------- | ------------------------------------------------------- |
| Human id   | Opaque `task-<uuid>` only        | `PROJ-123` issue key (stable, human-referenceable)      |
| Type       | None                             | Epic / Story / Task / Bug / Subtask                     |
| Reporter   | None (only free-text `assignee`) | `reporter` actor captured at create                     |
| Assignee   | Single free-text string          | Decide single vs multi (see §5.5)                       |
| Hierarchy  | Flat `dependsOn` DAG only        | Epic→Story→(Task/Bug)→Subtask parent/child + validation |

### 5.2 Issue keys `PROJ-123` — key, sequence, uniqueness, concurrency

- **Project key**: new `project.key` (2–10 chars, `^[A-Z][A-Z0-9]*$`), unique across
  projects. On create: derive from name (uppercase alnum, first token, truncate) with a
  **collision suffix** (`PAY`, `PAY2`, …) if taken; user may override. Uniqueness
  enforced in the synchronous `createProject`/`updateProject(key?)` against a rebuilt
  in-memory set (P3) → 409 `key_taken`.
- **Sequence**: new `project.seq` (monotonic int, starts 0). `createTask` does
  `task.number = ++p.seq` **inside the synchronous mutator** — atomic read-modify-write,
  so numbers are gap-free and unique **without a mutex** (D2). The derived issue key
  `PROJ-<number>` is computed in `shapeTask` (never persisted as a string — `key` + `number`
  are the authority, mirroring the `columnId`-is-derived lesson, D4).
- **Uniqueness across the three actors** (human, agent, bearer/MCP): all writes funnel
  through the **single gateway process** and its synchronous mutators, so `++p.seq`
  cannot double-allocate regardless of actor. **Assumption stated:** exactly one gateway
  process owns `data/` (true today — the store is process-local, no shared-fs multi-writer).
  If that ever changes, sequence generation needs a file lock — called out in §9.
- **Backfill** (§8): assign `number` to existing tasks in `createdAt` order; set
  `seq = max(number)`; derive `key` from name. Idempotent (only if absent).

### 5.3 Issue types

`task.type ∈ {epic, story, task, bug, subtask}`, default **`task`** (backfill default).
Zod enum `PmIssueTypeSchema`. Type drives: card glyph/colour, hierarchy validation
(§5.6), and List/Board filtering. `type` is a plain field edit (LWW). Changing a type
that would violate hierarchy (e.g. a parent-having task → `epic`, or a
children-having task → `subtask`) is **rejected 422 `hierarchy_invalid`** (§5.6).

### 5.4 Reporter

`task.reporter: actor|null`, set to the creating actor (P2) at `createTask`, editable
(field edit). Auto-added as a watcher (§4.6). Backfill default `null`. Shown in the
detail modal; filterable in List.

### 5.5 Single owner vs multi-assignee — analysis & recommendation

**Today:** `assignee` is a single nullable free-text string, surfaced in card/List/edit
and used by the List text filter.

| Dimension                           | Single `assignee` (keep)                            | Multi `assignees[]`                                                           |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Backward-compat                     | Zero migration; field unchanged                     | Migration `assignee→assignees[0]`; every read/filter/UX site changes          |
| "Who owns this?" clarity            | One throat to choke — matches PM/Kanban norms       | Diffuses ownership; needs a "primary" anyway                                  |
| UX surface (card/List/Gantt/filter) | Existing chips work                                 | Multi-chip layout, filter semantics ("any of"), Gantt row ownership ambiguous |
| Notifications                       | One assignee recipient                              | Fan-out to N — fine with §4.6 but more noise                                  |
| Real need                           | Covered by **watchers** (§4.6) for "involve others" | Genuine only for pair/mob work                                                |
| Single-user reality (P2)            | Assignee is already free-text, effectively a label  | Multi-assignee has little value under one human                               |

**Recommendation: keep a single `assignee`** for this enhancement and satisfy the
"multiple people involved" need with **watchers** (§4.6, already built in Cluster 2).
It is fully backward-compatible, matches the single-user reality, and avoids touching
every read/filter/UX site. **Defer** true `assignees[]` to post-v1; if later added, do
it additively (`assignees[]` with `assignee` kept as the derived primary =
`assignees[0]`), so no rename. This is the §9 recommended resolution.

### 5.6 Hierarchy (Epic→Story→Subtask) — model, validation matrix, move/delete

**Model:** new `task.parentId: taskId|null` (same project only). This is a **separate
edge from `dependsOn`** — hierarchy is containment, `dependsOn` is scheduling order.
Both are validated independently.

**Allowed parent→child (validation matrix):**

| Child ↓ / Parent → | (none/root)              | Epic | Story | Task | Bug | Subtask |
| ------------------ | ------------------------ | ---- | ----- | ---- | --- | ------- |
| **Epic**           | ✅                       | ❌   | ❌    | ❌   | ❌  | ❌      |
| **Story**          | ✅                       | ✅   | ❌    | ❌   | ❌  | ❌      |
| **Task**           | ✅                       | ✅   | ❌    | ❌   | ❌  | ❌      |
| **Bug**            | ✅                       | ✅   | ❌    | ❌   | ❌  | ❌      |
| **Subtask**        | ❌ (parent **required**) | ❌   | ✅    | ✅   | ✅  | ❌      |

Rules enforced in `createTask`/`updateTask` when `parentId`/`type` changes → violation
= **422 `hierarchy_invalid`** `{reason}`:

- Epic cannot have a parent.
- Story/Task/Bug may have **only an Epic** parent (or none).
- Subtask **must** have a parent, and only a Story/Task/Bug parent (never Epic, never
  Subtask — max depth 3: Epic→Story→Subtask).
- **No cycles** in the parent chain (a task can't be its own ancestor) — synchronous
  walk mirroring `wouldCycle` for `dependsOn`, but over `parentId`.
- Cross-project parenting forbidden (parent must exist in the same project) → 404/400.

**Move (board column move):** unaffected — hierarchy is orthogonal to status/columns
(a Subtask can be Done while its Story is In Progress), exactly like sprints (D5).
Moving a task between columns never changes `parentId`.

**Delete behaviour matrix:**

| Delete target                | Children policy (recommended)                                                                                  | Alt (open decision §9)  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Epic with Stories            | **Orphan**: children's `parentId → null` (become root Stories/Tasks)                                           | Block if non-empty      |
| Story/Task/Bug with Subtasks | **Orphan**: Subtasks' `parentId → null` **and** `type → task` (a parentless Subtask is invalid, so promote it) | Cascade-delete Subtasks |
| Subtask (leaf)               | Plain delete                                                                                                   | —                       |

Delete also scrubs the id from other tasks' `dependsOn` (existing D6 behaviour) **and**
nulls any `parentId` pointing at it (new). All in the one synchronous `deleteTask`.
Recommended orphan-not-cascade avoids silent bulk data loss; the promote-Subtask→Task
step keeps the type/hierarchy invariant intact.

### 5.7 Schema changes (`PmTask`, `PmProject`)

```jsonc
// PmProject gains:
"key": "PAY",        // NEW: unique project key ^[A-Z][A-Z0-9]{1,9}$
"seq": 42,           // NEW: monotonic issue-number counter
// PmTask gains:
"number": 43,        // NEW: per-project issue number (with key ⇒ derived "PAY-43")
"type": "story",     // NEW: epic|story|task|bug|subtask (default "task")
"reporter": "user:lek", // NEW: actor|null
"parentId": "task-…",   // NEW: hierarchy edge (same project) | null
"watchers": ["user:lek","agent"] // NEW (Cluster 2): actor[]
// derived on GET (never persisted): "key": "PAY-43"  (from project.key + number)
```

Zod: `PmIssueTypeSchema`, add fields to `PmTaskSchema`/`PmProjectSchema` (all optional
w/ defaults, P4), extend `Create/UpdateTaskRequest` (`type?`, `parentId?`, `reporter?`
— reporter usually server-set), `Create/UpdateProjectRequest` (`key?`). `PmTask` gains
derived `key?` (like `columnId?`).

### 5.8 API contracts

Mostly **extend existing** routes (additive fields), plus reads:

- `POST /api/pm/projects` accepts optional `key` (else derived); `PATCH …/projects/:id`
  accepts `key?` (→ 409 `key_taken` on collision).
- `POST …/tasks` & `PATCH …/tasks/:id` accept `type?`, `parentId?`, `reporter?` →
  validated (§5.6); violations 422 `hierarchy_invalid`, key collision 409.
- `GET …/projects/:id` returns tasks with derived `key`, plus `type/reporter/parentId/
watchers`. Optional `GET …/projects/:id/tree` returns the Epic→Story→Subtask forest
  (derived; convenience for the hierarchy UI).
- Task move/delete routes unchanged in signature; `deleteTask` gains the `parentId`
  scrub + Subtask-promote (§5.6) internally.

### 5.9 Agent / MCP tool changes

- `pm_add_task` / `pm_update_task` gain `type`, `parent_id` params (and `reporter`
  optional; default server-set). Existing approval tiers unchanged (routine WRITE).
- `pm_get_project` output now includes `key`/`type`/`parentId`/`reporter` (no tool
  signature change).
- Optional read `pm_get_tree {project_id}` (auto).
- `describeCall` for add/update mentions type/parent when present; `tools.test.ts`
  updated. Protocol docs updated.

### 5.10 UX flows (future `app.html` edits)

- **Card** (`renderCard` ≈1351): show `PROJ-123` key (monospace, muted) + a type glyph;
  a parent-key chip (`↳ PAY-12`) when nested; keep assignee/priority/due/labels/deps.
- **Edit modal** (≈806–869): add **Type** select, **Parent** picker (filtered to valid
  parents per §5.6 matrix, showing keys), read-only **Reporter**, read-only **Key**.
  Invalid type/parent combos disabled client-side; server 422 is the backstop.
- **List** (`LIST_COLUMNS` ≈1479): add **Key**, **Type**, **Reporter** columns;
  type/reporter filters.
- **Board**: optional group-by-Epic swimlane view is a post-v1 nicety (open decision);
  v1 just shows the parent chip.
- Permissions: human full; agent add/update via approval; reporter is actor-derived, not
  user-editable to arbitrary identities (advisory field, P2).

### 5.11 Acceptance criteria (verifiable)

- AC16 New project gets a unique `key`; a colliding explicit key → 409 `key_taken`;
  derivation suffixes on collision.
- AC17 Two tasks created back-to-back (even via different actors) get consecutive,
  unique `number`s and derived keys `PROJ-N`, `PROJ-N+1`; no gaps, no dupes under
  interleaved creates.
- AC18 Type defaults to `task`; setting each of the five types persists and drives the
  card glyph.
- AC19 Hierarchy matrix enforced: Subtask without a parent → 422; Subtask under an Epic
  → 422; Story under a Story → 422; Epic with a parent → 422; a parent cycle → 422; a
  valid Epic→Story→Subtask chain succeeds.
- AC20 Deleting an Epic orphans its Stories (`parentId:null`, still exist); deleting a
  Story orphans + promotes its Subtasks to `type:task`; the deleted id is scrubbed from
  every `dependsOn` and every `parentId`.
- AC21 Reporter captured as the creating actor; auto-added to watchers.
- AC22 `assignee` stays a single field; existing tasks/filters unaffected (multi-assignee
  deferred).
- AC23 A legacy `pm.json` loads, is backfilled (numbers/keys/type=task/reporter=null)
  **idempotently** (re-loading does not renumber or change keys).

---

## 6. Unified schema summary (all new fields, one place)

```jsonc
Project: { …existing, key:"PAY", seq:42,
           columns:[{ …existing(id,name,taskIds), wipLimit:int|null, transitions:[colId]|null }] }
Task:    { …existing, number:43, type:"epic|story|task|bug|subtask",
           reporter:actor|null, parentId:taskId|null, watchers:[actor],
           /* derived on GET, never persisted: */ columnId, key:"PAY-43" }
```

Separate stores (P1): `pm-activity/<pid>.jsonl`, `pm-comments/<pid>.jsonl`,
`pm-attachments/<pid>/{index.jsonl,<attId>}`, `pm-notifications.json`.

All `pm.json` additions are **small scalars/short arrays** — the whole-file-rewrite
cost stays proportional to task count, not to comment/activity/attachment volume.

---

## 7. Migration / backfill (project / task / column) — idempotent

A `migrate(store)` step runs inside `pm.js` `load()` **after** parse, returns a
`changed` flag, and `persist()`s **only if changed** (so a migrated file is stable on
subsequent boots — idempotency guard):

1. **Column**: for each column missing `wipLimit`/`transitions`, set `null`.
2. **Project key/seq**: if `key` absent → derive unique key from `name` (collision
   suffix against keys already assigned this pass); if `seq` absent → set to the max
   assigned `number` after step 3.
3. **Task number**: for tasks missing `number`, assign sequentially in `createdAt`
   order (stable), starting after any already-present numbers.
4. **Task type/reporter/parentId/watchers**: default `type:"task"`, `reporter:null`,
   `parentId:null`, `watchers:[]` when absent.
5. **Idempotency**: every step is "only if field absent" — re-running assigns nothing
   new, so keys/numbers never change across reboots. Unit-tested by loading a migrated
   file twice and asserting byte-identical output.

**Round-trip / data-safety (verified against `pm.js`):** `persist()` serializes the raw
in-memory `store`, and mutators edit in place / `load()` adopts `parsed.projects`
wholesale — so **unknown nested fields survive on disk**. Only the GET wire-shape
(`shapeTask`/`shapeProject`, rebuilt field-by-field) drops fields it doesn't know. This
is the basis of the rollback story (§8): new-version data is preserved on disk even
while an old gateway runs, but an old gateway's **GET responses omit** the new fields.

---

## 8. Phased rollout — separately deployable, backward-compatible, rollback

Each phase is independently shippable (gateway can deploy ahead of the artifact; the
artifact degrades gracefully because unknown fields are optional). **Prod deploy note
(inherited):** rebuild the frontend with `./build-prod.sh` (bakes `PUBLIC_ORIGIN`) and
**restart prod-gateway** (new routes need a gateway restart) + prod-agent.

- **Phase 0 — Schema + migration (gateway only).** Add fields/defaults, `migrate()`,
  extend Zod + the coded-error→HTTP mapper (422 slugs). No behaviour change; existing
  tests stay green. Ship + verify migration on a copy of prod `pm.json`.
- **Phase 1 — Issue model (Cluster 3) backend + tools.** Keys/seq, type, reporter,
  parentId + validation; agent/MCP params. Gate on `test:pm` + `tools.test.ts`.
- **Phase 2 — Custom columns/WIP/transitions (Cluster 1) backend + tools.** New column
  routes, 422 enforcement, agent retry-safety.
- **Phase 3 — Collaboration (Cluster 2) backend + `src/pm-collab.js`.** JSONL/blob/
  notification stores, activity emission, attachment routes, watcher/notification API,
  optional push wiring. Read tools + comment/watch write tools.
- **Phase 4 — Artifact UX (all clusters).** The `app.html` edits (column UI, issue
  keys/types/hierarchy, comment/attachment/activity/watch panes, notification bell).
  Ships last so the gateway is always ahead. Live sandboxed-iframe smoke.
- **Phase 5 — Docs + deploy.** `TERMINAL-PROTOCOL.md`, `AGENT-PROTOCOL.md`, `CLAUDE.md`,
  `PM-TOOL-PLAN.md` cross-link.

**Backward compatibility:** additive fields, defaulted; existing routes/tools/contracts
unchanged; existing `pm.json` migrated lazily and idempotently; the Kanban artifact is
never touched (D1).

**Rollback (per phase):**

- **Gateway rollback (Phases 0–3):** revert the gateway binary. On-disk `pm.json`
  keeps the new scalar fields (harmless to an old gateway — §7 round-trip safety), but
  old GET responses omit them; the **separate collab stores are simply ignored** by an
  old gateway (no schema coupling). No data loss; the only user-visible effect is the
  new fields/panes disappear until re-deploy.
- **Data caveat:** issue **numbers/keys** assigned by the new version persist in
  `pm.json` and remain valid after rollback (they're plain fields) — rollback does not
  renumber. Attachment blobs written under `data/pm-attachments/` are orphaned but
  harmless; a re-deploy re-adopts them.
- **Artifact rollback (Phase 4):** re-publish the previous `app.html`; the gateway API
  is a superset, so the old artifact keeps working.
- **Point of no easy return:** none — every phase is revertible. The only irreversible
  user action is a hard column-delete `mode=relocate` or an Epic orphan (data
  reshaped), which is a user choice, not a deploy artifact.

---

## 9. Test plan

Extends the existing harnesses (`test:pm` standalone gateway script; `tools.test.ts`
vitest; live sandboxed-iframe smoke). New/extended coverage:

**Unit (`pm.js` / `pm-collab.js`):**

- Column CRUD + reorder splice; last-column guard; relocate splice order.
- WIP/transition enforcement decision points; same-column reorder exemption.
- `wouldCycle` for `parentId`; hierarchy matrix (every cell); Subtask-promote on parent
  delete; `dependsOn`+`parentId` scrub on delete.
- Sequence allocation gap-free under simulated interleaved `createTask`.
- `migrate()` idempotency (load twice → byte-identical); key-collision suffixing.
- JSONL fold (latest-per-id, tombstones); notification write-queue no-lost-update.

**Integration / API (`test/pm-endpoints.js`, extend the 14 checks):**

- Column routes: create/rename/wip/transitions/reorder(409)/delete(block|relocate|last).
- Move 422 `wip_exceeded` / `transition_forbidden` (distinct from 409 `stale`).
- Issue-key uniqueness + `PROJ-N` derivation; hierarchy 422s; delete orphan/promote.
- Comments append/edit/delete-tombstone; activity emitted per mutation; attachment
  upload/download/round-trip/over-cap 413; notifications create + read-state.
- **D10 bearer** still authorizes all new routes; **CSRF**: new writes 403 on foreign
  Origin, new reads (comments/activity/attachment GET) Origin-exempt.

**Agent (`tools.test.ts`):**

- New tools present with closed schemas; correct WRITE/ONE_TIME membership
  (`pm_delete_column` one-time; comment/watch/column add/update allow-always; reads
  auto). `pm_move_task` **does not retry** a 422 (asserts single gateway call).

**UI (live sandboxed-iframe smoke, matching prod sandbox — not a bare page):**

- Column ⋯ menu add/rename/WIP badge/delete-relocate; move blocked at WIP shows banner.
- Issue key + type glyph on cards; parent picker rejects invalid combos; hierarchy chip.
- Comment add/list; attachment upload + download link; activity list; watch toggle;
  notification bell unread count → mark read.

**Concurrency:**

- Interleaved `createTask` → unique sequence (script drives N parallel POSTs, asserts
  gap-free set).
- Two moves into a WIP-1 column → exactly one succeeds, other 422.
- Concurrent comment appends + concurrent notification writes → no lost record.

**Migration:**

- A pre-enhancement `pm.json` fixture loads, backfills, and is idempotent on re-load;
  existing task order/columns/deps preserved; keys/numbers stable across reboot.

**Security:**

- Attachment filename traversal/NUL/newline can't escape the blob dir; over-cap 413;
  download is authed + same-origin + `nosniff`; comment/notification bodies are
  `textContent` (no HTML injection); push payload never contains a comment body;
  reporter/actor cannot be spoofed past the auth channel (advisory only, P2).

---

## 10. Risks / trade-offs / open decisions (with recommendations)

| #    | Decision                     | Options                                           | Recommendation                                                                                                      |
| ---- | ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| OD1  | WIP over-limit               | Hard block (422) vs soft-warn (allow + flag)      | **Hard block** (predictable, enforceable server-side); expose a per-column "soft" boolean later if users push back. |
| OD2  | Column delete default        | Block-if-nonempty vs relocate                     | **Block by default**, relocate opt-in via `mode=relocate` (no silent moves).                                        |
| OD3  | Epic/parent delete           | Orphan vs cascade vs block                        | **Orphan** (+ promote Subtask→Task); never silent bulk delete.                                                      |
| OD4  | Assignee cardinality         | Single vs multi                                   | **Keep single**; use watchers for "involve others"; multi deferred, additive if needed (§5.5).                      |
| OD5  | Collab store fs concurrency  | mutex in pm.js vs async route-layer + write-queue | **Route-layer write-queue** in `pm-collab.js`; keep `pm.js` synchronous & mutex-free (D2 intact).                   |
| OD6  | Notification storage         | JSONL+cursor vs bounded atomic JSON               | **Bounded atomic JSON** (needs read-state; matches registry.js).                                                    |
| OD7  | Attachment agent upload      | Add tool vs human-only                            | **Human-only** (binary via agent is awkward; mirrors no-task-delete precedent).                                     |
| OD8  | Reporter editability         | Actor-locked vs free-text                         | **Actor-derived, editable to actor strings only** (advisory field; not a trust boundary).                           |
| OD9  | Board group-by-Epic swimlane | v1 vs post-v1                                     | **Post-v1** (parent chip suffices for v1).                                                                          |
| OD10 | Multi-process gateway        | Assume single-writer vs file-lock seq             | **Assume single-writer** (true today); document the file-lock requirement if it ever shards.                        |

**Top risks:** (a) **`pm.json` bloat** if collab data leaks inline — mitigated by P1 and
AC9. (b) **Agent retrying a 422** — mitigated by P5 + AC7. (c) **Migration renumbering**
on a bug — mitigated by idempotency guard + AC23 + testing on a prod copy. (d)
**Attachment path traversal** — mitigated by opaque blob names + fs-route sanitization +
AC11. (e) **Audit integrity** — activity is append-only, never deletable (AC10).

**Explicit non-goals (cite `PM-TOOL-PLAN.md` §8, do not re-argue):** real multi-user
RBAC/login; cross-project hierarchy or dependencies; drag-and-drop; real-time push of
board changes; auto-scheduling/critical-path; per-task `rev`; comments on entities
other than tasks; rich-text/markdown comment rendering; email/Slack notification
channels; workflow automation rules; SLA/time-tracking.

---

## 11. Acceptance criteria — master index

Every feature has verifiable criteria above; consolidated for sign-off:

- **Custom columns/WIP/transitions:** AC1–AC8.
- **Collaboration (comments/activity/attachments/watchers/notifications):** AC9–AC15.
- **Issue model (keys/types/reporter/assignee/hierarchy):** AC16–AC23.

Sign-off = all ACs green in `test:pm` + `tools.test.ts` + the live iframe smoke, with
migration verified on a copy of production `pm.json` and rollback verified by running an
old gateway against new-version data (no crash, no data loss).

---

## 12. Files / modules changed (all items below are ✅ DONE — see §13 for evidence)

| File                                                               | Change (as shipped)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/terminal-gateway/src/pm.js`                                  | ✅ New fields/defaults; idempotent `migrate()`; column mutators (`createColumn`/`updateColumn`/`moveColumn`/`deleteColumn`); WIP/transition/hierarchy enforcement in `createTask`/`moveTask`/`updateTask`; issue-key + sequence allocation; `deleteTask` parent-scrub/promote + `dependsOn` scrub; `watchTask`/`unwatchTask` (idempotent).                                                                                                                                                                      |
| `apps/terminal-gateway/src/pm-collab.js`                           | ✅ **NEW** — fully synchronous (not async+write-queue, see §13.2 deviation) JSONL comments/activity, attachment blob+metadata, bounded notification store, project-cascade cleanup.                                                                                                                                                                                                                                                                                                                             |
| `apps/terminal-gateway/src/server.js`                              | ✅ `handlePm` new routes (columns, comments, activity, attachments, watch/unwatch, notifications); `pmErrorStatus` 422/409/404/400 slug mapping; attachment upload/download streaming (fs-route BODY_LIMIT-bypass pattern); `actorOf(req)` actor derivation; activity emission after every mutation incl. column ops (§13.3 gap found + fixed) with an explicit `taskId` field (§13.4 gap found + fixed).                                                                                                       |
| `apps/terminal-gateway/src/push.js`                                | ✅ Reused as-is; PM notify path calls it best-effort, comment-body-free, never rolls back on failure.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/shared-types/src/terminal.ts` (+ `index.ts`)             | ✅ Extended `PmColumn/PmTask/PmProject/Create*/Update*`; added `PmIssueTypeSchema`, `PmComment*`, `PmActivity` (+ `taskId`), `PmAttachmentMeta`, `PmNotification*`; barrel re-exports.                                                                                                                                                                                                                                                                                                                          |
| `apps/agent-service/src/tools.ts`                                  | ✅ 16 new tools (columns ×4, `pm_get_tree`, comments/activity/watch/attachments-read ×6) on top of the 8 shipped in v1; `WRITE_TOOLS`/`ONE_TIME_TOOLS` membership; `describeCall`/`executeTool`; 422 no-retry surfacing (unit-tested).                                                                                                                                                                                                                                                                          |
| `apps/agent-service/src/gateway-client.ts`                         | ✅ New `/api/pm/*` client methods incl. `movePmColumn`; `movePmTask`/`movePmColumn` 422-hard-error (no retry), 409-retry-once (unchanged contract).                                                                                                                                                                                                                                                                                                                                                             |
| `apps/agent-service/src/tools.test.ts`                             | ✅ Extended to 86 tests total — new-tool presence/tiers/schemas + explicit 422-vs-409 retry-count assertions.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tools/pm-mcp/server.mjs`                                          | ✅ Mirrors every new agent tool (columns/comments/activity/watch/tree/attachments-read); same dep-free JSON-RPC clone shape.                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/terminal/public/pm/app.html`                                 | ✅ Column ⋯ menu (rename/WIP/transitions/move/delete) + WIP badge + "+ Add column"; transition-filtered move dropdown; 422-vs-409 error handling; issue key/type/parent chips on cards; edit-modal Type/Parent/Reporter/Key + Comments/Attachments/Activity/Watch sections; List Key/Type/Reporter columns; topbar notification bell with unread badge + dropdown + mark-read. The pre-existing `.timeline` CSS block (another author's uncommitted work) verified byte-identical-preserved throughout (§13.5). |
| `apps/terminal/src/features/terminal/components/pm-dialog.tsx`     | ✅ No change needed, as predicted — existing sandbox flags already cover the new forms/uploads.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/terminal-gateway/test/pm-endpoints.js`                       | ✅ Extended from 14 → **37 checks** covering every Cluster 1–3 API/concurrency/migration/security case (AC1–AC24).                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/TERMINAL-PROTOCOL.md`, `docs/AGENT-PROTOCOL.md`, `CLAUDE.md` | ✅ Updated with the new endpoints/tools and cross-links to this plan.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 13. Implementation status & evidence (added post-build)

**Built via a role-based loop** (PM/SA scoping + cross-review, BE implementing
backend/tools/MCP, FE implementing the artifact) across 6 phases, each gated on
its own passing tests before the next began; two phases (3 and 4b) each had a
real, independently-discovered gap sent back for a fix-and-retest cycle before
sign-off (§13.3, §13.4). No phase stopped at a scaffold/TODO — every phase landed
production-quality, test-backed code.

### 13.1 Phase-by-phase summary

- **Phase 0+1 — schema + migration + issue model** (combined; same files, no
  reason to split): `PmIssueTypeSchema`, extended `Pm*` schemas, idempotent
  `migrate()`, project key/seq, task number/type/reporter/parentId/watchers,
  hierarchy matrix + parent-cycle check, `deleteTask` orphan/promote,
  `GET /projects/:id/tree`. AC16–AC23 green first pass; no gaps found on review.
- **Phase 2 — custom columns/WIP/transitions**: column CRUD/reorder/delete
  (block/relocate), WIP + transition enforcement with the 422/409 split,
  `pm_add/update/move/delete_column` tools + MCP mirror. AC1–AC8 green first
  pass; SA review confirmed the 422-vs-409 retry distinction is real (dedicated
  mocked-gateway unit tests proving exactly 1 call on 422, 2 on 409).
- **Phase 3 — collaboration backend**: `pm-collab.js`, all comment/activity/
  attachment/notification routes, cascade deletes, watch/unwatch. AC9–AC15 green
  first pass, **but SA review found two real gaps** before sign-off — see §13.3.
- **Phase 4a — workflow/issue-model UI**: column ⋯ menu, WIP badge, transition
  filtering, issue key/type/parent chips, edit-modal fields, List columns.
  Reviewed via direct code read (hierarchy matrix, DOM-safety, 422 handling) +
  an independent live-browser smoke (real gateway, real login, headless
  Chromium) that the reviewer wrote and ran fresh, not reused from the builder's
  own test — no gaps found.
- **Phase 4b — collaboration UI**: notification bell, comments/attachments/
  activity/watch sections in the edit modal. **The reviewer's own independent
  live-browser test found a real gap** the builder's own tests had missed —
  see §13.4.
- **Phase 5 — this section**: full-workspace `typecheck`/`lint`/`build`/`test`
  (all green, only pre-existing unrelated warnings), regression-checked the
  three sibling gateway suites (`test:kanban` 16, `test:fs`, `test:git`) since
  `server.js` was heavily edited, docs updated, this status section written.

### 13.2 Deviation — synchronous `pm-collab.js`, not async + write-queue (OD5)

The plan's OD5 posed "mutex in `pm.js` vs. async route-layer + write-queue" for
the new collaboration stores. **Shipped instead:** `pm-collab.js` is **fully
synchronous** fs (`appendFileSync` for JSONL, `writeFileSync`+`renameSync` for
the bounded notification store), matching the dominant convention already used
by `pm.js`/`kanban.js`/`registry.js`/`push.js` in this gateway. Synchronous calls
in Node's single-threaded event loop cannot interleave (no `await` point
mid-write), so there is no lost-update race and **no write-queue is needed at
all** — this sidesteps the OD5 concern class rather than solving it. Proven
empirically: AC14 fires two comment-POSTs via `Promise.all` and asserts both
persist (list grows by 2, not 1). The only genuinely async part is reading the
raw HTTP upload body (mirroring the existing fs-upload route's chunked-read-
with-cap pattern) — the blob write itself, once buffered, is a plain
`fs.writeFileSync`.

### 13.3 Gap found + fixed — column mutations emitted no activity records

**Found by:** PM+SA code review (reading the actual diff against §4.4's verb
list), not by the builder's own tests. **Symptom:** `column_added`/`wip_set`/
`transition_set`/`column_deleted` were documented as verbs in `pm-collab.js`'s
own comment but never actually emitted anywhere in `server.js` — column create/
rename/WIP-set/transitions-set/reorder/delete were silent in the audit log. A
second, related gap in the same pass: `assignee` never auto-joined
`task.watchers` (contradicting §4.6's stated rule), so the "assigned"
notification only ever reached pre-existing watchers, never a freshly assigned
person. **Fix:** wired `pmCollab.appendActivity` at all four column routes
(capturing pre-mutation state, e.g. the column's name, before it's deleted);
`createTask`/`updateTask` now push a truthy `assignee` onto `watchers` (deduped
against the reporter). **Regression tests added:** AC10b (column CRUD activity)
and AC17b (assignee auto-watch, incl. a real bearer-vs-cookie two-actor
notification proof). Both independently re-verified (fresh test run, not
trusted from the fix report).

### 13.4 Gap found + fixed — attachment activity invisible in the task view

**Found by:** the PM+SA reviewer's own from-scratch live-browser test (real
gateway, real login, headless Chromium) — not mocked, not reused from the
builder's test suite. **Symptom:** the builder's live-stack test asserted
`attached`/`detached` activity existed via the raw API, but never checked it
actually **rendered in the task's Activity list in the browser**. It didn't,
because `attached`/`detached` activity correctly targets `{type:"attachment",
id:attId}` (an attachment is its own entity) — but the frontend's
`renderActivity` filtered strictly on `a.target.id === taskId`, so
attachment-scoped entries were silently excluded from every task's Activity
view, permanently, no matter how many times it reloaded. This was **not** a
staleness bug (a live-refresh fix had already been applied and verified
correct for `commented`/`watched`) — it was a filtering-logic bug uncovered
only once the reviewer clicked through a real browser instead of trusting a
description of expected behavior. **Fix:** `pm-collab.js`'s `appendActivity`
and every task-scoped `server.js` call site now also carry an explicit
`taskId` field (additive; `PmActivitySchema` gained `taskId: z.string()
.optional()`); the frontend filter became `a.taskId === taskId ||
(a.target && a.target.id === taskId)` (backward-compatible with any record
predating the fix). **Regression test added:** AC24 (backend, asserting
`attached`/`detached` carry `taskId`) plus a live-browser re-run by the
reviewer that reproduced the exact original failure and confirmed the fix
(all four verbs — created/commented/attached/watched — now visible in one
modal session without closing/reopening).

### 13.5 `app.html` preservation — verified at every step, not assumed

`apps/terminal/public/pm/app.html` held an **uncommitted, pre-existing** 8-line
`.timeline` CSS block from another author when this work began. Every phase
that touched the file (4a, 4b, and both fix passes) was instructed to `git
diff` the file **before and after every edit** and treat any change to that
block as an error to stop and fix immediately. The reviewer independently
re-checked `git diff -- apps/terminal/public/pm/app.html` after **every** phase
and fix in this build (not just at the end) and confirmed the exact 8 lines
present, byte-for-byte, in every check. Final state: the file grew from its
original ~2128 lines to ~3809 lines, entirely additive (1801 insertions / 101
deletions against the original commit — the 101 "deletions" are Phase 4a's own
in-place edits to code it had itself just added moments earlier in the same
pass, re-confirmed line-by-line against what the reviewer had already read, not
a removal of anything pre-existing).

### 13.6 Final gate results (all independently re-run by the reviewer, not just trusted from agent reports)

- `pnpm --filter @sparklab/terminal-gateway test:pm` → **PASS, 37/37 checks**.
- `pnpm --filter @sparklab/agent-service test` → **86/86 pass**.
- `pnpm --filter @sparklab/terminal-gateway test:kanban` → **16/16** (regression
  guard — `server.js` was heavily edited; Kanban is untouched, D1 held).
- `pnpm --filter @sparklab/terminal-gateway test:fs` / `test:git` → all green
  (further `server.js` regression guards).
- `pnpm -w typecheck` → clean across all 10 workspace packages.
- `pnpm -w lint` → 0 errors (pre-existing, unrelated warnings only — none in any
  file this work touched).
- `pnpm -w build` → both Next.js apps build clean.
- Two independent, from-scratch, real-gateway-and-browser Playwright smokes
  (one per FE phase) written and run by the PM+SA reviewer — not reused from
  the builder's own scripts — to avoid rubber-stamping a builder's self-report.
- `git status`/`git diff --check` clean; **zero commits** made during this build
  (per instruction); `apps/terminal/public/pm/app.html`'s pre-existing 8-line
  `.timeline` block preserved throughout (§13.5).

### 13.7 Known limitations (carried over from §8/§10, still true post-build)

Everything in §8 (deliberately deferred) and the recommendations in §10 remain
exactly as designed — none of the post-v1 deferrals (multi-assignee, per-task
`rev`, cross-project deps, milestones, WIP soft-warn, comment-edit-in-agent,
attachment-upload-via-agent, board-wide comment/attachment count badges or a
"watched" card indicator — the last two deliberately skipped in the FE build
itself to avoid N+1 board-render requests, per §4.9's reasoning) were built.
This is by design, not a gap: they were explicitly out of scope for this pass.

---

### Relationship to `docs/PM-TOOL-PLAN.md`

This plan is a strict, additive superset of the shipped PM v1 described in
`docs/PM-TOOL-PLAN.md`. It **reuses** D1 (separate gateway-owned artifact), D2
(synchronous mutators, no mutex — preserved by keeping collab writes in the async route
layer), D3 (`rev` on move — extended to column reorder), D4 (`taskIds[]` authority —
extended to column relocate), D5 (sprint orthogonality — the model for
hierarchy/status orthogonality), D6 (DAG cycle-check — the model for the parent-chain
check), D10 (shared bearer — all new routes inherit it), D11 (sandbox flags — already
sufficient), and D12 (approval tiers — extended to the new tools). It **resolves** the
D9 column-editing deferral (§3.5). Read `PM-TOOL-PLAN.md` first; this document only adds.
