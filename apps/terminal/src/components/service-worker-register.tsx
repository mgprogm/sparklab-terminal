"use client";

/**
 * Registers the service worker (public/sw.js) and surfaces an unobtrusive
 * "Update available — reload" prompt when a NEW version is waiting.
 *
 * Guarded to production + browsers that support the API: a dev-registered SW
 * caching /_next/static would make `next dev` sessions confusing, and the SW is
 * only meaningful against a real production build.
 *
 * Update lifecycle (see also public/sw.js + docs/PWA-PLAN.md): the SW no longer
 * auto-`skipWaiting()`s, so a new version parks in "waiting". We detect it
 * (either already-waiting on load, or via `updatefound` while the page is open)
 * and — only when an existing worker already controls the page (a genuine
 * update, not the first install) — show the prompt. Accepting posts
 * `SKIP_WAITING` to the waiting worker and reloads ONCE on `controllerchange`.
 * The reload listener is attached only on accept (so a first-install
 * `clients.claim()` never triggers a reload) and is `{ once: true }` +
 * ref-guarded against loops.
 */
import { Button } from "@sparklab/ui/components/ui/button";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isUpdateWaiting } from "./pwa-detect";

export function ServiceWorkerRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    let cleanupUpdateFound: (() => void) | undefined;

    const onRegistered = (registration: ServiceWorkerRegistration) => {
      // Already installed-and-waiting from a previous visit? (controller present
      // ⇒ this is an update, not a first install.)
      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaiting(registration.waiting);
      }
      // A new version installs while the page is open.
      const onUpdateFound = () => {
        const installing = registration.installing;
        if (!installing) return;
        const onStateChange = () => {
          if (
            isUpdateWaiting(
              installing.state,
              !!navigator.serviceWorker.controller,
            )
          ) {
            setWaiting(registration.waiting ?? installing);
            installing.removeEventListener("statechange", onStateChange);
          }
        };
        installing.addEventListener("statechange", onStateChange);
      };
      registration.addEventListener("updatefound", onUpdateFound);
      cleanupUpdateFound = () =>
        registration.removeEventListener("updatefound", onUpdateFound);
    };

    const register = () => {
      void navigator.serviceWorker
        .register("/sw.js")
        .then(onRegistered)
        .catch(() => {
          // Registration failures are non-fatal — the app works without the SW.
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
    return () => {
      window.removeEventListener("load", register);
      cleanupUpdateFound?.();
    };
  }, []);

  const applyUpdate = () => {
    if (!waiting) return;
    // Reload exactly once, when the new worker takes control.
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        if (reloadingRef.current) return;
        reloadingRef.current = true;
        window.location.reload();
      },
      { once: true },
    );
    waiting.postMessage({ type: "SKIP_WAITING" });
    setWaiting(null);
  };

  if (!waiting) return null;

  return (
    <div className="bg-card border-border text-foreground animate-in fade-in slide-in-from-bottom-2 fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-md border py-1 pl-3 pr-1 shadow-sm">
      <span className="text-sm">A new version is available.</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2"
        onClick={applyUpdate}
      >
        <RefreshCw className="size-3.5" />
        Reload
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground size-7"
        aria-label="Dismiss update notice"
        onClick={() => setWaiting(null)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
