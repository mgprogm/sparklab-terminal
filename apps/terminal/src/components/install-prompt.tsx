"use client";

/**
 * Unobtrusive "Install app" affordance. Listens for the Android/desktop
 * `beforeinstallprompt` event (iOS has no equivalent — Safari installs via the
 * Share sheet, so this simply never shows there) and surfaces a small,
 * dismissible pill anchored bottom-LEFT — the agent FAB owns bottom-right.
 *
 * Dismissal persists in localStorage so it doesn't nag. Styled with theme
 * tokens per DESIGN.md; the lucide Download icon at size-3.5. See docs/PWA-PLAN.md.
 */
import { Button } from "@sparklab/ui/components/ui/button";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

// Minimal shape of the non-standard event (not in lib.dom yet).
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "sparklab.installPrompt.dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      window.localStorage.getItem(DISMISS_KEY) === "1"
    ) {
      return;
    }
    const onBeforeInstall = (event: Event) => {
      // Suppress the browser's default mini-infobar; show our own affordance.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferred) return null;

  const install = async () => {
    await deferred.prompt();
    await deferred.userChoice;
    // Whatever the outcome, the event can only be used once.
    setDeferred(null);
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
