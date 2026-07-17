# "Job finished" Push Notifications — Design & Decision Record

> Status: **implemented & verified** (2026-07-16). A Web Push notification is
> delivered when a command finishes in any session, even with the tab closed or
> the device asleep. Builds on the PWA shipped the same day (`docs/PWA-PLAN.md`).
> The whole feature is **inert** unless VAPID is configured AND ≥1 device has
> subscribed — zero subscriptions means zero added cost and no behavior change.

## What ships

- **Gateway owns push end to end** (`apps/terminal-gateway`): VAPID config + a
  subscription store + a gated poll loop + the `web-push` send path.
- **3 REST routes** under `/api/push/*` (behind the existing cookie auth).
- **Service worker** `push` + `notificationclick` handlers.
- **Frontend**: an unobtrusive toggle in Settings → _Notify_, permission
  requested only on that explicit gesture.
- **VAPID keygen** script + env wiring + graceful "not configured" degradation.

---

## 1. Architecture decisions (settled before implementation)

- **D1 — The gateway owns push, not the agent-service.** The gateway already
  runs `tmux list-sessions` (the signal source), is the single enforcement
  point for auth/sessions, owns all sidecar-JSON persistence, and the browser
  already proxies `/api/*` to it. The agent-service is not reachable from the
  frontend over REST and has no business here.
- **D2 — Use the `web-push` library; do NOT hand-roll crypto.** Web Push is
  RFC 8291 `aes128gcm` payload encryption + an RFC 8292 VAPID JWT. A subtle bug
  there fails _silently_ as non-delivery — the exact opposite of the user's
  hard constraint ("no fake notifications that can't really notify"). This is
  the one deliberate, documented dependency added to the otherwise
  dependency-minimal gateway; that ethos was about keeping agent/OpenAI
  complexity out, not a zero-dep vow.
- **D3 — Signal = `pane_current_command` transition non-shell → shell.**
  `listSessions()` already returns `currentCommand` per session cheaply in one
  `tmux list-sessions` call. No screen-diffing (too expensive over SSH). The
  shell set (`bash`/`zsh`/`sh`/`fish`/`dash`, plus login-shell `-bash` form)
  mirrors `SHELLS` in `apps/agent-service/src/tools.ts`.
- **D4 — Web Push, not Background Sync.** Background Sync (`sync`) is
  retry-on-reconnect for _outbound_ actions — wrong mechanism. Periodic
  Background Sync is Chromium-only with deliberately unreliable timing. Neither
  can wake a closed page to say "your job finished." Web Push is the only
  primitive that does, so it is the answer.
- **D5 — Subscription store = gitignored sidecar JSON**
  (`push-subscriptions.json`), atomic tmp+rename write, mirroring
  `registry.js`/`servers.json`. Single-user auth ⇒ effectively one user with
  many device subscriptions, deduped by `endpoint`. A dead endpoint
  (`404`/`410` from the push service) is pruned so the store never rots.

---

## 2. The poll loop (the one real always-on change)

`apps/terminal-gateway/src/server.js`, started/stopped by the `/api/push/*`
routes and at boot.

- **Gated on ≥1 subscription.** Zero subscriptions ⇒ the loop never runs ⇒ zero
  cost, zero behavior change (single-server and remote-SSH cost profiles stay
  identical to before). `startPushLoop()` fires when the first subscription
  arrives (or at boot if subscriptions persisted a restart); `stopPushLoop()`
  when the last one leaves.
