/**
 * @vitest-environment node
 *
 * Unit tests for the grouping pure function.
 */
import { describe, expect, it } from "vitest";

import { flattenTree, groupSessions, hasAnyGrouping } from "../grouping";

import type { SessionInfo } from "@sparklab/shared-types";

function session(
  overrides: Partial<SessionInfo> & { id: string },
): SessionInfo {
  return {
    name: overrides.id,
    createdAt: null,
    tags: [],
    currentCommand: "bash",
    attached: false,
    org: null,
    project: null,
    ...overrides,
  };
}

describe("groupSessions", () => {
  it("returns an empty tree for no sessions", () => {
    expect(groupSessions([])).toEqual([]);
  });

  it("puts all ungrouped sessions into one bucket", () => {
    const tree = groupSessions([
      session({ id: "web-a", createdAt: 2 }),
      session({ id: "web-b", createdAt: 1 }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.org).toBeNull();
    expect(tree[0]!.sessionCount).toBe(2);
    // Sorted by createdAt ascending.
    expect(tree[0]!.projects[0]!.sessions[0]!.id).toBe("web-b");
    expect(tree[0]!.projects[0]!.sessions[1]!.id).toBe("web-a");
  });

  it("sorts orgs A-Z with Ungrouped last", () => {
    const tree = groupSessions([
      session({ id: "web-z", org: "Zebra" }),
      session({ id: "web-u" }), // ungrouped
      session({ id: "web-a", org: "Alpha" }),
    ]);
    expect(tree.map((g) => g.org)).toEqual(["Alpha", "Zebra", null]);
  });

  it("sorts projects A-Z within an org, no-project first", () => {
    const tree = groupSessions([
      session({ id: "web-1", org: "Acme", project: "checkout" }),
      session({ id: "web-2", org: "Acme" }),
      session({ id: "web-3", org: "Acme", project: "api" }),
    ]);
    expect(tree).toHaveLength(1);
    const projects = tree[0]!.projects;
    // null (no project) comes first, then api, then checkout.
    expect(projects.map((p) => p.project)).toEqual([null, "api", "checkout"]);
  });

  it("sorts sessions by createdAt within a group", () => {
    const tree = groupSessions([
      session({ id: "web-c", org: "X", createdAt: 3 }),
      session({ id: "web-a", org: "X", createdAt: 1 }),
      session({ id: "web-b", org: "X", createdAt: 2 }),
    ]);
    const ids = tree[0]!.projects[0]!.sessions.map((s) => s.id);
    expect(ids).toEqual(["web-a", "web-b", "web-c"]);
  });

  it("handles null createdAt (sorts to 0)", () => {
    const tree = groupSessions([
      session({ id: "web-b", org: "X", createdAt: 1000 }),
      session({ id: "web-a", org: "X", createdAt: null }),
    ]);
    const ids = tree[0]!.projects[0]!.sessions.map((s) => s.id);
    expect(ids).toEqual(["web-a", "web-b"]);
  });

  it("counts sessions correctly across projects", () => {
    const tree = groupSessions([
      session({ id: "web-1", org: "Acme", project: "a" }),
      session({ id: "web-2", org: "Acme", project: "b" }),
      session({ id: "web-3", org: "Acme" }),
    ]);
    expect(tree[0]!.sessionCount).toBe(3);
  });

  it("produces a full tree with multiple orgs, projects, and ungrouped", () => {
    const tree = groupSessions([
      session({ id: "web-1", org: "Acme", project: "checkout", createdAt: 1 }),
      session({ id: "web-2", org: "Acme", project: "checkout", createdAt: 2 }),
      session({ id: "web-3", org: "Acme", project: "api", createdAt: 1 }),
      session({ id: "web-4", org: "Beta", createdAt: 1 }),
      session({ id: "web-5", createdAt: 1 }),
    ]);
    // Acme, Beta, Ungrouped
    expect(tree.map((g) => g.org)).toEqual(["Acme", "Beta", null]);
    expect(tree[0]!.sessionCount).toBe(3);
    expect(tree[1]!.sessionCount).toBe(1);
    expect(tree[2]!.sessionCount).toBe(1);
  });
});

describe("hasAnyGrouping", () => {
  it("returns false for all-ungrouped sessions", () => {
    expect(
      hasAnyGrouping([session({ id: "web-a" }), session({ id: "web-b" })]),
    ).toBe(false);
  });

  it("returns true when at least one session has an org", () => {
    expect(
      hasAnyGrouping([
        session({ id: "web-a" }),
        session({ id: "web-b", org: "X" }),
      ]),
    ).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(hasAnyGrouping([])).toBe(false);
  });
});

describe("flattenTree", () => {
  it("preserves tree order in the flat list", () => {
    const tree = groupSessions([
      session({ id: "web-u", createdAt: 10 }), // ungrouped -> last
      session({ id: "web-a1", org: "Alpha", project: "p1", createdAt: 1 }),
      session({ id: "web-a2", org: "Alpha", project: "p1", createdAt: 2 }),
      session({ id: "web-b1", org: "Beta", createdAt: 1 }),
    ]);
    const flat = flattenTree(tree);
    const ids = flat.map((s) => s.id);
    // Alpha -> Beta -> Ungrouped
    expect(ids).toEqual(["web-a1", "web-a2", "web-b1", "web-u"]);
  });
});
