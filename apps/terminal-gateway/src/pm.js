// Project-management store for the PM-tool artifact (docs/PM-TOOL-PLAN.md).
//
// A structural clone of kanban.js with a richer model: projects contain status
// columns (the ordering + status authority — D4), sprints (orthogonal to
// columns — D5), and tasks that carry assignee/priority/labels/dates/sprintId
// and a per-project dependency DAG (dependsOn — D6). Same invariants as Kanban:
// STATE in a gitignored data/pm.json sidecar; module-level store; load() at
// bottom; atomic persist() (writeFileSync(TMP)+renameSync); every mutator is
// FULLY SYNCHRONOUS so a read-modify-write is atomic (no mutex); a monotonic
// per-project `rev` gives optimistic concurrency for moveTask (D3).
//
// D4: Column.taskIds[] is the SOLE authority for a task's status + order. A task
// record stores NO status/order; getProject() derives a per-task `columnId`
// (and `status` = column name) for consumers but never persists it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = process.env.PM_FILE || path.join(DATA_DIR, "pm.json");
const TMP = `${FILE}.tmp`;

const DEFAULT_COLUMNS = ["Backlog", "To Do", "In Progress", "Done"];
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const ISSUE_TYPES = new Set(["epic", "story", "task", "bug", "subtask"]);
// A valid project key: leading letter, 2–10 alnum uppercase (^[A-Z][A-Z0-9]{1,9}$).
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

// { projects: { [id]: Project } }; Project.tasks is a map id -> task.
let store = { projects: {} };

function now() {
  return Date.now();
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
function err(code, message, details) {
  const e = new Error(message || code);
  e.code = code; // "not_found"|"bad_request"|"stale"|"cycle"|"key_taken"|"hierarchy_invalid"
  if (details) e.details = details; // extra fields merged into the JSON error body
  return e;
}

// ---- Issue-key helpers (§5.2) ----
// Derive a candidate key base from a project name: uppercase alnum of the first
// token, strip a leading run of digits (must start with a letter), 2–10 chars.
function deriveKeyBase(name) {
  const token = String(name || "")
    .trim()
    .split(/\s+/)[0];
  let k = String(token || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "");
  if (!k) k = "PROJ";
  k = k.slice(0, 10);
  while (k.length < 2) k += "X";
  return k;
}
// Return `base`, or `base2`, `base3`, … until unused (case-insensitive). Trims
// the base so the suffixed key never exceeds 10 chars.
function uniqueKey(base, taken) {
  base = base.toUpperCase();
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const trimmed = base.slice(0, Math.max(1, 10 - suffix.length));
    const cand = trimmed + suffix;
    if (!taken.has(cand)) return cand;
  }
}
// Normalize + validate an explicit (user-supplied) key.
function normalizeExplicitKey(k) {
  const up = String(k).toUpperCase();
  if (!KEY_RE.test(up))
    throw err("bad_request", "key must match ^[A-Z][A-Z0-9]{1,9}$");
  return up;
}
// The set of keys in use (uppercase), optionally excluding one project id.
function keysInUse(excludeId) {
  const s = new Set();
  for (const p of Object.values(store.projects)) {
    if (excludeId && p.id === excludeId) continue;
    if (p.key) s.add(String(p.key).toUpperCase());
  }
  return s;
}

