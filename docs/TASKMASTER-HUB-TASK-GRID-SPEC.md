# Task Master Hub — tag task-status grid: implementation spec

> Spec for the plan in `docs/TASKMASTER-HUB-TASK-GRID-PLAN.md`.
> Target file: `apps/terminal/public/taskmaster-hub/app.html` (sole file; no
> gateway, shared-types, or agent-service changes).

---

## 0. Resolved decisions

| #   | Decision                           | Answer                                                                                                     |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D1  | Grid respects the task filter?     | **Yes.** Source list is `state.tasks.filter(matchesTaskFilter)`.                                           |
| D2  | Cells clickable to detail overlay? | **Yes.** `role="button"`, `tabindex="0"`, click and Enter/Space call `openDetail(task.id)`.                |
| D3  | "Ready" gets its own color?        | **Yes.** New `--status-ready` custom property + `.progress-cell.ready` rule.                               |
| D4  | Legend?                            | **Yes.** One compact wrapping row under the grid with swatch + label + count, one entry per status bucket. |
| D5  | Cell order                         | Numeric `id` ascending (`Number(a.id) - Number(b.id)`).                                                    |
| D6  | Cap for large tags?                | **No cap in v1.** Flex-wrap handles overflow naturally inside the scrollable `.hub`.                       |

---

## 1. CSS additions

All additions go inside the existing `<style>` block.

### 1a. New custom property `--status-ready`

Insert into the `:root` block (lines 11-34), immediately after line 33
(`--status-other: #aea69c;`):

```css
--status-ready: #b8c98a;
```

This is a warm green-yellow, visually distinct from `--status-done` (`#8eb878`,
a cooler green) and `--status-pending` (`#d8b46a`, amber). Dev may adjust the
exact hex.

### 1b. New rules for the task grid, ready modifier, focus, and legend

Insert immediately after the `.progress-cell.status-blocked` rule block (after
line 448, before line 449 `.card-select`):

```css
.progress-cell.ready {
  background: var(--status-ready);
}
.progress-cell[role="button"] {
  cursor: pointer;
}
.progress-cell[role="button"]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.task-grid {
  margin: 6px 0 2px;
}
.task-grid-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 2px 0 8px;
  font-size: 11px;
  color: var(--mute);
  align-items: center;
}
.task-grid-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
```

Note: the `.task-grid` wrapper uses `margin: 6px 0 2px` (top space after the
heading, small bottom gap before the legend). The `.progress-grid` class
(lines 418-423, `margin: 2px 0 8px`) is reused on the inner grid container
itself (see section 2), so no duplication of the grid's own flex/gap/cell rules
is needed. The `.task-grid` is a structural wrapper around the `.progress-grid`
and the `.task-grid-legend`.

---

## 2. New helper: `renderTaskStatusGrid()`

Insert as a standalone function immediately before `renderNextTile()` (before
line 1279). The function builds and returns a `.task-grid` wrapper element
containing a `.progress-grid` of clickable cells and a `.task-grid-legend`.

### 2a. Full function body (spec)

