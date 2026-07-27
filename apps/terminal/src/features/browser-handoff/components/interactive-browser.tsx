"use client";

import { useEffect, useRef } from "react";

import { LatestFrameRenderer } from "../frame-renderer";
import { HandoffInputScheduler } from "../input-scheduler";

import type { BrowserHandoffConnection } from "../connection";
import type { HandoffInput } from "../protocol";
import type React from "react";

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;

type MouseButton = "left" | "middle" | "right";

const buttonName = (button: number, buttons: number): MouseButton | null =>
  button === 0
    ? "left"
    : button === 1
      ? "middle"
      : button === 2
        ? "right"
        : buttons & 1
          ? "left"
          : buttons & 4
            ? "middle"
            : buttons & 2
              ? "right"
              : button < 3
                ? "left"
                : null;

const pressedButtons = (buttons: number): MouseButton[] => {
  const active: MouseButton[] = [];
  if (buttons & 1) active.push("left");
  if (buttons & 4) active.push("middle");
  if (buttons & 2) active.push("right");
  return active;
};

const clickCount = (detail: number): number =>
  Math.max(1, Math.min(3, Math.trunc(detail) || 1));

const modifiers = (
  event: React.KeyboardEvent,
): ("Alt" | "Control" | "Meta" | "Shift")[] => {
  const active: ("Alt" | "Control" | "Meta" | "Shift")[] = [];
  if (event.altKey) active.push("Alt");
  if (event.ctrlKey) active.push("Control");
  if (event.metaKey) active.push("Meta");
  if (event.shiftKey) active.push("Shift");
  return active;
};

const isClipboardShortcut = (event: React.KeyboardEvent): boolean =>
  ((event.ctrlKey || event.metaKey) &&
    ["KeyC", "KeyV", "KeyX"].includes(event.code)) ||
  (event.shiftKey && event.code === "Insert");

