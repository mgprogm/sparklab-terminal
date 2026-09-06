# Task Master Hub MCP — design

> Status: **built (2026-09-06).** `tools/taskmaster-hub-mcp/server.mjs` +
> `README.md`. A dependency-free stdio JSON-RPC MCP server, a near-copy of
> `tools/notes-mcp/` / `tools/kanban-mcp/`, that exposes the gateway's
> `/api/taskmaster/*` routes as MCP tools so an MCP-capable agent CLI
> (Claude Code, OpenCode) can **onboard its own project** into a running
> Task Master Hub and then coordinate work through the claim layer — without
> hand-rolling REST calls.

## 1. Why a Hub MCP (it is not `task-master`'s own MCP)

`task-master-ai` ships its own MCP server; that talks to a local `.taskmaster/`
directly and knows nothing about the Hub's registry, the multi-agent
execution/claim layer, or the `ownerChannel` binding. This MCP is a thin
client of **the Hub gateway** instead:

- one `taskmaster_hub_init` call registers the current project with the Hub
  (the same `POST /api/taskmaster/projects` the web UI uses — probes
  `.taskmaster/` + `binaryMode`) and hands back the project id, the claim
  protocol, and the identity this MCP will claim as;
- the claim / progress / release tools go through the gateway execution
  sidecar, so a terminal agent participates in the same coordination a
  human in the Hub UI and the in-app Agent Chat see (409 on a held task,
  TTL auto-expiry, `ownerChannel` 403 on cross-channel mutation).

**Deliberate duplication.** These tools functionally mirror agent-service's
in-loop `taskmaster_*` tools. That is the same split Kanban / PM / Notes
already have: an in-app tool set for Agent Chat, and a standalone MCP for
external CLIs. Do not "consolidate" them — the consumers and the transports
differ.

## 2. Auth & identity (the one thing this MCP adds beyond convenience)

- **Token.** `TASKMASTER_HUB_API_TOKEN`, falling back to `GATEWAY_API_TOKEN`
  (mirrors `NOTES_API_TOKEN || GATEWAY_API_TOKEN`). Sent as
  `Authorization: Bearer …` on every call — never a cookie. The gateway
  stays the single enforcement point.
- **Base URL.** `TASKMASTER_HUB_BASE_URL`, default `http://127.0.0.1:3107`.
- **Per-worker channel.** A bearer caller is `client:bearer` to
  `actorOf(req)` _unless_ it sends a valid `x-pm-actor` header, in which
  case it is `client:<actor>`. Phase C binds a claim to that channel:
  `update` / `release` from a different real channel → **403**. So each
  agent/worker that wants its claims isolated from other bearer callers must
  set **`TASKMASTER_HUB_ACTOR`** — the MCP sends it as the `x-pm-actor`
  header (header name is literally `x-pm-actor`, inherited from PM's
  `reporter`).
  - The gateway regex is `^[\w.@:-]+$`, ≤64 chars. `TASKMASTER_HUB_ACTOR`
    with a space or `/` would **silently degrade to `client:bearer`** —
    i.e. that worker would quietly share a channel with every other
    misconfigured one. The MCP therefore validates it **at startup** and
    **exits non-zero** if it is set-but-invalid, rather than degrade.
    Unset is allowed (you get `client:bearer`, and a stderr warning).
- **Claim labels.** `TASKMASTER_HUB_ROLE` / `_NAME` / `_TOOL` (defaults
  `Developer` / `MCP agent` / `Task Master Hub MCP`) and
  `TASKMASTER_HUB_AGENT_ID` (defaults to the actor value, else `"mcp"`) are
  sent on `taskmaster_hub_claim`. These are display/`agentId` only; the
  security boundary is the token + channel, never these strings.

## 3. `taskmaster_hub_init` — the onboarding tool

Input: `{ path?, server_id?, name? }`.

- `path` defaults to the MCP process's `process.cwd()` — which is **reported,
  not trusted**: Claude Code's `--scope local` spawns in the project dir but
  OpenCode's global config does not guarantee it, and if the agent and the
  gateway are on different hosts the cwd is meaningless to the gateway. Pass
  an explicit `path` when in doubt.
- `server_id` defaults to `TASKMASTER_HUB_SERVER_ID` or `"local"`.
- Calls `POST /api/taskmaster/projects` — the gateway's own probe
  (`test -d <path>/.taskmaster` through the exec seam) is what rejects a bad
  path with a clean 400; the MCP does not pre-validate the path.
- Returns: `{ project, binaryMode, currentTag, identity: { agentId, role,
name, tool, channel }, protocol: "<the 5-step claim workflow>",
agentsMdSnippet: "<the AGENTS.md paragraph to paste>" }`.
- **It does not write any repo file.** No kanban/pm/notes MCP writes to the
  filesystem; a REST client staying a REST client is the invariant. The
  `agentsMdSnippet` is returned as text for the agent to place itself.

