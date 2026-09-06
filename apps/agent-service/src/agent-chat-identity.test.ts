import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.AGENT_CHAT_ROLE = "BE";
process.env.AGENT_CHAT_NAME = "backend agent";
process.env.AGENT_CHAT_TOOL = "Codex CLI";

const { config } = await import("./config.js");

test("AGENT_CHAT_* env overrides produce the configured identity", () => {
  assert.equal(config.agentChat.identityRole, "BE");
  assert.equal(config.agentChat.identityName, "backend agent");
  assert.equal(config.agentChat.identityTool, "Codex CLI");
});
