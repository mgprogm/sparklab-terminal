"use client";

/**
 * Unified, unobtrusive "install" affordance — ONE component, two paths:
 *
 * - **Chromium / Android / desktop:** listens for `beforeinstallprompt`,
 *   suppresses the browser's default mini-infobar, and shows a small "Install
 *   app" pill that triggers the native prompt.
 * - **iOS Safari:** there is no `beforeinstallprompt` — installing is manual via
 *   the Share sheet → "Add to Home Screen", and on iOS that install is a
 *   PREREQUISITE for Web Push to work at all. So we show a one-time, dismissible
 *   coaching card with those steps. Shown ONLY on iOS Safari, when not already
 *   installed, and when not previously dismissed.
 *
 * Both anchor bottom-LEFT (the agent FAB owns bottom-right) and persist their
 * dismissal in localStorage so they never nag. Theme tokens per DESIGN.md;
 * lucide icons at size-3.5. See docs/PWA-PLAN.md.
 */
import { Button } from "@sparklab/ui/components/ui/button";
import { Download, Share, SquareArrowUp, X } from "lucide-react";
import { useEffect, useState } from "react";

import { isIosSafari, isStandalonePwa } from "./pwa-detect";

// Minimal shape of the non-standard event (not in lib.dom yet).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// iOS Safari exposes a non-standard `navigator.standalone` (not in lib.dom).
interface NavigatorStandalone extends Navigator {
  standalone?: boolean;
}

const DISMISS_KEY = "sparklab.installPrompt.dismissed";
const IOS_DISMISS_KEY = "sparklab.iosInstallHint.dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // --- Chromium path: beforeinstallprompt ---
    const chromiumDismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setShowIosHint(false);
    };
    if (!chromiumDismissed) {
      window.addEventListener("beforeinstallprompt", onBeforeInstall);
    }
    window.addEventListener("appinstalled", onInstalled);

    // --- iOS path: Share-sheet coaching ---
    const nav = window.navigator as NavigatorStandalone;
    const standaloneMedia = window.matchMedia(
      "(display-mode: standalone)",
    ).matches;
    const ios = isIosSafari(nav.userAgent, nav.platform, nav.maxTouchPoints);
    const installed = isStandalonePwa(nav.standalone, standaloneMedia);
    const iosDismissed = window.localStorage.getItem(IOS_DISMISS_KEY) === "1";
    if (ios && !installed && !iosDismissed) setShowIosHint(true);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // --- Chromium pill (takes precedence when the native prompt is available) ---
  if (deferred) {
    const install = async () => {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null); // the event can only be used once
    };
    const dismiss = () => {
      window.localStorage.setItem(DISMISS_KEY, "1");
      setDeferred(null);
    };
    return (
      <div className="bg-card border-border text-foreground animate-in fade-in slide-in-from-bottom-2 fixed bottom-4 left-4 z-50 flex items-center gap-1 rounded-md border py-1 pl-2 pr-1 shadow-sm">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={() => void install()}
        >
          <Download className="size-3.5" />
          Install app
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7"
          aria-label="Dismiss install prompt"
          onClick={dismiss}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  // --- iOS coaching card ---
  if (showIosHint) {
    const dismissIos = () => {
      window.localStorage.setItem(IOS_DISMISS_KEY, "1");
      setShowIosHint(false);
    };
    return (
      <div className="bg-card border-border text-foreground animate-in fade-in slide-in-from-bottom-2 fixed bottom-4 left-4 z-50 flex max-w-[19rem] items-start gap-2 rounded-md border p-3 shadow-sm">
        <Share className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 text-xs leading-relaxed">
          <p className="text-foreground text-sm font-medium">
            Install to your Home Screen
          </p>
          <p className="text-muted-foreground mt-1">
            Tap{" "}
            <SquareArrowUp className="mx-0.5 inline size-3.5 align-text-bottom" />{" "}
            Share, then{" "}
            <span className="text-foreground">Add to Home Screen</span>.
            Required for notifications on iOS.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground -mr-1 -mt-1 size-7 shrink-0"
          aria-label="Dismiss install hint"
          onClick={dismissIos}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return null;
}
