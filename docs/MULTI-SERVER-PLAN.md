# Multi-server plan: "Connected Servers"

> **Status: IMPLEMENTED — MVP shipped 2026-07-15.** The MVP section below
> (Option C: SSH + remote tmux, server registry, qualified session ids, sidebar
> grouping, add-server dialog, Servers settings tab, password auth opt-in) is
> done and tests pass (`acceptance:remote`, `test:servers-password`). The
> implementation spec is `docs/multi-server-impl-spec.md` (code-validated,
> frozen). "Later" items — agent `server` arg, key-gen UI, Option B
> hub-and-spoke — remain out of scope. This file is kept as the decision
> record; `docs/multi-server-impl-spec.md` is the authoritative wire/code
> contract.

## Problem

Today the whole system is single-server: the browser talks to exactly one
gateway (`NEXT_PUBLIC_GATEWAY_URL`, a build-time constant), and that gateway
only talks to the **local** tmux server on its own host. You can have many
sessions, but they are all shells on the one machine where the gateway runs.
The only way to reach another server is to `ssh` manually from inside a
session.

The goal: an **"Add server"** feature — register any number of servers, see
their sessions grouped in the sidebar, and create a session on any of them —
without weakening the core guarantee that **jobs survive the browser, the
network, and the gateway**.

## The key decision: how does a remote server join?

Three realistic options were considered:

| Option                                      | How it works                                                                  | Cost on each remote server                                     | Job survival                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| **A. Gateway-per-server, browser fans out** | Each server runs its own gateway; the frontend holds N gateway URLs           | Node + gateway install, public exposure, TLS, auth each        | ✅ per host                        |
| **B. Hub-and-spoke proxy**                  | Remote gateways register with the main gateway, which proxies REST/WS to them | Node + gateway install (only the hub is exposed)               | ✅ per host                        |
| **C. SSH + remote tmux** ← **chosen**       | The one existing gateway runs tmux commands on remotes over SSH               | **Nothing** — just `sshd` + `tmux`, which servers already have | ✅ tmux on the remote owns the job |

**Option C wins** because it is the smallest change that preserves every
load-bearing invariant, and "add server" becomes as cheap as adding an SSH
host: no agent to deploy, update, patch, or expose on each machine. Option B
remains the documented fallback for servers where SSH from the gateway host is
not allowed — it can be added later behind the same registry
(`"type": "gateway"`) without reworking the frontend.

## How Option C works

The gateway does exactly two kinds of tmux work today, and both translate 1:1
to SSH:

```
Control:  tmux has-session / ls / new-session / kill-session / capture-pane / send-keys
   →      ssh <host> tmux ...                       (short-lived exec)

Attach:   node-pty spawns: tmux attach-session -t web-<id>
   →      node-pty spawns: ssh -t <host> tmux attach-session -t web-<id>
```

A single `exec(server, cmd)` seam either prefixes `ssh <host>` or doesn't; the
local machine is just a pre-registered default server (`id: "local"`,
`type: "local"`) that skips ssh.

### Why the invariants hold

- **tmux on the remote host stays the source of truth.** A restarted gateway
  rediscovers sessions by running `tmux ls` over SSH on each registered
  server — the same "no database" principle, applied per host.
- **Job survival gets _stronger_, not weaker.** The shell and its jobs live
  inside remote tmux, so even if the gateway host or the network between them
  dies, the job keeps running. Closing the tab still kills only the local pty
  (which drops the ssh client, which detaches the tmux client — never the
  session). The **one `kill-session` call site** stays in the gateway.
- **Raw bytes end to end still holds.** `ssh -t` is a transparent byte pipe;
  node-pty is still spawned with `encoding: null`, WS frames stay binary,
  nothing in the browser pipeline changes.
- **The attach redraw remains the single painter.** tmux's attach-time redraw
  arrives through ssh exactly as it does locally; scrollback still comes from
  the REST `capture-pane` endpoint (now executed over ssh).

## Server registry

Sessions need no new persistence (tmux per host is truth), but the server
registry is **config, not state**, so it gets a home: a gitignored
`servers.json` next to the gateway `.env`:

```json
{
  "servers": [
    { "id": "local", "name": "This machine", "type": "local" },
    {
      "id": "build01",
      "name": "Build server",
      "type": "ssh",
      "host": "10.0.0.12",
      "user": "deploy",
      "port": 22,
      "identityFile": "~/.ssh/gateway_ed25519"
    }
  ]
}
```

