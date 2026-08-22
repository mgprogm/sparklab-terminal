// Persisted, one-shot terminal actions created through Agent Chat.  Keeping
// these in the gateway means a chat WebSocket (or agent-service restart) does
// not discard an already approved action.
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
  process.env.SCHEDULED_TERMINAL_ACTIONS_FILE ||
  path.join(__dirname, "..", "data", "scheduled-terminal-actions.json");
const TMP = `${FILE}.tmp`;

let store = [];

function inputEncryptionKey() {
  const raw = process.env.SCHEDULED_TERMINAL_ACTIONS_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function encryptInput(text) {
  const key = inputEncryptionKey();
  if (!key) {
    const error = new Error(
      "scheduled terminal input is not configured; set SCHEDULED_TERMINAL_ACTIONS_KEY to a base64 32-byte key",
    );
    error.code = "SCHEDULED_INPUT_KEY_UNAVAILABLE";
    throw error;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
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

function decryptInput(input) {
  const key = inputEncryptionKey();
  if (!key)
    throw new Error("scheduled terminal input encryption key is unavailable");
  if (!input || typeof input !== "object")
    throw new Error("scheduled terminal input payload is invalid");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(input.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("scheduled terminal input cannot be decrypted");
  }
}

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

function publicAction(action) {
  const { input: _input, ...rest } = action;
  return {
    ...rest,
    kind: action.kind || "keys",
    ...(action.kind === "input" ? { hasText: true } : {}),
  };
}

function list() {
  return store.map(publicAction);
}

function create({ sessionId, keys, executeAt }) {
  const action = {
    id: `terminal-action-${randomUUID()}`,
    kind: "keys",
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
  return publicAction(action);
}

function createInput({ sessionId, text, keys, executeAt }) {
  const action = {
    id: `terminal-action-${randomUUID()}`,
    kind: "input",
    sessionId,
    keys,
    input: encryptInput(text),
    executeAt,
    status: "scheduled",
    createdAt: Date.now(),
    executedAt: null,
    error: null,
  };
  store.push(action);
  persist();
  return publicAction(action);
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

export default {
  load,
  list,
  create,
  createInput,
  decryptInput,
  due,
  claim,
  finish,
  cancel,
};
