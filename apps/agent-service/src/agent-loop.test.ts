import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const { BrowserHandoffBroker } = await import("./browser-handoff-broker.js");
const { gateway } = await import("./gateway-client.js");

const {
  sanitizePersistedToolArgs,
  sanitizePersistedToolResult,
  parseComputerAction,
  formatCodexProviderReply,
  describeStreamError,
  resolveExecutionIdentity,
  AgentLoop,
} = await import("./agent-loop.js");

test("browser arguments omit typed secrets and URL tokens from history", () => {
  assert.deepEqual(
    sanitizePersistedToolArgs("browser_act", {
      action: "type",
      index: 7,
      text: "CANARY_TYPED_SECRET",
    }),
    { action: "type", index: 7, text: "[redacted]" },
  );

  const navigate = sanitizePersistedToolArgs("browser_act", {
    action: "navigate",
    url: "https://example.com/path?token=CANARY_URL_SECRET#private",
  });
  assert.equal(navigate.url, "https://example.com/path");
  assert.doesNotMatch(JSON.stringify(navigate), /CANARY/);
});

test("scheduled terminal input omits its durable text payload", () => {
  const sanitized = sanitizePersistedToolArgs("schedule_terminal_input", {
    session_id: "web-one",
    text: "CANARY_DELAYED_COMMAND",
    keys: ["Enter"],
    execute_at: "2026-08-22T22:30:00+07:00",
  });
  assert.equal(sanitized.text, "[scheduled input omitted]");
  assert.doesNotMatch(JSON.stringify(sanitized), /CANARY/);
});

test("browser page state and screenshots never become durable tool results", () => {
  const content = JSON.stringify({
    title: "CANARY_PAGE_SECRET",
    screenshot: "CANARY_BASE64_MARKER",
  });
  assert.equal(
    sanitizePersistedToolResult("browser_observe", content),
    "[browser result omitted from durable history]",
  );
  assert.equal(sanitizePersistedToolResult("read_screen", content), content);
});

test("browser capture results omit saved-file metadata from durable history", () => {
  const content = JSON.stringify({
    saved: true,
    path: "/private/project/capture.png",
    mediaType: "image/png",
  });
  assert.equal(
    sanitizePersistedToolResult("browser_capture", content),
    "[browser result omitted from durable history]",
  );
});

test("computer_act redacts typed text from durable history", () => {
  const sanitized = sanitizePersistedToolArgs("computer_act", {
    kind: "type_text",
    x: 12,
    y: 34,
    text: "CANARY_DESKTOP_SECRET",
  });
  assert.equal(sanitized.text, "[redacted]");
  assert.doesNotMatch(JSON.stringify(sanitized), /CANARY/);
});

test("computer_* results (screenshot + AX tree) never become durable tool results", () => {
  const content = JSON.stringify({
    snapshotId: "drv-1",
    elements: [{ role: "button", name: "CANARY_WINDOW_TITLE" }],
    screenshot: "CANARY_BASE64_MARKER",
  });
  assert.equal(
    sanitizePersistedToolResult("computer_observe", content),
    "[computer result omitted from durable history]",
  );
  assert.equal(
    sanitizePersistedToolResult("computer_act", content),
    "[computer result omitted from durable history]",
  );
});

test("formatCodexProviderReply: status line above Codex output", () => {
  const reply = formatCodexProviderReply({
    mode: "workspace-write",
    cwd: "/srv/app",
    exitCode: 0,
    output: "  patched src/index.ts  \n",
    truncated: false,
    durationMs: 12_340,
  });
  assert.match(reply, /^_Codex CLI · workspace-write · exit 0 · 12\.3s_\n\n/);
  assert.match(reply, /patched src\/index\.ts/);
  assert.doesNotMatch(reply, /truncated/);
});

test("formatCodexProviderReply: null exit, truncation, and empty output", () => {
  const reply = formatCodexProviderReply({
    mode: "read-only",
    cwd: "/srv/app",
    exitCode: null,
    output: "   ",
    truncated: true,
    durationMs: 500,
  });
  assert.match(reply, /exit unknown/);
  assert.match(reply, /output truncated/);
  assert.match(reply, /\(Codex produced no output\.\)/);
});

