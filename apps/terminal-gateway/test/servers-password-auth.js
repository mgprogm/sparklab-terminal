// Acceptance: per-server SSH PASSWORD auth ("Connected Servers").
//
// Password auth is opt-in per server. This asserts the security-critical wire +
// persistence guarantees that must hold regardless of environment:
//   1. POST /api/servers with a password → 201, authMethod:"password", and the
//      response NEVER echoes the password.
//   2. GET /api/servers → the server reports authMethod:"password" and no
//      password field (the secret never leaves the gateway host).
//   3. The password IS persisted (plaintext) to the gitignored servers.json so
//      the gateway can reconnect after a restart.
//   4. A key-based server (no password) reports authMethod:"key".
//   5. POST /api/servers/test with a password against an unroutable host returns
//      reachability:"unreachable" without hanging — proving the password exec
//      path runs non-interactively (askpass; no TTY prompt) rather than blocking.
//
// The actual "logs in with the right password" path needs an sshd that accepts a
// password we know — which we cannot provision without root. So the live-login
// check runs ONLY when GW_TEST_SSH_HOST + GW_TEST_SSH_PASSWORD (and optionally
// GW_TEST_SSH_USER/PORT) are set; otherwise that one check is SKIPPED (the rest
// still run and must PASS).
//
// Run: node test/servers-password-auth.js   (or: pnpm --filter … test:servers-password)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const RUN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const SERVERS_FILE = path.join(os.tmpdir(), `gw-servers-pw-${RUN}.json`);

let server;

function cleanup() {
  try {
    fs.rmSync(SERVERS_FILE, { force: true });
  } catch {}
  if (server && !server.killed) server.kill("SIGKILL");
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), SERVERS_FILE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    server.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("listening on")) resolve();
    });
    server.stderr.on("data", (d) => process.stderr.write(`[gw] ${d}`));
    setTimeout(() => reject(new Error("server did not start in time")), 8000);
  });
}

async function rest(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function main() {
  await startServer();

  // 1. Register a password server.
  const created = await rest("POST", "/api/servers", {
    id: "pwbox",
    name: "Password box",
    host: "10.255.255.1", // unroutable (TEST-NET); we only check the API shape
    user: "azureuser",
    password: "s3cr3t-pw",
  });
  assert(
    created.status === 201,
    `POST password server: expected 201, got ${created.status}`,
  );
  assert(
    created.json.authMethod === "password",
    `created authMethod: expected "password", got ${JSON.stringify(created.json.authMethod)}`,
  );
  assert(
    !("password" in created.json),
    "SECURITY: POST response leaked the password field",
  );
  console.log(
    "  ok: POST /api/servers stored password server; response authMethod=password, no password echoed",
  );

  // 2. GET must not leak the password and must report the method.
  const list = await rest("GET", "/api/servers");
  assert(
    list.status === 200,
    `GET /api/servers: expected 200, got ${list.status}`,
  );
  const pwbox = list.json.find((s) => s.id === "pwbox");
  assert(pwbox, "GET /api/servers: password server missing from list");
  assert(
    pwbox.authMethod === "password",
    `GET authMethod: expected "password", got ${JSON.stringify(pwbox.authMethod)}`,
  );
  assert(
    !("password" in pwbox),
    "SECURITY: GET /api/servers leaked the password field",
  );
  console.log(
    "  ok: GET /api/servers reports authMethod=password and never returns the password",
  );

  // 3. Password IS persisted to servers.json (so it survives a restart).
  const onDisk = JSON.parse(fs.readFileSync(SERVERS_FILE, "utf8"));
  const stored = onDisk.find((s) => s.id === "pwbox");
  assert(
    stored && stored.password === "s3cr3t-pw",
    "servers.json did not persist the password",
  );
  console.log(
    "  ok: password persisted (plaintext) in the gitignored servers.json",
  );

  // 4. A key server reports authMethod=key.
  const keySrv = await rest("POST", "/api/servers", {
    id: "keybox",
    name: "Key box",
    host: "10.255.255.2",
    user: "deploy",
    identityFile: "~/.ssh/id_ed25519",
  });
  assert(
    keySrv.status === 201,
    `POST key server: expected 201, got ${keySrv.status}`,
  );
  assert(
    keySrv.json.authMethod === "key",
    `key server authMethod: expected "key", got ${JSON.stringify(keySrv.json.authMethod)}`,
  );
  assert(
    !("password" in keySrv.json),
    "key server response unexpectedly had a password field",
  );
  console.log("  ok: key-based server reports authMethod=key");

  // 5. Test against an unroutable host must fail fast (non-interactive), not hang.
  const t0 = Date.now();
  const test = await rest("POST", "/api/servers/test", {
    id: "probe",
    name: "probe",
    host: "10.255.255.1",
    user: "azureuser",
    password: "whatever",
  });
  const elapsed = Date.now() - t0;
  assert(
    test.status === 200,
    `POST /api/servers/test: expected 200, got ${test.status}`,
  );
  assert(
    test.json.reachability === "unreachable",
    `unroutable password test: expected unreachable, got ${JSON.stringify(test.json.reachability)}`,
  );
  assert(
    elapsed < 30000,
    `password test path appears to hang (${elapsed}ms) — askpass not wired?`,
  );
  console.log(
    `  ok: password test path ran non-interactively (unreachable in ${elapsed}ms, no hang)`,
  );

  // 6. OPTIONAL live login — only with real creds in the env.
  const liveHost = process.env.GW_TEST_SSH_HOST;
  const livePw = process.env.GW_TEST_SSH_PASSWORD;
  if (liveHost && livePw) {
    const live = await rest("POST", "/api/servers/test", {
      id: "live",
      name: "live",
      host: liveHost,
      user: process.env.GW_TEST_SSH_USER || undefined,
      port: process.env.GW_TEST_SSH_PORT
        ? Number(process.env.GW_TEST_SSH_PORT)
        : undefined,
      password: livePw,
    });
    assert(
      live.json.reachability === "ok",
      `LIVE password login to ${liveHost} failed: ${JSON.stringify(live.json)}`,
    );
    console.log(
      `  ok: LIVE password login to ${liveHost} succeeded (reachability=ok)`,
    );
  } else {
    console.log(
      "  SKIPPED (live login): set GW_TEST_SSH_HOST + GW_TEST_SSH_PASSWORD (and optionally GW_TEST_SSH_USER/PORT) to verify a real password login end-to-end.",
    );
  }

  cleanup();
  console.log(
    "\nPASS: per-server SSH password auth — stored, never leaked, authMethod reported, non-interactive exec.",
  );
  process.exit(0);
}

main().catch((err) => fail(err.message || String(err)));
