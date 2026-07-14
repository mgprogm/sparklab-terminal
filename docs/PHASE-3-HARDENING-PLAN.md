# Phase 3 Plan: Hardening + Daily-Driver UX

Status: **Workstream A implemented + verified** (2026-07-14). Gate 7 green, 14/14 E2E passing.
Branch: `feat/monorepo-platform`.

## Goal / definition of done

Every doc in this repo carries the same warning: _the gateway is unauthenticated remote code execution — do not expose it publicly._ Phase 3 exists to delete that sentence. Done means:

1. The terminal can be deployed behind a reverse proxy on a real network (HTTPS/WSS, authenticated, origin-checked, rate-limited) and used daily from the phone the mobile work (commit `01d60e2`) was built for.
2. The two biggest remaining UX gaps are closed: scrollback survives reconnect, and the session list shows what's alive/attached/idle.

Everything here is additive at the gateway boundary. **No wire-protocol changes**: keystrokes stay binary WS frames, control stays JSON text frames, resize stays `sendResize()`, teardown stays `pty.kill()`-only. The three-lifetimes model is untouched — auth decides _whether_ you may attach, never _what owns the job_.

## Non-goals (deferred to Phase 4+)

- Multi-user accounts, per-user tmux sockets/Unix-user isolation, RBAC.
- Session sharing / read-only viewers.
- Mobile phase-2 items (pinch-zoom font, selection handles, edge-swipe, PWA manifest).
- Gateway TypeScript conversion (still a separate task per the platform plan).
- Idle-session garbage collection — the product's whole point is that sessions survive; any future reaping must be opt-in and loud. Phase 3 only _surfaces_ idleness (B2), it never acts on it.

## Workstream A — Security (blocking; ship in this order)

### A1. WebSocket Origin check (CSWSH) — first, smallest, highest value

Today `server.on('upgrade')` (`apps/terminal-gateway/src/server.js:273`) accepts any origin: any web page the operator visits can open `ws://<gateway>/attach` and type into their shell, because browsers do not apply CORS to WebSocket upgrades.

- Add `ALLOWED_ORIGINS` env (comma-separated, e.g. `https://term.example.com`; dev default `http://localhost:3000,http://localhost:3007`).
- In the upgrade handler, reject with `socket.write('HTTP/1.1 403 ...')` + destroy when `req.headers.origin` is absent or not in the allowlist. Same check on state-changing REST (`POST`/`DELETE` in `handleApi`) as CSRF belt-and-braces.
- Unit-style test alongside the existing gateway test scripts: upgrade with a bad `Origin` must be refused, with a good one must attach.

### A2. Token auth (single-user) on REST + WS

Single shared secret, browser session via cookie. No user accounts, no password storage.

- **Secret**: `GATEWAY_AUTH_TOKEN` env. If unset, gateway runs in today's open mode **only when bound to loopback** (see A3); refuses to start unbound+tokenless.
- **Login**: `POST /api/auth/login` `{ token }` → `crypto.timingSafeEqual` compare → on success set session cookie: `HttpOnly; SameSite=Strict; Path=/; Secure` (Secure skipped on plain-HTTP loopback dev). Cookie value = random 128-bit session id, held in an in-memory `Map` with absolute expiry (e.g. 30 days); gateway restart logs everyone out — acceptable for single-user, no persistence to design. `POST /api/auth/logout` clears it. `GET /api/auth/me` → `200`/`401` for the frontend to probe.
- **Enforcement**: every `/api/*` route except `/api/auth/*` and every `/attach` upgrade requires a valid cookie → otherwise `401` (REST) / `4001` close (WS upgrade: `401` before handshake).
- **Why cookies work in both topologies**: cookies are host-scoped, not port-scoped — a cookie set via the Next rewrite proxy on `localhost:3000` is sent on the direct WS to `localhost:3007` in dev; in prod the single-origin reverse proxy (A3) makes it trivially same-origin. No token ever appears in a URL.
- **Frontend** (`apps/terminal`): a `features/auth/` slice — login form (RHF + Zod, schema in `packages/shared-types`), TanStack Query `me` probe gating the shell, 401 responses from `use-sessions` redirect to login, `Connection` treats the WS auth-failure close code as `noReconnect` (no backoff loop against a 401).
- **shared-types**: add `auth.ts` Zod schemas (login body, error shape, WS close codes).

