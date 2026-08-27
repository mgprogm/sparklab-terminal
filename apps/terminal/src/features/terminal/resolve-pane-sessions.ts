/**
 * Grid-aware sibling of `resolveActiveSession` (session-fallback.ts) — the
 * pure decision behind the multi-window "active session vanished -> fall
 * back" effect. Kept out of the component so it can be unit-tested without
 * rendering the whole shell. See docs/MULTI-WINDOW-PLAN.md D7.
 *
 * Same load-gate reasoning as resolveActiveSession: useSessions has no
 * initialData, so `sessions` is [] during the initial fetch. Acting then
 * would null every pane's persisted session before the list is even known.
 */

/** Minimal shape needed here — the real sessions carry more. */
interface SessionLike {
  id: string;
}

/**
 * Decide the next per-pane session ids after a sessions-list update.
 *
 * Order of operations (D4 + D7, reconciled):
 * 1. Drop any pane id not present in `sessions` (-> null).
 * 2. Dedupe: if two panes resolved to the same id, keep the FIRST
 *    occurrence and null out later ones (D4 — a session in at most one
 *    pane).
 * 3. Only the FOCUSED pane, if still empty after the above AND at least one
 *    session exists, auto-fills with the first session not already claimed
 *    by another pane. This — not always `sessions[0]` — is what keeps D4
 *    and D7 satisfied simultaneously: `sessions[0]` may already be shown in
 *    a different pane, and re-assigning it there would violate D4. If every
 *    session is already claimed elsewhere, the focused pane stays empty
 *    (nothing left to show it). In `single` mode there is no "other pane",
 *    so this degrades exactly to resolveActiveSession's "attach to
 *    sessions[0]" rule.
 *
 * @returns the next `sessionId | null` array (same length/order as
 *   `paneSessionIds`), or `undefined` when nothing would change — mirroring
 *   resolveActiveSession's contract exactly. This matters: the caller effect
 *   only writes back (via `reconcilePanes`) when the result is not
 *   `undefined`, and a fresh-but-equal array would otherwise create a new
 *   array identity every render and refire the effect forever.
 */
export function resolvePaneSessions(
  sessionsLoaded: boolean,
  sessions: SessionLike[],
  paneSessionIds: (string | null)[],
  focusedPaneIndex: number,
): (string | null)[] | undefined {
  // Still loading: don't touch any pane (the bug fix — see module doc).
  if (!sessionsLoaded) return undefined;

  const validIds = new Set(sessions.map((s) => s.id));
  const claimed = new Set<string>();

  const resolved: (string | null)[] = paneSessionIds.map((id) => {
    if (id !== null && validIds.has(id) && !claimed.has(id)) {
      claimed.add(id);
      return id;
    }
    return null;
  });

  if (
    focusedPaneIndex >= 0 &&
    focusedPaneIndex < resolved.length &&
    resolved[focusedPaneIndex] === null
  ) {
    const fallback = sessions.find((s) => !claimed.has(s.id));
    if (fallback) {
      resolved[focusedPaneIndex] = fallback.id;
      claimed.add(fallback.id);
    }
  }

  const changed = resolved.some((id, i) => id !== paneSessionIds[i]);
  return changed ? resolved : undefined;
}
