/**
 * @vitest-environment node
 *
 * Unit tests for the multi-server grouping layer. The load-bearing rules:
 * - `reachable:false` rows are NEVER dropped (the "unreachable != dead" rule).
 * - A session on a serverId missing from the registry still appears (orphan).
 * - Grouped-vs-flat is decided PER server subset, not globally.
 * - Collapse keys are bare in single-server mode, namespaced in multi-server.
 */
import { describe, expect, it } from "vitest";

import {
  groupByServer,
  isServerUnreachable,
  orgCollapseKey,
  projectCollapseKey,
  serverCollapseKey,
  serverStatus,
  sessionServerId,
} from "../server-grouping";

import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";

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

function server(overrides: Partial<ServerInfo> & { id: string }): ServerInfo {
  return {
    name: overrides.id,
    type: "ssh",
    reachability: "ok",
    lastProbeAt: 1720000000000,
    ...overrides,
  };
}

const LOCAL = server({ id: "local", name: "This machine", type: "local" });

describe("sessionServerId", () => {
  it("defaults an absent serverId to local", () => {
    expect(sessionServerId(session({ id: "web-a" }))).toBe("local");
    expect(sessionServerId(session({ id: "web-a", serverId: "build01" }))).toBe(
      "build01",
    );
  });
});

describe("serverStatus / isServerUnreachable", () => {
  it("local is always ok", () => {
    expect(serverStatus(LOCAL)).toBe("ok");
    expect(isServerUnreachable(LOCAL)).toBe(false);
  });

  it("an ssh server never probed is 'checking'", () => {
    const s = server({ id: "build01", lastProbeAt: null });
    expect(serverStatus(s)).toBe("checking");
    expect(isServerUnreachable(s)).toBe(false);
  });

  it("a probed unreachable ssh server is 'unreachable'", () => {
    const s = server({ id: "build01", reachability: "unreachable" });
    expect(serverStatus(s)).toBe("unreachable");
    expect(isServerUnreachable(s)).toBe(true);
  });
});

describe("collapse key helpers", () => {
  it("returns bare keys in single-server mode (serverId null)", () => {
    expect(orgCollapseKey(null, "Acme")).toBe("Acme");
    expect(orgCollapseKey(null, null)).toBe("__ungrouped__");
    expect(projectCollapseKey(null, "Acme", "web")).toBe("Acme/web");
  });

  it("namespaces keys by server in multi-server mode", () => {
    expect(serverCollapseKey("build01")).toBe("server:build01");
    expect(orgCollapseKey("build01", "Acme")).toBe("build01::Acme");
    expect(orgCollapseKey("build01", null)).toBe("build01::__ungrouped__");
    expect(projectCollapseKey("build01", "Acme", "web")).toBe(
      "build01::Acme/web",
    );
  });
});

describe("groupByServer", () => {
  it("orders local first, then ssh servers A-Z by name", () => {
    const groups = groupByServer(
      [],
      [
        server({ id: "zeta", name: "Zeta" }),
        LOCAL,
        server({ id: "alpha", name: "Alpha" }),
      ],
    );
    expect(groups.map((g) => g.server.id)).toEqual(["local", "alpha", "zeta"]);
  });

  it("yields a group even for a server with zero sessions", () => {
    const groups = groupByServer([], [LOCAL, server({ id: "build01" })]);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.sessionCount).toBe(0);
  });

  it("NEVER drops an unreachable (reachable:false) session", () => {
    const build = server({ id: "build01", reachability: "unreachable" });
    const sessions = [
      session({ id: "web-a", serverId: "local", reachable: true }),
      session({ id: "web-b", serverId: "build01", reachable: false }),
    ];
    const groups = groupByServer(sessions, [LOCAL, build]);
    const buildGroup = groups.find((g) => g.server.id === "build01")!;
    expect(buildGroup.sessionCount).toBe(1);
    expect(buildGroup.sessions.map((s) => s.id)).toContain("web-b");
  });

  it("keeps a session whose serverId is missing from the registry (orphan)", () => {
    const sessions = [
      session({ id: "web-a", serverId: "local" }),
      session({ id: "web-ghost", serverId: "vanished" }),
    ];
    const groups = groupByServer(sessions, [LOCAL]);
    const orphan = groups.find((g) => g.server.id === "vanished");
    expect(orphan).toBeDefined();
    expect(orphan!.sessions.map((s) => s.id)).toEqual(["web-ghost"]);
    // Orphan servers render greyed, not dropped.
    expect(isServerUnreachable(orphan!.server)).toBe(true);
  });

  it("decides grouped-vs-flat per server subset, not globally", () => {
    const build = server({ id: "build01" });
    const sessions = [
      // local has an org => grouped
      session({ id: "web-a", serverId: "local", org: "Acme" }),
      // build01 has no org => flat
      session({ id: "web-b", serverId: "build01" }),
    ];
    const groups = groupByServer(sessions, [LOCAL, build]);
    expect(groups.find((g) => g.server.id === "local")!.grouped).toBe(true);
    expect(groups.find((g) => g.server.id === "build01")!.grouped).toBe(false);
  });
});
