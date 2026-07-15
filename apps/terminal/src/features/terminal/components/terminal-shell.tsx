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

import { parseSessionRef } from "@sparklab/shared-types";
import { Button } from "@sparklab/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sparklab/ui/components/ui/sheet";
import { cn } from "@sparklab/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Menu, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DynamicXTerm } from "./dynamic-xterm";
import { ExtraKeysBar } from "./extra-keys-bar";
import { SessionList } from "./session-list";
import { SessionSidebar } from "./session-sidebar";
import { SettingsDialog } from "./settings-dialog";
import { TerminalFooter } from "./terminal-footer";
import { useMediaQuery } from "../hooks/use-media-query";
import { useServers } from "../hooks/use-servers";
import { useSessionUrlSync } from "../hooks/use-session-url-sync";
import {
  useCreateSession,
  useDeleteSession,
  useSessions,
  useUpdateSession,
} from "../hooks/use-sessions";
import { useSettingsUrlSync } from "../hooks/use-settings-url-sync";
import { useUrlFlagSync } from "../hooks/use-url-flag-sync";
import { useVisualViewport } from "../hooks/use-visual-viewport";
import { serverStatus, sessionServerId } from "../server-grouping";
import { resolveActiveSession } from "../session-fallback";
import { useTerminalStore } from "../store";

import type { TerminalHandle } from "./xterm";
import type { ConnectionStatus } from "../connection";
import type {
  CreateSessionParams,
  UpdateSessionParams,
} from "../hooks/use-sessions";
import type { ModifierSnapshot } from "../keys";

