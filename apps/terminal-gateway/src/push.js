// Web Push ("your job finished" notifications).
//
// The gateway owns push end to end. This module has two jobs:
//   1. VAPID config — read the keypair from env and configure the `web-push`
//      library. Absent/invalid keys => push is simply "not configured": every
//      caller degrades gracefully and the gateway still boots untouched.
//   2. Subscription store — a gitignored push-subscriptions.json next to the
//      gateway .env (mirrors registry.js/servers.json: atomic tmp+rename write,
//      missing/corrupt file starts empty). Single-user auth => effectively one
//      user with many device subscriptions, deduped by endpoint URL.
//
// It also exposes sendToAll(payload): encrypt + POST to every stored endpoint
// via web-push (RFC 8291 aes128gcm), pruning any endpoint the push service
// reports dead (404/410). It deliberately knows NOTHING about the poll loop —
// server.js drives that and calls in here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// push-subscriptions.json sits next to the gateway .env (apps/terminal-gateway/),
// one dir up from src/. Overridable for tests via PUSH_SUBSCRIPTIONS_FILE.
const FILE =
  process.env.PUSH_SUBSCRIPTIONS_FILE ||
  path.join(__dirname, "..", "push-subscriptions.json");
const TMP = `${FILE}.tmp`;

// ---- VAPID configuration ----
// setVapidDetails() throws on missing/invalid keys or a subject that is not a
// mailto: / https: URL, so it is called ONLY when all three are present, inside
// a try/catch — a bad config marks push unconfigured, never crashes boot.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.warn(
      `[push] VAPID configuration invalid; push disabled: ${err.message}`,
    );
    configured = false;
  }
} else {
  console.warn(
    "[push] VAPID keys not set (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); push notifications disabled.",
  );
}

function isConfigured() {
  return configured;
}

function getPublicKey() {
  return configured ? VAPID_PUBLIC_KEY : null;
}

// ---- Subscription store ----
let store = []; // array of PushSubscription objects (endpoint + keys)

// A subscription must have a string endpoint and the two encryption keys. Bad
// records are dropped rather than crashing the whole load.
function sanitize(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.endpoint !== "string" || !entry.endpoint) return null;
  const keys = entry.keys;
  if (!keys || typeof keys !== "object") return null;
  if (typeof keys.p256dh !== "string" || !keys.p256dh) return null;
  if (typeof keys.auth !== "string" || !keys.auth) return null;
  const record = {
    endpoint: entry.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
  if (entry.expirationTime === null || typeof entry.expirationTime === "number")
    record.expirationTime = entry.expirationTime ?? null;
  return record;
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    store = Array.isArray(parsed) ? parsed.map(sanitize).filter(Boolean) : [];
  } catch {
    store = []; // missing or corrupt file => no subscriptions
  }
  return store;
}

function persist() {
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(TMP, json, "utf8");
  fs.renameSync(TMP, FILE);
}

function list() {
  return store.map((s) => ({ ...s, keys: { ...s.keys } }));
}

function count() {
  return store.length;
}

// Store a subscription, deduped by endpoint (re-subscribe REPLACES, never
// appends). Returns the current count.
function add(sub) {
  const record = sanitize(sub);
  if (!record) throw new Error("invalid subscription");
  const idx = store.findIndex((s) => s.endpoint === record.endpoint);
  if (idx >= 0) store[idx] = record;
  else store.push(record);
  persist();
  return store.length;
}

// Remove a subscription by endpoint. Idempotent — returns true whether or not
// it was present (so unsubscribe is a clean no-op on an unknown endpoint).
function remove(endpoint) {
  const idx = store.findIndex((s) => s.endpoint === endpoint);
  if (idx < 0) return false;
  store.splice(idx, 1);
  persist();
  return true;
}

// ---- Sending ----
// Encrypt + POST `payload` (a plain object, JSON-serialized) to every stored
// subscription. A 404/410 from the push service means the endpoint is dead:
// prune it so the store never rots. Other errors are logged and left alone
// (transient / best-effort — jobs survive, notifications don't have to).
// Returns { sent, pruned, failed }.
async function sendToAll(payload) {
  if (!configured) return { sent: 0, pruned: 0, failed: 0, skipped: true };
  const body = JSON.stringify(payload);
  const targets = [...store];
  let sent = 0;
  let pruned = 0;
  let failed = 0;
  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
        sent++;
      } catch (err) {
        const code =
          err && typeof err.statusCode === "number" ? err.statusCode : 0;
        if (code === 404 || code === 410) {
          remove(sub.endpoint);
          pruned++;
        } else {
          failed++;
          console.warn(
            `[push] send failed (status ${code || "?"}): ${err.message}`,
          );
        }
      }
    }),
  );
  return { sent, pruned, failed };
}

load();

export default {
  isConfigured,
  getPublicKey,
  list,
  count,
  add,
  remove,
  sendToAll,
};
