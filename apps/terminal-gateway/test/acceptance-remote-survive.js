// Multi-server acceptance — proves the pitch across the SSH exec seam:
//   "A job on a REMOTE server keeps counting while the gateway is restarted."
//
// We do this WITHOUT a second machine by standing up a SECOND tmux server on a
// dedicated socket (`tmux -L <sock>`) and reaching it over `ssh localhost`,
// registered as an ssh-type server in the registry. This exercises the real
// ssh code path (serverExecArgv => `ssh … tmux -L <sock> …`) for create,
// has-session, attach, and the reachability probe.
//
// Flow:
//   1. Set up passwordless ssh to localhost with an EPHEMERAL key (added to
//      ~/.ssh/authorized_keys, removed on cleanup).                [prereq]
//   2. Start a remote tmux server on socket <sock>; write a servers.json
//      registering server "remote" (host localhost, that key, tmuxCommand
//      `tmux -L <sock>`). Point the gateway at it via SERVERS_FILE.
//   3. Start the gateway; POST /api/sessions {serverId:"remote"} => the session
//      is created on the remote tmux over ssh. Attach, start a tick loop.
//   4. Confirm ticks stream; record the last tick; KILL the gateway process.
//   5. Wait a gap with NO gateway. The remote tmux (a separate process) must
//      keep the job counting. RESTART the gateway.
//   6. Reattach over ssh; confirm the tick jumped by ~=the gap AND keeps
//      arriving live.
//
// PREREQUISITE: an sshd on localhost that accepts publickey auth for the
// current user, and a writable ~/.ssh/authorized_keys. If ssh to localhost
// cannot be established the test prints "SKIPPED" (exit 0) with the reason —
// it never silently passes.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const SERVER_ID = "remote";
const GAP_MS = 9000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unique per-run identifiers so parallel/interrupted runs never collide and
// cleanup can target exactly what this run created.
const RUN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const SOCK = `gw-remote-${RUN}`; // tmux -L socket name for the "remote" server
const KEY_MARKER = `gw-accept-remote-${RUN}`;
const KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gw-remote-key-"));
const KEY_FILE = path.join(KEY_DIR, "id");
const SERVERS_FILE = path.join(os.tmpdir(), `gw-servers-${RUN}.json`);
const AUTHORIZED_KEYS = path.join(os.homedir(), ".ssh", "authorized_keys");

const USER = os.userInfo().username;

let server;
let sessionId = null; // qualified id remote/web-…
let authKeyAppended = false;

// ---- cleanup / skip / fail --------------------------------------------------
function killRemoteTmux() {
  try {
    execFileSync("tmux", ["-L", SOCK, "kill-server"], { stdio: "ignore" });
  } catch {}
}

function removeAuthorizedKey() {
  if (!authKeyAppended) return;
  try {
    const lines = fs.readFileSync(AUTHORIZED_KEYS, "utf8").split("\n");
    const kept = lines.filter((l) => !l.includes(KEY_MARKER));
    fs.writeFileSync(AUTHORIZED_KEYS, kept.join("\n"), { mode: 0o600 });
  } catch {}
}

function cleanup() {
  killRemoteTmux();
  removeAuthorizedKey();
  try {
    fs.rmSync(SERVERS_FILE, { force: true });
  } catch {}
  try {
    fs.rmSync(KEY_DIR, { recursive: true, force: true });
  } catch {}
  if (server && !server.killed) server.kill("SIGKILL");
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function skip(msg) {
  console.log(`\nSKIPPED: ${msg}`);
  console.log(
    "  (prerequisite: sshd on localhost accepting publickey auth for the current user)",
  );
  cleanup();
  process.exit(0);
}

// ---- ssh prerequisite setup -------------------------------------------------
// Returns the ssh option array used by BOTH this harness and (equivalently) the
// gateway, so a probe here proves the gateway's probe will also work.
function sshOpts() {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    "-i",
    KEY_FILE,
    "-o",
    "IdentitiesOnly=yes",
  ];
}

