import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

let response: { status: number; body: unknown } = {
  status: 200,
  body: { data: [] },
};
let requestCount = 0;

const server = http.createServer((_req, res) => {
  requestCount++;
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(JSON.stringify(response.body));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
test.after(() => server.close());

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
// Short TTL so the expiry tests below don't need a real 10-minute wait.
process.env.OPENROUTER_CATALOG_TTL_MS = "50";

const { getOpenRouterCatalog } = await import("./openrouter-catalog.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("fetches and reduces the catalog: filters unknown efforts, drops malformed entries", async () => {
  response = {
    status: 200,
    body: {
      data: [
        {
          id: "openai/gpt-6-astra",
          name: "OpenAI: GPT-6 Astra",
          context_length: 1_050_000,
          pricing: { prompt: "0.00001", completion: "0.00005" },
          // "bogus" isn't in AgentReasoningEffortSchema and must be dropped.
          reasoning: {
            supported_efforts: ["low", "medium", "bogus"],
            mandatory: true,
          },
        },
        {
          id: "z-ai/glm-5.2:free",
          name: "GLM 5.2 (free)",
          context_length: 128_000,
          pricing: { prompt: "0", completion: "0" },
          // No reasoning block at all.
        },
        {
          // Missing required `id` — must be skipped, not crash the whole fetch.
          name: "malformed entry",
          context_length: 1,
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    },
  };
  requestCount = 0;

  const { models } = await getOpenRouterCatalog();

  assert.equal(requestCount, 1);
  assert.equal(models.length, 2);
  const astra = models.find((m) => m.id === "openai/gpt-6-astra");
  assert.deepEqual(astra?.reasoning, {
    supportedEfforts: ["low", "medium"],
    mandatory: true,
  });
  const glm = models.find((m) => m.id === "z-ai/glm-5.2:free");
  assert.equal(glm?.reasoning, undefined);
});

test("serves the cached list within the TTL without refetching", async () => {
  requestCount = 0;
  const { models } = await getOpenRouterCatalog();
  assert.equal(requestCount, 0);
  assert.equal(models.length, 2);
});

test("refetches once the TTL has expired", async () => {
  await sleep(80); // > OPENROUTER_CATALOG_TTL_MS (50ms)
  response = {
    status: 200,
    body: {
      data: [
        {
          id: "only/one-model-now",
          name: "Only One Model Now",
          context_length: 8192,
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    },
  };
  requestCount = 0;

  const { models } = await getOpenRouterCatalog();

  assert.equal(requestCount, 1);
  assert.deepEqual(
    models.map((m) => m.id),
    ["only/one-model-now"],
  );
});

test("serves the last-known-good cache when a refetch fails", async () => {
  await sleep(80);
  response = { status: 500, body: { error: "upstream down" } };
  requestCount = 0;

  const { models } = await getOpenRouterCatalog();

  assert.equal(requestCount, 1); // it DID try
  // ...but the previous (still-valid) list is what came back, not empty/throw.
  assert.deepEqual(
    models.map((m) => m.id),
    ["only/one-model-now"],
  );
});
