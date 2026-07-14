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

## Commands

```bash
pnpm install                          # workspace install (pnpm + Turborepo)
pnpm dev                              # turbo dev: gateway (3007) + Next.js terminal app (3000)
pnpm build / lint / typecheck / test  # turbo across all workspaces
pnpm --filter @sparklab/terminal-gateway smoke             # node-pty attaches tmux; session outlives pty.kill()
pnpm --filter @sparklab/terminal-gateway acceptance        # job keeps counting while disconnected, resumes live
pnpm --filter @sparklab/terminal-gateway acceptance:multi  # multi-session isolation; DELETE is the only kill
pnpm --filter @sparklab/e2e e2e       # Playwright gates (needs a production build with NEXT_PUBLIC_GATEWAY_URL=http://localhost:3907)
```

The gateway "tests" are standalone node scripts under `apps/terminal-gateway/test/` that spawn real tmux sessions and a real gateway, assert with plain `throw`, and print `PASS`/`FAIL`. They clean up their tmux sessions; if one is interrupted, check for orphans with `tmux ls` and `tmux kill-session -t <name>`.

## Architecture: three independent lifetimes

The core idea is that the process owner is **tmux**, not the gateway and not the browser. Three layers fail independently:

```
Browser (xterm.js)  --WebSocket-->  Gateway (node-pty)  --tmux attach-->  tmux server --> shell + jobs
```

- **The gateway never owns the job.** On WS attach it spawns a node-pty running `tmux attach-session -t <name>`. On WS close it kills **only that pty** (which detaches the tmux client). It must **never** run `tmux kill-session` on disconnect — that line's absence is what keeps jobs alive. See `teardown()` in `src/server.js`.
- **tmux is the source of truth for session state.** There is no database. A restarted gateway rediscovers everything via `tmux has-session` / `tmux ls`. Sessions are created explicitly via `POST /api/sessions`; attach never creates.
- **tmux's attach redraw is the single painter of the visible screen.** On attach, tmux redraws the current screen automatically (including full-screen apps like vim/htop). Scrollback history is additionally fetched via the REST `capture-pane` endpoint (`GET /api/sessions/:id/scrollback`) and injected client-side _behind_ the redraw on the first binary frame — see `docs/TERMINAL-PROTOCOL.md`. Naive replay ON TOP of the redraw remains forbidden (double-draw).

## Load-bearing invariants (don't break these)

- **Raw bytes end to end.** The pty is spawned with `encoding: null` so `onData` yields Buffers, never decoded strings. pty output → WS **binary** frames → `term.write(Uint8Array)`; keystrokes → `TextEncoder` → WS binary → `pty.write`. Decoding to a JS string anywhere mid-pipeline corrupts multibyte UTF-8 (verified with Thai input). Keep binary frames binary.
- **WS message routing is by frame type, not content.** Binary frame = keystrokes. Text frame = JSON control message (`resize`, `ping`). Server → client control messages are also JSON text (`exit`, `pong`). Anything new on the wire follows this split.
- **Reconnect resets the terminal before the redraw.** The client (`apps/terminal/src/features/terminal/connection.ts`) sets `freshConnect = true` on each (re)connect and calls `term.reset()` on the first binary frame after, so tmux's attach redraw doesn't stack on stale content.
- **Multi-viewer sizing:** sessions are configured with `window-size latest` + `aggressive-resize on` so tmux follows the most recently active client instead of shrinking to the smallest.

## Layout

- `apps/terminal-gateway/` — Node gateway (plain JS). `src/server.js` is the entire gateway: REST session CRUD + auth endpoints, `/attach` WS endpoint, tmux session management, origin allowlist, rate limiting. Sessions are `web-<uuid>`, created via `POST /api/sessions`.
- `apps/terminal/` — Next.js frontend. Auth gate in `src/features/auth/`; terminal logic in `src/features/terminal/`.
- `apps/e2e/` — Playwright E2E suite (gates 1--8 + StrictMode check).
- `packages/shared-types/` — Zod schemas for REST, WS, and auth (`src/terminal.ts`, `src/auth.ts`).
- `test/` (in `apps/terminal-gateway/`) — smoke + acceptance scripts.
- `deploy/Caddyfile` — reverse-proxy example for production.
- `docs/DESIGN-SYSTEM.md` — design and phased plan.

## Status & what's deliberately absent

Phase 1 (attach/detach, reconnect), Phase 2 (multi-session REST + UI), and Phase 3 (Workstream A: token auth, origin allowlist, rate limiting, loopback bind, deploy docs; Workstream B: scrollback restore, session status badges) are done (2026-07-14). Expose the gateway only via the reverse-proxy topology in `docs/DEPLOYMENT.md` with `GATEWAY_AUTH_TOKEN` set. **Not yet implemented (Phase 4):** multi-user isolation, session sharing / read-only viewers, mobile phase-2 extras (PWA, pinch-zoom).
