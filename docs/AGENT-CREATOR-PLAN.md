# Agent Creator (pluggable HTML artifact) — Design & Implementation Plan

> **SUPERSEDED (2026-07-28)** — see `docs/AGENTIC-AI-CREATOR-PLAN.md` for the current
> design (v2). This v1 draft is kept for history; it does not reflect the two-layer
> survivability model, per-tool MCP proxy, runtime-provider abstraction, run
> versioning, or the settled publish/hosting decision (D8 in the v2 doc) that came out
> of the follow-up design review. Do not build against this file.

> Status: **proposed** (2026-07-28) — design idea only, not yet built. Written the same
> day as the PM artifact's workflow/issue-model/collaboration extension, and modeled
> directly on the two shipped artifacts (`docs/KANBAN-PLAN.md`, `docs/PM-TOOL-PLAN.md`).
> This document is a strawman for review, not a committed spec — several decisions below
> are marked **OPEN** and need a call before build starts (see §9).
>
> Scope: a third pluggable artifact that lets a user **define, configure, and run
> agentic AI agents** — backed by the **Claude Code CLI** or the **Codex CLI** as the
> actual execution engine — individually or grouped into a **Team**. Agents declare which
> of this system's existing artifact MCP servers (pm-mcp, kanban-mcp, future ones) they
> may reach when they run. Like Kanban and PM, it is owned end-to-end by the **gateway**
> (a new `agents.json` sidecar + `/api/agents/*` REST), with a self-contained HTML UI
> loaded into a sandboxed `<iframe>` modal, callable by both the in-app agent and an
> external AI CLI.

Unlike Kanban and PM, this artifact's core feature is **running a process**, not just
storing state — it is the first pluggable artifact with an execution/job component. That
single fact drives most of the decisions below, because this repo already has a strong,
load-bearing opinion about what "running a process" must mean (see D3).

---

## 0. Grounding (verified against source)

Every decision below anchors to an existing pattern in the repo (mirrors, not invents):

- **Sidecar store convention**: `apps/terminal-gateway/src/{kanban,pm}.js` — module-level
  store, `load()` at module bottom, atomic `persist()` (`writeFileSync(TMP)` +
  `renameSync`), env-overridable file path for tests. The PM store in particular proved
  that **synchronous mutators need no mutex** (atomicity is free in a single-threaded
  event loop) — a refinement over Kanban's original explicit async mutex. Agent Creator
  follows the PM convention.
