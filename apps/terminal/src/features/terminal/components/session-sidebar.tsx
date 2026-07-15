"use client";

/**
 * SessionSidebar — the desktop (≥ md) inline sidebar: an <aside> wrapping
 * SessionList, which renders the session header/list AND the signed-in account
 * footer (the footer hosts the primary "New" action on desktop). On mobile the
 * sidebar is replaced by a Sheet drawer in TerminalShell (mobile UX spec §1.2);
 * the `hidden md:flex` classes also guard the pre-hydration frame on small
 * screens.
 */

import { cn } from "@sparklab/ui/lib/utils";
import { ChevronsLeft, ChevronsRight } from "lucide-react";

import { SessionList } from "./session-list";

import type {
  CreateSessionParams,
  UpdateSessionParams,
} from "../hooks/use-sessions";
import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";

interface SessionSidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  /** Registry servers; drives the multi-server sidebar grouping. */
  servers?: ServerInfo[];
  collapsed: boolean;
  onSelectSession: (id: string) => void;
  onCreateSession: (params?: CreateSessionParams) => void;
  onDeleteSession: (id: string) => void;
  onUpdateSession?: (params: UpdateSessionParams) => void;
  onToggleCollapse: () => void;
  /** Called after any dialog closes so the terminal can reclaim focus. */
  onDialogClose?: () => void;
  /** Signed-in username; absent in open mode (dev, auth disabled). */
  username?: string;
  onLogout?: () => void;
  /** Opens the settings dialog (owned by the shell). */
  onOpenSettings?: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  servers,
  collapsed,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onUpdateSession,
  onToggleCollapse,
  onDialogClose,
  username,
  onLogout,
  onOpenSettings,
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
        servers={servers}
        collapsed={collapsed}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onDeleteSession={onDeleteSession}
        onUpdateSession={onUpdateSession}
        onDialogClose={onDialogClose}
        username={username}
        onLogout={onLogout}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}