// ---- Hierarchy helpers (§5.6) ----
function typeOf(task) {
  return task && ISSUE_TYPES.has(task.type) ? task.type : "task";
}
// Is `parentType` (a type string or null for "no parent") a legal parent for a
// child of `childType`? Encodes the §5.6 matrix exactly.
function parentAllowed(childType, parentType) {
  switch (childType) {
    case "epic":
      return parentType === null;
    case "story":
    case "task":
    case "bug":
      return parentType === null || parentType === "epic";
    case "subtask":
      return (
        parentType === "story" || parentType === "task" || parentType === "bug"
      );
    default:
      return false;
  }
}
// Would making `parentId` the parent of `taskId` create a parent-chain cycle?
// Walk up from parentId following parentId edges; a cycle exists if we reach
// taskId. Mirrors wouldCycle() but over the containment edge.
function wouldParentCycle(project, taskId, parentId) {
  const seen = new Set();
  let cur = parentId;
  while (cur) {
    if (cur === taskId) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    const t = project.tasks[cur];
    cur = t ? (t.parentId ?? null) : null;
  }
  return false;
}
// Validate a task's desired (type, parentId) against the full matrix, parent
// existence, cycles, AND its existing children (changing this task's type must
// not orphan a child). Pure — reads only, throws hierarchy_invalid/not_found.
function validateHierarchy(project, task, type, parentId) {
  if (parentId != null) {
    if (parentId === task.id)
      throw err("hierarchy_invalid", "a task cannot be its own parent", {
        reason: "self_parent",
      });
    const parent = project.tasks[parentId];
    if (!parent) throw err("not_found", `parent not found: ${parentId}`);
    const parentType = typeOf(parent);
    if (!parentAllowed(type, parentType))
      throw err(
        "hierarchy_invalid",
        `a ${type} cannot have a ${parentType} parent`,
        { reason: "matrix", child: type, parent: parentType },
      );
    if (wouldParentCycle(project, task.id, parentId))
      throw err("hierarchy_invalid", "parent cycle", { reason: "cycle" });
  } else if (!parentAllowed(type, null)) {
    // e.g. a Subtask requires a parent.
    throw err("hierarchy_invalid", `a ${type} requires a parent`, {
      reason: "parent_required",
      child: type,
    });
  }
  // A type change must keep this task a valid parent for each existing child.
  for (const child of Object.values(project.tasks)) {
    if (child.id !== task.id && (child.parentId ?? null) === task.id) {
      if (!parentAllowed(typeOf(child), type))
        throw err(
          "hierarchy_invalid",
          `changing type to ${type} would orphan child ${child.id}`,
          { reason: "child", child: typeOf(child), parent: type },
        );
    }
  }
}

// ---- Migration / backfill (§7) — idempotent (only-if-field-absent) ----
// Runs inside load() after parse. Returns true if anything changed (so load()
// persists exactly once). Re-running is a no-op ⇒ numbers/keys never move.
function migrate(s) {
  let changed = false;
  const projects = Object.values(s.projects || {});
  const assignedKeys = new Set();
  for (const p of projects)
    if (p.key) assignedKeys.add(String(p.key).toUpperCase());
  for (const p of projects) {
    // 1. Column wipLimit/transitions default null.
    if (Array.isArray(p.columns)) {
      for (const c of p.columns) {
        if (!("wipLimit" in c)) {
          c.wipLimit = null;
          changed = true;
        }
        if (!("transitions" in c)) {
          c.transitions = null;
          changed = true;
        }
      }
    }
    const tasks = p.tasks ? Object.values(p.tasks) : [];
    // 4. Task type/reporter/parentId/watchers defaults.
    for (const t of tasks) {
      if (!("type" in t) || !t.type) {
        t.type = "task";
        changed = true;
      }
      if (!("reporter" in t)) {
        t.reporter = null;
        changed = true;
      }
      if (!("parentId" in t)) {
        t.parentId = null;
        changed = true;
      }
      if (!("watchers" in t)) {
        t.watchers = [];
        changed = true;
      }
    }
    // 3. Task number: assign to tasks missing it in createdAt order, continuing
    //    after any numbers already present (idempotent).
    const missing = tasks.filter(
      (t) => !("number" in t) || typeof t.number !== "number",
    );
    if (missing.length) {
      let max = 0;
      for (const t of tasks)
        if (typeof t.number === "number" && t.number > max) max = t.number;
      missing.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const t of missing) t.number = ++max;
      changed = true;
    }
    // 2. Project key (derived-unique) + seq (max number).
    if (!p.key) {
      const k = uniqueKey(deriveKeyBase(p.name), assignedKeys);
      p.key = k;
      assignedKeys.add(k.toUpperCase());
      changed = true;
    }
    if (typeof p.seq !== "number") {
      let max = 0;
      for (const t of tasks)
        if (typeof t.number === "number" && t.number > max) max = t.number;
      p.seq = max;
      changed = true;
    }
  }
  return changed;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store =
      parsed && typeof parsed === "object" && parsed.projects
        ? { projects: parsed.projects }
        : { projects: {} };
  } catch {
    store = { projects: {} };
  }
  // Idempotent backfill; persist only when it actually changed something.
  if (migrate(store)) persist();
  return store;
}

