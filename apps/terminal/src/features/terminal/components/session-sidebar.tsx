"use client";

/**
 * SessionSidebar — the desktop (≥ md) inline sidebar: an <aside> wrapping
 * SessionList plus the collapse toggle. On mobile the sidebar is replaced by
 * a Sheet drawer in TerminalShell (mobile UX spec §1.2); the `hidden md:flex`
 * classes also guard the pre-hydration frame on small screens.
 */

import { Separator } from "@sparklab/ui/components/ui/separator";
import { cn } from "@sparklab/ui/lib/utils";
import { ChevronsLeft, ChevronsRight, LogOut } from "lucide-react";

import { SessionList } from "./session-list";

import type { SessionInfo } from "@sparklab/shared-types";

interface SessionSidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  collapsed: boolean;
  onSelectSession: (id: string) => void;
  onCreateSession: (name?: string) => void;
  onDeleteSession: (id: string) => void;
  onToggleCollapse: () => void;
  /** Called after any dialog closes so the terminal can reclaim focus. */
  onDialogClose?: () => void;
  onLogout?: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  collapsed,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onToggleCollapse,
  onDialogClose,
  onLogout,
}: SessionSidebarProps) {
  return (
    <aside
      className={cn(
        "border-border bg-background hidden h-full flex-col border-r transition-[width,flex-basis] duration-0 md:flex",
        collapsed ? "w-[52px] flex-[0_0_52px]" : "w-[248px] flex-[0_0_248px]",
      )}
    >
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        collapsed={collapsed}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onDeleteSession={onDeleteSession}
        onDialogClose={onDialogClose}
      />

      <Separator />

      {onLogout && (
        <button
          type="button"
          onClick={onLogout}
          aria-label="Sign out"
          className="border-border text-muted-foreground hover:bg-accent hover:text-secondary-foreground flex h-[38px] w-full items-center justify-center gap-2 border-t bg-transparent text-xs font-medium tracking-wider transition-colors"
        >
          <LogOut className="size-3.5" />
          {!collapsed && <span>Sign out</span>}
        </button>
      )}

      {/* Collapse toggle (desktop-only affordance) */}
      <button
        type="button"
        className="border-border text-muted-foreground hover:bg-accent hover:text-secondary-foreground flex h-[38px] items-center justify-center gap-2 border-t bg-transparent text-xs font-medium tracking-wider transition-colors"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <ChevronsRight className="size-3.5" />
        ) : (
          <>
            <ChevronsLeft className="size-3.5" />
            <span>Collapse</span>
          </>
        )}
      </button>
    </aside>
  );
}
