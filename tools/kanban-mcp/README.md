# Kanban MCP server

A dependency-free [Model Context Protocol](https://modelcontextprotocol.io)
(stdio) server that exposes the gateway's `/api/kanban/*` board API as MCP
tools, so an MCP-capable client (Claude Code, Codex, …) gets Kanban tools
automatically instead of hand-writing `curl`.

It is a thin REST client: every call hits the gateway with the scoped
`KANBAN_API_TOKEN` bearer (never a cookie), so the gateway stays the single
enforcement point. No build step, no dependencies — plain Node ≥ 18.

## Tools

| Tool                  | REST                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kanban_list_boards`  | `GET /api/kanban/boards`                                                                                                                                        |
| `kanban_get_board`    | `GET /api/kanban/boards/:id`                                                                                                                                    |
| `kanban_create_board` | `POST /api/kanban/boards`                                                                                                                                       |
| `kanban_delete_board` | `DELETE /api/kanban/boards/:id`                                                                                                                                 |
| `kanban_add_card`     | `POST /api/kanban/boards/:id/cards`                                                                                                                             |
| `kanban_update_card`  | `PATCH /api/kanban/cards/:id`                                                                                                                                   |
| `kanban_move_card`    | `POST /api/kanban/cards/:id/move` — auto-fetches `rev` and retries once on a 409, so you never manage revisions; `to_index` defaults to the target column's end |

## Config (env)

| Var                | Required | Default                 |
| ------------------ | -------- | ----------------------- |
| `KANBAN_API_TOKEN` | yes      | —                       |
| `KANBAN_BASE_URL`  | no       | `http://127.0.0.1:3107` |

`KANBAN_API_TOKEN` must equal the gateway's `KANBAN_API_TOKEN`. Point
`KANBAN_BASE_URL` at the public origin (e.g. `https://sparklab.ap.loclx.io`)
when running the client off-box, or leave it at the loopback gateway on the
same host.

## Connect it

### Claude Code

```bash
claude mcp add kanban \
  -e KANBAN_API_TOKEN=<your-token> \
  -e KANBAN_BASE_URL=https://sparklab.ap.loclx.io \
  -- node /home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal/tools/kanban-mcp/server.mjs
```

Then in a Claude Code session: `/mcp` to confirm it's connected, and ask
e.g. _"list my kanban boards"_ / _"move card X to Done"_.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.kanban]
command = "node"
args = ["/home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal/tools/kanban-mcp/server.mjs"]
env = { KANBAN_API_TOKEN = "<your-token>", KANBAN_BASE_URL = "https://sparklab.ap.loclx.io" }
```

### Any MCP client

Run `node tools/kanban-mcp/server.mjs` as a stdio MCP server with the two env
vars set. It speaks newline-delimited JSON-RPC 2.0 (`initialize`, `tools/list`,
`tools/call`, `ping`).

## Notes

- Get the token: it's the `KANBAN_API_TOKEN` line in `apps/terminal-gateway/.env`.
- This server lives **outside** the pnpm workspace globs (`apps/*`, `packages/*`)
  on purpose, so it never enters turbo build/lint/typecheck.
- Protocol reference for the underlying REST: `docs/TERMINAL-PROTOCOL.md`
  → `/api/kanban/*`.
