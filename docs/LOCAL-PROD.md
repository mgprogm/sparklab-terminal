# Running a local production build (with PM2)

This is a **manual** for building and running the web terminal in **production
mode on your own machine**, on ports that don't collide with `pnpm dev`. It is
the local counterpart to the VPS/Caddy guide in
[`DEPLOYMENT.md`](./DEPLOYMENT.md) — no reverse proxy, no TLS, just the three
services running as real production processes for testing a prod build.

Two ways to run are provided; both use the same ports and the same build:

- **PM2** (`ecosystem.config.cjs`) — recommended; survives your terminal
  closing, auto-restarts on crash, has log management.
- **Plain script** (`run-prod-local.sh`) — foreground, `Ctrl+C` stops all
  three. Good for a quick one-off.

---

## Port map

The local prod stack runs at a **+100 offset** from dev, so both can run at
once with zero conflict:

| Service       | Dev (`pnpm dev`) | Local prod |
| ------------- | ---------------- | ---------- |
| Terminal app  | `3002`           | **`3100`** |
| Gateway       | `3007`           | **`3107`** |
| Agent service | `3009`           | **`3109`** |

The frontend also builds into a separate `.next-prod` directory so a prod build
never clobbers dev's `.next`.

To change the ports, edit the constants at the top of **both**
`ecosystem.config.cjs` and `run-prod-local.sh`, then rebuild (the gateway/agent
URLs are inlined into the app at build time — see below).

---

## Prerequisites

```bash
node -v      # >= 24
pnpm -v      # workspace package manager
tmux -V      # the gateway attaches tmux; jobs live here
pm2 -v       # process manager (npm i -g pm2 if missing)
```

`pnpm install` must have been run at least once in the repo.

---

## Step 1 — Build the frontend

The Next.js app **inlines the gateway and agent URLs at build time**
(`NEXT_PUBLIC_*`), so they must be set on the build command. Point them at the
local prod ports:

```bash
NEXT_DIST_DIR=.next-prod \
NEXT_PUBLIC_GATEWAY_URL=http://localhost:3107 \
NEXT_PUBLIC_AGENT_URL=http://localhost:3109 \
  pnpm --filter @sparklab/terminal build
```

Re-run this **any time you change frontend code or the prod ports**. The
gateway (plain JS) and agent service (`tsx`) have no build step.

---

## Step 2 — Configure secrets / auth

Ports and origins are set by the launcher (PM2 or the script). Everything else —
**auth credentials and the Azure key** — still comes from each package's
gitignored `.env`, which the start commands load via `--env-file-if-exists=.env`:

- `apps/terminal-gateway/.env` — `GATEWAY_AUTH_USER` + password
- `apps/agent-service/.env` — `AZURE_OPENAI_*`, `GPT56SOL_DEPLOYMENT`, gateway creds

Node/tsx give **shell env precedence over the `.env` file**, which is exactly
how the launcher overrides `PORT`/`ALLOWED_ORIGINS`/etc. without touching your
`.env` files.

> **Production-faithful auth (optional).** For local testing the plaintext
> `GATEWAY_AUTH_PASSWORD` in `.env` is fine. For a prod-faithful run, replace it
> with a hash and delete the plaintext:
>
> ```bash
> pnpm --filter @sparklab/terminal-gateway hash-password
> # → GATEWAY_AUTH_PASSWORD_HASH='scrypt$...'   (paste into apps/terminal-gateway/.env)
> ```

---

## Step 3 — Run with PM2 (recommended)

```bash
pm2 start ecosystem.config.cjs        # start prod-gateway, prod-agent, prod-terminal
pm2 list                              # see status (look for the three prod-* rows)
pm2 logs prod-terminal                # tail one service's logs
pm2 logs                              # tail all
```

Everyday operations:

```bash
pm2 restart ecosystem.config.cjs      # after a rebuild or code change
pm2 restart prod-gateway              # restart just one
pm2 stop ecosystem.config.cjs         # stop all three (stays registered)
pm2 delete ecosystem.config.cjs       # remove the three from PM2 entirely
```

### Survive a reboot (optional)

```bash
pm2 save        # snapshot the current process list (includes ALL your pm2 apps)
pm2 startup     # prints a command to enable the PM2 systemd service; run it
```

