# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Explore via the knowledge graph first (graphify)

This repo has a graphify knowledge graph in `graphify-out/` (gitignored, regenerable). Use it **before** grep/find sweeps — one read of the report answers most structural questions in far fewer tokens:

- **Start here for any exploration or planning:** read `graphify-out/GRAPH_REPORT.md` (structure, hubs, communities, cross-links).
- **Structural questions** ("what calls X?", "how does X connect to Y?"): query `graphify-out/graph.json` or invoke the `/graphify` skill.
- **If `graphify-out/` is missing** (fresh clone) or stale after significant changes, regenerate it off-session (no Claude tokens; ~$0.07 on Azure):

  ```bash
  set -a; . ~/workspaces/sparklab/graphify/.env; set +a
  /home/sparklab/miniconda3/bin/python3.13 \
    ~/workspaces/sparklab/graphify/scripts/graphify_azure.py "$(pwd)" --no-viz
  ```

## What this is

A web terminal whose defining property is that **jobs survive the browser and the gateway**. Closing the tab, losing the network, or restarting the Node gateway must never kill a running process. `docs/DESIGN-SYSTEM.md` is the authoritative design and rationale — read it before making architectural changes.

It also ships an **Agent Chat**: a floating panel (bottom-right of the terminal) where an AI agent — a custom tool-calling loop over Azure OpenAI (`gpt-5.6-sol`), running as a separate `apps/agent-service` — can read any session's screen, type into it _with per-write approval_, and create sessions, all through the gateway. See `docs/AGENT-PROTOCOL.md`.

## Commands

```bash
pnpm install                          # workspace install (pnpm + Turborepo)
pnpm dev                              # turbo dev: gateway (3007) + Next.js terminal app (3000)
pnpm build / lint / typecheck / test  # turbo across all workspaces
pnpm --filter @sparklab/terminal-gateway smoke             # node-pty attaches tmux; session outlives pty.kill()
pnpm --filter @sparklab/terminal-gateway acceptance        # job keeps counting while disconnected, resumes live
pnpm --filter @sparklab/terminal-gateway acceptance:multi  # multi-session isolation; DELETE is the only kill
pnpm --filter @sparklab/terminal-gateway test:agent-endpoints  # agent REST: /screen capture + /keys inject
pnpm --filter @sparklab/agent-service smoke   # live: agent creates a session via the approval flow (1 Azure call)
pnpm --filter @sparklab/e2e e2e       # Playwright gates (needs a production build with NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_GATEWAY_URL=http://localhost:3907)
```

The gateway "tests" are standalone node scripts under `apps/terminal-gateway/test/` that spawn real tmux sessions and a real gateway, assert with plain `throw`, and print `PASS`/`FAIL`. They clean up their tmux sessions; if one is interrupted, check for orphans with `tmux ls` and `tmux kill-session -t <name>`.

## Architecture: three independent lifetimes

The core idea is that the process owner is **tmux**, not the gateway and not the browser. Three layers fail independently:

```
Browser (xterm.js)  --WebSocket-->  Gateway (node-pty)  --tmux attach-->  tmux server --> shell + jobs
```

- **The gateway never owns the job.** On WS attach it spawns a node-pty running `tmux attach-session -t <name>`. On WS close it kills **only that pty** (which detaches the tmux client). It must **never** run `tmux kill-session` on disconnect — that line's absence is what keeps jobs alive. See `teardown()` in `src/server.js`.
- **tmux is the source of truth for session state.** There is no database. A restarted gateway rediscovers everything via `tmux has-session` / `tmux ls`. Sessions are created explicitly via `POST /api/sessions`; attach never creates.
- **The agent is a fourth, independent lifetime.** `apps/agent-service` runs the AI loop and can crash/restart without touching any pty. It is deliberately _not_ in the gateway (which stays plain-JS and dependency-minimal). It operates terminals **only** as a gateway REST client — never tmux directly — so the gateway stays the single enforcement point for the `web-` prefix, auth, and the one `kill-session` call site. It reads via `GET /api/sessions/:id/screen` and writes via `POST /api/sessions/:id/keys` (both added for this; see `docs/TERMINAL-PROTOCOL.md`). The human keystroke path is untouched.
- **tmux's attach redraw is the single painter of the visible screen.** On attach, tmux redraws the current screen automatically (including full-screen apps like vim/htop). Scrollback history is additionally fetched via the REST `capture-pane` endpoint (`GET /api/sessions/:id/scrollback`) and injected client-side _behind_ the redraw on the first binary frame — see `docs/TERMINAL-PROTOCOL.md`. Naive replay ON TOP of the redraw remains forbidden (double-draw).

## Load-bearing invariants (don't break these)

