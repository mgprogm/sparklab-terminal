"use client";

/**
 * SessionList -- the session-list content (header + grouped list + create/delete/
 * move dialogs), supporting a two-level org/project tree when any session has
 * an org set, and falling back to the flat list for ungrouped workspaces.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sparklab/ui/components/ui/alert-dialog";
import { Button } from "@sparklab/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import { Input } from "@sparklab/ui/components/ui/input";
import { Label } from "@sparklab/ui/components/ui/label";
import { ScrollArea } from "@sparklab/ui/components/ui/scroll-area";
import { Separator } from "@sparklab/ui/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Folder,
  LogOut,
  MoreHorizontal,
  Plus,
  Server,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Unplug,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  groupSessions,
  hasAnyGrouping,
  flattenTree,
  type SessionTree,
} from "../grouping";
import {
  groupByServer,
  isServerUnreachable,
  orgCollapseKey,
  projectCollapseKey,
  serverCollapseKey,
  serverDotClass,
  serverStatus,
  sessionServerId,
} from "../server-grouping";
import { useTerminalStore } from "../store";
import { AddServerDialog } from "./add-server-dialog";

import type {
  CreateSessionParams,
  UpdateSessionParams,
} from "../hooks/use-sessions";
import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";

import { useAgentStore } from "@/features/agent-chat";

// Shell processes that don't count as "running a job".
const SHELLS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "-bash",
  "-sh",
  "-zsh",
]);

/** Formats a relative time string from epoch seconds. */
function formatRelativeTime(epochSeconds: number): string {
  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (diffSeconds < 60) return "idle now";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `idle ${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `idle ${String(hours)}h`;
  return `idle ${String(Math.floor(hours / 24))}d`;
}

function isRunning(cmd: string): boolean {
  return !!cmd && !SHELLS.has(cmd);
}

/** Collect unique org values from sessions. */
function uniqueOrgs(sessions: SessionInfo[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.org) set.add(s.org);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Collect unique project values for a given org from sessions. */
function uniqueProjects(sessions: SessionInfo[], org: string): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.org === org && s.project) set.add(s.project);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface SessionListProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  /** Registry servers. When absent or <= 1 the sidebar is single-server and
   *  renders exactly as before (no server headers). */
  servers?: ServerInfo[];
  /** Desktop-only collapsed (icon rail) mode. The mobile drawer never collapses. */
  collapsed?: boolean;
  /** "drawer" enlarges touch targets for the mobile Sheet. */
  variant?: "sidebar" | "drawer";
  onSelectSession: (id: string) => void;
  onCreateSession: (params?: CreateSessionParams) => void;
  onDeleteSession: (id: string) => void;
  onUpdateSession?: (params: UpdateSessionParams) => void;
  /** Called after any dialog closes so the terminal can reclaim focus. */
  onDialogClose?: () => void;
  /** Signed-in username; absent in open mode (dev, auth disabled). When any of
   *  the account props below are present, the account footer renders and hosts
   *  the "New" action; otherwise (mobile drawer) "New" stays in the header. */
  username?: string;
  onLogout?: () => void;
  /** Opens the settings dialog (owned by the shell). */
  onOpenSettings?: () => void;
}

export function SessionList({
  sessions,
  activeSessionId,
  servers,
  collapsed = false,
  variant = "sidebar",
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onUpdateSession,
  onDialogClose,
  username,
  onLogout,
  onOpenSettings,
}: SessionListProps) {
  const drawer = variant === "drawer";
  // When account controls are wired (desktop sidebar), the footer renders and
  // owns the primary "New" action; the header drops it. Without them (mobile
  // drawer) there is no footer, so "New" remains in the header.
  const showAccountFooter = !!(onOpenSettings || onLogout);
  // Multi-server mode: server headers appear only once a second server exists.
  const serverList = useMemo(() => servers ?? [], [servers]);
  const multiServer = serverList.length > 1;
  // Fast serverId -> record lookup for row-level reachability + tooltips.
  const serverById = useMemo(() => {
    const m = new Map<string, ServerInfo>();
    for (const s of serverList) m.set(s.id, s);
    return m;
  }, [serverList]);
  const serverGroups = useMemo(
    () => (multiServer ? groupByServer(sessions, serverList) : []),
    [multiServer, sessions, serverList],
  );
  // Sessions the agent is actively writing to -- drives the amber row badge.
  const agentActiveSessionIds = useAgentStore((s) => s.agentActiveSessionIds);

  // Collapse state from the store.
  const collapsedGroups = useTerminalStore((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useTerminalStore((s) => s.toggleGroupCollapsed);

  // ---- Create dialog state ----
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newServerId, setNewServerId] = useState("local");

  // ---- Add-server dialog state (multi-server sidebar row) ----
  const [addServerOpen, setAddServerOpen] = useState(false);

  // ---- Delete dialog state ----
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);

  // ---- Move/rename dialog state ----
  const [moveTarget, setMoveTarget] = useState<SessionInfo | null>(null);
  const [moveName, setMoveName] = useState("");
  const [moveOrg, setMoveOrg] = useState("");
  const [moveProject, setMoveProject] = useState("");

  // Compute tree and grouping flag.
  const grouped = useMemo(() => hasAnyGrouping(sessions), [sessions]);
  const tree = useMemo(() => groupSessions(sessions), [sessions]);
  const flatSessions = useMemo(
    () => (grouped ? flattenTree(tree) : sessions),
    [grouped, tree, sessions],
  );

  // Datalist suggestions.
  const orgSuggestions = useMemo(() => uniqueOrgs(sessions), [sessions]);
  const createProjectSuggestions = useMemo(
    () => (newOrg ? uniqueProjects(sessions, newOrg) : []),
    [sessions, newOrg],
  );
  const moveProjectSuggestions = useMemo(
    () => (moveOrg ? uniqueProjects(sessions, moveOrg) : []),
    [sessions, moveOrg],
  );

  // ---- Create handlers ----
  const openCreateDialog = useCallback(
    (
      prefillOrg?: string,
      prefillProject?: string,
      prefillServerId?: string,
    ) => {
      setNewName("");
      setNewOrg(prefillOrg ?? "");
      setNewProject(prefillProject ?? "");
      setNewServerId(prefillServerId ?? "local");
      setCreateOpen(true);
    },
    [],
  );

  const handleCreate = () => {
    const params: CreateSessionParams = {};
    if (newName.trim()) params.name = newName.trim();
    if (newOrg.trim()) params.org = newOrg.trim();
    if (newProject.trim()) params.project = newProject.trim();
    // Only carry serverId in multi-server mode so the single-server POST body
    // stays byte-identical to before.
    if (multiServer && newServerId) params.serverId = newServerId;
    onCreateSession(Object.keys(params).length > 0 ? params : undefined);
    setNewName("");
    setNewOrg("");
    setNewProject("");
    setNewServerId("local");
    setCreateOpen(false);
    onDialogClose?.();
  };

  const handleCreateCancel = () => {
    setNewName("");
    setNewOrg("");
    setNewProject("");
    setNewServerId("local");
    setCreateOpen(false);
    onDialogClose?.();
  };

  // ---- Delete handlers ----
  const handleDelete = () => {
    if (deleteTarget) {
      onDeleteSession(deleteTarget.id);
    }
    setDeleteTarget(null);
    onDialogClose?.();
  };

  const handleDeleteCancel = () => {
    setDeleteTarget(null);
    onDialogClose?.();
  };

  // ---- Move/rename handlers ----
  const openMoveDialog = useCallback((s: SessionInfo) => {
    setMoveTarget(s);
    setMoveName(s.name);
    setMoveOrg(s.org ?? "");
    setMoveProject(s.project ?? "");
  }, []);

  const handleMove = () => {
    if (moveTarget && onUpdateSession) {
      const params: UpdateSessionParams = { id: moveTarget.id };
      const trimmedName = moveName.trim();
      if (trimmedName && trimmedName !== moveTarget.name) {
        params.name = trimmedName;
      }
      const trimmedOrg = moveOrg.trim();
      const trimmedProject = moveProject.trim();
      if (trimmedOrg !== (moveTarget.org ?? "")) {
        params.org = trimmedOrg || null;
      }
      if (trimmedProject !== (moveTarget.project ?? "")) {
        params.project = trimmedProject || null;
      }
      // Only call if something changed.
      if (Object.keys(params).length > 1) {
        onUpdateSession(params);
      }
    }
    setMoveTarget(null);
    onDialogClose?.();
  };

  const handleMoveCancel = () => {
    setMoveTarget(null);
    onDialogClose?.();
  };

  // ---- Session row renderer ----
  const renderSessionRow = (s: SessionInfo) => {
    const server = serverById.get(sessionServerId(s));
    // Grey a row only in multi-server mode when its server can't be reached
    // ("couldn't ask" != "dead"). An unknown (orphan) serverId is treated the
    // same — muted, never destructive, never dropped.
    const unreachable = multiServer && (!server || isServerUnreachable(server));
    const serverName = server?.name ?? sessionServerId(s);

    const tooltipLines: string[] = [s.name];
    if (collapsed) {
      if (multiServer) tooltipLines.push(serverName);
      if (s.org) {
        tooltipLines.push(s.project ? `${s.org} / ${s.project}` : s.org);
      }
    }

    const row = (
      <Tooltip key={s.id}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "group relative flex w-full items-center rounded-sm transition-colors",
              collapsed && "justify-center",
              unreachable && "opacity-60",
              s.id === activeSessionId
                ? "border-l-primary bg-secondary border-l-2"
                : "hover:bg-accent border-l-2 border-l-transparent",
            )}
          >
            {/* Row select button */}
            <button
              type="button"
              onClick={() => {
                if (s.id !== activeSessionId) onSelectSession(s.id);
              }}
              className={cn(
                "pointer-coarse:py-3 flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left",
                collapsed ? "justify-center px-0" : "px-2.5",
              )}
            >
              {/* Status dot */}
              <span
                className={cn(
                  "size-[7px] shrink-0 rounded-full",
                  isRunning(s.currentCommand)
                    ? "bg-chart-1"
                    : "bg-muted-foreground",
                  s.attached && "ring-chart-1/30 ring-2",
                  agentActiveSessionIds.includes(s.id) &&
                    "ring-chart-2/40 ring-2",
                )}
                title={
                  (isRunning(s.currentCommand)
                    ? `running: ${s.currentCommand}`
                    : "idle shell") + (s.attached ? " (attached)" : "")
                }
              />

              {/* Name on line 1; command + status share line 2 */}
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-sm",
                      s.id === activeSessionId
                        ? "text-foreground"
                        : "text-secondary-foreground",
                    )}
                  >
                    {s.name}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
                    {s.currentCommand && (
                      <span className="text-muted-foreground min-w-0 truncate font-mono">
                        {s.currentCommand}
                      </span>
                    )}
                    {agentActiveSessionIds.includes(s.id) && (
                      <span className="text-chart-2 flex shrink-0 items-center gap-1">
                        {s.currentCommand && (
                          <span
                            aria-hidden="true"
                            className="text-muted-foreground"
                          >
                            ·
                          </span>
                        )}
                        <Sparkles className="size-3" />
                        agent
                      </span>
                    )}
                    {/* B2: Status badge */}
                    {s.attachedClients !== undefined &&
                    s.attachedClients > 0 ? (
                      <span className="text-chart-1 shrink-0">
                        {s.currentCommand && (
                          <span
                            aria-hidden="true"
                            className="text-muted-foreground mr-1.5"
                          >
                            ·
                          </span>
                        )}
                        {s.attachedClients === 1
                          ? "1 viewer"
                          : `${String(s.attachedClients)} viewers`}
                      </span>
                    ) : s.lastActivity != null ? (
                      <span className="text-muted-foreground shrink-0">
                        {s.currentCommand && (
                          <span aria-hidden="true" className="mr-1.5">
                            ·
                          </span>
                        )}
                        {formatRelativeTime(s.lastActivity)}
                      </span>
                    ) : null}
                    {unreachable && (
                      <span className="text-muted-foreground shrink-0">
                        unreachable
                      </span>
                    )}
                  </span>
                </div>
              )}
            </button>

            {/* Row actions: move/rename + delete. Always visible (not
                hover-gated) so the terminate/delete action is discoverable
                without hovering — works for local and remote sessions alike. */}
            {!collapsed && (
              <div className="mr-1 flex shrink-0 items-center gap-0.5">
                {onUpdateSession && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:bg-accent hover:text-secondary-foreground pointer-coarse:p-2 rounded-sm p-1 transition-colors"
                        title="Session actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem onClick={() => openMoveDialog(s)}>
                        Rename / Move to...
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <button
                  type="button"
                  className="text-muted-foreground hover:bg-destructive/20 hover:text-destructive pointer-coarse:p-2 rounded-sm p-1 transition-all"
                  title="Delete session (kills the running job)"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(s);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        </TooltipTrigger>
        {(collapsed || unreachable) && (
          <TooltipContent side="right">
            {collapsed ? (
              tooltipLines.map((line, i) => <div key={i}>{line}</div>)
            ) : (
              <div className="max-w-56">
                This server is unreachable. The session is still running there —
                the gateway just can&apos;t reach {serverName} right now.
              </div>
            )}
          </TooltipContent>
        )}
      </Tooltip>
    );

    return row;
  };

  // ---- Server header renderer (multi-server only) ----
  const renderServerHeader = (server: ServerInfo, sessionCount: number) => {
    const key = serverCollapseKey(server.id);
    const isCollapsed = !!collapsedGroups[key];
    const status = serverStatus(server);
    const unreachable = status === "unreachable";

    return (
      <div
        key={`server-${server.id}`}
        className="group/server flex items-center"
      >
        <button
          type="button"
          className="text-muted-foreground hover:text-secondary-foreground flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors"
          onClick={() => toggleGroupCollapsed(key)}
        >
          {isCollapsed ? (
            <ChevronRight className="size-3 shrink-0" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )}
          <Server className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{server.name}</span>
          {unreachable && (
            <span className="text-muted-foreground border-border flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] normal-case tracking-wider">
              <Unplug className="size-3" />
              unreachable
            </span>
          )}
          <span
            className={cn(
              "ml-auto size-[7px] shrink-0 rounded-full",
              serverDotClass(server),
            )}
            title={status}
          />
          <span className="text-muted-foreground shrink-0 text-[10px] font-normal tabular-nums">
            {sessionCount}
          </span>
        </button>
        <button
          type="button"
          disabled={unreachable}
          className={cn(
            "text-muted-foreground pointer-coarse:opacity-100 mr-1.5 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity group-hover/server:opacity-100",
            unreachable
              ? "cursor-not-allowed opacity-40"
              : "hover:text-secondary-foreground",
          )}
          title={
            unreachable
              ? `Can't create a session — ${server.name} is unreachable.`
              : `New session on ${server.name}`
          }
          onClick={() => {
            if (!unreachable) openCreateDialog(undefined, undefined, server.id);
          }}
        >
          <Plus className="size-3" />
        </button>
      </div>
    );
  };

  // ---- Org header renderer ----
  const renderOrgHeader = (
    orgName: string | null,
    sessionCount: number,
    serverId: string | null = null,
  ) => {
    const key = orgCollapseKey(serverId, orgName);
    const isCollapsed = !!collapsedGroups[key];
    const label = orgName ?? "Ungrouped";

    return (
      <div key={`org-${key}`} className="group/org flex items-center">
        <button
          type="button"
          className="text-muted-foreground hover:text-secondary-foreground flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors"
          onClick={() => toggleGroupCollapsed(key)}
        >
          {isCollapsed ? (
            <ChevronRight className="size-3 shrink-0" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )}
          <Building2 className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          <span className="text-muted-foreground ml-auto shrink-0 text-[10px] font-normal tabular-nums">
            {sessionCount}
          </span>
        </button>
        {orgName && (
          <button
            type="button"
            className="text-muted-foreground hover:text-secondary-foreground pointer-coarse:opacity-100 mr-1.5 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity group-hover/org:opacity-100"
            title={`New session in ${orgName}`}
            onClick={() =>
              openCreateDialog(orgName, undefined, serverId ?? undefined)
            }
          >
            <Plus className="size-3" />
          </button>
        )}
      </div>
    );
  };

  // ---- Project header renderer ----
  const renderProjectHeader = (
    orgName: string | null,
    projectName: string,
    sessionCount: number,
    serverId: string | null = null,
  ) => {
    const key = projectCollapseKey(serverId, orgName, projectName);
    const isCollapsed = !!collapsedGroups[key];

    return (
      <div key={`proj-${key}`} className="group/proj flex items-center pl-4">
        <button
          type="button"
          className="text-muted-foreground hover:text-secondary-foreground flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs transition-colors"
          onClick={() => toggleGroupCollapsed(key)}
        >
          {isCollapsed ? (
            <ChevronRight className="size-3 shrink-0" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )}
          <Folder className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{projectName}</span>
          <span className="text-muted-foreground ml-auto shrink-0 text-[10px] font-normal tabular-nums">
            {sessionCount}
          </span>
        </button>
        {orgName && (
          <button
            type="button"
            className="text-muted-foreground hover:text-secondary-foreground pointer-coarse:opacity-100 mr-1.5 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity group-hover/proj:opacity-100"
            title={`New session in ${orgName} / ${projectName}`}
            onClick={() =>
              openCreateDialog(orgName, projectName, serverId ?? undefined)
            }
          >
            <Plus className="size-3" />
          </button>
        )}
      </div>
    );
  };

  // ---- Org tree renderer (reused for single-server and per-server subtrees) ----
  // `serverId == null` => single-server (bare collapse keys, unchanged);
  // a non-null serverId namespaces the keys and threads through create prefills.
  const renderOrgTree = (
    orgTree: SessionTree,
    serverId: string | null = null,
  ): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];

    for (const orgGroup of orgTree) {
      const orgKey = orgCollapseKey(serverId, orgGroup.org);
      const orgCollapsed = !!collapsedGroups[orgKey];

      elements.push(
        renderOrgHeader(orgGroup.org, orgGroup.sessionCount, serverId),
      );

      if (!orgCollapsed) {
        for (const projGroup of orgGroup.projects) {
          if (projGroup.project) {
            const projKey = projectCollapseKey(
              serverId,
              orgGroup.org,
              projGroup.project,
            );
            const projCollapsed = !!collapsedGroups[projKey];

            elements.push(
              renderProjectHeader(
                orgGroup.org,
                projGroup.project,
                projGroup.sessions.length,
                serverId,
              ),
            );

            if (!projCollapsed) {
              for (const s of projGroup.sessions) {
                elements.push(
                  <div key={s.id} className="pl-8">
                    {renderSessionRow(s)}
                  </div>,
                );
              }
            }
          } else {
            // Sessions directly under org (no project).
            for (const s of projGroup.sessions) {
              elements.push(
                <div key={s.id} className="pl-4">
                  {renderSessionRow(s)}
                </div>,
              );
            }
          }
        }
      }
    }

    return elements;
  };

  // ---- Single-server grouped list (unchanged behavior). ----
  const renderGroupedList = () => renderOrgTree(tree, null);

  // ---- Multi-server: server -> (org -> project) -> sessions ----
  const renderServerGroupedList = () => {
    const elements: React.ReactNode[] = [];

    for (const group of serverGroups) {
      const { server } = group;
      elements.push(renderServerHeader(server, group.sessionCount));

      const serverCollapsed = !!collapsedGroups[serverCollapseKey(server.id)];
      if (serverCollapsed) continue;

      if (group.grouped) {
        // Per-server org tree (grouped-vs-flat decided per subset, not global).
        elements.push(...renderOrgTree(group.tree, server.id));
      } else {
        for (const s of group.sessions) {
          elements.push(
            <div key={s.id} className="pl-4">
              {renderSessionRow(s)}
            </div>,
          );
        }
      }
    }

    return elements;
  };

  // ---- Flat list renderer (collapsed rail or no grouping) ----
  const renderFlatList = () => {
    const list = grouped ? flatSessions : sessions;
    return list.map((s) => renderSessionRow(s));
  };

  // Org input ref for focusing after datalist selection.
  const createOrgInputRef = useRef<HTMLInputElement>(null);
  const moveOrgInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      {/* Header */}
      <div
        className={cn(
          "border-border flex h-[42px] shrink-0 items-center border-b",
          collapsed ? "justify-center px-0" : "justify-between px-3.5",
          drawer && "h-12",
        )}
      >
        {!collapsed && (
          <span className="brand-shimmer text-xs font-bold uppercase tracking-[0.18em]">
            SPARKLAB
          </span>
        )}
        {/* "New" lives in the header only when there's no account footer to host
            it (the mobile drawer). On desktop it moves into the footer row. */}
        {!showAccountFooter && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size={collapsed ? "icon-xs" : "xs"}
                className={cn(drawer && "h-9 px-3 text-sm")}
                onClick={() => openCreateDialog()}
              >
                <Plus className="size-3.5" />
                {!collapsed && <span>New</span>}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Create a new session</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Session list */}
      {/* Force Radix's internal viewport wrapper (display:table, sizes to the
          longest row's max-content) to block so rows truncate within the
          viewport width instead of overflowing horizontally — otherwise the
          shrink-0 row actions get pushed past the right edge and clipped. */}
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className={cn("space-y-0.5", collapsed ? "p-1" : "p-1.5")}>
          {collapsed
            ? renderFlatList()
            : multiServer
              ? renderServerGroupedList()
              : grouped
                ? renderGroupedList()
                : renderFlatList()}

          {sessions.length === 0 && !collapsed && !multiServer && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Terminal className="text-muted-foreground size-8" />
              <p className="text-muted-foreground text-sm">No sessions yet.</p>
              <Button
                variant="default"
                size="sm"
                className={cn(drawer && "h-11 px-4")}
                onClick={() => openCreateDialog()}
              >
                Create your first session
              </Button>
            </div>
          )}

          {/* "Add server" ghost row — multi-server, expanded sidebar only. */}
          {multiServer && !collapsed && (
            <button
              type="button"
              className="text-muted-foreground hover:text-secondary-foreground mt-1 flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors"
              onClick={() => setAddServerOpen(true)}
            >
              <Plus className="size-3.5 shrink-0" />
              Add server
            </button>
          )}
        </div>
      </ScrollArea>

      {/* Account footer — one 42px line mirroring the header: identity (glyph +
          username) on the left, a compact icon-action group on the right. The
          primary "New" action leads the group as a filled button so it reads as
          primary while sharing the row's icon geometry; the settings gear and
          sign-out follow as ghost icons. Collapsed rail centers the icons. */}
      {showAccountFooter && (
        <>
          <Separator />
          <div
            className={cn(
              "flex h-[42px] shrink-0 items-center",
              collapsed
                ? "justify-center px-0"
                : "justify-between gap-2 px-2.5",
            )}
          >
            {!collapsed && onLogout && (
              <div className="flex min-w-0 items-center gap-2" title={username}>
                <CircleUser className="text-muted-foreground size-4 shrink-0" />
                <span className="text-foreground truncate text-xs font-medium">
                  {username ?? "Signed in"}
                </span>
              </div>
            )}
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="icon-xs"
                    aria-label="New session"
                    onClick={() => openCreateDialog()}
                    className="shrink-0"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  Create a new session
                </TooltipContent>
              </Tooltip>
              {onOpenSettings && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Settings"
                      onClick={onOpenSettings}
                      className="text-muted-foreground hover:text-secondary-foreground shrink-0"
                    >
                      <Settings className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Settings</TooltipContent>
                </Tooltip>
              )}
              {onLogout && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Sign out"
                      onClick={onLogout}
                      className="text-muted-foreground hover:text-secondary-foreground shrink-0"
                    >
                      <LogOut className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {username ? `Sign out (${username})` : "Sign out"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </>
      )}

      {/* Add-server dialog (shared component; also reachable from Settings).
          Mounted only in multi-server mode — its query hooks require a
          QueryClient, and the single-server sidebar has no entry point to it. */}
      {multiServer && (
        <AddServerDialog
          open={addServerOpen}
          onOpenChange={setAddServerOpen}
          onDialogClose={onDialogClose}
        />
      )}

      {/* ---- Create session dialog ---- */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) handleCreateCancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <div className="space-y-3">
              {/* Server selector — multi-server only. Hidden (implicit local)
                  in single-server mode, so the dialog is unchanged there. */}
              {multiServer && (
                <div className="space-y-1.5">
                  <Label
                    htmlFor="create-server"
                    className="text-muted-foreground text-xs"
                  >
                    Server
                  </Label>
                  <div className="border-input flex items-center gap-2 rounded-md border bg-transparent px-3 py-2 text-sm">
                    <Server className="text-muted-foreground size-3.5 shrink-0" />
                    <select
                      id="create-server"
                      value={newServerId}
                      onChange={(e) => setNewServerId(e.target.value)}
                      className="text-foreground w-full bg-transparent outline-none"
                    >
                      {serverGroups.map(({ server }) => {
                        const unreachable =
                          serverStatus(server) === "unreachable";
                        return (
                          <option
                            key={server.id}
                            value={server.id}
                            disabled={unreachable}
                          >
                            {server.name}
                            {unreachable ? " — unreachable" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </div>
              )}
              <Input
                placeholder="Session name (optional)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-org"
                  className="text-muted-foreground text-xs"
                >
                  Organization (optional)
                </Label>
                <Input
                  id="create-org"
                  ref={createOrgInputRef}
                  placeholder="e.g. Acme Corp"
                  value={newOrg}
                  onChange={(e) => {
                    setNewOrg(e.target.value);
                    if (!e.target.value.trim()) setNewProject("");
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  list="create-org-suggestions"
                  maxLength={32}
                />
                <datalist id="create-org-suggestions">
                  {orgSuggestions.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="create-project"
                  className="text-muted-foreground text-xs"
                >
                  Project (optional)
                </Label>
                <Input
                  id="create-project"
                  placeholder="e.g. checkout"
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!newOrg.trim()}
                  list="create-project-suggestions"
                  maxLength={32}
                />
                <datalist id="create-project-suggestions">
                  {createProjectSuggestions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={handleCreateCancel}
              >
                Cancel
              </Button>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---- Delete session alert dialog ---- */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) handleDeleteCancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteTarget?.name ?? deleteTarget?.id}&quot;? This
              kills the running job.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDeleteCancel}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Move/rename dialog ---- */}
      <Dialog
        open={!!moveTarget}
        onOpenChange={(open) => {
          if (!open) handleMoveCancel();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename / Move session</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleMove();
            }}
          >
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label
                  htmlFor="move-name"
                  className="text-muted-foreground text-xs"
                >
                  Name
                </Label>
                <Input
                  id="move-name"
                  value={moveName}
                  onChange={(e) => setMoveName(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="move-org"
                  className="text-muted-foreground text-xs"
                >
                  Organization
                </Label>
                <Input
                  id="move-org"
                  ref={moveOrgInputRef}
                  placeholder="(none)"
                  value={moveOrg}
                  onChange={(e) => {
                    setMoveOrg(e.target.value);
                    if (!e.target.value.trim()) setMoveProject("");
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  list="move-org-suggestions"
                  maxLength={32}
                />
                <datalist id="move-org-suggestions">
                  {orgSuggestions.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="move-project"
                  className="text-muted-foreground text-xs"
                >
                  Project
                </Label>
                <Input
                  id="move-project"
                  placeholder="(none)"
                  value={moveProject}
                  onChange={(e) => setMoveProject(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!moveOrg.trim()}
                  list="move-project-suggestions"
                  maxLength={32}
                />
                <datalist id="move-project-suggestions">
                  {moveProjectSuggestions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={handleMoveCancel}
              >
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
