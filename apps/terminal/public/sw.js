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
const CACHE_VERSION = "v1";
const CACHE_NAME = `sparklab-terminal-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// App-shell assets worth precaching. Only the fully static, self-contained
// fallback shell — not the dynamic app document or hashed JS/CSS.
const PRECACHE_URLS = [OFFLINE_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Activate this SW immediately rather than waiting for all tabs to close.
      .then(() => self.skipWaiting()),
  );
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
