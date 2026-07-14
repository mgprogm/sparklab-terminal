"use client";

/**
 * SessionSidebar — the desktop (≥ md) inline sidebar: an <aside> wrapping
 * SessionList (whose header line carries the collapse toggle) plus the
 * signed-in footer. On mobile the sidebar is replaced by
 * a Sheet drawer in TerminalShell (mobile UX spec §1.2); the `hidden md:flex`
 * classes also guard the pre-hydration frame on small screens.
 */

import { Button } from "@sparklab/ui/components/ui/button";
import { Separator } from "@sparklab/ui/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import { ChevronsLeft, ChevronsRight, CircleUser, LogOut } from "lucide-react";

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
  /** Signed-in username; absent in open mode (dev, auth disabled). */
  username?: string;
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
  username,
  onLogout,
}: SessionSidebarProps) {
  return (
    <aside
      className={cn(
        "border-border bg-background relative hidden h-full flex-col border-r transition-[width,flex-basis] duration-0 md:flex",
        collapsed ? "w-[52px] flex-[0_0_52px]" : "w-[248px] flex-[0_0_248px]",
      )}
    >
      {/* Collapse toggle — a small round button STRADDLING the sidebar's
          right border, vertically centered on the 42px header line. */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="border-border bg-background text-muted-foreground hover:bg-accent hover:text-secondary-foreground absolute -right-3 top-[21px] z-20 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border shadow-sm transition-colors"
      >
        {collapsed ? (
          <ChevronsRight className="size-3.5" />
        ) : (
          <ChevronsLeft className="size-3.5" />
        )}
      </button>

      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        collapsed={collapsed}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onDeleteSession={onDeleteSession}
        onDialogClose={onDialogClose}
      />

      {/* Account row — one footer line mirroring the 42px header line:
          identity (glyph + username) on the left, compact icon-only sign-out
          on the right. Collapsed rail centers the sign-out icon alone. */}
      {onLogout && (
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
            {!collapsed && (
              <div className="flex min-w-0 items-center gap-2" title={username}>
                <CircleUser className="text-muted-foreground size-4 shrink-0" />
                <span className="text-foreground truncate text-xs font-medium">
                  {username ?? "Signed in"}
                </span>
              </div>
            )}
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
          </div>
        </>
      )}
    </aside>
  );
}
