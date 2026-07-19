# Virtual Browser

The Agent Chat can open public websites in an isolated, headless Chromium instance and show a read-only screenshot above the terminal. Browser sessions start lazily per chat and are destroyed on Stop, disconnect, or service shutdown.

## Prerequisites

Install Node.js 24+, pnpm 11, tmux, and `uv`. Prepare the trusted Browser Use checkout once:

```bash
cd /home/sparklab/workspaces/sparklab/browser-use
uv sync
uvx browser-use install
```

The checkout is used as a runtime dependency; this repository does not modify it.

## Configure Agent Chat

From this repository:

```bash
pnpm install
cp apps/agent-service/.env.example apps/agent-service/.env
```

Fill in the required Azure OpenAI values, then enable browser tools:

```env
BROWSER_USE_PROJECT=/home/sparklab/workspaces/sparklab/browser-use
BROWSER_USE_HEADLESS=true
```

For local gateway open mode, remove `GATEWAY_AUTH_USER` and `GATEWAY_AUTH_PASSWORD` from the agent-service environment. When gateway authentication is enabled, those values must match the gateway credentials.

## Start and Use

```bash
pnpm dev
```

Open `http://localhost:3002`, open Agent Chat, and ask it to visit a public HTTP(S) URL. Navigation and other state-changing browser actions require one-time approval. A successful action publishes a revisioned PNG or WebP snapshot; use **Back to terminal** to hide it and the globe control to reopen the latest view.

The initial `about:blank` observation intentionally displays no screenshot. Private, loopback, link-local, reserved, credential-bearing, and non-HTTP(S) destinations are rejected.

## Code Map and Invariants

- `apps/agent-service/src/browser-runtime.ts` owns one lazy Browser Use MCP subprocess per agent loop, bounded MCP messages, snapshots, and cleanup.
- `browser-proxy.ts` and `browser-security.ts` enforce public-network-only egress and DNS-rebinding protection.
- `agent-loop.ts`, `tools.ts`, and `approvals.ts` expose the restricted tool surface, redact typed text, and prevent persistent browser approvals.
- `packages/shared-types/src/agent.ts` defines bounded `browser_view` and `browser_closed` WebSocket frames.
- `apps/terminal/src/features/browser-view/` owns ephemeral view state and the read-only overlay. Revision tombstones prevent stale frames from reopening a closed view.

Do not expose raw MCP, CDP, JavaScript execution, filesystem, upload, or download capabilities. Do not persist screenshots or browser state in chat history. Keep xterm mounted beneath the overlay and move focus away from its hidden textarea.

## Verify and Troubleshoot

Run the focused and repository-wide checks after changes:

```bash
pnpm --filter @sparklab/agent-service test
pnpm --filter @sparklab/terminal test
pnpm typecheck
pnpm build
```

If browser tools are absent, confirm that `BROWSER_USE_PROJECT` is present in `apps/agent-service/.env`, `uv` is on `PATH`, and restart `pnpm dev`. If Chromium cannot start, rerun `uvx browser-use install` in the Browser Use checkout. Inspect the agent-service process on port 3009 for MCP startup or policy errors.
