# @sparklab/agent-service

The **Agent Chat** backend: a Node/TypeScript service that hosts a WebSocket
(`/agent`, default port 3009) and runs a custom tool-calling loop over an Azure
OpenAI deployment (`gpt-5.6-sol`). It lets the user chat with an AI agent that
can view, drive, and create terminal sessions — always through the gateway,
never touching tmux directly.

It is a **fourth independent lifetime** in the stack (browser · gateway · tmux ·
agent): it can crash or restart without affecting any attached pty. See
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for where it sits, and
[../../docs/AGENT-PROTOCOL.md](../../docs/AGENT-PROTOCOL.md) for the wire
protocol, the 7 tools, and the safety model.

## Why a custom loop (no agent SDK)

The loop, the approval gate, and conversation persistence are all first-party
(`src/agent-loop.ts`, `src/approvals.ts`, `src/history.ts`). This keeps the only
dependency an HTTP client (`openai` in Azure mode) and makes the seven terminal
tools the model's entire capability surface — there are no built-in tools to
disable.

## Setup

```bash
cp .env.example .env      # then fill in the Azure credentials
```

Required env (see `.env.example` and the table in
[../../docs/GETTING-STARTED.md](../../docs/GETTING-STARTED.md)):
`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`,
`GPT56SOL_DEPLOYMENT`, plus `AGENT_PORT`, `GATEWAY_URL`, `ALLOWED_ORIGINS`, and
(in gateway auth mode) `GATEWAY_AUTH_USER` / `GATEWAY_AUTH_PASSWORD`. The service
**fails fast** at startup if a required Azure var is missing. `.env` is
gitignored — never commit the key.

## Scripts

```bash
pnpm --filter @sparklab/agent-service dev        # tsx watch (reads .env)
pnpm --filter @sparklab/agent-service start      # tsx, no watch
pnpm --filter @sparklab/agent-service build      # tsc → dist/
pnpm --filter @sparklab/agent-service typecheck  # tsc --noEmit
pnpm --filter @sparklab/agent-service smoke       # live end-to-end (1 Azure call)
```

The `smoke` test spawns a real gateway (open mode) + this service, opens a WS,
sends one message, auto-approves the write, and asserts the agent actually
created a session in tmux via the approval flow — then cleans up. It makes one
real Azure call, so it needs a valid `.env` and takes ~1min (the model is slow).

## Layout

| File                                                      | Role                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/index.ts`                                            | HTTP + WS server; origin + cookie auth; buffers early frames until ready |
| `src/agent-loop.ts`                                       | The streaming tool-calling loop (one per connection); per-turn caps      |
| `src/tools.ts`                                            | The 7 tools (schemas + dispatcher) against the gateway                   |
| `src/gateway-client.ts`                                   | Gateway REST client (login, sessions, screen, keys)                      |
| `src/approvals.ts`                                        | Write-approval gate (request/response bridge, 120s timeout → deny)       |
| `src/history.ts`                                          | Per-chat JSONL persistence under `data/` (gitignored)                    |
| `src/azure.ts` / `src/config.ts` / `src/system-prompt.ts` | Azure client, env validation, operator persona                           |

Runs via `tsx` (not plain `node`) because it imports `@sparklab/shared-types`
from its TypeScript source.
