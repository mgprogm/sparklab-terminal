import assert from "node:assert/strict";
import test from "node:test";

// tools.ts -> gateway-client.ts -> config.ts fail-fast on missing env. Supply
// inert values before importing; no network client is created in this suite.
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const { TOOLS, WRITE_TOOLS, ONE_TIME_TOOLS, describeCall, executeTool } =
  await import("./tools.js");
const { gateway, GatewayError } = await import("./gateway-client.js");

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

// ---- Kanban tools -----------------------------------------------------------

const KANBAN_TOOLS = [
  "kanban_list",
  "kanban_get",
  "kanban_create",
  "kanban_delete",
  "kanban_move",
  "kanban_add_card",
  "kanban_update_card",
];

test("all seven Kanban tools are exposed", () => {
  const names = toolNames();
  for (const t of KANBAN_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("every Kanban tool has a closed parameters schema", () => {
  for (const name of KANBAN_TOOLS) {
    const tool = TOOLS.find((t) => t.function.name === name);
    assert.ok(tool, `${name} not found`);
    const params = tool.function.parameters as {
      type?: string;
      additionalProperties?: boolean;
    };
    assert.equal(params.type, "object", `${name} parameters not an object`);
    assert.equal(
      params.additionalProperties,
      false,
      `${name} must set additionalProperties:false`,
    );
  }
});

test("Kanban reads are auto (NOT write tools)", () => {
  assert.equal(WRITE_TOOLS.has("kanban_list"), false);
  assert.equal(WRITE_TOOLS.has("kanban_get"), false);
});

test("the four routine Kanban writes are WRITE tools", () => {
  for (const t of [
    "kanban_create",
    "kanban_move",
    "kanban_add_card",
    "kanban_update_card",
  ]) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
  }
});

test("kanban_delete is approval-gated AND coerced one-time (D9)", () => {
  // Must be a WRITE tool (so approval runs at all) AND in the one-time set
  // (so allow-always is coerced to a single allow) — the browser_act shape.
  assert.equal(WRITE_TOOLS.has("kanban_delete"), true);
  assert.equal(ONE_TIME_TOOLS.has("kanban_delete"), true);
});

test("the routine Kanban writes are NOT in the one-time set (allow-always ok)", () => {
  for (const t of [
    "kanban_create",
    "kanban_move",
    "kanban_add_card",
    "kanban_update_card",
  ]) {
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      false,
      `${t} should permit allow-always`,
    );
  }
});

test("describeCall returns a non-empty summary for each Kanban tool", () => {
  const args = {
    board_id: "kb-1",
    card_id: "card-1",
    to_column_id: "col-2",
    to_index: 1,
    name: "My Board",
    title: "My Card",
  };
  for (const t of KANBAN_TOOLS) {
    const s = describeCall(t, args);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${t} produced an empty describeCall`);
  }
});

test("kanban_get requires board_id (no gateway call when missing)", async () => {
  assert.equal(
    await executeTool("kanban_get", {}),
    "error: board_id is required",
  );
});

// ---- Project-management (PM) tools ------------------------------------------

const PM_READ_TOOLS = ["pm_list_projects", "pm_get_project", "pm_get_tree"];
const PM_WRITE_TOOLS = [
  "pm_create_project",
  "pm_delete_project",
  "pm_add_task",
  "pm_update_task",
  "pm_move_task",
  "pm_add_sprint",
  "pm_add_column",
  "pm_update_column",
  "pm_delete_column",
  "pm_move_column",
];
const PM_TOOLS = [...PM_READ_TOOLS, ...PM_WRITE_TOOLS];

test("all PM read/write tools (9 base + 4 column) are exposed", () => {
  const names = toolNames();
  for (const t of PM_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("pm_get_tree is a read tool (auto, NOT a write)", () => {
  assert.ok(toolNames().includes("pm_get_tree"));
  assert.equal(WRITE_TOOLS.has("pm_get_tree"), false);
  assert.equal(ONE_TIME_TOOLS.has("pm_get_tree"), false);
});

test("pm_add_task and pm_update_task expose type + parent_id params", () => {
  for (const name of ["pm_add_task", "pm_update_task"]) {
    const tool = TOOLS.find((t) => t.function.name === name);
    assert.ok(tool, `${name} not found`);
    const props = (
      tool.function.parameters as { properties?: Record<string, unknown> }
    ).properties;
    assert.ok(props && "type" in props, `${name} missing type param`);
    assert.ok(props && "parent_id" in props, `${name} missing parent_id param`);
  }
});

test("pm_get_tree requires project_id (no gateway call when missing)", async () => {
  assert.equal(
    await executeTool("pm_get_tree", {}),
    "error: project_id is required",
  );
});

test("there is no pm_delete_task tool (task deletion stays human-only)", () => {
  assert.ok(!toolNames().includes("pm_delete_task"));
});

test("every PM tool has a closed parameters schema", () => {
  for (const name of PM_TOOLS) {
    const tool = TOOLS.find((t) => t.function.name === name);
    assert.ok(tool, `${name} not found`);
    const params = tool.function.parameters as {
      type?: string;
      additionalProperties?: boolean;
    };
    assert.equal(params.type, "object", `${name} parameters not an object`);
    assert.equal(
      params.additionalProperties,
      false,
      `${name} must set additionalProperties:false`,
    );
  }
});

test("PM reads are auto (NOT write tools)", () => {
  for (const t of PM_READ_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), false, `${t} should NOT be a WRITE tool`);
  }
});

test("the ten PM writes (6 base + 4 column) are WRITE tools", () => {
  for (const t of PM_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
  }
});

test("pm_delete_project is approval-gated AND coerced one-time (D12)", () => {
  assert.equal(WRITE_TOOLS.has("pm_delete_project"), true);
  assert.equal(ONE_TIME_TOOLS.has("pm_delete_project"), true);
});

test("the routine PM writes are NOT in the one-time set (allow-always ok)", () => {
  for (const t of [
    "pm_create_project",
    "pm_add_task",
    "pm_update_task",
    "pm_move_task",
    "pm_add_sprint",
    "pm_add_column",
    "pm_update_column",
    "pm_move_column",
  ]) {
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      false,
      `${t} should permit allow-always`,
    );
  }
});

test("describeCall returns a non-empty summary for each PM tool", () => {
  const args = {
    project_id: "pm-1",
    task_id: "task-1",
    to_column_id: "col-2",
    to_index: 1,
    name: "My Project",
    title: "My Task",
  };
  for (const t of PM_TOOLS) {
    const s = describeCall(t, args);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${t} produced an empty describeCall`);
  }
});