- **Raw bytes end to end.** The pty is spawned with `encoding: null` so `onData` yields Buffers, never decoded strings. pty output → WS **binary** frames → `term.write(Uint8Array)`; keystrokes → `TextEncoder` → WS binary → `pty.write`. Decoding to a JS string anywhere mid-pipeline corrupts multibyte UTF-8 (verified with Thai input). Keep binary frames binary.
- **WS message routing is by frame type, not content.** Binary frame = keystrokes. Text frame = JSON control message (`resize`, `ping`). Server → client control messages are also JSON text (`exit`, `pong`). Anything new on the wire follows this split.
- **Reconnect resets the terminal before the redraw.** The client (`apps/terminal/src/features/terminal/connection.ts`) sets `freshConnect = true` on each (re)connect and calls `term.reset()` on the first binary frame after, so tmux's attach redraw doesn't stack on stale content.
- **Multi-viewer sizing:** sessions are configured with `window-size latest` + `aggressive-resize on` so tmux follows the most recently active client instead of shrinking to the smallest.

## Frontend UI conventions

- **`DESIGN.md` (repo root) is the visual source of truth.** When creating or editing any frontend UI, base colors, typography, spacing, and component geometry on it (Warp-inspired language: warm near-charcoal canvas `#2b2622`, ink `#f7f5f0`, Inter type, understated CTAs, tight shape geometry). Prefer the existing Tailwind theme tokens (`bg-background`, `text-muted-foreground`, `border-border`, `bg-accent`, `text-chart-1`, …) which encode that palette — do not hardcode hex values that bypass them.
- **Icons: `lucide-react` is the default icon library.** Use it for all new icons (typical inline size here is `size-3.5`/`size-4`); don't introduce another icon set or inline ad-hoc SVGs.
- Reusable primitives live in `@sparklab/ui` (shadcn-style: `Button`, `Tooltip`, `Dialog`, `Separator`, …) — reach for those before writing bespoke markup.

## Layout

- `apps/terminal-gateway/` — Node gateway (plain JS). `src/server.js` is the entire gateway: REST session CRUD + auth endpoints, agent REST (`GET /api/sessions/:id/screen`, `POST /api/sessions/:id/keys`), `/attach` WS endpoint, tmux session management, origin allowlist, rate limiting. Sessions are `web-<uuid>`, created via `POST /api/sessions`.
- `apps/agent-service/` — Node/TS agent service (port 3009). `src/index.ts` (WS `/agent`, origin + cookie auth), `agent-loop.ts` (the custom tool-calling loop), `azure.ts` (Azure OpenAI client), `tools.ts` (the 7 tools + dispatcher), `gateway-client.ts`, `approvals.ts`, `history.ts` (per-chat JSONL), `system-prompt.ts`. Config + secrets in a gitignored `.env` (see `.env.example`).
- `apps/terminal/` — Next.js frontend. Auth gate in `src/features/auth/`; terminal logic in `src/features/terminal/` (including the settings dialog, `components/settings-dialog.tsx`, opened from the sidebar gear); the Agent Chat UI in `src/features/agent-chat/` (FAB, docked panel, approval card, attribution overlay).
- `apps/e2e/` — Playwright E2E suite (gates 1--8 + StrictMode check).
- `packages/shared-types/` — Zod schemas for REST, WS, and auth (`src/terminal.ts`, `src/auth.ts`, `src/agent.ts`).
- `test/` (in `apps/terminal-gateway/`) — smoke + acceptance scripts.
- `deploy/Caddyfile` — reverse-proxy example for production.
- `docs/DESIGN-SYSTEM.md` — design and phased plan.

## Status & what's deliberately absent

Phase 1 (attach/detach, reconnect), Phase 2 (multi-session REST + UI), and Phase 3 (Workstream A: auth, origin allowlist, rate limiting, loopback bind, deploy docs; Workstream B: scrollback restore, session status badges) are done (2026-07-14). Auth is single-user username/password (`GATEWAY_AUTH_USER` + `GATEWAY_AUTH_PASSWORD_HASH`, scrypt via `pnpm --filter @sparklab/terminal-gateway hash-password`; plaintext `GATEWAY_AUTH_PASSWORD` for dev/tests) — it replaced the original `GATEWAY_AUTH_TOKEN`, which the gateway now hard-rejects at startup. Expose the gateway only via the reverse-proxy topology in `docs/DEPLOYMENT.md` with auth credentials set.

**Agent Chat** (2026-07-14): `apps/agent-service` + `apps/terminal/src/features/agent-chat`, backed by Azure OpenAI (`gpt-5.6-sol`). Custom tool-calling loop; 7 tools (`list_sessions`/`read_screen`/`wait_idle` auto; `type_text`/`press_keys`/`run_command`/`create_session` approval-gated); no `kill_session` (destroy stays human-only). Full protocol + safety model in `docs/AGENT-PROTOCOL.md`.

**Settings dialog** (2026-07-15): `apps/terminal/src/features/terminal/components/settings-dialog.tsx`, a client-only modal opened from the sidebar gear. Four sections: Appearance (terminal font size — persisted in the terminal store as `terminalFontSize`, the only section with behavior), Agent chat (read-only model + per-write approval policy — no persisted auto-approve, by design), Account (username + sign out; password stays env-set, no change-password), Connection (read-only gateway URL / status / session count). Desktop-only entry point for now (the mobile drawer has no account row).

**Not yet implemented (Phase 4):** multi-user isolation, session sharing / read-only viewers, mobile phase-2 extras (PWA, pinch-zoom), a mobile settings entry point.
