/**
 * Multi-server ("Connected Servers") grouping layer.
 *
 * Wraps the existing org->project `grouping.ts` with a top-level partition by
 * server. `grouping.ts` itself is UNCHANGED — this module partitions the flat
 * session list by `serverId` and calls `groupSessions()` on each subset.
 *
 * The single-server rule lives in the sidebar, not here: when only `local`
 * exists the sidebar bypasses this module entirely and renders exactly as it
 * did before multi-server. This module is exercised only at >= 2 servers.
 */
import { LOCAL_SERVER_ID } from "@sparklab/shared-types";

import { groupSessions, hasAnyGrouping, type SessionTree } from "./grouping";

import type { ServerInfo, SessionInfo } from "@sparklab/shared-types";

/** A three-state reachability derived for the UI (the wire only carries
 *  "ok" | "unreachable"; "checking" is a client-side state for an ssh server
 *  whose first probe has not returned yet). */
export type ServerStatus = "ok" | "unreachable" | "checking";

/** The serverId a session belongs to (absent => "local", per the contract). */
export function sessionServerId(s: SessionInfo): string {
  return s.serverId ?? LOCAL_SERVER_ID;
}

/**
 * The UI reachability of a server.
 * - `local` is always reachable.
 * - An ssh server that has never been probed (`lastProbeAt == null`) is
 *   "checking" (the amber first-probe state), regardless of the placeholder
 *   reachability value.
 * - Otherwise the wire `reachability` ("ok" | "unreachable") stands.
 */
export function serverStatus(server: ServerInfo): ServerStatus {
  if (server.type === "local") return "ok";
  if (server.lastProbeAt == null) return "checking";
  return server.reachability;
}

/** Whether a server is unreachable — "couldn't ask", NEVER "dead". Drives the
 *  greyed (muted) treatment; never the destructive color. */
export function isServerUnreachable(server: ServerInfo): boolean {
  return serverStatus(server) === "unreachable";
}

/** The status-dot token class for a server (§1 of the UX spec). Muted for
 *  unreachable — never `bg-destructive`. */
export function serverDotClass(server: ServerInfo): string {
  switch (serverStatus(server)) {
    case "ok":
      return "bg-chart-1";
    case "checking":
      return "bg-chart-2";
    case "unreachable":
      return "bg-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// Collapse-key helpers (shared by the sidebar renderer and the store's
// expandAncestors). Single-server mode (serverId == null) keeps the bare keys
// unchanged so a user's existing persisted collapse state is preserved.
// Multi-server mode namespaces every key by serverId to avoid collisions
// between two servers that both have an org named "Acme".
// ---------------------------------------------------------------------------

/** Collapse key for a server header (multi-server only). */
export function serverCollapseKey(serverId: string): string {
  return `server:${serverId}`;
}

/** Collapse key for an org header. `serverId == null` => bare (single-server). */
export function orgCollapseKey(
  serverId: string | null,
  org: string | null,
): string {
  const orgKey = org ?? "__ungrouped__";
  return serverId == null ? orgKey : `${serverId}::${orgKey}`;
}

/** Collapse key for a project header. `serverId == null` => bare. */
export function projectCollapseKey(
  serverId: string | null,
  org: string | null,
  project: string,
): string {
  const orgKey = org ?? "__ungrouped__";
  const base = `${orgKey}/${project}`;
  return serverId == null ? base : `${serverId}::${base}`;
}

// ---------------------------------------------------------------------------
// groupByServer
// ---------------------------------------------------------------------------

/** One server's group: its record, the org->project tree of its sessions, and
 *  whether that subset has any org grouping at all (per-server flat vs tree). */
export interface ServerGroup {
  server: ServerInfo;
  /** org->project tree of this server's sessions (meaningful when `grouped`). */
  tree: SessionTree;
  /** True when at least one of this server's sessions has an org — render the
   *  org tree; false => render the sessions flat directly under the header. */
  grouped: boolean;
  /** This server's sessions in a stable order (createdAt asc), for flat mode. */
  sessions: SessionInfo[];
  /** Total sessions under this server (reachable or not). */
  sessionCount: number;
}

/** Synthesize a placeholder record for a serverId that appears on a session
 *  but is not in the registry response. Treated as unreachable so its rows are
 *  greyed rather than silently dropped (the "never prune" rule). */
function orphanServer(id: string): ServerInfo {
  return {
    id,
    name: id,
    type: "ssh",
    reachability: "unreachable",
    // Non-null so `serverStatus` reports "unreachable" (greyed), not "checking":
    // an unregistered server is one we genuinely can't reach, not one mid-probe.
    lastProbeAt: 0,
  };
}

/** Stable server order: `local` first, then ssh servers A-Z by name.
 *  Unreachable servers KEEP their position (do not sink to the bottom). */
function sortServers(servers: ServerInfo[]): ServerInfo[] {
  return [...servers].sort((a, b) => {
    if (a.id === LOCAL_SERVER_ID) return -1;
    if (b.id === LOCAL_SERVER_ID) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Partition sessions by server, then group each subset (org->project).
 *
 * - Every registry server yields a group, even with zero sessions (so a
 *   present-but-empty greyed server is still visible).
 * - Any serverId found on a session but missing from `servers` yields an
 *   orphan group (never drop a session — the "unreachable != dead" rule).
 * - `reachable:false` rows are grouped exactly like reachable ones; the caller
 *   never filters them before this runs.
 */
export function groupByServer(
  sessions: SessionInfo[],
  servers: ServerInfo[],
): ServerGroup[] {
  // Bucket sessions by serverId.
  const byServer = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const id = sessionServerId(s);
    let bucket = byServer.get(id);
    if (!bucket) {
      bucket = [];
      byServer.set(id, bucket);
    }
    bucket.push(s);
  }

  const known = new Set(servers.map((s) => s.id));
  // Orphan servers (referenced by a session but not registered) keep their
  // sessions visible; append them after the known servers, sorted by id.
  const orphans = [...byServer.keys()]
    .filter((id) => !known.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map(orphanServer);

  const ordered = [...sortServers(servers), ...orphans];

  return ordered.map((server) => {
    const subset = byServer.get(server.id) ?? [];
    const tree = groupSessions(subset);
    // flattenTree order == groupSessions order; for flat mode we want the same
    // createdAt-asc ordering, which groupSessions already applies within the
    // single ungrouped bucket.
    const flat = tree.flatMap((org) => org.projects.flatMap((p) => p.sessions));
    return {
      server,
      tree,
      grouped: hasAnyGrouping(subset),
      sessions: flat,
      sessionCount: subset.length,
    };
  });
}