function setupSsh() {
  // Generate an ephemeral keypair.
  try {
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", KEY_MARKER, "-f", KEY_FILE],
      { stdio: "ignore" },
    );
  } catch (err) {
    skip(`ssh-keygen unavailable: ${err.message}`);
  }
  // Ensure ~/.ssh exists, then append our pubkey to authorized_keys.
  try {
    fs.mkdirSync(path.dirname(AUTHORIZED_KEYS), {
      recursive: true,
      mode: 0o700,
    });
    const pub = fs.readFileSync(`${KEY_FILE}.pub`, "utf8").trim();
    fs.appendFileSync(AUTHORIZED_KEYS, `\n${pub}\n`, { mode: 0o600 });
    authKeyAppended = true;
  } catch (err) {
    skip(`could not write ~/.ssh/authorized_keys: ${err.message}`);
  }
  // Verify passwordless ssh actually works now.
  try {
    execFileSync("ssh", [...sshOpts(), `${USER}@localhost`, "true"], {
      stdio: "ignore",
      timeout: 12000,
    });
  } catch (err) {
    skip(`ssh ${USER}@localhost failed with the ephemeral key: ${err.message}`);
  }
}

// ---- gateway lifecycle ------------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), SERVERS_FILE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("listening on")) resolve();
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", (d) => process.stderr.write(`[gw] ${d}`));
    setTimeout(() => reject(new Error("server did not start in time")), 8000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.killed) return resolve();
    server.once("exit", () => resolve());
    server.kill("SIGKILL");
  });
}

function maxTick(text) {
  let max = null;
  const re = /TICK (\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (max === null || n > max) max = n;
  }
  return max;
}

