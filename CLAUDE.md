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
pnpm --filter @sparklab/terminal-gateway acceptance:remote # remote job survives full gateway restart over localhost ssh
pnpm --filter @sparklab/terminal-gateway test:agent-endpoints  # agent REST: /screen capture + /keys inject
pnpm --filter @sparklab/terminal-gateway test:servers-password # password auth stored/never-leaked/authMethod reported
pnpm --filter @sparklab/terminal-gateway test:fs              # file-explorer REST: 18 checks incl. awkward-name quoting, 413, CSRF
pnpm --filter @sparklab/agent-service smoke   # live: agent creates a session via the approval flow (1 Azure call)
pnpm --filter @sparklab/e2e e2e       # Playwright gates (needs a production build with NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_GATEWAY_URL=http://localhost:3907)
```

**Local production** (ports 3100/3107/3109 — +100 offset from dev, runs alongside it with no collision): build the frontend first, then start all three services via PM2 (`pm2 start ecosystem.config.cjs`) or the plain foreground script (`./run-prod-local.sh`; `--no-build` skips the build step). Full workflow in `docs/LOCAL-PROD.md`.

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

- `apps/terminal-gateway/` — Node gateway (plain JS). `src/server.js` is the entire gateway: REST session CRUD + auth endpoints, agent REST (`GET /api/sessions/:id/screen`, `POST /api/sessions/:id/keys`), file-explorer REST (6 routes under `/api/sessions/:id/fs/*` — list/read/download/upload/mkdir/entry), `/attach` WS endpoint, tmux session management, origin allowlist, rate limiting, multi-server exec seams: `serverExecArgv`/`serverExec`/`serverExecStdin` (tmux-only) and the non-tmux sibling `serverCmdArgv`/`serverCmd`/`serverCmdStdin` (used by fs routes), SSH multiplexing (`sshOptsFor`, ControlMaster/ControlPath/ControlPersist), reachability probe (`probeServer`), and server registry API (`GET/POST/DELETE /api/servers`, `POST /api/servers/test`). Sessions are `web-<uuid>` locally; qualified ids `<serverId>/web-<uuid>` on the wire. `src/registry.js` (NEW) loads/persists the server registry (`servers.json`, atomic write); always injects the implicit `local` entry.
- `apps/agent-service/` — Node/TS agent service (port 3009). `src/index.ts` (WS `/agent`, origin + cookie auth), `agent-loop.ts` (the custom tool-calling loop), `azure.ts` (Azure OpenAI client), `tools.ts` (the 7 tools + dispatcher), `gateway-client.ts`, `approvals.ts`, `history.ts` (per-chat JSONL), `system-prompt.ts`. Config + secrets in a gitignored `.env` (see `.env.example`).
- `apps/terminal/` — Next.js frontend. Auth gate in `src/features/auth/`; terminal logic in `src/features/terminal/` (including the settings dialog, `components/settings-dialog.tsx`, opened from the sidebar gear; `components/add-server-dialog.tsx` NEW; `components/file-explorer-dialog.tsx` NEW — two-pane file-explorer modal opened from the header; `hooks/use-servers.ts` NEW; `hooks/use-file-explorer.ts` NEW — TanStack Query queries/mutations + download helper for the file explorer; `server-grouping.ts` NEW — server-level grouping above the org→project tree); the Agent Chat UI in `src/features/agent-chat/` (FAB, docked panel, approval card, attribution overlay).
- `apps/e2e/` — Playwright E2E suite (gates 1--8 + StrictMode check).
- `packages/shared-types/` — Zod schemas for REST, WS, and auth (`src/terminal.ts`, `src/auth.ts`, `src/agent.ts`). `terminal.ts` also exports the fs schemas: `FsEntryType`, `FsEntry`, `FsListResponse`, `FsReadResponse`, `FsMkdirRequest/Response`, `FsRenameRequest/Response`, `FsDeleteResponse`, `FsUploadResponse`; plus `GitStatusResponse` (footer git summary); all re-exported from `index.ts`.
- `test/` (in `apps/terminal-gateway/`) — smoke + acceptance scripts; also `fs-endpoints.js` (file-explorer REST, 18 checks, run via `test:fs`) and `git-endpoints.js` (footer git summary, 7 checks, run via `test:git`).
- `deploy/Caddyfile` — reverse-proxy example for production.
- `ecosystem.config.cjs` (repo root) — PM2 ecosystem for the local production stack; manages three processes (`prod-gateway` :3107, `prod-agent` :3109, `prod-terminal` :3100).
- `run-prod-local.sh` (repo root) — plain foreground launcher for the same local production stack; builds the frontend then starts all three. Pass `--no-build` to skip the build.
- `docs/LOCAL-PROD.md` — full manual for building and running a production build locally (PM2 and script paths, port map, auth, verify steps, troubleshooting).
- `docs/DESIGN-SYSTEM.md` — design and phased plan.

## Status & what's deliberately absent

Phase 1 (attach/detach, reconnect), Phase 2 (multi-session REST + UI), and Phase 3 (Workstream A: auth, origin allowlist, rate limiting, loopback bind, deploy docs; Workstream B: scrollback restore, session status badges) are done (2026-07-14). Auth is single-user username/password (`GATEWAY_AUTH_USER` + `GATEWAY_AUTH_PASSWORD_HASH`, scrypt via `pnpm --filter @sparklab/terminal-gateway hash-password`; plaintext `GATEWAY_AUTH_PASSWORD` for dev/tests) — it replaced the original `GATEWAY_AUTH_TOKEN`, which the gateway now hard-rejects at startup. Expose the gateway only via the reverse-proxy topology in `docs/DEPLOYMENT.md` with auth credentials set.

**Agent Chat** (2026-07-14): `apps/agent-service` + `apps/terminal/src/features/agent-chat`, backed by Azure OpenAI (`gpt-5.6-sol`). Custom tool-calling loop; 7 tools (`list_sessions`/`read_screen`/`wait_idle` auto; `type_text`/`press_keys`/`run_command`/`create_session` approval-gated); no `kill_session` (destroy stays human-only). Full protocol + safety model in `docs/AGENT-PROTOCOL.md`.

**Settings dialog** (2026-07-15): `apps/terminal/src/features/terminal/components/settings-dialog.tsx`, a client-only modal opened from the sidebar gear. Four sections: Appearance (terminal font size — persisted in the terminal store as `terminalFontSize`, the only section with behavior), Agent chat (read-only model + per-write approval policy — no persisted auto-approve, by design), Account (username + sign out; password stays env-set, no change-password), Connection (read-only gateway URL / status / session count). Sections are tabbed. Desktop-only entry point for now (the mobile drawer has no account row).

**URL deep-linking** (2026-07-15): UI state is reflected in the page query string via `window.history.replaceState` (not `useSearchParams` — avoids a Suspense boundary + CSR bailout, and is loop-safe). `?session=<id>` selects the active terminal, `?settings=<section>` opens the settings dialog to a tab, `?agent` opens the agent panel. URL wins on mount (overriding persisted state), store→URL thereafter; `replaceState` only, so switches don't create back/forward entries. Hooks live in `apps/terminal/src/features/terminal/hooks/use-*-url-sync.ts` + `use-url-flag-sync.ts`, mounted in `terminal-shell.tsx`. Prerequisite fix: the session vanish-fallback is gated on the sessions query's first success (`session-fallback.ts`) so the initial-fetch window can't clobber a persisted/URL id.

**Session organization** (2026-07-15): sessions carry optional `org` + `project` metadata (sidecar `data/sessions.json`, not tmux); the sidebar groups them in a two-level collapsible tree (Ungrouped last, persisted collapse, active-session auto-expand). `PATCH /api/sessions/:id` updates name/org/project (rename shipped with this); groups are derived from live sessions — no registry. Spec/decision record: `docs/SESSION-ORGANIZATION-PLAN.md`; grouping logic in `apps/terminal/src/features/terminal/grouping.ts`.

**Connected Servers — multi-server MVP** (2026-07-15): Option C from `docs/MULTI-SERVER-PLAN.md` (SSH + remote tmux) is now implemented. The gateway routes all tmux work through a single exec seam (`serverExecArgv`) that either runs tmux locally (for the implicit `local` server) or via `ssh -tt … tmux …` for registered remote servers. SSH multiplexing (`ControlMaster`/`ControlPath`/`ControlPersist=60s`) keeps attach latency low by reusing one TCP+auth handshake per server. A new `src/registry.js` loads the gitignored `servers.json` (atomic writes); `GET /api/servers` + `POST/DELETE` + `POST /api/servers/test` manage the registry behind the existing cookie auth. Session ids become qualified (`<serverId>/web-<uuid>`) everywhere on the wire; bare ids remain backward-compatible (implicit `local`). Unreachable servers are never silently pruned: `GET /api/sessions` returns last-known rows with `reachable:false`; the metadata sidecar doubles as the last-known cache, keyed by qualified id. The sidebar groups sessions by server above the existing org→project tree (server headers appear only when ≥2 servers exist, so single-server UI is pixel-identical). The add-server dialog (`components/add-server-dialog.tsx`) and a new Servers tab in the settings dialog (`?settings=servers`) expose the registry; `hooks/use-servers.ts` provides TanStack Query mutations. Per-server SSH **password auth** is available as an opt-in (see below). Spec + decision record: `docs/MULTI-SERVER-PLAN.md` and `docs/multi-server-impl-spec.md`.

**Connected Servers — per-server password auth** (2026-07-15): a deliberate departure from the original "key-only" trust model, added for hosts that only accept password login. Uses OpenSSH's askpass mechanism — NOT `sshpass`: a helper script at `$TMPDIR/gw-ssh-cm/askpass.sh` echoes `$GW_SSH_PASSWORD`; `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4) cause ssh to invoke it non-interactively on both the control exec path and the WS-attach pty path. The password is passed via child-process env (never argv, so it doesn't appear in `ps`). The password is stored **plaintext in the gitignored `servers.json`** and is never returned over the wire; `GET /api/servers` reports only `authMethod: "key"|"password"` without the secret. The add-server dialog's Key/Password toggle sets `authMethod`; for key auth, `BatchMode=yes` remains; for password auth, `BatchMode=no` + `PreferredAuthentications=password` + `PubkeyAuthentication=no` are used so ssh goes straight to the askpass helper in one attempt, and the ControlMaster socket then carries every subsequent exec so the password is used only on initial connect.

**File Explorer** (2026-07-16): a modal opened from a "Browse files" button beside the terminal title in the header. Scoped to the selected terminal's session; browses and manages the filesystem of whichever server (local or remote-over-SSH) that session lives on, seeded at the session's cwd. Full read/write: directory listing with breadcrumb, text preview (binary files show "preview unavailable" + Download), plus New folder, Upload, Download, Rename, and Delete (destructive ops confirmed). Hidden files toggle is off by default. Decision record: `docs/FILE-EXPLORER-PLAN.md`. Gateway adds a non-tmux exec seam (`serverCmdArgv`/`serverCmd`/`serverCmdStdin`) and 6 routes under `/api/sessions/:id/fs/*` (list, read, download, upload, mkdir, entry PATCH/DELETE); GET routes are Origin-exempt; state-changing routes get the full Origin/CSRF check. Every path flows as a single argv token — never string-concatenated — and `find` records are NUL-delimited so filenames with spaces, quotes, or newlines survive round-trip safely. Frontend: `hooks/use-file-explorer.ts` (TanStack Query) + `components/file-explorer-dialog.tsx`; store gains `explorerOpen`/`setExplorerOpen`; header button is disabled when no session is active or the server is unreachable; `?explorer` URL flag via `useUrlFlagSync`. Tested by `apps/terminal-gateway/test/fs-endpoints.js` (18 checks, `test:fs`).

**Footer git status** (2026-07-16): the mini footer bar (`components/terminal-footer.tsx`, below the xterm frame) now shows the active session's git branch + working-tree status of its cwd — a `GitBranch` icon + branch name (short oid on detached HEAD), upstream ahead/behind (↑/↓ when non-zero), and a staged/unstaged/untracked/conflicted breakdown (`+N ~N ?N !N`, colored via chart-1/chart-2/muted/destructive; a clean tree shows `✓`). Gateway adds `GET /api/sessions/:id/git` (dedicated to the active session — NOT folded into `GET /api/sessions`): resolves the cwd, runs one `git status --porcelain=v2 --branch` through the `serverCmd` seam (local or ssh) with an 8s timeout, and returns `{isRepo:false}` outside a work tree. Frontend polls via `hooks/use-git-status.ts` (TanStack Query, 5s, `retry:false`, `enabled` gated on reachability). Schema `GitStatusResponse` in `shared-types/src/terminal.ts`. Tested by `apps/terminal-gateway/test/git-endpoints.js` (7 checks, `test:git`). Protocol: `docs/TERMINAL-PROTOCOL.md`.

**Not yet implemented (Phase 4):** multi-user isolation, session sharing / read-only viewers, mobile phase-2 extras (PWA, pinch-zoom), a mobile settings entry point.
