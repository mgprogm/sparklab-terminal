// Registry sidecar for the Task Master Hub artifact feature.
//
// STATE, not config: lives in a gitignored data/taskmaster-projects.json
// sidecar (mirrors registry.js / kanban.js). A module-level store, load() at
// module bottom, atomic persist() (writeFileSync(TMP) + renameSync over the
// live file); a missing/corrupt file degrades to an empty store.
//
// This sidecar holds ONLY pointers — {id, name, serverId, path, binaryMode}.
// It never holds task content: every read/write of actual task data goes
// through the real `task-master` CLI (see docs/TASKMASTER-HUB-PLAN.md D1/D2).
// Fully synchronous mutators, same reasoning as kanban.js/registry.js: no
// mid-method await, so a read-modify-write is atomic without a mutex.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
// Overridable for tests via TASKMASTER_PROJECTS_FILE (mirrors KANBAN_FILE).
const FILE =
  process.env.TASKMASTER_PROJECTS_FILE ||
  path.join(DATA_DIR, "taskmaster-projects.json");
const TMP = `${FILE}.tmp`;

let store = { projects: {} }; // id -> { id, name, serverId, path, binaryMode, createdAt }

function err(code, message) {
  const e = new Error(message || code);
  e.code = code; // "not_found" | "bad_request"
  return e;
}

function newId() {
  return `tmp-${crypto.randomUUID()}`;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    store =
      parsed && typeof parsed === "object" && parsed.projects
        ? parsed
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

function list() {
  return Object.values(store.projects).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}

function get(id) {
  const p = store.projects[id];
  return p ? { ...p } : undefined;
}

// `binaryMode` is probed by the caller (server.js, via a real exec) BEFORE
// calling create() — this module never shells out itself, it only persists
// what it's told (same separation as registry.js not probing reachability).
function create({ name, serverId, path: projectPath, binaryMode }) {
  if (typeof projectPath !== "string" || !projectPath.startsWith("/")) {
    throw err("bad_request", "path must be an absolute path");
  }
  if (typeof serverId !== "string" || !serverId) {
    throw err("bad_request", "serverId is required");
  }
  const id = newId();
  const record = {
    id,
    name: typeof name === "string" && name ? name : projectPath,
    serverId,
    path: projectPath,
    binaryMode: binaryMode === "binary" ? "binary" : "core-only-npx",
    createdAt: Date.now(),
  };
  store.projects[id] = record;
  persist();
  return { ...record };
}

function remove(id) {
  if (!store.projects[id]) throw err("not_found", "project not found");
  delete store.projects[id];
  persist();
}

load();

export default { load, list, get, create, remove };
