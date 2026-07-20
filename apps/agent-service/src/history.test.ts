import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const historyDir = await mkdtemp(join(tmpdir(), "sparklab-agent-history-"));
process.env.AGENT_HISTORY_DIR = historyDir;
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const { appendMessages, deleteChat, listChats, openChat } =
  await import("./history.js");

test.after(async () => {
  await rm(historyDir, { recursive: true });
  delete process.env.AGENT_HISTORY_DIR;
});

test("resolves the latest chat independently for each terminal", async () => {
  const firstA = await openChat("local/web-a");
  await appendMessages(firstA, [{ role: "user", content: "first A" }]);
  assert.equal(await openChat("local/web-a"), firstA);

  const secondA = await openChat("local/web-a", undefined, true);
  await appendMessages(secondA, [{ role: "user", content: "second A" }]);
  assert.notEqual(secondA, firstA);
  assert.equal(await openChat("local/web-a"), secondA);

  const firstB = await openChat("local/web-b");
  await appendMessages(firstB, [{ role: "user", content: "first B" }]);
  assert.notEqual(firstB, firstA);
  assert.notEqual(firstB, secondA);

  const chatsA = await listChats("local/web-a");
  assert.deepEqual(
    new Set(chatsA.map((chat) => chat.id)),
    new Set([firstA, secondA]),
  );
  assert.ok(chatsA.every((chat) => chat.terminalSessionId === "local/web-a"));
  assert.deepEqual(
    (await listChats("local/web-b")).map((chat) => chat.id),
    [firstB],
  );
});

test("does not relink a chat to another terminal", async () => {
  const chatId = await openChat("local/web-owner", undefined, true);
  await assert.rejects(
    openChat("local/web-other", chatId),
    /different terminal session/,
  );
  await assert.rejects(
    deleteChat(chatId, "local/web-other"),
    /different terminal session/,
  );
});

test("deleting a chat removes both history and its terminal link", async () => {
  const chatId = await openChat("local/web-delete", undefined, true);
  await appendMessages(chatId, [{ role: "user", content: "remove me" }]);
  await deleteChat(chatId);
  assert.deepEqual(await listChats("local/web-delete"), []);
  assert.notEqual(await openChat("local/web-delete"), chatId);
});
