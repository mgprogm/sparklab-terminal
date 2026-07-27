// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HandoffInputScheduler } from "../input-scheduler";

describe("HandoffInputScheduler", () => {
  beforeEach(() => vi.useFakeTimers());

  it("sends only the latest pointer move per animation frame", () => {
    let animationCallback: FrameRequestCallback | null = null;
    const output = vi.fn();
    const scheduler = new HandoffInputScheduler(output, {
      requestAnimationFrame: (callback) => {
        animationCallback = callback;
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
      setTimeout,
      clearTimeout,
    });

    scheduler.send({ type: "pointer", action: "move", x: 1, y: 1 });
    scheduler.send({ type: "pointer", action: "move", x: 2, y: 3 });
    expect(output).not.toHaveBeenCalled();
    (animationCallback as FrameRequestCallback | null)?.(0);
    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith({
      type: "pointer",
      action: "move",
      x: 2,
      y: 3,
    });
  });

  it("bounds and coalesces wheel deltas", () => {
    const output = vi.fn();
    const scheduler = new HandoffInputScheduler(output, {
      requestAnimationFrame: vi.fn(),
      cancelAnimationFrame: vi.fn(),
      setTimeout,
      clearTimeout,
    });
    scheduler.send({ type: "wheel", x: 10, y: 20, deltaX: 100, deltaY: 1500 });
    scheduler.send({ type: "wheel", x: 30, y: 40, deltaX: -50, deltaY: 1500 });
    vi.advanceTimersByTime(49);
    expect(output).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(output).toHaveBeenCalledWith({
      type: "wheel",
      x: 30,
      y: 40,
      deltaX: 50,
      deltaY: 2000,
    });
  });

  it("flushes a pending location before click and key events", () => {
    const output = vi.fn();
    const scheduler = new HandoffInputScheduler(output, {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      setTimeout,
      clearTimeout,
    });
    scheduler.send({ type: "pointer", action: "move", x: 7, y: 9 });
    scheduler.send({
      type: "pointer",
      action: "down",
      x: 7,
      y: 9,
      button: "left",
    });
    scheduler.send({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      modifiers: [],
    });
    expect(output.mock.calls.map(([input]) => input)).toEqual([
      { type: "pointer", action: "move", x: 7, y: 9 },
      { type: "pointer", action: "down", x: 7, y: 9, button: "left" },
      {
        type: "key",
        action: "down",
        key: "a",
        code: "KeyA",
        modifiers: [],
      },
    ]);
  });
});