function remoteHasSession(name) {
  try {
    execFileSync("tmux", ["-L", SOCK, "has-session", "-t", name], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  setupSsh();
  console.log(`ssh ${USER}@localhost OK (ephemeral key)`);

  // Stand up the remote tmux server (separate socket) and register it.
  execFileSync("tmux", ["-L", SOCK, "new-session", "-d", "-s", "__seed"], {
    stdio: "ignore",
  });
  execFileSync("tmux", ["-L", SOCK, "kill-session", "-t", "__seed"], {
    stdio: "ignore",
  });
  fs.writeFileSync(
    SERVERS_FILE,
    JSON.stringify(
      [
        {
          id: SERVER_ID,
          name: "Localhost-over-SSH (test)",
          type: "ssh",
          host: "localhost",
          user: USER,
          identityFile: KEY_FILE,
          // File-only override: point the remote at our dedicated socket so it
          // is a genuinely separate tmux server from the gateway's local one.
          tmuxCommand: ["tmux", "-L", SOCK],
        },
      ],
      null,
      2,
    ),
  );

  await startServer();
  console.log(`gateway up on :${PORT} (SERVERS_FILE=${SERVERS_FILE})`);

  // GET /api/servers should report the remote as reachable ("ok").
  const serversRes = await fetch(`${BASE}/api/servers`);
  const servers = await serversRes.json();
  const remote = servers.find((s) => s.id === SERVER_ID);
  if (!remote)
    fail("GET /api/servers did not list the registered remote server");
  if (remote.reachability !== "ok") {
    fail(`remote reachability="${remote.reachability}", expected "ok"`);
  }
  console.log(`GET /api/servers: remote reachability=${remote.reachability}`);

  // Create the session ON THE REMOTE via REST (ssh new-session under the hood).
  const createRes = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "remote-job", serverId: SERVER_ID }),
  });
  if (createRes.status !== 201) {
    fail(`POST /api/sessions returned ${createRes.status}, expected 201`);
  }
  const created = await createRes.json();
  sessionId = created.id;
  if (created.serverId !== SERVER_ID) {
    fail(`created.serverId="${created.serverId}", expected "${SERVER_ID}"`);
  }
  if (!sessionId.startsWith(`${SERVER_ID}/`)) {
    fail(`created id "${sessionId}" is not qualified with "${SERVER_ID}/"`);
  }
  const tmuxName = sessionId.slice(sessionId.indexOf("/") + 1);
  console.log(`created ${sessionId} on the remote via REST`);

  // Independent proof the session really lives on the SEPARATE tmux server.
  if (!remoteHasSession(tmuxName)) {
    fail(`session ${tmuxName} not found on remote tmux -L ${SOCK}`);
  }
  console.log(`confirmed: session present on remote tmux -L ${SOCK}`);

  // Exercise `tmux list-sessions -F <format>` OVER SSH — the format string has
  // spaces/tabs, so this fails unless remote args are shell-quoted. GET
  // /api/sessions must surface the remote session (reachable, qualified id).
  const listRes = await fetch(`${BASE}/api/sessions`);
  if (listRes.status !== 200) {
    fail(`GET /api/sessions returned ${listRes.status}, expected 200`);
  }
  const sessions = await listRes.json();
  const listed = sessions.find((s) => s.id === sessionId);
  if (!listed) {
    fail(
      `GET /api/sessions did not include remote ${sessionId} — remote list-sessions -F likely broke (arg quoting?)`,
    );
  }
  if (listed.reachable === false) {
    fail(
      `remote session listed reachable:false right after a successful create`,
    );
  }
  console.log(
    `GET /api/sessions lists ${sessionId} over ssh (remote -F format survived quoting)`,
  );

  const wsUrl = `ws://localhost:${PORT}/attach?session=${encodeURIComponent(sessionId)}`;

  // --- Connection #1: start the job, watch ticks ---
  const ws1 = new WebSocket(wsUrl);
  ws1.binaryType = "arraybuffer";
  let buf1 = "";
  await new Promise((resolve, reject) => {
    ws1.on("open", resolve);
    ws1.on("error", reject);
  });
  ws1.on("message", (data, isBinary) => {
    if (isBinary) buf1 += Buffer.from(data).toString("utf8");
  });
  await sleep(900);
  ws1.send(
    Buffer.from("for i in $(seq 1 600); do echo TICK $i; sleep 1; done\n"),
    { binary: true },
  );

  let before = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const t = maxTick(buf1);
    if (t !== null && t >= 3) {
      before = t;
      break;
    }
  }
  if (before === null)
    fail("never saw ticks stream on the remote (connection #1)");
  console.log(`connection #1: ticks streaming on remote, last tick=${before}`);

  // --- Kill the GATEWAY (not the remote tmux). ---
  ws1.close();
  await sleep(300);
  const tKill = Date.now();
  await stopServer();
  console.log("gateway KILLED; remote tmux (separate process) keeps the job");

  // --- Gap with NO gateway: the remote must keep counting. ---
  await sleep(GAP_MS);
  if (!remoteHasSession(tmuxName)) {
    fail(
      "remote session died while the gateway was down (job did NOT survive)",
    );
  }
  console.log(`mid-gap: remote tmux -L ${SOCK} still has the session`);

  // --- Restart the gateway; reattach over ssh. ---
  await startServer();
  console.log("gateway RESTARTED");

  const ws2 = new WebSocket(wsUrl);
  ws2.binaryType = "arraybuffer";
  let buf2 = "";
  await new Promise((resolve, reject) => {
    ws2.on("open", resolve);
    ws2.on("error", reject);
  });
  ws2.on("message", (data, isBinary) => {
    if (isBinary) buf2 += Buffer.from(data).toString("utf8");
  });

  await sleep(2500);
  const afterFirst = maxTick(buf2);
  const tAfter = Date.now();
  if (afterFirst === null) fail("reconnect: no ticks in redraw/live stream");

  await sleep(3000);
  const afterSecond = maxTick(buf2);
  ws2.close();

  const elapsedSec = Math.round((tAfter - tKill) / 1000);
  const delta = afterFirst - before;
  console.log(
    `\nbefore=${before}  after=${afterFirst}  delta=${delta}  (gateway-down gap ~${elapsedSec}s)`,
  );

  // (a) the count advanced by roughly the gap — it kept running while the
  //     gateway was DOWN, not just replayed a stale buffer.
  if (delta < 5) {
    fail(
      `tick advanced only ${delta}; expected ~${elapsedSec} (job did not keep running across the gateway restart)`,
    );
  }
  // (b) ticks still arrive live after the restart+reattach.
  if (!(afterSecond > afterFirst)) {
    fail(
      `ticks not advancing live after restart (${afterFirst} -> ${afterSecond})`,
    );
  }

  console.log(
    "\nPASS: remote job survived a full gateway restart and resumed live over ssh.",
  );
  console.log(
    `  before=${before} -> after=${afterFirst} (+${delta} while gateway down ~${elapsedSec}s) -> live=${afterSecond}`,
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
