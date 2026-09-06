// End-to-end test: drives tools/taskmaster-hub-mcp/server.mjs (as a real
// child process) against a real scratch gateway, proving the onboarding +
// claim/update/release flow AND per-worker ownerChannel isolation (Phase C)
// works through the MCP -> gateway REST path, not just a mock.
//
// The gateway runs auth-enabled with a stub `task-master` binary and fully
// scratched data files (never the repo's real data/). Asserts with `throw`,
// prints PASS/FAIL, cleans up its scratch dir + child processes.
//
// Run: node test/taskmaster-hub-mcp.mjs
//   (or `pnpm --filter @sparklab/terminal-gateway test:taskmaster-hub-mcp`;
//    per the gateway-test-auth-env-leak note, prefix with
//    `env -u GATEWAY_AUTH_USER -u GATEWAY_AUTH_PASSWORD -u GATEWAY_AUTH_PASSWORD_HASH`
//    if those are exported in your shell.)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GW_DIR = path.join(__dirname, "..");
const MCP = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "tools",
  "taskmaster-hub-mcp",
  "server.mjs",
);
const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = "mcpe2e";
const PASS_WORD = "mcpe2e-secret";
const TOKEN = "mcp-e2e-bearer-tok";

let gw;
let sessions = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "taskmaster-hub-mcp-"));

function cleanup() {
  for (const s of sessions) {
    try {
      s.kill();
    } catch {}
  }
  if (gw && !gw.killed) gw.kill("SIGTERM");
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {}
}
function assert(cond, msg) {
  if (!cond) {
    console.error(`\nFAIL: ${msg}`);
    cleanup();
    process.exit(1);
  }
}
const ok = (msg) => console.log(`  ok: ${msg}`);

// --- scratch project + stub binary ---------------------------------------
const projectDir = path.join(scratch, "proj");
fs.mkdirSync(path.join(projectDir, ".taskmaster"), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, ".taskmaster", "state.json"),
  JSON.stringify({ currentTag: "master" }),
);
const stub = path.join(scratch, "tm-stub.sh");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"--version"*) echo "0.43.1-stub"; exit 0;;
  *"list --project"*) echo '{"tasks":[{"id":"1","title":"Task One","status":"pending","priority":"high","dependencies":[],"blocks":[]}],"metadata":{"total":1,"tag":"master"}}'; exit 0;;
  *"show --id 1 --project"*) echo '{"task":{"id":"1","title":"Task One","status":"pending","details":"d","testStrategy":"t","subtasks":[]}}'; exit 0;;
  *"next --project"*) echo '{"task":{"id":"1","title":"Task One","status":"pending"},"found":true}'; exit 0;;
  *"set-status"*) echo '{"success":true,"updatedTasks":[{"id":"1"}]}'; exit 0;;
