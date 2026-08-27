/**
 * @vitest-environment node
 *
 * Tests for the multi-window layout slice of the terminal Zustand store —
 * see docs/MULTI-WINDOW-PLAN.md §2 and docs/MULTI-WINDOW-DECISIONS.md.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultLayout,
  deriveActiveSessionId,
  normalizeLayout,
  PANE_COUNT,
  RATIOS_LENGTH,
  useTerminalStore,
  type LayoutState,
} from "../store";

function reset(layout: LayoutState = defaultLayout()) {
  useTerminalStore.setState({
    activeSessionId: deriveActiveSessionId(layout),
    layout,
    recentSessionIds: [],
  });
}

/** Non-null pane accessor for test readability — the panes arrays used
 * throughout this file are always populated by construction. */
function pane(panes: LayoutState["panes"], i: number) {
  return panes[i]!;
}

beforeEach(() => reset());
afterEach(() => reset());

describe("layout slice defaults", () => {
  it("starts in single mode with one empty, focused pane", () => {
    const { layout, activeSessionId } = useTerminalStore.getState();
    expect(layout.mode).toBe("single");
    expect(layout.panes).toHaveLength(1);
    expect(layout.panes[0]!.sessionId).toBeNull();
    expect(layout.focusedPaneId).toBe(layout.panes[0]!.id);
    expect(layout.ratios).toEqual([1]);
    expect(activeSessionId).toBeNull();
  });
});

describe("setLayoutMode", () => {
  it("is a no-op when the mode is unchanged", () => {
    const before = useTerminalStore.getState().layout;
    useTerminalStore.getState().setLayoutMode("single");
    expect(useTerminalStore.getState().layout).toBe(before);
  });

  it("grows panes to the target count, leaving new panes empty by default", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const { layout } = useTerminalStore.getState();
    expect(layout.mode).toBe("cols-2");
    expect(layout.panes).toHaveLength(PANE_COUNT["cols-2"]);
    expect(layout.panes[1]!.sessionId).toBeNull();
    expect(layout.ratios).toHaveLength(RATIOS_LENGTH["cols-2"]);
  });

  it("preserves the existing pane's session when growing", () => {
    const pane0 = useTerminalStore.getState().layout.panes[0]!.id;
    useTerminalStore.getState().setPaneSession(pane0, "web-1");
    useTerminalStore.getState().setLayoutMode("grid-2x2");
    const { layout } = useTerminalStore.getState();
    expect(layout.panes).toHaveLength(4);
    expect(layout.panes[0]!.sessionId).toBe("web-1");
  });

  it("auto-fills new panes from recentSessionIds minus already-shown (§8 #3)", () => {
    const pane0 = useTerminalStore.getState().layout.panes[0]!.id;
    useTerminalStore.getState().setPaneSession(pane0, "web-1");
    useTerminalStore.setState({
      recentSessionIds: ["web-1", "web-2", "web-3"],
    });
    useTerminalStore.getState().setLayoutMode("cols-3");
    const { layout } = useTerminalStore.getState();
    // web-1 is already shown in pane 0, so the two new panes fill from the
    // next most-recent unclaimed ids: web-2, then web-3.
    expect(layout.panes.map((p) => p.sessionId)).toEqual([
      "web-1",
      "web-2",
      "web-3",
    ]);
  });

  it("leaves a new pane empty once recentSessionIds is exhausted", () => {
    // The existing (first) pane stays null — growing never touches it.
    // recentSessionIds has only one candidate, so only the first new pane
    // (index 1) fills; the second new pane (index 2) has nothing left.
    useTerminalStore.setState({ recentSessionIds: ["web-1"] });
    useTerminalStore.getState().setLayoutMode("cols-3");
    const { layout } = useTerminalStore.getState();
    expect(layout.panes.map((p) => p.sessionId)).toEqual([null, "web-1", null]);
  });

  it("shrinks by dropping panes from the end", () => {
    useTerminalStore.getState().setLayoutMode("grid-2x2");
    const { panes } = useTerminalStore.getState().layout;
    const p0 = pane(panes, 0);
    const p1 = pane(panes, 1);
    useTerminalStore.getState().setPaneSession(p0.id, "web-1");
    useTerminalStore.getState().setPaneSession(p1.id, "web-2");

    useTerminalStore.getState().setLayoutMode("cols-2");
    const { layout } = useTerminalStore.getState();
    expect(layout.panes).toHaveLength(2);
    expect(layout.panes.map((p) => p.sessionId)).toEqual(["web-1", "web-2"]);
  });

  it("preserves focus when the focused pane survives shrinking", () => {
    useTerminalStore.getState().setLayoutMode("grid-2x2");
    const secondPaneId = useTerminalStore.getState().layout.panes[1]!.id;
    useTerminalStore.getState().focusPane(secondPaneId);

    useTerminalStore.getState().setLayoutMode("cols-2");
    expect(useTerminalStore.getState().layout.focusedPaneId).toBe(secondPaneId);
  });

  it("refocuses the first pane when the focused pane is dropped by shrinking", () => {
    useTerminalStore.getState().setLayoutMode("cols-3");
    const thirdPaneId = useTerminalStore.getState().layout.panes[2]!.id;
    useTerminalStore.getState().focusPane(thirdPaneId);

    useTerminalStore.getState().setLayoutMode("single");
    const { layout } = useTerminalStore.getState();
    expect(layout.focusedPaneId).toBe(layout.panes[0]!.id);
  });
});

