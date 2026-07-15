// Metadata store for session names/tags that tmux cannot hold.
//
// tmux is the source of truth for which sessions EXIST; this file only carries
// the human-assigned display name, createdAt, and optional tags, keyed by the
// QUALIFIED session id `<serverId>/web-<uuid>` (multi-server). Backing file:
// data/sessions.json.
//
// Multi-server ("Connected Servers"): the sidecar doubles as the "last-known"
// cache that feeds `reachable:false` rows for an UNREACHABLE server, so its
// pruning is per-server — we only drop stale keys within servers that actually
// responded this tick (see pruneToExisting), never within an unreachable
// server's namespace. Bare pre-multi-server keys (`web-…`, no "/") are migrated
// to the `local/` namespace on load.
//
// Writes are atomic: we serialize to sessions.json.tmp (same directory, so the
// rename stays within one filesystem) then fs.rename over the live file, so the
// live file is never observed half-written. A missing or corrupt file starts
// empty rather than crashing the gateway.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "sessions.json");
const TMP = path.join(DATA_DIR, "sessions.json.tmp");

let store = {}; // { [id]: { name, createdAt, tags? } }

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    store =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
  } catch {
    // Missing or corrupt file: start empty, don't crash.
    store = {};
  }
  // Migrate bare pre-multi-server keys (`web-…`, no "/") to the `local/`
  // namespace so every key is a qualified id going forward.
  let migrated = false;
  const next = {};
  for (const [key, val] of Object.entries(store)) {
    if (key.includes("/")) {
      next[key] = val;
    } else {
      next[`local/${key}`] = val;
      migrated = true;
    }
  }
  store = next;
  if (migrated) {
    try {
      persist();
    } catch {}
  }
  return store;
}

// Extract the serverId prefix from a qualified id. Bare (no "/") => "local".
function serverIdOf(id) {
  const slash = id.indexOf("/");
  if (slash < 0) return "local";
  return id.slice(0, slash) || "local";
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  const json = JSON.stringify(store, null, 2);
  // Atomic: write temp then rename over the real file (same fs).
  fs.writeFileSync(TMP, json, "utf8");
  fs.renameSync(TMP, FILE);
}

function get(id) {
  return store[id];
}

function list() {
  return { ...store };
}

// Insert or merge metadata for a session id. Returns the stored record.
function upsert(id, meta) {
  const existing = store[id] || {};
  store[id] = { ...existing, ...meta };
  persist();
  return store[id];
}

function remove(id) {
  if (id in store) {
    delete store[id];
    persist();
    return true;
  }
  return false;
}

// Drop metadata for ids not present in the live set (tmux is source of truth),
// PER-SERVER. `liveIds` is the set of qualified ids that reachable servers
// actually reported this tick; `reachableServerIds` is the set of server ids
// that responded. We only prune keys whose server responded — an UNREACHABLE
// server's namespace is never touched, so its last-known name/org/project
// survives the outage (the sidecar is the "last-known" cache). Returns removed.
function pruneToExisting(liveIds, reachableServerIds) {
  const alive = new Set(liveIds);
  const reachable =
    reachableServerIds instanceof Set
      ? reachableServerIds
      : new Set(reachableServerIds || []);
  const removed = [];
  for (const id of Object.keys(store)) {
    if (!reachable.has(serverIdOf(id))) continue; // never prune an unreachable server
    if (!alive.has(id)) {
      removed.push(id);
      delete store[id];
    }
  }
  if (removed.length) persist();
  return removed;
}

load();

export default { load, get, list, upsert, remove, pruneToExisting };
