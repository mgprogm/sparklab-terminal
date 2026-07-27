import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentStore } from "../store";
import { useAgentChat } from "../use-agent-chat";

import type { BrowserHandoffControlFrame } from "@/features/browser-handoff";
import type { AgentWsServerMessage } from "@sparklab/shared-types";
import type { PropsWithChildren } from "react";

import { useBrowserHandoffStore } from "@/features/browser-handoff";
import { useBrowserViewStore } from "@/features/browser-view";
import { useTerminalStore } from "@/features/terminal/store";

const connectionMocks = vi.hoisted(() => {
  type Callbacks = {
    onFrame: (frame: AgentWsServerMessage) => void;
    onHandoffFrame?: (frame: BrowserHandoffControlFrame) => void;
    onConnected: (connected: boolean) => void;
  };
  class MockAgentConnection {
    static instances: MockAgentConnection[] = [];
    disposed = false;

    constructor(
      readonly callbacks: Callbacks,
      readonly terminalSessionId: string,
      readonly resumeChatId: string | null,
      readonly forceNewChat: boolean,
    ) {
      MockAgentConnection.instances.push(this);
    }

    connect() {}
    dispose() {
      this.disposed = true;
    }
    sendUserMessage() {}
    sendApproval() {}
    interrupt() {}
    listChats() {}
    deleteChat() {}
  }
  return { MockAgentConnection };
});

vi.mock("../connection", () => ({
  AgentConnection: connectionMocks.MockAgentConnection,
}));

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("useAgentChat terminal switching", () => {
  beforeEach(() => {
    connectionMocks.MockAgentConnection.instances.length = 0;
    useTerminalStore.setState({ activeSessionId: "local/web-a" });
    useAgentStore.setState({
      panelOpen: true,
      connected: false,
      chatId: null,
      terminalSessionId: null,
      chatIdsByTerminal: {},
      legacyChatId: null,
      entries: [],
    });
    useBrowserViewStore.getState().clear();
    useBrowserHandoffStore.getState().clear();
  });

  afterEach(() => {
    act(() => useTerminalStore.setState({ activeSessionId: null }));
  });

  it("opens one chat per terminal and ignores a late frame from the old socket", () => {
    renderHook(() => useAgentChat(), { wrapper });
    const first = connectionMocks.MockAgentConnection.instances[0]!;
    expect(first.terminalSessionId).toBe("local/web-a");
    expect(first.resumeChatId).toBeNull();

    act(() => useTerminalStore.setState({ activeSessionId: "local/web-b" }));
    const second = connectionMocks.MockAgentConnection.instances[1]!;
    expect(first.disposed).toBe(true);
    expect(second.terminalSessionId).toBe("local/web-b");
    expect(useAgentStore.getState().entries).toEqual([]);

    act(() => {
      first.callbacks.onFrame({
        type: "chat_started",
        chatId: "chat-a-late",
        terminalSessionId: "local/web-a",
      });
    });
    expect(useAgentStore.getState().chatId).toBeNull();

    act(() => {
      second.callbacks.onFrame({
        type: "chat_started",
        chatId: "chat-b",
        terminalSessionId: "local/web-b",
      });
    });
    expect(useAgentStore.getState().chatIdsByTerminal).toEqual({
      "local/web-b": "chat-b",
    });
  });

  it("reopens a hidden browser view when the active handoff is republished", () => {
    renderHook(() => useAgentChat(), { wrapper });
    const connection = connectionMocks.MockAgentConnection.instances[0]!;
    act(() => {
      useBrowserViewStore.getState().ingest({
        type: "browser_view",
        browserId: "browser-1",
        revision: 1,
        url: "https://example.com/login",
        title: "Sign in",
        viewport: { width: 1280, height: 720 },
        screenshot: { mediaType: "image/png", data: "AA==" },
      });
      useBrowserViewStore.getState().hide();
      connection.callbacks.onHandoffFrame?.({
        type: "browser_handoff_state",
        browserId: "browser-1",
        handoffId: "handoff-1",
        state: "human_active",
        expiresAt: Date.now() + 60_000,
      });
    });

    expect(useBrowserViewStore.getState().visible).toBe(true);
    expect(useBrowserHandoffStore.getState().handoffId).toBe("handoff-1");
  });
});
