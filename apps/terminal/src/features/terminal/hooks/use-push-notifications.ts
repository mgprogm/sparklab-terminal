"use client";

/**
 * Client push-notification state + enable/disable for the "job finished"
 * feature. Deliberately unobtrusive: permission is requested ONLY from an
 * explicit user gesture (the settings toggle calling `enable()`), never on
 * load. Graceful on every unsupported path — the toggle renders disabled with
 * a short reason rather than crashing.
 *
 * Flow (enable): request Notification permission -> pushManager.subscribe(
 * {userVisibleOnly, applicationServerKey}) using the gateway's VAPID public key
 * -> POST /api/push/subscribe. Disable: unsubscribe + POST /api/push/unsubscribe.
 *
 * The service worker is registered in production only (see PWA-PLAN.md D5), so
 * in dev there is no registration and the toggle shows disabled with a reason.
 */

import {
  VapidPublicKeyResponseSchema,
  type VapidPublicKeyResponse,
} from "@sparklab/shared-types";
import { useCallback, useEffect, useState } from "react";

// base64url VAPID public key -> Uint8Array for applicationServerKey. The
// classic bug is base64-vs-base64url + missing padding; handle both.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Back the view with a plain ArrayBuffer so it satisfies BufferSource
  // (applicationServerKey rejects the SharedArrayBuffer-widened default).
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Why the toggle is unusable, or null when push is available to enable. */
function detectSupportReason(): string | null {
  if (typeof window === "undefined") return "unavailable";
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return "Not supported on this browser.";
  }
  if (!("PushManager" in window)) {
    // iOS Safari exposes PushManager only for a Home-Screen-installed PWA
    // (iOS 16.4+). In a normal tab it is simply absent.
    const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
    return isIos
      ? "On iOS, install to your Home Screen first."
      : "Not supported on this browser.";
  }
  return null;
}

export interface PushState {
  /** Full support + config resolved (false while the mount probe runs). */
  ready: boolean;
  /** True when the toggle can be interacted with. */
  available: boolean;
  /** Short explanation shown when not available. */
  disabledReason: string | null;
  /** Current subscription state. */
  subscribed: boolean;
  /** In-flight enable/disable. */
  busy: boolean;
  /** Last enable/disable error, human-readable. */
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

async function fetchVapid(): Promise<VapidPublicKeyResponse> {
  const res = await fetch("/api/push/vapid-public-key");
  if (!res.ok) throw new Error(`vapid key: ${String(res.status)}`);
  const data: unknown = await res.json();
  return VapidPublicKeyResponseSchema.parse(data);
}

export function usePushNotifications(): PushState {
  const [ready, setReady] = useState(false);
  const [supportReason, setSupportReason] = useState<string | null>(
    "Not supported on this browser.",
  );
  const [configured, setConfigured] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [hasRegistration, setHasRegistration] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount probe: support -> server config -> existing subscription.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const reason = detectSupportReason();
      if (reason) {
        if (!cancelled) {
          setSupportReason(reason);
          setReady(true);
        }
        return;
      }
      if (!cancelled) setSupportReason(null);

      try {
        const vapid = await fetchVapid();
        if (cancelled) return;
        setConfigured(vapid.configured);
        setPublicKey(vapid.publicKey ?? null);
      } catch {
        if (!cancelled) setConfigured(false);
      }

      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (cancelled) return;
        setHasRegistration(!!reg);
        if (reg) {
          const existing = await reg.pushManager.getSubscription();
          if (!cancelled) setSubscribed(!!existing);
        }
      } catch {
        /* leave defaults */
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (!publicKey) throw new Error("Push is not configured on the server.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Notification permission was not granted.");
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        throw new Error("Service worker unavailable — use the installed app.");
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        throw new Error(
          `Failed to register subscription (${String(res.status)}).`,
        );
      }
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        // Tell the gateway first, then drop the browser subscription.
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // Reason precedence: unsupported browser > server not configured > no SW.
  let disabledReason: string | null = supportReason;
  if (!disabledReason && ready && !configured) {
    disabledReason = "Push is not configured on the server.";
  }
  if (!disabledReason && ready && !hasRegistration) {
    disabledReason = "Available in the installed app.";
  }

  return {
    ready,
    available: ready && !disabledReason,
    disabledReason,
    subscribed,
    busy,
    error,
    enable,
    disable,
  };
}