esac
echo "unrecognized: $args" >&2; exit 2
`,
);
fs.chmodSync(stub, 0o755);

function startGateway() {
  return new Promise((resolve, reject) => {
    gw = spawn("node", ["src/server.js"], {
      cwd: GW_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        GATEWAY_AUTH_USER: USER,
        GATEWAY_AUTH_PASSWORD: PASS_WORD,
        GATEWAY_API_TOKEN: TOKEN,
        ALLOWED_ORIGINS: "http://localhost:3000",
        TASKMASTER_COMMAND: stub,
        TASKMASTER_PROJECTS_FILE: path.join(scratch, "tm-projects.json"),
        TASKMASTER_EXECUTIONS_FILE: path.join(scratch, "tm-exec.json"),
        GATEWAY_DATA_DIR: path.join(scratch, "data"),
        SERVERS_FILE: path.join(scratch, "servers.json"),
        PUSH_SUBSCRIPTIONS_FILE: path.join(scratch, "push-subs.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    gw.stdout.on("data", (d) => {
      out += d;
      if (out.includes("listening on")) resolve();
    });
    gw.stderr.on("data", (d) => process.stderr.write(`[gw] ${d}`));
    setTimeout(() => reject(new Error("gateway did not start in time")), 10000);
  });
}

// A persistent MCP child; sequential request/response keyed by id.
function mcpSession(actor, agentId) {
  const child = spawn("node", [MCP], {
    env: {
      ...process.env,
      TASKMASTER_HUB_API_TOKEN: TOKEN,
      TASKMASTER_HUB_BASE_URL: BASE,
      TASKMASTER_HUB_ACTOR: actor,
      TASKMASTER_HUB_AGENT_ID: agentId,
      TASKMASTER_HUB_ROLE: "BE",
      TASKMASTER_HUB_NAME: actor,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  sessions.push(child);
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    }
  });
  let id = 0;
  return {
    async call(name, args) {
      const myId = ++id;
      const m = await new Promise((resolve, reject) => {
        const to = setTimeout(
          () => reject(new Error(`MCP call timed out: ${name}`)),
          30000,
        );
        waiters.set(myId, (msg) => {
          clearTimeout(to);
          resolve(msg);
        });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: myId,
            method: "tools/call",
            params: { name, arguments: args },
          }) + "\n",
        );
      });
      return {
        text: m.result?.content?.[0]?.text,
        isError: Boolean(m.result?.isError),
      };
    },
  };
}

const CHAN = /forbidden|channel|auth channel/i;

async function main() {
  await startGateway();
  console.log(`gateway up on :${PORT} (auth enabled, stub task-master)`);

  // Two workers, DIFFERENT x-pm-actor, SAME agentId — so the agentId check
  // passes and it is the ownerChannel guard that must do the rejecting.
  const A = mcpSession("workerA", "shared-agent");
  const B = mcpSession("workerB", "shared-agent");

  // --- onboarding ---
  let r = await A.call("taskmaster_hub_init", { path: projectDir });
  const init = JSON.parse(r.text || "{}");
  assert(
    !r.isError && init.project && init.project.id,
    "init did not register a project",
  );
  assert(init.binaryMode === "binary", "init binaryMode !== binary");
  assert(
    init.identity.channel === "client:workerA",
    "init identity channel wrong",
  );
  assert(
    typeof init.protocol === "string" &&
      init.protocol.includes("taskmaster_hub_claim"),
    "init did not return the claim protocol text",
  );
  assert(
    typeof init.agentsMdSnippet === "string" &&
      init.agentsMdSnippet.includes("Task Master Hub"),
    "init did not return an AGENTS.md snippet",
  );
  const pid = init.project.id;
  ok("taskmaster_hub_init registered the project + returned protocol/snippet");

  // re-init is idempotent
  r = await A.call("taskmaster_hub_init", { path: projectDir });
  const reinit = JSON.parse(r.text || "{}");
  assert(
    !r.isError &&
      reinit.alreadyRegistered === true &&
      reinit.project.id === pid,
    "re-init not idempotent",
  );
  ok("re-init returns the existing registration (idempotent)");

  // --- claim / progress / overview (worker A) ---
  r = await A.call("taskmaster_hub_claim", { project_id: pid, task_id: "1" });
  assert(
    !r.isError && JSON.parse(r.text).status === "working",
    "workerA claim failed",
  );
  ok("workerA claim -> working");

  r = await A.call("taskmaster_hub_update_progress", {
    project_id: pid,
    task_id: "1",
    status: "review",
  });
  assert(
    !r.isError && JSON.parse(r.text).status === "review",
    "workerA update_progress failed",
  );
  ok("workerA update_progress -> review");

  r = await A.call("taskmaster_hub_overview", { project_id: pid });
  const ov = JSON.parse(r.text);
  assert(
    ov.executions &&
      ov.executions.length === 1 &&
      ov.executions[0].agentId === "shared-agent" &&
      ov.executions[0].agentRole === "BE",
    "overview does not show the held claim",
  );
  ok("overview shows the claim held (agentId shared-agent, role BE)");

  // --- worker B (different channel, same agentId) is rejected ---
  r = await B.call("taskmaster_hub_update_progress", {
    project_id: pid,
    task_id: "1",
    status: "working",
  });
  assert(
    r.isError && CHAN.test(r.text),
    `workerB update_progress not rejected on channel: ${r.text}`,
  );
  ok(`workerB update_progress -> rejected (${r.text.replace(/^Error: /, "")})`);

  r = await B.call("taskmaster_hub_release", { project_id: pid, task_id: "1" });
  assert(
    r.isError && CHAN.test(r.text),
    `workerB release not rejected on channel: ${r.text}`,
  );
  ok("workerB release -> rejected (channel)");

  // --- worker A releases; task is then free for anyone ---
  r = await A.call("taskmaster_hub_release", { project_id: pid, task_id: "1" });
  assert(
    !r.isError && JSON.parse(r.text).released === "1",
    "workerA release failed",
  );
  ok("workerA release -> ok");

  r = await B.call("taskmaster_hub_claim", { project_id: pid, task_id: "1" });
  assert(
    !r.isError && JSON.parse(r.text).status === "working",
    "workerB could not claim after release",
  );
  ok("workerB claims the freed task");

  r = await A.call("taskmaster_hub_update_progress", {
    project_id: pid,
    task_id: "1",
    status: "review",
  });
  assert(
    r.isError && CHAN.test(r.text),
    `workerA not locked out of workerB's fresh claim: ${r.text}`,
  );
  ok(
    "channel lock now points the other way (workerA -> 403 on workerB's claim)",
  );

  // --- invalid actor: the MCP refuses to start ---
  const bad = spawn("node", [MCP], {
    env: {
      ...process.env,
      TASKMASTER_HUB_API_TOKEN: TOKEN,
      TASKMASTER_HUB_ACTOR: "bad actor",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const code = await new Promise((res) => bad.on("exit", res));
  assert(
    code === 1,
    `MCP with an invalid TASKMASTER_HUB_ACTOR should exit 1, got ${code}`,
  );
  ok("invalid TASKMASTER_HUB_ACTOR -> MCP exits 1 at startup");

  cleanup();
  console.log(
    "\nPASS: taskmaster-hub-mcp — init/idempotency, claim/progress/overview/release, " +
      "per-worker ownerChannel isolation (403), invalid-actor startup guard.",
  );
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
