"use client";

/**
 * TerminalFooter — mini status bar directly below the xterm frame.
 *
 * Quiet, read-only counterpart to the 42px header: 28px tall, muted text,
 * no interactive elements. Shows where the active session lives (server name
 * + reachability dot — reuses the sidebar's dot colors, never destructive
 * red for "couldn't ask"), the current git branch + working-tree status of the
 * session's cwd, and what it is doing (current command), plus the org/project
 * breadcrumb and attached-client count when present.
 *
 * Rendered only while a session is active, so the empty state keeps the
 * full-height pane. Styling: DESIGN.md theme tokens only.
 */

import { cn } from "@sparklab/ui/lib/utils";
import { GitBranch } from "lucide-react";

import { useGitStatus } from "../hooks/use-git-status";
import { serverDotClass, serverStatus } from "../server-grouping";

import type {
  GitStatusResponse,
  ServerInfo,
  SessionInfo,
} from "@sparklab/shared-types";

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

  // Only poll git for a reachable session/server — never an unreachable host.
  const reachable =
    session.reachable !== false &&
    (!server || serverStatus(server) !== "unreachable");
  const { data: git } = useGitStatus(session.id, reachable);
  const showGit = !!git?.isRepo;

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

      {server && showGit && <span aria-hidden="true">·</span>}

      {showGit && <GitSummary git={git} />}

      {(server || showGit) && command && <span aria-hidden="true">·</span>}

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

/** Branch + upstream ahead/behind + staged/unstaged/untracked/conflicted counts.
 *  Each count is shown only when non-zero; a clean tree shows just the branch. */
function GitSummary({ git }: { git: GitStatusResponse }) {
  const branch = git.branch || (git.detached ? "detached" : "—");
  const ahead = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  const staged = git.staged ?? 0;
  const unstaged = git.unstaged ?? 0;
  const untracked = git.untracked ?? 0;
  const conflicted = git.conflicted ?? 0;
  const clean = staged + unstaged + untracked + conflicted === 0;

  return (
    <span
      className="flex min-w-0 shrink items-center gap-1.5"
      title={
        clean
          ? `${branch} · clean`
          : `${branch} · ${staged} staged, ${unstaged} unstaged, ${untracked} untracked${
              conflicted ? `, ${conflicted} conflicted` : ""
            }`
      }
    >
      <span className="flex min-w-0 items-center gap-1">
        <GitBranch className="size-3 shrink-0" />
        <span className="max-w-40 truncate font-mono">{branch}</span>
      </span>

      {(ahead > 0 || behind > 0) && (
        <span className="flex shrink-0 items-center gap-0.5 tabular-nums">
          {ahead > 0 && <span>↑{ahead}</span>}
          {behind > 0 && <span>↓{behind}</span>}
        </span>
      )}

      {clean ? (
        <span className="text-chart-1 shrink-0">✓</span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 tabular-nums">
          {staged > 0 && <span className="text-chart-1">+{staged}</span>}
          {unstaged > 0 && <span className="text-chart-2">~{unstaged}</span>}
          {untracked > 0 && (
            <span className="text-muted-foreground">?{untracked}</span>
          )}
          {conflicted > 0 && (
            <span className="text-destructive">!{conflicted}</span>
          )}
        </span>
      )}
    </span>
  );
}
