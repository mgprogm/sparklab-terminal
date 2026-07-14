# Deployment guide

This document covers how to deploy the web terminal safely on a real network.
The security model: **TLS and the public surface live in the reverse proxy (Caddy); the gateway and the Next.js app bind to loopback only.**

## Topology

```
Internet
   │  HTTPS / WSS  (443)
   ▼
┌─────────────────────────────────────────────────┐
│  Caddy  (public, TLS termination)                │
│  term.example.com                                │
└──┬──────────────┬──────────────┬─────────────────┘
   │ /attach      │ /agent       │ /api/*     everything else
   │ HTTP+WS      │ HTTP+WS      │ HTTP       HTTP
   ▼              ▼              ▼            ▼
┌──────────┐  ┌──────────────┐          ┌───────────────┐
│ Gateway  │  │ agent-service│          │  Next.js app  │
│ 127.0.0.1│◄─┤ 127.0.0.1    │          │  127.0.0.1    │
│ :3007    │  │ :3009        │          │  :3000        │
└────┬─────┘  └──────────────┘          └───────────────┘
     │ tmux attach-session      (agent-service drives terminals
     ▼                           via the gateway's loopback REST)
┌───────────────┐
│  tmux server  │  ← owns every running job
└───────────────┘
```

The gateway never touches a public socket. All auth and origin enforcement
happens inside the gateway process; Caddy only forwards and terminates TLS. The
agent service also binds loopback: it verifies the browser's `gw_session`
cookie against the gateway on each WS upgrade, and reaches tmux only through the
gateway's REST API. Deploying Agent Chat is **optional** — omit the service and
the `/agent` route and the terminal works unchanged (the chat panel just can't
connect).

## Environment variables

| Variable                     | Default                                       | Required in prod       | Description                                                                                                                                          |
| ---------------------------- | --------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                       | `3007`                                        | No                     | Gateway listen port                                                                                                                                  |
| `HOST`                       | `127.0.0.1`                                   | No                     | Gateway bind address. **Must be loopback unless auth credentials are set.**                                                                          |
| `GATEWAY_AUTH_USER`          | _(unset)_                                     | **Yes**                | Username for single-user auth. No credentials + non-loopback HOST → gateway refuses to start.                                                        |
| `GATEWAY_AUTH_PASSWORD_HASH` | _(unset)_                                     | **Yes**                | scrypt hash of the password, generated with `pnpm --filter @sparklab/terminal-gateway hash-password`. Quote it in shell/env files — it contains `$`. |
| `GATEWAY_AUTH_PASSWORD`      | _(unset)_                                     | No                     | Plaintext password alternative for dev/tests only; hashed at startup. If both are set, the hash wins. Never use in production.                       |
| `ALLOWED_ORIGINS`            | `http://localhost:3000,http://localhost:3007` | **Yes**                | Comma-separated list of allowed `Origin` values for WS upgrades and mutating REST calls. Set to your public origin, e.g. `https://term.example.com`. |
| `TRUST_PROXY`                | _(unset / `0`)_                               | **Yes** (behind proxy) | Set to `1` when running behind a reverse proxy. Enables: reading client IP from `X-Forwarded-For`, adding `; Secure` to the session cookie.          |
| `MAX_WS_CONNECTIONS`         | `32`                                          | No                     | Cap on concurrent WebSocket connections. Over-cap connections are rejected post-handshake with close code 1013.                                      |
| `NEXT_PUBLIC_GATEWAY_URL`    | `http://localhost:3007`                       | **Yes**                | Inlined at build time into the Next.js app — must be the public WebSocket URL: `wss://term.example.com`.                                             |

### Agent Chat (only if deploying `apps/agent-service`)

Set in `apps/agent-service/.env` (gitignored). If you are not deploying Agent Chat, skip this table and the `/agent` Caddy route.