describe("focusPane", () => {
  it("moves focus and mirrors activeSessionId", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const p0 = pane(useTerminalStore.getState().layout.panes, 0);
    const p1 = pane(useTerminalStore.getState().layout.panes, 1);
    useTerminalStore.getState().setPaneSession(p1.id, "web-2");

    useTerminalStore.getState().focusPane(p1.id);
    const state = useTerminalStore.getState();
    expect(state.layout.focusedPaneId).toBe(p1.id);
    expect(state.activeSessionId).toBe("web-2");

    useTerminalStore.getState().focusPane(p0.id);
    expect(useTerminalStore.getState().activeSessionId).toBeNull();
  });

  it("is a no-op for an unknown paneId", () => {
    const before = useTerminalStore.getState().layout;
    useTerminalStore.getState().focusPane("does-not-exist");
    expect(useTerminalStore.getState().layout).toBe(before);
  });
});

describe("setPaneSession", () => {
  it("sets a pane's session and mirrors activeSessionId when it's focused", () => {
    const pane0 = useTerminalStore.getState().layout.panes[0]!.id;
    useTerminalStore.getState().setPaneSession(pane0, "web-1");
    expect(useTerminalStore.getState().activeSessionId).toBe("web-1");
  });

  it("enforces D4: clears the session from any other pane that held it", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const p0 = pane(useTerminalStore.getState().layout.panes, 0);
    const p1 = pane(useTerminalStore.getState().layout.panes, 1);
    useTerminalStore.getState().setPaneSession(p0.id, "web-1");

    useTerminalStore.getState().setPaneSession(p1.id, "web-1");
    const { layout } = useTerminalStore.getState();
    expect(layout.panes.find((p) => p.id === p0.id)?.sessionId).toBeNull();
    expect(layout.panes.find((p) => p.id === p1.id)?.sessionId).toBe("web-1");
  });

  it("is a no-op for an unknown paneId", () => {
    const before = useTerminalStore.getState().layout;
    useTerminalStore.getState().setPaneSession("does-not-exist", "web-1");
    expect(useTerminalStore.getState().layout).toBe(before);
  });
});

describe("setActiveSessionId (legacy call-site compatibility)", () => {
  it("writes into the focused pane, unchanged external signature", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const p1 = pane(useTerminalStore.getState().layout.panes, 1);
    useTerminalStore.getState().focusPane(p1.id);

    useTerminalStore.getState().setActiveSessionId("web-9");
    const { layout, activeSessionId } = useTerminalStore.getState();
    expect(activeSessionId).toBe("web-9");
    expect(layout.panes.find((p) => p.id === p1.id)?.sessionId).toBe("web-9");
  });

  it("null clears the focused pane", () => {
    useTerminalStore.getState().setActiveSessionId("web-1");
    useTerminalStore.getState().setActiveSessionId(null);
    expect(useTerminalStore.getState().activeSessionId).toBeNull();
  });
});

