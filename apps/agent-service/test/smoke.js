// Live smoke test for the agent service.
//
// Spawns a real gateway (open mode, loopback) + the agent service (real Azure
// creds from .env, but pointed at the open-mode gateway with no auth), opens a
// WS to /agent, sends one message, auto-approves every write, and asserts the
// agent actually created a session and ran a command through the gateway.
//
// This makes ONE real Azure call. Run: pnpm --filter @sparklab/agent-service smoke
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SVC = path.join(__dirname, "..");
const GW = path.join(SVC, "..", "terminal-gateway");
const GW_PORT = 3995;
const AGENT_PORT = 3994;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Slow reasoning model (~15s per call); a create→approve→run→wait→summarize
// turn is several calls. Give it generous headroom.
const CONVO_TIMEOUT_MS = 120000;
let gw, agent;
let before = new Set();

function webSessions() {
  try {
    return execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("web-"));
  } catch {
    return [];
  }
}

function waitFor(child, needle, label) {
  return new Promise((resolve, reject) => {
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes(needle)) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    setTimeout(() => reject(new Error(`${label} did not start`)), 12000);
  });
}

function cleanup() {
  // Kill any web- session that appeared during the run, even on timeout —
  // computed here (not passed in) so the timeout/error paths clean up too.
  for (const id of webSessions().filter((s) => !before.has(s))) {
    try {
      execFileSync("tmux", ["kill-session", "-t", id], { stdio: "ignore" });
    } catch {}
  }
  if (gw && !gw.killed) gw.kill("SIGTERM");
  if (agent && !agent.killed) agent.kill("SIGTERM");
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

async function main() {
  before = new Set(webSessions());

  // 1. Gateway in open mode (loopback, no auth env).
  gw = spawn("node", ["src/server.js"], {
    cwd: GW,
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      GATEWAY_AUTH_USER: "",
      GATEWAY_AUTH_PASSWORD: "",
      GATEWAY_AUTH_PASSWORD_HASH: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(gw, "listening on", "gw");

  // 2. Agent service: Azure creds from process.env (loaded via --env-file),
  //    gateway auth blanked so it uses the open-mode gateway.
  agent = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: SVC,
    env: {
      ...process.env,
      AGENT_PORT: String(AGENT_PORT),
      GATEWAY_URL: `http://127.0.0.1:${GW_PORT}`,
      GATEWAY_AUTH_USER: "",
      GATEWAY_AUTH_PASSWORD: "",
      ALLOWED_ORIGINS: "http://localhost:3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(agent, "listening on", "agent");
  await sleep(300);

  // 3. Connect (no Origin header, no cookie → open-mode auth passes).
  const ws = new WebSocket(`ws://127.0.0.1:${AGENT_PORT}/agent`);
  const frames = [];
  let chatStarted = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`conversation timed out (${CONVO_TIMEOUT_MS}ms)`)),
      CONVO_TIMEOUT_MS,
    );
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "user_message",
          text: "Create a new terminal session named smoke-check, then tell me it's ready. Just that one action.",
        }),
      );
    });
    ws.on("message", (data) => {
      let f;
      try {
        f = JSON.parse(data.toString());
      } catch {
        return;
      }
      frames.push(f);
      if (f.type === "tool_use")
        console.log(`  → tool_use ${f.tool} :: ${f.summary}`);
      else if (f.type === "tool_result")
        console.log(`  ← tool_result ${f.tool} ok=${f.ok}`);
      else if (f.type === "status") console.log(`  · status ${f.state}`);
      else if (f.type === "approval_request")
        console.log(`  ? approval ${f.tool} :: ${f.summary}`);
      else if (f.type === "assistant_message")
        console.log(`  ✓ assistant: ${f.text.slice(0, 80)}`);
      else if (f.type !== "assistant_delta") console.log(`  [${f.type}]`);
      if (f.type === "chat_started") chatStarted = true;
      if (f.type === "approval_request") {
        ws.send(
          JSON.stringify({
            type: "approval_response",
            requestId: f.requestId,
            behavior: "allow",
          }),
        );
      }
      if (f.type === "error")
        console.error(`[agent-frame] error: ${f.message}`);
      // Turn ends when status returns to idle after we've seen a final message.
      if (f.type === "status" && f.state === "idle" && chatStarted) {
        clearTimeout(timer);
        setTimeout(resolve, 200);
      }
    });
    ws.on("error", reject);
  });
  ws.close();

  // 4. Assertions.
  if (!chatStarted) fail("never received chat_started");
  const toolUses = frames.filter((f) => f.type === "tool_use");
  if (toolUses.length === 0) fail("agent made no tool calls");
  const tools = new Set(toolUses.map((f) => f.tool));
  const errors = frames.filter((f) => f.type === "error");
  if (errors.length && toolUses.length === 0)
    fail(`agent errored before acting: ${errors[0].message}`);

  // 5. Verify a session was actually created in tmux (gateway = source of truth).
  const after = webSessions();
  const created = after.filter((s) => !before.has(s));
  const approvals = frames.filter((f) => f.type === "approval_request");
  const finalMsg = frames.filter((f) => f.type === "assistant_message").pop();

  console.log("\n--- smoke summary ---");
  console.log(`chat_started:        ${chatStarted}`);
  console.log(`tool calls:          ${[...tools].join(", ")}`);
  console.log(`approvals requested: ${approvals.length}`);
  console.log(`sessions created:    ${created.length}`);
  console.log(
    `final message:       ${finalMsg ? JSON.stringify(finalMsg.text.slice(0, 120)) : "(none)"}`,
  );

  if (approvals.length === 0)
    fail("expected at least one approval_request for the write tool");
  if (created.length === 0)
    fail("no new session was created in tmux (see frame trace above)");

  console.log("\nPASS");
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.message));
