import assert from "node:assert/strict";
import test from "node:test";

// No ARK_API_KEY here (the default state): no BytePlus model appears or
// resolves. See azure-ark.test.ts for the configured branch — Node's test
// runner isolates each file in its own process, so the two env states never
// collide.
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
delete process.env.GPT56TERRA_DEPLOYMENT;
delete process.env.GPT56LUNA_DEPLOYMENT;
delete process.env.ARK_API_KEY;
delete process.env.CODEX_PROVIDER_ENABLED;

const { resolveModel, availableModels } = await import("./azure.js");

test("BytePlus models are hidden and unresolvable without ARK_API_KEY", () => {
  for (const id of [
    "deepseek-v4-pro-byteplus",
    "deepseek-v32-byteplus",
    "glm-byteplus",
  ] as const) {
    assert.equal(resolveModel(id), undefined, id);
    assert.ok(!availableModels().includes(id), id);
  }
});

test("a configured Azure deployment resolves to the azure branch", () => {
  const resolved = resolveModel("gpt-5.6-sol");
  assert.ok(resolved);
  assert.equal(resolved.deployment, "test-deployment");
  assert.equal(resolved.supportsReasoningEffort, true);
  assert.equal(resolved.extraBody, undefined);
  assert.ok(availableModels().includes("gpt-5.6-sol"));
});

test("an unconfigured Azure deployment does not resolve", () => {
  assert.equal(resolveModel("gpt-5.6-luna"), undefined);
  assert.ok(!availableModels().includes("gpt-5.6-luna"));
});

test("codex-cli is hidden without CODEX_PROVIDER_ENABLED", () => {
  assert.ok(!availableModels().includes("codex-cli"));
});