- **Baseline rule.** The FIRST tick after a (re)start records every reachable
  session's `currentCommand` and notifies **nothing** — otherwise every
  already-running job would "finish" on gateway restart and spam. Per-session
  last-known state is in-memory/transient (consistent with "jobs survive,
  notifications are best-effort"). Baseline resets only on stopped→running; a
  second subscription while running does NOT re-baseline.
- **Transition logic** (the silent-correctness surface):
  - Only **`reachable:true`** rows are evaluated and update state. Unreachable
    rows carry a fabricated `""` — letting that through would fire spurious
    pushes on a network flap (`job → "" → job`). Flap ⇒ no-op.
  - Fire only when `prev` is a _genuine_ non-shell command (non-empty, not a
    shell) and `curr` is a shell. `""` is "unknown" — never a shell, never a
    trigger.
  - A session first seen after baseline just records; it never fires on its
    first observation. A vanished session is forgotten so a re-created id
    re-baselines cleanly.
- **Interval:** `PUSH_POLL_INTERVAL_MS = 4000` (a const).

On a detected finish, `push.sendToAll({ title, body, sessionId, tag })` runs the
`web-push` encrypt+POST to every subscription and prunes any `404`/`410`.

---

## 3. Service worker (`apps/terminal/public/sw.js`)

- **`push`** — parses the JSON payload and calls `showNotification`, **except**
  in the one permission-safe suppression case below. `CACHE_VERSION` bumped
  `v2`→`v3` with this change (`v1`→`v2` was the original push handler).
- **`notificationclick`** — focuses an existing app window (navigating it to
  `?session=<id>` when possible) or opens one there. That URL param already
  drives active-session selection.
- The existing `fetch`/`install`/`activate` handlers and the load-bearing
  `/api/*` + WebSocket bypass are **untouched**.

### Visible-session suppression (implemented 2026-07-16)

**Rule.** Before showing, the `push` handler calls
`self.clients.matchAll({ type: "window", includeUncontrolled: true })` and omits
the OS notification **iff** some client is **`visibilityState === "visible"`
AND `focused === true`** AND its URL's `?session=<id>` (percent-decoded by
`URL.searchParams.get`, matching the frontend's qualified `serverId/web-…`
value) **equals the payload's `sessionId`**. In every other case — tab closed,
backgrounded, or a _different_ session on screen — it always `showNotification`,
exactly as before. Extracted as the pure function `hasVisibleClientForSession`
so it is unit-tested directly (see §8).

