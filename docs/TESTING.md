# Testing

Three layers, each proving something the others can't:

1. **Gateway acceptance scripts** — real tmux, real gateway, no browser. Prove the _process-survival_ core.
2. **Vitest unit tests** — fast, isolated. Prove the _client protocol logic_ (Connection class, schemas, stores, hooks).
3. **Playwright E2E** — real browser against a production build. Prove the _eight gates_ end to end (gates 1--6 are the historical cut-over gates; gates 7--8 are the Phase 3 auth and scrollback gates).

```bash
pnpm test                 # all Vitest suites (via turbo)
pnpm --filter e2e test    # Playwright (boots its own gateway + app)
pnpm --filter @sparklab/terminal-gateway smoke
pnpm --filter @sparklab/terminal-gateway acceptance
pnpm --filter @sparklab/terminal-gateway acceptance:multi
pnpm --filter @sparklab/terminal-gateway test:agent-endpoints   # agent REST
pnpm --filter @sparklab/agent-service smoke                     # Agent Chat, live (1 Azure call)
```

Agent Chat adds a fourth surface: the agent REST endpoints (`test:agent-endpoints`, a gateway script) and a live end-to-end smoke of the agent service (§1a).

## 1. Gateway scripts (`apps/terminal-gateway/test/`)

Standalone node scripts — no test framework, plain `throw`, print `PASS`/`FAIL`. **These are the load-bearing tests for the product's defining property; never rewrite them into Playwright.**

