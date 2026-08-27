/**
 * @vitest-environment node
 *
 * Tests for resolvePaneSessions — the grid-aware sibling of
 * resolveActiveSession behind the multi-window "active session vanished ->
 * fall back" effect.
 */
import { describe, expect, it } from "vitest";

import { resolvePaneSessions } from "../resolve-pane-sessions";
import { resolveActiveSession } from "../session-fallback";

const S = (...ids: string[]) => ids.map((id) => ({ id }));

describe("resolvePaneSessions", () => {
  it("leaves panes untouched while sessions are still loading", () => {
    expect(resolvePaneSessions(false, [], ["web-1", null], 0)).toBeUndefined();
    expect(
      resolvePaneSessions(false, S("web-1"), [null, null], 0),
    ).toBeUndefined();
  });

  it("drops a pane id that no longer exists in the loaded list", () => {
    expect(resolvePaneSessions(true, S("web-1"), ["gone", "web-1"], 1)).toEqual(
      [null, "web-1"],
    );
  });

  it("dedupes: keeps the first occurrence, nulls later panes with the same id", () => {
    expect(
      resolvePaneSessions(
        true,
        S("web-1", "web-2"),
        ["web-1", "web-1", "web-2"],
        0,
      ),
    ).toEqual(["web-1", null, "web-2"]);
  });

  it("does not auto-fill a non-focused empty pane", () => {
    // Focus is on pane 0 (already filled); pane 1 stays empty even though
    // web-2 is available and unclaimed.
    expect(
      resolvePaneSessions(true, S("web-1", "web-2"), ["web-1", null], 0),
    ).toBeUndefined();
  });

  it("auto-fills the focused pane with the first unclaimed session", () => {
    // web-1 is already shown in pane 0; the focused pane (1) is empty and
    // must NOT grab web-1 (D4) — it falls back to the next unclaimed one.
    expect(
      resolvePaneSessions(true, S("web-1", "web-2"), ["web-1", null], 1),
    ).toEqual(["web-1", "web-2"]);
  });

  it("leaves the focused pane empty when every session is already claimed", () => {
    expect(
      resolvePaneSessions(
        true,
        S("web-1", "web-2"),
        ["web-1", "web-2", null],
        2,
      ),
    ).toBeUndefined();
  });

  it("clears all panes when loaded and genuinely empty", () => {
    expect(resolvePaneSessions(true, [], ["web-1", "web-2"], 0)).toEqual([
      null,
      null,
    ]);
  });

  it("does nothing when loaded, empty, and every pane already null", () => {
    expect(resolvePaneSessions(true, [], [null, null], 0)).toBeUndefined();
  });

  it("returns undefined when panes are already fully consistent (no infinite loop)", () => {
    // Every id valid, no duplicates, focused pane already filled: nothing
    // to change. A fresh-but-equal array here would refire the caller
    // effect forever.
    expect(
      resolvePaneSessions(
        true,
        S("web-1", "web-2", "web-3"),
        ["web-1", "web-2", "web-3"],
        1,
      ),
    ).toBeUndefined();
  });

  it("ignores an out-of-range focusedPaneIndex without crashing", () => {
    expect(resolvePaneSessions(true, S("web-1"), ["gone"], 5)).toEqual([null]);
    expect(resolvePaneSessions(true, S("web-1"), ["gone"], -1)).toEqual([null]);
  });

  it("matches resolveActiveSession exactly in single-pane mode", () => {
    // In `single` mode there is exactly one pane and it is always focused —
    // the D10 guarantee that default single-pane behavior is byte-identical
    // extends down to the resolver level.
    const cases: [boolean, { id: string }[], string | null][] = [
      [true, [], "web-gone"],
      [true, S("web-1", "web-2"), "gone"],
      [true, S("web-1", "web-2"), null],
      [true, S("web-1", "web-2"), "web-2"],
    ];
    for (const [loaded, sessions, id] of cases) {
      const scalar = resolveActiveSession(loaded, sessions, id);
      const arr = resolvePaneSessions(loaded, sessions, [id], 0);
      if (scalar === undefined) {
        expect(arr).toBeUndefined();
      } else {
        expect(arr).toEqual([scalar]);
      }
    }
  });
});
