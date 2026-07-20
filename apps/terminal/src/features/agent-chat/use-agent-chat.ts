"use client";

/**
 * Owns the app's one live AgentConnection. It connects lazily when the panel
 * first opens and stays live while the panel is closed, but is replaced when
 * the focused terminal changes so each terminal gets its own conversation.
 *
 * Every socket carries `terminalSessionId`. The persisted terminal→chat map is
 * a fast client hint; the service resolves the latest linked chat when no id is
 * supplied. Explicit history loads use `resumeChatId`; new chats use `newChat`.
 * A connection generation guard drops late frames from superseded terminals.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { AgentConnection } from "./connection";
import { useAgentStore } from "./store";

import { authKeys } from "@/features/auth";
import { useBrowserViewStore } from "@/features/browser-view";
import { useTerminalStore } from "@/features/terminal/store";

let conn: AgentConnection | null = null;
let connectionGeneration = 0;
let connectionTerminalSessionId: string | null = null;

export function useAgentChat() {
  const queryClient = useQueryClient();
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);

  // Build a fresh connection bound to `resumeChatId`, disposing any prior one.
  const openConnection = useCallback(
    (
      terminalSessionId: string,
      resumeChatId: string | null,
      forceNewChat = false,
    ) => {
      const generation = ++connectionGeneration;
      conn?.dispose();
      useAgentStore.getState().setConnected(false);
      connectionTerminalSessionId = terminalSessionId;
      const ingest = useAgentStore.getState().ingest;
      const ingestBrowser = useBrowserViewStore.getState().ingest;
      const setConnected = useAgentStore.getState().setConnected;
      conn = new AgentConnection(
        {
          onFrame: (frame) => {
            if (generation !== connectionGeneration) return;
            if (
              frame.type === "browser_view" ||
              frame.type === "browser_closed"
            ) {
              ingestBrowser(frame);
              return;
            }
            ingest(frame);
          },
          onConnected: (connected) => {
            if (generation === connectionGeneration) setConnected(connected);
          },
          onAuthError: () => {
            if (generation !== connectionGeneration) return;
            void queryClient.invalidateQueries({ queryKey: authKeys.me() });
          },
        },
        terminalSessionId,
        resumeChatId,
        forceNewChat,
      );
      conn.connect();
    },
    [queryClient],
  );

  useEffect(() => {
    if (!activeSessionId) {
      if (conn) {
        ++connectionGeneration;
        conn.dispose();
        conn = null;
        connectionTerminalSessionId = null;
        useAgentStore.getState().setConnected(false);
      }
      useBrowserViewStore.getState().clear();
      useAgentStore.getState().beginTerminalSwitch(null);
      return;
    }
    if (!panelOpen && !conn) return;
    if (connectionTerminalSessionId === activeSessionId && conn) return;

    const state = useAgentStore.getState();
    const resumeChatId =
      state.chatIdsByTerminal[activeSessionId] ?? state.legacyChatId;
    useBrowserViewStore.getState().clear();
    state.beginTerminalSwitch(activeSessionId, resumeChatId);
    openConnection(activeSessionId, resumeChatId ?? null);
  }, [activeSessionId, panelOpen, openConnection]);

  const sendUserMessage = useCallback((text: string, sessionId?: string) => {
    conn?.sendUserMessage(text, sessionId);
  }, []);

  const sendApproval = useCallback(
    (
      requestId: string,
      behavior: Parameters<AgentConnection["sendApproval"]>[1],
    ) => {
      conn?.sendApproval(requestId, behavior);
    },
    [],
  );

  const interrupt = useCallback(() => {
    conn?.interrupt();
  }, []);

  const listChats = useCallback(() => {
    // chat_list clears this flag when the response arrives; until then the
    // history modal shows a loading row instead of "no conversations".
    useAgentStore.setState({ chats: [], chatsLoading: true });
    if (activeSessionId) conn?.listChats();
  }, [activeSessionId]);

  /** Start a fresh chat (old one stays in history). */
  const newChat = useCallback(() => {
    if (!activeSessionId) return;
    useBrowserViewStore.getState().clear();
    useAgentStore.getState().beginTerminalSwitch(activeSessionId);
    openConnection(activeSessionId, null, true);
  }, [activeSessionId, openConnection]);

  /** Resume a past chat; its transcript arrives via `chat_history`. */
  const loadChat = useCallback(
    (chatId: string) => {
      if (!activeSessionId) return;
      if (chatId === useAgentStore.getState().chatId) return;
      useBrowserViewStore.getState().clear();
      // Clear now; chat_history will replace with the reconstructed transcript.
      // loadingChat keeps the panel on "Loading chat…" (not the new-chat empty
      // state) until that replay arrives.
      useAgentStore.getState().beginTerminalSwitch(activeSessionId, chatId);
      openConnection(activeSessionId, chatId);
    },
    [activeSessionId, openConnection],
  );

  /** Delete a past chat. If it's the active one, drop to a fresh chat. */
  const deleteChat = useCallback(
    (chatId: string) => {
      // Delete on the currently-open socket first (guaranteed to send), then,
      // if we just deleted the active chat, reconnect to a fresh one. Remove
      // the row optimistically — the frame is fire-and-forget, so waiting for
      // the next list_chats would leave a stale row (and allow double-clicks).
      conn?.deleteChat(chatId);
      useAgentStore.setState((s) => ({
        chats: s.chats.filter((c) => c.id !== chatId),
        chatIdsByTerminal: Object.fromEntries(
          Object.entries(s.chatIdsByTerminal).filter(
            ([, mappedChatId]) => mappedChatId !== chatId,
          ),
        ),
      }));
      if (chatId === useAgentStore.getState().chatId) newChat();
    },
    [newChat],
  );

  return {
    sendUserMessage,
    sendApproval,
    interrupt,
    listChats,
    newChat,
    loadChat,
    deleteChat,
  };
}
