"use client";

/**
 * TerminalPane — one pane of the multi-window terminal grid
 * (docs/MULTI-WINDOW-PLAN.md §3b, D10, D11).
 *
 * D10 is non-negotiable: in `single` mode (multiPane === false) this
 * component returns a bare fragment — the exact same subtree
 * terminal-shell.tsx rendered directly before this feature (one
 * `<DynamicXTerm>` or the plain empty-state text, followed by the
 * reconnecting/unreachable overlays) with NO extra wrapper `<div>`, no
 * `data-*` attributes, no focus ring, no pointer-focus handler — there is
 * exactly one pane and it is always focused, so none of that chrome has
 * anything to do. `BrowserViewOverlay` (z-20) still visually wins over
 * these (z-10) overlays regardless of DOM position, since it sits at a
 * higher z-index at the shell level — see terminal-shell.tsx.
 *
 * In multi-pane mode the pane gets a slim ~26px chrome strip (D11): focus
 * affordance + session name + status dot + a session-picker dropdown
 * (greys out sessions already shown in another pane, D4) + a close button.
 */

import { parseSessionRef } from "@sparklab/shared-types";
import { Button } from "@sparklab/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import { cn } from "@sparklab/ui/lib/utils";
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { DynamicXTerm } from "./dynamic-xterm";
import { isServerUnreachable, sessionServerId } from "../server-grouping";

import type { TerminalHandle } from "./xterm";
import type { ConnectionStatus } from "../connection";
import type { ModifierSnapshot } from "../keys";
import type { PaneState } from "../store";
import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";
import type { RefObject } from "react";

function connectionDotClass(state: ConnectionStatus): string {
  return cn(
    "size-[7px] shrink-0 rounded-full",
    state === "connected" && "bg-chart-1",
    state === "reconnecting" && "bg-chart-2",
    state === "disconnected" && "bg-destructive",
  );
}

interface SessionPickerMenuProps {
  pane: PaneState;
  panes: PaneState[];
  sessions: SessionInfo[];
  onPick: (sessionId: string) => void;
  trigger: ReactNode;
}