If the project is already registered, `init` returns the existing row (the
registry create is idempotent on `{serverId, path}` — or, if it is not,
`init` first checks `GET /projects` and returns the match).

## 4. Tool surface

| Tool                             | Route                                                | Notes                                                                |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `taskmaster_hub_init`            | `POST /projects` (+ `GET /projects` for idempotency) | §3                                                                   |
| `taskmaster_hub_list_projects`   | `GET /projects`                                      |                                                                      |
| `taskmaster_hub_overview`        | `GET /projects/:id/overview`                         | counts + active claims                                               |
| `taskmaster_hub_list_tasks`      | `GET /projects/:id/tasks`                            | summary projection                                                   |
| `taskmaster_hub_get_task`        | `GET /projects/:id/tasks/:taskId`                    | full detail                                                          |
| `taskmaster_hub_next`            | `GET /projects/:id/next`                             |                                                                      |
| `taskmaster_hub_claim`           | `POST /projects/:id/tasks/:taskId/claim`             | sends configured identity                                            |
| `taskmaster_hub_update_progress` | `PATCH …/execution`                                  | `status` ∈ working/blocked/review; blocked needs `note`              |
| `taskmaster_hub_release`         | `DELETE …/execution`                                 |                                                                      |
| `taskmaster_hub_set_status`      | `POST …/tasks/:taskId/status`                        | done/cancelled/deferred auto-releases the claim                      |
| `taskmaster_hub_add_task`        | `POST /projects/:id/tasks`                           | `prompt` (+ `priority`); needs `binaryMode:"binary"` (503 otherwise) |
| `taskmaster_hub_update_task`     | `PATCH …/tasks/:taskId`                              | `prompt`; binary-only                                                |
| `taskmaster_hub_add_dependency`  | `POST /projects/:id/dependencies`                    | `id` + `depends_on`; cycle → 400 `dependency_cycle`                  |
| `taskmaster_hub_expand`          | `POST …/tasks/:taskId/expand`                        | `num?` / `research?`; binary-only                                    |
| `taskmaster_hub_current_tag`     | `GET /projects/:id/tags`                             |                                                                      |
| `taskmaster_hub_use_tag`         | `POST /projects/:id/tags/use`                        | binary-only; v1 = current-tag-only elsewhere                         |

**No `taskmaster_hub_unregister`.** `DELETE /projects/:id` is registry-only
(no `kill-session`, no data loss) but removing a project from a shared Hub is
a coordination-visible action — kept human/UI-only, matching the repo's
no-destructive-agent-tool convention (Kanban card delete, `pm_delete_task`,
`kill_session` are all absent from their agent surfaces too).

## 5. Transport & structure

Byte-for-byte the `notes-mcp` shape: `initialize` / `ping` / `tools/list` /
`tools/call` over newline-delimited JSON-RPC 2.0 on stdio, no SDK,
`api()` / `must()` REST helpers, one `IMPL` map, one `TOOLS` array. Errors
come back as `{ content:[{type:"text",…}], isError:true }`.

## 6. Verification

No automated-test precedent for these MCP servers (README + manual, like
kanban/pm/notes-mcp). Checked by piping JSON-RPC into `server.mjs` against
the live prod-gateway (`:3107`, `GATEWAY_API_TOKEN` set, a project already
registered):

1. `initialize` → `tools/list` returns the 16 tools.
2. `tools/call taskmaster_hub_list_projects` and `_overview` (reads) return
   real data.
3. Against a **scratch `TASKMASTER_EXECUTIONS_FILE` gateway** (not prod
   execution state): `_claim` with `x-pm-actor: mcpWorkerA` → 201; `_update_progress`
   with the same config → 200; a second run with `TASKMASTER_HUB_ACTOR=mcpWorkerB`
   `_update_progress` on A's claim → **403** (channel isolation proven);
   `_release` as A → 204.
4. `TASKMASTER_HUB_ACTOR="bad actor"` (space) → server exits non-zero at
   startup with a clear message.

## 7. Registering it

```bash
# Claude Code
claude mcp add taskmaster-hub -- node /abs/tools/taskmaster-hub-mcp/server.mjs \
  -e TASKMASTER_HUB_API_TOKEN=<token> \
  -e TASKMASTER_HUB_BASE_URL=https://sparklab.ap.loclx.io \
  -e TASKMASTER_HUB_ACTOR=<stable-worker-id> \
  -e TASKMASTER_HUB_ROLE=BE -e TASKMASTER_HUB_NAME="backend agent"

# OpenCode
opencode mcp add taskmaster-hub \
  --env TASKMASTER_HUB_API_TOKEN=<token> --env TASKMASTER_HUB_ACTOR=<id> \
  -- node /abs/tools/taskmaster-hub-mcp/server.mjs
```

Pi and `codex exec` have no MCP client — they use `/api/taskmaster/*` directly
(`docs/TASKMASTER-AGENT-SETUP.md` §4).
