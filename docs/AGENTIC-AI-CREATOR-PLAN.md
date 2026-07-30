# Agentic AI Creator (pluggable HTML artifact) — Design & Implementation Plan (v2)

> Status: **proposed** (2026-07-28) — design idea only, not yet built. **Supersedes
> `docs/AGENT-CREATOR-PLAN.md`** (v1 draft, same day) after a design review that
> compared it against an alternative "Agentic AI Creator" proposal (Creator → Agentic
> AI → Agent hierarchy, visual workflow DAG, per-tool MCP permissions, a live
> approval-mediating proxy, and a runtime-provider abstraction). This document keeps
> everything v1 got right (grounded against real source, tmux-based survivability,
> reuse of the `run_codex` security template, a scoped v1 that doesn't try to be a
> platform) and folds in five ideas that were genuinely better in the alternative
> proposal, while explicitly rejecting the one idea (publish each "Agentic AI" as its
> own top-level artifact) that would reverse a decision this repo has now made three
> times. See §1 D8 for the full reasoning on that call.
>
> Several decisions below are still marked **OPEN** (§9) and need a call before build
> starts.
>
> Scope: a third pluggable artifact — the **Creator** — that lets a user define,
> configure, and run **Agentic AI** applications: a named goal + a team of **Agents**
> (each backed by the Claude Code CLI or the Codex CLI) + an orchestration mode. Like
> Kanban and PM, it is owned end-to-end by the **gateway** (a new `agentic.json`
> sidecar + `/api/agentic/*` REST), with **one** self-contained HTML UI loaded into a
> sandboxed `<iframe>` modal — an Agentic AI is a _catalog entry inside that one
> artifact_, not a separate artifact of its own.

Three terms, used precisely throughout this document:

- **Creator** — this artifact itself: the studio/control-plane UI and its backend.
- **Agentic AI** — one thing a user builds inside the Creator: a goal, a team of
  Agents, an orchestration mode, and a set of artifact connections. Has a lifecycle
  (`draft` → `published` → `paused`/`archived`) and a version.
- **Agent** — one team member inside an Agentic AI, backed by a runtime provider
  (Claude CLI or Codex CLI today).
- **Run** — one execution of an Agentic AI. May involve several individual CLI
  process executions (one per "agent task" step) chained together by an orchestration
  layer that must itself survive restarts (§1 D3).
- **Connection** — scoped access from an Agentic AI's agents to one of this system's
  other artifact MCP servers (pm-mcp, kanban-mcp, future ones), mediated live rather
  than granted wholesale (§1 D5).

---

## 0. Grounding (verified against source, plus the v1→v2 design review)

Everything in `docs/AGENT-CREATOR-PLAN.md` §0 still applies unchanged (sidecar store
convention, route/auth pattern, the `run_codex` security template, multi-server exec
seams, the agent-service tool + approval pattern, MCP registration).

- **CORRECTION (verified 2026-07-28 against the installed CLI, v2.1.220):** the v1
  plan's claim that "Claude Code CLI has no `--mcp-config`/`--strict-mcp-config` flag"
  is **wrong for the installed version**. `claude --help` confirms `-p/--print`
  (headless one-shot), `--output-format` (incl. `stream-json`), `--permission-mode`,
  `--append-system-prompt`, `--mcp-config <files...>`, and `--strict-mcp-config`
  ("Only use MCP servers from --mcp-config"). This means Claude has real
  per-invocation MCP scoping, exactly analogous to Codex's `CODEX_HOME` — so the v1
  open decision "Claude CLI headless invocation shape" is now **resolved**, and D5's
  Claude path (below) uses `--mcp-config <per-run file> --strict-mcp-config` rather
  than the weaker project-scope `.mcp.json` discovery the v1 draft assumed. `codex`
  (v0.145.0) is also installed.

Two additional groundings from the design review:

- **"Many things inside one artifact" already has a precedent — twice.** Kanban is
  multi-board (`GET /api/kanban/boards` returns a list; one artifact has an in-app
  board switcher). PM is multi-project the same way. Neither gives a board or a
  project its own header button, its own iframe, or its own URL flag — you open the
  one Kanban button and pick a board from inside. **"Agentic AI" is the same shape of
  thing as a board or a project**: a data-level entity with many instances, not a
  reason to mint a new top-level artifact. This is the load-bearing precedent behind
  §1 D8.
- **A fixed, code-reviewed artifact frontend is a security invariant, not an
  accident.** Kanban's and PM's `app.html` files are static, author-written, and
  reviewed; only their _data_ varies at runtime. Any design where "publishing" mints a
  new runtime-generated frontend surface breaks that invariant. Modeling Agentic AI as
  data rendered by one fixed, reviewed UI (like a board or a project) preserves it
  automatically; a dynamic multi-artifact registry would not.

---

## 1. Architectural decisions (settled before implementation)

**D1 — Ownership: the gateway, not agent-service.** Unchanged from v1. Agent, Agentic
AI, and Run records are gateway-owned state; agent-service is a REST client only.

**D2 — Storage: `data/agentic.json` sidecar, atomic write, no mutex.** A new
`apps/terminal-gateway/src/agentic.js`, following PM's synchronous-mutator
convention. `AGENTIC_FILE` env override for tests. Four top-level collections:
`agents`, `agenticAis`, `connections`, `runs` (§2).

