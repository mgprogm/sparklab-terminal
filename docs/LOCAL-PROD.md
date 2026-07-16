# Running a local production build (with PM2)

This is a **manual** for building and running the web terminal in **production
mode on your own machine**, on ports that don't collide with `pnpm dev`. It is
the local counterpart to the VPS/Caddy guide in
[`DEPLOYMENT.md`](./DEPLOYMENT.md) — the same four services (gateway, agent,
terminal app, single-origin proxy) running as real production processes, without
Caddy or TLS.

Two ways to run are provided; both use the same ports and the same build:

- **PM2** (`ecosystem.config.cjs`) — recommended; survives your terminal
  closing, auto-restarts on crash, has log management. Required for tunnel use.
- **Plain script** (`run-prod-local.sh`) — foreground, `Ctrl+C` stops all
  services. Same-machine testing only (no proxy/tunnel).

---

## Port map

The local prod stack runs at a **+100 offset** from dev, so both can run at
once with zero conflict:

| Service             | Dev (`pnpm dev`) | Local prod |
| ------------------- | ---------------- | ---------- |
| Terminal app        | `3002`           | **`3100`** |
| Gateway             | `3007`           | **`3107`** |
| Agent service       | `3009`           | **`3109`** |
| Single-origin proxy | —                | **`3110`** |

The frontend also builds into a separate `.next-prod` directory so a prod build
never clobbers dev's `.next`.

### Single origin (why the proxy)

`prod-proxy.cjs` (port **3110**) fronts all three services on one origin:
`/attach` + `/api/*` → gateway, `/agent` → agent, everything else → terminal.
This is required so the `gw_session` cookie is **first-party** for the gateway
AND the agent — split them across separate hosts/ports and the agent's cookie
auth breaks (the host-only cookie never reaches the agent). **Open the proxy
(`:3110`), not the app (`:3100`) directly.**

## Switching local ↔ tunnel (the endpoint setting)

The public endpoint lives in the **root `.env`** (copy from `.env.example`).
Both `ecosystem.config.cjs` and `build-prod.sh` read it, so switching is one
line:

```bash
# .env
PUBLIC_ORIGIN=http://localhost:3110         # local, same machine only
# PUBLIC_ORIGIN=https://sparklab.ap.loclx.io # public loclx tunnel
TUNNEL_ENABLED=true                          # false → the prod-tunnel app is skipped
TUNNEL_SUBDOMAIN=sparklab
TUNNEL_REGION=ap
```

`PUBLIC_ORIGIN` is **baked into the frontend at build time** and added to the
gateway/agent allowlists. After editing `.env`:

```bash
./build-prod.sh                              # rebuild with the new PUBLIC_ORIGIN
pm2 restart ecosystem.config.cjs --update-env
```

The loclx tunnel points at the proxy (`:3110`) and serves the stack at
`https://<SUBDOMAIN>.<REGION>.loclx.io` (the region **is** part of the
hostname, e.g. `https://sparklab.ap.loclx.io`). A few loclx specifics:

- **Binary:** `/snap/bin/loclx` (installed via the snap package; the PM2 app
  invokes it directly with `interpreter: "none"`).
- **Auth:** run `loclx account login` once, or set `LOCLX_ACCESS_TOKEN` in the
  environment before starting PM2.
- **Subdomains must be alphanumeric** — hyphens are rejected by loclx with
  "TempSubdomain has invalid format".

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

The Next.js app **inlines the endpoint URL at build time** (`NEXT_PUBLIC_*`), so
it must be baked in. `build-prod.sh` reads `PUBLIC_ORIGIN` from the root `.env`
(see "Switching local ↔ tunnel" above) and builds with it:

```bash
./build-prod.sh
```

Re-run this **any time you change `PUBLIC_ORIGIN` or frontend code**. The
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
pm2 start ecosystem.config.cjs        # starts prod-gateway, prod-agent, prod-terminal, prod-proxy
                                       # (+ prod-tunnel when TUNNEL_ENABLED=true in .env)