| Script                             | Proves                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke-pty-tmux.js`                | node-pty can attach to tmux; output arrives as raw Buffers; the tmux session survives `pty.kill()`                                                                                                                                                                                            |
| `acceptance-survive-disconnect.js` | a counting job keeps running while no client is attached, then resumes live on reattach                                                                                                                                                                                                       |
| `acceptance-multi-session.js`      | sessions are isolated; jobs survive switching between sessions; DELETE kills only its target                                                                                                                                                                                                  |
| `agent-endpoints.js`               | the agent REST: `GET /screen` captures plain text + cursor/size/mode metadata (history works); `POST /keys` types literally without executing, named `Enter` then executes, the key whitelist is enforced, 404s are correct (`pnpm --filter @sparklab/terminal-gateway test:agent-endpoints`) |

They clean up their tmux sessions; if interrupted, check `tmux ls` and `tmux kill-session -t <name>`.

## 1a. Agent service smoke (`apps/agent-service/test/smoke.js`)

`pnpm --filter @sparklab/agent-service smoke` — a live end-to-end check of the Agent Chat backend. It spawns a real gateway (open mode) + the agent service, opens a WS to `/agent`, sends one message, auto-approves the write, and asserts the agent created a session in tmux through the approval flow, then cleans up. It makes **one real Azure call**, so it needs a valid `apps/agent-service/.env` and is not part of CI (it's a manual/local integration check). The model is slow (~15–20s/call), so the whole run takes ~1min.

## 2. Unit tests (Vitest)

Shared presets in `@sparklab/config-vitest` (`base` = node env, `react` = jsdom + Testing Library).

| Suite                                                          | Covers                                                                                                                                                                                                                                                                                  | Tests |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/shared-types/src/terminal.test.ts`                   | Schema round-trips against the real gateway payload shapes                                                                                                                                                                                                                              | 28    |
| `apps/terminal/.../connection.test.ts`                         | **The executable spec of the Connection class**: Uint8Array writes, `term.reset()` exactly once per fresh connect, resize/ping JSON frames, `noReconnect` blocks both resurrection paths, backoff schedule (1s→2s→4s→8s→15s), heartbeat force-close, `dispose()` finality, supersession | 35    |
| `apps/terminal/.../store.test.ts`                              | Zustand store reducers: active session, sidebar, mobile drawer, settings dialog open + section, and active-session-vanished fallback                                                                                                                                                    | 11    |
| `apps/terminal/.../session-fallback.test.ts`                   | Pure `resolveActiveSession(loaded, sessions, activeId)` decision: gated on first successful load, keeps a still-present id, falls back / nulls only after load                                                                                                                          | 6     |
| `apps/terminal/.../use-sessions.test.tsx`                      | Query hooks with mocked fetch; Zod failures surface as errors                                                                                                                                                                                                                           | 7     |
| `apps/terminal/.../session-sidebar.test.tsx`                   | Sidebar rendering, create dialog, delete confirmation, collapse, selection                                                                                                                                                                                                              | 12    |
| `apps/terminal/.../settings-dialog.test.tsx`                   | Settings modal: the four section tabs, switching between them, the open-vs-auth-disabled account state, and driving the font-size preference through the real store                                                                                                                     | 6     |
| `apps/terminal/.../use-session-url-sync.test.tsx`              | `?session=<id>` ↔ `activeSessionId`: URL wins on mount, store→URL thereafter, `replaceState` only                                                                                                                                                                                       | 5     |
| `apps/terminal/.../use-url-flag-sync.test.tsx`                 | Generic presence-flag sync (`?agent`): presence opens on mount, absence defers (never force-closes), reflects the flag back, params compose                                                                                                                                             | 4     |
| `apps/terminal/.../use-settings-url-sync.test.tsx`             | Value-carrying `?settings=<section>` sync: open (presence) + active tab (value), unknown/ bare values still open, write emits while open and removes on close                                                                                                                           | 6     |
| `apps/terminal/.../auth/api.test.ts`                           | Auth API client: login (204/401/429), me (200 with/without username, 401), logout                                                                                                                                                                                                       | 6     |
| `apps/terminal/.../auth/login-screen.test.tsx`                 | Login form rendering, username/password submission, invalid-credentials error display                                                                                                                                                                                                   | 3     |
| `apps/terminal/.../auth/use-auth-status.test.tsx`              | `useAuthStatus` hook: authenticated and unauthenticated states                                                                                                                                                                                                                          | 2     |
| `apps/terminal/.../connection-auth.test.ts`                    | Connection close code 4001: sets `noReconnect`, fires `onAuthError`; normal close codes still reconnect                                                                                                                                                                                 | 3     |
| `apps/terminal/.../connection-scrollback.test.ts`              | Scrollback injection sequencing: inject when fetch wins the race, skip when fetch fails or loses the race, no fetch after `noReconnect`                                                                                                                                                 | 4     |
| `apps/terminal/.../session-list-status.test.tsx`               | B2 status badges: viewer count, idle time, old-gateway compat (fields absent), schema accepts both shapes                                                                                                                                                                               | 4     |
| `apps/terminal/.../keys.test.ts`                               | Mobile key helpers: Ctrl/Alt input transforms, modifier arm/lock/consume, arrow CSI/SS3 sequences                                                                                                                                                                                       | 15    |
| `apps/terminal/.../store-persist.test.ts`                      | Store persistence partialize (keeps `activeSessionId` + `sidebarCollapsed`, drops transient UI state)                                                                                                                                                                                   | 2     |
| `apps/terminal/.../agent-chat/__tests__/store-history.test.ts` | Agent-chat store history reducers: `chat_list` populates chats; `chat_history` REPLACES transcript (fires on every reconnect — appending would duplicate); reconnect-resync idempotency; failed-tool replay entry → error-state row; `resetForNewChat` clears `chatId` + transcript     | 5     |

Convention: tests live in `__tests__/` beside the feature (or next to the source in packages). Use the `react` preset for anything touching the DOM.

## 3. Playwright E2E (`apps/e2e`)

Chromium only, serial workers. `playwright.config.ts` boots a **production build** of `apps/terminal` (port 3902, built with `NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_GATEWAY_URL=http://localhost:3907`) and a gateway on port 3907 via `webServer`. The `NEXT_DIST_DIR` isolation is required: a concurrently running `next dev` rewrites `.next` and corrupts the prod manifest. First run: `pnpm exec playwright install chromium`.

Gates 1--6 are the **cut-over gates** -- the checklist that had to pass before the legacy vanilla-JS frontend was deleted (it did, 2026-07-14). Gates 7--8 are the Phase 3 gates (auth, scrollback):

