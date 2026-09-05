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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Bot,
  FolderTree,
  Globe2,
  ListChecks,
  Menu,
  Monitor,
  NotebookText,
  SquareGanttChart,
  SquareKanban,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgenticDialog } from "./agentic-dialog";
import { ExtraKeysBar } from "./extra-keys-bar";
import { FileExplorerDialog } from "./file-explorer-dialog";
import { KanbanDialog } from "./kanban-dialog";
import { LayoutMenu } from "./layout-menu";
import { MunderDifflinDialog } from "./munder-difflin-dialog";
import { NotesDialog } from "./notes-dialog";
import { PmDialog } from "./pm-dialog";
import { SessionList } from "./session-list";
import { SessionSidebar } from "./session-sidebar";
import { SettingsDialog } from "./settings-dialog";
import { TaskmasterHubDialog } from "./taskmaster-hub-dialog";
import { TerminalFooter } from "./terminal-footer";
import { TerminalGrid } from "./terminal-grid";
import { TerminalSwitcher } from "./terminal-switcher";
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
import { resolvePaneSessions } from "../resolve-pane-sessions";
import { serverStatus, sessionServerId } from "../server-grouping";
import { useTerminalStore } from "../store";

import type { TerminalHandle } from "./xterm";
import type { ConnectionStatus } from "../connection";
import type {
  CreateSessionParams,
  UpdateSessionParams,
} from "../hooks/use-sessions";
import type { ModifierSnapshot } from "../keys";
import type { LayoutMode } from "../store";

import {
  AgentActivityOverlay,
  AgentChatPanel,
  AgentFab,
  useAgentStore,
} from "@/features/agent-chat";
import { authKeys, useAuthStatus, useLogout } from "@/features/auth";
import {
  BrowserViewOverlay,
  useBrowserViewStore,
} from "@/features/browser-view";
import {
  ComputerViewOverlay,
  useComputerViewStore,
} from "@/features/computer-view";