describe("closePane", () => {
  it("is a no-op in single mode", () => {
    const before = useTerminalStore.getState().layout;
    useTerminalStore
      .getState()
      .closePane(useTerminalStore.getState().layout.panes[0]!.id);
    expect(useTerminalStore.getState().layout).toBe(before);
  });

  it("is a no-op when the layout is already off-count for its mode", () => {
    // Defensive guard: the downgrade table assumes panes.length ===
    // PANE_COUNT[mode]. A layout that somehow arrived off-count (bypassing
    // normalizeLayout) must not produce another off-count layout.
    useTerminalStore.getState().setLayoutMode("grid-2x2");
    const offCount = useTerminalStore.getState().layout;
    useTerminalStore.setState({
      layout: { ...offCount, panes: offCount.panes.slice(0, 3) },
    });
    const before = useTerminalStore.getState().layout;
    useTerminalStore.getState().closePane(before.panes[0]!.id);
    expect(useTerminalStore.getState().layout).toBe(before);
  });

  it("is a no-op for an unknown paneId", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const before = useTerminalStore.getState().layout;
    useTerminalStore.getState().closePane("does-not-exist");
    expect(useTerminalStore.getState().layout).toBe(before);
  });

  it("drops cols-2 to single, keeping the surviving pane's session", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const p0 = pane(useTerminalStore.getState().layout.panes, 0);
    const p1 = pane(useTerminalStore.getState().layout.panes, 1);
    useTerminalStore.getState().setPaneSession(p0.id, "web-1");
    useTerminalStore.getState().setPaneSession(p1.id, "web-2");

    useTerminalStore.getState().closePane(p0.id);
    const { layout } = useTerminalStore.getState();
    expect(layout.mode).toBe("single");
    expect(layout.panes).toHaveLength(1);
    expect(layout.panes[0]!.id).toBe(p1.id);
    expect(layout.panes[0]!.sessionId).toBe("web-2");
    expect(layout.ratios).toEqual([1]);
  });

  it("drops grid-2x2 to cols-3", () => {
    useTerminalStore.getState().setLayoutMode("grid-2x2");
    const p0 = pane(useTerminalStore.getState().layout.panes, 0);
    useTerminalStore.getState().closePane(p0.id);
    const { layout } = useTerminalStore.getState();
    expect(layout.mode).toBe("cols-3");
    expect(layout.panes).toHaveLength(3);
    expect(layout.ratios).toHaveLength(RATIOS_LENGTH["cols-3"]);
  });

  it("preserves focus when the closed pane was not focused", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const p0 = pane(useTerminalStore.getState().layout.panes, 0);
    const p1 = pane(useTerminalStore.getState().layout.panes, 1);
    useTerminalStore.getState().focusPane(p1.id);

    useTerminalStore.getState().closePane(p0.id);
    expect(useTerminalStore.getState().layout.focusedPaneId).toBe(p1.id);
  });

  it("refocuses the first remaining pane when the focused pane is closed", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const p0 = pane(useTerminalStore.getState().layout.panes, 0);
    const p1 = pane(useTerminalStore.getState().layout.panes, 1);
    useTerminalStore.getState().focusPane(p0.id);

    useTerminalStore.getState().closePane(p0.id);
    const { layout } = useTerminalStore.getState();
    expect(layout.focusedPaneId).toBe(p1.id);
  });
});

describe("setRatios", () => {
  it("overwrites layout.ratios without touching panes", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    const panesBefore = useTerminalStore.getState().layout.panes;
    useTerminalStore.getState().setRatios([0.3, 0.7]);
    const { layout } = useTerminalStore.getState();
    expect(layout.ratios).toEqual([0.3, 0.7]);
    expect(layout.panes).toBe(panesBefore);
  });
});

