# Project Management tool (pluggable HTML artifact) — Design & Implementation Plan

> Status: **designed, not yet implemented** (2026-07-27). Scope: a **Kanban-first
> project-management suite** shipped as a **separate** pluggable HTML artifact
> alongside the existing Kanban board (its own `/api/pm/*`, `data/pm.json`, modal,
> agent tools, and MCP server — Kanban is untouched). One task model, **four
> views**: Board (primary) · List/table · Timeline/**Gantt with dependencies** ·
> Sprints. Reuses every pattern validated for Kanban (`docs/KANBAN-PLAN.md`):
> gateway-owned sidecar, synchronous mutators (no mutex), per-project `rev`
> optimistic concurrency, `Column.taskIds[]` as the sole ordering authority,
> same-origin sandboxed-iframe host seam.

A "project" is a set of ordered status columns (Backlog/To Do/In Progress/Done)
holding **tasks**. A task is richer than a Kanban card — assignee, priority,
labels, start/due dates, an optional sprint, and **dependencies on other tasks**.
The four views are projections of that one model. The PM tool is deliberately a
**separate artifact** (user's choice): it re-implements its own board view rather
than sharing Kanban's — a conscious duplication, not accidental copy-paste.

---

## 0. Grounding (verified against source — reuse, don't reinvent)

The PM tool is a structural clone of the shipped Kanban feature with a richer
model. Anchors it mirrors:

- **Sidecar store**: `apps/terminal-gateway/src/kanban.js` — module `store`, `load()`
  at bottom, atomic `persist()` (`writeFileSync(TMP)`+`renameSync`), synchronous
  mutators (atomic ⇒ no mutex), per-board `rev`, `KANBAN_FILE` test override.
  `src/pm.js` is the same shape with `PM_FILE`.
- **Routes**: `src/server.js` `handleKanban(req,res,url)` + the dispatch/auth-gate
  wiring (`parts[1]==="kanban"`), `readJsonObject`, coded-error→HTTP mapping
  (`not_found`→404, `stale`→409, else 400). `handlePm` mirrors it.
- **Bearer auth**: `isKanbanBearerAuthorized` + the `KANBAN_API_TOKEN` env. D10
  generalizes this to a shared helper without renaming the live var.
- **Schemas**: `packages/shared-types/src/terminal.ts` `Kanban*` block + `index.ts`
  barrel. Add a `Pm*` block the same way.
- **Agent tools**: `apps/agent-service/src/tools.ts` (`TOOLS`, `WRITE_TOOLS`,
  `ONE_TIME_TOOLS`), `describeCall`, `executeTool`; `gateway-client.ts` `call()`.
- **MCP**: `tools/kanban-mcp/server.mjs` (dep-free stdio JSON-RPC). `tools/pm-mcp/`
  mirrors it.
- **Frontend host**: `components/kanban-dialog.tsx` (sandboxed iframe),
  `terminal-shell.tsx` button + `useUrlFlagSync`, `store.ts` ephemeral flag,
  `public/kanban/app.html`. PM adds the `pm-*` siblings.
- **Test harness**: `test/kanban-endpoints.js` (`test:kanban`). `test/pm-endpoints.js`.

---

## 1. Architectural decisions (settled before implementation)

**D1 — Separate artifact, gateway-owned.** New `/api/pm/*`, `data/pm.json`, modal,
agent tools, and MCP — Kanban stays exactly as shipped. Per the user's "แยกเป็น
artifact ใหม่" choice. Consequence (named, accepted): the PM board view is a
**re-implementation**, not a shared component.

**D2 — Storage: `data/pm.json` sidecar.** `src/pm.js`, atomic write, `PM_FILE`
override for tests. Synchronous mutators ⇒ each read-modify-write is atomic; **no
mutex** (same reasoning as Kanban).

**D3 — Concurrency, explicitly scoped.**

- **`move` is `rev`-guarded** (per-project `rev`; stale → `409 {error:"stale",
project}`), because board reordering is the high-contention path (human drag/
  click + agent + CLI).
- **Field/dependency/sprint edits are last-writer-wins** (no `rev`). Acceptable
  for v1, but stated as a decision: "two clients edited the same task" resolves
  to last write. Revisit if it becomes a visible problem (post-v1: per-task
  `rev`).

**D4 — Single ordering authority: `Column.taskIds[]`.** A task's **status = which
column holds it** (derived on GET as `columnId`/`status`); the task stores **no**
`status` and **no** `order`. This is the load-bearing Kanban lesson — never two
sources of truth for position.

**D5 — Sprints are orthogonal to status.** `task.sprintId` is a real stored field
(nullable). A task can be In Progress **and** in Sprint 14. **Backlog = `sprintId:
null`.** The Sprints view groups by `sprintId`; it does not touch columns.

**D6 — Dependencies are a per-project DAG.**

- `task.dependsOn: string[]` — ids of other tasks **in the same project**.
- A create/update that would introduce a **cycle** is rejected `400
{error:"dependency cycle"}` (synchronous graph walk — does not affect the
  no-mutex reasoning).
- **Deleting a task scrubs its id from every other task's `dependsOn`** (same
  class as Kanban's `cardIds` cleanup) — no dangling edges, ever.
- Cross-project dependencies are out of scope (v1).

**D7 — Gantt vehicle: dependency-free raw SVG (the one decision that gates code).**
The artifact must stay a **zero-build, self-contained HTML file** (CSP blocks all
CDNs; no bundler). A full Gantt library is therefore off the table for v1. The v1
Gantt is hand-rolled and deliberately bounded:

- Horizontal bars on a date grid, one row per **scheduled** task (has `startDate`
  **and** `dueDate`), grouped by sprint then column.
- **Straight** predecessor→successor connector lines (absolute-positioned SVG);
  no routing/orthogonal elbows.
- Sprint start/end drawn as vertical markers.
- **No** auto-scheduling, **no** drag-to-resize/reschedule, **no** critical-path.
- **Date-less tasks** (missing start or due) render in an **"Unscheduled" tray**
  below the chart, never on the timeline. A dependency arrow with a date-less
  endpoint is **listed textually on the task**, not drawn (nothing to point at).
  Gantt is the hard part and gets **its own implementation checkpoint** (phase 5).

**D8 — Four views over one model.** Board (default, click-to-move dropdown — **no
drag in v1**, per Kanban), List/table (client sort+filter), Timeline/Gantt (D7),
Sprints (backlog + per-sprint lists). A top-bar view switcher; the selected view
is the only thing that changes.

**D9 — Fixed default columns in v1; column editing deferred.** Seeds Backlog/To Do/
In Progress/Done. Deferring column edit sidesteps "what happens to a column's tasks
when it's deleted" for v1 (reuses the Kanban decision).

**D10 — Auth: generalize the bearer without renaming the live token.** A shared
`isArtifactBearerAuthorized(req)` accepts `process.env.GATEWAY_API_TOKEN ||
process.env.KANBAN_API_TOKEN` and is used by **both** `/api/kanban/*` and
`/api/pm/*`. The already-deployed `KANBAN_API_TOKEN` keeps working unchanged
(**explicit test assertion**); `GATEWAY_API_TOKEN` is the new preferred name that
covers both artifacts. No live secret is renamed.

**D11 — Host seam + sandbox from v1.** `pm-dialog.tsx` renders
`<iframe src="/pm/app.html" sandbox="allow-scripts allow-same-origin allow-forms
allow-modals">`. `allow-forms`/`allow-modals` are included **from the start** (the
artifact has forms + `window.confirm()` deletes — the exact gap that bit Kanban).

**D12 — Agent approval tiers (per Kanban D9).** Reads auto; routine writes
(`pm_create_project`, `pm_add_task`, `pm_update_task`, `pm_move_task`,
`pm_add_sprint`) approvable **allow-always**; **`pm_delete_project` coerced
one-time** (in `ONE_TIME_TOOLS`). No task-delete agent tool wired if we want to keep
destructive surface minimal — TBD in phase 2 (see §9).

---

## 2. Data model (`data/pm.json`)

```jsonc
{
  "projects": {
    "pm-<uuid>": {
      "id": "pm-<uuid>",
      "name": "Payments service",
      "tags": ["backend"],
      "rev": 12,
      "createdAt": 0,
      "updatedAt": 0,
      "columns": [
        // status + ordering authority (D4)
        { "id": "col-<uuid>", "name": "Backlog", "taskIds": ["task-a"] },
        { "id": "col-<uuid>", "name": "To Do", "taskIds": [] },
        { "id": "col-<uuid>", "name": "In Progress", "taskIds": ["task-b"] },
        { "id": "col-<uuid>", "name": "Done", "taskIds": [] },
      ],
      "sprints": [
        // orthogonal to columns (D5)
        {
          "id": "spr-<uuid>",
          "name": "Sprint 14",
          "startDate": 0,
          "endDate": 0,
        },
      ],
      "tasks": {
        // map by id; NO status / NO order (D4)
        "task-a": {
          "id": "task-a",
          "title": "…",
          "description": "",
          "assignee": "lek",
          "priority": "high", // low|medium|high|urgent (or omitted)
          "labels": ["api"],
          "startDate": 0,
          "dueDate": 0, // epoch ms, nullable (Gantt)
          "sprintId": "spr-<uuid>", // nullable → backlog
          "dependsOn": ["task-b"], // DAG, same project (D6)
          "createdAt": 0,
          "updatedAt": 0,
        },
      },
    },
  },
}
```

`getProject()` returns tasks as an **array**, each with a **derived** `columnId`
(and `status` = column name); `columnId`/`status`/`order` are never persisted.
(Reuses the Kanban wire-shape lesson: cards/tasks are an array on GET, not a map.)

`src/pm.js` API: `load`, `listProjects`, `getProject`, `createProject`,
`updateProject`, `deleteProject`, `createTask`, `updateTask` (fields + `dependsOn`,
cycle-checked), `moveTask` (`expectedRev`), `deleteTask` (scrubs `dependsOn`),
`createSprint`, `updateSprint`, `deleteSprint` (nulls affected `sprintId`).

---

## 3. Backend endpoints (`/api/pm/*` in `server.js` via `handlePm`)

Auth = cookie **or** shared bearer (D10). GET Origin-exempt; writes Origin/CSRF-checked.

### Read (GET — Origin-exempt)

| Route                      | Returns                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `GET /api/pm/projects`     | `{ projects: PmProjectSummary[] }`                            |
| `GET /api/pm/projects/:id` | full `PmProject` (columns, sprints, tasks[+derived columnId]) |

### Write (Origin/CSRF-checked)

| Route                                   | Body                                                                                                           | Result                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `POST /api/pm/projects`                 | `{name, tags?, columns?}`                                                                                      | 201 project                            |
| `PATCH /api/pm/projects/:id`            | `{name?, tags?}`                                                                                               | 200 project                            |
| `DELETE /api/pm/projects/:id`           | —                                                                                                              | 204                                    |
| `POST /api/pm/projects/:id/tasks`       | `{title, description?, assignee?, priority?, labels?, startDate?, dueDate?, columnId?, sprintId?, dependsOn?}` | 201 task (cycle→400)                   |
| `PATCH /api/pm/tasks/:id`               | `{projectId, …any field, dependsOn?}`                                                                          | 200 task (cycle→400)                   |
| `POST /api/pm/tasks/:id/move`           | `{projectId, toColumnId, toIndex, rev}`                                                                        | 200 project / 409 `stale`              |
| `DELETE /api/pm/tasks/:id?projectId=`   | —                                                                                                              | 204 (scrubs `dependsOn`)               |
| `POST /api/pm/projects/:id/sprints`     | `{name, startDate?, endDate?}`                                                                                 | 201 sprint                             |
| `PATCH /api/pm/sprints/:id`             | `{projectId, name?, startDate?, endDate?}`                                                                     | 200 sprint                             |
| `DELETE /api/pm/sprints/:id?projectId=` | —                                                                                                              | 204 (affected tasks → `sprintId:null`) |

Errors: 400 (validation / **dependency cycle**), 401, 403, 404, 409 `stale`, 413.

### Zod schemas — add to `packages/shared-types/src/terminal.ts` (`Pm*` block)

`PmPrioritySchema` (`z.enum(["low","medium","high","urgent"])`), `PmTaskSchema`,
`PmColumnSchema`, `PmSprintSchema`, `PmProjectSchema`, `PmProjectSummarySchema`,
`PmListResponseSchema`, `CreateProjectRequest`, `UpdateProjectRequest`,
`CreateTaskRequest`, `UpdateTaskRequest`, `MoveTaskRequest`
(`{projectId,toColumnId,toIndex:int≥0,rev:int}`), `CreateSprintRequest`,
`UpdateSprintRequest` — each with its `z.infer` type; re-export via `index.ts`.

---

## 4. AI access

### 4a. In-app agent (`tools.ts` + `gateway-client.ts`)

Tools: `pm_list_projects`, `pm_get_project`, `pm_create_project`,
`pm_delete_project`, `pm_add_task`, `pm_update_task` (fields + `set dependencies`),
`pm_move_task`, `pm_add_sprint` (+ `pm_delete_task` — see §9). Approval per **D12**.
`pm_move_task` fetches the project `rev` itself and retries once on 409 (model
never manages `rev`). `describeCall` + `executeTool` case per tool; `tools.test.ts`
asserts presence, schemas, and approval tiers.

### 4b. External AI — MCP (`tools/pm-mcp/server.mjs`) + REST

A dep-free stdio MCP server mirroring `tools/kanban-mcp/`, exposing the same tool
set over the shared bearer (`GATEWAY_API_TOKEN`/`KANBAN_API_TOKEN`), `PM_BASE_URL`.
README with `claude mcp add pm …` + `~/.codex/config.toml`. Plain REST remains
available for `curl`.

---

## 5. Frontend

- **Store** (`store.ts`): `pmOpen` + `setPmOpen`, ephemeral (persist-excluded, like `kanbanOpen`).
- **Button** (`terminal-shell.tsx`): ghost icon (lucide `SquareGanttChart`) beside
  the Kanban button, always enabled (gateway-global). `useUrlFlagSync("pm", …)`.
- **Modal** (`components/pm-dialog.tsx`): controlled `Dialog`, large content, the
  D11 sandboxed iframe → `/pm/app.html`.
- **Artifact** (`apps/terminal/public/pm/app.html`): one self-contained file, zero
  external requests, DESIGN.md palette. Top bar: project switcher + **view switcher
  (Board · List · Timeline · Sprints)** + New project. Views:
  - **Board**: columns with task cards (title, assignee chip, priority flag, due
    date, labels, dep-count badge); click-to-move dropdown; add/edit/delete task
    (edit modal covers all fields incl. sprint + a dependency multiselect).
  - **List**: sortable/filterable table (title, status, assignee, priority, due,
    sprint, #deps).
  - **Timeline/Gantt** (D7): SVG bars + straight dep connectors + Unscheduled tray.
  - **Sprints**: Backlog (`sprintId:null`) + one lane per sprint; move task between
    lanes = set `sprintId` (a field edit, LWW — not `rev`-guarded).
    All fetches relative `/api/pm/*` (same-origin, cookie carried); `textContent`-only
    DOM; inline error banner on non-2xx / 401.

---

## 6. Phased implementation checklist

1. **Backend** — `pm.js` store, `Pm*` schemas, `handlePm` routes (projects, tasks,
   move, dependencies+cycle, sprints), shared bearer helper (D10).
2. **`test/pm-endpoints.js`** (`test:pm`) — gate before UI (see §7).
3. **Agent tools** — `gateway-client.ts` methods, `tools.ts` (D12), `describeCall`,
   `executeTool`, `tools.test.ts`.
4. **MCP** — `tools/pm-mcp/server.mjs` + README; end-to-end test vs live gateway.
5. **Frontend host + artifact** — store/button/modal + `app.html` with **Board +
   List + Sprints + task fields/dependencies editing** (no Gantt yet). **Checkpoint.**
6. **Gantt view** (D7) — SVG bars + dep connectors + Unscheduled tray. **Own
   checkpoint** (highest UI risk).
7. **Docs + deploy** — `TERMINAL-PROTOCOL.md`/`AGENT-PROTOCOL.md`/`CLAUDE.md`;
   `build-prod.sh` + **restart prod-gateway** (new routes) + prod-agent.

## 7. Testing (`test/pm-endpoints.js`, `test:pm`)

Standalone node script (real gateway, `throw` asserts, PASS/FAIL). Cases: project/
task CRUD; **move splice + rev/409**; **dependency cycle → 400** (A→B→A rejected);
**task delete scrubs `dependsOn`** from other tasks; sprint CRUD + **orthogonality**
(task keeps its column when sprint changes; sprint delete nulls `sprintId`); date-less
task accepted (Gantt-tray path); CSRF (foreign Origin → 403 write, GET exempt);
**bearer — both `GATEWAY_API_TOKEN` AND the legacy `KANBAN_API_TOKEN` authorize
`/api/pm`** (D10 regression guard); 404s; 413. Plus `tools.test.ts` for the new
tools. Live artifact smoke (phase 5/6) loads `app.html` **inside a sandboxed iframe**
matching prod (not a bare page — the gap that hid Kanban's sandbox bug).

## 8. Deliberately deferred (post-v1)

Auto-scheduling / critical path / drag-resize Gantt; per-task `rev` (collision UX);
multi-assignee; comments / activity log / attachments; column editing & custom
statuses; cross-project dependencies; custom fields; recurring tasks; real-time push
of project changes; WIP limits; saved List filters; a unified multi-artifact host
registry (still one artifact per seam).

## 9. Open decisions worth confirming before build

- **`pm_delete_task` agent tool** — include it (agent can delete tasks, one-time
  approval) or keep task-deletion human-only in the UI like Kanban's cards? (Plan
  leans human-only; easy to add.)
- **Milestones** — the picked shape (A) didn't include milestones; a sprint's
  `endDate` marker covers most of it. Add a first-class `milestone` flag on tasks in
  v1, or defer? (Plan defers; Gantt shows sprint markers.)
- **Date input granularity** — day-level dates (store as epoch ms at 00:00 UTC) vs
  full timestamps. (Plan: day-level.)

## Critical files

- `apps/terminal-gateway/src/pm.js` — **new** store (mirrors `kanban.js`).
- `apps/terminal-gateway/src/server.js` — `handlePm` + shared bearer helper (D10).
- `apps/terminal-gateway/test/pm-endpoints.js` — **new** `test:pm`.
- `packages/shared-types/src/terminal.ts` + `index.ts` — `Pm*` schemas/types.
- `apps/agent-service/src/tools.ts`, `gateway-client.ts` — `pm_*` tools (D12).
- `tools/pm-mcp/server.mjs` + `README.md` — **new** MCP server.
- `apps/terminal/src/features/terminal/components/pm-dialog.tsx` — **new** host modal.
- `apps/terminal/public/pm/app.html` — **new** the PM artifact (4 views).
- `apps/terminal/src/features/terminal/{store.ts,components/terminal-shell.tsx}` — flag + button.
