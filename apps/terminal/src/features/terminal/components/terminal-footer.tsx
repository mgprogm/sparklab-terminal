"use client";

/**
 * TerminalFooter — mini status bar directly below the xterm frame.
 *
 * Quiet, read-only counterpart to the 42px header: 28px tall, muted text,
 * no interactive elements. Shows where the active session lives (server name
 * + reachability dot — reuses the sidebar's dot colors, never destructive
 * red for "couldn't ask") and what it is doing (current command), plus the
 * org/project breadcrumb and attached-client count when present.
 *
 * Rendered only while a session is active, so the empty state keeps the
 * full-height pane. Styling: DESIGN.md theme tokens only.
 */

import { cn } from "@sparklab/ui/lib/utils";

import { serverDotClass } from "../server-grouping";

import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";

export function TerminalFooter({
  session,
  server,
}: {
  session: SessionInfo;
  /** Registry entry for the session's server; undefined while servers load. */
  server?: ServerInfo;
}) {
  const command = session.currentCommand || null;
  const clients = session.attachedClients ?? 0;
  const breadcrumb = session.org
    ? session.project
      ? `${session.org} / ${session.project}`
      : session.org
    : null;

  return (
    <div className="border-border text-muted-foreground flex h-7 min-w-0 shrink-0 items-center gap-2 border-t px-4 text-[11px]">
      {server && (
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          <span
            className={cn("size-[7px] rounded-full", serverDotClass(server))}
          />
          <span className="max-w-40 truncate">{server.name}</span>
        </span>
      )}

      {server && command && <span aria-hidden="true">·</span>}

      {command && (
        <span className="min-w-0 truncate font-mono" title={command}>
          {command}
        </span>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {breadcrumb && <span className="max-w-56 truncate">{breadcrumb}</span>}
        {clients > 1 && <span className="tabular-nums">{clients} clients</span>}
      </span>
    </div>
  );
}
