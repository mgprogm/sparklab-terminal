# Task Master Hub — QA report (Phase 2 + Phase 3 review)

> Reviewed by QA against `docs/TASKMASTER-HUB-PHASE-2-3-SPEC.md` +
> `docs/TASKMASTER-HUB-PLAN.md` (D1-D12, §1e). Diff reviewed: working tree in
> worktree `taskmaster-hub` vs commit `5434cdc` (Phase 0/1 baseline), plus the
> two new untracked files (`taskmaster-hub-dialog.tsx`, `public/taskmaster-hub/app.html`).
>
> **Status: SIGNED OFF after round 2.** Finding 1 (below) was sent to Dev and
> fixed; re-verified independently. Finding 2 is a non-blocking nit, left
> as-is by mutual agreement. Not committed — left for the coordinator/user to
> commit.

## Commands re-run independently (not trusting Dev's self-report)

| Command                                                       | Result                                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @sparklab/agent-service typecheck`             | clean                                                                                                                                                                                              |
| `pnpm --filter @sparklab/agent-service test`                  | 176/176 pass (incl. 9 new Task Master Hub tests)                                                                                                                                                   |
| `pnpm --filter @sparklab/terminal typecheck`                  | clean                                                                                                                                                                                              |
| `pnpm --filter @sparklab/terminal-gateway test:taskmaster`    | 11/11 pass, unchanged — confirms Phase 1 backend untouched                                                                                                                                         |
| `pnpm lint` (full monorepo)                                   | 0 errors, 41 warnings — all in pre-existing files never touched by this feature (agent-chat, auth, browser-view, computer-view, vitest.config.ts); zero warnings in any of the 7 changed/new files |
| `git diff 5434cdc --stat -- packages/ apps/terminal-gateway/` | empty — confirms shared-types and the gateway were NOT touched in Phase 2/3, as D7/D2 require                                                                                                      |

All of Dev's self-reported command results were reproduced exactly.

## What passed

1. **D7 approval tiers — exact match, verified by grep + passing tests, not just comment claims.**
   `WRITE_TOOLS` (apps/agent-service/src/tools.ts:86-90) has all 5 writes
   (`set_status`, `add_dependency`, `add_task`, `update_task`, `expand`).
   `ONE_TIME_TOOLS` (lines 134-136) has exactly the 3 AI-mutation tools
   (`add_task`, `update_task`, `expand`) — `set_status`/`add_dependency` are
   correctly absent from `ONE_TIME_TOOLS`, and all 4 read tools
   (`list_projects`/`list`/`show`/`next`) are absent from both sets. Backed by
   dedicated `tools.test.ts` assertions (not just static analysis).

2. **D7 REST-client-only — verified.** Every one of the 9
   `taskmaster_*` tool implementations in `executeTool()` (tools.ts:2582-2662)
   calls a `gateway.*Taskmaster*()` method; `gateway-client.ts`'s 8 new
   methods (lines 449-597) each hit `/api/taskmaster/*` via `this.call()`/
   `this.json()` — none reads `data/taskmaster-projects.json` or a project's
   `.taskmaster/` tree. Confirmed by reading every line of the diff, not
   sampling.

3. **D9 payload-size discipline in the frontend — verified.** The task list
   view (`renderBucket`/`renderCard` in `app.html`) renders only from
   `GET /projects/:id/tasks` (summary-projected by the gateway already — no
   `details`/`testStrategy` ever reaches this fetch). The detail panel does a
   dedicated fresh `GET /projects/:id/tasks/:taskId` fetch on every open
   (`openDetail`/`loadDetail`, lines 245-246) and shows an explicit "Loading
   full task details…" state rather than mislabeling stale summary data as
   detail.

4. **Security conventions — verified.** `grep -n innerHTML app.html` returns
   only the safety comment at line 8; the entire DOM is built through the
   `elem()` helper (`textContent`-only). The iframe host
   (`taskmaster-hub-dialog.tsx:44`) sets
   `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"` —
   matches the D11-lesson requirement exactly.

5. **UI correctness — verified for everything spec'd:**
   - Two distinct "next task" empty states render different copy
     (`renderNextTile`, app.html:223-231): `hasAnyTasks:true` → "Every task is
     done or blocked — nothing is ready to start."; otherwise → "This tag has
     no tasks yet." — confirmed genuinely different strings, not a shared
     generic message.
   - Tag-switch requires `window.confirm(...)` before firing (app.html:273);
     project removal also requires confirm (line 270).
   - Error responses render via the shared `showBanner`/`handleError` path
     (never a silent failure or console-only throw) — every `.catch()` in the
     file routes through `handleError` or `handleMutationError`.
   - `dependency_cycle` 400s get the specific "This would create a circular
     dependency." banner text (app.html:261), distinct from the generic
     `handleMutationError` path used for other 400s.
   - `504`/`outcome_unknown` timeout responses get a distinct banner + an
     automatic re-fetch of the list/detail, with **no retry button** offered
     (`refreshAfterUnknown`, `handleMutationError`, lines 209-213) — matches
     D11 exactly.
   - Legacy-family detail actions (add-dependency, expand, update-via-prompt)
     are disabled with an explanatory `title` tooltip when
     `binaryMode !== "binary"`; the status dropdown and the project-select's
     binaryMode-aware labeling are correctly NOT gated the same way (core
     family + registry-only reads, per the route table in spec §0).
   - `priority`/`complexity`/dependency badges render nothing for
     null/absent values rather than "null" (`renderCard`, app.html:242).
   - Polling: verified independently (not just taking Dev's word) by reading
     `packages/ui/src/components/ui/dialog.tsx` — `DialogPrimitive.Root` is
     used with no `forceMount`, so Radix fully unmounts `DialogContent` (and
     the iframe inside it) on close. Dev's reasoning holds: the poll interval
     dies with the iframe's JS context; no explicit `clearInterval`-on-close
     is needed, exactly mirroring PM's own `app.html` precedent.
   - Every route in the Phase 2/3 spec's §0 table is wired to a UI control
     **except one** — see Finding 1 below.

## Findings

### Finding 1 (real gap, sent to Dev, FIXED — verified round 2) — no "Add task" UI control

`POST /api/taskmaster/projects/:id/tasks` (add-task, D6's 4th v1 legacy-family
action, already implemented and tested in Phase 1, and exposed as the
`taskmaster_add_task` agent tool in this very PR) has **no corresponding
control anywhere in `public/taskmaster-hub/app.html`**. I grepped the entire
file for `add-task`/`addTask`/a POST to `.../tasks` with a `prompt` body and
found none — confirmed by re-reading the whole file. Every other route in the
spec's §0 table has a wired-up control; this is the only one missing:

| Route                                   | UI control                                          | Status      |
| --------------------------------------- | --------------------------------------------------- | ----------- |
| `GET /projects`                         | project `<select>`                                  | present     |
| `POST /projects`                        | "Add project" form                                  | present     |
| `DELETE /projects/:id`                  | "Remove project" button (bonus, spec said optional) | present     |
| `GET /projects/:id/tasks`               | list/bucket rendering                               | present     |
| `GET /projects/:id/tasks/:taskId`       | detail panel fetch                                  | present     |
| `GET /projects/:id/next`                | next-task tile                                      | present     |
| `POST .../status`                       | status dropdown + next-tile quick action            | present     |
| `GET .../tags`                          | current-tag label                                   | present     |
| `POST .../tags/use`                     | "Switch tag" form                                   | present     |
| **`POST .../tasks` (add-task)**         | **none**                                            | **MISSING** |
| `PATCH .../tasks/:taskId` (update-task) | "Update via prompt" textarea                        | present     |
| `POST .../tasks/:taskId/expand`         | "Expand" button                                     | present     |
| `POST .../dependencies`                 | "Add dependency" mini-form                          | present     |

Root cause: SA's Phase 2/3 spec §2.4 never described a "create new task" form
in either the top-bar or detail-panel sections (spec gap, not just a Dev
oversight) — but the plan's own premise (§0: "the Hub gives one dashboard...
exposes the same operations as agent tools") and D6's explicit v1 action list
both include add-task as a first-class Hub capability. A human using the Hub
today cannot create a task at all; only the agent chat's `taskmaster_add_task`
tool can. This is a real, user-visible functional gap, not a nit — flagged to
Dev to add a small form (prompt textarea + optional priority select + optional
dependencies) mirroring the existing "Add project"/"Update via prompt" form
patterns already in the file, most naturally placed as a header action on the
task list panel (`.tasks` column) or beside the "Next task" tile.

**Round 2 fix, verified.** Dev added a static `#add-task-panel` block
(app.html:126-136, sibling of `#content`, matching the `#project-form`/
`#tag-form` pattern already in the file) with a "+ Add task" button, a
prompt textarea, an optional priority select, and a comma-separated
dependencies input. Verified independently by re-reading the whole file:

- **The form is built once, not on every render.** Unlike the first Codex
  pass (which Dev caught and had fixed before sending back — the form was
  originally rebuilt inside `renderContent()`, which runs every 5s poll
  tick, silently resetting any half-typed prompt), the current version's
  form lives in static HTML with listeners attached once at script-load
  time (`el.addTaskBtn`/`el.addTaskForm` listeners, lines 294-307). Confirmed
  `renderContent()` (lines 235-242) touches only `el.content`'s subtree —
  `#add-task-panel` is a sibling `<div>` outside `#content`, so no render
  path can touch it.
- **Gating is non-destructive.** `renderAddTaskGate()` (lines 187-192, called
  everywhere `renderTag()` already is — project switch, every poll tick,
  tag-switch success) only toggles `.hidden` on the panel and `.disabled` on
  the four form controls plus a binary-note string — it never touches
  `.value` on any input, so typed text survives repeated poll-triggered
  calls to this function.
- Panel is hidden entirely (`classList.toggle("hidden", !state.project)`)
  when no project is selected; shown-but-disabled with "Requires the
  task-master binary" when `binaryMode !== "binary"` — matches the same
  convention as the other three legacy-family detail-panel actions.
- Submit handler (lines 296-307) builds `{prompt, priority?, dependencies?}`
  correctly (empty priority/deps omitted via spread, matching the request
  schema's `.optional()` fields), routes success through
  `state.tasks = response.tasks || []` + `renderContent()` (immediate UI
  update, matching the documented `POST .../tasks` → `{tasks:[...]}` summary
  response shape) and failure through the existing `handleMutationError`
  (so a `504`/`outcome_unknown` timeout on `add-task` gets the same
  no-blind-retry treatment as the other AI-mutation actions).
- `grep -n "renderAddTaskControl|innerHTML" app.html` confirms the old
  destructive function is gone and no new `innerHTML` was introduced.
- Re-ran all four verification commands after the fix — all still green
  (`terminal` typecheck clean, `agent-service` 176/176, gateway
  `test:taskmaster` 11/11) — and `git status`/`git diff --stat` confirm only
  `app.html` changed in this round; no other file was touched.

One caveat carried forward from Dev's own report and not resolved by either
of us: **no live-browser click-through was performed on this specific fix**
(no browser tooling available in this session either). The "typing survives
a real 5-second poll" claim rests on tracing the render/event call graph by
hand — solid static-analysis evidence (the code paths that would cause the
bug are demonstrably absent), but not an observed interaction. Recorded as a
known gap for whoever next has real browser access to this environment,
consistent with the rest of this feature's testing plan (§6 of the plan doc
already calls for one real-CLI/real-ssh smoke test that hasn't been run
either — pre-existing scope, not introduced by this round).

### Finding 2 (nit, non-blocking) — `ToolArgs.depends_on` type widened to `string[] | string`

To reuse the existing `depends_on` field name for `taskmaster_add_dependency`
(which is a single task id per its own JSON schema:
`depends_on: {type:"string"}`), Codex widened the shared `ToolArgs.depends_on`
field from `string[]` to `string[] | string` and added `as string[]` casts at
the two pre-existing PM call sites (`pm_add_task`/`pm_update_task`,
tools.ts ~2390/2418). This is a compile-time-only assertion with no runtime
narrowing: if a model ever called a PM tool with a malformed single-string
`depends_on` (schema still declares `array` for PM, so this should not happen
in practice, but the type system can no longer catch it), the cast would
silently let a wrong-shaped value flow into the PM gateway call. Separately,
`taskmaster_add_dependency`'s own executor uses
`dependsOn: String(args.depends_on)` — if `args.depends_on` ever arrived as an
array (again, shouldn't happen per its own scalar schema, but nothing
enforces it at the `ToolArgs` level since the field is now shared and unioned)
`String([...])` would silently join with commas rather than fail loudly.

Recommendation (not blocking): give `taskmaster_add_dependency` its own field
name (e.g. `dependency_id`) in `ToolArgs` instead of overloading `depends_on`,
removing the need for the two `as string[]` casts and the ambiguous union
type. Low severity — both real call paths are currently correct and fully
tested (176/176 including the new dependency-cycle fetch-stub test) because
the JSON-schema-declared type per tool is correct in both directions; this is
a maintainability/type-safety observation, not an observed bug.

### Not a finding — items explicitly deferred by spec, correctly omitted

- No `num` (target subtask count) input on the Expand form — the Phase 2/3
  spec's own UI prose (§2.4) only described a research checkbox, not a `num`
  control, so this is spec-compliant, not a gap. The route/tool both already
  accept `num`; only the UI control is absent, consistent with what was
  asked.
- No live-browser manual smoke test was performed by Dev or by QA in this
  round (no browser tooling available in either session) — the D9
  polling-stops-on-close claim was instead verified by reading Radix's
  `Dialog.Root` semantics directly (see "What passed" above), which is solid
  evidence but not the same as an observed Network-tab trace. Flagging as an
  open item for whoever next has real browser access to this environment.

## Disposition — SIGNED OFF

Finding 1 was sent to Dev (round 1) and fixed correctly (round 2, verified
above): the "Add task" UI now exists, is wired to the correct route/response
shape, is binaryMode-gated like the other legacy-family actions, and — the
part that actually required a second Codex pass — does not lose typed input
to the 5-second poll because the form is static markup outside the
poll-rebuilt `#content` subtree. Finding 2 (the `ToolArgs.depends_on` type
widening) was left as a documented, non-blocking nit by mutual agreement —
both real call paths are correct today; it's a maintainability observation
for a future pass, not a shipped bug.

All required verification commands were re-run independently after the fix
and are green: `@sparklab/agent-service` typecheck + 176/176 tests,
`@sparklab/terminal` typecheck, `@sparklab/terminal-gateway` `test:taskmaster`
11/11, full-monorepo `pnpm lint` 0 errors. `git status`/`git diff --stat`
confirm the only file touched in round 2 was `app.html`.

**Known gap carried forward (not blocking, not introduced by this review):**
no live-browser manual smoke test has been performed on the artifact by
anyone in this pipeline (SA/Dev/QA) — none of the three sessions had browser
tooling available. Everything above was verified by re-running the automated
suites and by hand-tracing the actual code (reading Radix's `Dialog.Root`
source for the polling-stops-on-close claim; reading the full render/event
call graph for the add-task fix). This matches the level of confidence the
plan doc's own §6 anticipates needing supplementing with ("one real-CLI,
real-ssh-to-localhost smoke test") — that live smoke test was never in this
review's scope and remains open. Recommend whoever next has real browser
access do one click-through pass (register a project, list tasks, add a
task, open detail, change status, switch tags, confirm polling behavior)
before this ships to real users, but nothing in static review contradicts
correctness.

This feature (Phase 2 + Phase 3, uncommitted in the worktree) is ready to
commit from a code-review standpoint.

## Addendum — live-browser verification (coordinator, post-signoff)

The known gap above (no live click-through) was closed before commit. Ran a
real Next.js dev server + gateway from this worktree (`TASKMASTER_COMMAND`
pointed at a genuine `npm install -g --prefix <scratch>` binary, not the npx
fallback) against the actual seeded `~/workspaces/samples/claude-task-master`
project, driven via the `dev-browser` skill (headless Chromium):

- Registered a project through the real "Add project" form; the `binaryMode`
  probe correctly detected `binary` vs. a separately-registered project
  pointed at the same path with no `task-master` on `$PATH` (`core-only-npx`,
  UI correctly labeled it "read-only" and gated `+ Add task`/tag-switch with
  "Requires the task-master binary").
- List view rendered real production data: 6 pending tasks with correct
  priority/deps/blocks/complexity chips, the Next-task tile showing the real
  ready task (`11.3`), tag correctly shown as `loop`.
- Opened a task card → detail panel fetched and rendered full `details`
  (long markdown, code blocks) on demand — confirms D9 (the list view itself
  never carried this payload) end to end, not just by source inspection.
- Status `<select>` in the detail panel pre-selected the task's real current
  status correctly.

**One real finding, not a code bug:** the live `task-master` CLI process
(even the "real binary" path, an `npm install -g --prefix` install with 851
packages) took 10-20+ seconds per invocation to spawn under this loaded dev
machine — long enough that a naive 3-4s test wait made the list look
permanently empty before the network trace (`page.on("response")`) proved
the request was simply still in flight, not failed or dropped. The UI's own
"Loading full task details…" state and the fact nothing errors while pending
means this degrades gracefully, but it's worth recording: this CLI's cold
per-invocation latency is real and non-trivial, distinct from any gateway
timeout logic (`TASKMASTER_TIMEOUT_MS` default 120s comfortably covers it).
No code change made in response — flagging for awareness, not a regression.

Cleanup: temporary dev gateway/terminal/dev-browser processes stopped after
verification; the main checkout's actual running services (ports 3107/3110)
were never touched.
