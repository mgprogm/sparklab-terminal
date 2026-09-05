import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
delete process.env.OPENROUTER_API_KEY;
// A host nothing listens on: if getOpenRouterCatalog() ever attempted a real
// fetch here despite the key being unset, this test would hang/timeout
// instead of resolving near-instantly.
process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:1";

const { getOpenRouterCatalog } = await import("./openrouter-catalog.js");

test("returns an empty catalog immediately, with no fetch attempt, when OPENROUTER_API_KEY is unset", async () => {
  const startedAt = Date.now();
  const { models, fetchedAt } = await getOpenRouterCatalog();
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(models, []);
  assert.ok(
    elapsedMs < 200,
    `expected a near-instant return, took ${elapsedMs}ms`,
  );
  assert.ok(fetchedAt >= startedAt);
});
