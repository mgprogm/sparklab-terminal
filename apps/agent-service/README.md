# @sparklab/agent-service

The **Agent Chat** backend: a Node/TypeScript service that hosts a WebSocket
(`/agent`, default port 3009) and runs a custom tool-calling loop over an Azure
OpenAI deployment (`gpt-5.6-sol`). It lets the user chat with an AI agent that
can view, drive, and create terminal sessions — always through the gateway,
never touching tmux directly.

It can also start one isolated Browser Use stdio MCP process per chat on demand.
Only observe, tab listing, and structured browser actions are exposed; raw MCP,
JavaScript, CDP, files, uploads, and downloads are not available to the model.

It is a **fourth independent lifetime** in the stack (browser · gateway · tmux ·
agent): it can crash or restart without affecting any attached pty. See
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for where it sits, and
[../../docs/AGENT-PROTOCOL.md](../../docs/AGENT-PROTOCOL.md) for the wire
protocol, the tool surface, and the safety model.

## Why a custom loop (no agent SDK)

The loop, the approval gate, and conversation persistence are all first-party
(`src/agent-loop.ts`, `src/approvals.ts`, `src/history.ts`). This keeps the only
dependency an HTTP client (`openai` in Azure mode) and makes the declared
terminal and browser tools the model's entire capability surface — there are no
built-in tools to disable.

Chats are owned by terminal session, not by the browser page. Every `/agent`
connection supplies `terminalSessionId`; the service resumes that terminal's
latest chat unless the client selects a specific `resumeChatId` or requests
`newChat=1`. Ownership is durable, so switching terminals or reloading the page
cannot leak one terminal's transcript into another.

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

To enable virtual-browser tools, set `BROWSER_USE_PROJECT` to a trusted local
Browser Use checkout. In that checkout, install Python dependencies and
Chromium with `uv sync` and `uvx browser-use install`. `uv` must be on the agent
service's `PATH`. `BROWSER_USE_HEADLESS` defaults to `true`.

Every chat receives a temporary Browser Use config, Chromium profile, download
directory, and enforcing loopback proxy. The proxy blocks non-HTTP(S), embedded
credentials, loopback, link-local, private/reserved networks, metadata services,
unsafe redirects, and DNS rebinding. Browser processes and their Chromium
process groups are terminated on Stop or disconnect; temporary state is then
removed. Do not weaken this isolation or expose the MCP process directly.
The initial `about:blank` observation intentionally has no view frame; the
first bounded view is emitted once navigation reaches a public HTTP(S) page.

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
| `src/tools.ts`                                            | Terminal/browser function schemas and terminal dispatcher                |
| `src/gateway-client.ts`                                   | Gateway REST client (login, sessions, screen, keys)                      |
| `src/approvals.ts`                                        | Write-approval gate (browser actions are always one-time)                |
| `src/browser-runtime.ts` / `src/browser-proxy.ts`         | Isolated Browser Use MCP lifecycle and network enforcement               |
| `src/history.ts`                                          | JSONL history + terminal ownership metadata; latest-chat resolution      |
| `src/azure.ts` / `src/config.ts` / `src/system-prompt.ts` | Azure client, env validation, operator persona                           |

Runs via `tsx` (not plain `node`) because it imports `@sparklab/shared-types`
from its TypeScript source.
