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

const setCanvasDimensions = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): boolean => {
  if (canvas.width === width && canvas.height === height) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return true;
};

interface VirtualCursorState {
  visible: boolean;
  pressed: boolean;
  acknowledged: boolean;
  clientX: number;
  clientY: number;
  label: string;
}

export function InteractiveBrowser({
  connection,
  enabled = true,
  mediaStream = null,
}: {
  connection: BrowserHandoffConnection | null;
  enabled?: boolean;
  mediaStream?: MediaStream | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorLabelRef = useRef<HTMLSpanElement>(null);
  const lastPointRef = useRef({ x: 0, y: 0 });
  const layoutRectRef = useRef<DOMRect | null>(null);
  const cursorFrameRef = useRef<number | null>(null);
  const cursorStateRef = useRef<VirtualCursorState>({
    visible: false,
    pressed: false,
    acknowledged: false,
    clientX: 0,
    clientY: 0,
    label: "",
  });
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldButtonsRef = useRef(new Set<MouseButton>());
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const invalidateLayoutRect = () => {
    layoutRectRef.current = null;
  };
  const scheduleCursorRender = () => {
    if (cursorFrameRef.current !== null) return;
    cursorFrameRef.current = window.requestAnimationFrame(() => {
      cursorFrameRef.current = null;
      // Reuse geometry only for one visual frame so layout shifts that do not
      // emit resize or scroll events cannot leave coordinate mapping stale.
      layoutRectRef.current = null;
      const cursor = cursorRef.current;
      const label = cursorLabelRef.current;
      if (!cursor || !label) return;
      const state = cursorStateRef.current;
      cursor.hidden = !state.visible;
      cursor.dataset.pressed = String(state.pressed);
      cursor.dataset.connected = String(enabledRef.current);
      cursor.dataset.acknowledged = String(state.acknowledged);
      cursor.style.transform = `translate3d(${state.clientX}px, ${state.clientY}px, 0)`;
      label.textContent = state.label;
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const invalidate = () => invalidateLayoutRect();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(invalidate);
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, true);
    window.visualViewport?.addEventListener("resize", invalidate);
    window.visualViewport?.addEventListener("scroll", invalidate);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, true);
      window.visualViewport?.removeEventListener("resize", invalidate);
      window.visualViewport?.removeEventListener("scroll", invalidate);
      layoutRectRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!cursorStateRef.current.visible) return;
    scheduleCursorRender();
  }, [enabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = mediaStream;
    if (mediaStream) void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [mediaStream]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !connection) return;
    const renderer = new LatestFrameRenderer(
      (frame) => createImageBitmap(frame),
      (bitmap) => {
        if (setCanvasDimensions(canvas, bitmap.width, bitmap.height))
          invalidateLayoutRect();
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
      cursorStateRef.current.acknowledged = true;
      cursorStateRef.current.label = `${lastPointRef.current.x}, ${lastPointRef.current.y} ✓`;
      scheduleCursorRender();
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => {
        cursorStateRef.current.acknowledged = false;
        scheduleCursorRender();
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
    return () => {
      scheduler?.dispose();
      if (cursorFrameRef.current !== null)
        window.cancelAnimationFrame(cursorFrameRef.current);
      cursorFrameRef.current = null;
    };
  }, []);

  const send = (input: HandoffInput) => {
    if (!enabled) return;
    schedulerRef.current?.send(input);
  };
  const point = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect =
      layoutRectRef.current ?? event.currentTarget.getBoundingClientRect();
    layoutRectRef.current = rect;
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
    cursorStateRef.current = {
      visible: true,
      pressed,
      acknowledged: false,
      clientX: event.clientX,
      clientY: event.clientY,
      label: enabled ? `${position.x}, ${position.y} …` : "connecting…",
    };
    scheduleCursorRender();
    return position;
  };

  return (
    <>
      <div className="relative flex max-h-full max-w-full items-center justify-center">
        {mediaStream && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label="WebRTC isolated browser video"
            className="max-h-full max-w-full bg-white object-contain shadow-lg"
            onLoadedMetadata={(event) => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              if (
                setCanvasDimensions(
                  canvas,
                  Math.min(MAX_WIDTH, event.currentTarget.videoWidth),
                  Math.min(MAX_HEIGHT, event.currentTarget.videoHeight),
                )
              )
                invalidateLayoutRect();
            }}
          />
        )}
        <canvas
          ref={canvasRef}
          width={MAX_WIDTH}
          height={MAX_HEIGHT}
          tabIndex={0}
          role="application"
          aria-label="Interactive isolated browser"
          aria-disabled={!enabled}
          className={`${mediaStream ? "absolute inset-0 h-full w-full opacity-0" : "max-h-full max-w-full bg-white object-contain shadow-lg"} cursor-none touch-none outline-none focus:ring-2 focus:ring-amber-400 aria-disabled:cursor-wait aria-disabled:opacity-80`}
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
      </div>
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
        <svg
          data-testid="virtual-mouse-arrow"
          viewBox="0 0 24 24"
          className="size-6 origin-[2px_2px] -translate-x-0.5 -translate-y-0.5 drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] transition-transform group-data-[pressed=true]:scale-75"
        >
          <path
            d="M2 2 9.5 21l3.1-7.1 7.4-2.8L2 2Z"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="fill-white stroke-sky-500 transition-colors group-data-[acknowledged=true]:fill-emerald-100 group-data-[connected=false]:fill-red-100 group-data-[pressed=true]:fill-amber-100 group-data-[acknowledged=true]:stroke-emerald-500 group-data-[connected=false]:stroke-red-500 group-data-[pressed=true]:stroke-amber-500"
          />
        </svg>
        <span
          ref={cursorLabelRef}
          className="absolute left-3 top-3 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white"
        />
      </div>
    </>
  );
}
