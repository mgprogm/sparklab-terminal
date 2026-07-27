import assert from "node:assert/strict";
import test from "node:test";

// tools.ts -> gateway-client.ts -> config.ts fail-fast on missing env. Supply
// inert values before importing; no network client is created in this suite.
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const { TOOLS, WRITE_TOOLS, describeCall, executeTool } =
  await import("./tools.js");
const { gateway } = await import("./gateway-client.js");

function toolNames(): string[] {
  return TOOLS.map((t) => t.function.name);
}

test("the standalone file tools were removed (use run_codex instead)", () => {
  const names = toolNames();
  assert.ok(!names.includes("list_files"), "list_files should be removed");
  assert.ok(!names.includes("read_file"), "read_file should be removed");
});

// ---- run_codex --------------------------------------------------------------

test("run_codex is exposed as a tool", () => {
  assert.ok(toolNames().includes("run_codex"), "run_codex missing from TOOLS");
});

test("browser handoff is an explicit one-time approved tool", () => {
  assert.ok(toolNames().includes("browser_request_handoff"));
  assert.equal(WRITE_TOOLS.has("browser_request_handoff"), true);
  assert.equal(
    describeCall("browser_request_handoff", {}),
    "take control of the isolated browser",
  );
});

test("run_codex is a WRITE tool (approval-gated, consequential)", () => {
  assert.equal(WRITE_TOOLS.has("run_codex"), true);
});

test("run_codex requires session_id and prompt; mode is a two-value enum", () => {
  const codex = TOOLS.find((t) => t.function.name === "run_codex");
  assert.ok(codex);
  assert.deepEqual(codex.function.parameters?.required, [
    "session_id",
    "prompt",
  ]);
  const props = codex.function.parameters?.properties as Record<
    string,
    { enum?: string[] }
  >;
  assert.ok(props.mode, "run_codex is missing a mode property");
  assert.deepEqual(props.mode.enum, ["read-only", "workspace-write"]);
});

test("describeCall shows the exact Codex mode and task (visible approval)", () => {
  assert.equal(
    describeCall("run_codex", { prompt: "explain the auth flow" }),
    "run Codex [read-only]: explain the auth flow",
  );
  assert.equal(
    describeCall("run_codex", {
      mode: "workspace-write",
      prompt: "add a test for parseArgs",
    }),
    "run Codex [workspace-write]: add a test for parseArgs",
  );
  // An unknown mode is presented as read-only (matches the executor's clamp).
  assert.equal(
    describeCall("run_codex", { mode: "danger-full-access", prompt: "x" }),
    "run Codex [read-only]: x",
  );
});

test("run_codex short-circuits when prompt is missing (no gateway call)", async () => {
  assert.equal(
    await executeTool("run_codex", { session_id: "web-x" }),
    "error: session_id and prompt are required",
  );
});

test("run_codex forwards agent-service Azure config outside the JSON body", async () => {
  const originalFetch = globalThis.fetch;
  let seenHeaders: Headers | undefined;
  let seenBody = "";
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/auth/login")) {
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "gw_session=test-session; HttpOnly" },
      });
    }
    seenHeaders = new Headers(init?.headers);
    seenBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        mode: "read-only",
        cwd: "/tmp/project",
        exitCode: 0,
        output: "ok",
        truncated: false,
        durationMs: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await gateway.runCodex("web-x", { prompt: "inspect this project" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seenHeaders?.get("x-sparklab-codex-azure-api-key"), "test-key");
  assert.equal(
    seenHeaders?.get("x-sparklab-codex-azure-endpoint"),
    "https://example.invalid",
  );
  assert.equal(
    seenHeaders?.get("x-sparklab-codex-azure-deployment"),
    "test-deployment",
  );
  assert.ok(!seenBody.includes("test-key"), "secret leaked into request body");
});
