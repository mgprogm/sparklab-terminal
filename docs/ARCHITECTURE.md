# Architecture

## The core idea: three independent lifetimes

The defining property of the terminal product is that **jobs survive the browser and the gateway**. The process owner is **tmux** — not the Node gateway, not the browser tab. Three layers fail independently:

```
Browser (Next.js + xterm.js)
      │  WebSocket (binary frames = terminal I/O, JSON text frames = control)
      ▼
Gateway (node-pty, apps/terminal-gateway)
      │  spawns: tmux attach-session -t <id>
      ▼
tmux server ──> shell + long-running jobs
```

- **The gateway never owns the job.** On WS attach it spawns a node-pty running `tmux attach-session`. On WS close it kills only that pty (detaching the tmux client). It never runs `tmux kill-session` on disconnect — only the explicit `DELETE /api/sessions/:id` does.
- **tmux is the source of truth.** There is no database of live state. A restarted gateway rediscovers sessions via `tmux has-session` / `tmux ls`. (Display metadata like names/tags lives in a small JSON file, `src/metadata.js`.)
- **tmux's attach redraw is the single painter of the visible screen.** On reattach, tmux redraws the current screen (including full-screen apps like vim). The client resets the terminal first so the redraw lands on a clean screen; scrollback history is fetched via the REST `capture-pane` endpoint and injected _behind_ the redraw (see [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md)). Replay on top of the redraw would double-draw and remains forbidden.

The full rationale and edge-case analysis is in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md). The wire protocol is specified in [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md).

## The agent: a fourth independent lifetime

The **Agent Chat** feature adds an AI agent that can view, drive, and create terminals on the user's behalf. It is a **fourth lifetime** that fails independently of the other three: the agent service can crash, restart, or be killed without touching a single attached pty or tmux session.

```
Browser chat panel ──WS /agent (JSON)──► agent-service ──REST (loopback)──► gateway ──► tmux
   (apps/terminal)                        (apps/agent-service, :3009)        (:3007)
```

- **The agent is just another gateway client.** It never touches tmux directly and never touches the human keystroke path. Every terminal operation goes through the gateway REST API — the one place that already enforces the `web-` prefix, auth, and the single `kill-session` call site. It reads with `GET /api/sessions/:id/screen` (plain-text `capture-pane`, no ANSI) and writes with `POST /api/sessions/:id/keys` (literal text via `send-keys -l` / bracketed `paste-buffer`, or whitelisted named keys).
- **Not in the gateway, on purpose.** The gateway stays plain-JS and dependency-minimal (its test scripts are the load-bearing proof of job survival). The agent's TypeScript, its Azure OpenAI dependency, and its crash/retry behaviour live in a separate process so they can never take down the attach ptys.
- **Writes ask first.** Read tools run immediately; write tools pause the loop at an approval gate until the user answers in the chat panel (120s → deny). There is no `kill_session` tool — destroying a session stays a human-only action.

Protocol, tools, and safety model: [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md).

## Monorepo layout

pnpm workspaces + Turborepo. Workspace globs: `apps/*`, `packages/*` (`pnpm-workspace.yaml`). Task graph in `turbo.json`: `build` (dependsOn `^build`), `lint`, `typecheck`, `test`, `dev` (persistent, uncached), `e2e` (uncached).

```
├── apps/
│   ├── terminal-gateway/     # Node gateway (plain JS, deliberately)
│   ├── agent-service/        # Node/TS agent loop over Azure OpenAI (Agent Chat)
│   ├── terminal/             # Next.js terminal frontend (+ agent-chat feature)
│   ├── web/                  # Next.js product app (pattern exemplars)
│   └── e2e/                  # Playwright suite (not built, only tested)
├── packages/
│   ├── shared-types/         # Zod schemas: REST + WS + agent protocol
│   ├── ui/                   # shadcn/ui + Tailwind v4 design system
│   ├── config-typescript/    # shared tsconfig bases
│   ├── config-eslint/        # shared ESLint 9 flat configs
│   └── config-vitest/        # shared Vitest presets
└── docs/
```