function persist() {
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(TMP, FILE);
}

function requireProject(projectId) {
  const p = store.projects[projectId];
  if (!p) throw err("not_found", "project not found");
  return p;
}
function touch(p) {
  p.rev += 1;
  p.updatedAt = now();
}

// ---- Field coercion helpers ----
function cleanPriority(v) {
  return typeof v === "string" && PRIORITIES.has(v) ? v : undefined;
}
function cleanLabels(v) {
  return Array.isArray(v) ? v.map(String) : [];
}
function cleanDate(v) {
  // epoch ms or null; ignore anything else.
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// D6: would setting task `taskId`'s dependsOn to `deps` create a cycle? Edge
// T -> X means "T depends on X". A cycle exists if T is reachable from any dep
// by following dependsOn edges. Pure synchronous graph walk.
function wouldCycle(project, taskId, deps) {
  const seen = new Set();
  const stack = [...deps];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) return true; // back to T => cycle
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = project.tasks[cur];
    if (t) stack.push(...t.dependsOn);
  }
  return false;
}

// Validate + normalize a dependsOn list against the project (existing ids, not
// self, deduped). Throws on cycle. Returns the cleaned array.
function resolveDeps(project, taskId, rawDeps) {
  if (!Array.isArray(rawDeps)) return [];
  const deps = [];
  for (const d of rawDeps) {
    const id = String(d);
    if (id === taskId)
      throw err("bad_request", "a task cannot depend on itself");
    if (!project.tasks[id])
      throw err("not_found", `dependency not found: ${id}`);
    if (!deps.includes(id)) deps.push(id);
  }
  if (wouldCycle(project, taskId, deps)) throw err("cycle", "dependency cycle");
  return deps;
}

// ---- Read shapes ----
function shapeTask(project, task, columnOf) {
  const number = typeof task.number === "number" ? task.number : null;
  return {
    id: task.id,
    number,
    title: task.title,
    description: task.description,
    type: typeOf(task),
    assignee: task.assignee ?? null,
    reporter: task.reporter ?? null,
    priority: task.priority ?? null,
    labels: [...task.labels],
    startDate: task.startDate ?? null,
    dueDate: task.dueDate ?? null,
    sprintId: task.sprintId ?? null,
    parentId: task.parentId ?? null,
    watchers: Array.isArray(task.watchers) ? [...task.watchers] : [],
    dependsOn: [...task.dependsOn],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    columnId: columnOf[task.id] ?? null, // derived (D4)
    // Derived issue key (project.key + number), never persisted.
    ...(project.key && number != null
      ? { key: `${project.key}-${number}` }
      : {}),
  };
}

function shapeProject(p) {
  const columnOf = {};
  for (const col of p.columns)
    for (const tid of col.taskIds) columnOf[tid] = col.id;
  return {
    id: p.id,
    name: p.name,
    key: p.key,
    seq: p.seq,
    tags: [...p.tags],
    rev: p.rev,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    columns: p.columns.map((c) => ({
      id: c.id,
      name: c.name,
      taskIds: [...c.taskIds],
      wipLimit: c.wipLimit ?? null,
      transitions: c.transitions ? [...c.transitions] : null,
    })),
    sprints: p.sprints.map((s) => ({
      id: s.id,
      name: s.name,
      startDate: s.startDate ?? null,
      endDate: s.endDate ?? null,
    })),
    tasks: Object.values(p.tasks).map((t) => shapeTask(p, t, columnOf)),
  };
}

