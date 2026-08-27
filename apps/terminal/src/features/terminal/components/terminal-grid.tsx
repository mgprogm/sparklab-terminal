"use client";

/**
 * TerminalGrid — renders the mode-appropriate tree of <ResizableSplit> /
 * <TerminalPane> for the current layout (docs/MULTI-WINDOW-PLAN.md §3c).
 *
 * | mode       | tree                                                           |
 * | ---------- | -------------------------------------------------------------- |
 * | single     | <TerminalPane pane={panes[0]}/> (no split, no chrome)          |
 * | cols-2     | <ResizableSplit axis="x" ratios=[r,1-r]> 2 panes                |
 * | rows-2     | <ResizableSplit axis="y"> 2 panes                                |
 * | cols-3     | <ResizableSplit axis="x" ratios=[a,b,c]> 3 panes                 |
 * | grid-2x2   | <ResizableSplit axis="y"> of two <ResizableSplit axis="x">       |
 *
 * Mobile (D9): force-collapses to a single bare pane showing the FOCUSED
 * pane's session, regardless of the stored `layout.mode` — the layout
 * itself is left untouched in the store so it re-expands when the viewport
 * grows again. Never call setLayoutMode() here.
 *
 * Owns the shared `dragging` boolean (D5) — whichever <ResizableSplit>'s
 * onDragStateChange most recently fired — and threads it to every pane as
 * `resizeCoalesced`.
 */

import { useCallback, useState } from "react";

import { ResizableSplit } from "./resizable-split";
import { TerminalPane } from "./terminal-pane";
import { useTerminalStore } from "../store";

import type { TerminalHandle } from "./xterm";
import type { ConnectionStatus } from "../connection";
import type { ModifierSnapshot } from "../keys";
import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";
import type { RefObject } from "react";

export interface TerminalGridProps {
  sessions: SessionInfo[];
  servers: ServerInfo[];
  paneHandlesRef: RefObject<Map<string, TerminalHandle>>;
  modifiersRef: RefObject<ModifierSnapshot | null>;
  onPaneStatus: (paneId: string, state: ConnectionStatus, text: string) => void;
  onSessionError: () => void;
  onAuthError: () => void;
  /** D9: force single-pane, showing the focused pane's session only. */
  isMobile: boolean;
}

export function TerminalGrid({
  sessions,
  servers,
  paneHandlesRef,
  modifiersRef,
  onPaneStatus,
  onSessionError,
  onAuthError,
  isMobile,
}: TerminalGridProps) {
  const layout = useTerminalStore((s) => s.layout);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const setPaneSession = useTerminalStore((s) => s.setPaneSession);
  const closePane = useTerminalStore((s) => s.closePane);
  const setRatios = useTerminalStore((s) => s.setRatios);

  const [dragging, setDragging] = useState(false);

  // Stable identity (deps: [paneHandlesRef], itself a stable ref object) —
  // an inline function here would be a new identity every render, causing
  // every xterm's registration effect (deps [onRegisterHandle, paneId,
  // focus]) to unregister+re-register on every dragging state change.
  const registerHandle = useCallback(
    (paneId: string, handle: TerminalHandle | null) => {
      if (handle) {
        paneHandlesRef.current.set(paneId, handle);
      } else {
        paneHandlesRef.current.delete(paneId);
      }
    },
    [paneHandlesRef],
  );

  const { panes, focusedPaneId, mode, ratios } = layout;

  const renderPane = (
    paneIndex: number,
    multiPane: boolean,
    dragForPane = dragging,
  ) => {
    const pane = panes[paneIndex];
    if (!pane) return null;
    return (
      <TerminalPane
        dragging={dragForPane}
        focused={pane.id === focusedPaneId}
        key={pane.id}
        modifiersRef={modifiersRef}
        multiPane={multiPane}
        onAuthError={onAuthError}
        onClosePane={() => closePane(pane.id)}
        onFocus={() => focusPane(pane.id)}
        onPickSession={(id) => setPaneSession(pane.id, id)}
        onRegisterHandle={registerHandle}
        onSessionError={onSessionError}
        onStatusChange={onPaneStatus}
        pane={pane}
        panes={panes}
        servers={servers}
        sessions={sessions}
      />
    );
  };

  // D9: mobile always renders a single bare pane for the focused session,
  // regardless of the stored layout.mode (which is left untouched).
  if (isMobile) {
    const focusedIndex = panes.findIndex((p) => p.id === focusedPaneId);
    return renderPane(focusedIndex < 0 ? 0 : focusedIndex, false, false);
  }

  if (mode === "single") {
    return renderPane(0, false);
  }

  if (mode === "cols-2" || mode === "rows-2") {
    return (
      <ResizableSplit
        axis={mode === "cols-2" ? "x" : "y"}
        onDragStateChange={setDragging}
        onRatiosChange={setRatios}
        ratios={ratios}
      >
        {[renderPane(0, true), renderPane(1, true)]}
      </ResizableSplit>
    );
  }

  if (mode === "cols-3") {
    return (
      <ResizableSplit
        axis="x"
        onDragStateChange={setDragging}
        onRatiosChange={setRatios}
        ratios={ratios}
      >
        {[renderPane(0, true), renderPane(1, true), renderPane(2, true)]}
      </ResizableSplit>
    );
  }

  // grid-2x2: an outer row split (axis=y) of two inner column splits
  // (axis=x). `layout.ratios` for this mode is the flat 3-tuple
  // `[rowRatio, topColRatio, bottomColRatio]` (store.ts / D3 decisions doc)
  // — NOT one ratio per pane, since this mode composes two binary splits.
  // Each inner <ResizableSplit> only ever sees/writes its OWN 2-element
  // slice; the write-back below splices that single changed fraction back
  // into the flat 3-tuple, leaving the other two untouched.
  const rowRatio = ratios[0] ?? 0.5;
  const topColRatio = ratios[1] ?? 0.5;
  const bottomColRatio = ratios[2] ?? 0.5;

  return (
    <ResizableSplit
      axis="y"
      onDragStateChange={setDragging}
      onRatiosChange={([a]) =>
        setRatios([a ?? rowRatio, topColRatio, bottomColRatio])
      }
      ratios={[rowRatio, 1 - rowRatio]}
    >
      {[
        <ResizableSplit
          axis="x"
          key="top"
          onDragStateChange={setDragging}
          onRatiosChange={([a]) =>
            setRatios([rowRatio, a ?? topColRatio, bottomColRatio])
          }
          ratios={[topColRatio, 1 - topColRatio]}
        >
          {[renderPane(0, true), renderPane(1, true)]}
        </ResizableSplit>,
        <ResizableSplit
          axis="x"
          key="bottom"
          onDragStateChange={setDragging}
          onRatiosChange={([a]) =>
            setRatios([rowRatio, topColRatio, a ?? bottomColRatio])
          }
          ratios={[bottomColRatio, 1 - bottomColRatio]}
        >
          {[renderPane(2, true), renderPane(3, true)]}
        </ResizableSplit>,
      ]}
    </ResizableSplit>
  );
}
