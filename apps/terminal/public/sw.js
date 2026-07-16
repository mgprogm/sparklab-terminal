/*
 * Service worker for Sparklab Terminal — installability + an offline app-shell
 * fallback. Deliberately dependency-free (no Workbox/next-pwa) to match the
 * gateway's plain-JS, dependency-minimal ethos. See docs/PWA-PLAN.md.
 *
 * A live terminal is inherently online (raw bytes over a WebSocket), so this SW
 * caches almost nothing:
 *   - It NEVER touches /api/* (the gateway REST + WS-proxy surface). Those are
 *     early-returned before respondWith, so live terminal traffic is never
 *     cached or served stale. (The /attach WebSocket upgrade never reaches a
 *     service worker's fetch event at all, but the /api/* guard is the one that
 *     is load-bearing and is asserted here explicitly.)
 *   - Navigations are network-first, falling back to /offline.html only when
 *     the network is unreachable. The dynamic root document is never precached.
 *   - Immutable Next build assets (/_next/static/*) are cache-first for a fast,
 *     installable shell.
 *   - Everything else passes straight through to the network.
 */

// Bump CACHE_VERSION whenever offline.html or this file changes, so the
// activate handler evicts the previous cache.
const CACHE_VERSION = "v4";
const CACHE_NAME = `sparklab-terminal-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// App-shell assets worth precaching. Only the fully static, self-contained
// fallback shell — not the dynamic app document or hashed JS/CSS.
const PRECACHE_URLS = [OFFLINE_URL];

self.addEventListener("install", (event) => {
  // NOTE: deliberately NO self.skipWaiting() here. A new SW now parks in the
  // "waiting" state instead of auto-activating, so the page can surface an
  // "Update available — reload" prompt (see service-worker-register.tsx). The
  // waiting worker activates only when the page posts { type: "SKIP_WAITING" }
  // below. (The very first SW on a client — no existing controller — activates
  // immediately regardless, since there is nothing to wait behind.)
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

// The page tells us to take over now (user accepted the update prompt).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      // Take control of open clients so the new SW governs immediately.
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs. Everything else (POST/PATCH/DELETE, uploads,
  // cross-origin) passes through untouched.
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Load-bearing bypass: never intercept the gateway API/WS-proxy surface.
  // No respondWith → the browser handles these exactly as if no SW existed.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Navigations: network-first, fall back to the offline shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(OFFLINE_URL);
        return cached ?? Response.error();
      }),
    );
    return;
  }

  // Immutable build assets: cache-first (serve fast, populate on first hit).
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Anything else: passthrough (no respondWith).
});

// ---------------------------------------------------------------------------
// Web Push — "your job finished" notifications (see docs/PUSH-NOTIFICATIONS-PLAN.md).
// ---------------------------------------------------------------------------

// Pure suppression rule (kept standalone + self-contained so it is unit-tested
// directly in test/push-endpoints.js). Returns true when some same-origin window
// client is BOTH visible AND focused AND already showing this session via its
// `?session=<id>` URL param. `URL.searchParams.get` decodes the percent-encoded
// qualified id (the frontend writes `?session=<serverId%2Fweb-...>`), so it
// compares equal to the payload's raw `sessionId`.
function hasVisibleClientForSession(clients, sessionId) {
  if (!sessionId) return false;
  return clients.some((client) => {
    if (client.visibilityState !== "visible" || client.focused !== true) {
      return false;
    }
    try {
      return new URL(client.url).searchParams.get("session") === sessionId;
    } catch {
      return false;
    }
  });
}

// EVERY push normally MUST call showNotification: iOS and Chrome revoke push
// permission for silent/data-only pushes. The ONE permitted exception — used
// here — is that the Push API lets the user agent relax the userVisibleOnly
// requirement WHILE a same-origin window is visible; Chromium does not spend the
// silent-push budget (nor show its "site updated in background" fallback) in
// that window. So we omit the OS notification ONLY when the user is already
// looking at the exact session that finished — otherwise it is pure noise. In
// every other case (tab closed, backgrounded, or a different session on screen)
// we always showNotification, exactly as before. The payload stays GENERIC
// (session name + "finished", never command output) since it transits the push
// service. See docs/PUSH-NOTIFICATIONS-PLAN.md.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = {};
      }
      const title = data.title || "Job finished";
      const body = data.body || "A terminal command finished.";
      // The relevant session id, used to suppress + by notificationclick.
      const sessionId =
        typeof data.sessionId === "string" ? data.sessionId : null;

      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Suppress: the user is actively viewing this terminal. Permission-safe
      // per the visible-client exception above.
      if (hasVisibleClientForSession(clients, sessionId)) return;

      await self.registration.showNotification(title, {
        body,
        tag: data.tag || "sparklab-job",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { sessionId },
      });
    })(),
  );
});

// Focus an existing app window (deep-linking to the session via ?session=<id>
// — that URL param already drives active-session selection) or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId =
    event.notification.data && event.notification.data.sessionId;
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            // Reuse an open app window; steer it to the session if we can.
            if (sessionId && "navigate" in client) {
              return client.focus().then(() => client.navigate(target));
            }
            return client.focus();
          }
        }
        return self.clients.openWindow ? self.clients.openWindow(target) : null;
      }),
  );
});