function shapeSummary(p) {
  return {
    id: p.id,
    name: p.name,
    key: p.key,
    tags: [...p.tags],
    rev: p.rev,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    columnCount: p.columns.length,
    taskCount: Object.keys(p.tasks).length,
    sprintCount: p.sprints.length,
  };
}

function listProjects() {
  return Object.values(store.projects)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(shapeSummary);
}
function getProject(projectId) {
  const p = store.projects[projectId];
  return p ? shapeProject(p) : undefined;
}

// The Epic→Story→Subtask forest, derived (never persisted). Roots are tasks
// with no parent; each node carries its shaped task + `children`.
function getTree(projectId) {
  const p = store.projects[projectId];
  if (!p) return undefined;
  const columnOf = {};
  for (const c of p.columns) for (const tid of c.taskIds) columnOf[tid] = c.id;
  const byParent = new Map();
  for (const t of Object.values(p.tasks)) {
    const pid = t.parentId ?? null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(t);
  }
  const build = (parentId) =>
    (byParent.get(parentId) || [])
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({ ...shapeTask(p, t, columnOf), children: build(t.id) }));
  return { id: p.id, name: p.name, key: p.key, tree: build(null) };
}

// ---- Project mutators ----
function createProject({ name, tags = [], columns, key } = {}) {
  if (!name || typeof name !== "string")
    throw err("bad_request", "name required");
  const ts = now();
  const colNames =
    Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;
  // §5.2: explicit key (collision → key_taken) or derived-unique from name.
  const taken = keysInUse();
  let projectKey;
  if (key !== undefined && key !== null && String(key).trim()) {
    projectKey = normalizeExplicitKey(key);
    if (taken.has(projectKey))
      throw err("key_taken", `project key ${projectKey} is already in use`);
  } else {
    projectKey = uniqueKey(deriveKeyBase(name), taken);
  }
  const p = {
    id: newId("pm"),
    name,
    key: projectKey,
    seq: 0,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
    columns: colNames.map((n) => ({
      id: newId("col"),
      name: String(n),
      taskIds: [],
      wipLimit: null,
      transitions: null,
    })),
    sprints: [],
    tasks: {},
  };
  store.projects[p.id] = p;
  persist();
  return shapeProject(p);
}

function updateProject(projectId, { name, tags, key } = {}) {
  const p = requireProject(projectId);
  if (key !== undefined) {
    const nk = normalizeExplicitKey(key);
    if (keysInUse(projectId).has(nk))
      throw err("key_taken", `project key ${nk} is already in use`);
    p.key = nk;
  }
  if (name !== undefined) p.name = name;
  if (tags !== undefined) p.tags = tags.map(String);
  touch(p);
  persist();
  return shapeProject(p);
}

function deleteProject(projectId) {
  if (!store.projects[projectId]) return false;
  delete store.projects[projectId];
  persist();
  return true;
}