## Apps

### `apps/terminal-gateway` (`@sparklab/terminal-gateway`)

Plain-JS Node server, no framework, no build step. Two files:

- `src/server.js` — REST session CRUD (`/api/sessions`), a read-only scrollback endpoint (`GET /api/sessions/:id/scrollback`, tmux `capture-pane`), the `/attach` WebSocket endpoint, tmux session management. The list response carries per-session status (`attachedClients`, `lastActivity`). Spawns ptys with `encoding: null` so all terminal I/O stays raw bytes.
- `src/metadata.js` — session display metadata (names, tags) persisted to `data/sessions.json` (gitignored runtime data).

Deliberate choices: it stays plain JS (moved verbatim in the monorepo restructure; TS conversion is a separate future task), and it serves no frontend anymore (its old vanilla-JS `public/` was deleted after the cut-over gates passed; static requests now 404).

The auth boundary lives at the gateway: single-user username/password auth via `GATEWAY_AUTH_USER` + `GATEWAY_AUTH_PASSWORD_HASH` (scrypt, timing-safe verify; plaintext `GATEWAY_AUTH_PASSWORD` accepted for dev), in-memory cookie sessions (`gw_session`, HttpOnly, SameSite=Strict, 30-day absolute expiry), origin allowlist on WS upgrades and mutating REST, per-IP login rate limiting (5/min). The gateway binds `127.0.0.1` by default; TLS terminates at a reverse proxy (Caddy) per [DEPLOYMENT.md](DEPLOYMENT.md). When no credentials are set, auth is disabled (open mode); the gateway refuses to start credential-less on a non-loopback `HOST`.

Tests live in `test/` as standalone node scripts (see [TESTING.md](TESTING.md)) — they are the load-bearing proof of job survival.

### `apps/agent-service` (`@sparklab/agent-service`)

The Agent Chat backend — a Node/TypeScript service (port 3009, run via `tsx`) that hosts the WebSocket `/agent` endpoint and runs a **custom tool-calling loop** over an Azure OpenAI deployment (`gpt-5.6-sol`). No agent SDK: the loop, the approval gate, and conversation persistence are all first-party.

| File                                                      | Role                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                            | HTTP + WS server. On upgrade: origin allowlist (pre-handshake), then cookie auth by proxying the browser's cookie to the gateway's `/api/auth/me` (fail → close `4001`). Attaches the message listener synchronously and buffers until auth + init finish, so the client's first `user_message` (sent on WS open) is never dropped. |
| `src/agent-loop.ts`                                       | One instance per connection. Streams `gpt-5.6-sol`, relays text deltas, runs the approval gate on write tools, executes via the gateway, feeds results back, loops until the model stops. Per-turn caps (24 model calls / 10 writes); `AbortController` wired to the Stop button.                                                   |
| `src/tools.ts`                                            | OpenAI function schemas for terminal reads/writes and isolated virtual-browser tools. No `kill_session`, raw MCP, JavaScript, or CDP capability.                                                                                                                                                                                    |
| `src/gateway-client.ts`                                   | Fetch client for the gateway (loopback); logs in with `GATEWAY_AUTH_*` when the gateway has auth on, reuses the `gw_session` cookie, re-logs in on 401.                                                                                                                                                                             |
| `src/approvals.ts`                                        | Pending-approval map; `requestApproval` emits an `approval_request` and awaits the user's `approval_response` (120s → deny). `allow_always` scopes to tool+session for the chat.                                                                                                                                                    |
| `src/history.ts`                                          | Per-chat JSONL under `data/<chatId>.jsonl` (gitignored). Persists the model message log for resume; also serves the history feature: `listChats` (metadata derived from file mtimes + line counts — no sidecar), `deleteChat`, and `reconstructTranscript` (fold stored OpenAI messages into UI replay entries server-side).        |
| `src/config.ts` / `src/azure.ts` / `src/system-prompt.ts` | Env validation (fail-fast), the `AzureOpenAI` client, and the operator persona.                                                                                                                                                                                                                                                     |

