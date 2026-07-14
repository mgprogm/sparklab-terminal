/**
 * Pure decision for the "active session vanished → fall back" effect in
 * TerminalShell. Kept out of the component so it can be unit-tested without
 * rendering the whole shell.
 *
 * The load gate is the load-bearing part: useSessions has no initialData, so
 * `sessions` is [] during the initial fetch. Acting then would null a
 * persisted (or, later, URL-supplied) activeSessionId before the list is even
 * known — see `use-sessions.ts`.
 */

/** Minimal shape needed here — the real sessions carry more. */
interface SessionLike {
  id: string;
}

/**
 * Decide the next activeSessionId after a sessions-list update.
 *
 * @returns the id to set (a string), `null` to clear it, or `undefined` to
 *   leave it unchanged (nothing to do).
 */
export function resolveActiveSession(
  sessionsLoaded: boolean,
  sessions: SessionLike[],
  activeSessionId: string | null,
): string | null | undefined {
  // Still loading: don't touch the id (this is the bug fix — see module doc).
  if (!sessionsLoaded) return undefined;

  // Loaded and genuinely empty: clear any stale selection.
  if (!sessions.length) return activeSessionId ? null : undefined;

  // Selected session is gone: fall back to the first.
  if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
    return sessions[0]?.id ?? null;
  }

  // Nothing selected yet: attach to the first.
  if (!activeSessionId) return sessions[0]?.id ?? null;

  // Selection is valid — leave it alone.
  return undefined;
}
