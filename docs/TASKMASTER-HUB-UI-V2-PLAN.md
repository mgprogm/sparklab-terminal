# Task Master Hub — UI v2 Brainstorm & Plan

> Status: **Phase A built and verified (2026-09-05), uncommitted.** Human
> claim/progress/release controls, relative-time + stale-claim styling, a
> consistent in-flight label on every async button, and a static client-side
> task filter were added to `apps/terminal/public/taskmaster-hub/app.html`.
> Verified end-to-end against a temporary, isolated gateway+frontend stack
> (stubbed `task-master` binary, scratch data files) via the `dev-browser`
> skill: claim → review → blocked (+note) → release cycle, the
> `dependencies_unmet`/blocked-note-required banners, the read-only view for
> a claim held by another agent, the stale-claim visual past 80% of the
> client-side TTL estimate, and the filter surviving a live 5s poll tick
> with focus and value intact.
>
> **Addendum (same day):** the Next Task tile also gained a subtask
> progress indicator — a `done/total` percentage chip next to the task id
> and a small color-coded grid (one cell per subtask, native `title`
> tooltip per cell) below the title. Designed by a forked design-teammate
> agent (grounded in the real summary-vs-full data split and the 5s poll
> constraint), reviewed and implemented by the coordinator, and verified via
> the same isolated dev-browser stack: correct percentage math, correct
> per-status cell coloring, correct tooltip content, and exactly one detail
> fetch per next-task id across multiple poll ticks (no refetch storm).
> This was a feature addition, not part of the original Phase A scope.
>
> Phases B/C below remain unbuilt. Extends
> [`TASKMASTER-HUB-PLAN.md`](./TASKMASTER-HUB-PLAN.md) (CLI compatibility,
> data model, v1 build record) and
> [`TASKMASTER-HUB-OPERATIONS.md`](./TASKMASTER-HUB-OPERATIONS.md) (the
> current agent work protocol and its own "Current limitations and roadmap"
> section, which this doc cross-references rather than duplicates). Scope
> here is the Hub's UI only — no new backend primitive is proposed; every
> Phase A item below is a thin frontend layer over routes that already exist.

## 0. Correction note

This plan started as a three-persona chat brainstorm (Agent UX / Project
Manager / Multi-agent collaboration design). Verifying the brainstorm against
the actual working tree before writing it up found the brainstorm's premise
wrong in three places, all corrected in §1 below: the claim/execution system
is not a stub (a real gateway-owned primitive already exists), the status
buckets are not stacked full-width (a 6-column grid already exists in the
uncommitted working tree), and priority/complexity/dependency badges are
already on the bucket cards, not only in the detail view. The screenshot used
during the brainstorm predated the current working tree's reformat. The
phased plan in §4 reflects the corrected picture, not the original chat
message.

---

## 1. Verified current state (source-read, 2026-09-05)

- **Dialog host** (`taskmaster-hub-dialog.tsx`, uncommitted WIP): near-fullscreen
  (`h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)]`), sandboxed iframe, same
  pattern as Kanban/PM/Notes.
- **Topbar**: project switcher across registered `{server, path}` projects,
  Remove project, current-tag display + Switch tag (confirm action), Add
  project. `+ Add task` is gated by `binaryMode` (disabled with no live
  reason text for `core-only-npx` read-only projects — see Phase A).
- **Overview panel**: a 3×2 stat grid (tasks/ready/in-progress/blocked/done/
  active agents) plus a plain-text line per active execution — `taskId ·
role · agentName · tool · status`, or "No agent has claimed a task." This
  is real data (`state.overview.executions`), not a placeholder string.
- **Next-task tile**: shows the next actionable task with a "Set
  in-progress" button, or an explicit empty state.
- **Status buckets are already a 6-column CSS grid** (`.status-stack {
display: grid; grid-template-columns: repeat(6, minmax(260px, 1fr));
overflow-x: auto; }`) — Ready / Pending / In-progress / Review / Done /
  Other (deferred+cancelled+blocked, with its own status filter dropdown),
  side by side with horizontal scroll if the viewport is narrower than
  ~1600px.
