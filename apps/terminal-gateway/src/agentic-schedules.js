// Scheduled Agentic AI definitions and firing state. This is a synchronous
// sidecar store: every mutation is persisted atomically before it returns.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE =
  process.env.AGENT_SCHEDULES_FILE ||
  path.join(DATA_DIR, "agentic-schedules.json");
const TMP = `${FILE}.tmp`;

const configuredMaxInterval = Number(process.env.AGENT_SCHEDULE_MAX_INTERVAL);
const AGENT_SCHEDULE_MAX_INTERVAL =
  Number.isInteger(configuredMaxInterval) && configuredMaxInterval >= 1
    ? configuredMaxInterval
    : 1000;

let store = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new Error("schedule spec must be an object");
  if (!Number.isInteger(spec.interval) || spec.interval < 1)
    throw new Error("schedule interval must be an integer >= 1");
  if (spec.interval > AGENT_SCHEDULE_MAX_INTERVAL)
    throw new Error(
      `schedule interval must be <= ${AGENT_SCHEDULE_MAX_INTERVAL}`,
    );
  if (
    spec.atHour !== undefined &&
    (!Number.isInteger(spec.atHour) || spec.atHour < 0 || spec.atHour > 23)
  )
    throw new Error("schedule atHour must be an integer from 0 to 23");
  if (
    spec.atMinute !== undefined &&
    (!Number.isInteger(spec.atMinute) ||
      spec.atMinute < 0 ||
      spec.atMinute > 59)
  )
    throw new Error("schedule atMinute must be an integer from 0 to 59");

  if (spec.every === "minute") {
    if (spec.atHour !== undefined || spec.atMinute !== undefined)
      throw new Error("minute schedules cannot set atHour or atMinute");
  } else if (spec.every === "hour") {
    if (spec.atHour !== undefined)
      throw new Error("hour schedules cannot set atHour");
  } else if (spec.every !== "day") {
    throw new Error("schedule every must be minute, hour, or day");
  }

  return {
    every: spec.every,
    interval: spec.interval,
    ...(spec.atHour !== undefined ? { atHour: spec.atHour } : {}),
    ...(spec.atMinute !== undefined ? { atMinute: spec.atMinute } : {}),
  };
}

// Return the first fixed-anchor UTC recurrence strictly after fromMs.
function computeNextFireAt(spec, fromMs, anchorMs) {
  const normalized = validateSpec(spec);
  if (!Number.isFinite(fromMs) || !Number.isFinite(anchorMs))
    throw new Error("schedule timestamps must be finite numbers");

  if (normalized.every === "minute") {
    const stepMs = normalized.interval * 60_000;
    const offset = Math.max(0, Math.floor((fromMs - anchorMs) / stepMs) + 1);
    return anchorMs + offset * stepMs;
  }

  const anchor = new Date(anchorMs);
  if (normalized.every === "hour") {
    const baseMs = Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate(),
      anchor.getUTCHours(),
      normalized.atMinute ?? 0,
    );
    const stepMs = normalized.interval * 60 * 60_000;
    const offset = Math.max(0, Math.floor((fromMs - baseMs) / stepMs) + 1);
    return baseMs + offset * stepMs;
  }

  const baseMs = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate(),
    normalized.atHour ?? 0,
    normalized.atMinute ?? 0,
  );
  const stepMs = normalized.interval * 24 * 60 * 60_000;
  const offset = Math.max(0, Math.floor((fromMs - baseMs) / stepMs) + 1);
  return baseMs + offset * stepMs;
}

function load() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
  } catch {
    /* persist will surface an unusable directory */
  }
  let raw;
  try {
    raw = fs.readFileSync(FILE, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT")
      console.error(`FAILED TO LOAD AGENT SCHEDULES FROM ${FILE}:`, error);
    store = [];
    return store;
  }
  try {
    const parsed = JSON.parse(raw);
    store = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`CORRUPT AGENT SCHEDULES JSON AT ${FILE}:`, error);
    store = [];
  }
  return store;
}

function persist() {
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(TMP, FILE);
}

function list() {
  return clone(store);
}

function get(id) {
  const found = store.find((schedule) => schedule.id === id);
  return found ? clone(found) : undefined;
}

function count() {
  return store.filter((schedule) => schedule.enabled === true).length;
}

function resolveFingerprint(agenticId, fingerprint) {
  const value =
    typeof fingerprint === "function" ? fingerprint(agenticId) : fingerprint;
  if (typeof value !== "string" || !value)
    throw new Error("schedule definition fingerprint is required");
  return value;
}

function create(body = {}, fingerprint) {
  const spec = validateSpec(body.spec);
  const createdAt = Date.now();
  const record = {
    id: `schedule-${randomUUID()}`,
    agenticId: String(body.agenticId),
    serverId: String(body.serverId),
    cwd: String(body.cwd),
    objective: String(body.objective),
    spec,
    enabled: body.enabled === true,
    defFingerprint: resolveFingerprint(body.agenticId, fingerprint),
    lastFiredAt: null,
    nextFireAt: computeNextFireAt(spec, createdAt, createdAt),
    lastAttemptAt: null,
    lastOutcome: null,
    lastError: null,
    createdAt,
  };
  store.push(record);
  persist();
  return clone(record);
}

function update(id, patch = {}, fingerprint) {
  const index = store.findIndex((schedule) => schedule.id === id);
  if (index < 0) return undefined;
  const current = store[index];
  const next = { ...current };

  for (const field of [
    "agenticId",
    "serverId",
    "cwd",
    "objective",
    "enabled",
    "lastFiredAt",
    "nextFireAt",
    "lastAttemptAt",
    "lastOutcome",
    "lastError",
  ]) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  if (patch.spec !== undefined) next.spec = validateSpec(patch.spec);

  // Supplying the executable fingerprint marks a human schedule-definition
  // edit. Re-pin the closure and recurrence from now; scheduler state-only
  // updates omit it and retain their explicitly claimed nextFireAt.
  if (fingerprint !== undefined) {
    next.defFingerprint = resolveFingerprint(next.agenticId, fingerprint);
    next.nextFireAt = computeNextFireAt(next.spec, Date.now(), next.createdAt);
  }

  store[index] = next;
  persist();
  return clone(next);
}

function deleteSchedule(id) {
  const index = store.findIndex((schedule) => schedule.id === id);
  if (index < 0) return false;
  store.splice(index, 1);
  persist();
  return true;
}

load();

export default {
  load,
  list,
  get,
  create,
  update,
  delete: deleteSchedule,
  count,
  computeNextFireAt,
};
