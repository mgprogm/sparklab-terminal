// Metadata store for session names/tags that tmux cannot hold.
//
// tmux is the source of truth for which sessions EXIST; this file only carries
// the human-assigned display name, createdAt, and optional tags, keyed by
// session id. Backing file: data/sessions.json.
//
// Writes are atomic: we serialize to sessions.json.tmp (same directory, so the
// rename stays within one filesystem) then fs.rename over the live file, so the
// live file is never observed half-written. A missing or corrupt file starts
// empty rather than crashing the gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');
const TMP = path.join(DATA_DIR, 'sessions.json.tmp');

let store = {}; // { [id]: { name, createdAt, tags? } }

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    store = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Missing or corrupt file: start empty, don't crash.
    store = {};
  }
  return store;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  const json = JSON.stringify(store, null, 2);
  // Atomic: write temp then rename over the real file (same fs).
  fs.writeFileSync(TMP, json, 'utf8');
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

// Drop metadata for ids not present in the live set (tmux is source of truth).
// `existingIds` is any iterable of session ids. Returns the removed ids.
function pruneToExisting(existingIds) {
  const alive = new Set(existingIds);
  const removed = [];
  for (const id of Object.keys(store)) {
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