```js
function renderTaskStatusGrid() {
  var filtered = state.tasks.filter(matchesTaskFilter);
  if (!filtered.length) return null;

  filtered.sort(function (a, b) {
    return Number(a.id) - Number(b.id);
  });

  var wrapper = elem("div", "task-grid");

  // --- grid of cells ---
  var grid = elem("div", "progress-grid");
  grid.setAttribute("aria-label", "Task status grid");
  filtered.forEach(function (task) {
    var cls = "progress-cell " + statusClass(task.status);
    if (isReadyTask(task)) cls += " ready";
    var cell = elem("span", cls);
    cell.title =
      "#" +
      task.id +
      " · " +
      (task.title || "Untitled") +
      " · " +
      (task.status || "pending") +
      (task.priority ? " · " + task.priority : "");
    cell.setAttribute("role", "button");
    cell.setAttribute("tabindex", "0");
    cell.addEventListener("click", function () {
      void openDetail(task.id);
    });
    cell.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void openDetail(task.id);
      }
    });
    grid.appendChild(cell);
  });
  wrapper.appendChild(grid);

  // --- legend ---
  var readyCount = 0,
    pendingCount = 0,
    inProgressCount = 0,
    reviewCount = 0,
    doneCount = 0,
    blockedCount = 0,
    otherCount = 0;
  filtered.forEach(function (task) {
    if (isReadyTask(task)) readyCount++;
    else if (task.status === "pending") pendingCount++;
    else if (task.status === "in-progress") inProgressCount++;
    else if (task.status === "review") reviewCount++;
    else if (task.status === "done") doneCount++;
    else if (task.status === "blocked") blockedCount++;
    else otherCount++;
  });
  var legendItems = [
    ["ready", "Ready", readyCount],
    ["status-pending", "Pending", pendingCount],
    ["status-in-progress", "In progress", inProgressCount],
    ["status-review", "Review", reviewCount],
    ["status-done", "Done", doneCount],
    ["status-blocked", "Blocked", blockedCount],
    ["status-other", "Other", otherCount],
  ];
  var legend = elem("div", "task-grid-legend");
  legendItems.forEach(function (item) {
    if (item[2] === 0) return;
    var row = elem("span", "task-grid-legend-item");
    row.appendChild(elem("span", "progress-cell " + item[0]));
    row.appendChild(document.createTextNode(item[1] + " " + item[2]));
    legend.appendChild(row);
  });
  wrapper.appendChild(legend);

  return wrapper;
}
```

### 2b. Key design notes

- **Source list:** `state.tasks.filter(matchesTaskFilter)` -- the same
  predicate used by `renderContent()` at line 1194. This keeps the grid in
  sync with the status buckets below.

- **Sort:** `Number(a.id) - Number(b.id)` ascending. Task ids from
  `claude-task-master` are numeric strings.

- **Cell classes:** `"progress-cell " + statusClass(task.status)` reuses the
  existing `.progress-cell.status-*` rules (lines 430-448). When
  `isReadyTask(task)` is true, a bare `ready` class is appended; the
  `.progress-cell.ready` rule (new, section 1b) overrides the
  `.progress-cell.status-pending` background because it appears later in the
  stylesheet and has equal specificity. This mirrors the `renderContent()`
  partition where Ready tasks are pulled out of the Pending bucket
  (lines 1207-1211: `status !== "pending" || !isReadyTask(task)`).

- **Tooltip format:** `"#" + id + " · " + title + " · " + status`
  with an optional ` · priority` suffix. Uses `·` (middle dot)
  matching the subtask grid's separator at lines 1304-1309.

- **Click handler:** Matches the existing card click pattern at line 1633-1634:
  `void openDetail(task.id)`. The `void` prefix silences the returned promise.

- **Keyboard handler:** Enter and Space both fire `openDetail`, with
  `preventDefault()` on Space to suppress page scroll (standard
  `role="button"` pattern).

- **Legend partition** uses the exact same predicates as `renderContent()`
  (lines 1194-1216) and `renderOtherBucket()` (lines 1504-1507):
  - **Ready:** `isReadyTask(task)` (status `"pending"` AND all deps done;
    function at lines 1364-1372).
  - **Pending:** `task.status === "pending" && !isReadyTask(task)` (the
    remainder after Ready is extracted, matching lines 1207-1211).
  - **In progress:** `task.status === "in-progress"`.
  - **Review:** `task.status === "review"`.
  - **Done:** `task.status === "done"`.
  - **Blocked:** `task.status === "blocked"`.
  - **Other:** everything else (covers `"deferred"`, `"cancelled"`, and any
    future unknown status).

  Note: `state.overview.counts` (lines 1226-1239) is NOT used because those
  counts are server-computed over the full unfiltered tag, while the grid and
  legend must reflect the task-filter-narrowed view.

- **Legend swatches** reuse the `.progress-cell` class at the standard 12x12 px
  size. The `ready` swatch uses class `"progress-cell ready"`, which picks up
  `--status-ready`. The `blocked` swatch uses `"progress-cell status-blocked"`,
  which picks up `var(--danger)` from line 447.