/** D4: greys out (disables) any session already shown in another pane. */
function SessionPickerMenu({
  pane,
  panes,
  sessions,
  onPick,
  trigger,
}: SessionPickerMenuProps) {
  const shownElsewhere = new Set(
    panes
      .filter((p) => p.id !== pane.id && p.sessionId)
      .map((p) => p.sessionId as string),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {sessions.length === 0 ? (
          <div className="text-muted-foreground px-2 py-1.5 text-xs">
            No sessions yet.
          </div>
        ) : (
          sessions.map((session) => {
            const disabled = shownElsewhere.has(session.id);
            return (
              <DropdownMenuItem
                key={session.id}
                className={cn(disabled && "text-muted-foreground")}
                disabled={disabled}
                onSelect={() => onPick(session.id)}
              >
                <Terminal className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{session.name}</span>
                {session.id === pane.sessionId && (
                  <Check className="size-3.5" />
                )}
                {disabled && session.id !== pane.sessionId && (
                  <span className="text-[10px]">shown</span>
                )}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface TerminalPaneProps {
  pane: PaneState;
  /** Full pane list — needed for the "already shown elsewhere" (D4) check. */
  panes: PaneState[];
  focused: boolean;
  /** false renders the D10 bare single-pane subtree; true renders chrome. */
  multiPane: boolean;
  sessions: SessionInfo[];
  servers: ServerInfo[];
  /** True while a divider affecting this pane is being dragged (D5) —
   * threaded straight to XTermComponent's resizeCoalesced prop. */
  dragging: boolean;
  onFocus: () => void;
  onPickSession: (sessionId: string) => void;
  /** Only called in multiPane mode. */
  onClosePane: () => void;
  onRegisterHandle: (paneId: string, handle: TerminalHandle | null) => void;
  modifiersRef: RefObject<ModifierSnapshot | null>;
  onStatusChange: (
    paneId: string,
    state: ConnectionStatus,
    text: string,
  ) => void;
  onSessionError: () => void;
  onAuthError: () => void;
}

export function TerminalPane({
  pane,
  panes,
  focused,
  multiPane,
  sessions,
  servers,
  dragging,
  onFocus,
  onPickSession,
  onClosePane,
  onRegisterHandle,
  modifiersRef,
  onStatusChange,
  onSessionError,
  onAuthError,
}: TerminalPaneProps) {
  const [status, setStatus] = useState<{
    state: ConnectionStatus;
    text: string;
  }>({ state: "disconnected", text: "idle" });

  const handleStatusChange = useCallback(
    (state: ConnectionStatus, text: string) => {
      setStatus({ state, text });
      onStatusChange(pane.id, state, text);
    },
    [onStatusChange, pane.id],
  );

  const meta = sessions.find((s) => s.id === pane.sessionId);
  const serverId = meta
    ? sessionServerId(meta)
    : pane.sessionId
      ? parseSessionRef(pane.sessionId).serverId
      : null;
  const server = serverId ? servers.find((s) => s.id === serverId) : undefined;
  const unreachable = !!server && isServerUnreachable(server);
  const serverName = server?.name ?? serverId ?? "the server";

  const terminal = pane.sessionId ? (
    <DynamicXTerm
      sessionId={pane.sessionId}
      paneId={pane.id}
      onRegisterHandle={onRegisterHandle}
      onStatusChange={handleStatusChange}
      onSessionError={onSessionError}
      onAuthError={onAuthError}
      modifiersRef={modifiersRef}
      resizeCoalesced={dragging}
    />
  ) : multiPane ? (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-muted-foreground text-xs">No session in this pane.</p>
      <SessionPickerMenu
        onPick={onPickSession}
        pane={pane}
        panes={panes}
        sessions={sessions}
        trigger={
          <Button size="sm" variant="outline">
            Pick a session
          </Button>
        }
      />
    </div>
  ) : (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground">No session selected.</p>
    </div>
  );

  const overlays = (
    <>
      {pane.sessionId && !unreachable && status.state === "reconnecting" && (
        <div className="bg-background/80 absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center backdrop-blur-sm">
          <Loader2 className="text-muted-foreground size-6 animate-spin" />
          <p className="text-muted-foreground text-xs">{status.text}</p>
        </div>
      )}
      {pane.sessionId && unreachable && (
        <div className="bg-background/80 absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center backdrop-blur-sm">
          <Unplug className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm">
            Can&apos;t reach {serverName}.
          </p>
          <p className="text-muted-foreground text-xs">
            The session is still running there. Reconnecting…
          </p>
        </div>
      )}
    </>
  );

  if (!multiPane) {
    // D10: byte-identical to today's single-pane subtree — no wrapper.
    return (
      <>
        {terminal}
        {overlays}
      </>
    );
  }

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        focused && "ring-ring z-[1] ring-1 ring-inset",
      )}
      data-pane-id={pane.id}
      data-testid="terminal-pane"
      onPointerDownCapture={onFocus}
    >
      <div
        className={cn(
          "border-border flex h-[26px] shrink-0 items-center gap-1.5 border-b px-2 text-xs",
          focused && "bg-accent/60",
        )}
      >
        <span className={connectionDotClass(status.state)} />
        <span className="text-foreground min-w-0 flex-1 truncate">
          {meta?.name ?? (pane.sessionId ? pane.sessionId : "no session")}
        </span>
        <SessionPickerMenu
          onPick={onPickSession}
          pane={pane}
          panes={panes}
          sessions={sessions}
          trigger={
            <button
              aria-label="Change session"
              className="text-muted-foreground hover:text-foreground shrink-0"
              type="button"
            >
              <ChevronsUpDown className="size-3.5" />
            </button>
          }
        />
        <button
          aria-label="Close pane"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={onClosePane}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {terminal}
        {overlays}
      </div>
    </div>
  );
}