| Spec                             | Gate                                    | Method                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate-1-gateway-scripts.spec.ts` | Gateway scripts still pass              | Runs all three scripts via `execFile`                                                                                                                                                                                                                     |
| `gate-2-thai-roundtrip.spec.ts`  | Multibyte UTF-8 uncorrupted             | Types `สวัสดีครับ`, echoes to a file inside the session, asserts file bytes                                                                                                                                                                               |
| `gate-3-reconnect.spec.ts`       | Clean redraw after gateway restart      | Kills + respawns the gateway mid-session; asserts a pre-restart marker appears exactly once and input still works                                                                                                                                         |
| `gate-4-job-survival.spec.ts`    | Jobs survive page close                 | Starts a ticking counter, closes the page, reopens; asserts the counter advanced                                                                                                                                                                          |
| `gate-5-vim-redraw.spec.ts`      | Full-screen apps redraw on reattach     | Opens vim, reloads the page, asserts vim UI in `capture-pane`                                                                                                                                                                                             |
| `gate-6-multi-viewer.spec.ts`    | Resize follows the latest client        | Two pages, different viewports; asserts tmux `window_width` follows                                                                                                                                                                                       |
| `gate-7-auth.spec.ts`            | Unauthenticated is rejected (Phase 3)   | REST 401 without cookie; 429 rate limit after 5 wrong passwords; 403 on disallowed WS origin; 4001 close on unauthenticated WS; UI login journey (wrong password error, correct username/password login, keystroke echo, cookie persists across reload)   |
| `gate-8-scrollback.spec.ts`      | Scrollback survives reconnect (Phase 3) | REST scrollback assertions (history-only capture via `-E -1`, `lines` clamping, 404 on bogus ids); UI reload + Shift+PageUp reveals a history line not on the visible screen; vim-redraw regression (gate-5 invariant) stays clean with scrollback active |
| `strictmode-check.spec.ts`       | No double-attach                        | Asserts `tmux list-clients` shows exactly 1 client after page load                                                                                                                                                                                        |

Caveats:

- Timing-sensitive (shell readiness, reconnect backoff); CI runners may need timeout tuning.
- The StrictMode check runs against the prod build; the dev-mode double-mount behavior is covered by the Connection unit tests (dispose + supersession).
- Gate 8 disables WebGL at browser launch to force xterm's DOM renderer — the WebGL renderer draws to canvas and leaves no readable text in the DOM to assert against.

## CI (`.github/workflows/ci.yml`)

Two jobs on push (main/master/feat branches) and PRs:

1. **build-and-test** — Node from `.nvmrc`, pnpm cache, `pnpm install --frozen-lockfile`, then one cached Turborepo invocation: `pnpm turbo lint typecheck test build`.
2. **e2e** (needs job 1) — installs tmux + Playwright chromium, builds the apps, runs the E2E suite; uploads traces/artifacts on failure.

Git hooks (husky): pre-commit runs `lint-staged` (prettier on staged files — eslint runs per-workspace via `turbo lint`, since eslint isn't installed at the root); commit-msg enforces conventional commits via commitlint.

## When you change…

| Change                                                                           | Must run                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `server.js` wire protocol                                                        | shared-types tests + update schemas + full E2E           |
| `connection.ts` / `xterm.tsx`                                                    | connection unit tests + gates 2–4 + strictmode check     |
| Session REST semantics                                                           | shared-types tests + `use-sessions` tests + gate 1       |
| Anything touching pty/tmux spawning                                              | all three gateway scripts                                |
| Auth endpoints or cookie logic                                                   | auth unit tests + gate 7                                 |
| `features/auth/` UI                                                              | auth unit tests + gate 7 (UI journey)                    |
| Scrollback endpoint or injection                                                 | connection-scrollback tests + gate 8                     |
| Session status fields / badges                                                   | session-list-status tests + shared-types tests           |
| Agent REST (`/screen`, `/keys`)                                                  | `test:agent-endpoints` + shared-types (`agent.ts`)       |
| Agent loop / tools / WS protocol                                                 | `agent-service` typecheck + `agent-service` smoke        |
| Agent-chat store or WS frames (`features/agent-chat/store.ts`, history protocol) | `store-history` Vitest suite + `agent-service` typecheck |
