"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PointerEvent as ReactPointerEvent, MouseEvent } from "react";

/**
 * Press-and-hold gesture (mobile stealth reveal on the login screen).
 *
 * Fires `onComplete` only after the pointer has been held down continuously for
 * `durationMs`. The hold is cancelled — and `onComplete` never fires — if the
 * pointer is released, cancelled by the OS/gesture system, leaves the element,
 * or drifts more than `MOVE_TOLERANCE_PX` from where it started (so a scroll or
 * swipe never counts as a hold).
 *
 * Completion uses a single `setTimeout` (not rAF) so it is deterministic under
 * fake timers in tests; the visual fill is driven separately off `holding` via
 * a CSS transition. Pointer capture keeps events flowing to the origin element
 * even if the finger strays; `setPointerCapture`/`releasePointerCapture` are
 * optional-chained because jsdom doesn't implement them.
 */

const MOVE_TOLERANCE_PX = 12;

interface UsePressAndHoldParams {
  /** Called once, after a full, uninterrupted hold. */
  onComplete: () => void;
  /** Hold duration in milliseconds. */
  durationMs: number;
  /** When false the gesture is inert (handlers no-op). */
  enabled?: boolean;
}

interface PressAndHoldHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onPointerLeave: (e: ReactPointerEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function usePressAndHold({
  onComplete,
  durationMs,
  enabled = true,
}: UsePressAndHoldParams): {
  holding: boolean;
  handlers: PressAndHoldHandlers;
} {
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const captureRef = useRef<{ el: Element; id: number } | null>(null);
  // Keep the latest callback without re-binding handlers each render.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const cap = captureRef.current;
    if (cap) {
      try {
        cap.el.releasePointerCapture?.(cap.id);
      } catch {
        // capture may already be gone (pointercancel); ignore.
      }
      captureRef.current = null;
    }
    startRef.current = null;
    setHolding(false);
  }, []);

  // Clear any live timer/capture if the component unmounts mid-hold.
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!enabled) return;
      // Only the primary contact: any touch/pen, or the left mouse button.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Suppress the native text-selection / drag that a long press starts.
      e.preventDefault();
      startRef.current = { x: e.clientX, y: e.clientY };
      const el = e.currentTarget;
      try {
        el.setPointerCapture?.(e.pointerId);
        captureRef.current = { el, id: e.pointerId };
      } catch {
        captureRef.current = null;
      }
      setHolding(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        cancel();
        onCompleteRef.current();
      }, durationMs);
    },
    [enabled, durationMs, cancel],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancel();
    },
    [cancel],
  );

  const onContextMenu = useCallback((e: MouseEvent) => {
    // A long press raises the context menu / iOS callout, which would abort the
    // hold; suppress it so the gesture can complete.
    e.preventDefault();
  }, []);

  return {
    holding,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu,
    },
  };
}