test("parseComputerAction: element target preferred, x,y fallback, element rejected for press_key/scroll (M3.1)", () => {
  // Element branch wins even when x,y are also present.
  assert.deepEqual(
    parseComputerAction({
      kind: "click",
      element_index: 3,
      snapshot_id: "snap-2",
      x: 10,
      y: 20,
    }),
    { kind: "click", target: { elementIndex: 3, snapshotId: "snap-2" } },
  );
  // type_text takes an element target.
  assert.deepEqual(
    parseComputerAction({
      kind: "type_text",
      element_index: 0,
      snapshot_id: "snap-2",
      text: "hi",
    }),
    {
      kind: "type_text",
      target: { elementIndex: 0, snapshotId: "snap-2" },
      text: "hi",
    },
  );
  // x,y fallback when no element target is supplied.
  assert.deepEqual(parseComputerAction({ kind: "click", x: 5, y: 6 }), {
    kind: "click",
    target: { x: 5, y: 6 },
  });
  // press_key / scroll reject an element target locally, pointing at x,y.
  for (const kind of ["press_key", "scroll"] as const) {
    const out = parseComputerAction({
      kind,
      element_index: 1,
      snapshot_id: "snap-2",
      key: "Return",
      direction: "down",
    });
    assert.equal(typeof out, "string");
    assert.match(out as string, /cannot target an element_index/);
    assert.match(out as string, /screen x,y/);
  }
  // no target at all → error naming both forms.
  assert.match(
    parseComputerAction({ kind: "click" }) as string,
    /element_index \+ snapshot_id.*or screen x \+ y/,
  );
});

test("parseComputerAction: double_click / right_click take element or x,y (M3.2)", () => {
  assert.deepEqual(
    parseComputerAction({
      kind: "double_click",
      element_index: 4,
      snapshot_id: "snap-9",
    }),
    { kind: "double_click", target: { elementIndex: 4, snapshotId: "snap-9" } },
  );
  assert.deepEqual(parseComputerAction({ kind: "right_click", x: 12, y: 34 }), {
    kind: "right_click",
    target: { x: 12, y: 34 },
  });
});

test("parseComputerAction: drag needs integer to_x/to_y and rejects an element target (M3.2)", () => {
  assert.deepEqual(
    parseComputerAction({ kind: "drag", x: 10, y: 20, to_x: 90, to_y: 120 }),
    { kind: "drag", target: { x: 10, y: 20 }, to: { x: 90, y: 120 } },
  );
  // Missing / negative end point.
  assert.match(
    parseComputerAction({ kind: "drag", x: 10, y: 20 }) as string,
    /drag requires integer to_x and to_y/,
  );
  assert.match(
    parseComputerAction({
      kind: "drag",
      x: 10,
      y: 20,
      to_x: -1,
      to_y: 5,
    }) as string,
    /drag requires integer to_x and to_y/,
  );
  // An element target for drag is rejected locally.
  assert.match(
    parseComputerAction({
      kind: "drag",
      element_index: 0,
      snapshot_id: "snap-9",
      to_x: 90,
      to_y: 120,
    }) as string,
    /drag cannot target an element_index/,
  );
});

function makeApiError(
  status: number,
  error?: { message?: string; metadata?: Record<string, unknown> },
): Error {
  const message = error?.message ? `${status} ${error.message}` : `${status}`;
  return Object.assign(new Error(message), { status, error });
}

test("describeStreamError: a 429 with OpenRouter's generic body surfaces the metadata.raw detail instead", () => {
  const err = makeApiError(429, {
    message: "Provider returned error",
    metadata: {
      raw: "upstream rate limit: 20 requests/day exceeded",
      provider_name: "z-ai",
    },
  });
  const msg = describeStreamError(err);
  assert.match(msg, /Rate limited \(429\)/);
  assert.match(msg, /Upstream provider: z-ai\./);
  assert.match(msg, /upstream rate limit: 20 requests\/day exceeded/);
  assert.doesNotMatch(msg, /Provider returned error/);
});

test("describeStreamError: a 429 with a real body message and no metadata surfaces that message", () => {
  const err = makeApiError(429, {
    message: "You have exceeded your current quota",
  });
  const msg = describeStreamError(err);
  assert.match(msg, /Rate limited \(429\)/);
  assert.match(msg, /You have exceeded your current quota/);
});

test("describeStreamError: a 429 with no body at all still gives actionable guidance", () => {
  const err = makeApiError(429);
  const msg = describeStreamError(err);
  assert.match(msg, /Rate limited \(429\) by the model provider\./);
  assert.match(msg, /wait a bit and try again/);
});

test("describeStreamError: a non-429 error passes its message through unchanged", () => {
  const err = makeApiError(500, { message: "internal server error" });
  assert.equal(describeStreamError(err), "500 internal server error");
});