// ---- Task mutators ----
function createTask(projectId, fields = {}) {
  const p = requireProject(projectId);
  const {
    title,
    description = "",
    type,
    assignee,
    reporter,
    priority,
    labels,
    startDate,
    dueDate,
    sprintId,
    parentId,
    columnId,
    dependsOn,
  } = fields;
  if (!title || typeof title !== "string")
    throw err("bad_request", "title required");
  const column = columnId
    ? p.columns.find((c) => c.id === columnId)
    : p.columns[0];
  if (!column) throw err("not_found", "column not found");
  // §3.6: WIP check on create — reject before any mutation.
  if (column.wipLimit != null && column.taskIds.length >= column.wipLimit)
    throw err(
      "wip_exceeded",
      `column ${column.name} is at its WIP limit (${column.wipLimit})`,
      {
        column: column.id,
        limit: column.wipLimit,
        current: column.taskIds.length,
      },
    );
  if (sprintId != null && !p.sprints.find((s) => s.id === sprintId))
    throw err("not_found", "sprint not found");
  // Resolve type + validate hierarchy BEFORE any mutation so a rejection leaves
  // the store untouched (no phantom task, no consumed sequence number).
  if (type !== undefined && !ISSUE_TYPES.has(type))
    throw err("bad_request", `invalid type: ${type}`);
  const taskType = ISSUE_TYPES.has(type) ? type : "task";
  const desiredParentId = parentId != null ? String(parentId) : null;
  {
    // Parent-existence + matrix pre-check (a new task has no children/cycles).
    let parentType = null;
    if (desiredParentId != null) {
      const parent = p.tasks[desiredParentId];
      if (!parent)
        throw err("not_found", `parent not found: ${desiredParentId}`);
      parentType = typeOf(parent);
    }
    if (!parentAllowed(taskType, parentType))
      throw err(
        "hierarchy_invalid",
        parentType == null
          ? `a ${taskType} requires a parent`
          : `a ${taskType} cannot have a ${parentType} parent`,
        {
          reason: parentType == null ? "parent_required" : "matrix",
          child: taskType,
          parent: parentType,
        },
      );
  }
  const id = newId("task");
  // Deps reference existing tasks only; the new id isn't in the graph yet, so
  // this can't false-positive a cycle. Resolving before insert keeps the store
  // clean if it throws.
  const deps = dependsOn !== undefined ? resolveDeps(p, id, dependsOn) : [];
  const reporterActor =
    typeof reporter === "string" && reporter ? reporter : null;
  const ts = now();
  const task = {
    id,
    number: ++p.seq, // atomic read-modify-write inside the synchronous mutator
    title,
    description: typeof description === "string" ? description : "",
    type: taskType,
    assignee: typeof assignee === "string" && assignee ? assignee : undefined,
    reporter: reporterActor,
    priority: cleanPriority(priority),
    labels: cleanLabels(labels),
    startDate: cleanDate(startDate),
    dueDate: cleanDate(dueDate),
    sprintId: sprintId != null ? String(sprintId) : null,
    parentId: desiredParentId,
    watchers: reporterActor ? [reporterActor] : [],
    dependsOn: deps,
    createdAt: ts,
    updatedAt: ts,
  };
  // §4.6: auto-add assignee to watchers (dedupe with reporter).
  const assigneeStr =
    typeof assignee === "string" && assignee ? assignee : null;
  if (assigneeStr && !task.watchers.includes(assigneeStr)) {
    task.watchers.push(assigneeStr);
  }
  p.tasks[id] = task;
  column.taskIds.push(id);
  touch(p);
  persist();
  const columnOf = {};
  for (const c of p.columns) for (const tid of c.taskIds) columnOf[tid] = c.id;
  return shapeTask(p, task, columnOf);
}

