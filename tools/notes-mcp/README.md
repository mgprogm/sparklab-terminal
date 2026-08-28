# Notes MCP server

A dependency-free [Model Context Protocol](https://modelcontextprotocol.io)
(stdio) server that exposes the gateway's `/api/notes/*` OneNote-style note
tool (notebooks → sections → pages, Markdown bodies) as MCP tools, so an
MCP-capable client (Claude Code, Codex, …) gets Notes tools automatically
instead of hand-writing `curl`. A near-copy of `tools/kanban-mcp/`.

It is a thin REST client: every call hits the gateway with a scoped bearer
token (never a cookie), so the gateway stays the single enforcement point. No
build step, no dependencies — plain Node ≥ 18.

## Tools

| Tool                    | REST                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notes_list`            | `GET /api/notes/notebooks`                                                                                                                                                           |
| `notes_get_notebook`    | `GET /api/notes/notebooks/:id`                                                                                                                                                       |
| `notes_get_page`        | `GET /api/notes/notebooks/:id/pages/:pageId`                                                                                                                                         |
| `notes_search`          | `GET /api/notes/search?q=&limit=`                                                                                                                                                    |
| `notes_create_notebook` | `POST /api/notes/notebooks` — seeds one section "Notes" + one "Untitled page"                                                                                                        |
| `notes_delete_notebook` | `DELETE /api/notes/notebooks/:id` (irreversible)                                                                                                                                     |
| `notes_create_section`  | `POST /api/notes/notebooks/:id/sections`                                                                                                                                             |
| `notes_delete_section`  | `DELETE /api/notes/sections/:id` — `mode` "block" (default, 422 if non-empty) \| "cascade"                                                                                           |
| `notes_create_page`     | `POST /api/notes/notebooks/:id/pages` — `section_id` for top-level, or `parent_id` for a subpage                                                                                     |
| `notes_append_to_page`  | `POST /api/notes/pages/:id/append` — additive, no revision to manage                                                                                                                 |
| `notes_move_page`       | `POST /api/notes/pages/:id/move` — auto-fetches the notebook `rev` and retries once on a 409                                                                                         |
| `notes_update_page`     | `PATCH /api/notes/pages/:id` — blind title/body/tags replace; auto-fetches `rev` but **never retries** a 409 (surfaced as an error so a concurrent edit is never silently discarded) |
| `notes_delete_page`     | `DELETE /api/notes/pages/:id` — `mode` "orphan" (default, promotes children) \| "cascade"                                                                                            |

`notes_move_page` and `notes_update_page` both look up the current revision
themselves so the caller never has to track it — but they diverge on what
happens next on a conflict: a move is a re-derived splice, so replaying it
once against the fresh revision is safe; a body/title replace is a blind
overwrite, so a stale write is surfaced as an error instead of silently
discarding whatever the other writer just saved
(`docs/NOTES-TOOL-PLAN.md` D4).

## Config (env)

| Var                 | Required | Default                 |
| ------------------- | -------- | ----------------------- |
| `NOTES_API_TOKEN`   | no\*     | —                       |
| `GATEWAY_API_TOKEN` | no\*     | —                       |
| `NOTES_BASE_URL`    | no       | `http://127.0.0.1:3107` |

\* One of `NOTES_API_TOKEN` or `GATEWAY_API_TOKEN` must be set — `NOTES_API_TOKEN`
is checked first, then `GATEWAY_API_TOKEN` as a fallback. Either value must equal
the gateway's own `GATEWAY_API_TOKEN` (the shared artifact bearer that already
authorizes `/api/kanban/*` and `/api/pm/*` — no new token is needed for Notes).
Point `NOTES_BASE_URL` at the public origin (e.g. `https://sparklab.ap.loclx.io`)
when running the client off-box, or leave it at the loopback gateway on the
same host.

## Connect it

### Claude Code

```bash
claude mcp add notes \
  -e NOTES_API_TOKEN=<your-token> \
  -e NOTES_BASE_URL=https://sparklab.ap.loclx.io \
  -- node /home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal/tools/notes-mcp/server.mjs
```

Then in a Claude Code session: `/mcp` to confirm it's connected, and ask
e.g. _"list my notebooks"_ / _"create a page called Kickoff in my Engineering notebook"_.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.notes]
command = "node"
args = ["/home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal/tools/notes-mcp/server.mjs"]
env = { NOTES_API_TOKEN = "<your-token>", NOTES_BASE_URL = "https://sparklab.ap.loclx.io" }
```

### Any MCP client

Run `node tools/notes-mcp/server.mjs` as a stdio MCP server with the env vars
set. It speaks newline-delimited JSON-RPC 2.0 (`initialize`, `tools/list`,
`tools/call`, `ping`).

## Notes

- Get the token: it's the `GATEWAY_API_TOKEN` line in `apps/terminal-gateway/.env`
  (the same value already used for Kanban/PM's `KANBAN_API_TOKEN` fallback).
- This server lives **outside** the pnpm workspace globs (`apps/*`, `packages/*`)
  on purpose, so it never enters turbo build/lint/typecheck.
- Protocol reference for the underlying REST: `docs/TERMINAL-PROTOCOL.md`
  → `/api/notes/*`.
