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
                <button
                  type="button"
                  onClick={() => {
                    if (s.id !== activeSessionId) onSelectSession(s.id);
                  }}
                  className={cn(
                    "pointer-coarse:py-3 group flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition-colors",
                    collapsed && "justify-center px-0 py-2",
                    s.id === activeSessionId
                      ? "border-l-primary bg-secondary border-l-2"
                      : "hover:bg-accent border-l-2 border-l-transparent",
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

                  {/* Name + command */}
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
                      {s.currentCommand && (
                        <span className="text-muted-foreground block truncate font-mono text-xs">
                          {s.currentCommand}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Delete button — always visible + enlarged on touch (B4/B10) */}
                  {!collapsed && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:bg-destructive/20 hover:text-destructive pointer-coarse:p-2.5 pointer-coarse:opacity-100 shrink-0 rounded-sm p-1 opacity-0 transition-all group-hover:opacity-100"
                      title="Delete session (kills the running job)"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(s);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </button>
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
