"use client";

import { useEffect } from "react";

import { isSettingsSection, type SettingsSection } from "../store";

/**
 * Syncs the settings dialog with a value-carrying `?settings=<section>` param.
 * Same `window.history.replaceState` mechanism as the other URL-sync hooks;
 * this one differs because one param encodes two pieces of state — open (the
 * param's presence) and the active tab (its value).
 *
 * - Read once, on mount: if `settings` is present, open the dialog; if its
 *   value is a known section, select that tab. Absence defers to the current
 *   state (never force-closes).
 * - Write, on change: `?settings=<section>` while open, removed when closed.
 *   `replaceState` only — opening/closing and tab switches don't create
 *   back/forward history entries.
 */
export function useSettingsUrlSync(
  open: boolean,
  section: SettingsSection,
  setOpen: (open: boolean) => void,
  setSection: (section: SettingsSection) => void,
): void {
  // Read (URL → state), once.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("settings");
    if (raw === null) return; // param absent → defer to current state
    setOpen(true);
    if (raw && isSettingsSection(raw)) setSection(raw);
  }, []);

  // Write (state → URL), on change.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set("settings", section);
    else url.searchParams.delete("settings");
    window.history.replaceState(null, "", url);
  }, [open, section]);
}
