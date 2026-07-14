"use client";

import { useEffect } from "react";

/**
 * Syncs a boolean "open" flag with a presence-style URL query param
 * (`?<param>`). Same mechanism and rationale as `use-session-url-sync`
 * (window.history.replaceState, not useSearchParams). Presence in the URL
 * means open.
 *
 * - Read once, on mount: if the param is present, force the flag open (a
 *   shared/bookmarked link is explicit intent). Absence DEFERS to the current
 *   value (e.g. a persisted `panelOpen`) — it never force-closes.
 * - Write, on change: reflect the flag into the URL — `?<param>=1` when open,
 *   removed when closed. `replaceState` only, so toggling never creates
 *   back/forward history entries.
 *
 * Multiple instances compose: each write only touches its own param and
 * preserves the rest of the query string, and effects run in call order on a
 * synchronously-updated URL.
 */
export function useUrlFlagSync(
  param: string,
  isOpen: boolean,
  setOpen: (open: boolean) => void,
): void {
  // Read (URL → state), once.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has(param)) setOpen(true);
  }, []);

  // Write (state → URL), on change.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (isOpen) url.searchParams.set(param, "1");
    else url.searchParams.delete(param);
    window.history.replaceState(null, "", url);
  }, [isOpen]);
}