| Variable                                      | Default                 | Required            | Description                                                                                                               |
| --------------------------------------------- | ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`                       | _(unset)_               | **Yes**             | Azure AI Foundry resource endpoint URL.                                                                                   |
| `AZURE_OPENAI_API_KEY`                        | _(unset)_               | **Yes**             | Azure key. Secret — gitignored `.env` only, and rotate if ever exposed.                                                   |
| `AZURE_OPENAI_API_VERSION`                    | `2025-04-01-preview`    | No                  | Pin the Azure OpenAI REST API version.                                                                                    |
| `GPT56SOL_DEPLOYMENT`                         | _(unset)_               | **Yes**             | Deployment name (e.g. `gpt-5.6-sol`); used as the model id.                                                               |
| `AGENT_PORT`                                  | `3009`                  | No                  | Listen port for the `/agent` WebSocket (loopback).                                                                        |
| `GATEWAY_URL`                                 | `http://127.0.0.1:3007` | **Yes**             | Loopback gateway base URL the service drives terminals through.                                                           |
| `ALLOWED_ORIGINS`                             | localhost dev origins   | **Yes**             | Allowed browser `Origin`s for the `/agent` WS. Set to your public origin, e.g. `https://term.example.com`.                |
| `GATEWAY_AUTH_USER` / `GATEWAY_AUTH_PASSWORD` | _(unset)_               | **Yes** (auth mode) | Credentials the service uses to log in to the gateway. Match the gateway's; omit only in open mode.                       |
| `NEXT_PUBLIC_AGENT_URL`                       | `http://localhost:3009` | **Yes**             | Inlined at build time into the Next.js app — the public agent WS URL: `wss://term.example.com` (same origin as the site). |

Because Caddy serves the agent WS at the same public origin as the site,
`NEXT_PUBLIC_AGENT_URL` is typically the same host as `NEXT_PUBLIC_GATEWAY_URL`
(both `wss://term.example.com`); the path (`/agent` vs `/attach`) routes them.

## Step-by-step: production on a VPS

### 1. Install prerequisites

```bash
# Node.js 24 (via nvm or nodesource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# tmux
sudo apt-get install -y tmux

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# pnpm
npm i -g pnpm
```

### 2. Clone and build

```bash
git clone https://github.com/your-org/claude-web-terminal.git /opt/web-terminal
cd /opt/web-terminal
pnpm install

# Build the Next.js app with the public gateway URL baked in.
NEXT_PUBLIC_GATEWAY_URL=wss://term.example.com \
  pnpm --filter @sparklab/terminal build
```

### 3. Generate the password hash

```bash
pnpm --filter @sparklab/terminal-gateway hash-password
# Password: ********  (prompted twice, no echo)
# → GATEWAY_AUTH_PASSWORD_HASH='scrypt$16384$8$1$…$…'
```

The command prints a ready-to-paste env line. The single quotes are
load-bearing — the value contains `$`.

### 4. Create a `.env` file for the gateway

```bash
cat > /opt/web-terminal/apps/terminal-gateway/.env << 'EOF'
GATEWAY_AUTH_USER=<your-username>
GATEWAY_AUTH_PASSWORD_HASH='<output of hash-password>'
ALLOWED_ORIGINS=https://term.example.com
TRUST_PROXY=1
HOST=127.0.0.1
PORT=3007
EOF
chmod 600 /opt/web-terminal/apps/terminal-gateway/.env
```

### 5. Configure Caddy

Copy `deploy/Caddyfile` and edit the domain:

```bash
sudo cp /opt/web-terminal/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/term.example.com/your-actual-domain.com/g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 6. Start the services (systemd example)

```ini
# /etc/systemd/system/web-terminal-gateway.service
[Unit]
Description=Web Terminal Gateway
After=network.target

[Service]
WorkingDirectory=/opt/web-terminal/apps/terminal-gateway
EnvironmentFile=/opt/web-terminal/apps/terminal-gateway/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now web-terminal-gateway

# Start the Next.js app (adjust as needed for your setup)
cd /opt/web-terminal && pnpm --filter @sparklab/terminal start &
```

**Agent Chat service (optional).** If deploying it, add a second unit. It runs
via `tsx`, so `ExecStart` invokes the workspace binary:

```ini
# /etc/systemd/system/web-terminal-agent.service
[Unit]
Description=Web Terminal Agent Service
After=network.target web-terminal-gateway.service

[Service]
WorkingDirectory=/opt/web-terminal/apps/agent-service
EnvironmentFile=/opt/web-terminal/apps/agent-service/.env
ExecStart=/opt/web-terminal/apps/agent-service/node_modules/.bin/tsx src/index.ts
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

Build the Next.js app with **both** public URLs baked in when Agent Chat is
enabled: `NEXT_PUBLIC_GATEWAY_URL=wss://term.example.com NEXT_PUBLIC_AGENT_URL=wss://term.example.com pnpm --filter @sparklab/terminal build`.

