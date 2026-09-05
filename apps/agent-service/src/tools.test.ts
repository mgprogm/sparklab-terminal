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

test("scheduled terminal actions are approval-gated and require an exact time", () => {
  const action = TOOLS.find(
    (tool) => tool.function.name === "schedule_terminal_action",
  );
  assert.ok(action, "schedule_terminal_action missing from TOOLS");
  assert.equal(WRITE_TOOLS.has("schedule_terminal_action"), true);
  assert.equal(ONE_TIME_TOOLS.has("schedule_terminal_action"), true);
  assert.deepEqual(action.function.parameters?.required, [
    "session_id",
    "keys",
    "execute_at",
  ]);
  assert.equal(
    describeCall("schedule_terminal_action", {
      session_id: "web-x",
      keys: ["Enter"],
      execute_at: "2026-08-22T22:30:00+07:00",
    }),
    "schedule Enter at 2026-08-22T22:30:00+07:00",
  );
});

test("scheduled terminal input is one-time approved and requires exact text", () => {
  const input = TOOLS.find(
    (tool) => tool.function.name === "schedule_terminal_input",
  );
  assert.ok(input, "schedule_terminal_input missing from TOOLS");
  assert.equal(WRITE_TOOLS.has("schedule_terminal_input"), true);
  assert.equal(ONE_TIME_TOOLS.has("schedule_terminal_input"), true);
  assert.deepEqual(input.function.parameters?.required, [
    "session_id",
    "text",
    "keys",
    "execute_at",
  ]);
  assert.equal(
    describeCall("schedule_terminal_input", {
      session_id: "web-x",
      text: "continue",
      keys: ["Enter"],
      execute_at: "2026-08-22T22:30:00+07:00",
    }),
    "schedule type continue then Enter at 2026-08-22T22:30:00+07:00",
  );
});

test("scheduled terminal actions can be listed and a pending action cancelled", () => {
  const list = TOOLS.find(
    (tool) => tool.function.name === "list_scheduled_terminal_actions",
  );
  const cancel = TOOLS.find(
    (tool) => tool.function.name === "cancel_scheduled_terminal_action",
  );
  assert.ok(list, "list_scheduled_terminal_actions missing from TOOLS");
  assert.ok(cancel, "cancel_scheduled_terminal_action missing from TOOLS");
  assert.equal(WRITE_TOOLS.has("list_scheduled_terminal_actions"), false);
  assert.equal(WRITE_TOOLS.has("cancel_scheduled_terminal_action"), true);
  assert.deepEqual(cancel.function.parameters?.required, ["action_id"]);
  assert.equal(
    describeCall("cancel_scheduled_terminal_action", { action_id: "timer-1" }),
    "cancel scheduled terminal action timer-1",
  );
});

test("browser handoff is an explicit one-time approved tool", () => {
  assert.ok(toolNames().includes("browser_request_handoff"));
  assert.equal(WRITE_TOOLS.has("browser_request_handoff"), true);
  assert.equal(
    describeCall("browser_request_handoff", {}),
    "take control of the isolated browser",
  );
});

