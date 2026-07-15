"use client";

import { normalizeSessionRef } from "@sparklab/shared-types";
import { useEffect } from "react";

/**
 * Syncs the `?session=<id>` URL query param with the terminal store's
 * activeSessionId.
 *
 * Mechanism is `window.history.replaceState`, deliberately NOT
 * `useSearchParams()`: the latter forces a <Suspense> boundary (none exists in
 * this route) and opts the route into the client-side-rendering bailout. It's
 * also loop-safe by construction — React is not subscribed to the URL, so a
 * store→URL write can never feed back into the URL→store read.
 *
 * Precedence / direction:
 * - Read once, on mount: a `?session` param OVERRIDES the rehydrated persisted
 *   activeSessionId (a shared/bookmarked link is explicit intent). The id is
 *   set through setActiveSessionId; `resolveActiveSession` then validates it
 *   against the loaded list and falls back if it no longer exists.
 * - Write, on every change: reflect activeSessionId back into the URL (so a
 *   plain persisted restore also shows up as `?session`). `replaceState`, never
 *   `pushState` — session switches don't create back/forward history entries.
 *
 * The read effect is declared before the write effect so, on the first commit,
 * it captures the incoming URL value before the write overwrites it.
 */
const PARAM = "session";

export function useSessionUrlSync(
  activeSessionId: string | null,
  setActiveSessionId: (id: string | null) => void,
): void {
  // Read (URL → store), once. Mount-only: the URL is read a single time; the
  // store is the source of truth thereafter.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get(PARAM);
    // Normalize so a bare `?session=web-…` bookmark (pre-multi-server, or a
    // hand-typed link) matches the now-qualified `local/web-…` list ids.
    if (fromUrl) setActiveSessionId(normalizeSessionRef(fromUrl));
  }, []);

  // Write (store → URL), on change.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (activeSessionId) url.searchParams.set(PARAM, activeSessionId);
    else url.searchParams.delete(PARAM);
    window.history.replaceState(null, "", url);
  }, [activeSessionId]);
}
