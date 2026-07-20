# Running Sparklab Terminal in Docker

Docker is an **additional** way to run the stack — it does not replace the native
paths (`pnpm dev`, `run-prod-local.sh`, PM2 via `ecosystem.config.cjs`). Deploy
either way. This image is suitable for **both quick testing and real deployment**.

## What's in the image

One **all-in-one container** runs the whole stack, supervised by pm2:

| Process         | Port (internal) | Role                                              |
| --------------- | --------------- | ------------------------------------------------- |
| `prod-gateway`  | 3107 (loopback) | REST + `/attach` WS, owns tmux                     |
| `prod-agent`    | 3109 (loopback) | Agent Chat loop (Azure OpenAI) — **only started when Azure is configured** |
| `prod-terminal` | 3100 (loopback) | Next.js frontend (`next start`)                   |
| `prod-proxy`    | **3110** (0.0.0.0) | Single-origin reverse proxy — the only exposed port |

Everything is served from **one origin** (`:3110`) so the `gw_session` cookie
stays first-party across the gateway and the agent — exactly like the native
local-prod stack.

### Why all-in-one + pm2 (the tmux invariant)

The project's defining property is that **jobs survive a gateway restart**. That
works because the gateway only _attaches_ to tmux — tmux is a separate process
tree. In this image, pm2 supervises the Node processes and can restart the
gateway **without killing tmux**, so the invariant holds _inside_ the container.

**The honest limitation:** restarting the **whole container** starts fresh — tmux
dies with it, so running jobs are lost. Persistent state (session metadata,
server registry, push subscriptions/settings, agent chat history) lives on the
`/data` volume and _does_ survive; live tmux sessions do not. This is inherent to
containerizing a tmux-owns-the-process design and is an accepted trade-off. For
maximum job durability across host reboots, use the native install.

### What's deliberately NOT included

The **virtual browser** (Browser Use / `uv` + Playwright Chromium) is not bundled
— it would add hundreds of MB and system libraries. `BROWSER_USE_PROJECT` is
unset, so the browser tools stay disabled; the rest of Agent Chat works normally.

## Quick start

```bash
cp .env.docker.example .env.docker
# edit .env.docker — at minimum set GATEWAY_AUTH_USER / GATEWAY_AUTH_PASSWORD
docker compose up -d --build
open http://localhost:3110          # login: admin / (your password)
```

Stop / logs / rebuild:

```bash
docker compose logs -f
docker compose down                 # keeps the /data volume
docker compose up -d --build        # rebuild after code or PUBLIC_ORIGIN change
```

## Configuration

All config is env (`.env.docker`, loaded by `docker-compose.yml`). See
`.env.docker.example` for the annotated list. The essentials:

| Variable                     | Required | Notes                                                        |
| ---------------------------- | -------- | ----------------------------------------------------------- |
| `PUBLIC_ORIGIN`              | yes      | The origin the browser loads from. **Baked at build time** — change it and rebuild. |
| `HOST_PORT`                  | no       | Host port mapped to the proxy (default `3110`).             |
| `GATEWAY_AUTH_USER`          | yes      | Login user.                                                 |
| `GATEWAY_AUTH_PASSWORD`      | yes\*    | Plaintext (hashed at boot). \*Or `GATEWAY_AUTH_PASSWORD_HASH`. |
| `GATEWAY_AUTH_PASSWORD_HASH` | prod     | scrypt hash (`pnpm --filter @sparklab/terminal-gateway hash-password`). |
| `TRUST_PROXY`                | TLS      | Set `1` only behind an external https reverse proxy.        |
| `AZURE_OPENAI_*`, `GPT56SOL_DEPLOYMENT` | Agent | Needed only for Agent Chat.                    |
| `VAPID_*`                    | Push     | Needed only for "job finished" push.                       |

### `PUBLIC_ORIGIN` is baked at build time

The Next.js frontend inlines its gateway/agent target (`NEXT_PUBLIC_*`) at build
time. `docker-compose.yml` passes `PUBLIC_ORIGIN` as **both** a build arg and a
runtime env, so changing it requires a rebuild:

```bash
PUBLIC_ORIGIN=https://terminal.example.com docker compose up -d --build
```

This is the same limitation as the native production build — not Docker-specific.

## Deploying behind TLS (production)

Terminate TLS at an external reverse proxy (Caddy/nginx/ingress) and forward to
the container's published port. Minimal Caddy:

```caddyfile
terminal.example.com {
    reverse_proxy localhost:3110
}
```

Then set in `.env.docker`:

```bash
PUBLIC_ORIGIN=https://terminal.example.com
TRUST_PROXY=1
```

and rebuild. `TRUST_PROXY=1` marks the session cookie `Secure` and honors
`X-Forwarded-*`. `deploy/Caddyfile` in this repo is a fuller example.

## Persistent state (the `/data` volume)

The named volume `sparklab-data` is mounted at `/data` and holds all mutable
state, redirected there via env overrides plus one symlink (`entrypoint.sh`):

| File / dir                    | Contents                                   |
| ----------------------------- | ------------------------------------------ |
| `/data/gateway/sessions.json` | Session names / org / project / mute       |
| `/data/servers.json`          | Connected-servers registry (SSH)           |
| `/data/push-subscriptions.json` | Web Push device endpoints                |
| `/data/push-settings.json`    | Push duration threshold / job-start toggle |
| `/data/agent-history/`        | Per-chat JSONL history                     |

`docker compose down` keeps this volume; `docker compose down -v` deletes it.

## Multi-server (SSH) from the container

Connecting to remote servers works — the image includes `openssh-client`. Note
that SSH keys/known_hosts live inside the container. To use key auth, bind-mount
your key material read-only, e.g. add to the `sparklab` service:

```yaml
volumes:
  - sparklab-data:/data
  - ~/.ssh:/root/.ssh:ro
```

Password auth (per-server, stored in `servers.json`) needs no key mount.

## Testing in the container

The gateway's smoke/acceptance tests need a real tmux, which the image has. Run
them against the built image:

```bash
docker compose exec sparklab \
  sh -lc 'cd /app && node_modules/.bin/pnpm --filter @sparklab/terminal-gateway smoke'
```

(`pnpm` is available via corepack inside the image; tmux is on `PATH`.)

## Troubleshooting

- **Login fails / logged out immediately** — `PUBLIC_ORIGIN` must exactly match
  the URL in the browser (scheme + host + port). Over https you must also set
  `TRUST_PROXY=1`. Rebuild after changing `PUBLIC_ORIGIN`.
- **`502 Bad gateway`** — a backend process is still starting or crashed; check
  `docker compose logs -f` (pm2 prints each app's output).
- **Jobs disappeared after `docker compose down/up`** — expected: the container
  restarted, so tmux restarted. Only `/data` state persists. See the invariant
  note above.
- **node-pty errors on an ARM/x86 mismatch** — the image compiles node-pty for
  its own platform; build on (or for) the target arch (`docker build --platform`).
