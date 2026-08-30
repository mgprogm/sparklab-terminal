/**
 * Raw contract probe for a real CUA desktop image. Boots one container, opens
 * `cua-driver mcp --direct` over `docker exec -i`, and dumps `tools/list` plus a
 * few representative `tools/call` responses so we can pin the TODO(spike) bits:
 * the full-display capture tool name, the get_accessibility_tree shape, and
 * whether the driver emits the ActionResult structuredContent.
 *
 * Run:  node apps/agent-service/test/cua-real/probe.mjs
 * Env:  CUA_IMAGE (default sparklab/cua-desktop:0.22.2)
 *       CUA_DRIVER_USER (default cua)  CUA_KEEP=1 to leave the container up
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const IMAGE = process.env.CUA_IMAGE || "sparklab/cua-desktop:0.22.2";
const USER = process.env.CUA_DRIVER_USER || "cua";
const NAME = `cua-probe-${Date.now().toString(36)}`;

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...opts });
}

const run = docker(["run", "-d", "--rm", "--name", NAME, IMAGE]);
if (run.status !== 0) {
  console.error("docker run failed:", run.stderr || run.stdout);
  process.exit(1);
}
console.log("container:", NAME);

// Wait for the X session BEFORE spawning the driver, so it doesn't come up
// against a display that isn't listening yet.
console.log("waiting for the XFCE/Xvnc session ...");
let xReady = false;
for (let i = 0; i < 45; i++) {
  const h = docker([
    "exec",
    NAME,
    "sh",
    "-lc",
    "curl -fsS http://127.0.0.1:6901/vnc.html >/dev/null && (xdpyinfo -display :1 >/dev/null 2>&1 || true)",
  ]);
  if (h.status === 0) {
    xReady = true;
    break;
  }
  await sleep(2000);
}
console.log("x session ready:", xReady);

let rpcId = 0;
const pending = new Map();
let buf = "";

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
    NAME,
    "cua-driver",
    "mcp",
    "--direct",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
child.stderr.on("data", (d) => process.stderr.write(`[driver stderr] ${d}`));
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
      console.log("[non-json]", line);
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
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function show(label, obj) {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(obj, null, 2).slice(0, 6000));
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cua-probe", version: "0" },
  });
  show("initialize", init.result ?? init);
  notify("notifications/initialized", {});

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  show("tools/list — names", names);
  show("tools/list — full", list.result);

  for (const name of [
    "get_desktop_state",
    "screenshot",
    "get_screen_size",
    "get_accessibility_tree",
    "list_windows",
    "list_apps",
  ]) {
    if (!names.includes(name)) {
      console.log(`\n(skip ${name}: not in tools/list)`);
      continue;
    }
    try {
      const r = await rpc("tools/call", {
        name,
        arguments:
          name === "get_desktop_state" || name === "screenshot"
            ? { include_screenshot: true }
            : {},
      });
      const trimmed = JSON.parse(JSON.stringify(r.result));
      for (const c of trimmed?.content ?? []) {
        if (c.type === "image" && typeof c.data === "string")
          c.data = `<${c.data.length} b64 chars>`;
      }
      show(`tools/call ${name}`, trimmed);
    } catch (e) {
      console.log(`tools/call ${name} -> ${e.message}`);
    }
  }
} catch (e) {
  console.error("PROBE ERROR:", e);
} finally {
  child.stdin.end();
  await sleep(500);
  if (!process.env.CUA_KEEP) docker(["rm", "-f", NAME]);
  else
    console.log(
      `\n(container ${NAME} left running; docker rm -f ${NAME} to clean up)`,
    );
  process.exit(0);
}
