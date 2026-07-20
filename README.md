# Sparklab Terminal

A web terminal whose defining property is that **your jobs survive the browser and the gateway**. Close the tab, drop the network, or restart the server process — a running job keeps going and is there, live, when you reconnect.

It ships with multi-server SSH access, a file explorer, "job finished" push notifications, installable-PWA support, and an **Agent Chat**: an AI agent that can read a session's screen, type into it with per-write approval, create sessions, and drive an isolated browser.

> ⚠️ **Status:** experimental / single-user. This is a personal project, not a hardened multi-tenant product — see [Security & scope](#security--scope) before exposing it to the internet.

---

## Why it's different

Most web terminals tie the shell process to the WebSocket or the server that spawned it — kill either and the job dies. Here the process owner is **tmux**, and three layers fail independently:

```
Browser (xterm.js)  --WebSocket-->  Gateway (node-pty)  --tmux attach-->  tmux server --> shell + jobs
```

- **The gateway never owns the job.** On connect it spawns a pty running `tmux attach`; on disconnect it kills _only that pty_ (detaching the tmux client). It never runs `tmux kill-session`.
- **tmux is the source of truth.** There is no database. A restarted gateway rediscovers every session via `tmux ls`.
- **The agent is a separate lifetime.** It can crash and restart without touching any terminal, and it operates terminals only as a REST client of the gateway.

Full rationale in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md).

## Features

- **Persistent jobs** — survive tab close, network loss, and gateway restart.
- **Multi-session** — create/rename/organize sessions; group them by org → project in the sidebar.
- **Multi-server** — attach to remote hosts over SSH (key or password auth) with connection multiplexing; local and remote sessions live side by side.
- **File explorer** — browse, preview, upload, download, rename, and delete files on any session's host (local or remote).
- **Git-status footer** — live branch + working-tree summary for the active session's cwd.
- **Agent Chat** — an Azure-OpenAI tool-calling loop that can read screens, type with per-write approval, create sessions, and operate an isolated, egress-restricted browser.
- **PWA + Web Push** — installable app; get notified when a long job finishes, even with the tab closed.

## Quick start

Requirements: **Node ≥ 24**, **pnpm 11**, and **tmux** installed locally.

```bash
pnpm install

# minimal auth config for the gateway (dev)
cp apps/terminal-gateway/.env.example apps/terminal-gateway/.env
# edit it: set GATEWAY_AUTH_USER and GATEWAY_AUTH_PASSWORD

pnpm dev     # gateway :3007 + terminal :3002 + agent :3009
```

Open <http://localhost:3002> and sign in with the credentials you set.

- Agent Chat needs Azure OpenAI credentials in `apps/agent-service/.env` (see its `.env.example`); the terminal works without it.
- Full walkthrough: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).

## Common commands

```bash
pnpm dev          # run all three services (turbo)
pnpm build        # build every workspace
pnpm lint         # lint
pnpm typecheck    # typecheck
pnpm test         # tests across workspaces

# gateway acceptance scripts (spawn real tmux + a real gateway)
pnpm --filter @sparklab/terminal-gateway acceptance        # job survives disconnect
pnpm --filter @sparklab/terminal-gateway acceptance:remote # job survives full gateway restart
```

More in [`docs/TESTING.md`](docs/TESTING.md).

## Project layout

| Path                     | What                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `apps/terminal/`         | Next.js frontend (xterm.js, auth, Agent Chat UI, PWA)                                   |
| `apps/terminal-gateway/` | Node gateway — session CRUD, tmux management, `/attach` WS, SSH, file & git & push REST |
| `apps/agent-service/`    | Node/TS AI agent service (tool-calling loop, browser runtime)                           |
| `apps/e2e/`              | Playwright end-to-end suite                                                             |
| `packages/shared-types/` | Zod schemas shared across REST / WS / auth                                              |
| `packages/ui/`           | Shared shadcn-style UI primitives                                                       |
| `docs/`                  | Architecture, protocols, and design records                                             |

Monorepo tooling: **pnpm workspaces + Turborepo**.

## Deployment

Expose the gateway only behind a reverse proxy with auth configured — never bind it to a public interface directly. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), the example [`deploy/Caddyfile`](deploy/Caddyfile), and [`docs/LOCAL-PROD.md`](docs/LOCAL-PROD.md) for a local production build.

## Security & scope

- **Single-user** username/password auth (scrypt-hashed). There is no multi-user isolation, session sharing, or read-only viewer support yet.
- Secrets live only in gitignored per-app `.env` files. Copy the `.env.example` templates; never commit real credentials.
- The Agent Chat's browser is intentionally locked down (public HTTP(S) egress only; no raw MCP/CDP/JS/file access). See [`docs/VIRTUAL-BROWSER.md`](docs/VIRTUAL-BROWSER.md).

Treat this as a tool for your own machines behind trusted auth, not as a hosted service for untrusted users.

## Contributing

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md). Commits follow Conventional Commits (enforced via commitlint + Husky).

## License

No license file yet — until one is added, this code is "all rights reserved" by default. If you intend to open it for reuse, add a `LICENSE`.