function updateTask(projectId, taskId, fields = {}) {
  const p = requireProject(projectId);
  const task = p.tasks[taskId];
  if (!task) throw err("not_found", "task not found");
  const {
    title,
    description,
    type,
    assignee,
    reporter,
    priority,
    labels,
    startDate,
    dueDate,
    sprintId,
    parentId,
    dependsOn,
  } = fields;
  // Validate a type/parent change BEFORE mutating (full matrix + cycle + child
  // checks) so a rejection leaves the store untouched.
  if (type !== undefined && !ISSUE_TYPES.has(type))
    throw err("bad_request", `invalid type: ${type}`);
  if (type !== undefined || parentId !== undefined) {
    const desiredType = type !== undefined ? type : typeOf(task);
    const desiredParentId =
      parentId !== undefined
        ? parentId != null
          ? String(parentId)
          : null
        : (task.parentId ?? null);
    validateHierarchy(p, task, desiredType, desiredParentId);
    task.type = desiredType;
    task.parentId = desiredParentId;
  }
  if (title !== undefined) {
    if (!title || typeof title !== "string")
      throw err("bad_request", "title must be non-empty");
    task.title = title;
  }
  if (description !== undefined) task.description = String(description);
  if (assignee !== undefined) {
    task.assignee = assignee ? String(assignee) : undefined;
    // §4.6: auto-add new assignee to watchers.
    if (assignee && !task.watchers.includes(String(assignee))) {
      task.watchers.push(String(assignee));
    }
  }
  if (reporter !== undefined) {
    task.reporter = reporter ? String(reporter) : null;
    if (task.reporter && !task.watchers.includes(task.reporter))
      task.watchers.push(task.reporter);
  }
  if (priority !== undefined) task.priority = cleanPriority(priority);
  if (labels !== undefined) task.labels = cleanLabels(labels);
  if (startDate !== undefined) task.startDate = cleanDate(startDate);
  if (dueDate !== undefined) task.dueDate = cleanDate(dueDate);
  if (sprintId !== undefined) {
    if (sprintId != null && !p.sprints.find((s) => s.id === sprintId))
      throw err("not_found", "sprint not found");
    task.sprintId = sprintId != null ? String(sprintId) : null;
  }
  if (dependsOn !== undefined)
    task.dependsOn = resolveDeps(p, taskId, dependsOn);
  task.updatedAt = now();
  touch(p);
  persist();
  const columnOf = {};
  for (const c of p.columns) for (const tid of c.taskIds) columnOf[tid] = c.id;
  return shapeTask(p, task, columnOf);
}

// D3/D4: board move with optimistic concurrency. Splice out of source column,
// into target at clamped index, one write.
// §3.6: WIP + transition enforcement AFTER rev check, BEFORE splice.
function moveTask(
  projectId,
  taskId,
  { toColumnId, toIndex, expectedRev } = {},
) {
  const p = requireProject(projectId);
  if (expectedRev !== undefined && expectedRev !== p.rev)
    throw err("stale", "project revision is stale");
  if (!p.tasks[taskId]) throw err("not_found", "task not found");
  const source = p.columns.find((c) => c.taskIds.includes(taskId));
  if (!source) throw err("not_found", "task not found in any column");
  const target = p.columns.find((c) => c.id === toColumnId);
  if (!target) throw err("not_found", "target column not found");
  // §3.6: cross-column move checks (same-column reorder exempt from both).
  if (source.id !== target.id) {
    // WIP hard-block (OD1).
    if (target.wipLimit != null && target.taskIds.length >= target.wipLimit)
      throw err(
        "wip_exceeded",
        `column ${target.name} is at its WIP limit (${target.wipLimit})`,
        {
          column: target.id,
          limit: target.wipLimit,
          current: target.taskIds.length,
        },
      );
    // Allowed-transitions check.
    if (source.transitions != null && !source.transitions.includes(toColumnId))
      throw err(
        "transition_forbidden",
        `move from ${source.name} to ${target.name} is not allowed`,
        {
          from: source.id,
          to: toColumnId,
          allowed: source.transitions,
        },
      );
  }
  source.taskIds.splice(source.taskIds.indexOf(taskId), 1);
  const idx = Math.max(
    0,
    Math.min(Number(toIndex) || 0, target.taskIds.length),
  );
  target.taskIds.splice(idx, 0, taskId);
  touch(p);
  persist();
  return shapeProject(p);
}

