// Collaboration data for the PM tool: comments, activity/audit, attachments,
// and notifications.
//
// ALL storage is SEPARATE from data/pm.json (which is the main project store).
// Follows the same conventions as pm.js / kanban.js / registry.js / push.js:
// fully synchronous filesystem operations so a read-modify-write cannot
// interleave in Node's single-threaded event loop — no mutex, no write-queue.
// The ONLY async part is reading the HTTP upload body, which happens in the
// route layer (server.js), not here.
//
// Storage layout (all under DATA_DIR):
//   data/pm-activity/<projectId>.jsonl       — append-only audit log
//   data/pm-comments/<projectId>.jsonl       — append-only; edit=new record; delete=tombstone
//   data/pm-attachments/<projectId>/index.jsonl — metadata (append + tombstone)
//   data/pm-attachments/<projectId>/<attId>  — opaque blob bytes
//   data/pm-notifications.json               — bounded atomic JSON with read-state
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.PM_COLLAB_DIR || path.join(__dirname, "..", "data");
const ACTIVITY_DIR = path.join(DATA_DIR, "pm-activity");
const COMMENTS_DIR = path.join(DATA_DIR, "pm-comments");
const ATTACHMENTS_DIR = path.join(DATA_DIR, "pm-attachments");
const NOTIFICATIONS_FILE = path.join(DATA_DIR, "pm-notifications.json");
const NOTIFICATIONS_TMP = `${NOTIFICATIONS_FILE}.tmp`;

const ATTACHMENT_CAP = Number(process.env.PM_ATTACHMENT_CAP) || 8 * 1024 * 1024;
const NOTIFICATIONS_MAX = Number(process.env.PM_NOTIFICATIONS_MAX) || 500;
const COMMENT_BODY_MAX = 8192;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Path-traversal sanitizer (modeled on safeChatId from agent-service). */
function safeId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new Error("invalid id");
  return id;
}

/** Ensure a directory exists (idempotent). */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore — race or permission; let the subsequent write surface the real error */
  }
}

/**
 * Read a JSONL file into an array of parsed records. Tolerates missing files
 * (returns []) and skips individual malformed lines so one bad record can't
 * nuke the whole read.
 */
function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return []; // ENOENT or permission — empty
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return records;
}