test("virtual-computer tools are hidden from TOOLS unless CUA_ENABLED, but their approval tiers are always keyed", () => {
  // This suite runs without CUA_ENABLED, so the model never sees the tools.
  for (const t of [
    "computer_observe",
    "computer_act",
    "computer_list_windows",
    "computer_capture",
  ])
    assert.equal(
      toolNames().includes(t),
      false,
      `${t} hidden without CUA_ENABLED`,
    );
  // Membership is by name and unconditional: if the tool ever is offered, it
  // is a one-time-approved write (no allow-always), like browser_act.
  assert.equal(WRITE_TOOLS.has("computer_act"), true);
  assert.equal(ONE_TIME_TOOLS.has("computer_act"), true);
  assert.equal(WRITE_TOOLS.has("computer_observe"), false);
  // M3.3: computer_list_windows is a read — never a write tool.
  assert.equal(WRITE_TOOLS.has("computer_list_windows"), false);
  assert.equal(ONE_TIME_TOOLS.has("computer_list_windows"), false);
  // M3.4: computer_capture is a one-time-approved file write, like browser_capture.
  assert.equal(WRITE_TOOLS.has("computer_capture"), true);
  assert.equal(ONE_TIME_TOOLS.has("computer_capture"), true);
  // describeCall stays defined regardless of gating.
  assert.equal(
    describeCall("computer_observe", {}),
    "observe computer desktop",
  );
  assert.equal(
    describeCall("computer_list_windows", {}),
    "list computer windows",
  );
  assert.equal(
    describeCall("computer_capture", {
      session_id: "web-x",
      path: "/tmp/desktop.png",
    }),
    "capture computer screen to /tmp/desktop.png",
  );
  assert.equal(
    describeCall("computer_act", {
      kind: "type_text",
      x: 40,
      y: 80,
      text: "hunter2",
    }),
    "type into computer @ 40,80: [redacted]",
  );
  // M3.1: element-target form of describeCall.
  assert.equal(
    describeCall("computer_act", {
      kind: "click",
      element_index: 5,
      snapshot_id: "snap-3",
    }),
    "click computer element 5",
  );
  assert.equal(
    describeCall("computer_act", {
      kind: "type_text",
      element_index: 2,
      snapshot_id: "snap-3",
      text: "hunter2",
    }),
    "type into computer element 2: [redacted]",
  );
  // M3.2: new kinds render on the approval card.
  assert.equal(
    describeCall("computer_act", {
      kind: "double_click",
      element_index: 5,
      snapshot_id: "snap-3",
    }),
    "double_click computer element 5",
  );
  assert.equal(
    describeCall("computer_act", { kind: "right_click", x: 12, y: 34 }),
    "right_click computer @ 12,34",
  );
  assert.equal(
    describeCall("computer_act", {
      kind: "drag",
      x: 10,
      y: 20,
      to_x: 30,
      to_y: 40,
    }),
    "drag computer @ 10,20 → 30,40",
  );
  assert.equal(
    describeCall("computer_act", { kind: "hotkey", keys: ["ctrl", "l"] }),
    "hotkey computer ctrl+l",
  );
});

test("browser capture is an explicit one-time approved file write", () => {
  const capture = TOOLS.find((t) => t.function.name === "browser_capture");
  assert.ok(capture);
  assert.equal(WRITE_TOOLS.has("browser_capture"), true);
  assert.equal(ONE_TIME_TOOLS.has("browser_capture"), true);
  assert.deepEqual(capture.function.parameters?.required, [
    "session_id",
    "path",
  ]);
  assert.equal(
    describeCall("browser_capture", {
      session_id: "web-x",
      path: "/tmp/page.png",
    }),
    "capture browser screen to /tmp/page.png",
  );
});

