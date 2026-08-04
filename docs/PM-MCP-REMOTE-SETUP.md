# PM MCP remote setup

This guide connects Claude Code and Codex on another machine to the PM artifact
API over the public HTTPS gateway. The MCP server itself remains a local stdio
process on the client machine; only its authenticated REST requests cross the
internet. Do not expose an additional MCP port.

## Prerequisites

- Node.js 18 or newer on the client machine.
- Claude Code and/or Codex installed on the client machine.
- The public gateway origin, currently `https://sparklab.ap.loclx.io`.
- The `GATEWAY_API_TOKEN` from `apps/terminal-gateway/.env` on the gateway host.

Never paste the token into chat, a command-line argument, or a tracked project
file. Store it in a mode-`600` file outside the checkout.

## 1. Retrieve the token on the gateway host

```bash
cd /home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal
nano apps/terminal-gateway/.env
```

Copy the value of `GATEWAY_API_TOKEN`. The legacy `KANBAN_API_TOKEN` is still
accepted, but new clients should use the preferred name. Transfer the value to
the client machine through a trusted secret channel.

## 2. Install the standalone MCP server on the client

```bash
mkdir -p ~/.local/lib/sparklab-pm-mcp ~/.local/bin ~/.config/sparklab

curl -fsSL \
  https://raw.githubusercontent.com/mgprogm/sparklab-terminal/main/tools/pm-mcp/server.mjs \
  -o ~/.local/lib/sparklab-pm-mcp/server.mjs

chmod 755 ~/.local/lib/sparklab-pm-mcp/server.mjs
node --check ~/.local/lib/sparklab-pm-mcp/server.mjs
node --version
```

The MCP server is dependency-free and requires Node.js 18 or newer.

## 3. Store the connection settings

```bash
install -m 600 /dev/null ~/.config/sparklab/pm-mcp.env
nano ~/.config/sparklab/pm-mcp.env
```

Enter the following, replacing the placeholder without committing this file:

```bash
GATEWAY_API_TOKEN='PASTE_TOKEN_HERE'
PM_BASE_URL='https://sparklab.ap.loclx.io'
```

Keep the permission restricted:

```bash
chmod 600 ~/.config/sparklab/pm-mcp.env
```

`PM_BASE_URL` is the origin only. Do not append `/api/pm`; the MCP server adds
that path itself.

## 4. Create a shared launcher

Create `~/.local/bin/sparklab-pm-mcp`:

```bash
#!/usr/bin/env bash
set -euo pipefail

set -a
source "$HOME/.config/sparklab/pm-mcp.env"
set +a

exec node "$HOME/.local/lib/sparklab-pm-mcp/server.mjs"
```

Then make it executable:

```bash
chmod 755 ~/.local/bin/sparklab-pm-mcp
```

Both clients use this launcher, keeping the secret out of their project
configuration.

## 5. Verify HTTPS authentication

```bash
set -a
source ~/.config/sparklab/pm-mcp.env
set +a

curl -fsS \
  -H "Authorization: Bearer $GATEWAY_API_TOKEN" \
  "$PM_BASE_URL/api/pm/projects"
```

A successful request returns the PM project-list JSON. HTTP `401` means the
token is absent or incorrect; connection or TLS errors indicate that the public
origin is unavailable or misconfigured.

## 6. Configure Claude Code for the project

From the target checkout:

```bash
cd /data/workspace/project-gendash-system/DatasciAndAI/src/project-gendash-system

claude mcp add --scope project pm -- \
  "$HOME/.local/bin/sparklab-pm-mcp"

claude mcp get pm
claude mcp list
```

Restart Claude Code, open `/mcp`, and confirm that `pm` is connected. A simple
functional check is: `List all PM projects.` The project-scoped `.mcp.json`
contains only the launcher path, not the bearer token.

## 7. Configure Codex for the project

Resolve the absolute launcher path first:

```bash
echo "$HOME/.local/bin/sparklab-pm-mcp"
```

Create `.codex/config.toml` in the target checkout and replace `YOUR_USER` with
the real account name. TOML does not expand `$HOME` in `command`.

```toml
[mcp_servers.pm]
command = "/home/YOUR_USER/.local/bin/sparklab-pm-mcp"
enabled = true
required = false
default_tools_approval_mode = "writes"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Verify and restart Codex:

```bash
codex mcp list
```

Open `/mcp` in the new session and confirm that `pm` is connected.

## Troubleshooting

- Launcher exits immediately: run `node --check` on `server.mjs` and confirm
  Node.js is at least version 18.
- `GATEWAY_API_TOKEN ... is not set`: confirm the env file path, spelling, and
  launcher `source` command.
- HTTP `401`: recopy `GATEWAY_API_TOKEN` from the gateway host without spaces or
  surrounding accidental characters.
- Connection failure: verify `PM_BASE_URL` and test its `/api/pm/projects`
  endpoint with `curl`.
- MCP is missing after configuration: restart the client and inspect `/mcp`,
  `claude mcp list`, or `codex mcp list`.
