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

// { projects: { [id]: Project } }; Project.tasks is a map id -> task.
let store = { projects: {} };

function now() {
  return Date.now();
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
function err(code, message) {
  const e = new Error(message || code);
  e.code = code; // "not_found" | "bad_request" | "stale" | "cycle"
  return e;
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
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    assignee: task.assignee ?? null,
    priority: task.priority ?? null,
    labels: [...task.labels],
    startDate: task.startDate ?? null,
    dueDate: task.dueDate ?? null,
    sprintId: task.sprintId ?? null,
    dependsOn: [...task.dependsOn],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    columnId: columnOf[task.id] ?? null, // derived (D4)
  };
}

function shapeProject(p) {
  const columnOf = {};
  for (const col of p.columns)
    for (const tid of col.taskIds) columnOf[tid] = col.id;
  return {
    id: p.id,
    name: p.name,
    tags: [...p.tags],
    rev: p.rev,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    columns: p.columns.map((c) => ({
      id: c.id,
      name: c.name,
      taskIds: [...c.taskIds],
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

// ---- Project mutators ----
function createProject({ name, tags = [], columns } = {}) {
  if (!name || typeof name !== "string")
    throw err("bad_request", "name required");
  const ts = now();
  const colNames =
    Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS;
  const p = {
    id: newId("pm"),
    name,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
    columns: colNames.map((n) => ({
      id: newId("col"),
      name: String(n),
      taskIds: [],
    })),
    sprints: [],
    tasks: {},
  };
  store.projects[p.id] = p;
  persist();
  return shapeProject(p);
}

function updateProject(projectId, { name, tags } = {}) {
  const p = requireProject(projectId);
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
    assignee,
    priority,
    labels,
    startDate,
    dueDate,
    sprintId,
    columnId,
    dependsOn,
  } = fields;
  if (!title || typeof title !== "string")
    throw err("bad_request", "title required");
  const column = columnId
    ? p.columns.find((c) => c.id === columnId)
    : p.columns[0];
  if (!column) throw err("not_found", "column not found");
  if (sprintId != null && !p.sprints.find((s) => s.id === sprintId))
    throw err("not_found", "sprint not found");
  const ts = now();
  const task = {
    id: newId("task"),
    title,
    description: typeof description === "string" ? description : "",
    assignee: typeof assignee === "string" && assignee ? assignee : undefined,
    priority: cleanPriority(priority),
    labels: cleanLabels(labels),
    startDate: cleanDate(startDate),
    dueDate: cleanDate(dueDate),
    sprintId: sprintId != null ? String(sprintId) : null,
    dependsOn: [],
    createdAt: ts,
    updatedAt: ts,
  };
  p.tasks[task.id] = task;
  column.taskIds.push(task.id);
  // Resolve deps AFTER the task exists (so self/cycle checks see it).
  if (dependsOn !== undefined)
    task.dependsOn = resolveDeps(p, task.id, dependsOn);
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
    assignee,
    priority,
    labels,
    startDate,
    dueDate,
    sprintId,
    dependsOn,
  } = fields;
  if (title !== undefined) {
    if (!title || typeof title !== "string")
      throw err("bad_request", "title must be non-empty");
    task.title = title;
  }
  if (description !== undefined) task.description = String(description);
  if (assignee !== undefined)
    task.assignee = assignee ? String(assignee) : undefined;
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
    const i = t.dependsOn.indexOf(taskId);
    if (i >= 0) t.dependsOn.splice(i, 1);
  }
  touch(p);
  persist();
  return true;
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
  createProject,
  updateProject,
  deleteProject,
  createTask,
  updateTask,
  moveTask,
  deleteTask,
  createSprint,
  updateSprint,
  deleteSprint,
};