pm2 list                              # see status (look for the prod-* rows)
pm2 logs prod-terminal                # tail one service's logs
pm2 logs                              # tail all
```

Everyday operations:

```bash
pm2 restart ecosystem.config.cjs      # after a rebuild or code change
pm2 restart prod-gateway              # restart just one
pm2 stop ecosystem.config.cjs         # stop all prod-* apps (stays registered)
pm2 delete ecosystem.config.cjs       # remove all prod-* apps from PM2 entirely
```

### Survive a reboot (optional)

```bash
pm2 save        # snapshot the current process list (includes ALL your pm2 apps)
pm2 startup     # prints a command to enable the PM2 systemd service; run it
```

`pm2 save` rewrites `~/.pm2/dump.pm2`, which holds **every** app PM2 knows about
(not just the prod-* apps). That's expected — only run it when you want the current
set to be the one restored on boot.

### What each PM2 app runs

| App             | Entry                                                 | Interpreter                  | Notes                                                  |
| --------------- | ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `prod-gateway`  | `apps/terminal-gateway/src/server.js`                 | `node --env-file-if-exists`  | plain JS                                               |
| `prod-agent`    | `apps/agent-service/src/index.ts`                     | `tsx --env-file-if-exists`   | runs TypeScript directly                               |
| `prod-terminal` | `apps/terminal/node_modules/next/dist/bin/next start` | `node`                       | **real Next JS entry**, not the `.bin/next` shell shim |
| `prod-proxy`    | `prod-proxy.cjs`                                      | `node`                       | single-origin proxy on `:3110`; zero npm dependencies  |
| `prod-tunnel`   | `/snap/bin/loclx tunnel http --to 127.0.0.1:3110 …`   | binary (`interpreter: none`) | only added when `TUNNEL_ENABLED=true` in `.env`        |

---

## Alternative — Run with the plain script

Foreground, no PM2. Builds then starts all three services; `Ctrl+C` stops everything:

```bash
./run-prod-local.sh              # build the app, then start all three
./run-prod-local.sh --no-build   # skip the build, just start
```

> **Note:** `run-prod-local.sh` predates the proxy. It bakes the individual service URLs
> (`:3107`, `:3109`) directly into the build and does **not** start `prod-proxy.cjs`, so it
> is suitable for same-machine testing only. For tunnel / public-URL use, **PM2 is required**
> (`build-prod.sh` + `pm2 start ecosystem.config.cjs`).

---

## Step 4 — Verify

**Always verify through the proxy (`:3110`), not the individual services directly.**
The proxy is the user-facing entry point; direct access to `:3100` won't have its origin
in the gateway's allowlist.

```bash
# ── Internal smoke checks (confirm each service started) ────────────────────
curl -s -o /dev/null -w "terminal  %{http_code}\n" http://localhost:3100/
curl -s -o /dev/null -w "agent     %{http_code}\n" http://localhost:3109/
curl -s -o /dev/null -w "gateway   %{http_code}\n" http://localhost:3107/api/sessions \
  -H "Origin: http://localhost:3110"

# ── Proxy / public-origin checks ────────────────────────────────────────────
# Proxy serves the terminal app
curl -s -o /dev/null -w "proxy/app %{http_code}\n" http://localhost:3110/

# Gateway reachable through the proxy (401 = auth is ON and working)
curl -s -o /dev/null -w "proxy/gw  %{http_code}\n" http://localhost:3110/api/sessions

# Full login round-trip through the proxy (expect 204, then 200)
curl -s -w " login    %{http_code}\n" -X POST http://localhost:3110/api/auth/login \
  -H "Content-Type: application/json" \
  -c /tmp/gw-cookie.txt \
  -d '{"username":"admin","password":"<your-password>"}'
curl -s -o /dev/null -w " authed   %{http_code}\n" http://localhost:3110/api/sessions \
  -b /tmp/gw-cookie.txt
```

Then open **http://localhost:3110** (not `:3100`) and log in.

When using the loclx tunnel, replace `http://localhost:3110` with
`https://<subdomain>.<region>.loclx.io` in the curl commands and in the browser.

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

**Browser can't load `http://localhost:3110` but `curl` returns `200`.**
The proxy is fine — this is client-side. Check: you're on the **same machine**
(all services bind `127.0.0.1`; auth cookies are origin-scoped to `localhost`);
no VPN is intercepting `localhost`; try opening `127.0.0.1:3110`; hard-refresh
to clear a stale service worker/cache.

**Login works via `curl` but not in the browser (401 loop).**
The browser's `Origin` must be in the gateway's `ALLOWED_ORIGINS`. The PM2
ecosystem derives this from `PUBLIC_ORIGIN` (root `.env`) and always adds
`http://localhost:3110`. So you must open the stack at `:3110` (or your tunnel
URL), not `:3100` directly. If you need to add another origin, edit
`PUBLIC_ORIGIN` in `.env` and re-run `./build-prod.sh && pm2 restart ecosystem.config.cjs --update-env`.

**Port already in use (`EADDRINUSE`).**
Something's still bound. Find and free it:

```bash
ss -ltnp | grep -E ':(3100|3107|3109|3110)'
fuser -k 3110/tcp   # proxy — most likely the entry point; do gateway/agent/terminal too
```

Often it's a leftover from `run-prod-local.sh`; if you switched to PM2, make
sure the script isn't also running.

**Changed frontend code but the browser shows the old app.**
`next start` serves the prebuilt `.next-prod`. Rebuild (Step 1), then
`pm2 restart prod-terminal`.

---

## Relationship to real production

This runs the same four processes as production (gateway, agent, terminal, proxy)
but **omits Caddy/TLS and binds loopback ports directly**. `prod-proxy.cjs` is
the zero-dependency local analogue of Caddy — it applies the same single-origin
routing (same path rules: `/attach`+`/api/*` → gateway, `/agent` → agent,
everything else → terminal) for the same reason: the `gw_session` cookie must be
first-party for both the gateway and the agent.

For an internet-facing deployment — reverse proxy, HTTPS, systemd units, hardened
auth — follow [`DEPLOYMENT.md`](./DEPLOYMENT.md). The security model there
(loopback binds, origin allowlist, scrypt auth) is the authority; this doc is for
local testing only.