- **Cards already carry**: task id, status chip, a claimed-by chip (`role ·
agentName · tool · status`) when an execution exists for that task,
  priority chip, a `blocks N` chip, a complexity chip, and a dependency
  list. Clicking opens the detail overlay.
- **Detail overlay**: status `<select>` (posts to `/tasks/:id/status`),
  dependencies, `details`/`testStrategy` text, subtasks list, and
  binary-gated legacy actions (Add dependency, Expand with a Research
  checkbox, Update via prompt).
- **Polling**: `setInterval(refreshProjectData, 5000)` re-fetches
  tasks/next/tags/overview and calls `renderContent()`, which wipes and
  rebuilds the whole `.hub` subtree. Existing stateful controls (the Other
  bucket's status filter, the detail status `<select>`) already survive
  this because they re-derive their displayed value from `state.*` on every
  render rather than holding transient DOM state — **any new control that
  commits its value to `state` immediately follows this pattern safely; a
  control that holds uncommitted free-typed input (like the historical
  Add-task regression QA caught) does not, and needs the same fix that got
  applied there.**
- **Backend claim/execution system is real, not a stub**
  (`apps/terminal-gateway/src/taskmaster-execution.js` + routes in
  `server.js`): atomic claim (409 on conflict, 409 on unmet dependencies,
  409 on non-actionable status), a status-transition allowlist
  (`working ↔ blocked ↔ review` only; `blocked` requires a non-empty note),
  release, and TTL-based auto-expiry (`TASKMASTER_CLAIM_TTL_MS`, default 30
  minutes). Routes: `POST /api/taskmaster/projects/:id/tasks/:taskId/claim`
  (body: `agentId` required, `agentName`/`agentRole`/`agentTool` optional),
  `PATCH`/`DELETE .../tasks/:taskId/execution` (body: `agentId` required;
  PATCH also takes `status`/`note`). Reaching `done` releases the claim via
  the normal task-status route (`releaseForTask`), not the execution route.
  Every execution record carries `claimedAt` and `updatedAt` timestamps —
  already available to the frontend, unused today.
- **Agent Chat already enforces this protocol**: claim required before
  `run_command`/`type_text`/`press_keys`/`run_codex`, bound to the
  persisted Agent Chat identity `chat-<chatId>` (per
  `TASKMASTER-HUB-OPERATIONS.md`).
- **The gap that is real** (stated in `TASKMASTER-HUB-OPERATIONS.md`'s own
  "Current limitations and roadmap," confirmed by reading `renderDetail`/
  `renderOverview`/`renderCard`): the Hub UI only _displays_ execution
  state — there is no button anywhere in `app.html` for a human to claim,
  update progress on, or release a task. Agent Chat's identity is a fixed
  default (`Developer · Agent Chat`); there is no per-role selection or
  external-CLI claim wrapper; there is no credential-to-owner binding
  (flagged there as a security follow-up); and there is no cross-project
  rollup, bulk operation, real-time push, or saved filter anywhere.
- **A reusable actor-resolution helper already exists server-side**:
  `actorOf(req)` in `server.js` returns `user:<GATEWAY_AUTH_USER>` for a
  cookie-authenticated request or `client:<X-PM-Actor>`/`client:bearer` for
  a scoped-bearer request — already used for PM's `reporter` field. Directly
  reusable if a Hub-originated claim should be labeled by the real
  configured username instead of a fixed string (see D1).
- **Known, unrelated, still-true constraints** (from the v1 QA pass): CLI
  invocations take 10–20+ seconds under load; `binaryMode:
"core-only-npx"` projects are read-only for every legacy-family action.

---

## 2. Three perspectives, revised against the verified state

**Agent UX** — the 10–20s CLI latency still has no consistent "in flight"
language (disable-while-pending exists, a visible spinner does not); the
6-column grid can require horizontal scroll below ~1600px width, which is a
real but width-dependent concern, not a stacked-layout problem; gated
actions should say why they're disabled at the point of failure, not rely on
the topbar state alone.

**Project Manager** — badges (priority/complexity/blocks) are already on
every card, so triage-without-opening-a-card already works; the real gap is
that nothing surfaces _aging_ (how long a task has sat in-progress or
blocked, or how long a claim has been held against its TTL) even though the
timestamps already exist in the payload; cross-project rollup and bulk
status change are both still absent and both still deferred by the original
v1 plan's §8.

**Multi-agent collaboration design** — the premise (humans, Claude/Codex CLI
sessions, and Agent Chat all potentially touching the same queue) already
has a real, atomic, TTL-guarded claim primitive behind it — this is not a
backend problem, it's a UI-exposure problem. The concrete gap is exactly
what `TASKMASTER-HUB-OPERATIONS.md` already states: no human-facing
claim/progress/release controls, and no role-specific identity beyond one
fixed Agent Chat default. Closing the first is a small, low-risk frontend
change; the second belongs to that doc's own roadmap and isn't re-designed
here.

---

## 3. Decisions needed

- **D1 — human claim identity.** The gateway is single-user auth, so there
  is exactly one human. Recommend a fixed `agentId: "human"`, `agentRole:
"Human"`, `agentTool: "Task Master Hub"` sent from `app.html` — no
  identity storage, no login prompt. Alternative: have the claim/execution
  routes call the existing `actorOf(req)` helper server-side when the
  request is cookie-authenticated and no agent identity is supplied, so the
  label shows the real `GATEWAY_AUTH_USER` value instead of the literal
  string "human." Recommend starting with the fixed string (zero backend
  change) and only adding the `actorOf()` variant if the generic label is
  confusing in practice.
- **D2 — narrow-viewport behavior for the 6-column grid.** Leave the
  existing horizontal-scroll behavior as is; the dialog is already
  near-fullscreen, and a compact/collapsed-column mode is added complexity
  for a problem that may not occur in practice. Revisit only if real usage
  shows friction.
- **D3 — bulk status change scope.** Given 10–20s per CLI call, any bulk
  action needs a visible sequential queue (not a spinner over N calls).
  Recommend deferring past Phase A/B until real per-project task counts
  make one-at-a-time genuinely painful — premature to build against
  guessed scale.
- **D4 — cross-project rollup cost.** A naive rollup means fetching
  `/overview` for every registered project; multiplied across the existing
  5s poll and 10–20s CLI latency, that's unusable. Recommend a manual
  "refresh rollup" action (fetched once on request, not polled), scoped to
  Phase B.
- **D5 — aging/stale-claim display.** Purely client-side: `claimedAt`/
  `updatedAt` are already in `state.overview.executions`; no backend
  change needed. Recommend a relative-time label plus a visual flag once
  elapsed time passes some fraction (e.g. 80%) of the 30-minute default
  TTL, read from an existing field if the TTL is ever surfaced in the
  overview response, else hardcoded to match the documented default.

---

## 4. Phased plan

### Phase A — frontend-only, reuses existing routes exactly, ships alone

- **Claim / Set working / Set blocked (+note) / Set review / Release**
  controls in the detail overlay, calling the existing `POST .../claim` and
  `PATCH`/`DELETE .../execution` routes with the D1 identity. This closes
  the exact gap `TASKMASTER-HUB-OPERATIONS.md` already lists first in its
  own roadmap.
- **Relative-time + stale-claim flag** on the claimed-by chip, both on
  cards and in the overview panel's execution list (D5).
- **Consistent in-flight affordance** (a small spinner glyph + disabled
  row) applied uniformly across every async action already in the file
  (status change, Expand, Add dependency, Update via prompt) and the new
  claim/progress/release controls — today it's "disabled while pending"
  with no visible indicator language.
- **Client-side free-text filter** (title/id) applied per bucket, built on
  the same `state.*`-driven-redraw pattern the Other bucket's status
  filter already uses, so it survives the 5s poll rebuild without needing
  to move anything outside `#content`.
- **Inline reason text** next to gated legacy actions when `binaryMode !==
"binary"`, instead of relying on the topbar's read-only indicator alone.

### Phase B — small, scoped additions

- **Manual cross-project rollup strip** (D4): counts per registered
  project, fetched only on an explicit refresh action, never polled.
  **Built and verified (2026-09-06).** A static `#rollup-panel` (outside
  `#content`, so it isn't touched by the 5s poll) holds a "Refresh project
  rollup" button; clicking it fires `GET /overview` for every registered
  project in parallel (`Promise.all`, safe here since these are reads, not
  the bulk feature's writes) and renders one row per project with live
  per-row loading/error state as each resolves independently — one
  project's failure never blocks the others. Clicking a row switches the
  active project (`selectProject`). Verified live with 3 projects (2 real
  success rows + 1 forced-failure row rendering its own error chip without
  affecting the other two) and the click-to-switch behavior.
- **Sequential bulk status-change queue** (D3): multi-select within a
  bucket, apply, a visible per-item progress list — built entirely on the
  existing single-task status route, no new backend endpoint. **Built and
  verified (2026-09-06).** A checkbox on every card (`state.bulkSelected`,
  keyed by task id, survives the 5s poll rebuild the same way the task
  filter does) feeds a toolbar that appears above the bucket grid whenever
  ≥1 task is selected: a target-status `<select>` (reuses `STATUS`), Apply,
  and Clear/Dismiss. `applyBulkStatus()` calls the existing per-task status
  route sequentially (never `Promise.all` — each CLI call is slow, so a
  true one-at-a-time queue with a live per-item ✓/✗/spinner row is the
  correct affordance, not a single blocking spinner); a failed item's error
  is shown inline and it stays selected for retry, a succeeded item is
  cleared from selection. Verified live: selection persists across a poll
  tick, both success and per-item-failure paths render correctly (the
  failure path was caught for real against the documented §1c
  "response must actually contain the requested id" contract — a stub
  fixture bug, not a feature bug, fixed in the test fixture), and Dismiss
  correctly tears the toolbar down.

### Phase C — cross-referenced, not re-designed here

Role-specific Agent Chat identity / external-CLI claim wrapper, and
credential-to-owner binding for direct artifact API callers. These are
already tracked in `TASKMASTER-HUB-OPERATIONS.md`'s own "Current
limitations and roadmap" section as backend/auth-model decisions; this
brainstorm doesn't add new scope to them.

---

## 5. Testing plan

No backend contract changes in Phase A unless D1 picks the `actorOf()`
variant (in which case extend `apps/terminal-gateway/test/
taskmaster-endpoints.js`, which already covers claim/conflict/progress/
overview-reflection, with a cookie-authenticated no-agentId case). Otherwise:
a manual click-through pass via the `dev-browser` skill — claim a task from
the Hub, transition working→blocked (note required)→review, release,
confirm the overview/card chips update; confirm the free-text filter
survives a 5s poll tick while a filter value is set; confirm the stale-claim
flag appears once `claimedAt` exceeds the TTL threshold (can be forced with
`TASKMASTER_CLAIM_TTL_MS` set low against a scratch project) — mirroring the
verification style the v1 QA report already used for this artifact.

---

## Critical files

- `apps/terminal/public/taskmaster-hub/app.html` — all Phase A/B UI.
- `apps/terminal-gateway/src/taskmaster-execution.js` /
  `server.js` (claim/execution routes) — reused as-is for Phase A; touched
  only if D1's `actorOf()` variant is chosen.
- `docs/TASKMASTER-HUB-OPERATIONS.md` — update its "Current limitations and
  roadmap" section once Phase A ships (the human-claim-controls line is
  resolved by it; leave the Phase C items as still open).
