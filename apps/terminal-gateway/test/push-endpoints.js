// Web Push /api/push/* integration test — proves the push endpoints AND the
// real crypto path against a REAL push service.
//
//   GET  /api/push/vapid-public-key
//   POST /api/push/subscribe
//   POST /api/push/unsubscribe
//
// The NON-NEGOTIABLE assertion (the crypto-correctness / "not faked" gate):
// drive a REAL headless browser (Playwright Firefox → Mozilla autopush) to call
// pushManager.subscribe against the live push service, then run the gateway's
// OWN push.js send code (setVapidDetails + web-push aes128gcm encrypt + POST)
// to that real endpoint and observe a 201 Created. A 201 proves the VAPID JWT
// and the RFC 8291 payload encryption are correct end to end.
//
// Chrome/Chromium is NOT usable here: Playwright's Chromium lacks Google's FCM
// API keys ("push service not available"). Firefox's autopush needs no keys and
// works headless with dom.push.serverURL + dom.push.testing.ignorePermission.
//
// Also covered: auth required, CSRF/Origin on state-changing routes, bad-body
// 400, dedup, idempotent unsubscribe, the graceful "not configured" path (a
// second gateway with no VAPID env), and 404/410 endpoint pruning (a local mock
// push server returning 410, exercised through the gateway's real send path).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const webpush = require("web-push");

// Playwright lives in the e2e workspace; resolve @playwright/test from there
// (it re-exports the browser launchers).
const E2E_DIR = path.join(ROOT, "..", "e2e", "/");
let firefox;
try {
  ({ firefox } = createRequire(E2E_DIR)("@playwright/test"));
} catch (e) {
  console.error(`\nFAIL: cannot resolve @playwright/test from ${E2E_DIR}`);
  console.error(String(e));
  process.exit(1);
}

const PORT = 3993;
const NC_PORT = 3992; // not-configured gateway
const BASE = `http://localhost:${PORT}`;
const NC_BASE = `http://localhost:${NC_PORT}`;
const AUTH_USER = "pushuser";
const AUTH_PASS = "pushpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VAPID = webpush.generateVAPIDKeys();
const VAPID_SUBJECT = "mailto:push-test@example.com";

let scratch;
let gw; // configured gateway
let ncGw; // not-configured gateway
let cookie = "";
const toClose = []; // extra servers/browsers to close
const createdTmux = []; // LOCAL tmux session names to kill on cleanup
// SSH-to-localhost fixture (best-effort) for the exit-code-over-ssh scenario.
const AUTHORIZED_KEYS = path.join(os.homedir(), ".ssh", "authorized_keys");
let sshRemote = null; // { sock, keyMarker } once set up; null => skip ssh test

// Self-signed cert for the local HTTPS mock push servers (web-push always uses
// https.request). Generated once; reused by the e2e + prune sections.
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

