# Documentation index

| Document                                                     | What it covers                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [GETTING-STARTED.md](GETTING-STARTED.md)                     | Prerequisites, install, starting dev, ports, environment variables                                                      |
| [ARCHITECTURE.md](ARCHITECTURE.md)                           | Monorepo layout, the three-lifetimes design, every app and package                                                      |
| [TERMINAL-PROTOCOL.md](TERMINAL-PROTOCOL.md)                 | REST API + WebSocket wire protocol, load-bearing invariants                                                             |
| [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md)                       | Agent Chat: `/agent`, auth, terminal/browser tools, approvals, history, and safety model                                |
| [VIRTUAL-BROWSER.md](VIRTUAL-BROWSER.md)                     | Virtual-browser setup, startup, code map, security invariants, and troubleshooting                                      |
| [TESTING.md](TESTING.md)                                     | Unit tests, Playwright E2E, the eight gates (six cut-over + auth + scrollback), CI pipeline                             |
| [CONTRIBUTING.md](CONTRIBUTING.md)                           | Code conventions: feature folders, imports, state rules, commits                                                        |
| [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)                         | Original Phase-1 design & rationale for the tmux-backed terminal (historical, still authoritative for gateway behavior) |
| [FRONTEND-PLATFORM-PLAN.md](FRONTEND-PLATFORM-PLAN.md)       | The implementation plan that produced the current monorepo (executed 2026-07-14; kept as a decision record)             |
| [DEPLOYMENT.md](DEPLOYMENT.md)                               | Production deployment: reverse-proxy topology, environment variables, Caddyfile, systemd, safety checklist              |
| [PHASE-3-HARDENING-PLAN.md](PHASE-3-HARDENING-PLAN.md)       | Workstreams A (auth/hardening) + B (scrollback, session status) shipped 2026-07-14                                      |
| [MULTI-SERVER-PLAN.md](MULTI-SERVER-PLAN.md)                 | Design proposal (not implemented): "Connected Servers" — create sessions on any registered server via SSH + remote tmux |
| [SESSION-ORGANIZATION-PLAN.md](SESSION-ORGANIZATION-PLAN.md) | Org → Project session grouping: metadata fields, PATCH endpoint, two-level collapsible sidebar tree                     |

## Quick orientation

This repo is a **pnpm + Turborepo monorepo**. The flagship app is a web terminal whose defining property is that **jobs survive the browser and the gateway**: processes are owned by tmux, not by the Node gateway and not by the browser tab.

```
Browser (Next.js + xterm.js) --WS--> Gateway (node-pty) --tmux attach--> tmux server --> shell + jobs
```

It also ships an **Agent Chat**: an AI agent (a custom tool-calling loop over Azure OpenAI, in `apps/agent-service`) that views and drives terminals — with per-write approval — through the gateway. It can also operate an isolated Browser Use instance and publish a read-only browser view. See [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md) and [VIRTUAL-BROWSER.md](VIRTUAL-BROWSER.md).

- `apps/terminal-gateway` — Node gateway (plain JS): REST session CRUD + agent REST (`/screen`, `/keys`) + `/attach` WebSocket.
- `apps/agent-service` — Node/TS agent service: the `/agent` WebSocket + the tool-calling loop over `gpt-5.6-sol`.
- `apps/terminal` — Next.js frontend: the terminal (xterm.js, TanStack Query, Zustand) + the Agent Chat panel.
- `apps/web` — Next.js app that carries the exemplar patterns for future product features.
- `apps/e2e` — Playwright suite proving the cut-over gates.
- `packages/*` — shared UI, types, and config.

Start here: [GETTING-STARTED.md](GETTING-STARTED.md).