### A3. TLS/WSS via reverse proxy; gateway binds loopback

TLS terminates at a reverse proxy (Caddy recommended — automatic certs), **not** in Node. This was already the platform plan's prod stance; Phase 3 implements and documents it.

- Gateway: add `HOST` env, **default `127.0.0.1`** (breaking change from implicit `0.0.0.0` — release-noted; LAN access now goes through the proxy). `server.listen(PORT, HOST)`.
- Ship `deploy/Caddyfile` example: one origin, `/api/*` and `/attach` → gateway, everything else → the Next.js app (or its static export). WS proxying works out of the box in Caddy.
- Docs: new `docs/DEPLOYMENT.md` (topology diagram, envs, Caddyfile, "what makes this safe now" checklist); update GETTING-STARTED env table and delete the "do not expose" warnings in favor of "expose only via the documented proxy".

### A4. Rate limiting + slow-loris guards

Scoped to the cheap, meaningful limits — not a WAF:

- Login: fixed-window per-IP (e.g. 5 attempts/min, `429` + `Retry-After`), in-memory.
- Global: cap concurrent WS connections (e.g. 32) and sessions (`MAX_SESSIONS` already implied by create flow — make it an env), cap request body size in `readBody`, set `server.headersTimeout`/`requestTimeout`.
- Honor `X-Forwarded-For` **only** when `TRUST_PROXY=1` (set in the documented proxy topology), else use socket address.

### A5. E2E gate 7 — "unauthenticated is rejected"

New Playwright spec `apps/e2e/specs/gate-7-auth.spec.ts`, same style as gates 1–6:

1. REST list/create without cookie → `401`.
2. `/attach` upgrade without cookie → refused; with bad `Origin` → refused.
3. Login with wrong token → `401` (and `429` after the burst); with right token → session list loads, terminal attaches, keystrokes echo.
4. Existing gates 1–6 still pass **with auth enabled** (the suite logs in once in a setup project and reuses storage state).

### Status update (2026-07-14)

Workstream A (A1--A5) is implemented and verified. All E2E specs pass (14 tests; gates 1--6 in open mode, gate 7 boots an authed gateway on the same port). Codex CLI was unavailable (bwrap sandbox error), so leads implemented directly.

Two documented follow-ups remain before A5 is fully complete:

1. **Gates 1--6 under an authed gateway.** The plan's A5.4 specifies that gates 1--6 pass with auth enabled (log in once, reuse storage state). In practice, gates 1--6 run in open mode; gate 7 swaps to an authed gateway only for itself and restores open mode in `afterAll`. Running gates 1--6 under auth requires a Node-side login helper in `apps/e2e/helpers.ts` (so non-browser test setup can obtain a cookie) plus a product decision on gate 3's restart-logs-you-out scenario (in-memory `authSessions` are lost on gateway restart, invalidating the cookie mid-test).
2. **Gate 3's bare `lsof` kill footgun.** `gate-3-reconnect.spec.ts` line 62 uses `lsof -ti:${GATEWAY_PORT} | xargs -r kill -9` without the `-sTCP:LISTEN` filter. This matches client sockets too (e.g. Playwright's own undici keep-alive connections), which can kill the test worker itself. Gate 7 already uses the safe form (`-sTCP:LISTEN`); gate 3 should be updated to match.

## Workstream B — Daily-driver UX

### B1. Scrollback restore on reconnect

The one remaining data-loss feeling: reattach shows only the current screen. The design doc's Edge Cases section explains why naive replay double-draws; the safe design keeps tmux's attach redraw as the single screen-painter and injects history only _behind_ it:

