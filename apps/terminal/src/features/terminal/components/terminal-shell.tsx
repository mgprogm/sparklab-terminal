"use client";

/**
 * TerminalShell — the top-level composition of sidebar + header + terminal.
 *
 * Wires TanStack Query (sessions), Zustand (activeSessionId, sidebar), and the
 * XTerm component together. The XTerm component is never remounted on session
 * switch; switching happens via the `sessionId` prop → the effect inside
 * XTermComponent disposes the old Connection and creates a new one.
 */

import { cn } from "@sparklab/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

import { DynamicXTerm } from "./dynamic-xterm";
import { SessionSidebar } from "./session-sidebar";
import {
  useCreateSession,
  useDeleteSession,
  useSessions,
} from "../hooks/use-sessions";
import { useTerminalStore } from "../store";

import type { ConnectionStatus } from "../connection";

export function TerminalShell() {
  const {
    activeSessionId,
    setActiveSessionId,
    sidebarCollapsed,
    toggleSidebar,
  } = useTerminalStore();

  const { data: sessions = [] } = useSessions();
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();

  const [status, setStatus] = useState<{
    state: ConnectionStatus;
    text: string;
  }>({ state: "disconnected", text: "idle" });

  // Ref to the xterm container for focus restoration.
  const termContainerRef = useRef<HTMLDivElement>(null);

  // ---- "Active session vanished → fall back" ----
  useEffect(() => {
    if (!sessions.length) {
      if (activeSessionId) setActiveSessionId(null);
      return;
    }
    // If the active session is gone, fall back to the first.
    if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(sessions[0]?.id ?? null);
      return;
    }
    // On first load with sessions but nothing selected, attach to the first.
    if (!activeSessionId && sessions.length) {
      setActiveSessionId(sessions[0]?.id ?? null);
    }
  }, [sessions, activeSessionId, setActiveSessionId]);

  // ---- Callbacks ----
  const handleStatusChange = useCallback(
    (state: ConnectionStatus, text: string) => {
      setStatus({ state, text });
    },
    [],
  );

  const handleSessionError = useCallback(() => {
    // Nothing extra — the sessions query will refetch on its 3s interval and
    // the vanish-fallback effect above will route to the next session.
  }, []);

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
    },
    [setActiveSessionId],
  );

  const handleCreateSession = useCallback(
    (name?: string) => {
      createSession.mutate(name, {
        onSuccess: (created) => {
          setActiveSessionId(created.id);
        },
      });
    },
    [createSession, setActiveSessionId],
  );

  const handleDeleteSession = useCallback(
    (id: string) => {
      deleteSession.mutate(id, {
        onSuccess: () => {
          // Don't null activeSessionId here — mirroring the original app.js
          // behavior: leave it set so the vanish-fallback effect sees the id
          // disappear from the refreshed list and routes to the next session
          // (or empty state). Nulling here would cause a brief XTerm remount
          // flash and a frozen terminal on last-delete.
        },
      });
    },
    [deleteSession],
  );

  const handleDialogClose = useCallback(() => {
    // Return focus to the terminal after dialogs close. The XTerm component
    // stashes a __termFocus method on its container div.
    const container = termContainerRef.current?.firstElementChild as
      (HTMLDivElement & { __termFocus?: () => void }) | null | undefined;
    if (container?.__termFocus) {
      container.__termFocus();
    } else {
      // Fallback: focus xterm's hidden textarea directly.
      const textarea =
        termContainerRef.current?.querySelector<HTMLTextAreaElement>(
          ".xterm-helper-textarea",
        );
      textarea?.focus();
    }
  }, []);

  const activeMeta = sessions.find((s) => s.id === activeSessionId);

  // Status dot color classes matching the original design.
  const dotClass = cn(
    "size-[7px] rounded-full",
    status.state === "connected" && "bg-chart-1",
    status.state === "reconnecting" && "bg-chart-2",
    status.state === "disconnected" && "bg-destructive",
  );

  return (
    <div className="bg-background text-secondary-foreground flex h-screen overflow-hidden font-sans text-sm antialiased">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        collapsed={sidebarCollapsed}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        onDeleteSession={handleDeleteSession}
        onToggleCollapse={toggleSidebar}
        onDialogClose={handleDialogClose}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header bar */}
        <div className="border-border flex h-[42px] items-center gap-2.5 border-b px-4">
          <span
            className={cn(
              "text-sm font-medium",
              activeSessionId ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {activeMeta?.name ??
              (activeSessionId ? activeSessionId : "no session")}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className={dotClass} />
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
              {status.text}
            </span>
          </span>
        </div>

        {/* Terminal viewport or empty state */}
        <div className="relative flex-1 overflow-hidden" ref={termContainerRef}>
          {activeSessionId ? (
            <DynamicXTerm
              sessionId={activeSessionId}
              onStatusChange={handleStatusChange}
              onSessionError={handleSessionError}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground">No session selected.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
