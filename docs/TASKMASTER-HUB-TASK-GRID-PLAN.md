# Task Master Hub — tag task-status grid on the Next Task tile

> Status: **planned, not built (2026-09-06).** Frontend-only follow-on to the
> UI v2 work ([`TASKMASTER-HUB-UI-V2-PLAN.md`](./TASKMASTER-HUB-UI-V2-PLAN.md)).
> Tracked as Task Master task **#5** in this repo's `.taskmaster/`.

## 1. What the user asked for

In the **Next Task** section of the Hub artifact, show a GitHub-contribution-
calendar-style grid where **one cell = one task in the current tag**, each cell
**colored by that task's status**, and **hovering a cell shows brief task
details**. Today that section only shows the single "next" task plus, when the
tag is empty, the text _"This tag has no tasks yet."_ The grid gives an
at-a-glance read of the whole tag's task health next to the single next-task
pick.

## 2. Why this is small

The Hub already ships the **exact pattern** for the subtask progress grid on
this same tile (`b465953`): a `.progress-grid` flex-wrap container of 12 px
`.progress-cell.status-<status>` squares with a native `title` tooltip (the
file's only tooltip precedent — no hand-rolled popover). This feature is the
same widget pointed at `state.tasks` instead of one task's `subtasks[]`.

- **No new API call, no new endpoint, no gateway/shared-types/agent change.**
  `state.tasks` is already fetched every 5 s poll by `refreshProjectData()`
  and carries `{id, title, status, priority, dependencies, blocks}` (D9
  summary projection).
- **Poll-safe by construction.** `renderContent()` wipes and rebuilds the
  `.hub` subtree every 5 s; the grid is derived purely from `state.*` on each
  render (same as the subtask grid, the Phase B bulk checkboxes, and the
  task filter), so it holds no transient DOM state.
- **One file:** `apps/terminal/public/taskmaster-hub/app.html`.

## 3. Design

### 3a. New helper `renderTaskStatusGrid()`

Builds and returns a `.task-grid` element (a `.progress-grid`-style flex-wrap
container). For each task in the source list (see 3c), append a
`<span class="progress-cell status-<status>">` (reusing `statusClass(task.status)`)
with:

```
cell.title = "#" + task.id + " · " + (task.title || "Untitled") +
             " · " + (task.status || "pending") +
             (task.priority ? " · " + task.priority : "")
```

Cells are **buttons for the keyboard/click path** — `role="button"`,
`tabindex="0"` — and clicking (or Enter/Space) calls the existing
`openDetail(task.id)` so a cell is a jump-to-detail affordance. (GitHub's
calendar cells aren't clickable, but the Hub already has a detail overlay and
this is a cheap, high-value add. If it complicates the diff, ship the tooltip-
only version first and add click in a follow-up — the tooltip is the
must-have.)

### 3b. "Ready" as its own color

`isReadyTask(task)` (status `pending` + all deps `done`) is a distinct bucket
in the Hub. Give ready tasks their own cell color instead of folding them into
`--status-pending`:

- add `--status-ready` to `:root` (a warm green-tinted accent, distinct from
  `--status-done`'s `#8eb878` and `--status-pending`'s `#d8b46a` — propose
  `#b8c98a` or similar; final value is a visual-polish call at build time);
- in `renderTaskStatusGrid()`, when `isReadyTask(task)` add a `ready` class
  and a `.progress-cell.ready { background: var(--status-ready); }` rule
  (a bare `.ready` modifier, compound-selectored like the existing
  `.progress-cell.status-*` rules so it doesn't collide with anything).

### 3c. Which tasks the grid shows — respect the free-text filter

Use `state.tasks.filter(matchesTaskFilter)` (the Phase A filter), **not** the
raw list, so the grid stays in sync with the status buckets below it (which
already filter). Order cells by numeric `id` ascending — the nearest analog to
the calendar's chronological order. When the filtered list is empty the grid
renders nothing and collapses.

### 3d. Compact legend

Cell colors aren't self-explanatory. Under the grid, render a one-line legend:
for each of Ready / Pending / In progress / Review / Done / Blocked / Other, a
`.progress-cell`-sized swatch + label + count (counts reuse the same
`visibleTasks` partition the buckets compute — or `state.overview.counts`
where it lines up). Keep it to a single wrapping row in `--mute` text.

### 3e. Placement in `renderNextTile()`

Under the `"Next task"` heading, before the next-task specifics:

```
"Next task" heading
→ renderTaskStatusGrid()   (new: full-width strip + legend)
→ existing content:
    - next.task card + subtask progress grid + "Set in-progress"   (found === true)
    - "Every task is done or blocked …"                            (found === false, hasAnyTasks)
    - "This tag has no tasks yet."                                 (no tasks at all)
```

So the grid + legend appear in **every** state; the existing empty-state text
stays as the sub-line when there is no actionable next task.

### 3f. CSS

Reuse `.progress-grid` / `.progress-cell` / `.progress-cell.status-*`. Add:
`--status-ready` var, `.progress-cell.ready`, a `.task-grid` wrapper only if it
needs different margins than `.progress-grid`, `.task-grid-legend` (flex-wrap,
`gap`, `--mute`, small font), and a focus-visible outline on the now-focusable
cells. No new fonts, no new deps, DESIGN.md palette only.

## 4. Decisions (recommended, resolve at build)

| #   | Decision                          | Recommendation                                                                                           |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | Grid respects the task filter?    | **Yes** — consistency with the buckets.                                                                  |
| D2  | Cells clickable → detail overlay? | **Yes**, but tooltip-only is an acceptable v1 if it shrinks the diff.                                    |
| D3  | "Ready" its own color?            | **Yes** — new `--status-ready` var + `.ready` modifier.                                                  |
| D4  | Legend?                           | **Yes** — one compact wrapping row with counts.                                                          |
| D5  | Cell order                        | Numeric `id` ascending.                                                                                  |
| D6  | Cap for very large tags?          | Flex-wrap already scrolls with the tile; no cap in v1. Revisit only if a real tag has hundreds of tasks. |

## 5. Verification

Frontend-only, no backend contract change → manual pass via the `dev-browser`
skill against a real gateway + a seeded project (mirrors the Phase A/B and
subtask-grid verification style):

- grid renders one cell per task, correct color per status, "Ready" tasks
  visually distinct;
- hovering a cell shows `#id · title · status · priority`;
- clicking a cell opens that task's detail overlay (if D2 shipped);
- typing in the task filter re-filters the grid in the same tick as the
  buckets, and the grid survives a 5 s poll with the filter value intact;
- empty tag → grid collapses, "This tag has no tasks yet." still shown;
- legend counts match the bucket counts.

No automated tests exist for this artifact (consistent with the rest of
`app.html`); `pnpm --filter @sparklab/terminal typecheck` must still pass
(the file is plain JS in `public/`, so this is a no-op guard, but run it).

## 6. Out of scope

Time/activity axis (real GitHub-calendar semantics need per-day task
create/close data the summary projection doesn't carry), drag/reorder from the
grid, per-cell context menu, cross-tag or cross-project grids.

## 7. Critical files

- `apps/terminal/public/taskmaster-hub/app.html` — all of it: `renderNextTile()`,
  a new `renderTaskStatusGrid()` helper, `:root` vars + `.progress-cell` CSS.
