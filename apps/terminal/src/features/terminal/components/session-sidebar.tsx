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
  /** True while the very first session-list fetch is in flight. */
  loading?: boolean;
  onSelectSession: (id: string) => void;
  onCreateSession: (params?: CreateSessionParams) => void | Promise<unknown>;
  onDeleteSession: (id: string) => void | Promise<unknown>;
  onUpdateSession?: (params: UpdateSessionParams) => void | Promise<unknown>;
  onToggleCollapse: () => void;
  /** Called after any dialog closes so the terminal can reclaim focus. */
  onDialogClose?: () => void;
  /** Signed-in username; absent in open mode (dev, auth disabled). */
  username?: string;
  onLogout?: () => void;
  /** True while the sign-out request is in flight. */
  logoutPending?: boolean;
  /** Opens the settings dialog (owned by the shell). */
  onOpenSettings?: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  servers,
  collapsed,
  loading,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onUpdateSession,
  onToggleCollapse,
  onDialogClose,
  username,
  onLogout,
  logoutPending,
  onOpenSettings,
}: SessionSidebarProps) {
  return (
    // Wrapper establishes the positioning context for the collapse toggle and
    // controls the flex-item width/transition — but intentionally has no
    // overflow-hidden so the toggle button can visually extend beyond the right
    // edge without being clipped.
    <div
      className={cn(
        "relative hidden h-full transition-[width,flex-basis] duration-0 md:flex",
        collapsed ? "w-[52px] flex-[0_0_52px]" : "w-[248px] flex-[0_0_248px]",
      )}
    >
      <aside className="border-border bg-background flex h-full w-full flex-col overflow-hidden border-r">
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          servers={servers}
          collapsed={collapsed}
          loading={loading}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onDeleteSession={onDeleteSession}
          onUpdateSession={onUpdateSession}
          onDialogClose={onDialogClose}
          username={username}
          onLogout={onLogout}
          logoutPending={logoutPending}
          onOpenSettings={onOpenSettings}
        />
      </aside>

      {/* Collapse toggle — placed OUTSIDE <aside> so its overflow-hidden does
          not clip this button, which straddles the sidebar's right border.
          The wrapper div's z-index-free relative context lets z-50 on this
          button compete in the root stacking context, painting it above the
          non-positioned terminal-panel header. */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="border-border bg-background text-muted-foreground hover:bg-accent hover:text-secondary-foreground absolute -right-3 top-[21px] z-50 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border shadow-sm transition-colors"
      >
        {collapsed ? (
          <ChevronsRight className="size-3.5" />
        ) : (
          <ChevronsLeft className="size-3.5" />
        )}
      </button>
    </div>
  );
}
