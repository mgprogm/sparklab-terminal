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
- **Reconnect restoration is tmux's attach redraw, not replay.** On reattach, tmux redraws the current screen (including full-screen apps like vim). The client resets the terminal first so the redraw lands on a clean screen — no `capture-pane` replay, which would double-draw.

The full rationale and edge-case analysis is in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md). The wire protocol is specified in [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md).

## Monorepo layout

pnpm workspaces + Turborepo. Workspace globs: `apps/*`, `packages/*` (`pnpm-workspace.yaml`). Task graph in `turbo.json`: `build` (dependsOn `^build`), `lint`, `typecheck`, `test`, `dev` (persistent, uncached), `e2e` (uncached).

```
├── apps/
│   ├── terminal-gateway/     # Node gateway (plain JS, deliberately)
│   ├── terminal/             # Next.js terminal frontend
│   ├── web/                  # Next.js product app (pattern exemplars)
│   └── e2e/                  # Playwright suite (not built, only tested)
├── packages/
│   ├── shared-types/         # Zod schemas: REST + WS protocol
│   ├── ui/                   # shadcn/ui + Tailwind v4 design system
│   ├── config-typescript/    # shared tsconfig bases
│   ├── config-eslint/        # shared ESLint 9 flat configs
│   └── config-vitest/        # shared Vitest presets
└── docs/
```

## Apps

### `apps/terminal-gateway` (`@sparklab/terminal-gateway`)

Plain-JS Node server, no framework, no build step. Two files:

- `src/server.js` — REST session CRUD (`/api/sessions`), the `/attach` WebSocket endpoint, tmux session management. Spawns ptys with `encoding: null` so all terminal I/O stays raw bytes.
- `src/metadata.js` — session display metadata (names, tags) persisted to `data/sessions.json` (gitignored runtime data).

Deliberate choices: it stays plain JS (moved verbatim in the monorepo restructure; TS conversion is a separate future task), and it serves no frontend anymore (its old vanilla-JS `public/` was deleted after the cut-over gates passed; static requests now 404).

The auth boundary lives at the gateway: single shared-secret token auth via `GATEWAY_AUTH_TOKEN`, in-memory cookie sessions (`gw_session`, HttpOnly, SameSite=Strict, 30-day absolute expiry), origin allowlist on WS upgrades and mutating REST, per-IP login rate limiting (5/min). The gateway binds `127.0.0.1` by default; TLS terminates at a reverse proxy (Caddy) per [DEPLOYMENT.md](DEPLOYMENT.md). When `GATEWAY_AUTH_TOKEN` is unset, auth is disabled (open mode); the gateway refuses to start tokenless on a non-loopback `HOST`.

Tests live in `test/` as standalone node scripts (see [TESTING.md](TESTING.md)) — they are the load-bearing proof of job survival.

### `apps/terminal` (`@sparklab/terminal`)

The Next.js (App Router) frontend for the terminal. Everything lives in one feature module, `src/features/terminal/`:

| File                             | Role                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection.ts`                  | The `Connection` class — WebSocket lifecycle ported near-verbatim from the original vanilla client. **A class outside React, on purpose**: single-live-connection semantics, `noReconnect` guard, heartbeat ping/pong, exponential backoff, supersession checks. Do not convert it into hooks.                                  |
| `components/xterm.tsx`           | The xterm.js wrapper. Terminal + Connection live in refs; one mount effect creates everything, its cleanup fully disposes everything (StrictMode-safe). A second effect swaps the `Connection` when the active session changes — the terminal itself is never remounted, and the component never re-renders on terminal output. |
| `components/dynamic-xterm.tsx`   | `next/dynamic(..., { ssr: false })` wrapper — xterm must never render on the server.                                                                                                                                                                                                                                            |
| `components/terminal-shell.tsx`  | Top-level composition: sidebar + status + terminal.                                                                                                                                                                                                                                                                             |
| `components/session-sidebar.tsx` | Session list, create dialog, delete confirmation (shadcn Dialog/AlertDialog).                                                                                                                                                                                                                                                   |
| `hooks/use-sessions.ts`          | TanStack Query: session list (3s `refetchInterval`), create/delete mutations with invalidation; responses Zod-parsed with `@sparklab/shared-types`.                                                                                                                                                                             |
| `store.ts`                       | Zustand (+`persist`): `activeSessionId`, `sidebarCollapsed`, fallback when the active session vanishes.                                                                                                                                                                                                                         |
| `index.ts`                       | The feature's only public surface.                                                                                                                                                                                                                                                                                              |

Wiring: `next.config.ts` rewrites `/api/:path*` to the gateway (same-origin REST for the browser); the WebSocket connects directly to `NEXT_PUBLIC_GATEWAY_URL`. xterm and its addons are npm dependencies bundled by Next — no CDN, no vendor script (offline/CSP requirement preserved).

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
| `@sparklab/shared-types`      | Zod schemas + inferred types for the REST API and WS control frames (`src/terminal.ts`). Source-export package: no build step; consumers transpile it (`transpilePackages` in Next apps). The schemas were derived from `server.js` — the server code is the source of truth; change them together.                                                                                                  |
| `@sparklab/ui`                | Design system: Tailwind v4 (CSS-first) theme tokens in `src/styles/globals.css`, `cn()` in `src/lib/utils.ts`, shadcn-generated components in `src/components/ui/` (checked in and editable — that's the shadcn model; regenerate/add with `pnpm dlx shadcn@latest add <name>` run inside the package). Apps must list it in `transpilePackages` and include its source in Tailwind `@source` globs. |
| `@sparklab/config-typescript` | `base.json` (strict + `noUncheckedIndexedAccess` + `noImplicitOverride` + `verbatimModuleSyntax`), plus `nextjs.json`, `react-library.json`, `node.json`.                                                                                                                                                                                                                                            |
| `@sparklab/config-eslint`     | ESLint 9 flat configs: `base.js`, `react.js`, `next.js`. Each workspace has a tiny `eslint.config.mjs` re-export.                                                                                                                                                                                                                                                                                    |
| `@sparklab/config-vitest`     | `base.js` (node env) and `react.js` (jsdom + Testing Library jest-dom setup).                                                                                                                                                                                                                                                                                                                        |

## Cross-cutting conventions

- **Feature/domain folders, not type grab-bags.** `app/` directories contain routing files only; logic lives in `src/features/<name>/` with a public `index.ts`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Server state in TanStack Query, client/UI state in Zustand — never mixed.**
- **Validate at the boundary.** Fetchers Zod-parse responses with `@sparklab/shared-types` before data enters the app.
- **Raw bytes end to end** for terminal I/O — see the invariants in [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md).
