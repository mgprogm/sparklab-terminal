"use client";

/** A fast, pane-local MRU terminal switcher; the sidebar remains visible. */

import { cn } from "@sparklab/ui/lib/utils";
import { Check, Search, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { sessionServerId } from "../server-grouping";

import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "-bash"]);

function sessionMatches(
  session: SessionInfo,
  serverName: string,
  query: string,
) {
  const searchText = [
    session.name,
    session.currentCommand,
    session.org,
    session.project,
    serverName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return searchText.includes(query.toLocaleLowerCase());
}

/** Local focus recency wins; live tmux activity is the sensible fallback. */
export function sortSessionsForSwitcher(
  sessions: SessionInfo[],
  recentSessionIds: string[],
) {
  const recency = new Map(recentSessionIds.map((id, index) => [id, index]));
  return [...sessions].sort((a, b) => {
    const aRecent = recency.get(a.id);
    const bRecent = recency.get(b.id);
    if (aRecent !== undefined || bRecent !== undefined) {
      if (aRecent === undefined) return 1;
      if (bRecent === undefined) return -1;
      if (aRecent !== bRecent) return aRecent - bRecent;
    }
    const activityDifference = (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
    if (activityDifference !== 0) return activityDifference;
    const createdDifference = (b.createdAt ?? 0) - (a.createdAt ?? 0);
    if (createdDifference !== 0) return createdDifference;
    return a.name.localeCompare(b.name);
  });
}

interface TerminalSwitcherProps {
  open: boolean;
  sessions: SessionInfo[];
  servers: ServerInfo[];
  activeSessionId: string | null;
  recentSessionIds: string[];
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function TerminalSwitcher({
  open,
  sessions,
  servers,
  activeSessionId,
  recentSessionIds,
  onClose,
  onSelect,
}: TerminalSwitcherProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const serverNames = useMemo(
    () => new Map(servers.map((server) => [server.id, server.name])),
    [servers],
  );
  const sortedSessions = useMemo(
    () => sortSessionsForSwitcher(sessions, recentSessionIds),
    [recentSessionIds, sessions],
  );
  const visibleSessions = useMemo(
    () =>
      sortedSessions.filter((session) => {
        const serverId = sessionServerId(session);
        return sessionMatches(
          session,
          serverNames.get(serverId) ?? serverId,
          query,
        );
      }),
    [query, serverNames, sortedSessions],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlightedIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setHighlightedIndex((index) =>
      Math.min(index, Math.max(0, visibleSessions.length - 1)),
    );
  }, [visibleSessions.length]);

  if (!open) return null;

  const selectHighlighted = () => {
    const session = visibleSessions[highlightedIndex];
    if (session) onSelect(session.id);
  };

  return (
    <div
      className="bg-background/55 absolute inset-0 z-30 flex items-start justify-center p-4 pt-[min(12vh,96px)] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label="Switch terminal"
        aria-modal="true"
        className="border-border bg-popover w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl"
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlightedIndex((index) =>
              Math.min(index + 1, visibleSessions.length - 1),
            );
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlightedIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            selectHighlighted();
          }
        }}
      >
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            ref={inputRef}
            className="placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlightedIndex(0);
            }}
            placeholder="Switch terminal…"
            value={query}
          />
          <kbd className="text-muted-foreground border-border rounded border px-1.5 py-0.5 text-[10px]">
            Esc
          </kbd>
        </div>

        <div className="max-h-[min(56dvh,440px)] overflow-y-auto p-1.5">
          {visibleSessions.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">
              No terminals match “{query}”.
            </p>
          ) : (
            visibleSessions.map((session, index) => {
              const serverId = sessionServerId(session);
              const serverName = serverNames.get(serverId) ?? serverId;
              const isRunning = !SHELLS.has(session.currentCommand);
              const isActive = session.id === activeSessionId;
              return (
                <button
                  key={session.id}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    index === highlightedIndex
                      ? "bg-accent"
                      : "hover:bg-accent/70",
                  )}
                  onClick={() => onSelect(session.id)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  type="button"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      isRunning ? "bg-chart-1" : "bg-muted-foreground",
                    )}
                  />
                  <Terminal className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block truncate text-sm">
                      {session.name}
                    </span>
                    <span className="text-muted-foreground block truncate font-mono text-xs">
                      {serverName} · {session.currentCommand || "shell"}
                    </span>
                  </span>
                  {isActive && (
                    <Check
                      aria-label="Current terminal"
                      className="text-primary size-4 shrink-0"
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
        <footer className="border-border text-muted-foreground flex items-center justify-between border-t px-3 py-2 text-[11px]">
          <span>Most recently active first</span>
          <span>↑↓ navigate · ↵ switch</span>
        </footer>
      </section>
    </div>
  );
}
