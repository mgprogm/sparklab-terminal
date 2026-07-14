"use client";

/**
 * Owns the single AgentConnection for the app. Connects lazily the first time
 * the panel opens, then stays connected for the page's lifetime (so a
 * running turn survives closing the panel). Frames are folded into the store.
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

  useEffect(() => {
    if (!panelOpen || conn) return;
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
      useAgentStore.getState().chatId,
    );
    conn.connect();
  }, [panelOpen, queryClient]);

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

  return { sendUserMessage, sendApproval, interrupt };
}
