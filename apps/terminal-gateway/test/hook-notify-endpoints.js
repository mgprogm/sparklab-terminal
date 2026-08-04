// POST /api/push/hook-notify integration test — proves the CLI turn-finished
// notification route against a REAL gateway + REAL tmux sessions.
//
// Covers: auth (dedicated HOOK_NOTIFY_TOKEN, wrong token -> 401, no token ->
// 401), validation (missing/bad fields -> 400), the graceful 503 when push is
// not configured, session resolution (unknown -> ok:false, a DEAD session
// whose metadata outlived its tmux session -> ok:false "unknown_session" —
// the fail-closed liveness check this route's design specifically added,
// live -> resolves + fires), mute suppression, that the global duration
// threshold has NO effect on this path (unlike the shell-transition poll
// loop), idempotency dedup (same eventId collapses; different eventId does
// not; no-eventId falls back to a short cooldown), a per-session rate limit,
// a leak-guard regression (a `detail` field is never echoed into the actual
// encrypted push payload) and its positive counterpart (the session's
// name/org/project — user-assigned labels, never CLI content — DO appear in
// the body, so different sessions are distinguishable). Both proven via
// ciphertext-length differencing against a real EC subscription + local mock
// push endpoint, rather than full aes128gcm decryption.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const webpush = require("web-push");

const PORT = 3996;
const NC_PORT = 3997; // not-configured (no VAPID) gateway
const BASE = `http://localhost:${PORT}`;
const NC_BASE = `http://localhost:${NC_PORT}`;
const AUTH_USER = "hookuser";
const AUTH_PASS = "hookpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const TOKEN = "test-hook-token-" + crypto.randomBytes(8).toString("hex");
const WRONG_TOKEN = "definitely-not-the-token";

const VAPID = webpush.generateVAPIDKeys();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scratch;
let gw; // configured gateway
let ncGw; // push-not-configured gateway
let cookie = "";
const toClose = [];
const createdTmux = [];

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        GATEWAY_DATA_DIR: scratch,
        PUSH_SUBSCRIPTIONS_FILE: path.join(scratch, `push-subs-${port}.json`),
        PUSH_SETTINGS_FILE: path.join(scratch, `push-settings-${port}.json`),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdoutBuf = "";
    let started = false;
    proc.stdout.on("data", (d) => {
      proc.stdoutBuf += d.toString();
      if (!started && proc.stdoutBuf.includes("listening on")) {
        started = true;
        resolve(proc);
      }
    });
    proc.stderr.on("data", (d) => process.stderr.write(`[gw:${port}] ${d}`));
    setTimeout(() => reject(new Error("server did not start in time")), 8000);
  });
}

// Parse `[push] notify {json}` lines the gateway emits for EVERY notification
// (generic observability channel — session + status only, never message
// text). Used to prove a hook call actually reached emitNotify.
function notifyEvents(proc) {
  const out = [];
  for (const line of proc.stdoutBuf.split("\n")) {
    const m = /\[push\] notify (\{.*\})\s*$/.exec(line);
    if (m) {
      try {
        out.push(JSON.parse(m[1]));
      } catch {
        /* ignore partial line */
      }
    }
  }
  return out;
}

async function waitForNotify(proc, pred, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ev = notifyEvents(proc).find(pred);
    if (ev) return ev;
    await sleep(100);
  }
  return null;
}