**D3 — Survivability is two layers, not one.** This is the central decision of v2. v1
only had to keep _one_ process alive across a restart. An Agentic AI run is a
potentially long-running, possibly-branching sequence of steps — including a human
approval step that might sit for hours — so survivability has to be solved at two
distinct levels:

1. **Process survivability, per agent-task step** — unchanged from v1: each "agent
   task" step spawns a detached tmux session (`agrun-<runId>-<nodeId>` — **NOT** a
   `web-` prefix: that prefix is filtered by `list-sessions` and would surface run
   jobs in the terminal sidebar and the attach/kill machinery; corrected during iter2
   implementation) through
   the existing tmux exec seam, wrapper writes the prompt to a private temp file
   (mode `0600`, never argv), redirects stdout+stderr to a log file, writes exit code
   to a marker file on completion. `AGENT_RUN_TIMEOUT_MS` still bounds each individual
   step as a wall-clock safety net.
2. **Workflow-state survivability — the new problem.** The orchestrator that decides
   "step 2 finished, start step 3" must **never hold that decision in the gateway
   process's memory**. If it did, a gateway restart mid-run would lose the run's
   position permanently (unlike an individual tmux job, which keeps running
   regardless of the gateway). Instead:
   - Every `Run` persists a `nodeExecutions[]` ledger (§2) — one entry per workflow
     step, with a `status` (`pending`/`running`/`waiting-approval`/`done`/`failed`/
     `skipped`), the step's resolved input/output, and (for agent-task steps) the
     `agentRunId` tying it to its tmux job.
   - The orchestrator is a **pure reducer over that persisted ledger**, not a
     long-lived async loop: "given the current `nodeExecutions[]`, what should happen
     next?" is recomputed fresh every time it's invoked — on a poll tick (an
     agent-task's tmux job finished), on a human action (approve/reject/guidance), and
     on gateway boot. This mirrors, at the workflow level, the exact idiom this repo
     already uses at the session level: `tmux ls` on boot rediscovers everything: no
     event a restart could have swallowed and no unrecoverable state.
   - **A step waiting on human approval costs nothing to keep alive.** Unlike an
     agent-task step, there is no process running while a run sits at a
     `waiting-approval` node — it's a row in the JSON sidecar. A run can wait there
     for days across any number of restarts at zero cost, because there was never
     anything to keep alive in the first place. Optionally, use the repo's existing
     Web Push infrastructure to notify a human when a run reaches this state, so
     "paused indefinitely" doesn't mean "silently forgotten."
   - **Parallel fan-out** ("supervisor delegates to N workers at once") spawns N
     agent-task tmux jobs, each a `nodeExecution` with a shared `parentNodeId`; the
     parent step is done only when every child is terminal — checked on every poll
     tick, same reducer.
   - **Boot rediscovery**: on startup, scan every `Run` with status `running` or
     `waiting-approval`. For any in-flight agent-task step, `tmux has-session` tells
     the gateway whether it's still running (if the underlying job already finished
     while the gateway was down, its exit marker + log are read immediately during
     boot and the reducer advances the run right there — no different from a session
     coming back after a restart).
   - **A new whole-run safety net**, distinct from the per-step one:
     `AGENTIC_RUN_MAX_AGE_MS` (§10). A run stuck at `waiting-approval` forever isn't
     consuming CPU the way a hung process would, but it is an unreviewed liability
     that can silently pile up. Past this age, **notify again — do not auto-cancel.**
     Force-failing a run that's genuinely waiting on a slow but legitimate human
     reviewer would be the wrong call; a repeated reminder is the honest one.

Rejected alternative (same as v1): a synchronous, in-memory orchestration loop that
walks the whole workflow inside one `await` chain. Simpler to write, but it dies with
the gateway process — exactly the failure mode this repo's entire premise exists to
avoid.