test("pm_get_project requires project_id (no gateway call when missing)", async () => {
  assert.equal(
    await executeTool("pm_get_project", {}),
    "error: project_id is required",
  );
});

// ---- PM Column tools --------------------------------------------------------

const PM_COL_TOOLS = [
  "pm_add_column",
  "pm_update_column",
  "pm_delete_column",
  "pm_move_column",
];

test("all four PM column tools are exposed", () => {
  const names = toolNames();
  for (const t of PM_COL_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("every PM column tool has a closed parameters schema", () => {
  for (const name of PM_COL_TOOLS) {
    const tool = TOOLS.find((t) => t.function.name === name);
    assert.ok(tool, `${name} not found`);
    const params = tool.function.parameters as {
      type?: string;
      additionalProperties?: boolean;
    };
    assert.equal(params.type, "object", `${name} parameters not an object`);
    assert.equal(
      params.additionalProperties,
      false,
      `${name} must set additionalProperties:false`,
    );
  }
});

test("pm column tools are WRITE tools", () => {
  for (const t of PM_COL_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
  }
});

test("pm_delete_column is coerced one-time (can strand/relocate many tasks)", () => {
  assert.equal(ONE_TIME_TOOLS.has("pm_delete_column"), true);
});

test("routine PM column writes are NOT in the one-time set (allow-always ok)", () => {
  for (const t of ["pm_add_column", "pm_update_column", "pm_move_column"]) {
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      false,
      `${t} should permit allow-always`,
    );
  }
});

test("describeCall returns a non-empty summary for each PM column tool", () => {
  const args = {
    project_id: "pm-1",
    column_id: "col-1",
    to_index: 2,
    name: "Review",
    wip_limit: 5,
    mode: "relocate" as const,
    to_column_id: "col-2",
  };
  for (const t of PM_COL_TOOLS) {
    const s = describeCall(t, args);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${t} produced an empty describeCall`);
  }
});

// ---- AC7: pm_move_task 422 no-retry vs 409 retry ----------------------------

test("AC7: pm_move_task does NOT retry a 422 (single gateway call)", async () => {
  // Stub gateway methods to count calls and simulate a 422 wip_exceeded.
  const originalGetPm = gateway.getPmProject.bind(gateway);
  const originalMovePm = gateway.movePmTask.bind(gateway);
  let moveCallCount = 0;

  gateway.getPmProject = async () =>
    ({
      id: "pm-test",
      rev: 5,
      columns: [{ id: "col-a", taskIds: [] }],
    }) as never;

  gateway.movePmTask = async () => {
    moveCallCount++;
    throw new GatewayError(422, "column In Progress is at its WIP limit (3)");
  };

  try {
    const result = await executeTool("pm_move_task", {
      project_id: "pm-test",
      task_id: "task-1",
      to_column_id: "col-a",
      to_index: 0,
    });
    assert.equal(
      moveCallCount,
      1,
      `422 must trigger exactly 1 gateway call, got ${moveCallCount}`,
    );
    assert.ok(
      result.startsWith("error: gateway 422:"),
      `422 surfaces as error string, got: ${result}`,
    );
  } finally {
    gateway.getPmProject = originalGetPm;
    gateway.movePmTask = originalMovePm;
  }
});

// ---- PM Collaboration (Phase 3) tools -----------------------------------------

const PM_COLLAB_READ_TOOLS = [
  "pm_list_comments",
  "pm_list_activity",
  "pm_list_attachments",
];
const PM_COLLAB_WRITE_TOOLS = [
  "pm_add_comment",
  "pm_watch_task",
  "pm_unwatch_task",
];
const PM_COLLAB_TOOLS = [...PM_COLLAB_READ_TOOLS, ...PM_COLLAB_WRITE_TOOLS];

test("all six PM collaboration tools are exposed", () => {
  const names = toolNames();
  for (const t of PM_COLLAB_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("every PM collab tool has a closed parameters schema", () => {
  for (const name of PM_COLLAB_TOOLS) {
    const tool = TOOLS.find((t) => t.function.name === name);
    assert.ok(tool, `${name} not found`);
    const params = tool.function.parameters as {
      type?: string;
      additionalProperties?: boolean;
    };
    assert.equal(params.type, "object", `${name} parameters not an object`);
    assert.equal(
      params.additionalProperties,
      false,
      `${name} must set additionalProperties:false`,
    );
  }
});

test("PM collab reads are auto (NOT write tools)", () => {
  for (const t of PM_COLLAB_READ_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), false, `${t} should NOT be a WRITE tool`);
  }
});

test("PM collab writes are WRITE tools (approval-gated)", () => {
  for (const t of PM_COLLAB_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
  }
});

test("PM collab writes are NOT in the one-time set (allow-always ok)", () => {
  for (const t of PM_COLLAB_WRITE_TOOLS) {
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      false,
      `${t} should permit allow-always`,
    );
  }
});

test("no pm_upload_attachment tool exists (human-only per OD7)", () => {
  assert.ok(!toolNames().includes("pm_upload_attachment"));
  assert.ok(!toolNames().includes("pm_add_attachment"));
});

test("no pm_notifications agent tools exist (human-only affordance)", () => {
  assert.ok(!toolNames().includes("pm_list_notifications"));
  assert.ok(!toolNames().includes("pm_mark_read"));
});

test("describeCall returns a non-empty summary for each PM collab tool", () => {
  const args = {
    project_id: "pm-1",
    task_id: "task-1",
    body: "test comment",
  };
  for (const t of PM_COLLAB_TOOLS) {
    const s = describeCall(t, args);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${t} produced an empty describeCall`);
  }
});

test("pm_add_comment requires project_id, task_id, body", async () => {
  assert.equal(
    await executeTool("pm_add_comment", { project_id: "pm-1" }),
    "error: project_id, task_id and body are required",
  );
});

test("pm_list_comments requires project_id and task_id", async () => {
  assert.equal(
    await executeTool("pm_list_comments", { project_id: "pm-1" }),
    "error: project_id and task_id are required",
  );
});

test("pm_list_activity requires project_id", async () => {
  assert.equal(
    await executeTool("pm_list_activity", {}),
    "error: project_id is required",
  );
});

test("pm_watch_task requires project_id and task_id", async () => {
  assert.equal(
    await executeTool("pm_watch_task", { project_id: "pm-1" }),
    "error: project_id and task_id are required",
  );
});

test("pm_list_attachments requires project_id and task_id", async () => {
  assert.equal(
    await executeTool("pm_list_attachments", { project_id: "pm-1" }),
    "error: project_id and task_id are required",
  );
});

test("AC7: pm_move_task retries once on 409 stale", async () => {
  const originalGetPm = gateway.getPmProject.bind(gateway);
  const originalMovePm = gateway.movePmTask.bind(gateway);
  let moveCallCount = 0;

  gateway.getPmProject = async () =>
    ({
      id: "pm-test",
      rev: 5,
      columns: [{ id: "col-a", taskIds: [] }],
      tasks: [],
    }) as never;

  gateway.movePmTask = async () => {
    moveCallCount++;
    if (moveCallCount === 1) {
      // First call: simulate stale rev.
      return {
        stale: true,
        project: {
          id: "pm-test",
          rev: 6,
          columns: [{ id: "col-a", taskIds: [] }],
          tasks: [],
        } as never,
      };
    }
    // Second call: succeed.
    return {
      stale: false,
      project: {
        id: "pm-test",
        rev: 7,
        columns: [{ id: "col-a", taskIds: ["task-1"] }],
        tasks: [],
      } as never,
    };
  };

  try {
    const result = await executeTool("pm_move_task", {
      project_id: "pm-test",
      task_id: "task-1",
      to_column_id: "col-a",
      to_index: 0,
    });
    assert.equal(
      moveCallCount,
      2,
      `409 stale must trigger exactly 2 gateway calls, got ${moveCallCount}`,
    );
    assert.ok(
      !result.startsWith("error:"),
      `retried move should succeed, got: ${result}`,
    );
  } finally {
    gateway.getPmProject = originalGetPm;
    gateway.movePmTask = originalMovePm;
  }
});
