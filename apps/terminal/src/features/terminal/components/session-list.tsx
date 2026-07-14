"use client";

/**
 * SessionList — the session-list content (header + list + create/delete
 * dialogs), extracted from SessionSidebar (mobile UX spec §1.2/§6.6) so it
 * can be rendered both inside the desktop <aside> and inside the mobile
 * drawer (Sheet). Touch-target and delete-visibility fixes (spec §4.4) live
 * here.
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
import { Input } from "@sparklab/ui/components/ui/input";
import { ScrollArea } from "@sparklab/ui/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import { Plus, Trash2, Terminal } from "lucide-react";
import { useState } from "react";

import type { SessionInfo } from "@sparklab/shared-types";

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

export interface SessionListProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  /** Desktop-only collapsed (icon rail) mode. The mobile drawer never collapses. */
  collapsed?: boolean;
  /** "drawer" enlarges touch targets for the mobile Sheet. */
  variant?: "sidebar" | "drawer";
  onSelectSession: (id: string) => void;
  onCreateSession: (name?: string) => void;
  onDeleteSession: (id: string) => void;
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
  onDialogClose,
}: SessionListProps) {
  const drawer = variant === "drawer";

  // ---- Create dialog state ----
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  // ---- Delete dialog state ----
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);

  const handleCreate = () => {
    onCreateSession(newName.trim() || undefined);
    setNewName("");
    setCreateOpen(false);
    onDialogClose?.();
  };

  const handleCreateCancel = () => {
    setNewName("");
    setCreateOpen(false);
    onDialogClose?.();
  };

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
              onClick={() => setCreateOpen(true)}
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
          {sessions.map((s) => (
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
                  {/* Row select button — covers the content area (no nesting issue) */}
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
                          {/* B2: Status badge — plain text (not tooltip-only,
                              mobile spec). Command truncates first; the badge
                              never does. */}
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

                  {/* Delete button — true sibling, not nested inside select button */}
                  {!collapsed && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:bg-destructive/20 hover:text-destructive pointer-coarse:p-2.5 pointer-coarse:opacity-100 mr-1.5 shrink-0 rounded-sm p-1 opacity-0 transition-all group-hover:opacity-100"
                      title="Delete session (kills the running job)"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(s);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right">{s.name}</TooltipContent>
              )}
            </Tooltip>
          ))}

          {sessions.length === 0 && !collapsed && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Terminal className="text-muted-foreground size-8" />
              <p className="text-muted-foreground text-sm">No sessions yet.</p>
              <Button
                variant="default"
                size="sm"
                className={cn(drawer && "h-11 px-4")}
                onClick={() => setCreateOpen(true)}
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
            <Input
              placeholder="Session name (optional)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
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
    </>
  );
}