export function InteractiveBrowser({
  connection,
  enabled = true,
}: {
  connection: BrowserHandoffConnection | null;
  enabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorLabelRef = useRef<HTMLSpanElement>(null);
  const lastPointRef = useRef({ x: 0, y: 0 });
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldButtonsRef = useRef(new Set<MouseButton>());
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !connection) return;
    const renderer = new LatestFrameRenderer(
      (frame) => createImageBitmap(frame),
      (bitmap) => {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      },
    );
    connection.setFrameHandler((frame) => renderer.enqueue(frame));
    return () => {
      connection.setFrameHandler(null);
      renderer.dispose();
    };
  }, [connection]);

  useEffect(() => {
    if (!connection) return;
    // v1 ACKs deliberately contain only the input kind. A move ACK therefore
    // looks the same as down/up and proves CDP completion, not that a page
    // element received focus or changed. Keep richer diagnostics free of
    // coordinates and typed values; see docs/BROWSER-HANDOFF-OPERATIONS.md.
    connection.setInputAckHandler?.((inputType) => {
      if (inputType !== "pointer" && inputType !== "wheel") return;
      const cursor = cursorRef.current;
      const label = cursorLabelRef.current;
      if (!cursor || !label) return;
      cursor.dataset.acknowledged = "true";
      label.textContent = `${lastPointRef.current.x}, ${lastPointRef.current.y} ✓`;
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => {
        cursor.dataset.acknowledged = "false";
      }, 350);
    });
    return () => {
      connection.setInputAckHandler?.(null);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    };
  }, [connection]);

  const schedulerRef = useRef<HandoffInputScheduler | null>(null);
  if (!schedulerRef.current)
    schedulerRef.current = new HandoffInputScheduler((input) =>
      connectionRef.current?.send(input),
    );
  useEffect(() => {
    const scheduler = schedulerRef.current;
    return () => scheduler?.dispose();
  }, []);

  const send = (input: HandoffInput) => {
    if (!enabled) return;
    schedulerRef.current?.send(input);
  };
  const point = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          MAX_WIDTH,
          Math.round(
            ((event.clientX - rect.left) / rect.width) *
              event.currentTarget.width,
          ),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          MAX_HEIGHT,
          Math.round(
            ((event.clientY - rect.top) / rect.height) *
              event.currentTarget.height,
          ),
        ),
      ),
    };
  };
  const moveVirtualCursor = (
    event: React.MouseEvent<HTMLCanvasElement>,
    pressed: boolean,
  ) => {
    const position = point(event);
    lastPointRef.current = position;
    const cursor = cursorRef.current;
    const label = cursorLabelRef.current;
    if (cursor) {
      cursor.hidden = false;
      cursor.dataset.pressed = String(pressed);
      cursor.dataset.connected = String(enabled);
      cursor.dataset.acknowledged = "false";
      cursor.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
    }
    if (label)
      label.textContent = enabled
        ? `${position.x}, ${position.y} …`
        : "connecting…";
    return position;
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width={MAX_WIDTH}
        height={MAX_HEIGHT}
        tabIndex={0}
        role="application"
        aria-label="Interactive isolated browser"
        aria-disabled={!enabled}
        className="max-h-full max-w-full cursor-none touch-none bg-white object-contain shadow-lg outline-none focus:ring-2 focus:ring-amber-400 aria-disabled:cursor-wait aria-disabled:opacity-80"
        onPointerMove={(event) =>
          send({
            type: "pointer",
            action: "move",
            ...moveVirtualCursor(event, event.buttons !== 0),
            buttons: pressedButtons(event.buttons),
          })
        }
        onPointerDown={(event) => {
          const button = buttonName(event.button, event.buttons);
          if (!button) return;
          event.currentTarget.focus();
          heldButtonsRef.current.add(button);
          send({
            type: "pointer",
            action: "down",
            ...moveVirtualCursor(event, true),
            button,
            buttons: [...heldButtonsRef.current],
            clickCount: clickCount(event.detail),
          });
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Mouse input still works when pointer capture is unavailable.
          }
        }}
        onPointerUp={(event) => {
          const button =
            buttonName(event.button, event.buttons) ??
            (heldButtonsRef.current.size === 1
              ? [...heldButtonsRef.current][0]!
              : null);
          if (!button) return;
          heldButtonsRef.current.delete(button);
          send({
            type: "pointer",
            action: "up",
            ...moveVirtualCursor(event, false),
            button,
            buttons: [...heldButtonsRef.current],
            clickCount: clickCount(event.detail),
          });
          try {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            // Best-effort cleanup for browsers without pointer capture support.
          }
        }}
        onPointerCancel={(event) => {
          const buttons = [...heldButtonsRef.current];
          heldButtonsRef.current.clear();
          for (const button of buttons)
            send({
              type: "pointer",
              action: "up",
              ...moveVirtualCursor(event, false),
              button,
              buttons: [],
              clickCount: 1,
            });
        }}
        onWheel={(event) => {
          event.preventDefault();
          send({
            type: "wheel",
            ...moveVirtualCursor(event, false),
            deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
            deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
          });
        }}
        onKeyDown={(event) => {
          event.preventDefault();
          if (isClipboardShortcut(event)) return;
          if (
            !event.key ||
            !event.code ||
            event.key.length > 64 ||
            event.code.length > 64
          )
            return;
          send({
            type: "key",
            action: "down",
            key: event.key,
            code: event.code,
            modifiers: modifiers(event),
          });
        }}
        onKeyUp={(event) => {
          event.preventDefault();
          if (isClipboardShortcut(event)) return;
          if (
            !event.key ||
            !event.code ||
            event.key.length > 64 ||
            event.code.length > 64
          )
            return;
          send({
            type: "key",
            action: "up",
            key: event.key,
            code: event.code,
            modifiers: modifiers(event),
          });
        }}
        onPaste={(event) => event.preventDefault()}
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div
        ref={cursorRef}
        data-testid="virtual-mouse"
        data-pressed="false"
        data-connected={String(enabled)}
        data-acknowledged="false"
        hidden
        className="group pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
        aria-hidden="true"
      >
        <div className="size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-400 bg-sky-400/20 shadow-[0_0_0_2px_rgba(0,0,0,0.6)] transition-transform group-data-[pressed=true]:scale-75 group-data-[acknowledged=true]:border-emerald-400 group-data-[connected=false]:border-red-400 group-data-[pressed=true]:border-amber-400 group-data-[acknowledged=true]:bg-emerald-400/30 group-data-[pressed=true]:bg-amber-400/40" />
        <span
          ref={cursorLabelRef}
          className="absolute left-3 top-3 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white"
        />
      </div>
    </>
  );
}
