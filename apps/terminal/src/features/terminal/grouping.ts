/**
 * Pure grouping function: SessionInfo[] -> a two-level tree
 * (org -> project -> sessions). Designed to be unit-tested in isolation.
 *
 * Sorting: orgs A-Z (Ungrouped last), projects A-Z within org,
 * sessions by createdAt ascending within each group.
 */
import type { SessionInfo } from "@sparklab/shared-types";

/** A project sub-group within an org. */
export interface ProjectGroup {
  /** Project name, or null for sessions directly in the org (no project). */
  project: string | null;
  sessions: SessionInfo[];
}

/** A top-level org group. */
export interface OrgGroup {
  /** Org name, or null for the "Ungrouped" bucket. */
  org: string | null;
  projects: ProjectGroup[];
  /** Total sessions under this org (across all projects + direct). */
  sessionCount: number;
}

/** The full tree produced by groupSessions. */
export type SessionTree = OrgGroup[];

/**
 * Build a two-level session tree from a flat session list.
 *
 * - Orgs sorted A-Z; the "Ungrouped" bucket (org === null) always comes last.
 * - Projects sorted A-Z within each org; the "no project" bucket comes first.
 * - Sessions sorted by createdAt ascending within their group (null createdAt
 *   sorts to 0 for stability).
 */
export function groupSessions(sessions: SessionInfo[]): SessionTree {
  // Accumulate into a map: org -> project -> sessions[]
  const orgMap = new Map<string | null, Map<string | null, SessionInfo[]>>();

  for (const s of sessions) {
    const org = s.org ?? null;
    const project = s.project ?? null;

    let projectMap = orgMap.get(org);
    if (!projectMap) {
      projectMap = new Map();
      orgMap.set(org, projectMap);
    }

    let bucket = projectMap.get(project);
    if (!bucket) {
      bucket = [];
      projectMap.set(project, bucket);
    }
    bucket.push(s);
  }

  // Sort helper: sessions by createdAt ascending.
  const sortSessions = (a: SessionInfo, b: SessionInfo) =>
    (a.createdAt ?? 0) - (b.createdAt ?? 0);

  // Build the tree.
  const result: SessionTree = [];

  // Sort org names A-Z; null (ungrouped) goes last.
  const orgKeys = [...orgMap.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });

  for (const orgKey of orgKeys) {
    const projectMap = orgMap.get(orgKey)!;

    // Sort project names A-Z; null (no project) goes first.
    const projectKeys = [...projectMap.keys()].sort((a, b) => {
      if (a === null) return -1;
      if (b === null) return 1;
      return a.localeCompare(b);
    });

    const projects: ProjectGroup[] = [];
    let sessionCount = 0;

    for (const projKey of projectKeys) {
      const bucket = projectMap.get(projKey)!;
      bucket.sort(sortSessions);
      sessionCount += bucket.length;
      projects.push({ project: projKey, sessions: bucket });
    }

    result.push({ org: orgKey, projects, sessionCount });
  }

  return result;
}

/**
 * Returns true when the tree has any org grouping at all (at least one session
 * has a non-null org). Used by the sidebar to decide whether to render
 * group headers or fall back to a flat list.
 */
export function hasAnyGrouping(sessions: SessionInfo[]): boolean {
  return sessions.some((s) => s.org != null);
}

/**
 * Flat list of all sessions from a tree, preserving tree order.
 * Useful for the collapsed rail which uses a flat list.
 */
export function flattenTree(tree: SessionTree): SessionInfo[] {
  const result: SessionInfo[] = [];
  for (const org of tree) {
    for (const proj of org.projects) {
      result.push(...proj.sessions);
    }
  }
  return result;
}