- **Gateway**: `GET /api/sessions/:id/scrollback?lines=N` (N clamped, default 2000) → runs `tmux capture-pane -p -e -J -S -N -E -1 -t <session>` once and returns `{ lines: string }` (ANSI-colored, joined). Read-only; no state.
- **Client sequencing** (in `connection.ts` + `xterm.tsx`, extending the existing `freshConnect` mechanism): on (re)connect, fetch scrollback **before** opening the WS; on the first binary frame keep the existing `term.reset()`, then write the scrollback text followed by `\r\n`, **then** write the frame. tmux's redraw repaints the visible screen on top (absolute cursor addressing), pushing the injected history into xterm's scrollback buffer — no double-draw of the viewport, history available on scroll-up.
- **Known imperfection, accepted**: injected history duplicates the lines currently on-screen (they exist both in scrollback and in the redraw). Mitigate by trimming the last `term.rows` lines of the capture; perfect dedup is out of scope.
- **Gate 8** (Playwright): run `seq 1 500`, hard-reload the page, scroll up → line `42` is present; vim redraw (gate 5) still clean with scrollback enabled.

### B2. Session status in the sidebar

Surface what tmux already knows; zero new state:

- **Gateway**: extend `GET /api/sessions` items with `attachedClients` (`#{session_attached}`) and `lastActivity` (`#{session_activity}`, epoch) from the existing `tmux ls -F` call; extend the Zod schema in `packages/shared-types` (optional fields — old clients unaffected).
- **Frontend**: in `session-list.tsx`, a status dot + label per row — `attached` (green, N viewers), `idle <relative time>` otherwise; relative time from `lastActivity`, refreshed by the existing 3s query poll. Tooltip on desktop, plain text on touch (no tooltip-only affordance — mobile spec B5 rule).

## Rollout order & estimates

| Step | Scope                                             | Owner | Est.     |
| ---- | ------------------------------------------------- | ----- | -------- |
| A1   | Origin allowlist on upgrade + mutating REST       | BE    | 0.5 day  |
| A2   | Token auth: gateway endpoints + cookie + FE login | BE+FE | 2–3 days |
| A3   | `HOST` bind, Caddyfile, DEPLOYMENT.md             | BE    | 1 day    |
| A4   | Rate limits, connection/body caps                 | BE    | 1 day    |
| A5   | Gate 7 + gates 1–6 under auth                     | QA    | 1 day    |
| B1   | Scrollback endpoint + client sequencing + gate 8  | BE+FE | 2–3 days |
| B2   | Status fields + sidebar badges                    | FE    | 1 day    |

A1–A5 ship together as the security release (~1 week); B1–B2 follow (~1 week). B-items must not start before A5 is green, so every new endpoint is born authenticated.

## Risks

- **WS close-code handling in `Connection`**: a 401 on upgrade must not trigger the reconnect backoff loop (hammering the gateway). Map the auth-failure close to the existing `noReconnect` path and test it.
- **Cookie vs. dev topology drift**: dev (two ports) relies on host-scoped cookies + the Next rewrite for login; if the WS URL derivation in `connection.ts:80-81` ever moves to a different host than the REST proxy target, auth silently breaks. Gate 7 runs in the dev topology to catch this.
- **Scrollback double-draw regression**: the exact failure the design doc warns about. Gate 8 includes the vim-redraw check with scrollback enabled; if sequencing proves fragile, ship B1 behind a client flag and fall back to no-replay.
- **`timingSafeEqual` length mismatch throws** — hash both sides (SHA-256) before comparing.
- **Loopback default breaks existing LAN users** (A3): called out in the release notes; the fix is the documented proxy, not re-opening the bind.

## Explicitly out of scope (Phase 4 candidates)

Per-user isolation (separate tmux sockets / Unix users), session sharing & read-only mode, audit logging, idle-GC with notification, PWA/add-to-homescreen, gateway TS conversion.
