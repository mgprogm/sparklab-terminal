/**
 * Reproduces + confirms the "this session has ended; call start_session
 * explicitly to reuse its label" bug found during live Agent Chat E2E testing
 * (2026-08-31): cua-driver runs its own background idle-session sweep
 * (spawn_lifecycle_maintenance in cua-driver-sdk/src/runtime.rs), independent
 * of container health, that ends ANY driver session (including the implicit
 * one agent-service always uses, since it never calls start_session) once it
 * has been idle past CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS (driver default:
 * 300s, swept every 30s). A slow chat (human approval, model think time)
 * easily exceeds that, so a click can fail closed with no recovery path.
 *
 * This probe sets the env var to a short value (5s) so the sweep (30s tick)
 * reliably fires within a short sleep, then confirms:
 *   (a) an initial get_desktop_state succeeds (touches the implicit session)
 *   (b) after sleeping past one 30s sweep tick, a click FAILS with exactly
 *       the "session has ended" text — proving the mechanism
 *   (c) with the env var set to a LONG value instead (the fix wired into
 *       config.ts/computer-runtime.ts), the same click SUCCEEDS after the
 *       same sleep — proving the fix works.
 *
 * Run: node apps/agent-service/test/cua-real/probe-session-ttl.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const IMAGE = process.env.CUA_IMAGE || "sparklab/cua-desktop:0.22.2";
const USER = process.env.CUA_DRIVER_USER || "cua";

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...opts });
}

async function withContainer(fn) {
  const name = `cua-ttl-probe-${Date.now().toString(36)}`;
  const run = docker(["run", "-d", "--rm", "--name", name, IMAGE]);
  if (run.status !== 0) {
    throw new Error(`docker run failed: ${run.stderr || run.stdout}`);
  }
  try {
    console.log("container:", name);
    let xReady = false;
    for (let i = 0; i < 45; i++) {
      const h = docker([
        "exec",
        name,
        "sh",
        "-lc",
        "curl -fsS http://127.0.0.1:6901/vnc.html >/dev/null",
      ]);
      if (h.status === 0) {
        xReady = true;
        break;
      }
      await sleep(2000);
    }
    if (!xReady) throw new Error("X session never came up");
    return await fn(name);
  } finally {
    docker(["rm", "-f", name]);
  }
}

function driverClient(name, ttlSecs) {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-u",
      USER,
      "-e",
      "HOME=/home/cua",
      "-e",
      "DISPLAY=:1",
      ...(ttlSecs != null
        ? ["-e", `CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS=${ttlSecs}`]
        : []),
      name,
      "cua-driver",
      "mcp",
      "--direct",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let rpcId = 0;
  const pending = new Map();
  let buf = "";
  child.stderr.on("data", () => undefined);
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  function rpc(method, params, timeoutMs = 20_000) {
    const id = ++rpcId;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        timeoutMs,
      );
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
  function notify(method, params) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }
  return {
    async init() {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cua-ttl-probe", version: "0" },
      });
      notify("notifications/initialized", {});
    },
    rpc,
    close() {
      child.stdin.end();
    },
  };
}

async function scenario(label, ttlSecs, sleepMs) {
  console.log(`\n===== ${label} (ttl=${ttlSecs}s, sleep=${sleepMs}ms) =====`);
  await withContainer(async (name) => {
    const c = driverClient(name, ttlSecs);
    await c.init();
    const observe = await c.rpc("tools/call", {
      name: "get_desktop_state",
      arguments: { screenshot_out_file: "/tmp/probe-ttl-shot.png" },
    });
    console.log(
      "initial get_desktop_state isError:",
      observe.result?.isError ?? "(no result)",
    );
    console.log(`sleeping ${sleepMs}ms ...`);
    await sleep(sleepMs);
    const click = await c.rpc("tools/call", {
      name: "click",
      arguments: { x: 5, y: 5 },
    });
    const text = JSON.stringify(click.result ?? click).slice(0, 300);
    console.log("click result:", text);
    const sessionEnded = /session has ended/.test(text);
    console.log(
      sessionEnded
        ? "  -> 'session has ended' reproduced"
        : "  -> click succeeded / different error (no session-ended text)",
    );
    c.close();
    return sessionEnded;
  });
}

try {
  // (a) short TTL + a sleep spanning one 30s sweep tick: reproduce the bug.
  await scenario("BUG REPRO: short driver-side session TTL", 5, 35_000);
  // (b) the fix: a long TTL (matches config.ts's new default) survives the
  // same sleep with no error.
  await scenario(
    "FIX CONFIRMATION: long driver-side session TTL",
    28_800,
    35_000,
  );
} catch (e) {
  console.error("PROBE ERROR:", e);
  process.exit(1);
}