test("gateway screenshot upload sends exact bytes to the encoded absolute path", async () => {
  const originalFetch = globalThis.fetch;
  const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let seenUrl = "";
  let seenContentType = "";
  let seenBody = Buffer.alloc(0);
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/auth/login")) {
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "gw_session=capture-test; HttpOnly" },
      });
    }
    seenUrl = String(input);
    seenContentType = new Headers(init?.headers).get("content-type") ?? "";
    seenBody = Buffer.from((init?.body as Buffer | undefined) ?? []);
    return new Response(
      JSON.stringify({ path: "/tmp/captures/page one.png", size: 4 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await gateway.uploadSessionFile(
      "web-x",
      "/tmp/captures/page one.png",
      screenshot,
      "image/png",
    );
    assert.deepEqual(result, {
      path: "/tmp/captures/page one.png",
      size: 4,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(
    seenUrl,
    /\/api\/sessions\/web-x\/fs\/upload\?path=%2Ftmp%2Fcaptures%2Fpage\+one\.png$/,
  );
  assert.equal(seenContentType, "image/png");
  assert.deepEqual(seenBody, screenshot);
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

// ---- Notes tools (docs/NOTES-TOOL-PLAN.md) ----------------------------------

const NOTES_READ_TOOLS = [
  "notes_list",
  "notes_get_notebook",
  "notes_get_page",
  "notes_search",
];
const NOTES_ALLOW_ALWAYS_WRITE_TOOLS = [
  "notes_create_notebook",
  "notes_create_section",
  "notes_create_page",
  "notes_append_to_page",
  "notes_move_page",
];
const NOTES_ONE_TIME_WRITE_TOOLS = [
  "notes_update_page",
  "notes_delete_page",
  "notes_delete_section",
  "notes_delete_notebook",
];
const NOTES_TOOLS = [
  ...NOTES_READ_TOOLS,
  ...NOTES_ALLOW_ALWAYS_WRITE_TOOLS,
  ...NOTES_ONE_TIME_WRITE_TOOLS,
];

test("all thirteen Notes tools are exposed", () => {
  const names = toolNames();
  for (const t of NOTES_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("every Notes tool has a closed parameters schema", () => {
  for (const name of NOTES_TOOLS) {
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

test("Notes reads are auto (NOT write tools)", () => {
  for (const t of NOTES_READ_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), false, `${t} should NOT be a WRITE tool`);
  }
});

test("the five additive/structural Notes writes are WRITE tools, allow-always (D9)", () => {
  for (const t of NOTES_ALLOW_ALWAYS_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      false,
      `${t} should permit allow-always`,
    );
  }
});

test("notes_update_page is approval-gated AND coerced one-time (D9 — inverted from the naive reading)", () => {
  assert.equal(WRITE_TOOLS.has("notes_update_page"), true);
  assert.equal(ONE_TIME_TOOLS.has("notes_update_page"), true);
});

test("notes_append_to_page is NOT in the one-time set (cannot clobber, D9)", () => {
  assert.equal(ONE_TIME_TOOLS.has("notes_append_to_page"), false);
});

test("the three Notes deletes are approval-gated AND coerced one-time (D10)", () => {
  for (const t of [
    "notes_delete_page",
    "notes_delete_section",
    "notes_delete_notebook",
  ]) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
    assert.equal(ONE_TIME_TOOLS.has(t), true, `${t} should be one-time`);
  }
});

test("describeCall returns a non-empty summary for each Notes tool", () => {
  const args = {
    notebook_id: "nb-1",
    section_id: "sec-1",
    page_id: "pg-1",
    query: "kickoff",
    name: "Engineering",
    title: "Kickoff",
    markdown: "- follow up",
    to_section_id: "sec-2",
    to_index: 0,
  };
  for (const t of NOTES_TOOLS) {
    const s = describeCall(t, args);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${t} produced an empty describeCall`);
  }
});

test("notes_get_notebook requires notebook_id (no gateway call when missing)", async () => {
  assert.equal(
    await executeTool("notes_get_notebook", {}),
    "error: notebook_id is required",
  );
});

test("notes_create_page requires either section_id or parent_id", async () => {
  assert.equal(
    await executeTool("notes_create_page", { notebook_id: "nb-1" }),
    "error: either section_id or parent_id is required",
  );
});

test("notes_move_page retries ONCE on a 409 stale (safe: re-derived splice, D4)", async () => {
  const originalGetNotebook = gateway.getNotebook.bind(gateway);
  const originalMovePage = gateway.movePage.bind(gateway);
  let moveCallCount = 0;

  gateway.getNotebook = async () =>
    ({ id: "nb-test", rev: 5, sections: [], pages: [] }) as never;

  gateway.movePage = async () => {
    moveCallCount++;
    if (moveCallCount === 1) {
      return {
        stale: true,
        notebook: { id: "nb-test", rev: 6, sections: [], pages: [] } as never,
      };
    }
    return {
      stale: false,
      notebook: { id: "nb-test", rev: 7, sections: [], pages: [] } as never,
    };
  };

  try {
    const result = await executeTool("notes_move_page", {
      notebook_id: "nb-test",
      page_id: "pg-1",
      to_section_id: "sec-1",
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
    gateway.getNotebook = originalGetNotebook;
    gateway.movePage = originalMovePage;
  }
});

test("notes_update_page does NOT retry a 409 stale (D4 — blind overwrite, surfaced not replayed)", async () => {
  const originalGetPage = gateway.getPage.bind(gateway);
  const originalUpdatePage = gateway.updatePage.bind(gateway);
  let updateCallCount = 0;

  gateway.getPage = async () =>
    ({
      id: "pg-1",
      title: "Kickoff",
      rev: 3,
      body: "old body",
    }) as never;

  gateway.updatePage = async () => {
    updateCallCount++;
    return {
      stale: true,
      page: {
        id: "pg-1",
        title: "Kickoff",
        rev: 4,
        body: "someone else's newer body",
      } as never,
    };
  };

  try {
    const result = await executeTool("notes_update_page", {
      notebook_id: "nb-1",
      page_id: "pg-1",
      body: "my overwrite",
    });
    assert.equal(
      updateCallCount,
      1,
      `a stale update must trigger exactly 1 gateway call (no retry), got ${updateCallCount}`,
    );
    assert.ok(
      result.startsWith("error:") && result.includes("stale"),
      `stale update should surface the conflict as an error string, got: ${result}`,
    );
    assert.ok(
      result.includes("someone else's newer body"),
      "the conflict should carry the CURRENT server page so the model sees what it would have clobbered",
    );
  } finally {
    gateway.getPage = originalGetPage;
    gateway.updatePage = originalUpdatePage;
  }
});

// ---- Task Master Hub tools -------------------------------------------------

const TASKMASTER_READ_TOOLS = [
  "taskmaster_list_projects",
  "taskmaster_list",
  "taskmaster_show",
  "taskmaster_next",
];
const TASKMASTER_ROUTINE_WRITE_TOOLS = [
  "taskmaster_set_status",
  "taskmaster_add_dependency",
];
const TASKMASTER_ONE_TIME_WRITE_TOOLS = [
  "taskmaster_add_task",
  "taskmaster_update_task",
  "taskmaster_expand",
];
const TASKMASTER_TOOLS = [
  ...TASKMASTER_READ_TOOLS,
  ...TASKMASTER_ROUTINE_WRITE_TOOLS,
  ...TASKMASTER_ONE_TIME_WRITE_TOOLS,
];

test("all 9 Task Master Hub tools are exposed", () => {
  const names = toolNames();
  for (const t of TASKMASTER_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("every Task Master Hub tool has a closed parameters schema", () => {
  for (const name of TASKMASTER_TOOLS) {
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

test("Task Master Hub reads are auto (NOT write tools)", () => {
  for (const t of TASKMASTER_READ_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), false, `${t} should NOT be a WRITE tool`);
    assert.equal(ONE_TIME_TOOLS.has(t), false, `${t} should NOT be one-time`);
  }
});

test("taskmaster_set_status and taskmaster_add_dependency are routine writes (allow-always ok)", () => {
  for (const t of TASKMASTER_ROUTINE_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
    assert.equal(ONE_TIME_TOOLS.has(t), false, `${t} should NOT be one-time`);
  }
});

test("taskmaster_add_task/update_task/expand are AI-mutation tools, coerced one-time (D7)", () => {
  for (const t of TASKMASTER_ONE_TIME_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      true,
      `${t} should be coerced one-time`,
    );
  }
});

test("taskmaster_list requires project_id (no gateway call when missing)", async () => {
  assert.equal(
    await executeTool("taskmaster_list", {}),
    "error: project_id is required",
  );
});

test("taskmaster_add_dependency requires project_id, id and depends_on", async () => {
  assert.equal(
    await executeTool("taskmaster_add_dependency", { project_id: "tmp-1" }),
    "error: project_id, id and depends_on are required",
  );
});

test("taskmaster_add_dependency surfaces dependency cycles distinctly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/auth/login")) {
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "gw_session=test-session" },
      });
    }
    assert.ok(url.endsWith("/dependencies"), `unexpected URL: ${url}`);
    return new Response(
      JSON.stringify({
        error: "would create a circular dependency",
        code: "dependency_cycle",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await executeTool("taskmaster_add_dependency", {
      project_id: "tmp-1",
      id: "3",
      depends_on: "5",
    });
    assert.match(result, /circular dependency/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
