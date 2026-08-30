// Live smoke test for the Virtual Computer (CUA) skill, through the real model.
//
// Spawns a real gateway (open mode, loopback) + the agent service with
// CUA_ENABLED and the real desktop image, opens a WS to /agent, asks the agent
// to look at the desktop, auto-approves computer_act, and asserts the whole
// path ran: model → agent-loop → computer_observe → real container →
// computer_view frame → assistant summary.
//
// This makes real model calls and boots a ~2 GB container. Run:
//   pnpm --filter @sparklab/agent-service test:computer-smoke
//
// STATUS (2026-08-30): the deterministic runtime path is fully covered by
// `test:computer-e2e` (stub) and `CUA_E2E_REAL=1 test:computer-e2e` (real
// container). This live-through-the-model leg does NOT currently pass: after
// chat_started the agent turn never starts (no `status thinking`, no
// assistant_delta, no error) — a pre-existing agent-service issue, not
// CUA-specific (the baseline `pnpm --filter @sparklab/agent-service smoke`
// is also broken today: it connects with no Origin header and `.env` now sets
// AGENT_ALLOW_MISSING_ORIGIN=false → 403). Kept as a ready harness for when
// the agent-loop turn-start / model provider is healthy.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SVC = path.join(__dirname, "..");
const GW = path.join(SVC, "..", "terminal-gateway");
const GW_PORT = 3993;
const AGENT_PORT = 3992;
const CONVO_TIMEOUT_MS = Number(process.env.CUA_SMOKE_TIMEOUT_MS || 300000);
const IMAGE = process.env.CUA_IMAGE || "sparklab/cua-desktop:0.22.2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gw, agent;

function sweepContainers() {
  try {
    const ids = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", "label=sparklab-cua"],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length)
      execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
  } catch {
    // best effort
  }
}

function waitFor(child, needle, label) {
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes(needle)) resolve();
    });
    child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    setTimeout(() => reject(new Error(`${label} did not start`)), 15000);
  });
}

function cleanup() {
  if (gw && !gw.killed) gw.kill("SIGTERM");
  if (agent && !agent.killed) agent.kill("SIGTERM");
  sweepContainers();
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

async function main() {
  sweepContainers();

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

  agent = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: SVC,
    env: {
      ...process.env,
      AGENT_PORT: String(AGENT_PORT),
      GATEWAY_URL: `http://127.0.0.1:${GW_PORT}`,
      GATEWAY_AUTH_USER: "",
      GATEWAY_AUTH_PASSWORD: "",
      ALLOWED_ORIGINS: "http://localhost:3000",
      AGENT_ALLOW_MISSING_ORIGIN: "false",
      CUA_ENABLED: "true",
      CUA_IMAGE: IMAGE,
      CUA_DRIVER_USER: "cua",
      CUA_START_TIMEOUT_MS: "180000",
      CUA_SCREENSHOT_DIR: "/tmp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(agent, "listening on", "agent");
  await sleep(300);

  const terminalSessionId = "local/cua-smoke";
  const ws = new WebSocket(
    `ws://127.0.0.1:${AGENT_PORT}/agent?terminalSessionId=${encodeURIComponent(terminalSessionId)}&newChat=1`,
    { headers: { Origin: "http://localhost:3000" } },
  );
  const frames = [];
  let chatStarted = false;
  let sawWork = false;
  let sent = false;

  const sendPrompt = () => {
    if (sent) return;
    sent = true;
    ws.send(
      JSON.stringify({
        type: "user_message",
        text: "Use the virtual computer. Call computer_observe once and tell me which application windows are open on the desktop. Do not click anything.",
      }),
    );
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`conversation timed out (${CONVO_TIMEOUT_MS}ms)`)),
      CONVO_TIMEOUT_MS,
    );
    // Send after chat_started (dodges the WS message-drop race), with an
    // on-open fallback in case chat_started was already replayed.
    ws.on("open", () => setTimeout(sendPrompt, 1500));
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
      else if (f.type === "computer_view")
        console.log(
          `  ▣ computer_view rev=${f.revision} ${f.viewport.width}x${f.viewport.height} ${Buffer.from(f.screenshot.data, "base64").length}B`,
        );
      else if (f.type === "computer_closed")
        console.log(`  ▣ computer_closed rev=${f.revision}`);
      else if (f.type === "assistant_message")
        console.log(`  ✓ assistant: ${f.text.slice(0, 200)}`);
      else if (f.type === "error") console.error(`  [error] ${f.message}`);
      else if (f.type !== "assistant_delta") console.log(`  [${f.type}]`);

      if (f.type === "chat_started") {
        chatStarted = true;
        setTimeout(sendPrompt, 300);
      }
      if (
        f.type === "assistant_delta" ||
        f.type === "tool_use" ||
        (f.type === "status" &&
          (f.state === "thinking" || f.state === "acting"))
      ) {
        sawWork = true;
      }
      if (f.type === "approval_request") {
        ws.send(
          JSON.stringify({
            type: "approval_response",
            requestId: f.requestId,
            behavior: "allow",
          }),
        );
      }
      // End only once the turn has actually run and returned to idle.
      if (f.type === "status" && f.state === "idle" && sent && sawWork) {
        clearTimeout(timer);
        setTimeout(resolve, 300);
      }
    });
    ws.on("error", reject);
  });
  ws.close();
  await sleep(500);

  const toolUses = frames.filter((f) => f.type === "tool_use");
  const views = frames.filter((f) => f.type === "computer_view");
  const errors = frames.filter((f) => f.type === "error");
  const finalMsg = frames.filter((f) => f.type === "assistant_message").pop();

  console.log("\n--- cua smoke summary ---");
  console.log(`chat_started:      ${chatStarted}`);
  console.log(
    `tool calls:        ${[...new Set(toolUses.map((f) => f.tool))].join(", ") || "(none)"}`,
  );
  console.log(
    `computer_view:     ${views.length}${views.length ? ` (last ${views.at(-1).viewport.width}x${views.at(-1).viewport.height})` : ""}`,
  );
  console.log(
    `errors:            ${errors.map((e) => e.message).join("; ") || "(none)"}`,
  );
  console.log(
    `final message:     ${finalMsg ? JSON.stringify(finalMsg.text.slice(0, 300)) : "(none)"}`,
  );

  if (!chatStarted) fail("never received chat_started");
  if (!toolUses.some((f) => f.tool === "computer_observe"))
    fail("agent never called computer_observe");
  if (views.length === 0) fail("no computer_view frame reached the client");
  const v = views.at(-1);
  if (!(v.viewport.width > 0 && v.viewport.height > 0))
    fail("computer_view had no viewport");
  if (Buffer.from(v.screenshot.data, "base64").length < 1000)
    fail("computer_view screenshot too small to be real");
  if (!finalMsg) fail("agent produced no final message");

  console.log("\nPASS");
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.message));