/** Append one JSON record as a JSONL line (parent dir must already exist). */
function appendJsonl(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Fold a JSONL array to latest-per-id (last record with a given id wins).
 * Returns a Map<id, record>. Tombstoned records (deleted:true) are included
 * in the map — callers filter them out as needed.
 */
function foldLatest(records) {
  const map = new Map();
  for (const r of records) {
    if (r && r.id) map.set(r.id, r);
  }
  return map;
}

/**
 * Sanitize an attachment filename: strip NUL bytes, newlines, and path
 * separators. The original name is metadata-only (never used as a filesystem
 * path), but we clean it for display safety.
 */
function sanitizeFilename(name) {
  return String(name || "unnamed")
    .replace(/[\x00\n\r/\\]/g, "_")
    .slice(0, 255);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
// Record: {id, taskId, author, body, createdAt, updatedAt?, deleted?}

function commentsFile(projectId) {
  return path.join(COMMENTS_DIR, `${safeId(projectId)}.jsonl`);
}

function addComment(projectId, taskId, author, body) {
  if (typeof body !== "string" || !body.trim())
    throw new Error("comment body required");
  if (body.length > COMMENT_BODY_MAX)
    throw new Error(`comment body exceeds ${COMMENT_BODY_MAX} chars`);
  const record = {
    id: newId("cmt"),
    taskId: String(taskId),
    author: String(author),
    body,
    createdAt: Date.now(),
  };
  ensureDir(COMMENTS_DIR);
  appendJsonl(commentsFile(projectId), record);
  return { ...record };
}

function editComment(projectId, commentId, body) {
  if (typeof body !== "string" || !body.trim())
    throw new Error("comment body required");
  if (body.length > COMMENT_BODY_MAX)
    throw new Error(`comment body exceeds ${COMMENT_BODY_MAX} chars`);
  // Must carry forward taskId, author, createdAt from the existing record.
  const file = commentsFile(projectId);
  const records = readJsonl(file);
  const folded = foldLatest(records);
  const existing = folded.get(String(commentId));
  if (!existing || existing.deleted) throw new Error("comment not found");
  const record = {
    id: existing.id,
    taskId: existing.taskId,
    author: existing.author,
    body,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  appendJsonl(file, record);
  return { ...record };
}

function deleteComment(projectId, commentId) {
  const file = commentsFile(projectId);
  const record = {
    id: String(commentId),
    deleted: true,
    updatedAt: Date.now(),
  };
  ensureDir(COMMENTS_DIR);
  appendJsonl(file, record);
}

function listComments(projectId, taskId) {
  const records = readJsonl(commentsFile(projectId));
  const folded = foldLatest(records);
  const result = [];
  for (const r of folded.values()) {
    if (r.deleted) continue;
    if (r.taskId !== String(taskId)) continue;
    result.push({ ...r });
  }
  result.sort((a, b) => a.createdAt - b.createdAt);
  return result;
}

function deleteCommentsForTask(projectId, taskId) {
  const records = readJsonl(commentsFile(projectId));
  const folded = foldLatest(records);
  const file = commentsFile(projectId);
  let count = 0;
  for (const r of folded.values()) {
    if (r.deleted) continue;
    if (r.taskId !== String(taskId)) continue;
    const tombstone = {
      id: r.id,
      deleted: true,
      updatedAt: Date.now(),
    };
    ensureDir(COMMENTS_DIR);
    appendJsonl(file, tombstone);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Activity / Audit
// ---------------------------------------------------------------------------
// Record: {id, ts, actor, verb, target:{type,id}, summary, before?, after?}
// Verbs: created|updated|moved|deleted|commented|attached|detached|watched|
//        unwatched|column_added|column_deleted|wip_set|transition_set|
//        assigned|reporter_set|parented|type_changed

function activityFile(projectId) {
  return path.join(ACTIVITY_DIR, `${safeId(projectId)}.jsonl`);
}

function appendActivity(projectId, entry) {
  const record = {
    id: newId("act"),
    ts: Date.now(),
    actor: entry.actor,
    verb: entry.verb,
    target: entry.target,
    summary: entry.summary,
  };
  if (entry.taskId !== undefined) record.taskId = entry.taskId;
  if (entry.before !== undefined) record.before = entry.before;
  if (entry.after !== undefined) record.after = entry.after;
  ensureDir(ACTIVITY_DIR);
  appendJsonl(activityFile(projectId), record);
}

function listActivity(projectId, { limit = 50, before } = {}) {
  const records = readJsonl(activityFile(projectId));
  // Reverse chronological (newest first).
  records.reverse();
  let result = records;
  if (before !== undefined && typeof before === "number") {
    result = result.filter((r) => r.ts < before);
  }
  return result.slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
// Metadata record: {id, taskId, filename, size, contentType, actor, createdAt}
// Tombstone: {id, deleted:true, updatedAt}

function attachmentIndexFile(projectId) {
  return path.join(ATTACHMENTS_DIR, safeId(projectId), "index.jsonl");
}

function attachmentBlobPath(projectId, attId) {
  return path.join(ATTACHMENTS_DIR, safeId(projectId), safeId(attId));
}

function addAttachment(
  projectId,
  taskId,
  { filename, contentType, buffer, actor },
) {
  if (!Buffer.isBuffer(buffer)) throw new Error("buffer must be a Buffer");
  if (buffer.length > ATTACHMENT_CAP)
    throw new Error(
      `attachment size ${buffer.length} exceeds cap ${ATTACHMENT_CAP}`,
    );
  const attId = newId("att");
  const projectDir = path.join(ATTACHMENTS_DIR, safeId(projectId));
  ensureDir(projectDir);
  // Write blob first (if this fails, no metadata is recorded).
  fs.writeFileSync(attachmentBlobPath(projectId, attId), buffer);
  const record = {
    id: attId,
    taskId: String(taskId),
    filename: sanitizeFilename(filename),
    size: buffer.length,
    contentType: String(contentType || "application/octet-stream"),
    actor: String(actor || ""),
    createdAt: Date.now(),
  };
  appendJsonl(attachmentIndexFile(projectId), record);
  return { ...record };
}

function getAttachmentMeta(projectId, attId) {
  safeId(attId);
  const records = readJsonl(attachmentIndexFile(projectId));
  const folded = foldLatest(records);
  const r = folded.get(String(attId));
  if (!r || r.deleted) return undefined;
  return { ...r };
}

function getAttachmentPath(projectId, attId) {
  return attachmentBlobPath(projectId, attId);
}

function listAttachments(projectId, taskId) {
  const records = readJsonl(attachmentIndexFile(projectId));
  const folded = foldLatest(records);
  const result = [];
  for (const r of folded.values()) {
    if (r.deleted) continue;
    if (r.taskId !== String(taskId)) continue;
    result.push({ ...r });
  }
  result.sort((a, b) => a.createdAt - b.createdAt);
  return result;
}

function deleteAttachment(projectId, attId) {
  safeId(attId);
  const tombstone = {
    id: String(attId),
    deleted: true,
    updatedAt: Date.now(),
  };
  ensureDir(path.join(ATTACHMENTS_DIR, safeId(projectId)));
  appendJsonl(attachmentIndexFile(projectId), tombstone);
  // Best-effort unlink of the blob.
  try {
    fs.unlinkSync(attachmentBlobPath(projectId, attId));
  } catch {
    /* ENOENT is fine — the blob may already be gone */
  }
}

function deleteAttachmentsForTask(projectId, taskId) {
  const records = readJsonl(attachmentIndexFile(projectId));
  const folded = foldLatest(records);
  const file = attachmentIndexFile(projectId);
  for (const r of folded.values()) {
    if (r.deleted) continue;
    if (r.taskId !== String(taskId)) continue;
    const tombstone = {
      id: r.id,
      deleted: true,
      updatedAt: Date.now(),
    };
    ensureDir(path.join(ATTACHMENTS_DIR, safeId(projectId)));
    appendJsonl(file, tombstone);
    try {
      fs.unlinkSync(attachmentBlobPath(projectId, r.id));
    } catch {
      /* ENOENT ok */
    }
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
// Record: {id, recipient, event, taskId, projectId, summary, createdAt, readAt}
// Bounded atomic JSON (mirrors push.js / registry.js style).

let notifStore = [];

function loadNotifications() {
  try {
    const raw = fs.readFileSync(NOTIFICATIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    notifStore = Array.isArray(parsed) ? parsed : [];
  } catch {
    notifStore = [];
  }
}

function persistNotifications() {
  const json = JSON.stringify(notifStore, null, 2);
  fs.writeFileSync(NOTIFICATIONS_TMP, json, "utf8");
  fs.renameSync(NOTIFICATIONS_TMP, NOTIFICATIONS_FILE);
}

function notify(recipient, { event, taskId, projectId, summary }) {
  const record = {
    id: newId("ntf"),
    recipient: String(recipient),
    event: String(event || ""),
    taskId: taskId != null ? String(taskId) : null,
    projectId: projectId != null ? String(projectId) : null,
    summary: String(summary || ""),
    createdAt: Date.now(),
    readAt: null,
  };
  notifStore.push(record);
  // Prune oldest past cap.
  if (notifStore.length > NOTIFICATIONS_MAX) {
    notifStore.splice(0, notifStore.length - NOTIFICATIONS_MAX);
  }
  persistNotifications();
}

function listNotifications(recipient, { unreadOnly = false } = {}) {
  let result = notifStore.filter((n) => n.recipient === String(recipient));
  if (unreadOnly) {
    result = result.filter((n) => n.readAt === null);
  }
  // Newest first.
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result.map((n) => ({ ...n }));
}

function markRead(recipient, { ids, all = false } = {}) {
  const now = Date.now();
  let count = 0;
  const recip = String(recipient);
  const idSet = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  for (const n of notifStore) {
    if (n.recipient !== recip) continue;
    if (n.readAt !== null) continue; // already read
    if (all || (idSet && idSet.has(n.id))) {
      n.readAt = now;
      count++;
    }
  }
  if (count > 0) persistNotifications();
  return count;
}

// ---------------------------------------------------------------------------
// Cleanup: delete ALL collab data for a project
// ---------------------------------------------------------------------------

function deleteAllForProject(projectId) {
  const pid = safeId(projectId);

  // 1. Activity JSONL
  try {
    fs.unlinkSync(path.join(ACTIVITY_DIR, `${pid}.jsonl`));
  } catch {
    /* ENOENT ok */
  }

  // 2. Comments JSONL
  try {
    fs.unlinkSync(path.join(COMMENTS_DIR, `${pid}.jsonl`));
  } catch {
    /* ENOENT ok */
  }

  // 3. Attachments directory (index + all blobs)
  try {
    fs.rmSync(path.join(ATTACHMENTS_DIR, pid), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ENOENT ok */
  }

  // 4. Scrub notifications referencing this project
  const before = notifStore.length;
  notifStore = notifStore.filter((n) => n.projectId !== pid);
  if (notifStore.length !== before) persistNotifications();
}

// ---------------------------------------------------------------------------
// Init: load notifications on import (JSONL stores are stateless reads)
// ---------------------------------------------------------------------------
ensureDir(DATA_DIR);
loadNotifications();

export default {
  // Comments
  addComment,
  editComment,
  deleteComment,
  listComments,
  deleteCommentsForTask,
  // Activity
  appendActivity,
  listActivity,
  // Attachments
  addAttachment,
  getAttachmentMeta,
  getAttachmentPath,
  listAttachments,
  deleteAttachment,
  deleteAttachmentsForTask,
  // Notifications
  notify,
  listNotifications,
  markRead,
  // Cleanup
  deleteAllForProject,
};