**Why it is permission-safe (pure-omit, no toast).** The Push API spec lets the
user agent _relax_ the `userVisibleOnly` requirement while a same-origin window
is visible, and Chromium implements exactly this: it does **not** spend the
silent-push budget nor show its "site updated in the background" fallback when a
window client is visible. This is the canonical MDN/web.dev pattern ("the
exception to always showing a notification is when the user already has your
site open"). So omitting the notification here incurs **no** permission penalty.
No in-app toast is shown: when the user is already looking at the exact terminal
that finished, the completion is visible on screen — any extra alert (OS or
in-app) would be redundant noise ("ไม่รบกวนผู้ใช้").

**Evidence / honesty note.** Chrome's silent-push _enforcement_ cannot be
exercised in this repo's automated environment (Playwright Chromium has no FCM
API keys, so a real Chrome push can't be delivered to a focused tab here). The
choice therefore rests on the documented W3C Push API relaxation + Chromium's
implemented behavior, not an end-to-end Chrome-penalty test. The **decision
logic** itself (which branch fires) is unit-tested against the shipped function.

---

## 4. Frontend UX (unobtrusive — "ไม่รบกวนผู้ใช้")

- **Permission requested only on the explicit toggle gesture** — never an
  on-load `Notification.requestPermission()`.
- `apps/terminal/src/features/terminal/hooks/use-push-notifications.ts` holds
  all client logic; a _Notify_ tab in the settings dialog exposes the toggle
  (`Bell`/`BellOff`, theme tokens, `@sparklab/ui`).
- Enable flow: request permission → `pushManager.subscribe({ userVisibleOnly,
applicationServerKey })` with the fetched VAPID public key → `POST
/api/push/subscribe`. Disable: `POST /api/push/unsubscribe` + browser
  `unsubscribe()`.
- **Graceful fallback:** the toggle shows disabled with a short reason when the
  browser lacks `serviceWorker`/`PushManager`/`Notification`, when push is not
  configured server-side, or when no service worker is registered ("Available in
  the installed app"). On iOS in a normal tab, `PushManager` is simply absent, so
  the reason becomes "On iOS, install to your Home Screen first." Never crashes,
  never shows a dead control.

---

## 5. VAPID setup / migration steps

VAPID keys are a new secret. They are the application-server identity the push
service authenticates the gateway with.

1. **Generate once per deployment:**
   ```bash
   pnpm --filter @sparklab/terminal-gateway generate-vapid
   ```
2. **Paste the output into `apps/terminal-gateway/.env`:**
   ```
   VAPID_PUBLIC_KEY=<base64url public>
   VAPID_PRIVATE_KEY=<base64url private>
   VAPID_SUBJECT=mailto:you@example.com   # mailto: or https: contact URI
   ```
   (See `apps/terminal-gateway/.env.example`.)
3. **Restart the gateway.** On boot it logs whether push is configured.
4. **Keep the keys STABLE.** Rotating them invalidates every existing browser
   subscription (each is bound to the public key it was created with) — every
   device would have to re-enable. Treat rotation as a migration.
5. **If keys are absent** the gateway boots and runs exactly as before: the
   endpoints report "not configured" and the poll loop never starts.

---

## 6. Platform constraints (call these out to users)

- **iOS:** Web Push works **only** for a Home-Screen-installed PWA on **iOS
  16.4+** — coherent with the install path already shipped, but surfaced in the
  toggle copy and here.
- **Payload privacy:** the payload transits third-party push services
  (FCM / Apple / Mozilla autopush). It is kept **generic** — session name +
  "the running command finished" — and **never** contains command output.
- **HTTPS/localhost only:** service workers (hence push) require a secure
  context. Production is served over HTTPS; `localhost` also qualifies.

---

## 7. Detection limits (honest — this is what "don't fake it" means)

- Tracks the **active pane's** `currentCommand` only. A job finishing in a
  **background tmux window** of a session is missed.
- A job that finishes **during a gateway-restart window** is missed (the first
  post-restart poll is a silent baseline).
- Detection is a poll (~4s), so timing is approximate.
- Best-effort by design: jobs survive; notifications do not have to.

---

## 8. Verification (how the crypto correctness was proven)

`apps/terminal-gateway/test/push-endpoints.js` (`pnpm --filter
@sparklab/terminal-gateway test:push`), a standalone-node test:

- **The crypto gate (non-negotiable):** drives a **real headless browser**
  (Playwright **Firefox** → **Mozilla autopush**; Playwright's Chromium can't —
  it lacks Google's FCM API keys, returning "push service not available") to
  call `pushManager.subscribe` against the **live** push service, then runs the
  gateway's **own** `push.js` send code (VAPID JWT + `web-push` `aes128gcm`
  encrypt + POST) to that real endpoint and asserts a literal **`201 Created`**.
  That 201 is the proof the crypto is correct end to end. The browser is kept
  open through the send — Mozilla drops the subscription (`410 Gone`) once the
  ephemeral Firefox profile is torn down.
- **Endpoint behaviors:** subscribe/unsubscribe/vapid-key; auth required; CSRF
  on the state-changing routes; the graceful `not-configured` path (a second
  gateway with no VAPID env → `configured:false` + `503`); dedup; idempotent
  unsubscribe; persisted-to-store.
- **Pruning:** a local HTTPS mock returning `410` (reusing the real
  subscription's ECDH keys so encryption succeeds before the POST) is added and
  the gateway's send path prunes it — real `410`, real prune.
- **SW suppression rule:** the shipped `hasVisibleClientForSession` function is
  extracted from `public/sw.js` (brace-matched + `eval`'d — the real code, not a
  copy) and its branches are asserted: focused+visible+matching-session → omit;
  unfocused / hidden / different-session / no-client / null-id → notify.

---

## 9. Extended controls (implemented 2026-07-17)

Items #4/#5/#6 landed. CACHE_VERSION bumped **v3 → v5** across the work (v4 = new
`showNotification` shape / poll refactor; v5 = action buttons). `PUSH_POLL_INTERVAL_MS`
is now env-overridable (tests poll at 200ms).

### 9.1 Per-session mute (#4)

Reuses the existing session metadata — NO new store/endpoint. `muted` rides on
`sessions.json` alongside org/project, is returned on each `GET /api/sessions`
row, and is set via the existing `PATCH /api/sessions/:id` (`muted:boolean`).
Enforced **server-side**: `pushPollTick` skips a finished session when
`s.muted` (a client can't stop an OS notification with the tab closed). It is
global-per-session (all devices) — correct for single-user. UI: a
Mute/Unmute item in the sidebar row's actions menu (`Bell`/`BellOff`), through
the existing `useUpdateSession` PATCH path.

### 9.2 Global push settings + duration threshold + job-start (#6)

A second gitignored sidecar `push-settings.json` (atomic write, `PUSH_SETTINGS_FILE`
override), `{ minDurationMs: 30000, notifyOnStart: false }`. `GET /api/push/settings`
(auth) + `PUT` (auth + Origin/CSRF — `PUT` added to the state-changing guard set),
edited from the Notify tab. The loop reads settings each tick.

- **Duration threshold.** The state map is `qid -> { cmd, startedAt, notifiedRunning }`.
  A job is timed on shell→non-shell; on finish `durationMs = now - startedAt` is
  computed and the notification is suppressed when `durationMs < minDurationMs`.
  `durationMs` is included in the payload. **Granularity is ±one poll interval**
  (~4s default); genuinely sub-interval jobs are already invisible (the loop
  never observes them running). A job already running at baseline has an untimed
  start (`startedAt = null`) and is long by construction ⇒ it notifies with an
  unknown/omitted duration.
- **Job-start = "still running after threshold".** The genuinely useful flavor,
  and what the `notifyOnStart` toggle does (NOT fire-on-every-command): a
  one-time alert (guarded by `notifiedRunning`) when a timed job crosses
  `minDurationMs` while still non-shell.

### 9.3 Exit code (#6) — session-scoped shell hook

A bash/zsh prompt hook installed at **session-create** time writes `$?` to the
session-scoped tmux user option `@web_last_exit`; the loop reads it **for free**
via `#{@web_last_exit}` in the existing `list-sessions -F` format (empirically
verified to resolve there — no `show-options` fallback needed). The hook
captures `$?` first, guards double-install with a `__SL_HOOK` sentinel, and is
quiet + non-fatal. The exit code is included in the payload **only when captured**
(bash/zsh + gateway-created sessions); other shells / pre-existing sessions omit
it (the backward-compat contract). The value is cleared after a finish so a
stale code can't re-fire.

- **Remote/SSH status: WORKS.** Verified on both LOCAL and a real
  ssh-to-localhost server — the hook install (`send-keys`) and the read
  (`list-sessions`) both flow through the same `serverExec` seam that already
  operates over ssh. The test uses an ephemeral key + a dedicated `tmux -L`
  socket and SKIPs gracefully if ssh-to-localhost is unavailable (never a hard
  failure), so exit-code is NOT local-only.

### 9.4 Success/fail rendering + action buttons (#5)

- The finish **title** reflects status when the exit code is known: "✓ Job
  finished" / "✗ Job failed (exit N)"; neutral "Job finished" otherwise. Still
  GENERIC — session name + status, never command output.
- The SW adds `actions: [{open},{dismiss-all}]`, sliced to
  `Notification.maxActions`. **Chromium/Android only** — iOS Safari silently
  ignores `actions` (the body tap still deep-links). `notificationclick` branches
  via the pure, unit-tested `resolveNotificationClick`: `dismiss-all` closes all
  notifications; `open`/default focuses + deep-links to `?session=<id>`. The
  visible-session-suppressed path shows nothing, so no actions there.

### Verification (extends §8)

`test:push` proves all of the above against a REAL running gateway + real tmux
(200ms interval): mute suppresses; duration gate both ways (with `durationMs`);
still-running fires exactly once; **exit code `false`→1 / `true`→0 on LOCAL AND
over SSH**; SW suppression + action-branch resolvers (extracted from the shipped
`sw.js`). The **real-201** crypto gate and the frontend vitest (mute mutation)
stay green.

### Needs a REAL device (cannot be automated here)

- iOS action-button rendering (iOS ignores `actions`; body tap verified logically).
- On-device, tab-closed delivery actually SHOWING the ✓/✗ + duration/exit code
  (the payload content is verified via the gateway log + the real-201 proves the
  encrypt/deliver path; rendering on a physical phone is manual).

## 10. Deliberately out of scope (post-v1)

- **Multi-user fan-out** — the store is single-user (many devices), matching the
  current single-user auth model.
- **Richer notification actions** (re-run the job, per-action deep targets).
- **Per-session notification routing** (only some devices) — single-user model.

---

## Critical files

- `apps/terminal-gateway/src/push.js` — VAPID config, subscription store, `sendToAll` (+ prune).
- `apps/terminal-gateway/src/server.js` — `/api/push/*` routes, poll loop, gating/baseline, `SHELLS`.
- `apps/terminal-gateway/scripts/generate-vapid.js` — keygen.
- `apps/terminal-gateway/.env.example` — env documentation.
- `apps/terminal/public/sw.js` — `push` + `notificationclick`.
- `apps/terminal/src/features/terminal/hooks/use-push-notifications.ts` — client logic.
- `apps/terminal/src/features/terminal/components/settings-dialog.tsx` — the _Notify_ toggle.
- `packages/shared-types/src/terminal.ts` — push schemas.
- `apps/terminal-gateway/test/push-endpoints.js` — verification (`test:push`).
