/**
 * End-to-end proof (real AgentLoop, real BrowserHandoffBroker, a local mock
 * server standing in for BOTH OpenRouter endpoints) that a turn carrying
 * `openrouterModelId` sends exactly that id as `model` in the outgoing
 * chat-completions request, and that an unknown id never reaches the
 * completions endpoint at all — resolveModel rejects it before any upstream
 * request is made, surfacing the existing "model not configured" error frame.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const completionsRequests: { body: string }[] = [];

const server = http.createServer((req, res) => {
  if (req.url === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "openai/gpt-6-astra",
            name: "OpenAI: GPT-6 Astra",
            context_length: 1_050_000,
            pricing: { prompt: "0.00001", completion: "0.00005" },
          },
          {
            id: "mandatory/reasoner",
            name: "Mandatory Reasoner",
            context_length: 32_000,
            pricing: { prompt: "0", completion: "0" },
            reasoning: {
              supported_efforts: ["high", "medium", "low"],
              mandatory: true,
              default_effort: "medium",
            },
          },
        ],
      }),
    );
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    completionsRequests.push({ body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "ok" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
test.after(() => server.close());

const historyDir = await mkdtemp(
  join(tmpdir(), "agent-loop-openrouter-catalog-"),
);

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OPENROUTER_MODEL = "openai/test-model";
process.env.OPENROUTER_CATALOG_TTL_MS = "60000";
process.env.AGENT_HISTORY_DIR = historyDir;
process.env.GATEWAY_URL = "http://127.0.0.1:1";
delete process.env.CODEX_PROVIDER_ENABLED;

const { AgentLoop } = await import("./agent-loop.js");
const { BrowserHandoffBroker } = await import("./browser-handoff-broker.js");

function newLoop(chatId: string) {
  const frames: Record<string, unknown>[] = [];
  const loop = new AgentLoop(
    (frame) => frames.push(frame as unknown as Record<string, unknown>),
    chatId,
    "web-test-session",
    new BrowserHandoffBroker(),
    "test-user",
  );
  return { loop, frames };
}

test("a turn with a valid openrouterModelId sends that exact id as `model` upstream", async () => {
  const before = completionsRequests.length;
  const { loop, frames } = newLoop("chat-catalog-valid");
  await loop.init();
  await loop.handleUserMessage(
    "hi",
    undefined,
    "openrouter-gpt-latest" as never,
    "medium" as never,
    "openai/gpt-6-astra",
  );

  assert.equal(
    frames.some((f) => f.type === "error"),
    false,
  );
  const made = completionsRequests.slice(before);
  assert.equal(made.length, 1);
  assert.equal(JSON.parse(made[0]!.body).model, "openai/gpt-6-astra");
});

test("a turn with an unknown openrouterModelId never reaches the completions endpoint", async () => {
  const before = completionsRequests.length;
  const { loop, frames } = newLoop("chat-catalog-unknown");
  await loop.init();
  await loop.handleUserMessage(
    "hi",
    undefined,
    "openrouter-gpt-latest" as never,
    "medium" as never,
    "no/such-model",
  );

  assert.equal(completionsRequests.length, before); // zero new requests
  const error = frames.find((f) => f.type === "error");
  assert.match(String(error?.message), /not configured/);
});

test('a mandatory-reasoning model upgrades a requested "none" effort to its default_effort', async () => {
  const before = completionsRequests.length;
  const { loop, frames } = newLoop("chat-catalog-mandatory-reasoning");
  await loop.init();
  await loop.handleUserMessage(
    "hi",
    undefined,
    "openrouter-gpt-latest" as never,
    "none" as never,
    "mandatory/reasoner",
  );

  assert.equal(
    frames.some((f) => f.type === "error"),
    false,
  );
  const made = completionsRequests.slice(before);
  assert.equal(made.length, 1);
  const sent = JSON.parse(made[0]!.body);
  assert.equal(sent.model, "mandatory/reasoner");
  // Upgraded from "none" (this model rejects/ignores it) to the catalog's
  // own recommended default, never sent as literal "none".
  assert.equal(sent.reasoning_effort, "medium");
});
