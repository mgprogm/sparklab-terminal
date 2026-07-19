import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const { sanitizePersistedToolArgs, sanitizePersistedToolResult } =
  await import("./agent-loop.js");

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