- **Routes**: `apps/terminal-gateway/src/server.js` — flat if-ladder per prefix
  (`handleKanban`/`handlePm`), Origin/CSRF guard fires only on state-changing methods and
  only when an `Origin` header is present (so bearer-token CLI calls skip it for free),
  64 KB body cap, shared `isArtifactBearerAuthorized` helper (`GATEWAY_API_TOKEN ||
KANBAN_API_TOKEN`) already generalized across artifacts (PM's D10) — Agent Creator
  reuses this same helper rather than minting a third token.
- **The `run_codex` security template** (`server.js`, route `POST
/api/sessions/:id/codex`) — the existing precedent for "the gateway spawns an
  agentic CLI on the user's behalf": gateway is the sole enforcement point, prompt is
  never in argv, sandbox mode is clamped to a small enum, env is a curated allowlist (not
  the gateway's full `process.env`), output is bounded, and there is a documented,
  honest caveat that the sandbox governs writes/exec, not read scope. Agent Creator's
  execution path (§1, D3) reuses this template wholesale rather than reinventing
  process-spawning security from scratch.
- **Multi-server exec seams**: `serverExecArgv`/`serverExec` (tmux-only, used by session
  attach) vs. `serverCmdArgv`/`serverCmd`/`serverCmdStdin` (non-tmux, used by fs/git/codex)
  — both resolve to either a local child process or `ssh -tt …`/`ssh …` for a registered
  remote server. A tmux-backed run (D3) uses the **tmux seam**, not the non-tmux one, since
  the whole point is a session the gateway can reattach to.
- **Agent-service tool + approval pattern**: `apps/agent-service/src/tools.ts` +
  `docs/AGENT-PROTOCOL.md` — `WRITE_TOOLS` gates approval (allow / allow-always / deny);
  `ONE_TIME_TOOLS` coerces the most dangerous writes (`run_codex`, `browser_act`,
  `kanban_delete`, `pm_delete_project`) to per-call re-approval; some destructive actions
  (`kill_session`, `pm_delete_task`, card delete) are **not exposed as agent tools at all**
  — human-only in the UI. Agent Creator's own "run" action is at least as dangerous as
  `run_codex` (§1, D6).
- **MCP registration**: `tools/{kanban,pm}-mcp/server.mjs` — dependency-free stdio
  JSON-RPC servers, thin REST clients using the shared bearer token, registered via
  `claude mcp add <name> -e TOKEN=... -e BASE_URL=... -- node <path>/server.mjs` or Codex's
  `~/.codex/config.toml [mcp_servers.<name>]`.
- **Claude Code CLI has no `--mcp-config` / `--strict-mcp-config` flag** (checked against
  current CLI docs while drafting this plan). MCP servers are registered via `claude mcp
add` (persistent, user/project scope) or a project-level `.mcp.json` file — there is no
  per-invocation config-injection flag analogous to Codex's `CODEX_HOME`. This materially
  shapes §1 D5 and is flagged again in §9.

---

## 1. Architectural decisions (settled before implementation)

**D1 — Ownership: the gateway, not agent-service.** Same reasoning as Kanban/PM: agent
definitions, teams, and run records are gateway-owned state; the browser reaches them
same-origin via `/api`; agent-service touches Agent Creator **only** as a REST client, so
the gateway remains the single enforcement point for spawning any CLI process. This is
even more important here than for Kanban/PM, because the "state" being protected includes
literal process-spawn capability, not just JSON.

**D2 — Storage: `data/agents.json` sidecar, atomic write, no mutex.** A new
`apps/terminal-gateway/src/agents.js` sibling to `kanban.js`/`pm.js`, following PM's
synchronous-mutator convention (no async lock needed). `AGENTS_FILE` env override for
tests. Three top-level collections: `agents`, `teams`, `runs` (§2). No database.

**D3 — Run survivability: a run is a detached tmux session, not a synchronous child
process.** This is the load-bearing decision of the whole plan. `run_codex` blocks
synchronously for up to `CODEX_TIMEOUT_MS` (180s default) and dies if the gateway
restarts — acceptable for a single bounded task, wrong for an agent run that may take
minutes and that a user may want to walk away from. The repo's entire premise is that
**jobs survive the browser and the gateway**; an "agent run" is a job, so it gets the same
treatment sessions get:

- `POST /api/agents/:id/run` creates a `Run` record and spawns
  `tmux new-session -d -s web-agent-<runId> -- <wrapper>` through the existing tmux exec
  seam (local or SSH, matching the target session's own server) — never a bare
  `execFile`/`spawn` held open by the gateway process itself.
- The wrapper script (materialized once per run, not templated per-agent) writes the
  prompt to a private temp file (mode `0600`, cleaned up after use — **never argv, never
  a literal in the tmux command line**, mirroring `run_codex`'s stdin-piping discipline),
  invokes the resolved CLI command redirecting stdout+stderr to a log file, and on exit
  writes the exit code to a small marker file (parallel to how the push-notification
  feature already reads `pane_current_command` transitions and a tmux option for exit
  code — this reuses that established idiom rather than inventing a new one).
- The gateway never polls with a busy loop that must stay alive — `GET
/api/agents/runs/:id` does a cheap `tmux has-session` check + tails the log/marker
  file on demand. A restarted gateway rediscovers in-flight runs exactly like it
  rediscovers tmux sessions today (`tmux ls` on boot), no run state is lost.
- Killing a run is `tmux kill-session -t web-agent-<runId>` — the same one kill-path
  discipline as session `DELETE`.
- **Survivable is not the same as unbounded.** Unlike a human-attached tmux session, a
  run has no human watching it, so it still needs a wall-clock safety net — a run that
  hangs forever (bad prompt, backend stuck waiting on input despite non-interactive
  flags) must not accumulate forever. The gateway force-kills the tmux session past
  `AGENT_RUN_TIMEOUT_MS` (§10), marking the run `timeout` — distinct from `run_codex`'s
  180s default in that this cap exists purely as a backstop, not the expected duration.
- Per-run temp state (prompt file, log file, exit-code marker, scoped MCP config dir —
  §1 D5) lives under `AGENT_RUNS_DIR` (§10), one subdirectory per run, swept on a
  retention timer (`AGENT_RUN_RETENTION_MS`, §10) so disk doesn't grow unbounded from
  finished runs.

Rejected alternative: reuse `run_codex`'s synchronous `serverCmdStdin` call as-is. Simpler,
but caps every run at ~3 minutes and makes "close the tab, come back later" — this whole
repo's signature feature — not work for the one artifact that most wants it.

**D4 — Reuse the `run_codex` security template inside the tmux wrapper.** Sandbox mode
clamped to an enum (`read-only` | `workspace-write`) — the enum values themselves stay
code-fixed, not env-configurable, matching `run_codex`'s existing posture that safety-
critical enums are not operator-tunable. Env is the same curated allowlist
(`PATH`/`HOME`/`USER`/`TERM`/`LANG`/`LC_*`/`SHELL`/`TMPDIR`/`XDG_*`) plus the relevant
credential-prefix passthrough per backend (`CODEX_*`/`OPENAI_*` for Codex,
`ANTHROPIC_*`/`CLAUDE_*` for Claude) — never the gateway's full environment (auth hash,
VAPID keys, other artifacts' tokens must never reach a spawned agent). The base allowlist
stays hardcoded for the same reason (`CODEX_ENV_ALLOWLIST` today is a code constant, not
an env override — widening it should be a code review, not a deploy-time footgun).
Output is bounded by tailing the log file (`AGENT_OUTPUT_MAX_BYTES`, default mirrors
Codex's 128 KB) rather than buffering unboundedly, and the prompt is capped
(`AGENT_PROMPT_MAX_BYTES`, default mirrors Codex's 16 KB) before it's written to the temp
file. The backend binary itself is overridable per backend (`CODEX_COMMAND`, already
existing; new `CLAUDE_COMMAND`, §10) purely for test stubbing and nonstandard install
paths — same convention as `run_codex`. The same honest caveat from `run_codex` applies
and must be documented again here: sandbox mode governs writes/exec, not read scope —
per-run human approval (D6) is the real control.

**D5 — MCP-connection scoping is per-run, config-file-based, and backend-specific.** An
Agent declares `mcpServers: string[]` (ids like `"pm"`, `"kanban"`) at definition time.
At run time the wrapper materializes a **scoped, temporary** MCP config containing only
the selected servers, pointed at the shared bearer token:

- **Codex**: a per-run temp directory used as `CODEX_HOME`, with a generated
  `config.toml` `[mcp_servers.*]` block for exactly the selected servers. Codex reads
  `$CODEX_HOME/.codex/config.toml` and nothing else, so unselected servers are simply
  absent from its view — this is the clean case.
- **Claude**: since there is no per-invocation config-injection flag (§0), scoping goes
  through a generated `.mcp.json` dropped in a per-run temp working directory, with the
  actual target cwd passed separately (or the CLI invoked from that temp directory with
  the real working path passed as a task-scoped instruction). This is a **softer**
  boundary than Codex's `CODEX_HOME` isolation and is flagged again in §9 — it needs
  verification against current Claude Code CLI project-scope `.mcp.json` discovery rules
  before this is trusted as a hard boundary.

The bearer token written into that scoped config is, per the open **D-Token** decision
(§9), controlled by `AGENT_MCP_SCOPED_TOKENS` (§10): `0` (default, simplest) bakes in the
same shared `GATEWAY_API_TOKEN`/`KANBAN_API_TOKEN` every artifact already accepts; `1`
switches to minting a short-lived, path-scoped token per run (TTL `AGENT_MCP_TOKEN_TTL_MS`,
§10), restricted server-side to only the artifact prefixes the agent's `mcpServers`
selection names. Making this an env toggle rather than a single baked-in choice lets an
operator start simple and turn on the stronger boundary later without a code change.

**D6 — Agent-service exposure: no `run_agent` tool in v1; CRUD tools only.** Running an
Agent is at least as dangerous as `run_codex` (it spawns a real CLI process, potentially
with `workspace-write`, potentially with MCP write access to Kanban/PM) — arguably more
so, since it can run unattended for minutes. Following the repo's precedent of leaving
some destructive/high-blast-radius actions **out of the agent tool surface entirely**
(`kill_session`, `pm_delete_task`), v1 exposes only:

- **Reads** (`agents_list`, `agents_get`, `runs_list`, `runs_get`) — auto, not gated.
- **Routine writes** (`agents_create`, `agents_update`, `teams_create`, `teams_update`) —
  gated, allow-always permitted (defining an agent has no side effect until it's run).
- **Destructive** (`agents_delete`, `teams_delete`) — coerced one-time.
- **No `run_agent` / `run_team` tool.** Starting a run is a human-click action in the
  artifact UI only, for v1. This is revisited post-v1 (§8) once real usage patterns exist.
- Every run request (human or, later, agent-tool-driven) is subject to a global cap,
  `AGENT_MAX_CONCURRENT_RUNS` (§10) — beyond it, `POST .../run` returns `429
too_many_runs` rather than silently queuing or, worse, spawning unboundedly many
  real LLM-calling CLI processes.
- For the `claude` backend specifically, the headless permission mode (§0, §9) defaults
  to the safest available option and is operator-tunable via
  `CLAUDE_DEFAULT_PERMISSION_MODE` (§10) — start conservative, relax post-launch once
  behavior is observed, without needing a code change to do so.

**D7 — "Pluggable" = the same host-seam pattern as Kanban/PM, unchanged.** The config UI
is one self-contained HTML file (`apps/terminal/public/agents/app.html`, inline CSS+JS,
zero deps) in a same-origin sandboxed `<iframe>` inside a controlled Dialog — the sandbox
is DOM/CSS/JS isolation for pluggability, not a security boundary (same honest note as
Kanban D6). Agent Creator does not attempt to generalize the artifact-hosting mechanism
into a shared plugin framework; that remains explicitly deferred across all three
artifacts.

**D8 — Global, gateway-scoped, not session/server-scoped for definitions; per-run target
is explicit.** Like Kanban (D7 there), Agent _definitions_ and _teams_ are not tied to any
particular tmux session — they're reusable configs. A _run_, however, always targets one
specific session's cwd/server explicitly chosen at run-start time (mirroring `run_codex`,
which is already session-scoped). The header button that opens the artifact is always
enabled; the "Run" action inside the artifact requires picking a target session.

---

## 2. Data model (`data/agents.json`)

```jsonc
{
  "agents": {
    "ag-<uuid>": {
      "id": "ag-<uuid>",
      "name": "Code reviewer",
      "backend": "codex", // "codex" | "claude"
      "systemPrompt": "…",
      "sandboxMode": "read-only", // "read-only" | "workspace-write"
      "mcpServers": ["pm", "kanban"], // ids of THIS system's registered artifact MCPs
      "model": null, // optional backend model override
      "rev": 3,
      "createdAt": 1785200000000,
      "updatedAt": 1785200000000,
    },
  },
  "teams": {
    "tm-<uuid>": {
      "id": "tm-<uuid>",
      "name": "Ship review",
      "agentIds": ["ag-a", "ag-b"], // order IS the pipeline order (D-style ordering authority)
      "mode": "sequential", // "sequential" | "parallel"
      "rev": 1,
      "createdAt": 1785200000000,
      "updatedAt": 1785200000000,
    },
  },
  "runs": {
    "run-<uuid>": {
      "id": "run-<uuid>",
      "agentId": "ag-a", // exactly one of agentId / teamId is set
      "teamId": null,
      "sessionId": "local/web-<uuid>", // target session (server + cwd resolved from it)
      "tmuxName": "web-agent-run-<uuid>",
      "logFile": "run-<uuid>.log",
      "status": "running", // "running" | "done" | "failed" | "timeout" | "killed"
      "exitCode": null,
      "startedAt": 1785200000000,
      "finishedAt": null,
    },
  },
}
```

`agentIds[]` on a Team is its own ordering authority (mirrors `Column.taskIds[]` /
`Column.cardIds[]` in PM/Kanban) — no duplicated "position" field on the agent. `runs` is
append-only; no `rev` needed since nothing external ever races a run record (only the
gateway's own poll/marker-file read updates it).

`agents.js` API (all mutators synchronous + atomic-persisting, PM-style, no mutex):
`load()`, `listAgents()`, `getAgent(id)`, `createAgent({...})`, `updateAgent(id,{...})`,
`deleteAgent(id)`, `listTeams()`, `getTeam(id)`, `createTeam({...})`, `updateTeam(id,{...})`,
`deleteTeam(id)`, `startRun({agentId|teamId, sessionId})` (spawns the tmux session, D3),
`getRun(id)` (live status via `tmux has-session` + log tail), `listRuns()`, `killRun(id)`.

---

## 3. Backend endpoints (`/api/agents/*` in `server.js`)

Same Origin/CSRF + bearer-or-cookie auth pattern as Kanban/PM (§0). Reads GET
(Origin-exempt); writes carry the Origin/CSRF guard.

### Read routes (GET — Origin-exempt)

| Route                         | Returns                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/agents`             | `{ agents: Agent[] }` — list                                                                                       |
| `GET /api/agents/:id`         | `Agent`                                                                                                            |
| `GET /api/agents/teams`       | `{ teams: Team[] }`                                                                                                |
| `GET /api/agents/teams/:id`   | `Team`                                                                                                             |
| `GET /api/agents/runs`        | `{ runs: RunSummary[] }`                                                                                           |
| `GET /api/agents/runs/:id`    | `Run` + tailed log excerpt                                                                                         |
| `GET /api/agents/mcp-servers` | `{ servers: {id,name}[] }` — enumerates registered artifact MCPs (pm, kanban, …) for the config UI's checkbox list |

### Write routes (state-changing — Origin-checked)

| Route                            | Body                                                              | Result                                      |
| -------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `POST /api/agents`               | `{name, backend, systemPrompt, sandboxMode, mcpServers?, model?}` | 201 `Agent`                                 |
| `PATCH /api/agents/:id`          | partial fields                                                    | 200 `Agent`                                 |
| `DELETE /api/agents/:id`         | —                                                                 | 204                                         |
| `POST /api/agents/teams`         | `{name, agentIds, mode}`                                          | 201 `Team`                                  |
| `PATCH /api/agents/teams/:id`    | partial fields                                                    | 200 `Team`                                  |
| `DELETE /api/agents/teams/:id`   | —                                                                 | 204                                         |
| `POST /api/agents/:id/run`       | `{sessionId}`                                                     | 202 `Run` — starts the tmux-backed run (D3) |
| `POST /api/agents/teams/:id/run` | `{sessionId}`                                                     | 202 `Run`                                   |
| `DELETE /api/agents/runs/:id`    | —                                                                 | 204 — kills the tmux session                |

Errors: 400 malformed/validation, 401 unauthorized, 403 forbidden origin, 404 unknown
agent/team/run, 413 body too large, 503 `backend_unavailable` (mirrors `codex_unavailable`)
if the CLI binary isn't found on the target server.

### Zod schemas — add to `packages/shared-types/src/terminal.ts`

`AgentBackend` (`z.enum(["codex","claude"])`), `AgentSandboxMode`, `Agent`, `Team`, `Run`,
`RunSummary`, `Create/UpdateAgentRequest`, `Create/UpdateTeamRequest`, `RunAgentRequest`,
plus list-response wrappers; re-exported from `index.ts` under a
`// REST: Agent Creator /api/agents/*` banner.

---

## 4. AI access

### 4a. In-app agent (`apps/agent-service/src/tools.ts` + `gateway-client.ts`)

Per **D6**: `agents_list`, `agents_get`, `agents_create`, `agents_update`, `agents_delete`,
`teams_list`, `teams_get`, `teams_create`, `teams_update`, `teams_delete`, `runs_list`,
`runs_get`. No `run_agent`/`run_team` tool in v1 — starting a run stays a human action in
the artifact UI.

### 4b. External AI (Claude/Codex CLI) — MCP server (`tools/agents-mcp/server.mjs`)

Same shape as `tools/{kanban,pm}-mcp/server.mjs` — a thin stdio JSON-RPC REST client using
the shared bearer token, mirroring the §3 routes. Note the recursion this makes possible:
an external Claude session with `agents-mcp` registered could define and run Agent Creator
agents itself. This is acknowledged but **`agents-mcp` is never itself a selectable
`mcpServers` entry for a spawned Agent** — an agent that can spawn agents is a fork-bomb
shape and is out of scope (§8).

---

## 5. Frontend

### 5a. Store (`features/terminal/store.ts`)

Add `agentsOpen: boolean` + `setAgentsOpen(open)`, ephemeral (persist-excluded), mirroring
`kanbanOpen`/`pmOpen`.

### 5b. Header button (`components/terminal-shell.tsx`)

Ghost icon `Button` (lucide — e.g. `Bot` or `Workflow`), always enabled (D8, definitions
aren't session-scoped), `Tooltip` "Agent Creator". `?agents` URL flag via
`useUrlFlagSync`.

### 5c. Host modal (`components/agents-dialog.tsx`)

Thin controlled `Dialog`, iframe body:

```tsx
<iframe
  src="/agents/app.html"
  title="Agent Creator"
  sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
  className="h-full w-full border-0"
/>
```

### 5d. The artifact (`apps/terminal/public/agents/app.html`)

Self-contained, three views:

- **Agents** — cards (name, backend badge, MCP-server chips, sandbox badge); "New Agent"
  form: name, backend radio (Claude/Codex), system-prompt textarea, sandbox-mode select,
  **MCP-server checkboxes** populated from `GET /api/agents/mcp-servers` (this is the
  concrete answer to "UI to config at least an option to select which artifact MCPs to
  connect"), optional model override.
- **Teams** — name, ordered agent list (add/remove/reorder — reorder is a plain array
  splice, no drag-and-drop required for v1), sequential/parallel toggle.
- **Runs** — table: status (running/done/failed/killed), agent or team name, target
  session, started/duration, truncated output preview; click to expand full tailed log;
  Kill button while running. Poll-based refresh (no WebSocket in v1, §8).

Palette hardcoded to mirror DESIGN.md, same documented exception as Kanban/PM.

---

## 6. Phased implementation checklist

1. **Verify the Claude CLI headless invocation shape first** (§0, §9) — this gates
   everything else for the `claude` backend. Confirm exact flags for non-interactive
   one-shot execution, output capture, and `.mcp.json` project-scope discovery rules
   against the currently-installed Claude Code CLI version before writing the wrapper.
2. **Backend**: `agents.js` store, shared-types schemas, `/api/agents/*` CRUD routes
   (agents + teams, no run yet).
3. **Run execution**: the tmux wrapper script, `POST .../run`, `GET .../runs/:id` status
   polling, `DELETE .../runs/:id` kill — the highest-risk, highest-interpretation-risk
   slice. **Checkpoint with the user before this step.**
4. **Gateway test** `test/agents-endpoints.js` (`test:agents`) — CRUD, run-lifecycle
   (start → poll → completes), kill, bearer auth, CSRF, sandbox-mode clamp, env-isolation
   (mirrors `codex-endpoints.js`).
5. **Agent tools** — CRUD-only per D6, `gateway-client.ts` methods, `tools.ts` cases,
   `tools.test.ts` assertions.
6. **Frontend** — store slice, header button, `agents-dialog.tsx`, URL flag.
7. **Artifact** `public/agents/app.html`. **Checkpoint with the user before this step.**
8. Docs: `docs/TERMINAL-PROTOCOL.md` + `docs/AGENT-PROTOCOL.md` Agent Creator section;
   update `CLAUDE.md` status + Layout.

---

## 7. Testing (planned; not yet written)

`apps/terminal-gateway/test/agents-endpoints.js` (`test:agents`), same standalone-script
convention as `kanban-endpoints.js`/`pm-endpoints.js`: agent/team CRUD; run lifecycle
(start a trivial stub-backend run via `CODEX_COMMAND`/`CLAUDE_COMMAND` pointed at a test
stub, poll until `done`, assert exit code + log content); timeout path (`AGENT_RUN_TIMEOUT_MS`
set low in-test, assert force-kill → `timeout` status); kill mid-run; sandbox-mode clamp →
400 for anything outside the enum; env-allowlist isolation (assert gateway secrets never
reach the spawned process's env, mirroring `codex-endpoints.js`'s env-isolation check);
concurrency cap (`AGENT_MAX_CONCURRENT_RUNS` set low in-test, assert 429 past it); bearer
auth + CSRF; 503 when the backend binary is missing.

---

## 8. Deliberately deferred (post-v1)

- **Visual DAG builder** for multi-agent workflows — v1 Teams are a flat ordered list
  (sequential or parallel), not a graph.
- **Multi-turn agent-to-agent chat protocols** — agents in a Team run independently
  (optionally sharing MCP-visible state like a PM board), not via a conversational
  handoff mechanism.
- **`run_agent`/`run_team` as an agent-service tool** — v1 keeps run-starting human-only
  (D6); revisit once there's real usage data on blast radius.
- **`agents-mcp` as a selectable MCP server for spawned agents** — the fork-bomb shape
  (§4b) stays out of scope entirely, not just deferred.
- **Marketplace / sharing of agent definitions** — export/import JSON is the escape
  hatch; no registry.
- **Auto-retry / self-healing runs** — a failed run is failed; a human reviews and
  re-runs.
- **Live-streamed run output** — v1 polls and tails a log file; a WebSocket upgrade on
  the run endpoint is a natural post-v1 addition, not required for a first cut.
- **Per-run scoped tokens** (§9, D-Token) if the shared-token approach is chosen for v1.

---

## 9. Open decisions worth confirming before build

- **Claude CLI headless invocation shape** — unverified in this repo (§0). Must confirm
  current flags for non-interactive execution, output-format, and permission-mode before
  the wrapper script (§1 D3/D4) can be written for the `claude` backend. Recommend
  starting any headless Claude run at the safest permission mode available and only
  relaxing it after observing real runs, mirroring how `run_codex` clamps to
  `read-only`/`workspace-write` rather than defaulting to full access.
- **MCP token scoping (D-Token)** — reuse the shared `GATEWAY_API_TOKEN` for every
  spawned agent's scoped MCP config (simple, but the token still authorizes the whole
  `/api/*` surface regardless of which servers were "selected" in the UI — selection only
  controls which _tools_ are presented, not what the token can reach if the process
  decides to call the REST API directly), **or** mint short-lived, path-scoped per-run
  tokens the gateway restricts to the selected artifact prefixes only (a real capability
  boundary, more machinery: token minting/expiry/revocation). Recommend the scoped-token
  approach for v1 given this artifact's higher blast radius than Kanban/PM, but flagging
  it as the single most expensive item in this plan.
- **Claude `.mcp.json` scoping robustness** (§1 D5) — needs verification that a
  project-scope `.mcp.json` in a per-run temp directory is actually honored the way a
  Codex `CODEX_HOME` config is, given no dedicated per-invocation flag exists for Claude.
  If it isn't reliable, the fallback is coarser: Claude-backed agents may need to accept
  _all_ registered MCP servers rather than a real subset for v1, with that limitation
  documented rather than silently dropped.
- **Run concurrency limits** — should there be a cap on simultaneous running Agents/Teams
  (per user, or system-wide), given each is a real CLI process potentially calling out to
  an LLM API? Recommend an env-configurable cap, `AGENT_MAX_CONCURRENT_RUNS` (§10,
  default 4) rather than either an uncapped system or a value fixed in code — the right
  number depends on host resources and provider rate limits an operator can see and the
  gateway can't guess.
- **Team `parallel` mode semantics** — do parallel agents in a Team share one target
  session/cwd (risk of write collisions if `workspace-write`) or does each get an
  isolated checkout? Recommend restricting `parallel` mode to `read-only` sandbox agents
  for v1 and requiring `sequential` for anything `workspace-write`, closing off the
  collision risk entirely rather than managing it.

---

## 10. Configuration (env)

Following the repo's existing convention (`apps/terminal-gateway/.env.example`'s Codex/
Push sections): numeric bounds, timeouts, paths, and behavioral toggles are env-
configurable with safe defaults; security-critical enums (sandbox mode values, the base
env allowlist) stay hardcoded so widening them is a code review, not a deploy-time
config edit. All new vars are optional — an unconfigured gateway boots and behaves
exactly as the defaults below describe.

```bash
# ---- Agent Creator artifact (data/agents.json + POST /api/agents/*) ----
# Sidecar store path override (mirrors KANBAN_FILE / PM_FILE).
# AGENTS_FILE=data/agents.json
# Per-run scratch space: prompt file, log file, exit-code marker, scoped MCP
# config (CODEX_HOME / .mcp.json). One subdirectory per run.
# AGENT_RUNS_DIR=data/agent-runs

# ---- Backend CLI invocation (mirrors the existing Codex tool's overrides) ----
# CODEX_COMMAND already exists (see the Codex section above) and is reused as-is
# for codex-backed agents. New sibling for the Claude backend, same purpose
# (test stubbing / nonstandard install paths):
# CLAUDE_COMMAND=claude
# Default headless permission mode for claude-backed runs. Start at the safest
# available mode; only relax after observing real runs (see docs/AGENT-CREATOR-PLAN.md §9).
# CLAUDE_DEFAULT_PERMISSION_MODE=plan

# ---- Bounds & timeouts ----
# Wall-clock safety net per run (a run is survivable, not unbounded) — past this,
# the gateway force-kills the tmux session and marks the run `timeout`.
# AGENT_RUN_TIMEOUT_MS=1800000
# How long a finished run's temp dir + log stay on disk before cleanup sweeps them.
# AGENT_RUN_RETENTION_MS=604800000
# Cap on the piped prompt (mirrors Codex's 16KB) and the tailed run-log read
# (mirrors Codex's 128KB).
# AGENT_PROMPT_MAX_BYTES=16384
# AGENT_OUTPUT_MAX_BYTES=131072
# Global cap on simultaneously running Agents/Teams — beyond it, POST .../run
# returns 429 `too_many_runs` rather than spawning unboundedly many CLI processes.
# AGENT_MAX_CONCURRENT_RUNS=4

# ---- MCP-connection scoping for spawned agents (D-Token, docs/AGENT-CREATOR-PLAN.md §9) ----
# 0 (default) = every spawned agent's scoped MCP config carries the same shared
# GATEWAY_API_TOKEN / KANBAN_API_TOKEN every artifact already accepts (simple;
# selection only controls which tools are presented, not what the token can reach).
# 1 = mint a short-lived, path-scoped token per run, restricted server-side to
# only the artifact prefixes the agent's mcpServers selection names (a real
# capability boundary; more moving parts).
# AGENT_MCP_SCOPED_TOKENS=0
# TTL for a minted scoped token when AGENT_MCP_SCOPED_TOKENS=1 — long enough to
# cover one run, short enough to bound exposure if it leaks.
# AGENT_MCP_TOKEN_TTL_MS=3600000
```

## Critical files

- `apps/terminal-gateway/src/agents.js` — **new** store (mirrors `pm.js`'s no-mutex
  convention).
- `apps/terminal-gateway/src/server.js` — `/api/agents/*` branches, tmux-wrapper spawn
  logic reusing the `serverExecArgv` tmux seam, `run_codex`-style env allowlist + sandbox
  clamp.
- `apps/terminal-gateway/test/agents-endpoints.js` — **new** `test:agents`.
- `packages/shared-types/src/terminal.ts` + `index.ts` — Agent/Team/Run schemas.
- `apps/agent-service/src/tools.ts`, `gateway-client.ts` — CRUD-only agent tools (D6).
- `tools/agents-mcp/server.mjs` — **new** MCP server for external AI clients.
- `apps/terminal/src/features/terminal/components/agents-dialog.tsx` — **new** host modal.
- `apps/terminal/public/agents/app.html` — **new** the pluggable Agent Creator artifact.
- `apps/terminal/src/features/terminal/{store.ts,components/terminal-shell.tsx}` — flag +
  button.
- `apps/terminal-gateway/.env.example` — new §10 config block (`AGENTS_FILE`,
  `AGENT_RUNS_DIR`, `CLAUDE_COMMAND`, `AGENT_RUN_TIMEOUT_MS`, `AGENT_RUN_RETENTION_MS`,
  `AGENT_PROMPT_MAX_BYTES`, `AGENT_OUTPUT_MAX_BYTES`, `AGENT_MAX_CONCURRENT_RUNS`,
  `AGENT_MCP_SCOPED_TOKENS`, `AGENT_MCP_TOKEN_TTL_MS`, `CLAUDE_DEFAULT_PERMISSION_MODE`).
