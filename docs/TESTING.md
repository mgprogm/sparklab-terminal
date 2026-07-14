# Testing

Three layers, each proving something the others can't:

1. **Gateway acceptance scripts** — real tmux, real gateway, no browser. Prove the _process-survival_ core.
2. **Vitest unit tests** — fast, isolated. Prove the _client protocol logic_ (Connection class, schemas, stores, hooks).
3. **Playwright E2E** — real browser against a production build. Prove the _six cut-over gates_ end to end.

```bash
pnpm test                 # all Vitest suites (via turbo)
pnpm --filter e2e test    # Playwright (boots its own gateway + app)
pnpm --filter @sparklab/terminal-gateway smoke
pnpm --filter @sparklab/terminal-gateway acceptance
pnpm --filter @sparklab/terminal-gateway acceptance:multi
```

## 1. Gateway scripts (`apps/terminal-gateway/test/`)

Standalone node scripts — no test framework, plain `throw`, print `PASS`/`FAIL`. **These are the load-bearing tests for the product's defining property; never rewrite them into Playwright.**

| Script                             | Proves                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `smoke-pty-tmux.js`                | node-pty can attach to tmux; output arrives as raw Buffers; the tmux session survives `pty.kill()` |
| `acceptance-survive-disconnect.js` | a counting job keeps running while no client is attached, then resumes live on reattach            |
| `acceptance-multi-session.js`      | sessions are isolated; jobs survive switching between sessions; DELETE kills only its target       |

They clean up their tmux sessions; if interrupted, check `tmux ls` and `tmux kill-session -t <name>`.

## 2. Unit tests (Vitest)

Shared presets in `@sparklab/config-vitest` (`base` = node env, `react` = jsdom + Testing Library).

| Suite                                        | Covers                                                                                                                                                                                                                                                                                  | Tests |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/shared-types/src/terminal.test.ts` | Schema round-trips against the real gateway payload shapes                                                                                                                                                                                                                              | 28    |
| `apps/terminal/.../connection.test.ts`       | **The executable spec of the Connection class**: Uint8Array writes, `term.reset()` exactly once per fresh connect, resize/ping JSON frames, `noReconnect` blocks both resurrection paths, backoff schedule (1s→2s→4s→8s→15s), heartbeat force-close, `dispose()` finality, supersession | 35    |
| `apps/terminal/.../store.test.ts`            | Zustand store + active-session-vanished fallback                                                                                                                                                                                                                                        | 8     |
| `apps/terminal/.../use-sessions.test.tsx`    | Query hooks with mocked fetch; Zod failures surface as errors                                                                                                                                                                                                                           | 7     |
| `apps/terminal/.../session-sidebar.test.tsx` | Sidebar rendering, create dialog, delete confirmation, collapse, selection                                                                                                                                                                                                              | 12    |

Convention: tests live in `__tests__/` beside the feature (or next to the source in packages). Use the `react` preset for anything touching the DOM.

## 3. Playwright E2E (`apps/e2e`)

Chromium only, serial workers. `playwright.config.ts` boots a **production build** of `apps/terminal` (port 3902, built with `NEXT_PUBLIC_GATEWAY_URL=http://localhost:3907`) and a gateway on port 3907 via `webServer`. First run: `pnpm exec playwright install chromium`.

The specs are the **six cut-over gates** — the checklist that had to pass before the legacy vanilla-JS frontend was deleted (it did, 2026-07-14):

| Spec                             | Gate                                | Method                                                                                                            |
| -------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `gate-1-gateway-scripts.spec.ts` | Gateway scripts still pass          | Runs all three scripts via `execFile`                                                                             |
| `gate-2-thai-roundtrip.spec.ts`  | Multibyte UTF-8 uncorrupted         | Types `สวัสดีครับ`, echoes to a file inside the session, asserts file bytes                                       |
| `gate-3-reconnect.spec.ts`       | Clean redraw after gateway restart  | Kills + respawns the gateway mid-session; asserts a pre-restart marker appears exactly once and input still works |
| `gate-4-job-survival.spec.ts`    | Jobs survive page close             | Starts a ticking counter, closes the page, reopens; asserts the counter advanced                                  |
| `gate-5-vim-redraw.spec.ts`      | Full-screen apps redraw on reattach | Opens vim, reloads the page, asserts vim UI in `capture-pane`                                                     |
| `gate-6-multi-viewer.spec.ts`    | Resize follows the latest client    | Two pages, different viewports; asserts tmux `window_width` follows                                               |
| `strictmode-check.spec.ts`       | No double-attach                    | Asserts `tmux list-clients` shows exactly 1 client after page load                                                |

Caveats:

- Timing-sensitive (shell readiness, reconnect backoff); CI runners may need timeout tuning.
- The StrictMode check runs against the prod build; the dev-mode double-mount behavior is covered by the Connection unit tests (dispose + supersession).

## CI (`.github/workflows/ci.yml`)

Two jobs on push (main/master/feat branches) and PRs:

1. **build-and-test** — Node from `.nvmrc`, pnpm cache, `pnpm install --frozen-lockfile`, then one cached Turborepo invocation: `pnpm turbo lint typecheck test build`.
2. **e2e** (needs job 1) — installs tmux + Playwright chromium, builds the apps, runs the E2E suite; uploads traces/artifacts on failure.

Git hooks (husky): pre-commit runs `lint-staged` (prettier on staged files — eslint runs per-workspace via `turbo lint`, since eslint isn't installed at the root); commit-msg enforces conventional commits via commitlint.

## When you change…

| Change                              | Must run                                             |
| ----------------------------------- | ---------------------------------------------------- |
| `server.js` wire protocol           | shared-types tests + update schemas + full E2E       |
| `connection.ts` / `xterm.tsx`       | connection unit tests + gates 2–4 + strictmode check |
| Session REST semantics              | shared-types tests + `use-sessions` tests + gate 1   |
| Anything touching pty/tmux spawning | all three gateway scripts                            |
