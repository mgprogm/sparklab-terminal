import assert from "node:assert/strict";
import test from "node:test";

// CODEX_PROVIDER_ENABLED=true: the "Codex CLI" entry is offered by
// availableModels(), but it is NOT a chat-completions model — resolveModel()
// still returns undefined for it (the agent loop branches to the gateway-Codex
// path before ever calling resolveModel). Node's test runner isolates each file
// in its own process, so this env state never collides with azure.test.ts.
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.CODEX_PROVIDER_ENABLED = "true";
delete process.env.ARK_API_KEY;

const { resolveModel, availableModels, isCodexCliModel } =
  await import("./azure.js");

test("codex-cli is listed when CODEX_PROVIDER_ENABLED=true", () => {
  assert.ok(availableModels().includes("codex-cli"));
});

test("codex-cli is not a chat-completions model (resolveModel → undefined)", () => {
  assert.equal(resolveModel("codex-cli"), undefined);
});

test("isCodexCliModel discriminates the picker entry", () => {
  assert.equal(isCodexCliModel("codex-cli"), true);
  assert.equal(isCodexCliModel("gpt-5.6-sol"), false);
});
