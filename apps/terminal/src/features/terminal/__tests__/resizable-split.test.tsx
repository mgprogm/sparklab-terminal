/**
 * Tests for <ResizableSplit> (docs/MULTI-WINDOW-PLAN.md D3): the pure
 * clampDividerDrag helper (the load-bearing math, fully covered without any
 * DOM/pointer simulation) plus a lightweight jsdom pointer-drag smoke test.
 *
 * jsdom (this repo's version, 26) implements neither `PointerEvent` nor
 * `Element.setPointerCapture`/`releasePointerCapture`. The component wraps
 * the capture calls in try/catch (so they're not stubbed here — the
 * fall-through to the window-level pointermove/pointerup listeners is
 * exactly what's being tested), but WITHOUT a `PointerEvent` constructor,
 * `@testing-library/dom`'s `fireEvent.pointerDown/Move/Up` fall back to a
 * bare `Event` that carries none of `clientX`/`button`/`pointerId` — so this
 * file polyfills a minimal `PointerEvent` (a thin `MouseEvent` subclass,
 * scoped to this file only) purely to get real event properties through.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  clampDividerDrag,
  MIN_PANE_PX,
  ResizableSplit,
} from "../components/resizable-split";

class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 0;
  }
}

let hadPointerEvent = true;
beforeAll(() => {
  hadPointerEvent = "PointerEvent" in window;
  if (!hadPointerEvent) {
    // @ts-expect-error -- minimal test-only polyfill, see file doc above.
    window.PointerEvent = PointerEventPolyfill;
  }
});
afterAll(() => {
  if (!hadPointerEvent) {
    // @ts-expect-error -- undo the polyfill so it doesn't leak to other files.
    delete window.PointerEvent;
  }
});

describe("clampDividerDrag", () => {
  it("returns the unclamped ratio when it's within bounds", () => {
    const next = clampDividerDrag([0.5, 0.5], 0, 0.6, 1000);
    expect(next).toEqual([0.6, 0.4]);
  });

  it("clamps to the MIN_PANE_PX floor on the low side", () => {
    // totalPx=1000, minPx=240 -> minRatio=0.24
    const next = clampDividerDrag([0.5, 0.5], 0, 0.01, 1000);
    expect(next[0]).toBeCloseTo(0.24);
    expect(next[1]).toBeCloseTo(0.76);
  });

  it("clamps to the MIN_PANE_PX floor on the high side", () => {
    const next = clampDividerDrag([0.5, 0.5], 0, 0.99, 1000);
    expect(next[0]).toBeCloseTo(0.76);
    expect(next[1]).toBeCloseTo(0.24);
  });

  it("preserves the pair's sum exactly", () => {
    const next = clampDividerDrag([0.3, 0.7], 0, 0.5, 1000);
    expect((next[0] ?? 0) + (next[1] ?? 0)).toBeCloseTo(1.0);
  });

  it("only touches the adjacent pair in a longer ratios array", () => {
    const next = clampDividerDrag([0.2, 0.3, 0.5], 1, 0.5, 1000);
    expect(next[0]).toBe(0.2);
    expect((next[1] ?? 0) + (next[2] ?? 0)).toBeCloseTo(0.8);
  });

  it("skips the pixel-floor clamp (rather than freezing the drag) when totalPx is unknown (0)", () => {
    // A 0px total means the minPx floor can't be expressed as a ratio —
    // minRatio degrades to 0, so the raw desiredRatio (still bounded to the
    // pair's own [0, span] range) passes through instead of NaN/inversion.
    const next = clampDividerDrag([0.5, 0.5], 0, 0.9, 0);
    expect(next[0]).toBeCloseTo(0.9);
    expect((next[0] ?? 0) + (next[1] ?? 0)).toBeCloseTo(1);
  });

  it("returns the same reference when the pair's span can't honor minPx", () => {
    // span=0.1, minPx=240 of a 1000px total -> minRatio=0.24, 2*minRatio=0.48 > span
    const ratios = [0.05, 0.05, 0.9];
    const next = clampDividerDrag(ratios, 0, 0.5, 1000);
    expect(next).toBe(ratios);
  });

  it("returns the same reference for an out-of-range divider index", () => {
    const ratios = [0.5, 0.5];
    expect(clampDividerDrag(ratios, 5, 0.5, 1000)).toBe(ratios);
  });

  it("uses the default MIN_PANE_PX export consistently", () => {
    const next = clampDividerDrag([0.5, 0.5], 0, 0, 2 * MIN_PANE_PX);
    // total is exactly 2*minPx -> minRatio=0.5, span=1 -> the only valid split is 0.5/0.5
    expect(next[0]).toBeCloseTo(0.5);
  });
});

describe("<ResizableSplit>", () => {
  it("renders one separator per adjacent pane pair with correct aria attrs", () => {
    render(
      <ResizableSplit axis="x" onRatiosChange={vi.fn()} ratios={[0.3, 0.7]}>
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </ResizableSplit>,
    );
    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(1);
    expect(separators[0]).toHaveAttribute("aria-orientation", "vertical");
    expect(separators[0]).toHaveAttribute("aria-valuemin", "0");
    expect(separators[0]).toHaveAttribute("aria-valuemax", "100");
    expect(separators[0]).toHaveAttribute("aria-valuenow", "30");
  });

  it("renders N-1 separators for N children (cols-3)", () => {
    render(
      <ResizableSplit
        axis="x"
        onRatiosChange={vi.fn()}
        ratios={[0.33, 0.33, 0.34]}
      >
        {[<div key="a">A</div>, <div key="b">B</div>, <div key="c">C</div>]}
      </ResizableSplit>,
    );
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("uses horizontal aria-orientation for axis=y", () => {
    render(
      <ResizableSplit axis="y" onRatiosChange={vi.fn()} ratios={[0.5, 0.5]}>
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </ResizableSplit>,
    );
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "horizontal",
    );
  });

  it("keyboard: ArrowRight nudges the ratio and commits via onRatiosChange", () => {
    const onRatiosChange = vi.fn();
    render(
      <ResizableSplit
        axis="x"
        onRatiosChange={onRatiosChange}
        ratios={[0.5, 0.5]}
      >
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </ResizableSplit>,
    );
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onRatiosChange).toHaveBeenCalledTimes(1);
    const [next] = onRatiosChange.mock.calls[0] as [number[]];
    expect(next[0]).toBeGreaterThan(0.5);
  });

  it("keyboard: Home jumps toward the low clamp", () => {
    const onRatiosChange = vi.fn();
    render(
      <ResizableSplit
        axis="x"
        onRatiosChange={onRatiosChange}
        ratios={[0.5, 0.5]}
      >
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </ResizableSplit>,
    );
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    expect(onRatiosChange).toHaveBeenCalledTimes(1);
    const [next] = onRatiosChange.mock.calls[0] as [number[]];
    expect(next[0]).toBeLessThan(0.5);
  });

  it("pointer drag: brackets onDragStateChange(true/false) and commits once on pointerup, not per pointermove", () => {
    const onRatiosChange = vi.fn();
    const onDragStateChange = vi.fn();
    render(
      <ResizableSplit
        axis="x"
        onDragStateChange={onDragStateChange}
        onRatiosChange={onRatiosChange}
        ratios={[0.5, 0.5]}
      >
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </ResizableSplit>,
    );
    const separator = screen.getByRole("separator");

    fireEvent.pointerDown(separator, { button: 0, clientX: 0, pointerId: 1 });
    expect(onDragStateChange).toHaveBeenCalledWith(true);

    // Several pointermoves while dragging must NOT call onRatiosChange —
    // that's the D5 coalescing contract (commit only on release).
    fireEvent.pointerMove(window, { clientX: 10 });
    fireEvent.pointerMove(window, { clientX: 20 });
    fireEvent.pointerMove(window, { clientX: 30 });
    expect(onRatiosChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);
    expect(onDragStateChange).toHaveBeenCalledWith(false);
    // jsdom reports a zero-size bounding rect, so totalPx is 0 and the
    // clamp helper degenerately returns the unchanged ratios reference —
    // onRatiosChange is only called when the result actually differs.
    expect(onRatiosChange).not.toHaveBeenCalled();
  });

  it("pointer drag with a real container size: commits the clamped ratio once on pointerup", () => {
    const onRatiosChange = vi.fn();
    const onDragStateChange = vi.fn();
    const { container } = render(
      <ResizableSplit
        axis="x"
        onDragStateChange={onDragStateChange}
        onRatiosChange={onRatiosChange}
        ratios={[0.5, 0.5]}
      >
        {[<div key="a">A</div>, <div key="b">B</div>]}
      </ResizableSplit>,
    );
    const root = container.firstElementChild as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 400,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 600 }); // +100px = +0.1 ratio
    fireEvent.pointerUp(window);

    expect(onRatiosChange).toHaveBeenCalledTimes(1);
    const [next] = onRatiosChange.mock.calls[0] as [number[]];
    expect(next[0]).toBeCloseTo(0.6);
    expect(next[1]).toBeCloseTo(0.4);
  });
});