**D4 — Reuse the `run_codex` security template per agent-task step.** Unchanged from
v1: sandbox mode clamped to `read-only`/`workspace-write` (code-fixed, not
env-configurable), curated env allowlist (never the gateway's full environment),
output/prompt bounds (`AGENT_OUTPUT_MAX_BYTES`/`AGENT_PROMPT_MAX_BYTES`), backend
binary overridable per runtime provider (`CODEX_COMMAND`, `CLAUDE_COMMAND`) purely for
test stubbing. The same honest caveat still applies: sandbox mode governs writes/exec,
not read scope.

**D5 — MCP mediation: a per-run proxy, with per-tool policy, replaces the
config-file-only approach.** v1 left this as an open question (config-file scoping vs.
a scoped token). v2 resolves it with a concrete mechanism that gets the strongest
option from the review essentially for free:

- An Agentic AI declares `connectionIds: string[]` — which `ArtifactConnection`
  records (§2) it may use. Each Agent declares `toolPolicies: AgentToolPolicy[]` —
  per connection, either `tools: "all"` or an explicit tool allowlist, plus a
  `policy` of `allow` / `deny` / `approval` (default `approval` for anything that
  isn't a known-safe read, matching this repo's existing "writes default to
  approval-required" ethos).
- At run time, the gateway spins up **one lightweight, ephemeral, stdio MCP server
  per run** — `tools/agentic-proxy/server.mjs`, the same dependency-free JSON-RPC
  pattern as `kanban-mcp`/`pm-mcp` — that sits between the spawned CLI and the real
  artifact MCP servers. The agent-task step's scoped config points **at this proxy**,
  not directly at `pm-mcp`/`kanban-mcp`: for Codex via a per-run `CODEX_HOME`
  `config.toml`; for Claude via `--mcp-config <per-run.json> --strict-mcp-config`
  (verified available in the installed CLI, §0) so only the proxy is visible to the
  run — no reliance on project-scope `.mcp.json` discovery.
- For every incoming tool call, the proxy looks up the calling agent's
  `toolPolicies`: `deny` returns an error immediately; `allow` forwards to the real
  MCP server (holding the actual credential itself — see below) and logs the call;
  `approval` blocks the call, creates a pending-approval record surfaced in the Runs
  UI (§5), and only forwards once a human approves (or returns a rejection to the
  CLI). A bounded wait, `AGENT_MCP_APPROVAL_TIMEOUT_MS` (§10), prevents a slow
  approval from hanging the calling CLI's own MCP client past its timeout — past that
  bound the proxy returns `approval_pending_timeout` and the human can still approve
  or deny after the fact for the _next_ call.
- **This is a bigger security upgrade than it sounds, almost by construction: the
  spawned CLI process never holds a real artifact credential at all** — only a
  connection to a local, ephemeral, per-run proxy that _the gateway_ holds the real
  credential for. `AGENT_MCP_SCOPED_TOKENS` (§10) now controls what the _proxy_ uses
  when forwarding approved calls (the shared `GATEWAY_API_TOKEN`, or a minted
  short-lived scoped token) — the CLI's own exposure is unaffected either way, since
  it never sees either token.
- Defense in depth: even though `--strict-mcp-config` (§0) already restricts a Claude
  run to exactly the proxy, the _proxy_ remains the actual enforcement boundary — so a
  looser-than-expected CLI-side scoping can never widen what a run can actually reach.

**D6 — Runtime provider abstraction, not a hardcoded backend enum.** v1 hardcoded
`backend: "codex"|"claude"` directly into the wrapper script's branching logic. v2
defines an internal interface:

```ts
interface AgentRuntimeProvider {
  id: string; // "codex-cli" | "claude-cli" | ...
  capabilities: {
    workspaceWrite: boolean;
    toolCalling: boolean;
    streaming: boolean;
  };
  buildInvocation(input: AgentTaskInput): WrapperInvocation; // argv, env, temp files
  parseResult(logTail: string, exitCode: number): AgentTaskResult;
}
```

Two concrete providers ship in v1 — `codex-cli` and `claude-cli` — both implemented
via the exact same D3/D4 tmux-wrapper mechanism internally; the interface is purely an
internal seam, not an exposed plugin SDK. This costs little now and means a future
provider (Claude API, a local model, a remote agent service) is an additive
implementation, not a rewrite of the wrapper's branching.

**D7 — Agent-service exposure: CRUD and workflow-editing tools only; still no
`run_*` tool, and no approve/reject tool either.** Running an Agentic AI is at least
as dangerous as `run_codex` was in v1 — arguably more so, since a run can now involve
several chained processes and live MCP write access. v2 keeps v1's stance and extends
it:

- **Reads** (`agentic_list`, `agentic_get`, `agentic_list_agents`,
  `agentic_get_run`, `agentic_list_runs`, `agentic_list_activity`) — auto.
- **Routine writes** (`agentic_create`, `agentic_update`, `agentic_add_agent`,
  `agentic_update_agent`, `agentic_connect_artifact`, `agentic_update_workflow`) —
  gated, allow-always permitted (no side effect until a run is actually started).
- **Destructive** (`agentic_delete`, `agentic_remove_agent`,
  `agentic_disconnect_artifact`) — coerced one-time.
- **No `agentic_start_run` tool.** Starting a run is human-click-only in the artifact
  UI, unchanged from v1's `run_agent` stance.
- **No `agentic_approve_action`/`agentic_reject_action` tool either — deliberately.**
  The entire point of a human-approval step is a human's judgment; an agent
  approving another agent's write defeats the control. This is a firmer version of
  v1's "no `run_agent` tool" reasoning, applied to the new approval surface.

**D8 — Publish & hosting model: Agentic AI is a catalog entry inside one artifact, not
a new artifact. This is the decision that most needed re-litigating, and it is now
settled.** The alternative proposal's Creator/Agentic-AI/Agent hierarchy is worth
keeping conceptually — but its "publish creates an independently runnable artifact
that appears beside PM and Kanban" mechanic is rejected. Reasoning:

- Per §0's grounding, "Agentic AI" is shaped exactly like a Kanban board or a PM
  project: a named, stateful, many-instances-per-system entity. Neither of those got
  its own header button, iframe, or URL flag — they got an in-app catalog inside one
  fixed artifact. Agentic AI gets the same treatment: one Creator artifact, one
  header button, one `?agentic` URL flag, with an in-app catalog listing every
  Agentic AI and its `status` (`draft`/`published`/`paused`/`archived`). **"Publish"
  is a status-field mutation** (`PATCH .../apps/:id {status:"published"}`), not an
  operation that mints anything new in the frontend.
- The alternative's actual missing piece — "the Creator produces N runnable
  applications" — is delivered by the catalog itself, not by N separate artifacts.
- Building true per-Agentic-AI top-level icons would require exactly the
  "generalized multi-artifact registry (host chrome, artifact manifest, tabs)" that
  Kanban §7, the PM plan, and v1's own D7 have now each _independently_ deferred as
  "gold-plating." Reversing that stance should be a deliberate, isolated decision if
  it's ever made — not something backed into as a side effect of this feature. It is
  explicitly deferred again here (§8), and if it's ever built it should be a
  **horizontal** capability shared by Kanban/PM/Agentic-AI, not something bespoke to
  this one artifact.
- This also preserves the fixed-and-reviewed-frontend security invariant from §0 —
  a runtime-generated artifact-per-publish model would not.
- A cheap, optional enhancement that gets most of the "feels like its own page"
  value without any of the registry cost: an id-parameterized deep link,
  `?agentic=<id>`, opens the one Creator artifact straight to that Agentic AI's run
  screen — the same pattern `?session=<id>` already uses for terminal sessions.

**D9 — Run config versioning.** A gap in v1: editing an Agent or an Agentic AI after
a run leaves that run's exact configuration ambiguous on replay. v2 adds a monotonic
`version` on `AgenticAI`, bumped on every definition edit (agent membership, workflow,
connections). Every `Run` snapshots `agenticAiVersion` plus a frozen, resolved copy of
the config it actually executed with (agent list, workflow, tool policies at start
time) directly into the `Run` record. Old runs stay reproducible and auditable no
matter how many times the live definition has changed since.

---

## 2. Data model (`data/agentic.json`)

```jsonc
{
  "agents": {
    "ag-<uuid>": {
      "id": "ag-<uuid>",
      "name": "Developer",
      "runtimeProvider": "codex-cli", // "codex-cli" | "claude-cli" (D6)
      "role": "worker", // "supervisor" | "worker" | "reviewer" — free-form label, not enforced
      "systemPrompt": "…",
      "sandboxMode": "workspace-write", // "read-only" | "workspace-write" (D4)
      "toolPolicies": [
        // per-connection, per-tool policy (D5) — replaces v1's flat mcpServers[]
        {
          "connectionId": "conn-pm-1",
          "tools": ["pm_get_project", "pm_add_comment"], // or "all"
          "policy": "allow", // "allow" | "deny" | "approval"
        },
        { "connectionId": "conn-pm-1", "tools": "all", "policy": "approval" },
      ],
      "model": null,
      "rev": 3,
      "createdAt": 1785200000000,
      "updatedAt": 1785200000000,
    },
  },

  "connections": {
    "conn-pm-1": {
      "id": "conn-pm-1",
      "targetType": "pm", // "pm" | "kanban" | future artifact ids
      "scope": "fixed", // "fixed" | "runtime-selection"
      "targetId": "pm-2f7a0d47-…", // a specific project/board id, when scope="fixed"
      "createdAt": 1785200000000,
    },
  },

  "agenticAis": {
    "aa-<uuid>": {
      "id": "aa-<uuid>",
      "name": "Software Delivery Team",
      "description": "Plans, implements, tests, and reviews development tasks.",
      "objectiveTemplate": "Complete the selected PM task while maintaining code quality.",
      "status": "published", // "draft" | "published" | "paused" | "archived" (D8)
      "orchestrationMode": "supervisor", // "single" | "supervisor" | "sequential" | "parallel"
      "agentIds": ["ag-lead", "ag-dev", "ag-test", "ag-review"], // order = supervisor/pipeline order
      "connectionIds": ["conn-pm-1"],
      "workflow": {
        // DAG-shaped from day one (so v2+ node types are additive, not a migration);
        // v1 UI only authors "single"/"supervisor"/"sequential"/"parallel" shapes —
        // no visual graph editor, no condition/router/retry/evaluation node types yet (§8)
        "nodes": [
          { "id": "n1", "type": "agent-task", "agentId": "ag-lead" } /* … */,
        ],
        "edges": [{ "from": "n1", "to": "n2" }],
        "entryNodeId": "n1",
      },
      "version": 4, // D9 — bumped on every definition edit
      "rev": 12,
      "createdAt": 1785200000000,
      "updatedAt": 1785200000000,
    },
  },

  "runs": {
    "run-<uuid>": {
      "id": "run-<uuid>",
      "agenticAiId": "aa-<uuid>",
      "agenticAiVersion": 4, // D9 — snapshot for reproducibility
      "resolvedConfig": {
        /* frozen copy of agents+workflow+toolPolicies at start time */
      },
      "sessionId": "local/web-<uuid>",
      "objective": "Implement AUTH-42",
      "status": "running", // "queued" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled"
      "nodeExecutions": [
        // D3 — the durable workflow ledger; this array IS the run's position
        {
          "nodeId": "n1",
          "status": "done",
          "agentRunId": "arun-1", // ties to the tmux job (D3 layer 1)
          "startedAt": 1785200001000,
          "finishedAt": 1785200030000,
        },
        {
          "nodeId": "n2",
          "status": "waiting-approval",
          "startedAt": 1785200030000,
        },
      ],
      "startedAt": 1785200001000,
      "finishedAt": null,
    },
  },
}
```

`agentIds[]` and `workflow.edges` are the sole ordering/structure authority — no
duplicated position field elsewhere. `runs` and their `nodeExecutions[]` are
append/update-only; no cross-client race exists on a `Run` (only the gateway's own
poll/marker-read and human approval actions mutate it), so no `rev` is needed there —
`rev` still guards `agents`/`agenticAis`/`connections` edits the same way it guards
Kanban cards and PM tasks.

`agentic.js` API (synchronous mutators, atomic-persisting, PM-style, no mutex):
`load()`, agent/connection/agenticAi CRUD (`list*`, `get*`, `create*`, `update*`,
`delete*`), `startRun({agenticAiId, sessionId, objective})` (resolves+freezes config,
spawns the entry node, D3), `advanceRun(runId)` (the reducer — recomputes and takes
the next action given the current `nodeExecutions[]`; called on poll tick, approval
action, and boot), `approveAction(runId, nodeId)` / `rejectAction(runId, nodeId, ...)`,
`listRuns()`, `getRun(id)`, `killRun(id)`.

---

## 3. Backend endpoints (`/api/agentic/*` in `server.js`)

Same Origin/CSRF + bearer-or-cookie auth pattern as Kanban/PM/v1.

### Read routes (GET — Origin-exempt)

| Route                          | Returns                                                 |
| ------------------------------ | ------------------------------------------------------- |
| `GET /api/agentic/agents`      | `{ agents: Agent[] }`                                   |
| `GET /api/agentic/agents/:id`  | `Agent`                                                 |
| `GET /api/agentic/connections` | `{ connections: ArtifactConnection[] }`                 |
| `GET /api/agentic/apps`        | `{ apps: AgenticAiSummary[] }` — the catalog (D8)       |
| `GET /api/agentic/apps/:id`    | `AgenticAI` (full, incl. `workflow`)                    |
| `GET /api/agentic/runs`        | `{ runs: RunSummary[] }`                                |
| `GET /api/agentic/runs/:id`    | `Run` (incl. `nodeExecutions[]` + tailed logs per step) |
| `GET /api/agentic/mcp-servers` | `{ servers: {id,name}[] }` — for the connection picker  |

### Write routes (state-changing — Origin-checked)

| Route                                              | Body                                                                                               | Result                                                                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/agentic/agents`                         | `{name, runtimeProvider, role?, systemPrompt, sandboxMode, toolPolicies?, model?}`                 | 201 `Agent`                                                                                                                                                                                                    |
| `PATCH /api/agentic/agents/:id`                    | partial                                                                                            | 200 `Agent`                                                                                                                                                                                                    |
| `DELETE /api/agentic/agents/:id`                   | —                                                                                                  | 204                                                                                                                                                                                                            |
| `POST /api/agentic/connections`                    | `{targetType, scope, targetId?}`                                                                   | 201 `ArtifactConnection`                                                                                                                                                                                       |
| `DELETE /api/agentic/connections/:id`              | —                                                                                                  | 204                                                                                                                                                                                                            |
| `POST /api/agentic/apps`                           | `{name, description?, objectiveTemplate?, orchestrationMode, agentIds, connectionIds?, workflow?}` | 201 `AgenticAI` (v=1)                                                                                                                                                                                          |
| `PATCH /api/agentic/apps/:id`                      | partial (bumps `version`, D9)                                                                      | 200 `AgenticAI`                                                                                                                                                                                                |
| `PATCH /api/agentic/apps/:id/status`               | `{status}`                                                                                         | 200 `AgenticAI` — **this is "publish"** (D8)                                                                                                                                                                   |
| `DELETE /api/agentic/apps/:id`                     | —                                                                                                  | 204                                                                                                                                                                                                            |
| `POST /api/agentic/apps/:id/run`                   | `{sessionId, objective}`                                                                           | 202 `Run`                                                                                                                                                                                                      |
| `DELETE /api/agentic/runs/:id`                     | —                                                                                                  | 204 — kills the run's current tmux job(s)                                                                                                                                                                      |
| `POST /api/agentic/runs/:id/nodes/:nodeId/approve` | —                                                                                                  | 200 `Run` — human-only, no agent tool (D7)                                                                                                                                                                     |
| `POST /api/agentic/runs/:id/nodes/:nodeId/reject`  | `{reason?}`                                                                                        | 200 `Run`                                                                                                                                                                                                      |
| `POST /api/agentic/runs/:id/guidance`              | `{text}`                                                                                           | 202 — injects keystrokes into the current step's tmux pane via the existing `serverExecArgv`-backed keys mechanism, **only if** that step's runtime provider was invoked interactively (§5, extension over v1) |

Errors: 400/401/403/404/413 as in v1, plus 422 `invalid_workflow` (cycle or dangling
edge in `workflow`), 503 `backend_unavailable`.

### Zod schemas — add to `packages/shared-types/src/terminal.ts`

`AgentRuntimeProvider` (`z.enum(["codex-cli","claude-cli"])`), `AgentToolPolicy`,
`Agent`, `ArtifactConnection`, `WorkflowNode`, `WorkflowEdge`, `WorkflowDefinition`,
`AgenticAI`, `AgenticAiSummary`, `NodeExecution`, `Run`, `RunSummary`, plus
Create/Update request variants for each; re-exported under a
`// REST: Agentic AI Creator /api/agentic/*` banner.

---

## 4. AI access

### 4a. In-app agent (`apps/agent-service/src/tools.ts` + `gateway-client.ts`)

Per **D7**: `agentic_list`, `agentic_get`, `agentic_list_agents`,
`agentic_create` /`agentic_update`/`agentic_delete` (agents), `agentic_connect_artifact`
/`agentic_disconnect_artifact` (connections), app-level `agentic_create_app`/
`agentic_update_app`/`agentic_update_workflow`/`agentic_delete_app`,
`agentic_list_runs`/`agentic_get_run`/`agentic_list_activity`. No start-run tool, no
approve/reject tool.

### 4b. External AI (Claude/Codex CLI) — MCP server (`tools/agentic-mcp/server.mjs`)

Same shape as `tools/{kanban,pm}-mcp/server.mjs`, mirroring §3's routes over the
shared bearer token. **Not** itself a selectable `connection` target for any spawned
Agent — same fork-bomb exclusion as v1.

### 4c. The per-run proxy (`tools/agentic-proxy/server.mjs`) — new in v2

Not exposed to any AI client as a registrable tool — it's internal infrastructure the
gateway spawns per run to mediate MCP traffic per **D5**. Documented here because it's
still "AI access" in the sense that it's what an Agent's own MCP tool calls actually
hit.

---

## 5. Frontend

### 5a. Store (`features/terminal/store.ts`)

`agenticOpen: boolean` + `setAgenticOpen(open)`, ephemeral, mirroring
`kanbanOpen`/`pmOpen`/v1's `agentsOpen`.

### 5b. Header button (`components/terminal-shell.tsx`)

One button (lucide `Bot` or `Workflow`), always enabled (D8 — catalog isn't
session-scoped). `?agentic` URL flag; optional `?agentic=<id>` deep-links straight to
that Agentic AI's run screen (D8).

### 5c. Host modal (`components/agentic-dialog.tsx`)

Unchanged shape from v1/Kanban/PM — one iframe, one Dialog.

### 5d. The artifact (`apps/terminal/public/agentic/app.html`)

Four views inside the **one** artifact:

- **Catalog** — every Agentic AI, its `status` badge, agent count, connection chips.
  "New Agentic AI" opens the builder.
- **Builder** — name/description/objective; agent team (add existing shared agents or
  define new ones inline: name, runtime-provider radio, system prompt, sandbox mode,
  **per-connection tool-policy grid** — the concrete v2 answer to per-tool MCP
  permissions); connections (pick artifact + scope); orchestration mode select
  (`single`/`supervisor`/`sequential`/`parallel` — **no visual DAG editor in v1**, see
  §8); a Publish toggle that flips `status`.
- **Run** — objective input, target-session picker, Start button; live view of
  `nodeExecutions[]` (status per step, which agent, elapsed time), a pending-approval
  banner with approve/reject when a step is `waiting-approval`, a guidance input (only
  enabled for steps whose runtime provider is running interactively), pause/kill.
- **Runs history** — past runs, their `agenticAiVersion` (D9), status, and a link to
  the full per-step transcript.

Palette hardcoded to mirror DESIGN.md, same documented exception as Kanban/PM/v1.

---

## 6. Phased implementation checklist

1. **Verify the Claude CLI headless invocation shape first** (§0, §9) — unchanged
   gate from v1, still first.
2. **Backend, static shapes**: `agentic.js` store, shared-types schemas,
   `/api/agentic/*` CRUD for agents/connections/apps (no run, no proxy yet).
3. **Survivability layer 1** (per-step tmux jobs) — reuse v1's design directly.
4. **Survivability layer 2** (the reducer + `nodeExecutions[]` ledger + boot
   rediscovery) — new and the highest-interpretation-risk slice in this whole plan.
   **Checkpoint with the user before this step.**
5. **The per-run MCP proxy** (`tools/agentic-proxy/server.mjs`) + per-tool policy
   enforcement + approval-pending flow. **Checkpoint with the user before this step**
   (second-highest risk — this is genuinely new infrastructure, not a reuse of an
   existing pattern like step 3 was).
6. **Gateway test** `test/agentic-endpoints.js` (`test:agentic`) — see §7.
7. **Agent tools** — CRUD-only per D7.
8. **Frontend** — store slice, header button, `agentic-dialog.tsx`, URL flag
   (incl. `?agentic=<id>` deep link).
9. **Artifact** `public/agentic/app.html`. **Checkpoint with the user before this
   step.**
10. Docs: `docs/TERMINAL-PROTOCOL.md` + `docs/AGENT-PROTOCOL.md` Agentic AI Creator
    section; update `CLAUDE.md` status + Layout; mark
    `docs/AGENT-CREATOR-PLAN.md` as superseded.

---

## 7. Testing (planned; not yet written)

`apps/terminal-gateway/test/agentic-endpoints.js` (`test:agentic`), same
standalone-script convention as the other artifacts' endpoint tests:

- Agent/connection/AgenticAI CRUD; workflow validation (cycle/dangling-edge → 422).
- **Reducer correctness**: start a multi-step run with a stub backend, kill the
  gateway process mid-run (simulate restart), reboot, assert `nodeExecutions[]` is
  rediscovered correctly and the run advances from where it left off — the load-bearing
  test for D3 layer 2.
- **Approval flow**: a run reaches a `waiting-approval` node, survives a simulated
  restart while waiting, approves after restart, run continues.
- **Proxy policy enforcement**: `allow` forwards and logs; `deny` returns an error
  without forwarding; `approval` blocks until a human decision, times out into
  `approval_pending_timeout` past `AGENT_MCP_APPROVAL_TIMEOUT_MS`.
- **Versioning**: edit an Agentic AI after starting a run; assert the run's
  `resolvedConfig`/`agenticAiVersion` is untouched by the later edit.
- Per-step sandbox clamp, env-allowlist isolation, output/prompt bounds, concurrency
  caps, timeout paths — all inherited unchanged from v1's `codex-endpoints.js`-style
  coverage.
- Bearer auth + CSRF.

---

## 8. Deliberately deferred (post-v1)

Carried over from v1, still deferred:

- **Visual DAG builder / condition-router / retry / evaluation node types.** The
  `workflow` data shape is graph-ready from day one (D9's design intentionally avoids
  a future breaking migration), but v1's UI only authors the four fixed orchestration
  modes — no graph editor, no branching logic beyond the built-in parallel fan-out.
- **Multi-turn agent-to-agent chat protocols.**
- **`agentic_start_run`/approve/reject as agent-service tools** (D7) — human-only by
  design, not just "not yet."
- **`agentic-mcp` as a selectable connection target** — fork-bomb shape, out of scope
  entirely.
- **Shared agent library UI** — agents are already reusable by id across Agentic AIs;
  a dedicated browsing/search library page is deferred.
- **Templates** — ✅ SHIPPED (iter7, post-v1): export/import/clone an Agentic AI as a
  portable, self-contained JSON (embeds its agents + connections; import recreates with
  fresh ids + remapped refs, validate-first + rollback). A **marketplace/registry** for
  sharing templates across users/installs is still deferred.
- **Scheduled/event-triggered runs, cost/token budgets, evaluation datasets** — still
  deferred (candidate post-v1 iterations).
- **The generalized multi-artifact registry** (D8) — explicitly deferred a fourth
  time here; if ever built, it must be horizontal across Kanban/PM/Agentic AI, not
  bespoke to this artifact.

---

## 9. Open decisions worth confirming before build

- **Claude CLI headless invocation shape** — ✅ **RESOLVED** (verified against
  installed v2.1.220, §0): `claude -p "<prompt>" --output-format stream-json
--permission-mode <mode> --append-system-prompt <p> --mcp-config <file>
--strict-mcp-config`. No longer a blocker for the `claude-cli` provider (D6). Keep
  `CLAUDE_DEFAULT_PERMISSION_MODE` (§10) conservative to start regardless.
- **`AGENT_MCP_APPROVAL_TIMEOUT_MS` tuning** — how long the proxy (D5) should hold an
  `approval`-tier call open before returning `approval_pending_timeout` to the CLI.
  Too short and routine approvals get spuriously killed; too long and a stuck CLI
  ties up a slot against `AGENT_MAX_CONCURRENT_RUNS`. Recommend a conservative default
  (a few minutes) and making it visibly configurable rather than guessing once.
- **Parallel fan-out width** — should `AGENT_MAX_PARALLEL_FANOUT` (§10) cap how many
  simultaneous agent-task tmux jobs one parallel-group step may spawn, independent of
  the whole-system `AGENT_MAX_CONCURRENT_RUNS`? Recommend yes — a single misconfigured
  parallel step shouldn't be able to consume the entire system-wide run budget alone.
- **`parallel` mode + `workspace-write` collision** — unchanged from v1: recommend
  restricting `parallel` to `read-only` agents, requiring `sequential`/`supervisor`
  for anything `workspace-write`.
- **MCP token scoping (D-Token) — ✅ RESOLVED (iter5, 2026-07-29).** Implemented and
  now **ENABLED BY DEFAULT** (`AGENT_MCP_SCOPED_TOKENS`, §10): each agent-task with
  connections is handed a freshly-minted, short-lived, capability-scoped bearer in its
  mcp.json instead of the shared `GATEWAY_API_TOKEN`. A leaked copy reaches ONLY the
  agent's connected artifact prefixes (`/api/pm`/`/api/kanban`) and its OWN
  pending-tool-call callback — never approve/reject (also cookie-only), Agentic
  CRUD/run, or another run's callback — and is revoked when the run ends. Side benefit:
  agentic MCP works in prod with NO shared token configured. Proven by a test that reads
  the actual minted token from the run's mcp.json and asserts the boundary. Honest
  residual (deferred): a scoped token still permits direct REST to its _connected
  artifact_, so it bounds WHICH artifact, not WHICH tool — full per-tool closure (proxy
  children never holding a gateway-callable token) is a later refinement. Also iter5:
  codex-cli agents with artifact connections are **fail-closed at run start**
  (`codex_mcp_unsupported`) since codex's ambient MCP can't be mediated (isolating
  `CODEX_HOME` breaks its auth — verified).
- **"Send guidance" — ✅ RESOLVED (iter6, 2026-07-29), via resume, NOT interactive
  panes.** The original worry (needing an interactive tmux pane + keystroke injection)
  was avoided: each claude-cli node runs turn 1 with a controlled `--session-id <uuid>`;
  a human then POSTs `/runs/:id/nodes/:nodeId/guidance {text}` (HUMAN-COOKIE-ONLY, like
  approve/reject — a leaked scoped token can't trigger it), which clears the node's
  stale markers, re-materializes the prompt = the guidance text with `--resume <uuid>`,
  and respawns the SAME detached tmux job as a new turn (`turns++`); a `completed` run
  is reopened to `running` and the normal reducer/reap advances it. Stays fully within
  the survivable batch model — no interactive pane, no keystroke path. `codex-cli`
  guidance is fail-closed (no resume support). Proven by a test that runs a claude node
  to done, sends guidance, and asserts turn 2 resumed (`--session-id` then `--resume`,
  `turns==2`) + bearer→403. Known edge (documented): a gateway crash in the ~ms window
  between recording the turn and spawning it re-runs the node's ORIGINAL objective (the
  guidance text isn't durably persisted); acceptable — retry the guidance.

---

## 10. Configuration (env)

All new/changed vars are optional; an unconfigured gateway boots and behaves exactly
per the defaults below.

```bash
# ---- Agentic AI Creator artifact (data/agentic.json + POST /api/agentic/*) ----
# Sidecar store path override (mirrors AGENTS_FILE from v1, renamed for v2's entities).
# AGENTIC_FILE=data/agentic.json
# Per-step scratch space: prompt file, log file, exit-code marker, scoped MCP
# config pointed at the per-run proxy. One subdirectory per node-execution.
# AGENT_RUNS_DIR=data/agentic-runs

# ---- Backend CLI invocation (unchanged from v1) ----
# CODEX_COMMAND=codex
# CLAUDE_COMMAND=claude
# CLAUDE_DEFAULT_PERMISSION_MODE=plan

# ---- Per-step bounds & timeouts (unchanged from v1) ----
# AGENT_RUN_TIMEOUT_MS=1800000
# AGENT_RUN_RETENTION_MS=604800000
# AGENT_PROMPT_MAX_BYTES=16384
# AGENT_OUTPUT_MAX_BYTES=131072
# AGENT_MAX_CONCURRENT_RUNS=4

# ---- Whole-workflow bounds (new in v2) ----
# Notify-again threshold for a run stuck waiting on human approval. Never
# auto-cancels — see §1 D3.
# AGENTIC_RUN_MAX_AGE_MS=259200000
# Cap on simultaneous agent-task jobs one parallel-group step may spawn,
# independent of the system-wide AGENT_MAX_CONCURRENT_RUNS.
# AGENT_MAX_PARALLEL_FANOUT=4

# ---- Per-run MCP proxy (D5, new in v2 — replaces v1's AGENT_MCP_SCOPED_TOKENS
# toggle on the CLI's own config; the CLI never holds a real credential now, only
# a connection to the proxy) ----
# How long an "approval"-tier tool call may sit open before the proxy returns
# approval_pending_timeout to the calling CLI (§9).
# AGENT_MCP_APPROVAL_TIMEOUT_MS=180000
# 0 (default) = the proxy forwards approved calls using the shared
# GATEWAY_API_TOKEN / KANBAN_API_TOKEN. 1 = the proxy forwards using a minted
# short-lived, path-scoped token instead (more moving parts, tighter audit).
# AGENT_MCP_SCOPED_TOKENS=0
# AGENT_MCP_TOKEN_TTL_MS=3600000
```

## Critical files

- `apps/terminal-gateway/src/agentic.js` — **new** store (mirrors `pm.js`'s no-mutex
  convention; replaces v1's `agents.js`).
- `apps/terminal-gateway/src/server.js` — `/api/agentic/*` branches; per-step
  tmux-wrapper spawn logic (D3 layer 1, reused from v1); the reducer/boot-rediscovery
  logic (D3 layer 2, new); spawning + lifecycle of the per-run proxy (D5).
- `tools/agentic-proxy/server.mjs` — **new** — the per-run MCP-mediating proxy (D5).
- `apps/terminal-gateway/test/agentic-endpoints.js` — **new** `test:agentic`.
- `packages/shared-types/src/terminal.ts` + `index.ts` — Agent/Connection/AgenticAI/
  Run/NodeExecution schemas.
- `apps/agent-service/src/tools.ts`, `gateway-client.ts` — CRUD + workflow-editing
  tools (D7).
- `tools/agentic-mcp/server.mjs` — **new** — MCP server for external AI clients (§4b).
- `apps/terminal/.../components/agentic-dialog.tsx` — **new** host modal.
- `apps/terminal/public/agentic/app.html` — **new** — catalog + builder + run +
  history views, all in the one artifact (D8).
- `apps/terminal/src/features/terminal/{store.ts,components/terminal-shell.tsx}` —
  flag + button.
- `apps/terminal-gateway/.env.example` — new §10 config block.
- `docs/AGENT-CREATOR-PLAN.md` — mark superseded, point to this document.