Secrets and config live in a gitignored `.env` (Azure endpoint/key/version, deployment name, `AGENT_PORT`, `GATEWAY_URL`, `ALLOWED_ORIGINS`, gateway creds); see `apps/agent-service/.env.example`. `build` emits with `tsc`; `dev`/`start` run via `tsx`. Protocol: [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md).

### `apps/terminal` (`@sparklab/terminal`)

The Next.js (App Router) frontend for the terminal. Everything lives in one feature module, `src/features/terminal/`:

| File                             | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection.ts`                  | The `Connection` class — WebSocket lifecycle ported near-verbatim from the original vanilla client. **A class outside React, on purpose**: single-live-connection semantics, `noReconnect` guard, heartbeat ping/pong, exponential backoff, supersession checks, scrollback fetch + injection behind the attach redraw. Do not convert it into hooks.                                                                                                                                                            |
| `components/xterm.tsx`           | The xterm.js wrapper. Terminal + Connection live in refs; one mount effect creates everything, its cleanup fully disposes everything (StrictMode-safe). A second effect swaps the `Connection` when the active session changes — the terminal itself is never remounted, and the component never re-renders on terminal output. A separate effect applies the persisted `terminalFontSize` preference to the live terminal (`"auto"` follows the responsive 13/14 breakpoint; a number overrides it) and refits. |
| `components/dynamic-xterm.tsx`   | `next/dynamic(..., { ssr: false })` wrapper — xterm must never render on the server.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `components/terminal-shell.tsx`  | Top-level composition: sidebar + status + terminal; also mounts the settings dialog and the URL sync for `?session` / `?settings` / `?agent`.                                                                                                                                                                                                                                                                                                                                                                    |
| `components/session-sidebar.tsx` | Session list, create dialog, delete confirmation (shadcn Dialog/AlertDialog), and the settings gear (opens the settings dialog; shown even in open mode).                                                                                                                                                                                                                                                                                                                                                        |
| `components/settings-dialog.tsx` | Settings modal (shadcn Dialog) with four **tabbed** sections (active tab in `settingsSection`, deep-linked via `?settings=<section>`): Appearance (terminal font size — the only one with behavior), Agent chat (read-only model + per-write approval policy), Account (username + sign out; password is env-set), Connection (gateway URL, status, session count). All client-only — no gateway changes.                                                                                                        |
| `hooks/use-sessions.ts`          | TanStack Query: session list (3s `refetchInterval`), create/delete mutations with invalidation; responses Zod-parsed with `@sparklab/shared-types`.                                                                                                                                                                                                                                                                                                                                                              |
| `hooks/use-session-url-sync.ts`  | Deep-linking bridge: `?session=<id>` ↔ `activeSessionId` via `window.history.replaceState` (not `useSearchParams` — avoids the Suspense/CSR-bailout, and is loop-safe). URL wins on mount (overrides persist), store→URL thereafter; `replaceState` only (no back/forward history entries).                                                                                                                                                                                                                      |
| `hooks/use-url-flag-sync.ts`     | Generic presence-flag version of the session sync for booleans: `?agent` ↔ agent panel open. Presence opens on mount (deferring to the current/persisted value when absent — never force-closes); reflects the flag back to the URL. Instances compose (each write preserves the other params).                                                                                                                                                                                                                  |
| `hooks/use-settings-url-sync.ts` | Value-carrying variant for the settings dialog: one `?settings=<section>` param encodes both open (presence) and active tab (value). Presence opens on mount and, if the value is a known section, selects that tab; write emits `?settings=<section>` while open, removes it when closed.                                                                                                                                                                                                                       |
| `session-fallback.ts`            | Pure `resolveActiveSession(loaded, sessions, activeId)` — the "active session vanished → fall back" decision, gated on the first successful load so the initial-fetch window can't null a persisted/URL id. Unit-tested in isolation.                                                                                                                                                                                                                                                                            |
| `store.ts`                       | Zustand (+`persist`): persists `activeSessionId`, `sidebarCollapsed`, and `terminalFontSize`; holds ephemeral `mobileSidebarOpen` / `settingsOpen` / `settingsSection`; fallback when the active session vanishes.                                                                                                                                                                                                                                                                                               |
| `index.ts`                       | The feature's only public surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Wiring: `next.config.ts` rewrites `/api/:path*` to the gateway (same-origin REST for the browser); the WebSocket connects directly to `NEXT_PUBLIC_GATEWAY_URL`. xterm and its addons are npm dependencies bundled by Next — no CDN, no vendor script (offline/CSP requirement preserved).

A second feature module, `src/features/agent-chat/`, holds the **Agent Chat** UI: the floating button and docked panel (bottom sheet on mobile), streaming messages, expandable tool-event rows, the approval card (risk hints + per-session auto-approve), the composer with a session target picker, the amber terminal-attribution overlay + session-row badge, and `chat-history-dialog.tsx` (browse, resume, and delete past conversations from the panel's "Chat options" ⋮ menu). It owns its own zustand `store.ts` — which persists both `panelOpen` and `chatId` so a page reload resumes the same conversation — and a JSON-only WS client (`connection.ts`, modelled on the terminal's `Connection`) that reconnects with `?resumeChatId=<id>` to load a past chat. Amber (`chart-2`) is reused as the agent-activity status color — not a new brand accent. The terminal byte pipeline is untouched; the agent UI is layered around it.

### `apps/web` (`@sparklab/web`)

The product app shell. Currently minimal by design — it exists to carry the canonical patterns future features copy:

- `src/components/providers.tsx` — `QueryClient` created in `useState` inside a client component (never module-level).
- `src/features/demo/` — the exemplar feature: Zod `schemas.ts`, Zustand `store.ts`, an RHF+Zod form, a public `index.ts`.
- `src/lib/query-keys.ts` — query-key factory convention.

### `apps/e2e`

Playwright (chromium, serial workers). Boots its own production build of the terminal app plus a gateway on test ports (gateway 3907, Next 3902) via `webServer`. Specs map one-to-one to the cut-over gates — see [TESTING.md](TESTING.md).

## Packages

| Package                       | Contents                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sparklab/shared-types`      | Zod schemas + inferred types for the REST API and WS control frames (`src/terminal.ts`), auth (`src/auth.ts`), and the agent chat protocol + agent REST bodies (`src/agent.ts`). Source-export package: no build step; consumers transpile it (`transpilePackages` in Next apps). The schemas were derived from `server.js` — the server code is the source of truth; change them together.          |
| `@sparklab/ui`                | Design system: Tailwind v4 (CSS-first) theme tokens in `src/styles/globals.css`, `cn()` in `src/lib/utils.ts`, shadcn-generated components in `src/components/ui/` (checked in and editable — that's the shadcn model; regenerate/add with `pnpm dlx shadcn@latest add <name>` run inside the package). Apps must list it in `transpilePackages` and include its source in Tailwind `@source` globs. |
| `@sparklab/config-typescript` | `base.json` (strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `verbatimModuleSyntax`), plus `nextjs.json`, `react-library.json`, `node.json`.                                                                                                                                                                                                                                            |
| `@sparklab/config-eslint`     | ESLint 9 flat configs: `base.js`, `react.js`, `next.js`. Each workspace has a tiny `eslint.config.mjs` re-export.                                                                                                                                                                                                                                                                                    |
| `@sparklab/config-vitest`     | `base.js` (node env) and `react.js` (jsdom + Testing Library jest-dom setup).                                                                                                                                                                                                                                                                                                                        |

## Cross-cutting conventions

- **Feature/domain folders, not type grab-bags.** `app/` directories contain routing files only; logic lives in `src/features/<name>/` with a public `index.ts`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Server state in TanStack Query, client/UI state in Zustand — never mixed.**
- **Validate at the boundary.** Fetchers Zod-parse responses with `@sparklab/shared-types` before data enters the app.
- **Raw bytes end to end** for terminal I/O — see the invariants in [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md).
