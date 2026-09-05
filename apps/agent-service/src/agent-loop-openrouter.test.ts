/**
 * Exercises the shared streaming/tool-calling loop with OpenRouter selected
 * as the resolved model, proving 1.2/1.3's provider wiring (a plain
 * OpenAI-compatible client + deployment id) behaves like any other provider
 * in `streamOnce`/`handleUserMessage` — the loop never branches on provider
 * identity, only on the opaque `ResolvedModel` it receives. Covers: streamed
 * text deltas, a full tool-call round (tool_use -> tool_result -> a second
 * model turn), and an upstream error surfacing safely (no key/header leak).
 *
 * A local HTTP server stands in for OpenRouter's `/chat/completions` SSE
 * endpoint — the same "set env, then dynamic import" seam every other
 * agent-service test in this repo uses, since config is read at module load.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void;
const queue: Handler[] = [];
const requestsSeen: {
  authorization?: string;
  referer?: string;
  title?: string;
  body: string;
}[] = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requestsSeen.push({
      authorization: req.headers.authorization,
      referer: req.headers["http-referer"] as string | undefined,
      title: req.headers["x-openrouter-title"] as string | undefined,
      body,
    });
    const handler = queue.shift();
    if (!handler) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "test: no handler queued" } }),
      );
      return;
    }
    handler(req, res, body);
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
test.after(() => server.close());

function sseChunk(res: http.ServerResponse, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function streamHandler(chunks: unknown[]): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) sseChunk(res, c);
    res.write("data: [DONE]\n\n");
    res.end();
  };
}

const historyDir = await mkdtemp(join(tmpdir(), "agent-loop-openrouter-"));

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OPENROUTER_MODEL = "openai/test-model";
process.env.OPENROUTER_HTTP_REFERER = "https://terminal.example";
process.env.OPENROUTER_APP_TITLE = "Terminal Test";
process.env.AGENT_HISTORY_DIR = historyDir;
// Deterministically unreachable — a real gateway must never be required for
// this loop-mechanics test; tool execution failing is an expected, handled
// outcome (`executeTool` turns any thrown error into an "error: ..." string).
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

test("OpenRouter turn: streamed text deltas reassemble into the finished assistant message", async () => {
  queue.push(
    streamHandler([
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { content: ", world." }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]),
  );
  const { loop, frames } = newLoop("chat-openrouter-stream");
  await loop.init();
  await loop.handleUserMessage(
    "hi",
    undefined,
    "openrouter-gpt-latest" as never,
    "medium" as never,
  );

  const deltas = frames
    .filter((f) => f.type === "assistant_delta")
    .map((f) => f.text);
  assert.deepEqual(deltas, ["Hello", ", world."]);
  const finished = frames.find((f) => f.type === "assistant_message");
  assert.equal(finished?.text, "Hello, world.");
  assert.equal(
    frames.some((f) => f.type === "error"),
    false,
  );

  const sent = requestsSeen.at(-1)!;
  assert.equal(sent.authorization, "Bearer test-openrouter-key");
  assert.equal(sent.referer, "https://terminal.example");
  assert.equal(sent.title, "Terminal Test");
  const parsed = JSON.parse(sent.body);
  assert.equal(parsed.model, "openai/test-model");
  assert.equal(parsed.stream, true);
  assert.equal("reasoning_effort" in parsed, false);
});

test("OpenRouter turn: a tool call round-trips (tool_use -> tool_result) into a second model turn", async () => {
  queue.push(
    streamHandler([
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Checking sessions." },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "list_sessions", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]),
  );
  queue.push(
    streamHandler([
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Done." },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]),
  );

  const requestsBefore = requestsSeen.length;
  const { loop, frames } = newLoop("chat-openrouter-tool");
  await loop.init();
  await loop.handleUserMessage(
    "list my sessions",
    undefined,
    "openrouter-gpt-latest" as never,
    "medium" as never,
  );

  const toolUse = frames.find((f) => f.type === "tool_use");
  assert.equal(toolUse?.tool, "list_sessions");
  assert.equal(toolUse?.callId, "call_1");
  const toolResult = frames.find((f) => f.type === "tool_result");
  assert.equal(toolResult?.callId, "call_1");
  // list_sessions is a read (not a WRITE_TOOL) — it must run without any
  // approval_request frame, regardless of the provider selected.
  assert.equal(
    frames.some((f) => f.type === "approval_request"),
    false,
  );

  const finalMessage = frames
    .filter((f) => f.type === "assistant_message")
    .at(-1);
  assert.equal(finalMessage?.text, "Done.");
  const madeThisTurn = requestsSeen.slice(requestsBefore);
  assert.equal(madeThisTurn.length, 2);
  // The second request's messages array must carry the tool's own result
  // back to the model (role: "tool"), proving the follow-up turn used it.
  const secondBody = JSON.parse(madeThisTurn[1]!.body);
  const toolMsg = secondBody.messages.find(
    (m: { role: string }) => m.role === "tool",
  );
  assert.equal(toolMsg?.tool_call_id, "call_1");
});

test("OpenRouter turn: an upstream error surfaces as a safe error frame (no secret leakage)", async () => {
  queue.push((_req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rate limited, slow down" } }));
  });

  const { loop, frames } = newLoop("chat-openrouter-error");
  await loop.init();
  await loop.handleUserMessage(
    "hi",
    undefined,
    "openrouter-gpt-latest" as never,
    "medium" as never,
  );

  const error = frames.find((f) => f.type === "error");
  assert.ok(error, "expected an error frame");
  const message = String(error!.message);
  assert.doesNotMatch(message, /test-openrouter-key/);
  assert.doesNotMatch(message, /Bearer/);
  assert.equal(
    frames.some((f) => f.type === "assistant_message"),
    false,
  );
});
