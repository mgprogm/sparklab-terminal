"use client";

/**
 * Registers the service worker (public/sw.js) for PWA installability + the
 * offline fallback. Renders nothing.
 *
 * Guarded to production and browsers that support the API: a dev-registered SW
 * caching /_next/static would make `next dev` sessions confusing, and the SW is
 * only meaningful against a real production build. See docs/PWA-PLAN.md.
 */
import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    // Register after load so it never competes with the first paint / attach.
    const register = () => {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failures are non-fatal — the app works without the SW.
      });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
