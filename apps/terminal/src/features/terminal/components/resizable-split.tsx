"use client";

/**
 * ResizableSplit — hand-rolled N-ary flex split with a draggable divider
 * between each adjacent pair of children (docs/MULTI-WINDOW-PLAN.md D3).
 *
 * - Children get `flex: <ratio> 1 0%` so they grow/shrink proportionally to
 *   their ratio (normalizes rounding for free, unlike a raw percentage
 *   flex-basis).
 * - Each divider is `role="separator"` with `aria-orientation` +
 *   `aria-valuemin/max/now` (cumulative left/top percentage at that
 *   divider), pointer-drag (window-level `pointermove`/`pointerup`, capture
 *   attempted but not required — jsdom doesn't implement
 *   `setPointerCapture`, so it's wrapped in try/catch), and Arrow/Home/End
 *   keyboard resize (D3 a11y requirement).
 * - Live drag position lives in local `dragRatios` state; `onRatiosChange`
 *   fires once on commit (pointerup / keyboard), never per `pointermove` —
 *   `layout.ratios` is persisted to localStorage on every store write, so a
 *   per-frame write would hammer it.
 * - `onDragStateChange(true|false)` brackets the drag — this is the D5
 *   signal `<TerminalPane>`/`XTermComponent` use to coalesce resize frames.
 */

