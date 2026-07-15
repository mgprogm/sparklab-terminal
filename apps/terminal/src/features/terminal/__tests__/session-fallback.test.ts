/**
 * @vitest-environment node
 *
 * Tests for resolveActiveSession — the pure decision behind TerminalShell's
 * "active session vanished → fall back" effect.
 */
import { describe, expect, it } from "vitest";

import { resolveActiveSession } from "../session-fallback";

const S = (...ids: string[]) => ids.map((id) => ({ id }));

describe("resolveActiveSession", () => {
  it("leaves the id untouched while sessions are still loading", () => {
    // The bug fix: during the initial fetch window sessions is [] but not yet
    // loaded — a persisted/URL id must NOT be nulled.
    expect(resolveActiveSession(false, [], "web-1")).toBeUndefined();
    expect(resolveActiveSession(false, [], null)).toBeUndefined();
  });

  it("clears a stale id once loaded and genuinely empty", () => {
    expect(resolveActiveSession(true, [], "web-1")).toBeNull();
  });

  it("does nothing when loaded, empty, and nothing was selected", () => {
    expect(resolveActiveSession(true, [], null)).toBeUndefined();
  });

  it("keeps a persisted id that still exists in the loaded list", () => {
    expect(
      resolveActiveSession(true, S("web-1", "web-2"), "web-2"),
    ).toBeUndefined();
  });

  it("falls back to the first session when the selected id vanished", () => {
    expect(resolveActiveSession(true, S("web-1", "web-2"), "gone")).toBe(
      "web-1",
    );
  });

  it("attaches to the first session when loaded with none selected", () => {
    expect(resolveActiveSession(true, S("web-1", "web-2"), null)).toBe("web-1");
  });

  it("keeps the active id when it exists as a qualified (unreachable) row", () => {
    // The "never prune unreachable" protection: an unreachable server's
    // last-known session stays in the list, so its qualified id remains valid
    // and the resolver must NOT fall it back. (The caller must not filter
    // reachable:false rows before this runs.)
    expect(
      resolveActiveSession(
        true,
        S("local/web-1", "build01/web-x"),
        "build01/web-x",
      ),
    ).toBeUndefined();
  });
});
