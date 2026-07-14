"use client";

/**
 * TerminalShell — the top-level composition of sidebar + header + terminal.
 *
 * Wires TanStack Query (sessions), Zustand (activeSessionId, sidebar), and the
 * XTerm component together. The XTerm component is never remounted on session
 * switch; switching happens via the `sessionId` prop → the effect inside
 * XTermComponent disposes the old Connection and creates a new one.
 *
 * Mobile (< md, mobile UX spec §1): the inline sidebar is replaced by a left
 * Sheet drawer opened from a hamburger button; the root height tracks the
 * visual viewport (`--app-height`, iOS keyboard fallback) and an extra-keys
 * bar renders below the terminal on coarse-pointer devices.
 */

import { Button } from "@sparklab/ui/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sparklab/ui/components/ui/sheet";
import { cn } from "@sparklab/ui/lib/utils";
import { Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { authKeys, useAuthStatus, useLogout } from "@/features/auth";
import {
  AgentActivityOverlay,
  AgentChatPanel,
  AgentFab,
} from "@/features/agent-chat";

import { DynamicXTerm } from "./dynamic-xterm";
import { ExtraKeysBar } from "./extra-keys-bar";
import { SessionList } from "./session-list";
import { SessionSidebar } from "./session-sidebar";
import { useMediaQuery } from "../hooks/use-media-query";
import {
  useCreateSession,
  useDeleteSession,
  useSessions,
} from "../hooks/use-sessions";
import { useVisualViewport } from "../hooks/use-visual-viewport";
import { useTerminalStore } from "../store";

import type { TerminalHandle } from "./xterm";
import type { ConnectionStatus } from "../connection";
import type { ModifierSnapshot } from "../keys";

export function TerminalShell() {
  const queryClient = useQueryClient();
  const logoutMutation = useLogout();
  // `username` is only present in auth mode; in open mode (dev, no
  // credentials) Sign out would be a silent no-op, so it isn't offered.
  const { data: me } = useAuthStatus();
  const {
    activeSessionId,
    setActiveSessionId,
    sidebarCollapsed,
    toggleSidebar,
    mobileSidebarOpen,
    setMobileSidebarOpen,
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
  // Imperative terminal handle (focus / sendInput / cursor-keys mode).
  const terminalHandleRef = useRef<TerminalHandle | null>(null);
  // Sticky Ctrl/Alt state shared between the extra-keys bar and xterm onData.
  const modifiersRef = useRef<ModifierSnapshot | null>(null);

  // `< md` = mobile: overlay drawer instead of the inline sidebar (§1.1).
  const isMobile = useMediaQuery("(max-width: 767px)");

  // iOS keyboard fallback: mirror visualViewport.height into --app-height.
  useVisualViewport();

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

  const handleAuthError = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: authKeys.me() });
  }, [queryClient]);

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

  // ---- Mobile drawer wrappers: auto-close on select/create/delete (§1.2).
  // No focus restoration on mobile — refocusing xterm would summon the
  // keyboard uninvited; the user taps the terminal instead (§4.1).
  const handleMobileSelectSession = useCallback(
    (id: string) => {
      handleSelectSession(id);
      setMobileSidebarOpen(false);
    },
    [handleSelectSession, setMobileSidebarOpen],
  );

  const handleMobileCreateSession = useCallback(
    (name?: string) => {
      handleCreateSession(name);
      setMobileSidebarOpen(false);
    },
    [handleCreateSession, setMobileSidebarOpen],
  );

  const handleMobileDeleteSession = useCallback(
    (id: string) => {
      handleDeleteSession(id);
      setMobileSidebarOpen(false);
    },
    [handleDeleteSession, setMobileSidebarOpen],
  );

  const activeMeta = sessions.find((s) => s.id === activeSessionId);

  // Status dot color classes matching the original design.
  const dotClass = cn(
    "size-[7px] rounded-full",
    status.state === "connected" && "bg-chart-1",
    status.state === "reconnecting" && "bg-chart-2",
    status.state === "disconnected" && "bg-destructive",
  );

  return (
    <div className="bg-background text-secondary-foreground flex h-[var(--app-height,100dvh)] overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] font-sans text-sm antialiased">
      {/* Desktop inline sidebar (hidden < md via CSS, unmounted on mobile). */}
      {!isMobile && (
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          collapsed={sidebarCollapsed}
          onSelectSession={handleSelectSession}
          onCreateSession={handleCreateSession}
          onDeleteSession={handleDeleteSession}
          onToggleCollapse={toggleSidebar}
          onDialogClose={handleDialogClose}
          username={me?.username}
          onLogout={me?.username ? () => logoutMutation.mutate() : undefined}
        />
      )}

      {/* Mobile left drawer with the same (always-expanded) session list. */}
      {isMobile && (
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent
            side="left"
            className="w-[min(80vw,300px)] max-w-none gap-0"
          >
            <SheetTitle className="sr-only">Sessions</SheetTitle>
            <SheetDescription className="sr-only">
              Select, create, or delete a terminal session.
            </SheetDescription>
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              variant="drawer"
              onSelectSession={handleMobileSelectSession}
              onCreateSession={handleMobileCreateSession}
              onDeleteSession={handleMobileDeleteSession}
            />
          </SheetContent>
        </Sheet>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header bar */}
        <div className="border-border flex h-[42px] min-w-0 items-center gap-2.5 border-b px-4">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2.5 size-11 shrink-0 md:hidden"
            aria-label="Open sessions"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              activeSessionId ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {activeMeta?.name ??
              (activeSessionId ? activeSessionId : "no session")}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className={dotClass} />
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
              {status.text}
            </span>
          </span>
        </div>

        {/* Terminal viewport or empty state */}
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          ref={termContainerRef}
        >
          {activeSessionId ? (
            <DynamicXTerm
              sessionId={activeSessionId}
              onStatusChange={handleStatusChange}
              onSessionError={handleSessionError}
              onAuthError={handleAuthError}
              handleRef={terminalHandleRef}
              modifiersRef={modifiersRef}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground">No session selected.</p>
            </div>
          )}

          {/* Agent Chat: amber attribution overlay + floating entry button,
              both anchored inside the terminal viewport. */}
          <AgentActivityOverlay activeSessionId={activeSessionId} />
          <AgentFab />
        </div>

        {/* Extra keys — coarse-pointer devices only (CSS-gated, §3.2). */}
        <ExtraKeysBar
          handleRef={terminalHandleRef}
          modifiersRef={modifiersRef}
        />
      </div>

      {/* Agent Chat panel: docked right column (desktop) / bottom sheet
          (mobile). Always mounted — owns the ⌘J shortcut and WS connection. */}
      <AgentChatPanel isMobile={isMobile} />
    </div>
  );
}