SSH auth is **key-based by default** — the original design stored no passwords.
Host keys are handled with `StrictHostKeyChecking=accept-new` (or a pinned
`known_hosts`). The trust model is deliberate: the gateway host's public key is
what you authorize on each server, so there is exactly one credential to rotate
and the browser never holds server credentials.

**Departure added at implementation:** per-server **password auth** was added
as an opt-in for hosts that only accept password login. The password is stored
plaintext in the gitignored `servers.json` and is never sent to the browser
(`GET /api/servers` returns only `authMethod: "key"|"password"`). The
mechanism uses OpenSSH's askpass protocol (`SSH_ASKPASS` +
`SSH_ASKPASS_REQUIRE=force`, OpenSSH ≥ 8.4) — not `sshpass` — so it works
non-interactively on both the control exec path and the WS-attach pty path.
See `docs/multi-server-impl-spec.md` §Password auth for full details.

## API changes (gateway)

- `GET /api/servers` — registry entries + live reachability
  (`ok | unreachable`, probed with a cached `ssh <host> true`).
- `POST /api/servers`, `DELETE /api/servers/:id` — manage the registry
  (behind the existing cookie auth, like all session CRUD).
- `POST /api/sessions` gains an optional `serverId` (default `"local"`).
- **Session identity becomes `serverId` + name.** The tmux name stays
  `web-<uuid>`; REST and WS reference the qualified id
  `<serverId>/web-<uuid>` (or a `?server=` param on `/attach`). Existing
  single-server clients keep working via the implicit `local`.
- `/screen`, `/keys`, and `/scrollback` work unchanged in spirit —
  `capture-pane` and `send-keys` simply run over the SSH exec path — so **the
  Agent Chat gets multi-server for free**: `list_sessions` grows a `server`
  field, `create_session` grows a `server` argument, and the approval card
  must show **which machine** the agent is about to type into (a safety
  requirement, not a nicety).

## Frontend

- **Sidebar grouped by server**: a small server header row (name + status dot
  reusing the existing badge colors) above its sessions, with "New session"
  per group.
- **"Add server" dialog** reachable from the sidebar, plus a new **Servers
  tab in the settings dialog** (`?settings=servers` — fits the existing
  tabbed, deep-linkable structure): name, host, user, port, key path, and a
  "Test connection" button that round-trips `ssh true`.
- **Deep link**: `?session=<serverId>/<id>` — the existing
  `use-session-url-sync.ts` pattern extends naturally.
- **Unreachable ≠ dead.** If a server drops off the network, its sessions
  render greyed with an "unreachable" badge — never pruned. This is critical:
  `session-fallback.ts` / `pruneToExisting()` currently assume "not in
  `tmux ls`" means gone. With remotes, "**couldn't ask**" must be
  distinguished from "**asked, and it's gone**", or a flaky link would wipe
  the session list.

## Failure modes to design in from day one

1. **SSH exec latency.** Control commands go from ~5 ms to ~50–200 ms. Use
   SSH connection multiplexing (`ControlMaster` / `ControlPersist`, one
   control socket per server) so every exec and attach reuses a single
   TCP + auth handshake. This is the difference between the UI feeling local
   and feeling remote.
2. **Partial `tmux ls` failures** during rediscovery and status polling:
   per-server error isolation — one dead host must never make the whole
   session list fail.
3. **Attach retry.** `ssh -t ... attach` fails slower and in more ways than a
   local attach (DNS, auth, host down). The reconnect loop in
   `connection.ts` already handles the shape; the gateway just needs to
   surface a distinguishable `exit` reason so the client can show _why_.

## Phasing

**MVP**

- `servers.json` registry + the `exec()` seam in the gateway.
- `serverId` on create / attach / list; qualified session ids.
- Sidebar grouping + add-server dialog + Servers settings tab.
- Acceptance script: **"job on a remote keeps counting while the gateway is
  restarted"** — provable without a real second machine by running a second
  tmux server on a separate socket (`tmux -L`) reached via localhost ssh.

**Later**

- Agent `server` argument + approval-card server display.
- Unreachable-badge polish; per-server default shell / cwd.
- Key-generation helper in the UI.
- Option B (`"type": "gateway"` hub-and-spoke) if a no-SSH environment ever
  demands it.
