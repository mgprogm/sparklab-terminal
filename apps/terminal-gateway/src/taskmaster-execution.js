// Gateway-owned execution state for Task Master Hub.  Task Master remains the
// source of truth for task content, status, and dependencies; this sidecar
// records only who is currently coordinating work on a task.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE =
  process.env.TASKMASTER_EXECUTIONS_FILE ||
  path.join(__dirname, "..", "data", "taskmaster-executions.json");
const TMP = `${FILE}.tmp`;
const ACTIVE = new Set(["claimed", "working", "blocked", "review"]);
const configuredClaimTtl = Number(process.env.TASKMASTER_CLAIM_TTL_MS);
const CLAIM_TTL_MS = Number.isFinite(configuredClaimTtl)
  ? configuredClaimTtl
  : 30 * 60_000;
let store = { executions: {}, events: [] };

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    store = { executions: {}, events: [] };
  }
  if (!store.executions) store.executions = {};
  if (!Array.isArray(store.events)) store.events = [];
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2));
  fs.renameSync(TMP, FILE);
}
function key(projectId, taskId) {
  return `${projectId}:${taskId}`;
}
function event(kind, execution) {
  store.events.push({
    id: `tme-${crypto.randomUUID()}`,
    kind,
    projectId: execution.projectId,
    taskId: execution.taskId,
    agentId: execution.agentId,
    at: Date.now(),
    status: execution.status,
    note: execution.note || "",
  });
  if (store.events.length > 500)
    store.events.splice(0, store.events.length - 500);
}
function expireStale() {
  if (CLAIM_TTL_MS <= 0) return;
  const now = Date.now();
  let changed = false;
  for (const x of Object.values(store.executions)) {
    if (ACTIVE.has(x.status) && now - x.updatedAt > CLAIM_TTL_MS) {
      x.status = "expired";
      x.updatedAt = now;
      event("expired", x);
      changed = true;
    }
  }
  if (changed) save();
}
function list(projectId) {
  expireStale();
  return Object.values(store.executions)
    .filter((x) => x.projectId === projectId && ACTIVE.has(x.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function get(projectId, taskId) {
  expireStale();
  const x = store.executions[key(projectId, taskId)];
  return x && ACTIVE.has(x.status) ? { ...x } : undefined;
}
function claim(projectId, taskId, agentId, agentName, agentRole, agentTool) {
  const existing = get(projectId, taskId);
  if (existing && existing.agentId !== agentId) {
    const e = new Error(
      `task is already claimed by ${existing.agentName || existing.agentId}`,
    );
    e.code = "claimed";
    throw e;
  }
  const now = Date.now();
  const x = {
    projectId,
    taskId: String(taskId),
    agentId,
    agentName: agentName || agentId,
    agentRole: agentRole || "Developer",
    agentTool: agentTool || "Agent Chat",
    status: "working",
    note: existing?.note || "",
    claimedAt: existing?.claimedAt || now,
    updatedAt: now,
  };
  store.executions[key(projectId, taskId)] = x;
  event("claimed", x);
  save();
  return { ...x };
}
function update(projectId, taskId, agentId, status, note) {
  const x = get(projectId, taskId);
  if (!x) {
    const e = new Error("task is not claimed");
    e.code = "not_found";
    throw e;
  }
  if (x.agentId !== agentId) {
    const e = new Error("only the claiming agent can update this task");
    e.code = "forbidden";
    throw e;
  }
  const allowed = {
    working: new Set(["working", "blocked", "review"]),
    blocked: new Set(["blocked", "working"]),
    review: new Set(["review", "working", "blocked"]),
  };
  if (!allowed[x.status]?.has(status)) {
    const e = new Error("invalid execution transition");
    e.code = "bad_request";
    throw e;
  }
  if (
    status === "blocked" &&
    !(typeof note === "string" ? note.trim() : x.note.trim())
  ) {
    const e = new Error("blocked status requires a note");
    e.code = "bad_request";
    throw e;
  }
  x.status = status;
  if (note !== undefined) x.note = note;
  x.updatedAt = Date.now();
  store.executions[key(projectId, taskId)] = x;
  event("updated", x);
  save();
  return { ...x };
}
function release(projectId, taskId, agentId) {
  const x = get(projectId, taskId);
  if (!x) return;
  if (x.agentId !== agentId) {
    const e = new Error("only the claiming agent can release this task");
    e.code = "forbidden";
    throw e;
  }
  x.status = "released";
  x.updatedAt = Date.now();
  store.executions[key(projectId, taskId)] = x;
  event("released", x);
  save();
}
function releaseForTask(projectId, taskId) {
  const x = get(projectId, taskId);
  if (!x) return;
  x.status = "released";
  x.updatedAt = Date.now();
  store.executions[key(projectId, taskId)] = x;
  event("released", x);
  save();
}
load();
export default { list, get, claim, update, release, releaseForTask };
