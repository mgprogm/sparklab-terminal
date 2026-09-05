import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_MODEL = "openai/test-model";
process.env.OPENROUTER_HTTP_REFERER = "https://terminal.example";
process.env.OPENROUTER_APP_TITLE = "Terminal Test";

const { availableModels, resolveModel } = await import("./azure.js");

test("OpenRouter is opt-in and resolves only its allowlisted public model", async () => {
  assert.ok(availableModels().includes("openrouter-gpt-latest"));
  // No openrouterModelId given: unchanged fixed-default behavior, no catalog
  // fetch attempted (this test sets no OPENROUTER_BASE_URL mock server).
  const resolved = await resolveModel("openrouter-gpt-latest");
  assert.ok(resolved);
  assert.equal(resolved.deployment, "openai/test-model");
  assert.equal(resolved.supportsReasoningEffort, false);
  assert.equal(resolved.extraBody, undefined);
  assert.equal(resolved.mandatoryReasoningFallback, undefined);
});
