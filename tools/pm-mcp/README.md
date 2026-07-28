# PM (Project-Management) MCP server

A dependency-free [Model Context Protocol](https://modelcontextprotocol.io)
(stdio) server that exposes the gateway's `/api/pm/*` project API as MCP tools,
so an MCP-capable client (Claude Code, Codex, …) gets project-management tools
automatically instead of hand-writing `curl`.

It is a thin REST client: every call hits the gateway with the scoped API token
bearer (never a cookie), so the gateway stays the single enforcement point.
No build step, no dependencies — plain Node ≥ 18.

## Tools

19 tools total — the original 8, plus 11 added for the workflow/issue-model/
collaboration enhancements (design: [`PM-ARTIFACT-ENHANCEMENTS-PLAN.md`](../../docs/PM-ARTIFACT-ENHANCEMENTS-PLAN.md)).
There is deliberately **no** task-delete, attachment-upload, or notification
tool — those stay human-only in the artifact UI.

### Projects & tasks

| Tool                | REST                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm_list_projects`  | `GET /api/pm/projects`                                                                                                                                                                                                           |
| `pm_get_project`    | `GET /api/pm/projects/:id`                                                                                                                                                                                                       |
| `pm_get_tree`       | `GET /api/pm/projects/:id/tree` — derived Epic→Story→Subtask forest                                                                                                                                                              |
| `pm_create_project` | `POST /api/pm/projects` (optional explicit `key`; else derived-unique from `name`)                                                                                                                                               |
| `pm_delete_project` | `DELETE /api/pm/projects/:id`                                                                                                                                                                                                    |
| `pm_add_task`       | `POST /api/pm/projects/:id/tasks`                                                                                                                                                                                                |
| `pm_update_task`    | `PATCH /api/pm/tasks/:id`                                                                                                                                                                                                        |
| `pm_move_task`      | `POST /api/pm/tasks/:id/move` — auto-fetches `rev` and retries **once, only on 409 stale**; a **422** (`wip_exceeded`/`transition_forbidden`) is a hard rejection, never retried; `to_index` defaults to the target column's end |
| `pm_add_sprint`     | `POST /api/pm/projects/:id/sprints`                                                                                                                                                                                              |

### Columns / workflow

| Tool               | REST                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `pm_add_column`    | `POST /api/pm/projects/:id/columns` — optional `index`, `wip_limit`, `transitions`                                  |
| `pm_update_column` | `PATCH /api/pm/columns/:colId` — `name`/`wip_limit`/`transitions` (last-writer-wins)                                |
| `pm_move_column`   | `POST /api/pm/columns/:colId/move` — reorder; same rev/409-retry-once handling as `pm_move_task`                    |
| `pm_delete_column` | `DELETE /api/pm/columns/:colId` — `mode="block"` (default, rejects non-empty) or `mode="relocate"` + `to_column_id` |

### Collaboration

| Tool                  | REST                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `pm_add_comment`      | `POST /api/pm/tasks/:id/comments`                                    |
| `pm_list_comments`    | `GET /api/pm/tasks/:id/comments` (oldest first)                      |
| `pm_list_activity`    | `GET /api/pm/projects/:id/activity` (newest first; `limit`/`before`) |
| `pm_watch_task`       | `POST /api/pm/tasks/:id/watch` (idempotent)                          |
| `pm_unwatch_task`     | `POST /api/pm/tasks/:id/unwatch` (idempotent)                        |
| `pm_list_attachments` | `GET /api/pm/tasks/:id/attachments` — metadata only, no upload tool  |

### Task fields

`pm_add_task` / `pm_update_task` accept the same optional fields (snake_case;
mapped to the REST camelCase body): `description`, `type`
(`epic`\|`story`\|`task`\|`bug`\|`subtask`, default `task`), `parent_id`
(hierarchy — Epic has no parent; Story/Task/Bug may parent under an Epic or be
root; Subtask **requires** a parent that is a Story/Task/Bug), `assignee`,
`priority` (`low`\|`medium`\|`high`\|`urgent`), `labels[]`, `start_date`,
`due_date`, `sprint_id`, `column_id`, `depends_on[]`. Dates are **epoch
milliseconds** (numbers). A task's derived issue key (e.g. `PAY-43`) and
`reporter` (the creating actor) come back on every read; neither is settable
via `pm_add_task`/`pm_update_task` — `reporter` is set server-side from the
caller's identity.

## Config (env)

| Var                 | Required | Default                                                       |
| ------------------- | -------- | ------------------------------------------------------------- |
| `GATEWAY_API_TOKEN` | yes      | — (`KANBAN_API_TOKEN` accepted as legacy fallback)            |
| `PM_BASE_URL`       | no       | falls back to `KANBAN_BASE_URL`, then `http://127.0.0.1:3107` |

`GATEWAY_API_TOKEN` must equal the gateway's API token (the deployed
`KANBAN_API_TOKEN` still authorizes `/api/pm`). Point `PM_BASE_URL` at the
public origin (e.g. `https://sparklab.ap.loclx.io`) when running the client
off-box, or leave it at the loopback gateway on the same host.

## Connect it

### Claude Code

```bash
claude mcp add pm \
  -e GATEWAY_API_TOKEN=<your-token> \
  -e PM_BASE_URL=https://sparklab.ap.loclx.io \
  -- node /home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal/tools/pm-mcp/server.mjs
```

Then in a Claude Code session: `/mcp` to confirm it's connected, and ask
e.g. _"list my projects"_ / _"add a task to project X"_ / _"move task Y to Done"_.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pm]
command = "node"
args = ["/home/sparklab/workspaces/sparklab/experimental-projects/claude-web-terminal/tools/pm-mcp/server.mjs"]
env = { GATEWAY_API_TOKEN = "<your-token>", PM_BASE_URL = "https://sparklab.ap.loclx.io" }
```

### Any MCP client

Run `node tools/pm-mcp/server.mjs` as a stdio MCP server with the two env
vars set. It speaks newline-delimited JSON-RPC 2.0 (`initialize`, `tools/list`,
`tools/call`, `ping`).

## Notes

- Get the token: it's the `GATEWAY_API_TOKEN` (or legacy `KANBAN_API_TOKEN`)
  line in `apps/terminal-gateway/.env`.
- This server lives **outside** the pnpm workspace globs (`apps/*`, `packages/*`)
  on purpose, so it never enters turbo build/lint/typecheck.
- Protocol reference for the underlying REST: `docs/TERMINAL-PROTOCOL.md`
  → `/api/pm/*`.