import { cn } from "@sparklab/ui/lib/utils";
import {
  Fragment,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/** Minimum pane size, in px, either axis (~30 cols / a handful of rows). */
export const MIN_PANE_PX = 240;

/** Keyboard nudge step, as a fraction (2%) — Home/End jump to the clamp. */
const KEYBOARD_STEP = 0.02;

/**
 * Pure clamp for a single divider drag inside an N-ary split. Only the pair
 * of ratios adjacent to `dividerIndex` (i and i+1) change; their sum is
 * preserved exactly (so the rest of the split is untouched by construction).
 * `desiredRatio` is the raw, unclamped fraction requested for the pair's
 * first (left/top) member; it's clamped so neither member drops below
 * `minPx` of `totalPx`.
 *
 * Returns a new ratios array, or the SAME `ratios` reference when the pair's
 * combined span can't honor `minPx` at all (a degenerate/zero container size
 * — e.g. jsdom, or a not-yet-laid-out frame) rather than producing NaN or an
 * inverted split.
 */
export function clampDividerDrag(
  ratios: number[],
  dividerIndex: number,
  desiredRatio: number,
  totalPx: number,
  minPx: number = MIN_PANE_PX,
): number[] {
  const a = ratios[dividerIndex];
  const b = ratios[dividerIndex + 1];
  if (a === undefined || b === undefined) return ratios;

  const span = a + b;
  const minRatio = totalPx > 0 ? minPx / totalPx : 0;
  if (span <= 0 || span < minRatio * 2) return ratios;

  const clamped = Math.min(Math.max(desiredRatio, minRatio), span - minRatio);
  if (clamped === a) return ratios;

  const next = [...ratios];
  next[dividerIndex] = clamped;
  next[dividerIndex + 1] = span - clamped;
  return next;
}

/** Cumulative percentage at divider `i` — the natural "value" of a
 * left-to-right (or top-to-bottom) split point, per aria-valuenow's "value
 * along the orientation" semantics. */
function cumulativePercent(ratios: number[], dividerIndex: number): number {
  let sum = 0;
  for (let i = 0; i <= dividerIndex; i++) sum += ratios[i] ?? 0;
  return Math.round(sum * 100);
}

export interface ResizableSplitProps {
  axis: "x" | "y";
  /** length === children.length. */
  ratios: number[];
  onRatiosChange: (ratios: number[]) => void;
  onDragStateChange?: (dragging: boolean) => void;
  children: ReactNode[];
}

export function ResizableSplit({
  axis,
  ratios,
  onRatiosChange,
  onDragStateChange,
  children,
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragRatios, setDragRatios] = useState<number[] | null>(null);
  const latestDragRatiosRef = useRef<number[] | null>(null);

  const activeRatios = dragRatios ?? ratios;

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, dividerIndex: number) => {
      // Only the primary button/touch/pen starts a drag.
      if (event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const totalPx = axis === "x" ? rect.width : rect.height;
      const startPos = axis === "x" ? event.clientX : event.clientY;
      const startRatios = ratios;
      const pointerId = event.pointerId;
      const targetEl = event.currentTarget;

      latestDragRatiosRef.current = null;
      onDragStateChange?.(true);

      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        /* jsdom / unsupported browser — window listeners below still work */
      }

      const handleMove = (moveEvent: PointerEvent) => {
        const pos = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
        const deltaRatio = totalPx > 0 ? (pos - startPos) / totalPx : 0;
        const desired = (startRatios[dividerIndex] ?? 0) + deltaRatio;
        const next = clampDividerDrag(
          startRatios,
          dividerIndex,
          desired,
          totalPx,
        );
        latestDragRatiosRef.current = next;
        setDragRatios(next);
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        try {
          targetEl.releasePointerCapture(pointerId);
        } catch {
          /* noop */
        }
        const finalRatios = latestDragRatiosRef.current ?? startRatios;
        latestDragRatiosRef.current = null;
        setDragRatios(null);
        onDragStateChange?.(false);
        if (finalRatios !== startRatios) onRatiosChange(finalRatios);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [axis, onDragStateChange, onRatiosChange, ratios],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, dividerIndex: number) => {
      const decreaseKey = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const increaseKey = axis === "x" ? "ArrowRight" : "ArrowDown";
      const container = containerRef.current;
      const rect = container?.getBoundingClientRect();
      const totalPx = rect ? (axis === "x" ? rect.width : rect.height) : 0;
      const current = ratios[dividerIndex] ?? 0;

      let next: number[] | null = null;
      if (event.key === decreaseKey) {
        next = clampDividerDrag(
          ratios,
          dividerIndex,
          current - KEYBOARD_STEP,
          totalPx,
        );
      } else if (event.key === increaseKey) {
        next = clampDividerDrag(
          ratios,
          dividerIndex,
          current + KEYBOARD_STEP,
          totalPx,
        );
      } else if (event.key === "Home") {
        next = clampDividerDrag(ratios, dividerIndex, 0, totalPx);
      } else if (event.key === "End") {
        next = clampDividerDrag(ratios, dividerIndex, 1, totalPx);
      }

      if (next && next !== ratios) {
        event.preventDefault();
        onRatiosChange(next);
      }
    },
    [axis, onRatiosChange, ratios],
  );

  return (
    // h-full/w-full (not just flex-1): this root is not always a flex child
    // of a flex parent — at the top of the grid it's a plain block child of
    // terminal-shell.tsx's viewport div — so flex-1 alone would resolve to
    // an "auto" (content-sized) box. h-full/w-full explicitly fills
    // whatever positioned/sized ancestor is actually there; flex-1 stays for
    // the nested case (a <ResizableSplit> as a grid-2x2 inner split, itself
    // wrapped by the flex child div below).
    <div
      ref={containerRef}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-1",
        axis === "x" ? "flex-row" : "flex-col",
      )}
    >
      {children.map((child, i) => (
        <Fragment key={i}>
          {/* `flex` (not just flex-1 on the CHILD): this wrapper must be a
              flex container itself so a <TerminalPane>'s own `flex-1` (or a
              nested <ResizableSplit>'s h-full/w-full) has something to
              size against — a plain block parent ignores flex-grow
              entirely. The inline `flex` shorthand below (from `ratios`)
              still governs how THIS wrapper is sized by the axis-row/col
              parent above. */}
          <div
            className="flex min-h-0 min-w-0 overflow-hidden"
            style={{ flex: `${Math.max(activeRatios[i] ?? 0, 0)} 1 0%` }}
          >
            {child}
          </div>
          {i < children.length - 1 && (
            <div
              aria-orientation={axis === "x" ? "vertical" : "horizontal"}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={cumulativePercent(activeRatios, i)}
              className={cn(
                "border-border hover:bg-accent focus-visible:bg-accent shrink-0 touch-none bg-transparent transition-colors focus-visible:outline-none",
                axis === "x"
                  ? "w-1 cursor-col-resize border-l"
                  : "h-1 cursor-row-resize border-t",
              )}
              onKeyDown={(event) => handleKeyDown(event, i)}
              onPointerDown={(event) => handlePointerDown(event, i)}
              role="separator"
              tabIndex={0}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
