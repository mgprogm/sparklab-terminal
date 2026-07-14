"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe matchMedia hook (mobile UX spec §1.1).
 *
 * Returns `false` until mounted so server and first client render agree;
 * pure-CSS cases should use Tailwind `md:` variants instead so there is no
 * pre-hydration flash.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