export function TerminalShell() {
  const queryClient = useQueryClient();
  const logoutMutation = useLogout();
  // `username` is only present in auth mode; in open mode (dev, no
  // credentials) Sign out would be a silent no-op, so it isn't offered.
  const { data: me } = useAuthStatus();
  const {
    activeSessionId,
    setActiveSessionId,
    recentSessionIds,
    markSessionActive,
    layout,
    setLayoutMode,
    reconcilePanes,
    sidebarCollapsed,
    toggleSidebar,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    explorerOpen,
    setExplorerOpen,
    kanbanOpen,
    setKanbanOpen,
    pmOpen,
    setPmOpen,
    agenticOpen,
    setAgenticOpen,
    munderDifflinOpen,
    setMunderDifflinOpen,
    notesOpen,
    setNotesOpen,
    taskmasterHubOpen,
    setTaskmasterHubOpen,
  } = useTerminalStore();

  // Agent panel open state lives in the agent-chat store (persisted there).
  const agentPanelOpen = useAgentStore((s) => s.panelOpen);
  const setAgentPanelOpen = useAgentStore((s) => s.setPanelOpen);
  const browserView = useBrowserViewStore((s) => s.view);
  const browserVisible = useBrowserViewStore((s) => s.visible);
  const showBrowser = useBrowserViewStore((s) => s.show);
  const computerView = useComputerViewStore((s) => s.view);
  const computerVisible = useComputerViewStore((s) => s.visible);
  const showComputer = useComputerViewStore((s) => s.show);

  const {
    data: sessions = [],
    isSuccess: sessionsLoaded,
    isLoading: sessionsLoading,
  } = useSessions();
  const { data: servers = [] } = useServers();
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const updateSession = useUpdateSession();

  // Per-pane connection status (D-note in plan §3a: "session-scoped UI
  // follows focus" — the header dot / Settings Connection tab read the
  // FOCUSED pane's entry; per-pane chrome/overlays read their own, passed
  // straight through TerminalPane's local state instead of round-tripping
  // through this map).
  const [statusByPane, setStatusByPane] = useState<
    Record<string, { state: ConnectionStatus; text: string }>
  >({});
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Ref to the xterm container for focus restoration.
  const termContainerRef = useRef<HTMLDivElement>(null);
  // Per-pane imperative terminal handle registry (D6) — replaces the old
  // single-slot terminalHandleRef, which could only ever reflect the
  // last-mounted pane.
  const paneHandlesRef = useRef<Map<string, TerminalHandle>>(new Map());
  // Sticky Ctrl/Alt state shared between the extra-keys bar and xterm onData.
  const modifiersRef = useRef<ModifierSnapshot | null>(null);

  // `< md` = mobile: overlay drawer instead of the inline sidebar (§1.1).
  const isMobile = useMediaQuery("(max-width: 767px)");

  // iOS keyboard fallback: mirror visualViewport.height into --app-height.
  useVisualViewport();

  // ⌘⇧O / Win⇧O (Ctrl⇧O fallback) is intentionally used instead of ⌘Tab:
  // browsers and macOS reserve the latter for their own app/tab switching.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "o"
      ) {
        event.preventDefault();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
  useUrlFlagSync("explorer", explorerOpen, setExplorerOpen);
  useUrlFlagSync("kanban", kanbanOpen, setKanbanOpen);
  useUrlFlagSync("pm", pmOpen, setPmOpen);
  useUrlFlagSync("agentic", agenticOpen, setAgenticOpen);
  useUrlFlagSync("munder-difflin", munderDifflinOpen, setMunderDifflinOpen);
  useUrlFlagSync("notes", notesOpen, setNotesOpen);
  useUrlFlagSync("taskmaster", taskmasterHubOpen, setTaskmasterHubOpen);

  // ---- "Active session vanished → fall back" (grid-aware, D7) ----
  // Decision lives in resolvePaneSessions (pure, unit-tested) — the
  // multi-pane sibling of resolveActiveSession. Same load-gate reasoning:
  // gates on the first successful load so the initial-fetch window
  // (sessions === [], no initialData) can't null every pane's
  // persisted/URL-supplied session. `layout.panes` is a stable reference
  // between real store mutations (SA's contract), so this only re-fires on
  // an actual layout or sessions change, not every render.
  useEffect(() => {
    const focusedIndex = layout.panes.findIndex(
      (p) => p.id === layout.focusedPaneId,
    );
    const next = resolvePaneSessions(
      sessionsLoaded,
      sessions,
      layout.panes.map((p) => p.sessionId),
      focusedIndex,
    );
    if (next !== undefined) reconcilePanes(next);
  }, [
    sessionsLoaded,
    sessions,
    layout.panes,
    layout.focusedPaneId,
    reconcilePanes,
  ]);

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
    if (activeSessionId && sessionsLoaded) {
      expandAncestors(
        activeOrg,
        activeProject,
        multiServer ? activeServerId : undefined,
      );
    }
  }, [
    activeSessionId,
    sessionsLoaded,
    activeOrg,
    activeProject,
    activeServerId,
    multiServer,
    expandAncestors,
  ]);

  // ---- Callbacks ----
  const handlePaneStatus = useCallback(
    (paneId: string, state: ConnectionStatus, text: string) => {
      setStatusByPane((prev) => ({ ...prev, [paneId]: { state, text } }));
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
      markSessionActive(id);
    },
    [markSessionActive, setActiveSessionId],
  );

  // These return the mutation promise so dialogs in SessionList can keep a
  // pending spinner visible until the gateway responds before closing.
  const handleCreateSession = useCallback(
    (params?: CreateSessionParams) =>
      createSession.mutateAsync(params).then((created) => {
        setActiveSessionId(created.id);
        markSessionActive(created.id);
      }),
    [createSession, markSessionActive, setActiveSessionId],
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
    // Return focus to the terminal after dialogs close, via the focused
    // pane's registered imperative handle (D6) — replaces the old
    // __termFocus-on-firstElementChild hack, which couldn't survive a grid
    // wrapper (see docs/MULTI-WINDOW-PLAN.md "Grounding").
    const handle = paneHandlesRef.current.get(layout.focusedPaneId);
    if (handle) {
      handle.focus();
      return;
    }
    // Fallback for the brief window before the dynamically-imported xterm
    // chunk has registered its handle. In `single` mode (today's only
    // reachable path pre-this-feature) the container IS the one pane, so an
    // unscoped query matches gate-6's existing `.xterm-helper-textarea`
    // selector exactly; in multi-pane mode, scope to the focused pane's
    // subtree so this can't grab a different pane's textarea.
    const root =
      layout.mode === "single"
        ? termContainerRef.current
        : (termContainerRef.current?.querySelector(
            `[data-pane-id="${layout.focusedPaneId}"]`,
          ) ?? termContainerRef.current);
    const textarea = root?.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    textarea?.focus();
  }, [layout.focusedPaneId, layout.mode]);

  const handleSwitcherSelect = useCallback(
    (id: string) => {
      handleSelectSession(id);
      setSwitcherOpen(false);
      requestAnimationFrame(handleDialogClose);
    },
    [handleDialogClose, handleSelectSession],
  );

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

  // Header dot / Settings Connection tab: the FOCUSED pane's status (D-note,
  // plan §3a) — falls back to the same literal `useState` initial the old
  // single `status` state used, so the header is identical on first render.
  const focusedStatus = statusByPane[layout.focusedPaneId] ?? {
    state: "disconnected" as ConnectionStatus,
    text: "idle",
  };

  // Status dot color classes matching the original design.
  const dotClass = cn(
    "size-[7px] rounded-full",
    focusedStatus.state === "connected" && "bg-chart-1",
    focusedStatus.state === "reconnecting" && "bg-chart-2",
    focusedStatus.state === "disconnected" && "bg-destructive",
  );

  // Read-only ref shape for ExtraKeysBar (D6): always reflects the
  // currently focused pane's handle, without needing a reactive effect to
  // keep a real ref in sync with registry mutations (which happen on a
  // plain ref, not store state).
  const focusedHandleRef = {
    get current() {
      return paneHandlesRef.current.get(layout.focusedPaneId) ?? null;
    },
  };

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
              "min-w-0 flex-1 truncate text-sm font-medium",
              activeSessionId ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {activeMeta?.name ??
              (activeSessionId ? activeSessionId : "no session")}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Switch terminal"
                className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                disabled={sessions.length === 0}
                onClick={() => setSwitcherOpen(true)}
                size="sm"
                variant="outline"
              >
                <ArrowLeftRight className="size-3.5" />
                Switch
              </Button>
            </TooltipTrigger>
            <TooltipContent>Switch terminal (⌘/Win⇧O)</TooltipContent>
          </Tooltip>
          {/* Multi-window layout presets (D2/D9) — desktop-only; the grid
              force-collapses to a single pane on mobile regardless of the
              stored mode, so the picker stays hidden there too. */}
          {!isMobile && (
            <LayoutMenu
              mode={layout.mode}
              onSelect={(mode: LayoutMode) => setLayoutMode(mode)}
            />
          )}
          {activeMeta &&
            (activeMeta.org || (activeServer && servers.length > 1)) && (
              <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
                <span aria-hidden="true">·</span>
                {servers.length > 1 && activeServer && (
                  <>
                    <button
                      type="button"
                      className="hover:text-foreground max-w-24 truncate transition-colors"
                      onClick={() => {
                        // No-op stub until jump-to-level navigation is added.
                      }}
                      title={activeServer.name}
                    >
                      {activeServer.name}
                    </button>
                    {activeMeta.org && <span aria-hidden="true">/</span>}
                  </>
                )}
                {activeMeta.org && (
                  <>
                    <button
                      type="button"
                      className="hover:text-foreground max-w-24 truncate transition-colors"
                      onClick={() => {
                        // No-op stub until jump-to-level navigation is added.
                      }}
                      title={activeMeta.org}
                    >
                      {activeMeta.org}
                    </button>
                    {activeMeta.project && <span aria-hidden="true">/</span>}
                  </>
                )}
                {activeMeta.project && (
                  <button
                    type="button"
                    className="hover:text-foreground max-w-24 truncate transition-colors"
                    onClick={() => {
                      // No-op stub until jump-to-level navigation is added.
                    }}
                    title={activeMeta.project}
                  >
                    {activeMeta.project}
                  </button>
                )}
              </span>
            )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Browse files"
                disabled={!activeSessionId || activeServerUnreachable}
                onClick={() => setExplorerOpen(true)}
              >
                <FolderTree className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Browse files</TooltipContent>
          </Tooltip>
          {/* Kanban is gateway-global (D7), never session-scoped — always
              enabled, unlike the Browse-files button above. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Kanban board"
                onClick={() => setKanbanOpen(true)}
              >
                <SquareKanban className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Kanban board</TooltipContent>
          </Tooltip>
          {/* Project management is gateway-global too — always enabled. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Project management"
                onClick={() => setPmOpen(true)}
              >
                <SquareGanttChart className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Project management</TooltipContent>
          </Tooltip>
          {/* Agentic AI Creator is gateway-global (D8) too — always enabled. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Agentic AI Creator"
                onClick={() => setAgenticOpen(true)}
              >
                <Bot className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Agentic AI Creator</TooltipContent>
          </Tooltip>
          {/* Notes is gateway-global too (D7) — always enabled. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Notes"
                onClick={() => setNotesOpen(true)}
              >
                <NotebookText className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Notes</TooltipContent>
          </Tooltip>
          {/* Task Master Hub is gateway-global too — always enabled. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Task Master Hub"
                onClick={() => setTaskmasterHubOpen(true)}
              >
                <ListChecks className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Task Master Hub</TooltipContent>
          </Tooltip>
          {/* Munder Difflin header button is disabled/hidden — the viewer is
              still reachable via the ?munder-difflin URL flag. */}
          {browserView && !browserVisible && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-chart-2 size-7 shrink-0"
                  aria-label="Reopen browser view"
                  onClick={showBrowser}
                >
                  <Globe2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reopen browser view</TooltipContent>
            </Tooltip>
          )}
          {/* Same reopen affordance for the agent's virtual computer (CUA)
              desktop: shown only when a current view exists but the user has
              sent it "Back to terminal". Later computer_view frames keep the
              hidden view fresh; this button brings it back. */}
          {computerView && !computerVisible && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-chart-2 size-7 shrink-0"
                  aria-label="Reopen computer view"
                  onClick={showComputer}
                >
                  <Monitor className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reopen computer view</TooltipContent>
            </Tooltip>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className={dotClass} />
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
              {focusedStatus.text}
            </span>
          </span>
        </div>

        {/* Terminal viewport: the multi-window grid (D2). In `single` mode
            (the default) TerminalGrid renders the exact single-pane subtree
            this container used to render directly — one <DynamicXTerm> (or
            the plain empty state) plus the reconnecting/unreachable
            overlays, with no extra wrapper — so this is pixel- and
            DOM-structure-identical to pre-multi-window behavior (D10). */}
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          ref={termContainerRef}
        >
          <TerminalGrid
            isMobile={isMobile}
            modifiersRef={modifiersRef}
            onAuthError={handleAuthError}
            onPaneStatus={handlePaneStatus}
            onSessionError={handleSessionError}
            paneHandlesRef={paneHandlesRef}
            servers={servers}
            sessions={sessions}
          />

          {/* Read-only screenshots cover xterm in-place. Xterm remains mounted,
              connected, and at the same size beneath this absolute layer.
              Grid-global (unchanged) — covers the whole viewport regardless
              of layout mode. */}
          <BrowserViewOverlay />

          {/* Same in-place read-only overlay pattern for the agent's virtual
              computer (CUA) desktop. Renders only when a computer_view frame
              has arrived; no-op otherwise. */}
          <ComputerViewOverlay />

          {/* Agent Chat: amber attribution overlay + floating entry button,
              both anchored inside the terminal viewport. Minimal v1 (plan
              §3a): highlights only when the agent's target is the FOCUSED
              pane's session; full per-pane targeting is a follow-up. */}
          <AgentActivityOverlay activeSessionId={activeSessionId} />
          <AgentFab />

          <TerminalSwitcher
            activeSessionId={activeSessionId}
            onClose={() => {
              setSwitcherOpen(false);
              requestAnimationFrame(handleDialogClose);
            }}
            onSelect={handleSwitcherSelect}
            open={switcherOpen}
            recentSessionIds={recentSessionIds}
            servers={servers}
            sessions={sessions}
          />
        </div>

        {/* Mini footer bar below the xterm frame: server + current command. */}
        {activeSessionId && activeMeta && (
          <TerminalFooter session={activeMeta} server={activeServer} />
        )}

        {/* Extra keys — coarse-pointer devices only (CSS-gated, §3.2). */}
        <ExtraKeysBar
          handleRef={focusedHandleRef}
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
        statusState={focusedStatus.state}
        statusText={focusedStatus.text}
        sessionCount={sessions.length}
      />

      {/* File explorer modal — scoped to the active session's server. Mounted
          once; open state lives in the store (deep-linked via `?explorer`). */}
      <FileExplorerDialog
        open={explorerOpen}
        onOpenChange={setExplorerOpen}
        sessionId={activeSessionId}
        serverName={activeServer?.name}
        unreachable={activeServerUnreachable}
      />

      {/* Kanban board modal — gateway-global (D7), not session-scoped. Mounted
          once; open state lives in the store (deep-linked via `?kanban`). */}
      <KanbanDialog open={kanbanOpen} onOpenChange={setKanbanOpen} />

      {/* Project management modal — gateway-global, not session-scoped.
          Mounted once; open state lives in the store (deep-linked via `?pm`). */}
      <PmDialog open={pmOpen} onOpenChange={setPmOpen} />

      <TaskmasterHubDialog
        open={taskmasterHubOpen}
        onOpenChange={setTaskmasterHubOpen}
      />

      {/* Agentic AI Creator modal — gateway-global (D8), not session-scoped.
          Mounted once; open state lives in the store (deep-linked via
          `?agentic`). */}
      <AgenticDialog open={agenticOpen} onOpenChange={setAgenticOpen} />

      {/* Munder Difflin viewer modal — gateway-global, not session-scoped.
          Mounted once; open state lives in the store (deep-linked via
          `?munder-difflin`). */}
      <MunderDifflinDialog
        open={munderDifflinOpen}
        onOpenChange={setMunderDifflinOpen}
      />

      {/* Notes modal — gateway-global (D7), not session-scoped. Mounted once;
          open state lives in the store (deep-linked via `?notes`). */}
      <NotesDialog open={notesOpen} onOpenChange={setNotesOpen} />
    </div>
  );
}
