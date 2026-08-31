import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const {
  sanitizePersistedToolArgs,
  sanitizePersistedToolResult,
  parseComputerAction,
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
