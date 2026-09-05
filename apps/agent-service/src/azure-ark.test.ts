import assert from "node:assert/strict";
import test from "node:test";

// ARK_API_KEY set: the BytePlus models are offered and resolve to the Ark
// branch (Bearer client, no reasoning_effort; `thinking` disabled for DeepSeek,
// absent for GLM). Deployment ids come from the env defaults.
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.ARK_API_KEY = "test-ark-key";
delete process.env.ARK_BASE_URL;
delete process.env.ARK_DEEPSEEK_DEPLOYMENT;
delete process.env.ARK_DEEPSEEK_V32_DEPLOYMENT;
delete process.env.ARK_GLM_DEPLOYMENT;

const { resolveModel, availableModels, azure } = await import("./azure.js");

test("all three BytePlus models are listed when ARK_API_KEY is set", () => {
  const models = availableModels();
  for (const id of [
    "deepseek-v4-pro-byteplus",
    "deepseek-v32-byteplus",
    "glm-byteplus",
  ] as const) {
    assert.ok(models.includes(id), id);
  }
});

test("DeepSeek V4 Pro resolves to the Ark branch with thinking disabled", async () => {
  const r = await resolveModel("deepseek-v4-pro-byteplus");
  assert.ok(r);
  assert.equal(r.deployment, "deepseek-v4-pro-260425");
  assert.equal(r.supportsReasoningEffort, false);
  assert.deepEqual(r.extraBody, { thinking: { type: "disabled" } });
  assert.notEqual(r.client, azure);
});

test("DeepSeek V3.2 resolves with its own default deployment id", async () => {
  const r = await resolveModel("deepseek-v32-byteplus");
  assert.ok(r);
  assert.equal(r.deployment, "deepseek-v3-2-251201");
  assert.equal(r.supportsReasoningEffort, false);
  assert.deepEqual(r.extraBody, { thinking: { type: "disabled" } });
});

test("GLM resolves to the Ark branch with no extra body", async () => {
  const r = await resolveModel("glm-byteplus");
  assert.ok(r);
  assert.equal(r.deployment, "glm-4-7-251222");
  assert.equal(r.supportsReasoningEffort, false);
  assert.equal(r.extraBody, undefined);
});

test("Azure models still resolve normally alongside Ark", async () => {
  const r = await resolveModel("gpt-5.6-sol");
  assert.ok(r);
  assert.equal(r.client, azure);
  assert.equal(r.supportsReasoningEffort, true);
});
