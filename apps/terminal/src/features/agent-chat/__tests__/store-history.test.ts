/**
 * @vitest-environment node
 *
 * Store tests for the agent-chat history reducers: the `chat_list` and
 * `chat_history` server frames. The load-bearing property is that
 * `chat_history` REPLACES the transcript (never appends) — it fires on explicit
 * loads, page reloads, AND every transient reconnect, so appending would
 * duplicate the whole conversation on a flaky link.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAgentStore } from "../store";

import type {
  AgentChatSummary,
  AgentReplayEntry,
} from "@sparklab/shared-types";

function reset() {
  useAgentStore.setState({
    chatId: null,
    terminalSessionId: null,
    chatIdsByTerminal: {},
    legacyChatId: null,
    entries: [],
    chats: [],
    unreadCount: 0,
    status: "idle",
    agentActiveSessionIds: [],
    _writeActive: {},
  });
}

describe("agent-chat store — history", () => {
  beforeEach(reset);
  afterEach(reset);

  it("chat_list populates the chats list", () => {
    const chats: AgentChatSummary[] = [
      {
        id: "a",
        title: "First",
        updatedAt: 2,
        messageCount: 4,
        terminalSessionId: "local/web-a",
      },
      {
        id: "b",
        title: "Second",
        updatedAt: 1,
        messageCount: 2,
        terminalSessionId: "local/web-a",
      },
    ];
    useAgentStore.getState().ingest({ type: "chat_list", chats });
    expect(useAgentStore.getState().chats).toEqual(chats);
  });

  it("records the latest chat independently for each terminal", () => {
    useAgentStore.getState().ingest({
      type: "chat_started",
      chatId: "chat-a",
      terminalSessionId: "local/web-a",
    });
    useAgentStore.getState().ingest({
      type: "chat_started",
      chatId: "chat-b",
      terminalSessionId: "local/web-b",
    });
    expect(useAgentStore.getState().chatIdsByTerminal).toEqual({
      "local/web-a": "chat-a",
      "local/web-b": "chat-b",
    });
  });

  it("clears the old transcript while switching terminals", () => {
    useAgentStore.setState({
      entries: [{ kind: "user", id: "old", text: "terminal A" }],
      pinnedTargetId: "local/web-a",
    });
    useAgentStore.getState().beginTerminalSwitch("local/web-b", "chat-b");
    expect(useAgentStore.getState()).toMatchObject({
      terminalSessionId: "local/web-b",
      chatId: "chat-b",
      entries: [],
      loadingChat: true,
      pinnedTargetId: null,
    });
  });

  it("chat_history REPLACES entries (does not append) and sets chatId", () => {
    // Seed a stale transcript, as if from a previous connection.
    useAgentStore.setState({
      entries: [{ kind: "user", id: "stale", text: "old" }],
      unreadCount: 3,
    });

    const entries: AgentReplayEntry[] = [
      { kind: "user", id: "h0", text: "hi" },
      { kind: "assistant", id: "h1", text: "hello" },
    ];
    useAgentStore
      .getState()
      .ingest({ type: "chat_history", chatId: "c1", entries });

    const s = useAgentStore.getState();
    expect(s.chatId).toBe("c1");
    expect(s.entries).toHaveLength(2); // replaced, not 3
    expect(s.entries[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(s.unreadCount).toBe(0);
  });

  it("replaying the same chat_history twice does not duplicate (reconnect resync)", () => {
    const entries: AgentReplayEntry[] = [
      { kind: "user", id: "h0", text: "q" },
      { kind: "assistant", id: "h1", text: "a" },
    ];
    const frame = { type: "chat_history", chatId: "c1", entries } as const;
    useAgentStore.getState().ingest(frame);
    useAgentStore.getState().ingest(frame);
    expect(useAgentStore.getState().entries).toHaveLength(2);
  });

  it("maps a failed tool replay entry to an error-state tool row", () => {
    const entries: AgentReplayEntry[] = [
      {
        kind: "tool",
        id: "h0",
        tool: "run_command",
        sessionId: "web-x",
        summary: "run: ls",
        input: { command: "ls" },
        ok: false,
        resultSummary: "denied by user",
      },
    ];
    useAgentStore
      .getState()
      .ingest({ type: "chat_history", chatId: "c1", entries });
    const e = useAgentStore.getState().entries[0];
    expect(e).toMatchObject({
      kind: "tool",
      state: "error",
      resultSummary: "denied by user",
    });
  });

  it("keeps an unfinished replayed tool in the running state", () => {
    const entries: AgentReplayEntry[] = [
      {
        kind: "tool",
        id: "h0",
        tool: "run_command",
        summary: "run: ls",
        input: { command: "ls" },
      },
    ];
    useAgentStore
      .getState()
      .ingest({ type: "chat_history", chatId: "c1", entries });
    expect(useAgentStore.getState().entries[0]).toMatchObject({
      kind: "tool",
      state: "running",
    });
  });

  it("merges a queued live tool call into its replayed tool row", () => {
    useAgentStore.getState().ingest({
      type: "chat_history",
      chatId: "c1",
      entries: [
        {
          kind: "tool",
          id: "call-stable",
          tool: "list_sessions",
          summary: "list sessions",
          input: {},
        },
      ],
    });
    useAgentStore.getState().ingest({
      type: "tool_use",
      callId: "call-stable",
      tool: "list_sessions",
      summary: "list sessions",
      input: {},
    });
    expect(useAgentStore.getState().entries).toHaveLength(1);
    expect(useAgentStore.getState().entries[0]).toMatchObject({
      id: "call-stable",
      state: "running",
    });
  });

  it("resolves a replayed approval when another tab answers it", () => {
    useAgentStore.getState().ingest({
      type: "approval_request",
      requestId: "approval-stable",
      tool: "run_codex",
      summary: "run Codex",
      input: {},
    });
    useAgentStore.getState().ingest({
      type: "approval_resolved",
      requestId: "approval-stable",
      behavior: "allow",
    });
    expect(useAgentStore.getState().entries[0]).toMatchObject({
      kind: "approval",
      state: "allow",
    });
  });

  it("requires recovery verification and resolves it for every connected tab", () => {
    useAgentStore.getState().ingest({
      type: "recovery_required",
      message: "Verify the external state before continuing.",
    });
    expect(useAgentStore.getState().entries[0]).toMatchObject({
      kind: "recovery",
      state: "pending",
    });
    useAgentStore.getState().ingest({
      type: "recovery_resolved",
      behavior: "verified",
    });
    expect(useAgentStore.getState().entries[0]).toMatchObject({
      kind: "recovery",
      state: "verified",
    });
  });

  it("resetForNewChat clears chatId and transcript", () => {
    useAgentStore.setState({
      chatId: "c1",
      entries: [{ kind: "user", id: "x", text: "hi" }],
    });
    useAgentStore.getState().resetForNewChat();
    const s = useAgentStore.getState();
    expect(s.chatId).toBeNull();
    expect(s.entries).toHaveLength(0);
  });
});
