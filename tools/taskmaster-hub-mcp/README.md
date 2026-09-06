# Task Master Hub MCP server

A dependency-free [Model Context Protocol](https://modelcontextprotocol.io)
(stdio) server that exposes the gateway's `/api/taskmaster/*` routes as MCP
tools, so an MCP-capable client (Claude Code, OpenCode, …) can **onboard its
own project** into a running Task Master Hub and then coordinate work through
the claim layer — instead of hand-writing `curl`. A near-copy of
`tools/notes-mcp/`.

This is **not** `task-master-ai`'s own MCP. That one drives a local
`.taskmaster/` directly and knows nothing about the Hub. This server is a
thin REST client of the **Hub gateway**: every call carries a scoped bearer
token (never a cookie), so the gateway stays the single enforcement point. No
build step, no dependencies — plain Node ≥ 18.

Design + decisions: `docs/TASKMASTER-HUB-MCP-PLAN.md`.

## The `init` flow

`taskmaster_hub_init` is the point of the server:

1. Run an MCP-capable agent CLI inside a project that has a `.taskmaster/`
   directory.
2. It calls `taskmaster_hub_init` (optionally with an explicit absolute
   `path` — the default is the MCP process cwd, which is _reported, not
   trusted_).
3. The gateway probes `.taskmaster/` + the `task-master` binary and registers
   the project. `init` returns the project id, `binaryMode`, current tag,
   the 5-step claim protocol, this worker's claim identity + auth channel,
   and an `AGENTS.md` snippet to paste (**it does not write any file**).
4. The agent then works through `taskmaster_hub_claim` /
   `_update_progress` / `_set_status` / `_release`.

Re-running `init` on an already-registered project returns the existing row.

## Tools

| Tool                             | REST                                             |
| -------------------------------- | ------------------------------------------------ |
| `taskmaster_hub_init`            | `GET /projects` (idempotency) + `POST /projects` |
| `taskmaster_hub_list_projects`   | `GET /projects`                                  |
| `taskmaster_hub_overview`        | `GET /projects/:id/overview`                     |
| `taskmaster_hub_list_tasks`      | `GET /projects/:id/tasks` (summary)              |
| `taskmaster_hub_get_task`        | `GET /projects/:id/tasks/:taskId` (full)         |
| `taskmaster_hub_next`            | `GET /projects/:id/next`                         |
| `taskmaster_hub_claim`           | `POST /projects/:id/tasks/:taskId/claim`         |
| `taskmaster_hub_update_progress` | `PATCH …/tasks/:taskId/execution`                |
| `taskmaster_hub_release`         | `DELETE …/tasks/:taskId/execution`               |
| `taskmaster_hub_set_status`      | `POST …/tasks/:taskId/status`                    |
| `taskmaster_hub_add_task`        | `POST /projects/:id/tasks` — binary-only         |
| `taskmaster_hub_update_task`     | `PATCH …/tasks/:taskId` — binary-only            |
| `taskmaster_hub_add_dependency`  | `POST /projects/:id/dependencies` — binary-only  |
| `taskmaster_hub_expand`          | `POST …/tasks/:taskId/expand` — binary-only      |
| `taskmaster_hub_current_tag`     | `GET /projects/:id/tags`                         |
| `taskmaster_hub_use_tag`         | `POST /projects/:id/tags/use` — binary-only      |

There is deliberately no `unregister` tool — removing a project from a shared
Hub is a coordination-visible action, kept human/UI-only (same convention as
the absent Kanban card-delete, `pm_delete_task`, `kill_session` agent tools).

"binary-only" routes need a real `task-master` binary installed on the
project's server; they return **503** where only the `npx` fallback is
available (`docs/TASKMASTER-HUB-PLAN.md` §1e).

## Config (env)

| Var                                       | Default                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TASKMASTER_HUB_API_TOKEN`                | —                                                 | Scoped bearer; falls back to `GATEWAY_API_TOKEN`. Required.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TASKMASTER_HUB_BASE_URL`                 | `http://127.0.0.1:3107`                           | Gateway or proxy base URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TASKMASTER_HUB_ACTOR`                    | _(unset)_                                         | Per-worker id, sent as the `x-pm-actor` header so this worker gets its **own** `ownerChannel` (Phase C — a claim can only be updated/released from the channel that created it). **Must match `^[\w.@:-]{1,64}$`** — the server refuses to start on a set-but-invalid value, because the gateway would otherwise silently downgrade it to `client:bearer` and this worker would share a channel with every other misconfigured one. Unset ⇒ `client:bearer` (fine for a single external worker). |
| `TASKMASTER_HUB_SERVER_ID`                | `local`                                           | Which registered server a new project is registered on.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TASKMASTER_HUB_ROLE` / `_NAME` / `_TOOL` | `Developer` / `MCP agent` / `Task Master Hub MCP` | Claim display labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TASKMASTER_HUB_AGENT_ID`                 | the actor value, else `mcp`                       | `agentId` used on claims.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Register

```bash
# Claude Code (local scope keys it to this project directory)
claude mcp add taskmaster-hub -- node /abs/path/tools/taskmaster-hub-mcp/server.mjs \
  -e TASKMASTER_HUB_API_TOKEN=<token> \
  -e TASKMASTER_HUB_BASE_URL=https://sparklab.ap.loclx.io \
  -e TASKMASTER_HUB_ACTOR=be-worker-1 \
  -e TASKMASTER_HUB_ROLE=BE -e TASKMASTER_HUB_NAME="backend agent"

# OpenCode
opencode mcp add taskmaster-hub \
  --env TASKMASTER_HUB_API_TOKEN=<token> --env TASKMASTER_HUB_ACTOR=be-worker-1 \
  -- node /abs/path/tools/taskmaster-hub-mcp/server.mjs
```

Pi and `codex exec` have no MCP client — they call `/api/taskmaster/*`
directly (`docs/TASKMASTER-AGENT-SETUP.md` §4).

## Smoke test (no client needed)

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"taskmaster_hub_list_projects","arguments":{}}}' \
 | TASKMASTER_HUB_API_TOKEN=<token> TASKMASTER_HUB_BASE_URL=http://127.0.0.1:3107 \
   node tools/taskmaster-hub-mcp/server.mjs
```
