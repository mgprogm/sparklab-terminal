# Documentation index

| Document                                               | What it covers                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [GETTING-STARTED.md](GETTING-STARTED.md)               | Prerequisites, install, starting dev, ports, environment variables                                                      |
| [ARCHITECTURE.md](ARCHITECTURE.md)                     | Monorepo layout, the three-lifetimes design, every app and package                                                      |
| [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md)           | REST API + WebSocket wire protocol, load-bearing invariants                                                             |
| [TESTING.md](TESTING.md)                               | Unit tests, Playwright E2E, the seven gates (six cut-over + auth), CI pipeline                                          |
| [CONTRIBUTING.md](CONTRIBUTING.md)                     | Code conventions: feature folders, imports, state rules, commits                                                        |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)                   | Original Phase-1 design & rationale for the tmux-backed terminal (historical, still authoritative for gateway behavior) |
| [FRONTEND-PLATFORM-PLAN.md](FRONTEND-PLATFORM-PLAN.md) | The implementation plan that produced the current monorepo (executed 2026-07-14; kept as a decision record)             |
| [DEPLOYMENT.md](DEPLOYMENT.md)                         | Production deployment: reverse-proxy topology, environment variables, Caddyfile, systemd, safety checklist              |
| [PHASE-3-HARDENING-PLAN.md](PHASE-3-HARDENING-PLAN.md) | Workstream A (auth/hardening) shipped 2026-07-14; Workstream B (scrollback, session status) in progress                 |

## Quick orientation

This repo is a **pnpm + Turborepo monorepo**. The flagship app is a web terminal whose defining property is that **jobs survive the browser and the gateway**: processes are owned by tmux, not by the Node gateway and not by the browser tab.

```
Browser (Next.js + xterm.js) --WS--> Gateway (node-pty) --tmux attach--> tmux server --> shell + jobs
```

- `apps/terminal-gateway` — Node gateway (plain JS): REST session CRUD + `/attach` WebSocket.
- `apps/terminal` — Next.js frontend for the terminal (xterm.js, TanStack Query, Zustand).
- `apps/web` — Next.js app that carries the exemplar patterns for future product features.
- `apps/e2e` — Playwright suite proving the cut-over gates.
- `packages/*` — shared UI, types, and config.

Start here: [GETTING-STARTED.md](GETTING-STARTED.md).