`pm2 save` rewrites `~/.pm2/dump.pm2`, which holds **every** app PM2 knows about
(not just these three). That's expected — only run it when you want the current
set to be the one restored on boot.

### What each PM2 app runs

| App             | Entry                                                 | Interpreter                 | Notes                                                  |
| --------------- | ----------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `prod-gateway`  | `apps/terminal-gateway/src/server.js`                 | `node --env-file-if-exists` | plain JS                                               |
| `prod-agent`    | `apps/agent-service/src/index.ts`                     | `tsx --env-file-if-exists`  | runs TypeScript directly                               |
| `prod-terminal` | `apps/terminal/node_modules/next/dist/bin/next start` | `node`                      | **real Next JS entry**, not the `.bin/next` shell shim |

---

## Alternative — Run with the plain script

Foreground, no PM2. Builds then starts all three; `Ctrl+C` stops everything:

```bash
./run-prod-local.sh              # build the app, then start all three
./run-prod-local.sh --no-build   # skip the build, just start
```

---

## Step 4 — Verify

```bash
# App serves HTML
curl -s -o /dev/null -w "app     %{http_code}\n" http://localhost:3100/

# Agent WS server is up
curl -s -o /dev/null -w "agent   %{http_code}\n" http://localhost:3109/

# Gateway rejects unauthenticated (401 = auth is ON and working)
curl -s -o /dev/null -w "gateway %{http_code}\n" http://localhost:3107/api/sessions \
  -H "Origin: http://localhost:3100"

# Full login round-trip (expect 204, then 200)
curl -s -w " login   %{http_code}\n" -X POST http://localhost:3107/api/auth/login \
  -H "Origin: http://localhost:3100" -H "Content-Type: application/json" \
  -c /tmp/gw-cookie.txt \
  -d '{"username":"admin","password":"<your-password>"}'
curl -s -o /dev/null -w " authed  %{http_code}\n" http://localhost:3107/api/sessions \
  -H "Origin: http://localhost:3100" -b /tmp/gw-cookie.txt
```

Then open **http://localhost:3100** and log in.

---

## Troubleshooting

**`pm2 logs` shows a `SyntaxError: missing ) after argument list` pointing at
`node_modules/.bin/next`.**
Node was told to execute the pnpm **shell shim** as JavaScript. The fix is
already in `ecosystem.config.cjs` — `prod-terminal` runs
`node_modules/next/dist/bin/next` (the real JS entry). If you still see this,
you're looking at a **stale log line** from a previously crashed process; the
error log file is shared across restarts. Confirm the live state with
`pm2 list` (status `online`, restarts `0`) and `curl http://localhost:3100/`.

**Browser can't load `http://localhost:3100` but `curl` returns `200`.**
The server is fine — this is client-side. Check: you're on the **same machine**
(the app binds `*:3100` but auth cookies are origin-scoped to `localhost`); no
proxy/VPN is intercepting `localhost`; try `127.0.0.1:3100`; hard-refresh to
clear a stale service worker/cache.

**Login works via `curl` but not in the browser (401 loop).**
The browser's `Origin` must be in the gateway's `ALLOWED_ORIGINS`. The launcher
sets it to `http://localhost:3100` — so use exactly that origin, not
`127.0.0.1:3100` or a LAN IP. To allow another origin, add it in
`ecosystem.config.cjs` (`prod-gateway` → `env.ALLOWED_ORIGINS`) and
`pm2 restart prod-gateway`.

**Port already in use (`EADDRINUSE`).**
Something's still bound. Find and free it:

```bash
ss -ltnp | grep -E ':310[079]'
fuser -k 3100/tcp   # etc.
```

Often it's a leftover from `run-prod-local.sh`; if you switched to PM2, make
sure the script isn't also running.

**Changed frontend code but the browser shows the old app.**
`next start` serves the prebuilt `.next-prod`. Rebuild (Step 1), then
`pm2 restart prod-terminal`.

---

## Relationship to real production

This runs the same three processes as production but **omits Caddy/TLS and binds
loopback ports directly**. For an internet-facing deployment — reverse proxy,
HTTPS, systemd units, hardened auth — follow [`DEPLOYMENT.md`](./DEPLOYMENT.md).
The security model there (loopback binds, origin allowlist, scrypt auth) is the
authority; this doc is for local testing only.

```

```
