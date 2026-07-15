"use client";

/**
 * Owns the single AgentConnection for the app. Connects lazily the first time
 * the panel opens, then stays connected for the page's lifetime (so a
 * running turn survives closing the panel). Frames are folded into the store.
 *
 * Switching chats is a reconnect, not a new protocol verb: loading a past chat
 * reopens the socket with `?resumeChatId=` (the service replays its transcript
 * via `chat_history`); starting a new chat reopens with none (the service mints
 * a fresh id). The old chat is always preserved in the service's JSONL.
 */
import { useCallback, useEffect } from "react";
import { authKeys } from "@/features/auth";
import { useQueryClient } from "@tanstack/react-query";
import { AgentConnection } from "./connection";
import { useAgentStore } from "./store";

let conn: AgentConnection | null = null;

export function useAgentChat() {
  const queryClient = useQueryClient();
  const panelOpen = useAgentStore((s) => s.panelOpen);

  // Build a fresh connection bound to `resumeChatId`, disposing any prior one.
  const openConnection = useCallback(
    (resumeChatId: string | null) => {
      conn?.dispose();
      const ingest = useAgentStore.getState().ingest;
      const setConnected = useAgentStore.getState().setConnected;
      conn = new AgentConnection(
        {
          onFrame: ingest,
          onConnected: setConnected,
          onAuthError: () => {
            void queryClient.invalidateQueries({ queryKey: authKeys.me() });
          },
        },
        resumeChatId,
      );
      conn.connect();
    },
    [queryClient],
  );

  useEffect(() => {
    if (!panelOpen || conn) return;
    openConnection(useAgentStore.getState().chatId);
  }, [panelOpen, openConnection]);

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
    useAgentStore.setState({ chatsLoading: true });
    conn?.listChats();
  }, []);

  /** Start a fresh chat (old one stays in history). */
  const newChat = useCallback(() => {
    useAgentStore.getState().resetForNewChat();
    openConnection(null);
  }, [openConnection]);

  /** Resume a past chat; its transcript arrives via `chat_history`. */
  const loadChat = useCallback(
    (chatId: string) => {
      if (chatId === useAgentStore.getState().chatId) return;
      // Clear now; chat_history will replace with the reconstructed transcript.
      // loadingChat keeps the panel on "Loading chat…" (not the new-chat empty
      // state) until that replay arrives.
      useAgentStore.getState().resetForNewChat();
      useAgentStore.setState({ chatId, loadingChat: true });
      openConnection(chatId);
    },
    [openConnection],
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