// D6: deleting a task scrubs it from every column AND from every other task's
// dependsOn — no dangling dependency edges.
function deleteTask(projectId, taskId) {
  const p = requireProject(projectId);
  if (!p.tasks[taskId]) return false;
  delete p.tasks[taskId];
  for (const col of p.columns) {
    const i = col.taskIds.indexOf(taskId);
    if (i >= 0) col.taskIds.splice(i, 1);
  }
  for (const t of Object.values(p.tasks)) {
    // Scrub the dependency edge (D6).
    const i = t.dependsOn.indexOf(taskId);
    if (i >= 0) t.dependsOn.splice(i, 1);
    // Orphan children (§5.6): null their parent; a now-parentless Subtask is
    // invalid, so promote it to a plain Task.
    if ((t.parentId ?? null) === taskId) {
      t.parentId = null;
      if (t.type === "subtask") t.type = "task";
    }
  }
  touch(p);
  persist();
  return true;
}

// ---- Column mutators (§3.4) ----
function createColumn(projectId, { name, index, wipLimit, transitions } = {}) {
  const p = requireProject(projectId);
  if (!name || typeof name !== "string")
    throw err("bad_request", "column name required");
  // Validate wipLimit: positive int or null.
  const wip = validateWipLimit(wipLimit);
  // Validate transitions: array of column ids (all must exist in this project) or null.
  const trans = validateTransitions(p, transitions);
  const col = {
    id: newId("col"),
    name: String(name),
    taskIds: [],
    wipLimit: wip,
    transitions: trans,
  };
  const i =
    index != null && Number.isInteger(index)
      ? Math.max(0, Math.min(index, p.columns.length))
      : p.columns.length;
  p.columns.splice(i, 0, col);
  touch(p);
  persist();
  return shapeProject(p);
}

function updateColumn(projectId, colId, { name, wipLimit, transitions } = {}) {
  const p = requireProject(projectId);
  const col = p.columns.find((c) => c.id === colId);
  if (!col) throw err("not_found", "column not found");
  if (name !== undefined) {
    if (!name || typeof name !== "string")
      throw err("bad_request", "column name must be a non-empty string");
    col.name = String(name);
  }
  if (wipLimit !== undefined) col.wipLimit = validateWipLimit(wipLimit);
  if (transitions !== undefined)
    col.transitions = validateTransitions(p, transitions, colId);
  touch(p);
  persist();
  return shapeProject(p);
}

function moveColumn(projectId, colId, { toIndex, expectedRev } = {}) {
  const p = requireProject(projectId);
  if (expectedRev !== undefined && expectedRev !== p.rev)
    throw err("stale", "project revision is stale");
  const from = p.columns.findIndex((c) => c.id === colId);
  if (from < 0) throw err("not_found", "column not found");
  const [col] = p.columns.splice(from, 1);
  const idx = Math.max(0, Math.min(Number(toIndex) || 0, p.columns.length));
  p.columns.splice(idx, 0, col);
  touch(p);
  persist();
  return shapeProject(p);
}

function deleteColumn(projectId, colId, { mode = "block", toColumnId } = {}) {
  const p = requireProject(projectId);
  if (p.columns.length <= 1)
    throw err("last_column", "cannot delete the last column");
  const idx = p.columns.findIndex((c) => c.id === colId);
  if (idx < 0) throw err("not_found", "column not found");
  const col = p.columns[idx];
  if (col.taskIds.length > 0) {
    if (mode === "relocate") {
      if (!toColumnId || toColumnId === colId)
        throw err(
          "bad_request",
          "toColumnId is required and must differ from the deleted column",
        );
      const target = p.columns.find((c) => c.id === toColumnId);
      if (!target) throw err("not_found", "target column not found");
      // Append source taskIds onto the END of target, preserving order.
      target.taskIds.push(...col.taskIds);
    } else {
      // Default mode = "block".
      throw err(
        "column_not_empty",
        `column ${col.name} is not empty (${col.taskIds.length} tasks)`,
      );
    }
  }
  // Remove the column.
  p.columns.splice(idx, 1);
  // Scrub this column id from any other column's transitions array.
  for (const c of p.columns) {
    if (Array.isArray(c.transitions)) {
      const ti = c.transitions.indexOf(colId);
      if (ti >= 0) c.transitions.splice(ti, 1);
    }
  }
  touch(p);
  persist();
  return shapeProject(p);
}