## Caddyfile reference

See `deploy/Caddyfile` for the full example. Key points:

- `/attach` and `/api/*` → `reverse_proxy 127.0.0.1:3007` (gateway)
- `/agent` → `reverse_proxy 127.0.0.1:3009` (agent service; omit if not deploying Agent Chat)
- Everything else → `reverse_proxy 127.0.0.1:3000` (Next.js app)
- Caddy issues and renews TLS certificates automatically for named hosts.

## "What makes this safe now" checklist

| Threat                                 | Mitigation                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated shell access           | Username/password login required (scrypt-hashed, timing-safe verify); all `/api/*` except `/api/auth/*`, plus `/attach`, check the `gw_session` cookie.                                                                            |
| Cross-site WebSocket hijacking (CSWSH) | Origin header checked against `ALLOWED_ORIGINS` on every WS upgrade (pre-handshake 403 for unknown/absent origins).                                                                                                                |
| CSRF on mutating REST endpoints        | Same origin check applied to `POST`/`DELETE /api/*` when an `Origin` header is present.                                                                                                                                            |
| Credential brute-force                 | Login rate-limited to 5 attempts/min per IP (fixed window, 429 + `Retry-After`).                                                                                                                                                   |
| Slow-loris / large body                | 64 KB body cap on all endpoints; `headersTimeout=30s`, `requestTimeout=60s`.                                                                                                                                                       |
| Too many WS connections                | Capped at `MAX_WS_CONNECTIONS` (default 32); over-cap connections closed with code 1013.                                                                                                                                           |
| TLS/MITM                               | TLS terminated at Caddy with auto-renewing certificates. Session cookie gains `; Secure` when `TRUST_PROXY=1`.                                                                                                                     |
| Gateway exposed publicly               | `HOST` defaults to `127.0.0.1`; binds loopback only. Only Caddy listens on public interfaces.                                                                                                                                      |
| Non-loopback bind without credentials  | Gateway refuses to start (`process.exit(1)`) if no auth credentials are set and `HOST` is non-loopback.                                                                                                                            |
| Password disclosure via config leak    | Production stores only the scrypt hash (`GATEWAY_AUTH_PASSWORD_HASH`); the plaintext password exists nowhere on the server.                                                                                                        |
| Unauthenticated agent access           | The `/agent` WS verifies the browser's `gw_session` cookie against the gateway on every upgrade (close `4001` on failure); its origin allowlist mirrors the gateway's. Binds loopback; only Caddy is public.                       |
| Agent running commands unsupervised    | Every write tool (`type_text`/`press_keys`/`run_command`/`create_session`) requires per-call user approval (120s → deny); no `kill_session` tool exists. `allow_always` is per-chat, non-persistent. Per-turn caps bound runaways. |
| Azure key disclosure                   | Key lives only in the gitignored `apps/agent-service/.env` (`chmod 600`), never inlined into client code; rotate immediately if exposed.                                                                                           |

## Development (open mode)

When no auth credentials are set and `HOST` is a loopback address (`127.0.0.1`, `::1`, `localhost`), the gateway runs in **open mode**: auth and origin checks are disabled, matching pre-Phase-3 behavior. This lets test scripts and `curl` work without credentials or browser headers.

Open mode is safe on loopback because no external network can reach the gateway. Do not expose open mode to a non-loopback interface.

## Upgrading from Phase 2

Phase 3 changes the default `HOST` bind from the implicit `0.0.0.0` to explicit `127.0.0.1`. **If you were relying on LAN access directly to the gateway, traffic now goes through the reverse proxy.** Update your `ALLOWED_ORIGINS` and auth credentials accordingly.

## Upgrading from token auth (`GATEWAY_AUTH_TOKEN`)

The Phase 3 shared-secret token has been replaced by username/password. The gateway **refuses to start** while `GATEWAY_AUTH_TOKEN` is still set — it will not silently come up in open mode behind your proxy. Migrate by replacing it in your `.env`:

```bash
GATEWAY_AUTH_USER=<your-username>
GATEWAY_AUTH_PASSWORD_HASH='<output of: pnpm --filter @sparklab/terminal-gateway hash-password>'
```

Existing browser sessions are unaffected in principle (cookies are in-memory), but the restart that applies this change logs everyone out anyway — sign in once with the new credentials.
