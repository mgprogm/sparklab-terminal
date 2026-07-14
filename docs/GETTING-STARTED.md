# Getting started

## Prerequisites

| Tool    | Version           | Notes                                                                                         |
| ------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Node.js | 24 (see `.nvmrc`) | `engine-strict` is on; older Node refuses to install                                          |
| pnpm    | 11.x              | `corepack enable` or `npm i -g pnpm` — the root `packageManager` field pins the exact version |
| tmux    | 3.x               | Required at runtime by the gateway and by the tests                                           |

## Install

```bash
pnpm install
```

This resolves all workspaces and builds node-pty's native binding (whitelisted in `pnpm-workspace.yaml`).

## Start dev — one line

```bash
pnpm dev
```

Runs `turbo dev`, which starts every app in parallel:

| App                          | URL                       | What it is                                 |
| ---------------------------- | ------------------------- | ------------------------------------------ |
| `@sparklab/terminal-gateway` | http://localhost:3007     | Gateway (REST + WS), `node --watch` reload |
| `@sparklab/terminal`         | **http://localhost:3002** | The web terminal — open this               |
| `@sparklab/web`              | http://localhost:3001     | Product app shell / pattern exemplars      |

Only want the terminal stack:

```bash
pnpm turbo dev --filter=@sparklab/terminal-gateway --filter=@sparklab/terminal
```

Or each app individually:

```bash
pnpm --filter @sparklab/terminal-gateway dev   # gateway, port 3007 (PORT=xxxx to override)
pnpm --filter @sparklab/terminal dev           # Next.js terminal app, port 3002
pnpm --filter @sparklab/web dev                # Next.js web app, port 3001
```

## Environment variables

| Variable                  | Default                                       | Used by         | Purpose                                                                                                                                                                              |
| ------------------------- | --------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                    | `3007`                                        | gateway         | Listen port for REST + WS                                                                                                                                                            |
| `HOST`                    | `127.0.0.1`                                   | gateway         | Bind address. Defaults to loopback. Must be loopback when `GATEWAY_AUTH_TOKEN` is unset (open mode).                                                                                 |
| `GATEWAY_AUTH_TOKEN`      | _(unset)_                                     | gateway         | Shared secret for single-user auth. Unset + non-loopback `HOST` → gateway refuses to start. See [DEPLOYMENT.md](DEPLOYMENT.md).                                                      |
| `ALLOWED_ORIGINS`         | `http://localhost:3000,http://localhost:3007` | gateway         | Comma-separated allowed `Origin` values for WS upgrades and mutating REST. Set to your public origin in production.                                                                  |
| `TRUST_PROXY`             | _(unset)_                                     | gateway         | Set to `1` behind a reverse proxy: enables `X-Forwarded-For` for rate limiting and `; Secure` on the session cookie.                                                                 |
| `MAX_WS_CONNECTIONS`      | `32`                                          | gateway         | Cap on concurrent WebSocket connections.                                                                                                                                             |
| `NEXT_PUBLIC_GATEWAY_URL` | `http://localhost:3007`                       | `apps/terminal` | Where the browser's WebSocket connects, and where Next rewrites proxy `/api/*`. **Inlined at build time** for client code — set it when running `next build`, not just `next start`. |

REST calls from the browser are same-origin (proxied through Next rewrites); the WebSocket connects directly to the gateway (`http` → `ws`, `https` → `wss`). The gateway sends no CORS headers — this is by design; keep REST behind the proxy.

## Everyday commands

```bash
pnpm build       # turbo build — all apps/packages
pnpm lint        # turbo lint
pnpm typecheck   # turbo typecheck
pnpm test        # turbo test — all Vitest suites
pnpm --filter e2e test                             # Playwright E2E (builds/boots its own servers)
pnpm --filter @sparklab/terminal-gateway smoke     # pty↔tmux smoke test
pnpm --filter @sparklab/terminal-gateway acceptance        # job survives disconnect
pnpm --filter @sparklab/terminal-gateway acceptance:multi  # multi-session isolation
```

If an interrupted test leaves tmux sessions behind: `tmux ls` then `tmux kill-session -t <name>`.

## Production notes

- Phase 3 adds single-user token auth, origin allowlist, rate limiting, and connection caps. See **[docs/DEPLOYMENT.md](DEPLOYMENT.md)** for the full production guide (topology, Caddyfile, all environment variables, security checklist).
- For production, put the Next app and the gateway behind one reverse proxy (single origin) — e.g. Caddy routing `/api/*` and `/attach` to the gateway, everything else to the Next server (see `deploy/Caddyfile`).