import {
  AgentActivityOverlay,
  AgentChatPanel,
  AgentFab,
  useAgentStore,
} from "@/features/agent-chat";
import { authKeys, useAuthStatus, useLogout } from "@/features/auth";

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
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
  } = useTerminalStore();

  // Agent panel open state lives in the agent-chat store (persisted there).
  const agentPanelOpen = useAgentStore((s) => s.panelOpen);
  const setAgentPanelOpen = useAgentStore((s) => s.setPanelOpen);

  const {
    data: sessions = [],
    isSuccess: sessionsLoaded,
    isLoading: sessionsLoading,
  } = useSessions();
  const { data: servers = [] } = useServers();
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const updateSession = useUpdateSession();

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

  // Deep-linking: `?session=<id>` ↔ activeSessionId. The URL read (on mount)
  // overrides the persisted id; resolveActiveSession below then validates it
  // against the loaded list. Routes only through setActiveSessionId — never
  // touches XTerm props, so the no-remount invariant holds.
  useSessionUrlSync(activeSessionId, setActiveSessionId);
  // `?settings=<section>` opens the dialog to a tab; `?agent` opens the panel.
  useSettingsUrlSync(
    settingsOpen,
    settingsSection,
    setSettingsOpen,
    setSettingsSection,
  );
  useUrlFlagSync("agent", agentPanelOpen, setAgentPanelOpen);

  // ---- "Active session vanished → fall back" ----
  // Decision lives in resolveActiveSession (pure, unit-tested). It gates on
  // the first successful load so the initial-fetch window (sessions === [],
  // no initialData) can't null a persisted/URL-supplied id.
  useEffect(() => {
    const next = resolveActiveSession(
      sessionsLoaded,
      sessions,
      activeSessionId,
    );
    if (next !== undefined) setActiveSessionId(next);
  }, [sessionsLoaded, sessions, activeSessionId, setActiveSessionId]);

  // ---- Auto-expand ancestors of the active session ----
  // Keyed on the active session's org/project primitives so it fires both
  // when the id changes AND when sessions load (deep-link / reload path:
  // org/project go null -> real value when the list arrives). The 3s poll
  // does not re-fire because the same primitive strings are unchanged.
  const expandAncestors = useTerminalStore((s) => s.expandAncestors);
  const multiServer = servers.length > 1;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeOrg = activeSession?.org ?? null;
  const activeProject = activeSession?.project ?? null;
  // In multi-server mode collapse keys are namespaced by serverId and the
  // server ancestor is expanded too; in single-server mode pass null (bare
  // keys — unchanged). Derive the serverId from the session, or the qualified
  // active id when the session isn't in the list yet (deep-link path).
  const activeServerId = activeSession
    ? sessionServerId(activeSession)
    : activeSessionId
      ? parseSessionRef(activeSessionId).serverId
      : null;
  useEffect(() => {
    if (activeSessionId) {
      expandAncestors(
        activeOrg,
        activeProject,
        multiServer ? activeServerId : undefined,
      );
    }
  }, [
    activeSessionId,
    activeOrg,
    activeProject,
    activeServerId,
    multiServer,
    expandAncestors,
  ]);

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

  // These return the mutation promise so dialogs in SessionList can keep a
  // pending spinner visible until the gateway responds before closing.
  const handleCreateSession = useCallback(
    (params?: CreateSessionParams) =>
      createSession.mutateAsync(params).then((created) => {
        setActiveSessionId(created.id);
      }),
    [createSession, setActiveSessionId],
  );

  const handleUpdateSession = useCallback(
    (params: UpdateSessionParams) => updateSession.mutateAsync(params),
    [updateSession],
  );

  const handleDeleteSession = useCallback(
    (id: string) =>
      // Don't null activeSessionId here — mirroring the original app.js
      // behavior: leave it set so the vanish-fallback effect sees the id
      // disappear from the refreshed list and routes to the next session
      // (or empty state). Nulling here would cause a brief XTerm remount
      // flash and a frozen terminal on last-delete.
      deleteSession.mutateAsync(id),
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
    (params?: CreateSessionParams) => {
      const result = handleCreateSession(params);
      setMobileSidebarOpen(false);
      return result;
    },
    [handleCreateSession, setMobileSidebarOpen],
  );

  const handleMobileDeleteSession = useCallback(
    (id: string) => {
      const result = handleDeleteSession(id);
      setMobileSidebarOpen(false);
      return result;
    },
    [handleDeleteSession, setMobileSidebarOpen],
  );

  const activeMeta = sessions.find((s) => s.id === activeSessionId);

  // Surface 5: when the active session lives on an unreachable server, overlay
  // a muted (NOT destructive) "still running there" reassurance on the pane —
  // visually distinct from an ordinary gateway disconnect.
  const activeServer = activeServerId
    ? servers.find((s) => s.id === activeServerId)
    : undefined;
  const activeServerUnreachable =
    !!activeServer && serverStatus(activeServer) === "unreachable";
  const activeServerName = activeServer?.name ?? activeServerId ?? "the server";

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
          servers={servers}
          collapsed={sidebarCollapsed}
          loading={sessionsLoading}
          onSelectSession={handleSelectSession}
          onCreateSession={handleCreateSession}
          onDeleteSession={handleDeleteSession}
          onUpdateSession={handleUpdateSession}
          onToggleCollapse={toggleSidebar}
          onDialogClose={handleDialogClose}
          username={me?.username}
          onLogout={me?.username ? () => logoutMutation.mutate() : undefined}
          logoutPending={logoutMutation.isPending}
          onOpenSettings={() => setSettingsOpen(true)}
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
              servers={servers}
              variant="drawer"
              loading={sessionsLoading}
              onSelectSession={handleMobileSelectSession}
              onCreateSession={handleMobileCreateSession}
              onDeleteSession={handleMobileDeleteSession}
              onUpdateSession={handleUpdateSession}
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

          {/* Connect/reconnect overlay: the header badge alone is easy to miss,
              so surface the wait on the pane itself. Removed reactively when
              onStatus("connected") fires at ws.onopen — before the first binary
              frame triggers tmux's attach redraw, so it never covers live
              output. The unreachable-server overlay below takes precedence. */}
          {activeSessionId &&
            !activeServerUnreachable &&
            status.state === "reconnecting" && (
              <div className="bg-background/80 absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center backdrop-blur-sm">
                <Loader2 className="text-muted-foreground size-6 animate-spin" />
                <p className="text-muted-foreground text-xs">{status.text}</p>
              </div>
            )}

          {/* Unreachable-server overlay (§7.2): muted reassurance that the job
              is safe. Distinct from the transient gateway-disconnect state. */}
          {activeSessionId && activeServerUnreachable && (
            <div className="bg-background/80 absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center backdrop-blur-sm">
              <Unplug className="text-muted-foreground size-8" />
              <p className="text-foreground text-sm">
                Can&apos;t reach {activeServerName}.
              </p>
              <p className="text-muted-foreground text-xs">
                The session is still running there. Reconnecting…
              </p>
            </div>
          )}

          {/* Agent Chat: amber attribution overlay + floating entry button,
              both anchored inside the terminal viewport. */}
          <AgentActivityOverlay activeSessionId={activeSessionId} />
          <AgentFab />
        </div>

        {/* Mini footer bar below the xterm frame: server + current command. */}
        {activeSessionId && activeMeta && (
          <TerminalFooter session={activeMeta} server={activeServer} />
        )}

        {/* Extra keys — coarse-pointer devices only (CSS-gated, §3.2). */}
        <ExtraKeysBar
          handleRef={terminalHandleRef}
          modifiersRef={modifiersRef}
        />
      </div>

      {/* Agent Chat panel: docked right column (desktop) / bottom sheet
          (mobile). Always mounted — owns the ⌘J shortcut and WS connection. */}
      <AgentChatPanel isMobile={isMobile} />

      {/* Settings modal — mounted once; open state lives in the store so any
          entry point (sidebar gear) can trigger it. */}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        username={me?.username}
        onLogout={me?.username ? () => logoutMutation.mutate() : undefined}
        logoutPending={logoutMutation.isPending}
        statusState={status.state}
        statusText={status.text}
        sessionCount={sessions.length}
      />
    </div>
  );
}
