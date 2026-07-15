// Phase 2 acceptance test — proves multi-session isolation, that jobs survive
// tab switching, and that DELETE is the ONLY surgical kill (detach everywhere
// else). Protocol/REST level, no browser.
//
// Flow:
//   1. POST two sessions A and B via REST.
//   2. Attach WS to A, start an AAA counter loop; attach WS to B, start a BBB
//      counter loop. Confirm A's stream shows only AAA and B's only BBB.
//   3. Simulate a tab switch: disconnect from A, watch B, reconnect to A —
//      confirm both sessions stay alive throughout AND A's counter advanced
//      while we were away (the job kept running unwatched).
//   4. DELETE A via REST. Confirm has-session A now FAILS but B still succeeds
//      and B's counter is still advancing.
//   5. DELETE B. Confirm no orphan web- sessions from this test remain.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}/attach?session=`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Multi-server: REST/WS ids are now QUALIFIED (`<serverId>/web-<uuid>`). The
// bare tmux name (last "/" segment) is what a direct `tmux` CLI call needs.
const bare = (id) => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);

function tmuxHasSession(id) {
  try {
    execFileSync("tmux", ["has-session", "-t", bare(id)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

// Extract the highest "<label> N" counter seen in a decoded chunk.
function maxCounter(text, label) {
  let max = null;
  const re = new RegExp(`${label} (\\d+)`, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (max === null || n > max) max = n;
  }
  return max;
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
  // TEST harness (consistent with the Phase 1 tests) — it is NOT in the gateway.
  for (const id of createdIds) {
    try {
      execFileSync("tmux", ["kill-session", "-t", bare(id)], {
        stdio: "ignore",
      });
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

// Open a WS, accumulate decoded output into an object with .buf. Caller owns
// closing it.
function openWs(id) {
  const ws = new WebSocket(`${WS_BASE}${encodeURIComponent(id)}`);
  ws.binaryType = "arraybuffer";
  const state = { ws, buf: "" };
  ws.on("message", (data, isBinary) => {
    if (isBinary) state.buf += Buffer.from(data).toString("utf8");
    else {
      try {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "error") state.error = msg.message;
      } catch {}
    }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(state));
    ws.on("error", reject);
    setTimeout(() => reject(new Error(`ws to ${id} did not open`)), 5000);
  });
}

function closeWs(state) {
  return new Promise((resolve) => {
    if (!state || !state.ws) return resolve();
    state.ws.on("close", resolve);
    try {
      state.ws.close();
    } catch {
      resolve();
    }
    setTimeout(resolve, 1500);
  });
}

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT}`);

  // --- 1. Create A and B via REST ---
  const resA = await rest("POST", "/api/sessions", { name: "job-A" });
  const resB = await rest("POST", "/api/sessions", { name: "job-B" });
  if (resA.status !== 201 || resB.status !== 201) {
    fail(
      `POST /api/sessions returned ${resA.status} / ${resB.status}, expected 201`,
    );
  }
  const A = (await resA.json()).id;
  const B = (await resB.json()).id;
  createdIds.push(A, B);
  console.log(`created A=${A}  B=${B}`);
  if (!tmuxHasSession(A) || !tmuxHasSession(B))
    fail("created sessions not present in tmux");

  // --- 2. Attach + start distinct jobs, then check isolation ---
  const wsA = await openWs(A);
  const wsB = await openWs(B);
  await sleep(600);
  wsA.ws.send(
    Buffer.from("while true; do echo AAA $((i=i+1)); sleep 1; done\n"),
    { binary: true },
  );
  wsB.ws.send(
    Buffer.from("while true; do echo BBB $((j=j+1)); sleep 1; done\n"),
    { binary: true },
  );

  // Wait for both streams to produce counters.
  let aTick = null;
  let bTick = null;
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    aTick = maxCounter(wsA.buf, "AAA");
    bTick = maxCounter(wsB.buf, "BBB");
    if (aTick >= 3 && bTick >= 3) break;
  }
  if (!(aTick >= 3)) fail("never saw AAA counter stream on session A");
  if (!(bTick >= 3)) fail("never saw BBB counter stream on session B");

  // Isolation: A's stream must contain no BBB, B's no AAA.
  if (wsA.buf.includes("BBB"))
    fail("session A's stream leaked BBB output (no isolation)");
  if (wsB.buf.includes("AAA"))
    fail("session B's stream leaked AAA output (no isolation)");
  console.log(
    `isolation OK: A sees only AAA (last=${aTick}), B sees only BBB (last=${bTick})`,
  );

  // --- 3. Tab switch: disconnect A, watch B, reconnect A ---
  const aBefore = maxCounter(wsA.buf, "AAA");
  await closeWs(wsA);
  console.log(`disconnected from A at AAA=${aBefore}; now "viewing" B only`);
  // Both must remain alive while A is unwatched.
  await sleep(4000);
  if (!tmuxHasSession(A))
    fail(
      "session A died after we disconnected from it (job did NOT survive tab switch)",
    );
  if (!tmuxHasSession(B)) fail("session B died while active");
  const bMid = maxCounter(wsB.buf, "BBB");
  console.log(
    `during switch: A alive=${tmuxHasSession(A)}, B alive=${tmuxHasSession(B)}, B counting (BBB=${bMid})`,
  );

  // Reconnect to A (fresh WS = "switch back").
  const wsA2 = await openWs(A);
  await sleep(2500);
  const aAfter = maxCounter(wsA2.buf, "AAA");
  if (aAfter === null) fail("reconnect to A: saw no AAA in redraw/live stream");
  if (!(aAfter > aBefore)) {
    fail(
      `A's counter did not advance while we were away (before=${aBefore}, after=${aAfter}) — job stalled on detach`,
    );
  }
  console.log(
    `switched back to A: counter advanced ${aBefore} -> ${aAfter} while unwatched (job kept running)`,
  );

  // --- 4. DELETE A (the ONE surgical kill). B must be untouched. ---
  const bBeforeDelete = maxCounter(wsB.buf, "BBB");
  const delRes = await rest("DELETE", `/api/sessions/${encodeURIComponent(A)}`);
  if (delRes.status !== 204)
    fail(`DELETE A returned ${delRes.status}, expected 204`);
  await closeWs(wsA2);
  await sleep(500);
  if (tmuxHasSession(A)) fail("DELETE did not kill session A");
  if (!tmuxHasSession(B))
    fail("DELETE A also killed B — delete was NOT surgical!");
  // B's job must still be counting.
  await sleep(3000);
  const bAfterDelete = maxCounter(wsB.buf, "BBB");
  if (!(bAfterDelete > bBeforeDelete)) {
    fail(
      `B's job stopped counting after A was deleted (${bBeforeDelete} -> ${bAfterDelete})`,
    );
  }
  console.log(
    `DELETE A surgical: has-session A=${tmuxHasSession(A)} (killed), B=${tmuxHasSession(B)} (alive), B still counting ${bBeforeDelete} -> ${bAfterDelete}`,
  );

  // --- 5. Clean up B, verify no orphans ---
  await closeWs(wsB);
  const delResB = await rest(
    "DELETE",
    `/api/sessions/${encodeURIComponent(B)}`,
  );
  if (delResB.status !== 204)
    fail(`DELETE B returned ${delResB.status}, expected 204`);
  await sleep(300);
  const orphans = listWebSessions().filter((s) =>
    createdIds.map(bare).includes(s),
  );
  if (orphans.length)
    fail(`orphan web- sessions from this test remain: ${orphans.join(", ")}`);
  console.log(
    `cleanup OK: no orphan web- sessions remain (${A}, ${B} both gone)`,
  );

  console.log(
    "\nPASS: multi-session isolation, jobs survive tab switching, DELETE is the only surgical kill.",
  );
  console.log(
    `  isolation: A=AAA-only(last ${aTick}), B=BBB-only(last ${bTick})`,
  );
  console.log(
    `  survived switch: A advanced ${aBefore} -> ${aAfter} while unwatched`,
  );
  console.log(
    `  surgical delete: A killed, B survived and kept counting ${bBeforeDelete} -> ${bAfterDelete}`,
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
