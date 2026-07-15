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
  Folder,
  MoreHorizontal,
  Plus,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useAgentStore } from "@/features/agent-chat";

import { groupSessions, hasAnyGrouping, flattenTree } from "../grouping";
import { useTerminalStore } from "../store";

import type { SessionInfo } from "@sparklab/shared-types";
import type {
  CreateSessionParams,
  UpdateSessionParams,
} from "../hooks/use-sessions";

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
}

export function SessionList({
  sessions,
  activeSessionId,
  collapsed = false,
  variant = "sidebar",
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onUpdateSession,
  onDialogClose,
}: SessionListProps) {
  const drawer = variant === "drawer";
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
    (prefillOrg?: string, prefillProject?: string) => {
      setNewName("");
      setNewOrg(prefillOrg ?? "");
      setNewProject(prefillProject ?? "");
      setCreateOpen(true);
    },
    [],
  );

  const handleCreate = () => {
    const params: CreateSessionParams = {};
    if (newName.trim()) params.name = newName.trim();
    if (newOrg.trim()) params.org = newOrg.trim();
    if (newProject.trim()) params.project = newProject.trim();
    onCreateSession(Object.keys(params).length > 0 ? params : undefined);
    setNewName("");
    setNewOrg("");
    setNewProject("");
    setCreateOpen(false);
    onDialogClose?.();
  };

  const handleCreateCancel = () => {
    setNewName("");
    setNewOrg("");
    setNewProject("");
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
    const tooltipLines: string[] = [s.name];
    if (collapsed && s.org) {
      tooltipLines.push(s.project ? `${s.org} / ${s.project}` : s.org);
    }

    return (
      <Tooltip key={s.id}>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "group relative flex w-full items-center rounded-sm transition-colors",
              collapsed && "justify-center",
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
                  </span>
                </div>
              )}
            </button>

            {/* Row actions: move/rename + delete */}
            {!collapsed && (
              <div className="pointer-coarse:opacity-100 mr-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
        {collapsed && (
          <TooltipContent side="right">
            {tooltipLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </TooltipContent>
        )}
      </Tooltip>
    );
  };

  // ---- Org header renderer ----
  const renderOrgHeader = (orgName: string | null, sessionCount: number) => {
    const key = orgName ?? "__ungrouped__";
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
            onClick={() => openCreateDialog(orgName)}
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
  ) => {
    const orgKey = orgName ?? "__ungrouped__";
    const key = `${orgKey}/${projectName}`;
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
            onClick={() => openCreateDialog(orgName, projectName)}
          >
            <Plus className="size-3" />
          </button>
        )}
      </div>
    );
  };

  // ---- Grouped list renderer ----
  const renderGroupedList = () => {
    const elements: React.ReactNode[] = [];

    for (const orgGroup of tree) {
      const orgKey = orgGroup.org ?? "__ungrouped__";
      const orgCollapsed = !!collapsedGroups[orgKey];

      elements.push(renderOrgHeader(orgGroup.org, orgGroup.sessionCount));

      if (!orgCollapsed) {
        for (const projGroup of orgGroup.projects) {
          if (projGroup.project) {
            const projKey = `${orgKey}/${projGroup.project}`;
            const projCollapsed = !!collapsedGroups[projKey];

            elements.push(
              renderProjectHeader(
                orgGroup.org,
                projGroup.project,
                projGroup.sessions.length,
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
          <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
            Sessions
          </span>
        )}
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
      </div>

      {/* Session list */}
      <ScrollArea className="flex-1">
        <div className={cn("space-y-0.5", collapsed ? "p-1" : "p-1.5")}>
          {grouped && !collapsed ? renderGroupedList() : renderFlatList()}

          {sessions.length === 0 && !collapsed && (
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
        </div>
      </ScrollArea>

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