// Validate wipLimit: a positive integer or null (explict null or undefined → null).
function validateWipLimit(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw err("bad_request", "wipLimit must be a positive integer or null");
  return v;
}

// Validate transitions: an array of column ids (all must exist in the project,
// excluding optionally the column being updated itself) or null.
function validateTransitions(project, v, excludeColId) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v))
    throw err(
      "bad_request",
      "transitions must be an array of column ids or null",
    );
  const colIds = new Set(project.columns.map((c) => c.id));
  for (const id of v) {
    if (typeof id !== "string")
      throw err("bad_request", "each transition must be a column id string");
    if (!colIds.has(id))
      throw err("not_found", `transition column not found: ${id}`);
  }
  return [...v];
}

// ---- Sprint mutators (D5) ----
function createSprint(projectId, { name, startDate, endDate } = {}) {
  const p = requireProject(projectId);
  if (!name || typeof name !== "string")
    throw err("bad_request", "name required");
  const sprint = {
    id: newId("spr"),
    name,
    startDate: cleanDate(startDate),
    endDate: cleanDate(endDate),
  };
  p.sprints.push(sprint);
  touch(p);
  persist();
  return { ...sprint };
}

// ---- Watcher mutators (§4.6) ----
function watchTask(projectId, taskId, actor) {
  const p = requireProject(projectId);
  const task = p.tasks[taskId];
  if (!task) throw err("not_found", "task not found");
  if (!Array.isArray(task.watchers)) task.watchers = [];
  const a = String(actor);
  if (!task.watchers.includes(a)) {
    task.watchers.push(a);
    touch(p);
    persist();
  }
  const columnOf = {};
  for (const c of p.columns) for (const tid of c.taskIds) columnOf[tid] = c.id;
  return shapeTask(p, task, columnOf);
}

function unwatchTask(projectId, taskId, actor) {
  const p = requireProject(projectId);
  const task = p.tasks[taskId];
  if (!task) throw err("not_found", "task not found");
  if (!Array.isArray(task.watchers)) task.watchers = [];
  const a = String(actor);
  const idx = task.watchers.indexOf(a);
  if (idx >= 0) {
    task.watchers.splice(idx, 1);
    touch(p);
    persist();
  }
  const columnOf = {};
  for (const c of p.columns) for (const tid of c.taskIds) columnOf[tid] = c.id;
  return shapeTask(p, task, columnOf);
}

function updateSprint(projectId, sprintId, { name, startDate, endDate } = {}) {
  const p = requireProject(projectId);
  const sprint = p.sprints.find((s) => s.id === sprintId);
  if (!sprint) throw err("not_found", "sprint not found");
  if (name !== undefined) sprint.name = name;
  if (startDate !== undefined) sprint.startDate = cleanDate(startDate);
  if (endDate !== undefined) sprint.endDate = cleanDate(endDate);
  touch(p);
  persist();
  return { ...sprint };
}

// Deleting a sprint nulls sprintId on every task that referenced it.
function deleteSprint(projectId, sprintId) {
  const p = requireProject(projectId);
  const idx = p.sprints.findIndex((s) => s.id === sprintId);
  if (idx < 0) return false;
  p.sprints.splice(idx, 1);
  for (const t of Object.values(p.tasks))
    if (t.sprintId === sprintId) t.sprintId = null;
  touch(p);
  persist();
  return true;
}

load();

export default {
  load,
  listProjects,
  getProject,
  getTree,
  createProject,
  updateProject,
  deleteProject,
  createColumn,
  updateColumn,
  moveColumn,
  deleteColumn,
  createTask,
  updateTask,
  moveTask,
  deleteTask,
  watchTask,
  unwatchTask,
  createSprint,
  updateSprint,
  deleteSprint,
};
