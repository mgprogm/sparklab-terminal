/**
 * Covers resolveModel's second, catalog-backed argument (openrouterModelId):
 * a valid id resolves to that exact upstream deployment; an unknown id never
 * reaches OpenRouter at all (resolves undefined, same as any unconfigured
 * model); a model with mandatory reasoning surfaces a fallback effort.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      data: [
        {
          id: "openai/gpt-6-astra",
          name: "OpenAI: GPT-6 Astra",
          context_length: 1_050_000,
          pricing: { prompt: "0.00001", completion: "0.00005" },
          reasoning: {
            supported_efforts: ["max", "xhigh", "high", "medium", "low"],
            mandatory: true,
            default_effort: "medium",
          },
        },
        {
          id: "z-ai/glm-5.2:free",
          name: "GLM 5.2 (free)",
          context_length: 128_000,
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    }),
  );
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
test.after(() => server.close());

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OPENROUTER_MODEL = "openai/test-model";
process.env.OPENROUTER_CATALOG_TTL_MS = "60000";

const { resolveModel } = await import("./azure.js");

test("a catalog id present in the fetched catalog resolves to that exact deployment", async () => {
  const r = await resolveModel("openrouter-gpt-latest", "z-ai/glm-5.2:free");
  assert.ok(r);
  assert.equal(r.deployment, "z-ai/glm-5.2:free");
  assert.equal(r.supportsReasoningEffort, false); // no `reasoning` block for this model
  assert.equal(r.mandatoryReasoningFallback, undefined);
});

test("a catalog id NOT present in the fetched catalog resolves undefined (never forwarded upstream)", async () => {
  const r = await resolveModel("openrouter-gpt-latest", "no/such-model");
  assert.equal(r, undefined);
});

test("a model with mandatory reasoning carries its default_effort as the fallback", async () => {
  const r = await resolveModel("openrouter-gpt-latest", "openai/gpt-6-astra");
  assert.ok(r);
  assert.equal(r.deployment, "openai/gpt-6-astra");
  assert.equal(r.supportsReasoningEffort, true);
  // The catalog's own recommended default, NOT supportedEfforts[0] ("max").
  assert.equal(r.mandatoryReasoningFallback, "medium");
});
