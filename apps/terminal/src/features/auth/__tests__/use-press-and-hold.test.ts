import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePressAndHold } from "../hooks/use-press-and-hold";

import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";

// jsdom has no PointerEvent and does not populate clientX/pointerId on synthetic
// pointer events, so the gesture logic is exercised here with fabricated events.
// currentTarget stubs the pointer-capture API the hook optional-chains onto.
function pointerEvent(
  overrides: Partial<{
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType: string;
    button: number;
  }> = {},
): ReactPointerEvent {
  const captured: number[] = [];
  const released: number[] = [];
  return {
    clientX: overrides.clientX ?? 0,
    clientY: overrides.clientY ?? 0,
    pointerId: overrides.pointerId ?? 1,
    pointerType: overrides.pointerType ?? "touch",
    button: overrides.button ?? 0,
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: (id: number) => captured.push(id),
      releasePointerCapture: (id: number) => released.push(id),
    },
  } as unknown as ReactPointerEvent;
}

const DURATION = 3000;

function setup(enabled = true) {
  const onComplete = vi.fn();
  const view = renderHook(() =>
    usePressAndHold({ onComplete, durationMs: DURATION, enabled }),
  );
  return { onComplete, view };
}

describe("usePressAndHold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onComplete after an uninterrupted full hold", () => {
    const { onComplete, view } = setup();

    act(() => view.result.current.handlers.onPointerDown(pointerEvent()));
    expect(view.result.current.holding).toBe(true);

    act(() => vi.advanceTimersByTime(DURATION));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(view.result.current.holding).toBe(false);
  });

  it("does not fire if released before the duration", () => {
    const { onComplete, view } = setup();

    act(() => view.result.current.handlers.onPointerDown(pointerEvent()));
    act(() => vi.advanceTimersByTime(DURATION - 100));
    act(() => view.result.current.handlers.onPointerUp(pointerEvent()));
    act(() => vi.advanceTimersByTime(1000));

    expect(onComplete).not.toHaveBeenCalled();
    expect(view.result.current.holding).toBe(false);
  });

  it("cancels when the pointer drifts beyond the move tolerance", () => {
    const { onComplete, view } = setup();

    act(() =>
      view.result.current.handlers.onPointerDown(
        pointerEvent({ clientX: 100, clientY: 100 }),
      ),
    );
    // 20px away (> 12px tolerance) -> cancel.
    act(() =>
      view.result.current.handlers.onPointerMove(
        pointerEvent({ clientX: 120, clientY: 100 }),
      ),
    );
    act(() => vi.advanceTimersByTime(DURATION));

    expect(onComplete).not.toHaveBeenCalled();
    expect(view.result.current.holding).toBe(false);
  });

  it("keeps holding through small jitter within tolerance", () => {
    const { onComplete, view } = setup();

    act(() =>
      view.result.current.handlers.onPointerDown(
        pointerEvent({ clientX: 100, clientY: 100 }),
      ),
    );
    // 5px away (< 12px tolerance) -> still holding.
    act(() =>
      view.result.current.handlers.onPointerMove(
        pointerEvent({ clientX: 103, clientY: 104 }),
      ),
    );
    expect(view.result.current.holding).toBe(true);

    act(() => vi.advanceTimersByTime(DURATION));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointercancel (interrupted gesture)", () => {
    const { onComplete, view } = setup();

    act(() => view.result.current.handlers.onPointerDown(pointerEvent()));
    act(() => view.result.current.handlers.onPointerCancel(pointerEvent()));
    act(() => vi.advanceTimersByTime(DURATION));

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("ignores a non-primary mouse button", () => {
    const { onComplete, view } = setup();

    act(() =>
      view.result.current.handlers.onPointerDown(
        pointerEvent({ pointerType: "mouse", button: 2 }),
      ),
    );
    expect(view.result.current.holding).toBe(false);

    act(() => vi.advanceTimersByTime(DURATION));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("no-ops entirely when disabled", () => {
    const { onComplete, view } = setup(false);

    act(() => view.result.current.handlers.onPointerDown(pointerEvent()));
    expect(view.result.current.holding).toBe(false);

    act(() => vi.advanceTimersByTime(DURATION));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("suppresses the context menu (long-press callout)", () => {
    const { view } = setup();
    const e = { preventDefault: vi.fn() } as unknown as MouseEvent;
    act(() => view.result.current.handlers.onContextMenu(e));
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
