// Agent Chat Phase 1 test — proves the two agent REST endpoints:
//   GET  /api/sessions/:id/screen?history=N  (plain-text capture + metadata)
//   POST /api/sessions/:id/keys              ({text} literal / {keys} whitelist)
// REST level, no browser, real gateway + real tmux.
//
// Flow:
//   1. POST a session via REST.
//   2. POST /keys {text:"echo hello-agent"} — must NOT execute: /screen shows
//      the literal typed text, no output line, and currentCommand is a shell.
//   3. POST /keys {keys:["Enter"]} — poll /screen until the "hello-agent"
//      output line appears (now it executed).
//   4. Whitelist: {keys:["kill-session"]} -> 400; malformed bodies -> 400.
//   5. Unknown session -> 404 on both endpoints.
//   6. history param: scroll "hello-agent" off-screen with seq, confirm
//      /screen (history=0) lost it and /screen?history=500 still has it.
//   7. DELETE the session. Confirm no orphan web- sessions remain.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3996;
const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh"]);

function listWebSessions() {
  try {
    const out = execFileSync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("web-"));
  } catch {
    return [];
  }
}

let server;
const createdIds = [];

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
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

function cleanup() {
  // Safety-net cleanup for interrupted runs. This raw kill-session lives in the
  // TEST harness (consistent with the other tests) — it is NOT in the gateway.
  for (const id of createdIds) {
    try {
      execFileSync("tmux", ["kill-session", "-t", id], { stdio: "ignore" });
    } catch {}
  }
  if (server && !server.killed) server.kill("SIGTERM");
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

async function rest(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function getScreen(id, history) {
  const q = history !== undefined ? `?history=${history}` : "";
  const res = await rest("GET", `/api/sessions/${id}/screen${q}`);
  if (res.status !== 200)
    fail(`GET /screen returned ${res.status}, expected 200`);
  return res.json();
}

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT}`);

  // --- 1. Create a session via REST ---
  const resCreate = await rest("POST", "/api/sessions", {
    name: "agent-endpoints-test",
  });
  if (resCreate.status !== 201)
    fail(`POST /api/sessions returned ${resCreate.status}, expected 201`);
  const id = (await resCreate.json()).id;
  createdIds.push(id);
  console.log(`created ${id}`);
  await sleep(600); // let the shell finish printing its prompt

  // --- 2. POST /keys {text} must type literally and NOT execute ---
  const resText = await rest("POST", `/api/sessions/${id}/keys`, {
    text: "echo hello-agent",
  });
  if (resText.status !== 204)
    fail(`POST /keys {text} returned ${resText.status}, expected 204`);
  await sleep(400);
  let scr = await getScreen(id);
  if (typeof scr.screen !== "string")
    fail('/screen response missing string "screen"');
  if (!Number.isInteger(scr.cursor?.x) || !Number.isInteger(scr.cursor?.y))
    fail("/screen response missing integer cursor.x/y");
  if (!Number.isInteger(scr.size?.cols) || !Number.isInteger(scr.size?.rows))
    fail("/screen response missing integer size.cols/rows");
  if (typeof scr.altScreen !== "boolean")
    fail("/screen response missing boolean altScreen");
  if (typeof scr.currentCommand !== "string")
    fail("/screen response missing string currentCommand");
  if (scr.screen.includes("\x1b["))
    fail("/screen contains ANSI escapes (must be plain text)");
  if (!scr.screen.includes("echo hello-agent"))
    fail('typed text "echo hello-agent" not visible on screen');
  // Not executed: no line is the bare command OUTPUT (a line that is exactly
  // "hello-agent" would only exist if echo ran).
  const outputLine = (s) =>
    s.split("\n").some((l) => l.trim() === "hello-agent");
  if (outputLine(scr.screen))
    fail("text was EXECUTED (output line present) — {text} must never execute");
  if (!SHELLS.has(scr.currentCommand))
    fail(
      `currentCommand "${scr.currentCommand}" is not a shell — did the text execute something?`,
    );
  console.log(
    `text typed literally, not executed (currentCommand=${scr.currentCommand}, cursor=${scr.cursor.x},${scr.cursor.y}, size=${scr.size.cols}x${scr.size.rows}, altScreen=${scr.altScreen})`,
  );

  // --- 3. POST /keys {keys:["Enter"]} executes the pending command ---
  const resEnter = await rest("POST", `/api/sessions/${id}/keys`, {
    keys: ["Enter"],
  });
  if (resEnter.status !== 204)
    fail(
      `POST /keys {keys:["Enter"]} returned ${resEnter.status}, expected 204`,
    );
  let executed = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    scr = await getScreen(id);
    if (outputLine(scr.screen)) {
      executed = true;
      break;
    }
  }
  if (!executed)
    fail('after Enter, "hello-agent" output never appeared on screen');
  console.log("Enter executed the pending command; output visible via /screen");

  // --- 4. Validation: whitelist + malformed bodies ---
  const resBadKey = await rest("POST", `/api/sessions/${id}/keys`, {
    keys: ["kill-session"],
  });
  if (resBadKey.status !== 400)
    fail(`{keys:["kill-session"]} returned ${resBadKey.status}, expected 400`);
  const resBoth = await rest("POST", `/api/sessions/${id}/keys`, {
    text: "x",
    keys: ["Enter"],
  });
  if (resBoth.status !== 400)
    fail(`{text+keys} returned ${resBoth.status}, expected 400`);
  const resNeither = await rest("POST", `/api/sessions/${id}/keys`, {});
  if (resNeither.status !== 400)
    fail(`{} returned ${resNeither.status}, expected 400`);
  const resEmptyText = await rest("POST", `/api/sessions/${id}/keys`, {
    text: "",
  });
  if (resEmptyText.status !== 400)
    fail(`{text:""} returned ${resEmptyText.status}, expected 400`);
  const resEmptyKeys = await rest("POST", `/api/sessions/${id}/keys`, {
    keys: [],
  });
  if (resEmptyKeys.status !== 400)
    fail(`{keys:[]} returned ${resEmptyKeys.status}, expected 400`);
  console.log(
    "validation OK: non-whitelisted key, text+keys, {}, empty text, empty keys all rejected with 400",
  );

  // --- 5. Unknown session -> 404 on both endpoints ---
  const ghost = "web-00000000-0000-0000-0000-000000000000";
  const res404screen = await rest("GET", `/api/sessions/${ghost}/screen`);
  if (res404screen.status !== 404)
    fail(
      `GET /screen for unknown session returned ${res404screen.status}, expected 404`,
    );
  const res404keys = await rest("POST", `/api/sessions/${ghost}/keys`, {
    keys: ["Enter"],
  });
  if (res404keys.status !== 404)
    fail(
      `POST /keys for unknown session returned ${res404keys.status}, expected 404`,
    );
  console.log("unknown session returns 404 on both endpoints");

  // --- 6. history param: scrolled-off content comes back with history>0 ---
  // Scroll hello-agent off the visible screen (pane is 24 rows).
  await rest("POST", `/api/sessions/${id}/keys`, { text: "seq 1 100" });
  await rest("POST", `/api/sessions/${id}/keys`, { keys: ["Enter"] });
  let scrolled = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    scr = await getScreen(id); // default history=0: visible screen only
    if (!scr.screen.includes("hello-agent") && scr.screen.includes("100")) {
      scrolled = true;
      break;
    }
  }
  if (!scrolled)
    fail(
      '"hello-agent" never scrolled off the visible screen (history test setup failed)',
    );
  const withHistory = await getScreen(id, 500);
  if (!withHistory.screen.includes("hello-agent"))
    fail('history=500 did not bring scrolled-off "hello-agent" back');
  if (withHistory.screen.length <= scr.screen.length)
    fail("history=500 capture is not larger than the visible-only capture");
  console.log(
    `history param OK: visible-only lost "hello-agent", history=500 recovered it (${scr.screen.length} -> ${withHistory.screen.length} chars)`,
  );

  // --- 7. Clean up, verify no orphans ---
  const resDel = await rest("DELETE", `/api/sessions/${id}`);
  if (resDel.status !== 204)
    fail(`DELETE returned ${resDel.status}, expected 204`);
  await sleep(300);
  const orphans = listWebSessions().filter((s) => createdIds.includes(s));
  if (orphans.length)
    fail(`orphan web- sessions from this test remain: ${orphans.join(", ")}`);
  console.log("cleanup OK: no orphan web- sessions remain");

  console.log(
    "\nPASS: agent endpoints — /screen captures plain text + metadata (history works), /keys types literally, Enter executes, whitelist enforced, 404s correct.",
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