- **Empty-tag handling:** When `filtered.length === 0`, the function returns
  `null`. The call site (section 3) checks for null before appending.

- **Legend omits zero-count items** to keep the row compact.

---

## 3. Call site in `renderNextTile()`

The grid must render in **all three** states of the Next Task tile (found task,
all done/blocked, no tasks). Insert immediately after the heading is appended
and before the `var next = state.next;` branch.

### Exact insertion point

Current code at lines 1280-1283:

```js
var box = elem("section", "next-tile"),
  head = elem("div", "next-title", "Next task");
box.appendChild(head);
var next = state.next;
```

Insert between line 1282 (`box.appendChild(head);`) and line 1283
(`var next = state.next;`):

```js
var taskGrid = renderTaskStatusGrid();
if (taskGrid) box.appendChild(taskGrid);
```

Resulting code:

```js
var box = elem("section", "next-tile"),
  head = elem("div", "next-title", "Next task");
box.appendChild(head);
var taskGrid = renderTaskStatusGrid();
if (taskGrid) box.appendChild(taskGrid);
var next = state.next;
```

This places the grid + legend after the "Next task" heading and before all
three branch bodies (the found-task card with subtask grid and Set in-progress
button; the "Every task is done or blocked" empty line; the "This tag has no
tasks yet." empty line). When the filtered task list is empty, `taskGrid` is
`null` and nothing is appended -- the empty-state text still renders below.

---

## 4. Deviations-allowed note

Dev may adjust:

- Anchor line numbers (the file is actively edited; find the anchors by content).
- Cosmetic values: the `--status-ready` hex, `gap`/`margin` pixel values, the
  `outline` color/offset on `:focus-visible`.

Dev must NOT change:

- **Single file** -- all changes in `apps/terminal/public/taskmaster-hub/app.html`.
- **No new fetch/endpoint** -- the grid is derived from `state.tasks` (already
  polled every 5 s by `refreshProjectData()`).
- **Poll-safety** -- `renderTaskStatusGrid()` is a pure function of `state.*`,
  rebuilt every render cycle (same as the subtask grid, the bulk toolbar, and
  the task filter).
- **Click behavior** -- `openDetail(task.id)` is the click target, matching the
  existing card-click convention.
- **Legend counts must use the same partition predicates** as `renderContent()`
  and `renderOtherBucket()`.

---

## 5. Verification checklist

Manual pass via the `dev-browser` skill against a real gateway + a seeded
Task Master project:

- [ ] Grid renders one cell per task in the current tag (filtered by the task
      filter input), each cell colored by its status. "Ready" tasks
      (`isReadyTask`) are visually distinct from plain "Pending".
- [ ] Hovering a cell shows `#id . title . status . priority` in a native
      tooltip.
- [ ] Clicking a cell opens that task's detail overlay.
- [ ] Enter/Space on a focused cell opens the detail overlay.
- [ ] Typing in the task filter re-filters the grid in the same tick as the
      status buckets; the grid survives a 5 s poll with the filter value
      intact.
- [ ] Empty tag (zero tasks) -- grid is absent, "This tag has no tasks yet."
      still shown.
- [ ] All-done/blocked tag -- grid shows only done/blocked cells, "Every task
      is done or blocked" text still shown below.
- [ ] Legend counts match the corresponding bucket counts in the status stack
      below.
- [ ] Legend omits zero-count entries.
- [ ] Focus-visible outline appears on cells when tabbing.

Typecheck guard (no-op for plain JS in `public/`, but must not regress):

```bash
pnpm --filter @sparklab/terminal typecheck
```

---

## 6. Files touched

| File                                           | What changes                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/terminal/public/taskmaster-hub/app.html` | `:root` += `--status-ready`; new CSS rules after line 448; new `renderTaskStatusGrid()` function before `renderNextTile()`; two-line insertion inside `renderNextTile()`. |

No other files are modified.
