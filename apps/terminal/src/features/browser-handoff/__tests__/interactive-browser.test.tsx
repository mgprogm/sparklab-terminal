import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("sends right double-click mouse state with bounded canvas coordinates", async () => {
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

    await act(
      () =>
        new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        ),
    );

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
    expect(screen.getByTestId("virtual-mouse-arrow").tagName).toBe("svg");
    expect(cursor.hidden).toBe(false);
    expect(cursor).toHaveAttribute("data-pressed", "true");
    expect(cursor).toHaveTextContent("640, 360 …");

    act(() => acknowledge?.("pointer"));
    await act(
      () =>
        new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        ),
    );
    expect(cursor).toHaveAttribute("data-acknowledged", "true");
    expect(cursor).toHaveTextContent("640, 360 ✓");
  });

  it("coalesces cursor DOM updates and invalidates its cached layout rect", () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const send = vi.fn();
    render(
      <InteractiveBrowser
        connection={
          {
            send,
            setFrameHandler: vi.fn(),
          } as unknown as BrowserHandoffConnection
        }
      />,
    );
    const canvas = screen.getByRole("application");
    const rect = {
      left: 0,
      top: 0,
      width: 640,
      height: 360,
      right: 640,
      bottom: 360,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    };
    const getBoundingClientRect = vi.fn(() => rect);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: getBoundingClientRect,
    });

    fireEvent(
      canvas,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 10,
        clientY: 20,
      }),
    );
    fireEvent(
      canvas,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 30,
        clientY: 40,
      }),
    );
    const cursor = screen.getByTestId("virtual-mouse");
    expect(cursor.hidden).toBe(true);
    expect(getBoundingClientRect).toHaveBeenCalledOnce();

    act(() => {
      for (const callback of animationFrames.splice(0)) callback(0);
    });
    expect(cursor.hidden).toBe(false);
    expect(cursor).toHaveStyle({
      transform: "translate3d(30px, 40px, 0)",
    });

    act(() => window.dispatchEvent(new Event("resize")));
    fireEvent(
      canvas,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 50,
        clientY: 60,
      }),
    );
    expect(getBoundingClientRect).toHaveBeenCalledTimes(2);
  });

  it("keeps the canvas backing store when decoded frame dimensions match", async () => {
    let frameHandler: ((frame: Blob) => void) | null = null;
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1280, height: 720, close })),
    );
    render(
      <InteractiveBrowser
        connection={
          {
            send: vi.fn(),
            setFrameHandler: vi.fn(
              (handler: ((frame: Blob) => void) | null) => {
                frameHandler = handler;
              },
            ),
          } as unknown as BrowserHandoffConnection
        }
      />,
    );
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    const drawImage = vi.fn();
    Object.defineProperty(canvas, "getContext", {
      value: () => ({ drawImage }),
    });
    const width = vi.spyOn(canvas, "width", "set");
    const height = vi.spyOn(canvas, "height", "set");

    act(() => frameHandler?.(new Blob(["frame"])));
    await waitFor(() => expect(drawImage).toHaveBeenCalledOnce());
    expect(width).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