describe("reconcilePanes", () => {
  it("writes ids by index and mirrors activeSessionId", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    useTerminalStore.getState().reconcilePanes(["web-1", "web-2"]);
    const { layout, activeSessionId } = useTerminalStore.getState();
    expect(layout.panes.map((p) => p.sessionId)).toEqual(["web-1", "web-2"]);
    expect(activeSessionId).toBe("web-1");
  });

  it("is a no-op (same state) when nothing would change", () => {
    useTerminalStore.getState().setLayoutMode("cols-2");
    useTerminalStore.getState().reconcilePanes(["web-1", "web-2"]);
    const before = useTerminalStore.getState().layout;

    useTerminalStore.getState().reconcilePanes(["web-1", "web-2"]);
    expect(useTerminalStore.getState().layout).toBe(before);
  });
});

describe("normalizeLayout", () => {
  it("returns a valid default when raw is undefined", () => {
    const layout = normalizeLayout(undefined);
    expect(layout.mode).toBe("single");
    expect(layout.panes).toHaveLength(1);
    expect(layout.focusedPaneId).toBe(layout.panes[0]!.id);
  });

  it("falls back to single for an unknown mode string", () => {
    const layout = normalizeLayout({ mode: "sixteen-way" as never });
    expect(layout.mode).toBe("single");
    expect(layout.panes).toHaveLength(1);
  });

  it("pads a short panes array up to PANE_COUNT[mode]", () => {
    const layout = normalizeLayout({
      mode: "grid-2x2",
      panes: [{ id: "a", sessionId: "web-1" }],
      focusedPaneId: "a",
      ratios: [0.5, 0.5, 0.5],
    });
    expect(layout.panes).toHaveLength(4);
    expect(layout.panes[0]!).toEqual({ id: "a", sessionId: "local/web-1" });
  });

  it("truncates an over-long panes array", () => {
    const layout = normalizeLayout({
      mode: "single",
      panes: [
        { id: "a", sessionId: null },
        { id: "b", sessionId: null },
      ],
      focusedPaneId: "a",
      ratios: [1],
    });
    expect(layout.panes).toHaveLength(1);
    expect(layout.panes[0]!.id).toBe("a");
  });

  it("dedupes sessionId across panes, first occurrence wins (D4)", () => {
    const layout = normalizeLayout({
      mode: "cols-2",
      panes: [
        { id: "a", sessionId: "web-1" },
        { id: "b", sessionId: "web-1" },
      ],
      focusedPaneId: "a",
      ratios: [0.5, 0.5],
    });
    expect(layout.panes[0]!.sessionId).toBe("local/web-1");
    expect(layout.panes[1]!.sessionId).toBeNull();
  });

  it("normalizes bare session refs to qualified form", () => {
    const layout = normalizeLayout({
      mode: "single",
      panes: [{ id: "a", sessionId: "web-1" }],
      focusedPaneId: "a",
      ratios: [1],
    });
    expect(layout.panes[0]!.sessionId).toBe("local/web-1");
  });

  it("clamps focusedPaneId to an existing pane when invalid", () => {
    const layout = normalizeLayout({
      mode: "single",
      panes: [{ id: "a", sessionId: null }],
      focusedPaneId: "ghost",
      ratios: [1],
    });
    expect(layout.focusedPaneId).toBe("a");
  });

  it("resets ratios to the mode default when the wrong length", () => {
    const layout = normalizeLayout({
      mode: "cols-3",
      panes: [
        { id: "a", sessionId: null },
        { id: "b", sessionId: null },
        { id: "c", sessionId: null },
      ],
      focusedPaneId: "a",
      ratios: [0.5, 0.5],
    });
    expect(layout.ratios).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("migrates a legacy activeSessionId into the sole empty pane", () => {
    // Pre-multi-window storage had no `layout` key at all.
    const layout = normalizeLayout(undefined, "web-legacy");
    expect(layout.panes[0]!.sessionId).toBe("local/web-legacy");
  });

  it("skips legacy migration once any pane already carries a session", () => {
    const layout = normalizeLayout(
      {
        mode: "single",
        panes: [{ id: "a", sessionId: "web-1" }],
        focusedPaneId: "a",
        ratios: [1],
      },
      "web-legacy",
    );
    expect(layout.panes[0]!.sessionId).toBe("local/web-1");
  });
});
