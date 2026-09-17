// Server registry for the multi-server ("Connected Servers") feature.
//
// CONFIG, not state: lives in a gitignored servers.json next to the gateway
// .env (NOT in tmux, NOT in the metadata sidecar). SSH auth is key-based by
// default; an optional per-server `password` may be stored here (plaintext, this
// gitignored file only) for hosts that require password auth. The implicit
// "local" server (the gateway host's own tmux, no ssh) is ALWAYS present and
// cannot be removed or have its connection fields changed — but its display
// NAME can be renamed, which is the one thing about it that IS persisted (as
// `localName` alongside the ssh server list, see the file shape below).
//
// File shape is `{ localName?: string, servers: SshServerRecord[] }`. An
// older file that is a bare array (pre-rename-feature) is still read as
// `servers` with no `localName` override; the next persist() rewrites it to
// the object shape.
//
// Atomic writes mirror metadata.js: serialize to servers.json.tmp then rename
// over the live file (same directory => same filesystem). A missing/corrupt
// file starts with just the implicit local server rather than crashing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// servers.json sits next to the gateway .env (apps/terminal-gateway/), one dir
// up from src/. Overridable for tests via SERVERS_FILE.
const FILE =
  process.env.SERVERS_FILE || path.join(__dirname, "..", "servers.json");
const TMP = `${FILE}.tmp`;

// The implicit default. A bare/unqualified session id resolves here.
const LOCAL_SERVER = Object.freeze({
  id: "local",
  name: "This machine",
  type: "local",
});

// Mirrors ServerIdSchema in @sparklab/shared-types: alnum start, then
// [A-Za-z0-9_-], 1..64 chars, and crucially NO "/" (it is the prefix before
// "/" in a qualified session id).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

let store = []; // array of ssh server records; "local" is implicit
let localName = null; // display-name override for "local"; null => default

function sanitize(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.id === "local" || !ID_RE.test(entry.id || "")) return null;
  const record = {
    id: entry.id,
    name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
    type: "ssh",
    host: entry.host,
  };
  if (!record.host || typeof record.host !== "string") return null;
  if (entry.user) record.user = entry.user;
  if (entry.port) record.port = entry.port;
  if (entry.identityFile) record.identityFile = entry.identityFile;
  // Optional password auth (plaintext, this gitignored file only; never sent
  // back over the API). Present => the gateway uses ssh password auth.
  if (typeof entry.password === "string" && entry.password.length) {
    record.password = entry.password;
  }
  // File-only advanced override (e.g. ["tmux","-L","sock"]); not settable via
  // the wire API. Lets the acceptance harness point at a separate tmux server.
  if (Array.isArray(entry.tmuxCommand))
    record.tmuxCommand = entry.tmuxCommand.map(String);
  return record;
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    // Back-compat: a bare array is the pre-rename-feature shape (servers only).
    const rawServers = Array.isArray(parsed) ? parsed : parsed?.servers;
    store = Array.isArray(rawServers)
      ? rawServers.map(sanitize).filter(Boolean)
      : [];
    localName =
      !Array.isArray(parsed) &&
      typeof parsed?.localName === "string" &&
      parsed.localName.trim()
        ? parsed.localName.trim()
        : null;
  } catch {
    // Missing or corrupt file: just the implicit local server.
    store = [];
    localName = null;
  }
  return store;
}

function persist() {
  const json = JSON.stringify(
    { ...(localName ? { localName } : {}), servers: store },
    null,
    2,
  );
  fs.writeFileSync(TMP, json, "utf8");
  fs.renameSync(TMP, FILE);
}

function localServer() {
  return localName ? { ...LOCAL_SERVER, name: localName } : { ...LOCAL_SERVER };
}

// All servers, local ALWAYS first. Returns copies (callers must not mutate).
function list() {
  return [localServer(), ...store.map((s) => ({ ...s }))];
}

function get(id) {
  if (id === "local") return localServer();
  const found = store.find((s) => s.id === id);
  return found ? { ...found } : undefined;
}

// Register an ssh server. Throws on invalid id / reserved id / duplicate.
function add(entry) {
  if (!ID_RE.test(entry?.id || "")) throw new Error("invalid server id");
  if (entry.id === "local") throw new Error('"local" is reserved');
  if (store.some((s) => s.id === entry.id))
    throw new Error("server id already exists");
  const record = sanitize({ ...entry, type: "ssh" });
  if (!record) throw new Error("invalid server entry");
  store.push(record);
  persist();
  return { ...record };
}

function remove(id) {
  if (id === "local") return false; // undeletable
  const idx = store.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  store.splice(idx, 1);
  persist();
  return true;
}

// Rename a server (the only mutable field post-add; connection params are
// immutable — remove + re-add to change host/user/port/auth). Works for
// "local" too (persists as `localName`). Returns the updated entry, or
// undefined if `id` isn't "local" and isn't a known ssh server.
function update(id, patch) {
  const name = typeof patch?.name === "string" ? patch.name.trim() : "";
  if (!name) throw new Error("name is required");
  if (id === "local") {
    localName = name === LOCAL_SERVER.name ? null : name;
    persist();
    return localServer();
  }
  const found = store.find((s) => s.id === id);
  if (!found) return undefined;
  found.name = name;
  persist();
  return { ...found };
}

load();

export default { load, list, get, add, update, remove, LOCAL_SERVER };
