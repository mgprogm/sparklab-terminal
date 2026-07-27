import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InteractiveBrowser } from "../components/interactive-browser";
import { useBrowserHandoffStore } from "../store";

import type { BrowserHandoffConnection } from "../connection";

describe("InteractiveBrowser", () => {
  beforeEach(() => useBrowserHandoffStore.getState().clear());

  it("sends allowlisted key events but blocks clipboard shortcuts", () => {
    const send = vi.fn();
    const setFrameHandler = vi.fn();
    render(
      <InteractiveBrowser
        connection={
          {
            send,
            setFrameHandler,
          } as unknown as BrowserHandoffConnection
        }
      />,
    );
    const canvas = screen.getByRole("application");
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    fireEvent.keyUp(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    expect(send).not.toHaveBeenCalled();

    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    expect(send).toHaveBeenCalledWith({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      modifiers: [],
    });
  });

  it("prevents paste and file-drop events", () => {
    render(<InteractiveBrowser connection={null} />);
    const canvas = screen.getByRole("application");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(paste);
    canvas.dispatchEvent(drop);
    expect(paste.defaultPrevented).toBe(true);
    expect(drop.defaultPrevented).toBe(true);
  });

  it("sends right double-click mouse state with bounded canvas coordinates", () => {
    const send = vi.fn();
    let acknowledge: ((inputType: "pointer") => void) | null = null;
    render(
      <InteractiveBrowser
        connection={
          {
            send,
            setFrameHandler: vi.fn(),
            setInputAckHandler: vi.fn(
              (handler: ((inputType: "pointer") => void) | null) => {
                acknowledge = handler;
              },
            ),
          } as unknown as BrowserHandoffConnection
        }
      />,
    );
    const canvas = screen.getByRole("application");
    Object.defineProperties(canvas, {
      setPointerCapture: {
        value: vi.fn(() => {
          throw new DOMException("capture unavailable");
        }),
      },
      hasPointerCapture: { value: vi.fn(() => true) },
      releasePointerCapture: { value: vi.fn() },
      getBoundingClientRect: {
        value: () => ({
          left: 0,
          top: 0,
          width: 640,
          height: 360,
          right: 640,
          bottom: 360,
          x: 0,
          y: 0,
          toJSON: () => undefined,
        }),
      },
    });

    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 2,
      buttons: 2,
      detail: 2,
      clientX: 320,
      clientY: 180,
    });
    Object.defineProperty(pointerDown, "pointerId", { value: 1 });
    fireEvent(canvas, pointerDown);

    expect(send).toHaveBeenLastCalledWith({
      type: "pointer",
      action: "down",
      x: 640,
      y: 360,
      button: "right",
      buttons: ["right"],
      clickCount: 2,
    });
    const cursor = screen.getByTestId("virtual-mouse");
    expect(cursor.hidden).toBe(false);
    expect(cursor).toHaveAttribute("data-pressed", "true");
    expect(cursor).toHaveTextContent("640, 360 …");

    act(() => acknowledge?.("pointer"));
    expect(cursor).toHaveAttribute("data-acknowledged", "true");
    expect(cursor).toHaveTextContent("640, 360 ✓");
  });
});
