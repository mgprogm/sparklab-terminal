// Persisted, one-shot terminal actions created through Agent Chat.  Keeping
// these in the gateway means a chat WebSocket (or agent-service restart) does
// not discard an already approved action.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE =
  process.env.SCHEDULED_TERMINAL_ACTIONS_FILE ||
  path.join(__dirname, "..", "data", "scheduled-terminal-actions.json");
const TMP = `${FILE}.tmp`;

let store = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(TMP, FILE);
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    store = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code !== "ENOENT")
      console.error(
        `FAILED TO LOAD SCHEDULED TERMINAL ACTIONS FROM ${FILE}:`,
        error,
      );
    store = [];
  }
  return list();
}

function list() {
  return clone(store);
}

function create({ sessionId, keys, executeAt }) {
  const action = {
    id: `terminal-action-${randomUUID()}`,
    sessionId,
    keys,
    executeAt,
    status: "scheduled",
    createdAt: Date.now(),
    executedAt: null,
    error: null,
  };
  store.push(action);
  persist();
  return clone(action);
}

function due(now = Date.now()) {
  return store
    .filter(
      (action) => action.status === "scheduled" && action.executeAt <= now,
    )
    .map(clone);
}

// Claim before executing. A process crash after this point intentionally loses
// the occurrence rather than replaying a potentially consequential key press.
function claim(id) {
  const action = store.find((item) => item.id === id);
  if (!action || action.status !== "scheduled") return undefined;
  action.status = "executing";
  persist();
  return clone(action);
}

function finish(id, error = null) {
  const action = store.find((item) => item.id === id);
  if (!action) return undefined;
  action.status = error ? "failed" : "executed";
  action.executedAt = Date.now();
  action.error = error;
  persist();
  return clone(action);
}

function cancel(id) {
  const action = store.find((item) => item.id === id);
  if (!action || action.status !== "scheduled") return undefined;
  action.status = "cancelled";
  action.executedAt = Date.now();
  persist();
  return clone(action);
}

export default { load, list, create, due, claim, finish, cancel };