test("describeStreamError: a non-Error value never throws", () => {
  assert.equal(describeStreamError("not an error"), "unexpected agent error");
  assert.equal(describeStreamError(undefined), "unexpected agent error");
});

test("parseComputerAction: hotkey needs a 2-8 key chord and no target (M3.2)", () => {
  assert.deepEqual(
    parseComputerAction({ kind: "hotkey", keys: ["ctrl", "l"] }),
    {
      kind: "hotkey",
      keys: ["ctrl", "l"],
    },
  );
  // A single key is a guaranteed driver rejection — refused at the parse layer.
  assert.match(
    parseComputerAction({ kind: "hotkey", keys: ["Escape"] }) as string,
    /chord of 2 to 8 keys/,
  );
  assert.match(
    parseComputerAction({ kind: "hotkey", keys: [] }) as string,
    /chord of 2 to 8 keys/,
  );
  // Over-long key name.
  assert.match(
    parseComputerAction({
      kind: "hotkey",
      keys: ["ctrl", "x".repeat(20)],
    }) as string,
    /short key name/,
  );
});

test("Agent Chat identity defaults match the hardcoded originals", async () => {
  const { config } = await import("./config.js");
  assert.equal(config.agentChat.identityRole, "Developer");
  assert.equal(config.agentChat.identityName, "Agent Chat");
  assert.equal(config.agentChat.identityTool, "Agent Chat");
});

test("Agent Chat identity config keys are strings", async () => {
  const { config } = await import("./config.js");
  assert.equal(typeof config.agentChat.identityRole, "string");
  assert.equal(typeof config.agentChat.identityName, "string");
  assert.equal(typeof config.agentChat.identityTool, "string");
});

test("per-turn identity overrides the Task Master execution identity", () => {
  assert.deepEqual(
    resolveExecutionIdentity("identity-override", {
      role: "BE",
      name: "backend agent",
      tool: "Codex CLI",
    }),
    {
      id: "chat-identity-override",
      role: "BE",
      name: "backend agent",
      tool: "Codex CLI",
    },
  );
});

test("Task Master execution identity uses config defaults when omitted", async () => {
  const { config } = await import("./config.js");
  assert.deepEqual(resolveExecutionIdentity("identity-default"), {
    id: "chat-identity-default",
    role: config.agentChat.identityRole,
    name: config.agentChat.identityName,
    tool: config.agentChat.identityTool,
  });
});

test("AgentLoop restores an existing Task Master claim during initialization", async () => {
  const chatId = `d2-active-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const claim = { projectId: "p1", taskId: "5" };
  const findActiveClaim = mock.method(
    gateway,
    "findActiveClaim",
    async (agentId: string) => {
      assert.equal(agentId, `chat-${chatId}`);
      return claim;
    },
  );
  try {
    const loop = new AgentLoop(
      () => {},
      chatId,
      "d2-terminal-session",
      new BrowserHandoffBroker(),
      "d2-user",
    );
    await loop.init();
    assert.deepEqual(
      (loop as unknown as { activeTask: unknown }).activeTask,
      claim,
    );
    assert.equal(findActiveClaim.mock.calls.length, 1);
    const execute = (
      loop as unknown as {
        execute: (
          tool: string,
          args: object,
          signal: AbortSignal,
        ) => Promise<string>;
      }
    ).execute;
    assert.equal(
      await execute.call(loop, "type_text", {}, new AbortController().signal),
      "error: session_id and text are required",
    );
  } finally {
    findActiveClaim.mock.restore();
  }
});

test("AgentLoop fails closed when Task Master claim reconstruction returns no claim", async () => {
  const findActiveClaim = mock.method(
    gateway,
    "findActiveClaim",
    async () => null,
  );
  try {
    const loop = new AgentLoop(
      () => {},
      `d2-no-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "d2-terminal-session",
      new BrowserHandoffBroker(),
      "d2-user",
    );
    await loop.init();
    assert.equal((loop as unknown as { activeTask: unknown }).activeTask, null);
    const execute = (
      loop as unknown as {
        execute: (
          tool: string,
          args: object,
          signal: AbortSignal,
        ) => Promise<string>;
      }
    ).execute;
    assert.equal(
      await execute.call(loop, "run_command", {}, new AbortController().signal),
      "error: Task Master preflight required: list/show an actionable task and call taskmaster_claim before implementation tools.",
    );
  } finally {
    findActiveClaim.mock.restore();
  }
});
