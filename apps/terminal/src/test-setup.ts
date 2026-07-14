/**
 * Test setup for the terminal app.
 * Stubs APIs missing from jsdom that radix-ui components require.
 */
import "@testing-library/jest-dom/vitest";

// ResizeObserver is not available in jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}
