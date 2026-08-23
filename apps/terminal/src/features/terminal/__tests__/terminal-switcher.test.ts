/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { sortSessionsForSwitcher } from "../components/terminal-switcher";

import type { SessionInfo } from "@sparklab/shared-types";

function session(
  id: string,
  lastActivity: number | null,
  createdAt = 0,
): SessionInfo {
  return {
    id,
    name: id,
    createdAt,
    tags: [],
    currentCommand: "zsh",
    attached: false,
    lastActivity,
  };
}

describe("sortSessionsForSwitcher", () => {
  it("puts locally most-recently selected sessions first", () => {
    const sessions = [
      session("web-a", 100),
      session("web-b", 300),
      session("web-c", 200),
    ];

    expect(
      sortSessionsForSwitcher(sessions, ["web-c", "web-a"]).map((s) => s.id),
    ).toEqual(["web-c", "web-a", "web-b"]);
  });

  it("uses gateway last activity when there is no local switch history", () => {
    const sessions = [
      session("web-a", 100),
      session("web-b", 300),
      session("web-c", 200),
    ];

    expect(sortSessionsForSwitcher(sessions, []).map((s) => s.id)).toEqual([
      "web-b",
      "web-c",
      "web-a",
    ]);
  });
});
