// Dead-session persistence test — real local gateway + real tmux.
//
// Covers:
//   1. A metadata-tracked session killed outside the gateway remains listed as
//      reachable:true, alive:false with its display metadata intact.
//   2. DELETE removes a dead session's metadata and returns 204.
//   3. PATCH can rename/move a dead session.
//   4. Recreating the exact tmux name self-heals the row to alive:true without
//      duplication.
//   5. One dead session is not auto-pruned while another remains live, and its
//      record remains present in the metadata sidecar.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "gw-dead-session-data-"),
);
const METADATA_FILE = path.join(DATA_DIR, "sessions.json");
const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;

const createdIds = [];
let server;

function bare(id) {
  const name = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  if (!/^web-[a-zA-Z0-9-]+$/.test(name)) {
    throw new Error(`unsafe tmux session name: ${name}`);
  }
  return name;
}

function killDirect(id) {
  execSync(`tmux kill-session -t ${bare(id)}`, { stdio: "ignore" });
}

function recreateDirect(id) {
  execSync(`tmux new-session -d -s ${bare(id)}`, { stdio: "ignore" });
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        GATEWAY_AUTH_USER: "",
        GATEWAY_AUTH_PASSWORD: "",
        GATEWAY_AUTH_PASSWORD_HASH: "",
        GATEWAY_AUTH_TOKEN: "",
        GATEWAY_DATA_DIR: DATA_DIR,
        SERVERS_FILE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("server did not start in time"));
    }, 8000);
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!settled && output.includes("listening on")) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(`[gw] ${chunk}`));
  });
}

async function request(method, pathname, body) {
  return fetch(`${BASE}${pathname}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(body) {
  const res = await request("POST", "/api/sessions", body);
  if (res.status !== 201) {
    throw new Error(`POST returned ${res.status}, expected 201`);
  }
  const session = await res.json();
  createdIds.push(session.id);
  return session;
}

async function list() {
  const res = await request("GET", "/api/sessions");
  if (res.status !== 200) {
    throw new Error(`GET returned ${res.status}, expected 200`);
  }
  return res.json();
}

function findOne(sessions, id) {
  const matches = sessions.filter((session) => session.id === id);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one row for ${id}, got ${matches.length}`,
    );
  }
  return matches[0];
}

async function remove(id) {
  const res = await request(
    "DELETE",
    `/api/sessions/${encodeURIComponent(id)}`,
  );
  if (res.status !== 204) {
    throw new Error(`DELETE ${id} returned ${res.status}, expected 204`);
  }
}

function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  for (const id of createdIds) {
    try {
      killDirect(id);
    } catch {}
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
}

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT}`);

  // 1. Reachable server + missing tmux session => persistent dead row.
  const first = await create({
    name: "dead-one",
    org: "Acme",
    project: "terminal",
  });
  let row = findOne(await list(), first.id);
  if (row.alive !== true || row.reachable !== true) {
    throw new Error(`new session was not live: ${JSON.stringify(row)}`);
  }
  killDirect(first.id);
  row = findOne(await list(), first.id);
  if (row.alive !== false || row.reachable !== true) {
    throw new Error(
      `killed session was not dead/reachable: ${JSON.stringify(row)}`,
    );
  }
  if (
    row.name !== "dead-one" ||
    row.org !== "Acme" ||
    row.project !== "terminal"
  ) {
    throw new Error(`dead row lost metadata: ${JSON.stringify(row)}`);
  }
  console.log("1. direct tmux kill persists alive:false row with metadata OK");

  // 2. DELETE on a dead row is metadata-only cleanup.
  await remove(first.id);
  if ((await list()).some((session) => session.id === first.id)) {
    throw new Error("dead session remained after DELETE");
  }
  console.log("2. DELETE dead session -> 204 and removes row OK");

  // 3. PATCH remains available because it only edits metadata.
  const patchable = await create({ name: "dead-patch", org: "Before" });
  killDirect(patchable.id);
  const patchRes = await request(
    "PATCH",
    `/api/sessions/${encodeURIComponent(patchable.id)}`,
    { name: "dead-renamed", org: "After", project: "Moved" },
  );
  if (patchRes.status !== 200) {
    throw new Error(
      `PATCH dead session returned ${patchRes.status}, expected 200`,
    );
  }
  const patched = await patchRes.json();
  if (
    patched.name !== "dead-renamed" ||
    patched.org !== "After" ||
    patched.project !== "Moved"
  ) {
    throw new Error(
      `PATCH returned wrong metadata: ${JSON.stringify(patched)}`,
    );
  }
  row = findOne(await list(), patchable.id);
  if (row.alive !== false || row.name !== "dead-renamed") {
    throw new Error(`patched dead row was wrong: ${JSON.stringify(row)}`);
  }
  await remove(patchable.id);
  console.log("3. PATCH rename/move on dead session -> 200 OK");

  // 4. Reappearing exact tmux name flips the same row back to live.
  const healing = await create({ name: "self-healing", org: "Acme" });
  killDirect(healing.id);
  if (findOne(await list(), healing.id).alive !== false) {
    throw new Error("self-healing fixture did not become dead first");
  }
  recreateDirect(healing.id);
  const healedRows = await list();
  row = findOne(healedRows, healing.id);
  if (row.alive !== true || row.reachable !== true) {
    throw new Error(
      `recreated session did not self-heal: ${JSON.stringify(row)}`,
    );
  }
  await remove(healing.id);
  console.log(
    "4. exact tmux-name recreation self-heals without duplication OK",
  );

  // 5. A dead row coexists with a live row and remains in the sidecar.
  const dead = await create({ name: "kept-dead", org: "Persisted" });
  const live = await create({ name: "kept-live", org: "Persisted" });
  killDirect(dead.id);
  const both = await list();
  const deadRow = findOne(both, dead.id);
  const liveRow = findOne(both, live.id);
  if (deadRow.alive !== false || liveRow.alive !== true) {
    throw new Error(
      `expected one dead and one live row: ${JSON.stringify({ deadRow, liveRow })}`,
    );
  }
  const sidecar = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
  if (!sidecar[dead.id]) {
    throw new Error("dead session metadata was auto-pruned from sidecar");
  }
  await remove(dead.id);
  await remove(live.id);
  console.log("5. dead + live coexist and dead metadata is not auto-pruned OK");
  console.log("\nDead-session persistence: all 5 cases passed.");
}

main()
  .catch((error) => {
    console.error(`\nFAIL: ${error.stack || error}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