async function req(base, method, pathname, { body, origin, headers } = {}) {
  const h = { ...(headers || {}) };
  if (cookie) h["cookie"] = cookie;
  if (origin) h["origin"] = origin;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${base}${pathname}`, { method, headers: h, body: payload });
}

async function hookNotify(base, token, body) {
  const h = { "content-type": "application/json" };
  if (token) h["authorization"] = `Bearer ${token}`;
  return fetch(`${base}/api/push/hook-notify`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  if (res.status !== 204) fail(`login returned ${res.status}, expected 204`);
  const m = /gw_session=[^;]+/.exec(res.headers.get("set-cookie") || "");
  assert(m, "login did not return gw_session cookie");
  cookie = m[0];
}

const enc = (id) => encodeURIComponent(id);

async function makeSession(name) {
  const res = await req(BASE, "POST", "/api/sessions", {
    body: { name },
    origin: ALLOWED_ORIGIN,
  });
  assert(
    res.status === 201,
    `POST /api/sessions -> ${res.status}, expected 201`,
  );
  const id = (await res.json()).id;
  createdTmux.push(id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);
  await sleep(600);
  return id;
}

// A real P-256 EC keypair + random auth secret — a syntactically/
// cryptographically valid PushSubscription that web-push's aes128gcm encrypt
// will happily target, without needing a real browser. Only used to prove
// ciphertext-length invariance (the leak-guard test), never decrypted.
function makeSubscriptionKeys() {
  const { publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    p256dh: raw.toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
}

function makeCert(dir) {
  const keyPath = path.join(dir, "mock-key.pem");
  const certPath = path.join(dir, "mock-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function cleanup() {
  for (const c of toClose) {
    try {
      c();
    } catch {}
  }
  for (const name of createdTmux) {
    try {
      execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
    } catch {}
  }
  if (gw && !gw.killed) gw.kill("SIGTERM");
  if (ncGw && !ncGw.killed) ncGw.kill("SIGTERM");
  if (scratch) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hook-notify-test-"));

  gw = await startServer(PORT, {
    GATEWAY_AUTH_USER: AUTH_USER,
    GATEWAY_AUTH_PASSWORD: AUTH_PASS,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    HOOK_NOTIFY_TOKEN: TOKEN,
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    NODE_TLS_REJECT_UNAUTHORIZED: "0", // accept the local mock's self-signed cert
  });
  console.log(`configured gateway up on :${PORT}`);
  await login();
  console.log("logged in; cookie captured");

  // --- Auth ---------------------------------------------------------------
  {
    const res = await hookNotify(BASE, null, {
      session: "web-x",
      tool: "claude",
      kind: "turn-finished",
    });
    assert(res.status === 401, `no token -> ${res.status}, expected 401`);
  }
  {
    const res = await hookNotify(BASE, WRONG_TOKEN, {
      session: "web-x",
      tool: "claude",
      kind: "turn-finished",
    });
    assert(res.status === 401, `wrong token -> ${res.status}, expected 401`);
  }
  console.log("  ok: no token / wrong token -> 401");

  // --- Validation -----------------------------------------------------------
  const badBodies = [
    { tool: "claude", kind: "turn-finished" }, // missing session
    { session: "web-x", kind: "turn-finished" }, // missing tool
    { session: "web-x", tool: "bogus", kind: "turn-finished" }, // bad tool enum
    { session: "web-x", tool: "claude", kind: "bogus" }, // bad kind enum
    { session: "x".repeat(300), tool: "claude", kind: "turn-finished" }, // oversized session
    {
      session: "web-x",
      tool: "claude",
      kind: "turn-finished",
      eventId: "x".repeat(200),
    }, // oversized eventId
    {
      session: "web-x",
      tool: "claude",
      kind: "turn-finished",
      detail: "x".repeat(100),
    }, // oversized detail
  ];
  for (const body of badBodies) {
    const res = await hookNotify(BASE, TOKEN, body);
    assert(
      res.status === 400,
      `bad body ${JSON.stringify(body).slice(0, 60)} -> ${res.status}, expected 400`,
    );
  }
  console.log(`  ok: ${badBodies.length} malformed bodies -> 400`);

  // --- Unknown session ------------------------------------------------------
  {
    const res = await hookNotify(BASE, TOKEN, {
      session: "web-does-not-exist",
      tool: "claude",
      kind: "turn-finished",
    });
    assert(res.status === 200, `unknown session -> ${res.status}, want 200`);
    const j = await res.json();
    assert(
      j.ok === false && j.reason === "unknown_session",
      `unknown session body ${JSON.stringify(j)}`,
    );
  }
  console.log("  ok: unknown session -> ok:false unknown_session");

  // --- Live session: resolves + fires ---------------------------------------
  const sid = await makeSession("hook-test");
  const tmuxName = sid.slice(sid.indexOf("/") + 1);
  {
    const res = await hookNotify(BASE, TOKEN, {
      session: tmuxName,
      tool: "claude",
      kind: "turn-finished",
      eventId: "turn-1",
    });
    assert(res.status === 202, `live session -> ${res.status}, want 202`);
    const j = await res.json();
    assert(
      j.ok === true && j.sessionId === sid,
      `live session body ${JSON.stringify(j)}, want ok:true sessionId:${sid}`,
    );
    const ev = await waitForNotify(
      gw,
      (e) => e.sessionId === sid && e.kind === "hook" && e.tool === "claude",
    );
    assert(
      ev,
      "expected a [push] notify log line for the live-session hook call",
    );
  }
  console.log("  ok: live session resolves by bare tmux name and fires");

  // --- Dead session: metadata exists, tmux does NOT (fail-closed liveness) --
  {
    execFileSync("tmux", ["kill-session", "-t", tmuxName], {
      stdio: "ignore",
    });
    await sleep(300);
    const res = await hookNotify(BASE, TOKEN, {
      session: tmuxName,
      tool: "claude",
      kind: "turn-finished",
      eventId: "turn-dead",
    });
    assert(res.status === 200, `dead session -> ${res.status}, want 200`);
    const j = await res.json();
    assert(
      j.ok === false && j.reason === "unknown_session",
      `dead session body ${JSON.stringify(j)} — metadata outliving tmux must NOT resolve (fail-closed)`,
    );
  }
  console.log(
    "  ok: dead session (metadata present, tmux gone) -> unknown_session (fail-closed liveness)",
  );

  // --- Mute + duration-bypass, on a fresh live session -----------------------
  const sid2 = await makeSession("hook-test-2");
  const tmuxName2 = sid2.slice(sid2.indexOf("/") + 1);
  {
    const muteRes = await req(BASE, "PATCH", `/api/sessions/${enc(sid2)}`, {
      body: { muted: true },
      origin: ALLOWED_ORIGIN,
    });
    assert(muteRes.status === 200, `mute -> ${muteRes.status}`);
    const res = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "codex",
      kind: "turn-finished",
      eventId: "muted-1",
    });
    const j = await res.json();
    assert(
      j.ok === false && j.reason === "muted",
      `muted session body ${JSON.stringify(j)}`,
    );
    await req(BASE, "PATCH", `/api/sessions/${enc(sid2)}`, {
      body: { muted: false },
      origin: ALLOWED_ORIGIN,
    });
  }
  console.log("  ok: muted session -> ok:false muted");

  {
    // A huge duration threshold would suppress EVERY shell-job finish; this
    // route must ignore it entirely (D3).
    const putRes = await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 3_600_000 },
      origin: ALLOWED_ORIGIN,
    });
    assert(putRes.status === 200, `PUT settings -> ${putRes.status}`);
    const res = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "codex",
      kind: "turn-finished",
      eventId: "duration-bypass-1",
    });
    assert(res.status === 202, `duration-bypass -> ${res.status}, want 202`);
    await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 30000 },
      origin: ALLOWED_ORIGIN,
    });
  }
  console.log(
    "  ok: hook-notify fires immediately even with minDurationMs=1h (duration threshold does not apply)",
  );

  // --- Idempotency ------------------------------------------------------------
  {
    const first = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "codex",
      kind: "turn-finished",
      eventId: "dup-evt-1",
    });
    assert(
      (await first.json()).ok === true,
      "first call with eventId should fire",
    );
    const second = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "codex",
      kind: "turn-finished",
      eventId: "dup-evt-1",
    });
    const j2 = await second.json();
    assert(
      j2.ok === false && j2.reason === "duplicate",
      `duplicate eventId body ${JSON.stringify(j2)}`,
    );
    const third = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "codex",
      kind: "turn-finished",
      eventId: "dup-evt-2",
    });
    assert(
      (await third.json()).ok === true,
      "a DIFFERENT eventId must not be treated as a duplicate",
    );
  }
  console.log("  ok: same eventId dedups; different eventId does not");

  {
    // No eventId at all -> short cooldown fallback still collapses an
    // immediate repeat (older CLI payload shape with no turn/prompt id).
    const first = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "claude",
      kind: "waiting-input",
    });
    assert(
      (await first.json()).ok === true,
      "first no-eventId call should fire",
    );
    const second = await hookNotify(BASE, TOKEN, {
      session: tmuxName2,
      tool: "claude",
      kind: "waiting-input",
    });
    const j2 = await second.json();
    assert(
      j2.ok === false && j2.reason === "duplicate",
      `no-eventId rapid repeat body ${JSON.stringify(j2)}`,
    );
  }
  console.log("  ok: no-eventId rapid repeat falls back to a short cooldown");

  // --- Rate limit ---------------------------------------------------------
  {
    const sid3 = await makeSession("hook-test-ratelimit");
    const tmuxName3 = sid3.slice(sid3.indexOf("/") + 1);
    let sawRateLimited = false;
    for (let i = 0; i < 25; i++) {
      const res = await hookNotify(BASE, TOKEN, {
        session: tmuxName3,
        tool: "claude",
        kind: "turn-finished",
        eventId: `rl-${i}`,
      });
      const j = await res.json();
      if (j.ok === false && j.reason === "rate_limited") {
        sawRateLimited = true;
        break;
      }
    }
    assert(
      sawRateLimited,
      "expected rate_limited within 25 distinct-eventId calls in one minute",
    );
  }
  console.log(
    "  ok: per-session rate limit trips under rapid distinct-event calls",
  );

  // --- Leak guard: `detail` must never affect the encrypted push payload ---
  // (proven via ciphertext-length invariance, not decryption — see
  // docs/HOOK-NOTIFICATIONS-SETUP.md "Known reduced-privacy path" for why full
  // decryption isn't attempted here.)
  {
    const certDir = fs.mkdtempSync(path.join(scratch, "cert-"));
    const tls = makeCert(certDir);
    const deliveries = [];
    const mock = https.createServer(tls, (rq, rs) => {
      const chunks = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        deliveries.push(Buffer.concat(chunks).length);
        rs.writeHead(201);
        rs.end();
      });
    });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    toClose.push(() => mock.close());

    const keys = makeSubscriptionKeys();
    const subRes = await req(BASE, "POST", "/api/push/subscribe", {
      body: {
        endpoint: `https://127.0.0.1:${mock.address().port}/leak-guard`,
        keys,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(subRes.status === 201, `subscribe -> ${subRes.status}`);

    const sid4 = await makeSession("hook-test-leak");
    const tmuxName4 = sid4.slice(sid4.indexOf("/") + 1);

    const shortDetailRes = await hookNotify(BASE, TOKEN, {
      session: tmuxName4,
      tool: "claude",
      kind: "turn-finished",
      eventId: "leak-short",
      detail: "x",
    });
    assert(
      (await shortDetailRes.json()).ok === true,
      "leak-guard short-detail call should fire",
    );

    const longDetailRes = await hookNotify(BASE, TOKEN, {
      session: tmuxName4,
      tool: "claude",
      kind: "turn-finished",
      eventId: "leak-long",
      detail: "SECRET".repeat(10).slice(0, 64),
    });
    assert(
      (await longDetailRes.json()).ok === true,
      "leak-guard long-detail call should fire",
    );

    const deadline = Date.now() + 5000;
    while (deliveries.length < 2 && Date.now() < deadline) await sleep(100);
    assert(
      deliveries.length === 2,
      `expected 2 mock deliveries, got ${deliveries.length}`,
    );
    assert(
      deliveries[0] === deliveries[1],
      `ciphertext lengths differ (${deliveries[0]} vs ${deliveries[1]}) — a differing 'detail' length must NEVER change the encrypted push payload size`,
    );
  }
  console.log(
    "  ok: leak-guard — varying `detail` length never changes the encrypted push payload size",
  );

  // --- Identity enrichment: session name/org/project DO appear in the body --
  // The positive counterpart to the leak-guard test above: a session's name
  // and org/project (user-assigned labels, never CLI content — see
  // hookNotifyCopy) must actually change the payload, so two sessions with
  // very different name/org/project lengths produce DIFFERENT ciphertext
  // lengths. Proven the same way as the leak-guard (length, not decryption),
  // just asserting the opposite direction.
  {
    const certDir = fs.mkdtempSync(path.join(scratch, "cert2-"));
    const tls = makeCert(certDir);
    const deliveries = [];
    const mock = https.createServer(tls, (rq, rs) => {
      const chunks = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        deliveries.push(Buffer.concat(chunks).length);
        rs.writeHead(201);
        rs.end();
      });
    });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    toClose.push(() => mock.close());

    const keys = makeSubscriptionKeys();
    const subRes = await req(BASE, "POST", "/api/push/subscribe", {
      body: {
        endpoint: `https://127.0.0.1:${mock.address().port}/identity-check`,
        keys,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(subRes.status === 201, `subscribe -> ${subRes.status}`);

    const shortSid = await makeSession("a");
    const shortTmux = shortSid.slice(shortSid.indexOf("/") + 1);
    const longRes = await req(BASE, "POST", "/api/sessions", {
      body: {
        name: "a-very-long-descriptive-session-name-indeed",
        org: "some-organization",
        project: "some-project",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(longRes.status === 201, `create long session -> ${longRes.status}`);
    const longSid = (await longRes.json()).id;
    createdTmux.push(longSid.slice(longSid.indexOf("/") + 1));
    const longTmux = longSid.slice(longSid.indexOf("/") + 1);
    await sleep(600);

    await hookNotify(BASE, TOKEN, {
      session: shortTmux,
      tool: "claude",
      kind: "turn-finished",
      eventId: "identity-short",
    });
    await hookNotify(BASE, TOKEN, {
      session: longTmux,
      tool: "claude",
      kind: "turn-finished",
      eventId: "identity-long",
    });

    const deadline = Date.now() + 5000;
    while (deliveries.length < 2 && Date.now() < deadline) await sleep(100);
    assert(
      deliveries.length === 2,
      `expected 2 mock deliveries, got ${deliveries.length}`,
    );
    assert(
      deliveries[1] > deliveries[0],
      `expected the long-name/org/project session's payload (${deliveries[1]}) to be LARGER than the short one's (${deliveries[0]}) — session identity does not appear to be embedded in the body`,
    );
  }
  console.log(
    "  ok: session name/org/project ARE embedded in the notification body (differential ciphertext-length check)",
  );

  // --- Push not configured -> 503 -------------------------------------------
  ncGw = await startServer(NC_PORT, {
    GATEWAY_AUTH_USER: AUTH_USER,
    GATEWAY_AUTH_PASSWORD: AUTH_PASS,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    HOOK_NOTIFY_TOKEN: TOKEN,
    // no VAPID_* -> push.isConfigured() === false
  });
  {
    const res = await hookNotify(NC_BASE, TOKEN, {
      session: "web-x",
      tool: "claude",
      kind: "turn-finished",
    });
    assert(res.status === 503, `not-configured -> ${res.status}, want 503`);
  }
  console.log("  ok: push not configured -> 503");

  console.log(
    "\nPASS: hook-notify endpoints — auth (no/wrong token), validation, unknown/live/dead session resolution (fail-closed liveness), mute suppression, duration-threshold bypass, idempotency (eventId dedup + no-eventId cooldown), rate limiting, leak-guard (detail never affects payload size), identity enrichment (name/org/project DO affect payload size), graceful 503.",
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
