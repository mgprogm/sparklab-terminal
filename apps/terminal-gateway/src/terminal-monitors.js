// Persisted deterministic terminal monitors. They never ask an LLM to decide
// what to execute: a monitor can only run the literal action approved at create.
import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE =
  process.env.TERMINAL_MONITORS_FILE ||
  path.join(__dirname, "..", "data", "terminal-monitors.json");
const TMP = `${FILE}.tmp`;
let store = [];

function key() {
  const value = process.env.SCHEDULED_TERMINAL_ACTIONS_KEY?.trim();
  const parsed = value ? Buffer.from(value, "base64") : null;
  return parsed?.length === 32 ? parsed : null;
}
function encrypt(text) {
  const k = key();
  if (!k) {
    const error = new Error(
      "autonomous terminal monitors require SCHEDULED_TERMINAL_ACTIONS_KEY",
    );
    error.code = "MONITOR_KEY_UNAVAILABLE";
    throw error;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function decrypt(payload) {
  const k = key();
  if (!k) throw new Error("terminal monitor encryption key is unavailable");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      k,
      Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("terminal monitor payload cannot be decrypted");
  }
}
function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2));
  fs.renameSync(TMP, FILE);
}
function publicMonitor(m) {
  const { trigger: _trigger, actionText: _actionText, ...rest } = m;
  return {
    ...rest,
    hasTriggerText: true,
    ...(m.actionType === "keys" ? {} : { hasActionText: true }),
  };
}
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code !== "ENOENT")
      console.error("FAILED TO LOAD TERMINAL MONITORS:", error);
    store = [];
  }
  return list();
}
function list() {
  return store.map(publicMonitor);
}
function create({
  sessionId,
  triggerText,
  actionType,
  actionText,
  keys,
  intervalMs,
  expiresAt,
  maxExecutions,
}) {
  const now = Date.now();
  const monitor = {
    id: `terminal-monitor-${randomUUID()}`,
    sessionId,
    trigger: encrypt(triggerText),
    actionType,
    ...(actionType === "keys" ? {} : { actionText: encrypt(actionText) }),
    keys,
    intervalMs,
    expiresAt,
    maxExecutions,
    executionCount: 0,
    status: "active",
    createdAt: now,
    nextCheckAt: now,
    lastCheckedAt: null,
    lastMatchedAt: null,
    lastExecutedAt: null,
    error: null,
  };
  store.push(monitor);
  persist();
  return publicMonitor(monitor);
}
function due(now = Date.now()) {
  return store
    .filter(
      (m) => m.status === "active" && m.nextCheckAt <= now && m.expiresAt > now,
    )
    .map((m) => JSON.parse(JSON.stringify(m)));
}
function finishCheck(id, { matched, error = null }) {
  const m = store.find((item) => item.id === id);
  if (!m || m.status !== "active") return;
  const now = Date.now();
  m.lastCheckedAt = now;
  m.error = error;
  if (matched) m.lastMatchedAt = now;
  if (m.expiresAt <= now) m.status = "completed";
  else m.nextCheckAt = now + m.intervalMs;
  persist();
}
function claimExecution(id) {
  const m = store.find((item) => item.id === id);
  if (!m || m.status !== "active" || m.executionCount >= m.maxExecutions)
    return;
  m.executionCount += 1;
  m.lastExecutedAt = Date.now();
  if (m.executionCount >= m.maxExecutions) m.status = "completed";
  persist();
  return JSON.parse(JSON.stringify(m));
}
function cancel(id) {
  const m = store.find((item) => item.id === id);
  if (!m || m.status !== "active") return;
  m.status = "cancelled";
  persist();
  return publicMonitor(m);
}
export default {
  load,
  list,
  create,
  due,
  finishCheck,
  claimExecution,
  cancel,
  decrypt,
};
