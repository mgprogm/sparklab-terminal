import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runDir = await mkdtemp(join(tmpdir(), "sparklab-agent-runs-"));
process.env.AGENT_RUN_DIR = runDir;

const {
  appendRunEvent,
  listRunStates,
  newRunState,
  recoverInterruptedRuns,
  unfinishedAssistantText,
  writeRunState,
} = await import("./agent-run-store.js");

test.after(async () => {
  await rm(runDir, { recursive: true });
  delete process.env.AGENT_RUN_DIR;
});

test("atomically persists a run and marks active work interrupted on recovery", async () => {
  const state = newRunState("chat-a", "local/web-a", "alice");
  state.lifecycle = "awaiting_approval";
  state.lastSeq = 2;
  await writeRunState(state);
  await appendRunEvent(state.id, {
    seq: 2,
    at: Date.now(),
    kind: "approval_requested",
  });

  const recovered = await recoverInterruptedRuns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, state.id);
  assert.equal(recovered[0]?.lifecycle, "interrupted");
  assert.equal(recovered[0]?.lastSeq, 3);

  const stored = await listRunStates();
  assert.equal(stored[0]?.lifecycle, "interrupted");
  assert.equal(stored[0]?.lastSeq, 3);
});

test("leaves terminal run states unchanged during recovery", async () => {
  const state = newRunState("chat-b", "local/web-b", "alice");
  state.lifecycle = "completed";
  await writeRunState(state);
  assert.deepEqual(await recoverInterruptedRuns(), []);
});

test("requires recovery rather than repeating an unfinished tool", async () => {
  const state = newRunState("chat-write", "local/web-write", "alice");
  state.lifecycle = "running";
  await writeRunState(state);
  await appendRunEvent(state.id, {
    seq: 1,
    at: Date.now(),
    kind: "frame",
    payload: { type: "tool_use", callId: "call-write" },
  });
  const recovered = await recoverInterruptedRuns();
  const result = recovered.find((candidate) => candidate.id === state.id);
  assert.equal(result?.lifecycle, "recovery_required");
});

test("recovers only the unfinished assistant text from a journal", async () => {
  const state = newRunState("chat-c", "local/web-c", "alice");
  await writeRunState(state);
  await appendRunEvent(state.id, {
    seq: 1,
    at: Date.now(),
    kind: "frame",
    payload: { type: "assistant_delta", text: "old" },
  });
  await appendRunEvent(state.id, {
    seq: 2,
    at: Date.now(),
    kind: "frame",
    payload: { type: "assistant_message", text: "old" },
  });
  await appendRunEvent(state.id, {
    seq: 3,
    at: Date.now(),
    kind: "frame",
    payload: { type: "assistant_delta", text: "new" },
  });
  assert.equal(await unfinishedAssistantText(state.id), "new");
});