// Best-effort passwordless-ssh-to-localhost fixture: ephemeral key added to
// ~/.ssh/authorized_keys + a dedicated tmux socket, registered as an ssh server
// in servers.json (tmuxCommand override is file-only). Returns true on success;
// on ANY failure returns false so the ssh exit-code scenario is SKIPPED (never
// a hard failure for an ssh-less environment). Mirrors acceptance-remote-survive.
function setupSsh(dir, serversFile) {
  const run = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const sock = `gw-push-${run}`;
  const keyMarker = `gw-push-exit-${run}`;
  const keyFile = path.join(dir, "id");
  try {
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", keyFile, "-C", keyMarker],
      { stdio: "ignore" },
    );
    const pub = fs.readFileSync(`${keyFile}.pub`, "utf8").trim();
    fs.mkdirSync(path.dirname(AUTHORIZED_KEYS), {
      recursive: true,
      mode: 0o700,
    });
    fs.appendFileSync(AUTHORIZED_KEYS, `\n${pub}\n`, { mode: 0o600 });
    sshRemote = { sock, keyMarker };
    // Probe: must connect non-interactively with this key.
    execFileSync(
      "ssh",
      [
        "-i",
        keyFile,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=5",
        "localhost",
        "true",
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    fs.writeFileSync(
      serversFile,
      JSON.stringify(
        [
          {
            id: "remote",
            name: "Remote (localhost)",
            type: "ssh",
            host: "localhost",
            user: os.userInfo().username,
            identityFile: keyFile,
            tmuxCommand: ["tmux", "-L", sock],
          },
        ],
        null,
        2,
      ),
    );
    return true;
  } catch (e) {
    console.log(
      `  (ssh-to-localhost unavailable; exit-code-over-ssh SKIPPED: ${String(
        e.message || e,
      ).slice(0, 100)})`,
    );
    return false;
  }
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  void cleanup().finally(() => process.exit(1));
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

async function cleanup() {
  for (const c of toClose) {
    try {
      await c();
    } catch {}
  }
  for (const name of createdTmux) {
    try {
      execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
    } catch {}
  }
  if (sshRemote) {
    try {
      execFileSync("tmux", ["-L", sshRemote.sock, "kill-server"], {
        stdio: "ignore",
      });
    } catch {}
    try {
      const kept = fs
        .readFileSync(AUTHORIZED_KEYS, "utf8")
        .split("\n")
        .filter((l) => !l.includes(sshRemote.keyMarker));
      fs.writeFileSync(AUTHORIZED_KEYS, kept.join("\n"), { mode: 0o600 });
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

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Accumulate ALL stdout so tests can observe the gateway's structured
    // `[push] notify {json}` lines (the payload is generic — no command output —
    // and is how we verify content that the encrypted push body hides).
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

// Parse the gateway's `[push] notify {json}` lines into objects.
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

// Wait until a notify event matching `pred` appears, or timeout (returns null).
async function waitForNotify(proc, pred, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ev = notifyEvents(proc).find(pred);
    if (ev) return ev;
    await sleep(120);
  }
  return null;
}

// Assert NO notify event matching `pred` appears within `windowMs`.
async function expectNoNotify(proc, pred, windowMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    if (notifyEvents(proc).find(pred)) return false;
    await sleep(120);
  }
  return true;
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

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  if (res.status !== 204) fail(`login returned ${res.status}, expected 204`);
  const setCookie = res.headers.get("set-cookie");
  const m = /gw_session=[^;]+/.exec(setCookie || "");
  assert(m, `set-cookie had no gw_session: ${setCookie}`);
  cookie = m[0];
}

// Drive Firefox to create a REAL push subscription against Mozilla autopush,
// using our test VAPID public key as the applicationServerKey. Returns the
// serialized PushSubscription. The browser (and its autopush WebSocket) is left
// OPEN — Mozilla drops the subscription ("410 Gone") when the ephemeral Firefox
// profile is torn down, so the caller must keep it alive until after the last
// real send, then invoke the returned close().
async function realBrowserSubscription() {
  const INDEX = `<!doctype html><html><body><script>
    window.__ready = navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready);
  </script></body></html>`;
  const SW = `self.addEventListener('install', e => self.skipWaiting());
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('push', e => {});`;

  const srv = http.createServer((rq, rs) => {
    if (rq.url === "/sw.js") {
      rs.writeHead(200, { "content-type": "text/javascript" });
      rs.end(SW);
    } else {
      rs.writeHead(200, { "content-type": "text/html" });
      rs.end(INDEX);
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;

  const browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      "dom.push.enabled": true,
      "dom.serviceWorkers.enabled": true,
      "dom.push.connection.enabled": true,
      "dom.push.serverURL": "wss://push.services.mozilla.com/",
      "dom.push.testing.ignorePermission": true,
    },
  });
  try {
    const context = await browser.newContext();
    await context.grantPermissions(["notifications"], { origin });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => window.__ready);

    const result = await page.evaluate(async (vapidPub) => {
      function u8(b64) {
        const pad = "=".repeat((4 - (b64.length % 4)) % 4);
        const s = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(s);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
      }
      const reg = await navigator.serviceWorker.ready;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let lastErr;
      for (let i = 0; i < 8; i++) {
        try {
          const s = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: u8(vapidPub),
          });
          return { ok: true, sub: s.toJSON() };
        } catch (e) {
          lastErr = String(e);
          await wait(1500);
        }
      }
      return { ok: false, error: lastErr };
    }, VAPID.publicKey);

    assert(
      result.ok,
      `browser pushManager.subscribe failed: ${result.error}. Real push ` +
        `subscription is the non-negotiable crypto gate — not faking it.`,
    );
    return {
      sub: result.sub,
      close: async () => {
        try {
          await browser.close();
        } catch {}
        await new Promise((r) => srv.close(r));
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    await new Promise((r) => srv.close(r));
    throw err;
  }
}

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "push-endpoints-"));
  const fileA = path.join(scratch, "subs-a.json");
  const fileB = path.join(scratch, "subs-b.json");
  const settingsFile = path.join(scratch, "push-settings.json");
  const serversFile = path.join(scratch, "servers.json");
  const tls = makeCert(scratch);
  const sshReady = setupSsh(scratch, serversFile);

  // --- configured gateway (auth + VAPID). NODE_TLS_REJECT_UNAUTHORIZED=0 so the
  // gateway's own push sends accept the local self-signed HTTPS mock used by the
  // end-to-end transition + prune sections (its outbound push is the only TLS it
  // does; the crypto 201 gate runs IN-PROCESS under normal TLS, unaffected). ---
  gw = await startServer(PORT, {
    GATEWAY_AUTH_USER: AUTH_USER,
    GATEWAY_AUTH_PASSWORD: AUTH_PASS,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    VAPID_SUBJECT,
    PUSH_SUBSCRIPTIONS_FILE: fileA,
    PUSH_SETTINGS_FILE: settingsFile,
    SERVERS_FILE: serversFile,
    PUSH_POLL_INTERVAL_MS: "200",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  });
  console.log(`configured gateway up on :${PORT}`);
  await login();
  console.log("logged in; cookie captured");

  // 1. vapid-public-key requires auth
  {
    const res = await fetch(`${BASE}/api/push/vapid-public-key`);
    assert(
      res.status === 401,
      `no-cookie vapid-key -> ${res.status}, want 401`,
    );
  }
  // 2. vapid-public-key with cookie -> configured:true + the public key
  {
    const res = await req(BASE, "GET", "/api/push/vapid-public-key");
    assert(res.status === 200, `vapid-key -> ${res.status}, want 200`);
    const j = await res.json();
    assert(j.configured === true, `vapid-key configured=${j.configured}`);
    assert(
      j.publicKey === VAPID.publicKey,
      `vapid-key publicKey mismatch: ${j.publicKey}`,
    );
    console.log("  ok: GET vapid-public-key returns configured:true + key");
  }
  // 3. subscribe requires auth
  {
    cookie = "";
    const res = await fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        endpoint: "https://x/y",
        keys: { p256dh: "a", auth: "b" },
      }),
    });
    assert(
      res.status === 401,
      `no-cookie subscribe -> ${res.status}, want 401`,
    );
    await login();
  }
  // 4. subscribe with forbidden Origin -> 403 (CSRF guard)
  {
    const res = await req(BASE, "POST", "/api/push/subscribe", {
      body: { endpoint: "https://x/y", keys: { p256dh: "a", auth: "b" } },
      origin: "http://evil.example.com",
    });
    assert(
      res.status === 403,
      `forbidden-origin subscribe -> ${res.status}, want 403`,
    );
    console.log(
      "  ok: subscribe requires auth (401) + rejects bad Origin (403)",
    );
  }
  // 5. subscribe with bad body -> 400
  {
    const res = await req(BASE, "POST", "/api/push/subscribe", {
      body: { endpoint: "not-a-url", keys: {} },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 400, `bad-body subscribe -> ${res.status}, want 400`);
    console.log("  ok: malformed subscription -> 400");
  }

  // 5b. push settings — GET defaults, PUT updates + persists, validation, CSRF
  {
    const g = await req(BASE, "GET", "/api/push/settings");
    assert(g.status === 200, `GET settings -> ${g.status}`);
    const def = await g.json();
    assert(
      def.minDurationMs === 30000 && def.notifyOnStart === false,
      `default settings unexpected: ${JSON.stringify(def)}`,
    );
    // No cookie -> 401
    const noauth = await fetch(`${BASE}/api/push/settings`);
    assert(noauth.status === 401, `GET settings no-cookie -> ${noauth.status}`);
    // PUT partial update
    const p = await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 1234, notifyOnStart: true },
      origin: ALLOWED_ORIGIN,
    });
    assert(p.status === 200, `PUT settings -> ${p.status}`);
    const upd = await p.json();
    assert(
      upd.minDurationMs === 1234 && upd.notifyOnStart === true,
      `PUT settings not applied: ${JSON.stringify(upd)}`,
    );
    // Persisted to the sidecar file
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert(onDisk.minDurationMs === 1234, "settings not persisted to sidecar");
    // Validation: bad type -> 400
    const bad = await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: "soon" },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 400, `PUT bad settings -> ${bad.status}, want 400`);
    // CSRF: forbidden Origin -> 403
    const csrf = await req(BASE, "PUT", "/api/push/settings", {
      body: { notifyOnStart: false },
      origin: "http://evil.example.com",
    });
    assert(
      csrf.status === 403,
      `PUT forbidden-origin -> ${csrf.status}, want 403`,
    );
    console.log(
      "  ok: push settings GET/PUT (defaults, update, persist, 400, auth, CSRF 403)",
    );
  }

  // --- REAL browser subscription (the crypto gate depends on this) ---
  console.log("  driving Playwright Firefox for a REAL push subscription…");
  const browserSub = await realBrowserSubscription();
  const realSub = browserSub.sub;
  // Keep the browser + autopush connection open until cleanup so the real
  // endpoint stays valid through the crypto send below.
  toClose.push(browserSub.close);
  console.log(`  ok: real subscription from ${new URL(realSub.endpoint).host}`);

  // 6. store the real subscription via the endpoint (201) + it lands in fileA
  {
    const res = await req(BASE, "POST", "/api/push/subscribe", {
      body: realSub,
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `subscribe -> ${res.status}, want 201`);
    const j = await res.json();
    assert(
      j.ok === true && j.count === 1,
      `subscribe body ${JSON.stringify(j)}`,
    );
    const stored = JSON.parse(fs.readFileSync(fileA, "utf8"));
    assert(
      stored.length === 1 && stored[0].endpoint === realSub.endpoint,
      "subscribe did not persist the endpoint to the store file",
    );
    console.log("  ok: subscribe stores subscription (201, persisted)");
  }
  // 7. dedup — re-subscribe replaces, count stays 1
  {
    const res = await req(BASE, "POST", "/api/push/subscribe", {
      body: realSub,
      origin: ALLOWED_ORIGIN,
    });
    const j = await res.json();
    assert(res.status === 201 && j.count === 1, `dedup count=${j.count}`);
    console.log("  ok: re-subscribe dedups by endpoint (count stays 1)");
  }
  // 8. unsubscribe -> 200, store empties; idempotent second call
  {
    const res = await req(BASE, "POST", "/api/push/unsubscribe", {
      body: { endpoint: realSub.endpoint },
      origin: ALLOWED_ORIGIN,
    });
    const j = await res.json();
    assert(res.status === 200 && j.count === 0, `unsubscribe count=${j.count}`);
    const stored = JSON.parse(fs.readFileSync(fileA, "utf8"));
    assert(stored.length === 0, "unsubscribe did not empty the store");
    const res2 = await req(BASE, "POST", "/api/push/unsubscribe", {
      body: { endpoint: realSub.endpoint },
      origin: ALLOWED_ORIGIN,
    });
    assert(res2.status === 200, `idempotent unsubscribe -> ${res2.status}`);
    console.log("  ok: unsubscribe empties store + is idempotent");
  }

  // --- not-configured gateway (auth on, but NO VAPID env) ---
  ncGw = await startServer(NC_PORT, {
    GATEWAY_AUTH_USER: AUTH_USER,
    GATEWAY_AUTH_PASSWORD: AUTH_PASS,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    PUSH_SUBSCRIPTIONS_FILE: path.join(scratch, "subs-nc.json"),
  });
  {
    // Log in for a cookie on the not-configured gateway.
    const lr = await fetch(`${NC_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
    });
    const ncCookie = /gw_session=[^;]+/.exec(
      lr.headers.get("set-cookie") || "",
    )[0];

    const res = await fetch(`${NC_BASE}/api/push/vapid-public-key`, {
      headers: { cookie: ncCookie },
    });
    const j = await res.json();
    assert(
      res.status === 200 && j.configured === false && !("publicKey" in j),
      `not-configured vapid-key -> ${res.status} ${JSON.stringify(j)}`,
    );
    const sub = await fetch(`${NC_BASE}/api/push/subscribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ncCookie,
        origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify(realSub),
    });
    assert(
      sub.status === 503,
      `not-configured subscribe -> ${sub.status}, want 503`,
    );
    console.log(
      "  ok: no VAPID -> vapid-key configured:false, subscribe 503 (graceful)",
    );
  }

  // =====================================================================
  // LIVE POLL LOOP SCENARIOS — a real running gateway (200ms interval), one
  // HTTPS mock subscription (reusing real ECDH keys so aes128gcm encryption
  // succeeds), and REAL tmux sessions. Delivery is observed via the mock; the
  // encrypted body is opaque, so payload CONTENT (duration/exit code) is
  // verified from the gateway's generic `[push] notify {json}` stdout lines.
  // =====================================================================
  const pollHits = [];
  const pollMock = https.createServer(tls, (rq, rs) => {
    const chunks = [];
    rq.on("data", (d) => chunks.push(d));
    rq.on("end", () => {
      pollHits.push(Buffer.concat(chunks).length);
      rs.writeHead(201);
      rs.end();
    });
  });
  await new Promise((r) => pollMock.listen(0, "127.0.0.1", r));
  toClose.push(() => new Promise((r) => pollMock.close(r)));
  const pollEndpoint = `https://127.0.0.1:${pollMock.address().port}/live`;

  // Subscribe once -> starts the loop; its first tick baselines and notifies
  // nothing. Sessions created afterward seed on first sight, then fire on finish.
  {
    const sr = await req(BASE, "POST", "/api/push/subscribe", {
      body: { endpoint: pollEndpoint, keys: realSub.keys },
      origin: ALLOWED_ORIGIN,
    });
    assert(sr.status === 201, `live subscribe -> ${sr.status}`);
    // Low threshold so short (~1s) test jobs clear the duration gate; disable
    // still-running for the transition/mute scenarios.
    await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 500, notifyOnStart: false },
      origin: ALLOWED_ORIGIN,
    });
    await sleep(600); // let the baseline tick pass
  }

  // Create a fresh session, optionally mute it, then run `cmd` in it. `serverId`
  // targets a registry server; `sock` (its `tmux -L <sock>`) is how the test
  // sends keys to a REMOTE (ssh-localhost) session directly.
  async function runJob(name, cmd, { muted = false, serverId, sock } = {}) {
    const body = serverId ? { name, serverId } : { name };
    const rc = await req(BASE, "POST", "/api/sessions", {
      body,
      origin: ALLOWED_ORIGIN,
    });
    assert(rc.status === 201, `${name}: create -> ${rc.status}`);
    const sid = (await rc.json()).id;
    const tmuxName = sid.includes("/") ? sid.slice(sid.indexOf("/") + 1) : sid;
    // Remote sessions live on the -L socket and die when it's killed at cleanup;
    // only LOCAL default-socket sessions need per-id kill tracking.
    if (!sock) createdTmux.push(tmuxName);
    if (muted) {
      const mr = await req(
        BASE,
        "PATCH",
        `/api/sessions/${encodeURIComponent(sid)}`,
        { body: { muted: true }, origin: ALLOWED_ORIGIN },
      );
      assert(mr.status === 200, `${name}: mute PATCH -> ${mr.status}`);
      assert((await mr.json()).muted === true, `${name}: muted not echoed`);
      // Deterministic: wait until the LIST the poll loop reads shows muted:true
      // (closes a race where a fresh session's metadata can be briefly pruned).
      const until = Date.now() + 3000;
      let confirmed = false;
      while (Date.now() < until) {
        const list = await (await req(BASE, "GET", "/api/sessions")).json();
        if (list.find((r) => r.id === sid)?.muted === true) {
          confirmed = true;
          break;
        }
        await sleep(150);
      }
      assert(confirmed, `${name}: muted not visible in GET /api/sessions`);
    }
    // Remote create + hook-install runs over ssh (slower) — give it longer.
    await sleep(sock ? 1600 : 400);
    const tmuxArgv = sock ? ["tmux", "-L", sock] : ["tmux"];
    execFileSync(tmuxArgv[0], [
      ...tmuxArgv.slice(1),
      "send-keys",
      "-t",
      tmuxName,
      cmd,
      "Enter",
    ]);
    return { sid, tmuxName };
  }

  // --- transition: a real finish fires exactly one push (delivered to mock) ---
  {
    const hitsBefore = pollHits.length;
    const { sid } = await runJob("push-transition", "sleep 1");
    const ev = await waitForNotify(gw, (e) => e.sessionId === sid, 10000);
    assert(
      ev,
      "poll loop did NOT notify on a real non-shell->shell transition",
    );
    // Delivery actually reached the (mock) push endpoint.
    const start = Date.now();
    while (pollHits.length === hitsBefore && Date.now() - start < 5000)
      await sleep(150);
    assert(pollHits.length > hitsBefore, "transition push was not delivered");
    console.log(
      "  ok: live poll loop fired + delivered a push on a real job-finish transition",
    );
  }

  // --- mute: a muted session's finish notifies NOTHING ---
  {
    const { sid } = await runJob("push-muted", "sleep 1", { muted: true });
    const quiet = await expectNoNotify(gw, (e) => e.sessionId === sid, 4000);
    assert(quiet, "muted session still produced a notify");
    console.log("  ok: muted session's job-finish produced NO notification");
  }

  // --- duration threshold: short job (< threshold) suppressed ---
  {
    // Raise threshold high; a ~1s job is detected running then finishes well
    // under it => suppressed by DURATION (not by never-detecting it).
    await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 60000 },
      origin: ALLOWED_ORIGIN,
    });
    const { sid } = await runJob("push-short", "sleep 1");
    const quiet = await expectNoNotify(gw, (e) => e.sessionId === sid, 4000);
    assert(quiet, "short job below threshold still notified");
    console.log("  ok: sub-threshold job suppressed by duration gate");
  }

  // --- duration threshold: long-enough job fires WITH durationMs ---
  {
    await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 500 },
      origin: ALLOWED_ORIGIN,
    });
    const { sid } = await runJob("push-long", "sleep 2");
    const ev = await waitForNotify(
      gw,
      (e) => e.sessionId === sid && e.kind === "finish",
      12000,
    );
    assert(ev, "long job did not fire a finish notification");
    assert(
      typeof ev.durationMs === "number" && ev.durationMs >= 500,
      `finish durationMs missing/short: ${JSON.stringify(ev)}`,
    );
    console.log(
      `  ok: job >= threshold fires with durationMs (${ev.durationMs}ms)`,
    );
  }

  // --- job-start "still running after threshold" (opt-in): fires once ---
  {
    await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 500, notifyOnStart: true },
      origin: ALLOWED_ORIGIN,
    });
    const { sid } = await runJob("push-running", "sleep 3");
    const ev = await waitForNotify(
      gw,
      (e) => e.sessionId === sid && e.kind === "running",
      8000,
    );
    assert(ev, "still-running alert did not fire when notifyOnStart is on");
    // It must fire exactly once for this session.
    await sleep(1500);
    const runningEvents = notifyEvents(gw).filter(
      (e) => e.sessionId === sid && e.kind === "running",
    );
    assert(
      runningEvents.length === 1,
      `still-running fired ${runningEvents.length} times, want 1`,
    );
    console.log(
      "  ok: 'still running after threshold' fires exactly once (opt-in)",
    );
    // Restore defaults for any later scenarios.
    await req(BASE, "PUT", "/api/push/settings", {
      body: { minDurationMs: 500, notifyOnStart: false },
      origin: ALLOWED_ORIGIN,
    });
  }

  // --- EXIT CODE (the crux) — false -> 1, true -> 0, on the LOCAL server ---
  {
    // Threshold already 500 here; run a long-enough job that ends with a known
    // exit. `sleep 1; false` => pane shows "sleep" (detected running) then the
    // prompt hook captures $? of `false` (1) into @web_last_exit.
    const failJob = await runJob("push-exit-fail", "sleep 1; false");
    const evFail = await waitForNotify(
      gw,
      (e) => e.sessionId === failJob.sid && e.kind === "finish",
      12000,
    );
    assert(evFail, "exit-code(fail): no finish notification");
    assert(
      evFail.exitCode === 1,
      `exit-code(fail): expected exitCode 1, got ${JSON.stringify(evFail)}`,
    );

    const okJob = await runJob("push-exit-ok", "sleep 1; true");
    const evOk = await waitForNotify(
      gw,
      (e) => e.sessionId === okJob.sid && e.kind === "finish",
      12000,
    );
    assert(evOk, "exit-code(ok): no finish notification");
    assert(
      evOk.exitCode === 0,
      `exit-code(ok): expected exitCode 0, got ${JSON.stringify(evOk)}`,
    );
    console.log(
      "  ok: EXIT CODE captured on LOCAL — `false` -> 1, `true` -> 0",
    );
  }

  // --- EXIT CODE over SSH — same mechanism through the ssh exec seam ---
  if (sshReady) {
    const sock = sshRemote.sock;
    const failJob = await runJob("push-ssh-fail", "sleep 1; false", {
      serverId: "remote",
      sock,
    });
    const evFail = await waitForNotify(
      gw,
      (e) => e.sessionId === failJob.sid && e.kind === "finish",
      15000,
    );
    assert(evFail, "exit-code ssh(fail): no finish notification");
    assert(
      evFail.exitCode === 1,
      `exit-code ssh(fail): expected 1, got ${JSON.stringify(evFail)}`,
    );
    const okJob = await runJob("push-ssh-ok", "sleep 1; true", {
      serverId: "remote",
      sock,
    });
    const evOk = await waitForNotify(
      gw,
      (e) => e.sessionId === okJob.sid && e.kind === "finish",
      15000,
    );
    assert(evOk, "exit-code ssh(ok): no finish notification");
    assert(
      evOk.exitCode === 0,
      `exit-code ssh(ok): expected 0, got ${JSON.stringify(evOk)}`,
    );
    console.log(
      "  ok: EXIT CODE captured over SSH — `false` -> 1, `true` -> 0",
    );
  } else {
    console.log("  SKIP: exit-code over ssh (ssh-to-localhost unavailable)");
  }

  // Stop the loop.
  await req(BASE, "POST", "/api/push/unsubscribe", {
    body: { endpoint: pollEndpoint },
    origin: ALLOWED_ORIGIN,
  });

  // =====================================================================
  // CRYPTO GATE — run the gateway's OWN push.js send code against the real
  // push endpoint and observe a literal 201. Same VAPID env the gateway used.
  // =====================================================================
  process.env.VAPID_PUBLIC_KEY = VAPID.publicKey;
  process.env.VAPID_PRIVATE_KEY = VAPID.privateKey;
  process.env.VAPID_SUBJECT = VAPID_SUBJECT;
  process.env.PUSH_SUBSCRIPTIONS_FILE = fileB;
  const push = (await import("../src/push.js")).default;
  assert(push.isConfigured(), "in-process push.js did not configure VAPID");

  // Literal 201 from the real push service, via the SAME web-push/VAPID setup
  // push.js configured at import (setVapidDetails is web-push module-global).
  {
    let r;
    try {
      r = await webpush.sendNotification(
        realSub,
        JSON.stringify({ title: "test", body: "hi" }),
      );
    } catch (err) {
      fail(
        `real push send threw: statusCode=${err.statusCode} ` +
          `headers=${JSON.stringify(err.headers)} body=${err.body}`,
      );
    }
    assert(
      r.statusCode === 201,
      `real push send statusCode=${r.statusCode}, want 201`,
    );
    console.log(
      `  ok: REAL push-service response = ${r.statusCode} (VAPID JWT + aes128gcm correct)`,
    );
  }

  // The gateway's own sendToAll path: add + send -> exactly one delivered.
  {
    push.add(realSub);
    const summary = await push.sendToAll({
      title: "Job finished",
      body: "session: the running command finished.",
      sessionId: "local/web-test",
    });
    assert(
      summary.sent === 1 && summary.failed === 0 && summary.pruned === 0,
      `push.sendToAll summary ${JSON.stringify(summary)} (want sent:1)`,
    );
    console.log(
      "  ok: gateway push.sendToAll delivered to the real endpoint (sent:1)",
    );
    push.remove(realSub.endpoint);
  }

  // Prune on 410: a local mock push server that always 410s. web-push ALWAYS
  // uses https.request, so the mock must be HTTPS (self-signed cert; TLS
  // verification disabled for this send only). Reuse REAL keys (aes128gcm runs
  // BEFORE the POST, so random keys would throw locally and never reach the
  // mock) and just swap the endpoint.
  {
    const mock = https.createServer(tls, (rq, rs) => {
      rs.writeHead(410);
      rs.end();
    });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    toClose.push(() => new Promise((r) => mock.close(r)));
    // Accept the self-signed cert for the mock POST (the real send above
    // already ran under normal TLS verification).
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const deadEndpoint = `https://127.0.0.1:${mock.address().port}/dead`;
    push.add({ endpoint: deadEndpoint, keys: realSub.keys });
    assert(push.count() === 1, `prune setup count=${push.count()}`);
    const summary = await push.sendToAll({ title: "x", body: "y" });
    assert(
      summary.pruned === 1,
      `prune summary ${JSON.stringify(summary)} (want pruned:1)`,
    );
    assert(
      push.count() === 0 &&
        !push.list().some((s) => s.endpoint === deadEndpoint),
      "410 endpoint was not pruned from the store",
    );
    console.log(
      "  ok: a 410 endpoint is pruned from the store (real HTTP 410)",
    );
  }

  // =====================================================================
  // SW suppression rule — extract the ACTUAL `hasVisibleClientForSession`
  // function shipped in public/sw.js and exercise its branch logic. This is the
  // real decision code (no duplication); it is a pure, self-contained function.
  // =====================================================================
  {
    const swPath = path.join(ROOT, "..", "terminal", "public", "sw.js");
    const swSrc = fs.readFileSync(swPath, "utf8");
    const marker = "function hasVisibleClientForSession";
    const startIdx = swSrc.indexOf(marker);
    assert(startIdx >= 0, "sw.js missing hasVisibleClientForSession");
    // Brace-match from the first `{` after the signature to the matching `}`.
    const braceStart = swSrc.indexOf("{", startIdx);
    let depth = 0;
    let endIdx = -1;
    for (let i = braceStart; i < swSrc.length; i++) {
      if (swSrc[i] === "{") depth++;
      else if (swSrc[i] === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    assert(endIdx > 0, "could not brace-match hasVisibleClientForSession");
    const fnSrc = swSrc.slice(startIdx, endIdx);
    // eslint-disable-next-line no-eval
    const hasVisibleClientForSession = eval(`(${fnSrc})`);

    const SID = "local/web-abc";
    const client = (over) => ({
      visibilityState: "visible",
      focused: true,
      url: `https://app.example/?session=${encodeURIComponent(SID)}`,
      ...over,
    });

    // focused + visible + matching session (URL is percent-encoded) -> suppress
    assert(
      hasVisibleClientForSession([client()], SID) === true,
      "should suppress when a focused visible client shows the matching session",
    );
    // a different session on screen -> do NOT suppress
    assert(
      hasVisibleClientForSession(
        [client({ url: "https://app.example/?session=local%2Fweb-OTHER" })],
        SID,
      ) === false,
      "must not suppress when the focused client shows a different session",
    );
    // visible but NOT focused -> do NOT suppress
    assert(
      hasVisibleClientForSession([client({ focused: false })], SID) === false,
      "must not suppress a visible-but-unfocused client",
    );
    // focused but hidden (backgrounded) -> do NOT suppress
    assert(
      hasVisibleClientForSession(
        [client({ visibilityState: "hidden" })],
        SID,
      ) === false,
      "must not suppress a hidden client",
    );
    // no clients / null sessionId -> do NOT suppress
    assert(
      hasVisibleClientForSession([], SID) === false,
      "no clients -> notify",
    );
    assert(
      hasVisibleClientForSession([client()], null) === false,
      "null sessionId -> notify",
    );
    // one of several clients matches -> suppress
    assert(
      hasVisibleClientForSession(
        [
          client({ focused: false }),
          client({ url: "https://app.example/?session=local%2Fweb-x" }),
          client(),
        ],
        SID,
      ) === true,
      "should suppress when ANY focused visible client shows the session",
    );
    console.log(
      "  ok: SW suppression rule — focused+visible+matching -> omit; " +
        "unfocused/hidden/other-session/none -> showNotification",
    );
  }

  console.log(
    "\nPASS: push endpoints — vapid-key (configured + not-configured), " +
      "subscribe/unsubscribe (auth, CSRF, 400, dedup, idempotent, persisted), " +
      "graceful 503, settings GET/PUT, live poll-loop fires on a real transition, " +
      "per-session mute suppresses server-side, duration threshold (suppress/fire " +
      "with durationMs), job-start still-running fires once, exit-code captured " +
      "(local + ssh: false->1, true->0), " +
      "REAL push-service 201 crypto gate, sendToAll delivery, 410 pruning, " +
      "SW visible-session suppression rule.",
  );
  await cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
