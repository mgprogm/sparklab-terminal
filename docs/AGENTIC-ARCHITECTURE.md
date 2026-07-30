# Agentic AI Creator — Architecture and Design

This document is the implementation-level architecture for the Agentic AI Creator,
the terminal workspace's third gateway-owned pluggable artifact. It describes the
shipped system, not a replacement roadmap. The decisions and design history remain in
[AGENTIC-AI-CREATOR-PLAN.md](./AGENTIC-AI-CREATOR-PLAN.md),
[AGENTIC-RICHER-WORKFLOWS-PLAN.md](./AGENTIC-RICHER-WORKFLOWS-PLAN.md), and
[AGENTIC-RICHER-WORKFLOWS-II-PLAN.md](./AGENTIC-RICHER-WORKFLOWS-II-PLAN.md); the
current delivery ledger and deferred work are in
[AGENTIC-STATUS-AND-REMAINING.md](./AGENTIC-STATUS-AND-REMAINING.md).

The load-bearing implementation is:

- `apps/terminal-gateway/src/agentic.js`: synchronous store, workflow validation,
  persisted run ledger, atomic mutators, and pure `decide()` reducer.
- `apps/terminal-gateway/src/server.js`: `/api/agentic/*`, run and scheduler drivers,
  tmux/marker I/O, authentication, and scoped capability tokens.
- `apps/terminal-gateway/src/agent-runtime.js`: provider invocation seam and result
  parsing.
- `apps/terminal-gateway/src/agentic-schedules.js`: atomic schedule sidecar.
- `tools/agentic-proxy/server.mjs`: policy-enforcing MCP proxy.
- `packages/shared-types/src/terminal.ts`: public Zod contracts.
- `apps/terminal/public/agentic/app.html`: self-contained artifact frontend.

## 1. Overview and terminology

The ownership hierarchy is:

| Term           | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Creator**    | The single pluggable artifact: fixed, reviewed UI plus gateway API and stores.                                              |
| **Agentic AI** | A catalog entry inside the Creator: objective template, team, workflow, connections, budget, lifecycle status, and version. |
| **Agent**      | A reusable team member configured with a runtime provider, prompt, sandbox, model, and per-tool policies.                   |
| **Run**        | One immutable-version execution of an Agentic AI, potentially containing many provider invocations.                         |
| **Connection** | A declaration that an Agent may reach a gateway-owned artifact MCP target (`pm` or `kanban`) under policy.                  |

The Creator follows the same “one artifact, many records” model as Kanban boards and
PM projects. Publishing changes an Agentic AI's `status` to `published`; it does not
generate HTML, register a new header button, or create another artifact. In short,
**publish is a status, not an artifact**. This preserves a fixed, code-reviewed
frontend and is the settled D8 decision.

The gateway owns the feature end to end (D1). `agent-service` is not the run
orchestrator. The primary state is a JSON sidecar, routes are gateway routes, and all
tmux control remains behind the gateway's existing local/SSH execution seam.

## 2. Three-lifetime survivability model

D3 separates three lifetimes that must not be accidentally coupled:

1. **Browser lifetime.** Closing or refreshing the Creator loses no run position.
   Runs and their step ledger are server-side; the Run history can re-attach to them.
2. **Gateway-process lifetime.** Every provider step runs in a detached tmux session
   named `agrun-<runId>-<nodeId>`. The prefix is always `agrun-`, never `web-`, so
   these jobs do not enter terminal session listing, attachment, key injection, job
   notifications, or human-session deletion paths.
3. **Workflow lifetime.** The workflow position is the persisted
   `nodeExecutions[]` ledger, not an `await` chain or an in-memory program counter.
   `decide(run, resolvedConfig)` recomputes the next action from that ledger after
   every observation and after restart.

The step wrapper writes `start.marker` before invoking the provider and atomically
renames an `exit.marker` containing the exit code afterward. `spawnNode()` persists
`recordSpawned()` before materializing or spawning, and checks for an existing tmux
session before `new-session -d`. `reapRunningNodes()` combines session existence with
the two markers:

| Observation                           | Recovery decision                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Session alive, no exit marker         | Still running; kill and enter retry/failure policy only after the per-step timeout.             |
| Exit marker present                   | Reap the recorded exit, even if it completed while the gateway was down.                        |
| No session/exit, start marker present | The provider started and died; fail rather than risk duplicating a workspace write.             |
| No session and no markers             | The provider never ran; commit one crash-recovery respawn, then fail if that recovery is spent. |

`bootRediscoverRuns()` calls `advanceRun()` for every active run. Thus the same reap
table handles normal polling and boot—there is no separate, weaker recovery path.
`startAgenticLoop()` is gated by `listActiveRuns()` and the timer stops when the last
run becomes terminal. The schedule timer is independently gated by the count of
enabled schedules.

`decide()` is deliberately pure: no I/O, timers, mutation, retry state, budget state,
or live definition lookup. The validated workflow remains a DAG; loops are never
encoded as back-edges. Retry, routing result interpretation, evaluation metadata,
budgets, repeated iterations, scheduling, and unattended restrictions are all
**driver-owned policies**. This keeps restart recovery a replay of durable facts
rather than a reconstruction of lost control flow.

## 3. Data model and persistence

### 3.1 Stores

`agentic.js` persists `data/agentic.json` (or `AGENTIC_FILE`) with four maps:

| Collection    | Contents and mutation model                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `agents`      | Reusable provider configurations; synchronous CRUD, monotonic `rev`.                                 |
| `connections` | PM/Kanban MCP targets; synchronous create/delete, delete scrubs references.                          |
| `agenticAis`  | Catalog definitions; synchronous CRUD/status transitions, `rev`, and monotonic executable `version`. |
| `runs`        | Durable execution records; no client `rev` because only gateway driver/approval paths mutate them.   |

Every mutator performs a synchronous read-modify-write and one atomic
`writeFileSync(tmp)` + `renameSync(tmp, file)` persistence step. Read shapes are deep
copies. `agentic-schedules.js` separately persists
`data/agentic-schedules.json` (or `AGENT_SCHEDULES_FILE`) as an array, using the same
synchronous atomic-write discipline and logging corrupt JSON loudly.

### 3.2 Agentic AI and configuration freeze

An Agentic AI contains `agentIds`, `connectionIds`, `objectiveTemplate`,
`orchestrationMode`, a validated workflow, optional `{maxSpawns,
maxWallClockMs}` budget, lifecycle `status`, `rev`, and `version`. Definition edits
bump both edit revision and version; status-only transitions bump `rev` but do not
create a new executable artifact.

`startRun()` resolves and freezes D9's execution closure into
`run.resolvedConfig`: workflow, complete referenced Agent snapshots, connection
`targetType`s, target `serverId` and absolute `cwd`, objective template, budget, and,
for scheduled runs, `unattended` and `scheduleId`. `agenticAiVersion` records the
definition version. A running or rediscovered run never consults a subsequently
edited Agentic AI, Agent, or Connection.

### 3.3 Run and node ledger

A Run records `id`, `agenticAiId`, `agenticAiVersion`, `resolvedConfig`, target
`sessionId` when applicable, concrete `objective`, status, `nodeExecutions[]`, bounded
`toolCallLog[]`, and start/finish times. Public run status is `queued`, `running`,
`waiting-approval`, `completed`, `failed`, `cancelled`, or `budget_exhausted`.
`spawnsUsed` is derived from persisted node `spawnAttempts`; the frozen budget is
copied into the read shape.

Each node execution begins as `{nodeId, status:"pending", turns:1}` and may carry:

| Field                                            | Purpose                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `status`, `startedAt`, `finishedAt`, `error`     | Durable lifecycle and bounded failure detail.                   |
| `agentRunId`, `parentNodeId`, `turns`            | Detached job identity, fan-out provenance, and guidance turns.  |
| `chosenEdges`                                    | Router-selected `from->to` keys; load-bearing routing state.    |
| `score`                                          | Display-only `SCORE` metadata; never read by routing.           |
| `iterationCount`, `lastVerdict`, `loopExhausted` | Displayable bounded-loop progress and terminal non-convergence. |
| `pendingToolCall`                                | Durable current/last approval request.                          |
| `logTail`                                        | GET-time bounded log tail; never persisted.                     |

The store also persists intentionally **off-wire** driver state:

- `retryPending`, `loopPending`, and `neverRanPending` are phase-commit flags. The
  driver writes the decision before clearing prior artifacts or respawning;
  `recordSpawned()` clears the flags. Recovery checks these flags before stale
  markers, closing the crash window without double-counting.
- `spawnAttempts` counts all spawn commitments and backs exact budget accounting;
  `retryCount` counts retries within the current loop iteration;
  `neverRanRecoveryCount` is the independent, one-recovery crash cap.
- `sessionEstablished` and `iterationInvocation {mode, providerSessionId}` determine
  whether a Claude iteration can safely use `--resume`. `providerSessionId` itself is
  also internal.
- Run-level `budgetHalt` closes the single-node loop/budget race: a loop node can be
  made terminal and the pending budget halt committed atomically before the driver
  finalizes `budget_exhausted`.

The public Zod schemas in `packages/shared-types/src/terminal.ts` describe most of the
wire projection. Internal phase flags and counters are deliberately absent. There is
current contract drift to account for: the runtime read shape additionally exposes
`turns` and `budgetHalt`, while the Agentic AI and request schemas omit the backend's
shipped `"custom"` orchestration mode. Consumers should feature-detect the additive
run fields; schema maintainers must not treat those omissions as backend restrictions.

## 4. The `decide()` reducer contract

`decide(run, resolvedConfig)` reads only the frozen workflow and current ledger and
returns `{toSpawn, toSkip, running, terminal}`.

Its exact rules are:

1. `running` is the list of node ids whose status is exactly `running`.
2. A `failed` node is handled only when it has an outgoing `on:"failure"` edge.
   Any other failed node—including a failed router or failed plain-edge source—is
   fail-fast: `terminal:"failed"`, with no new spawns or skips.
3. If every node is `done`, `failed`, or `skipped` and no unhandled failure exists,
   the run is `terminal:"completed"`.
4. Taken edges are derived only after their source is terminal:
   - router edges are taken only when their `from->to` key is in persisted
     `chosenEdges`;
   - `on:"success"` is taken for `done` and `on:"failure"` for `failed`;
   - a plain edge is taken only from a `done` non-router source.
5. A pending root (no incoming edges) is ready. A pending non-root waits until every
   incoming source is terminal; it is ready if at least one incoming edge was taken,
   otherwise it enters `toSkip`.
6. `toSpawn` is capped to `AGENT_MAX_PARALLEL_FANOUT - running.length`.

`advanceRun()` applies `toSkip`, re-runs the reducer, and repeats. That iteration is
the transitive skip closure: untaken branch children become skipped, which can make
their descendants decidable and skipped without embedding graph traversal side
effects in `decide()`.

Retries and loops keep a node `running` while their next attempt is committed, so the
reducer never sees transient failure or a back-edge. Budget checks occur around spawn
offers in the driver. These boundaries are architectural constraints, not incidental
implementation choices.

## 5. Workflow model and richer policies

### 5.1 Nodes and edges

The persisted backend node types are:

| Type                | Execution                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-task`        | Executes its referenced Agent through the provider seam. May carry retry and loop policies.                                                                                                           |
| `human-approval`    | Spawns no process; the driver parks it at `waiting-approval` until a human approves or rejects.                                                                                                       |
| `router`            | Executes an Agent, parses a `BRANCH` label, and persists one selected `chosenEdges` key. May carry retry policy.                                                                                      |
| “evaluation” preset | Frontend-only authoring preset. “Add evaluation” creates a normal `router`, commonly with `when:"pass"` and `when:"default"`; `evaluation-preset` is not stored or accepted as a fourth backend type. |

Edges from one node must use one homogeneous kind: plain, `on:"success"` /
`on:"failure"`, or router-only `when:"label"`. A router must have outgoing `when`
edges and exactly one distinct `default` label; unmatched `BRANCH` output selects that
default. Validation rejects dangling references, duplicate ids/labels, mixed edge
kinds, invalid entry ids, and cycles before mutating the store.

Built-in `single`, `sequential`, `parallel`, and current `supervisor` modes are
compiled by `buildResolvedWorkflow()`; `supervisor` currently collapses to sequential.
`custom` uses the saved DAG. Branching workflows reject `workspace-write` Agents
because siblings could mutate one `cwd` concurrently.

### 5.2 Retry policy

`retryPolicy {maxAttempts, backoffMs, retryOn:"failure"}` is accepted on
`agent-task` and `router` nodes and clamped by environment ceilings. On nonzero exit
or timeout, `retryOrFailNode()` commits `recordRetryAttempt()` while the node remains
`running`, removes stale markers/log, waits the fixed backoff, checks cancellation,
and calls `spawnNode()`. Exhaustion writes final `failed`, which is then visible to
the reducer. See [AGENTIC-RICHER-WORKFLOWS-PLAN.md](./AGENTIC-RICHER-WORKFLOWS-PLAN.md)
§1 and commit `44fc3fd` plus follow-up `06aafff`.

### 5.3 Router and condition policy

On successful router exit, `recordTerminalDone()` reads the bounded log through
`parseResult()`, matches the last `BRANCH: <label>` against outgoing `when` edges or
`default`, and atomically records `done` plus `chosenEdges`. `decide()` consumes only
that persisted choice. Non-router `on` edges route process success/failure without
parsing model text. See
[AGENTIC-ROUTER-IMPL-SPEC.md](./AGENTIC-ROUTER-IMPL-SPEC.md) and commit `be9b4b6`.

### 5.4 Evaluation and `SCORE`

Evaluation is the router authoring preset described above, not new graph semantics.
The evaluator emits `BRANCH` for routing and may emit `SCORE: <number>` for display.
The selected edge remains the only routing fact; `score` is persisted and rendered
but explicitly ignored by `decide()`. See
[AGENTIC-EVAL-IMPL-SPEC.md](./AGENTIC-EVAL-IMPL-SPEC.md) and commit `6322d83`.

### 5.5 Budget policy

Budgets are precisely measurable spawn and elapsed-time caps only:
`{maxSpawns?, maxWallClockMs?}`. Token and dollar budgets are deferred because the
provider seam does not report reliable usage. `budgetExhausted()` is driver-only.
Spawn count is exact across restart because it sums persisted `spawnAttempts`; a
parallel wave is clamped to remaining spawn capacity. Wall-clock enforcement has poll
granularity. Existing in-flight work, including approval waits, is allowed to finish;
no new nodes are spawned, then the run becomes `budget_exhausted` and remaining
pending nodes become `skipped`. Loop-specific `budgetHalt` ensures a leaf loop cannot
win the normal-completion race. See
[AGENTIC-BUDGET-IMPL-SPEC.md](./AGENTIC-BUDGET-IMPL-SPEC.md) and commit `f2d3cd0`.

### 5.6 Loop policy

`loopPolicy {maxIterations, until, backoffMs}` is valid only on `agent-task`, is
environment-clamped, and requires `claude-cli`; Codex fails closed because it cannot
resume the provider conversation. A successful iteration's last `BRANCH` is its
verdict. Equality with `until` finishes normally; reaching the cap finishes the node
with display-only `loopExhausted:true`; otherwise `loopRespawn()` commits the next
iteration, clears attempt artifacts, and resumes Claude with `--resume` plus a
revision prompt containing `lastVerdict`. Process failures consume retry attempts
inside the iteration; `commitLoopIteration()` resets `retryCount` for the next one.
The pending flags and independent `neverRanRecoveryCount` make all phase boundaries
restart-safe. The graph remains acyclic and `decide()` is unchanged. See
[AGENTIC-LOOP-DESIGN-REVIEW.md](./AGENTIC-LOOP-DESIGN-REVIEW.md),
[AGENTIC-LOOP-IMPL-SPEC.md](./AGENTIC-LOOP-IMPL-SPEC.md), and commit `98d88fa`.

### 5.7 Schedule policy

Schedules are a cron-lite, fixed-anchor UTC recurrence: every N minutes, hours (with
optional minute), or days (with optional hour/minute). A due occurrence is claimed by
persisting its next fire time **before** `startRun()`; a crash can lose that occurrence
but cannot duplicate it. Ticks are non-reentrant and sequential, one active run per
schedule is allowed, and the common start reservation enforces the global concurrent
run cap. The scheduled target is frozen as `serverId + cwd`, not a reusable tmux name.

A SHA-256 `defFingerprint` covers the full executable closure—app workflow and
objective template, referenced Agents and their policies, Connections, and budget.
`startRun()` recomputes it after asynchronous target checks and before creating the
run; definition drift yields `definition_changed` and the schedule must be re-saved.
Scheduled runs are `unattended`. See
[AGENTIC-SCHEDULE-DESIGN-REVIEW.md](./AGENTIC-SCHEDULE-DESIGN-REVIEW.md),
[AGENTIC-SCHEDULE-IMPL-SPEC.md](./AGENTIC-SCHEDULE-IMPL-SPEC.md), and commit `8ff3998`.

## 6. Provider seam and MCP mediation

### 6.1 `AgentRuntimeProvider`

`agent-runtime.js` has no dependency on `server.js` or `agentic.js`. Its
`buildInvocation(input)` dispatches to two internal providers and returns scratch
files plus the single wrapper command tmux executes:

- `codex-cli`: `codex exec -C <cwd> --sandbox <read-only|workspace-write> ...`,
  prompt on stdin, output to `out.log`. Its ambient MCP configuration cannot be
  safely replaced without also breaking operator provider configuration, so the
  Agentic proxy is not wired for Codex; this is a documented residual exposure.
- `claude-cli`: headless `claude -p --output-format stream-json --verbose`, safe
  permission-mode mapping, system prompt file, and strict per-invocation MCP config.
  Local targets get the Agentic proxy; remote targets get an empty strict MCP config.

Prompts, system text, wrapper, and MCP files are mode `0600`; prompts and secrets do
not appear on the tmux command line. Child environment variables come from a curated
allowlist plus only the local provider's own credential namespace. Gateway auth,
password hashes, VAPID material, and unrelated provider secrets are excluded.

R8 (`970b137`) hardened `parseResult(logTail, exitCode)` for real Claude stream-json:
it prefers the last `result.result`, otherwise concatenated assistant text blocks,
otherwise plaintext. It then returns process status plus the last line-matched
`BRANCH` and numeric `SCORE`.

### 6.2 Per-run proxy and capabilities

For a local Claude invocation, `buildMcpPolicyManifest()` derives a frozen, per-node
manifest from `resolvedConfig.connections` and that Agent's `toolPolicies`. The CLI
starts `tools/agentic-proxy/server.mjs` as its stdio MCP child. Operationally there is
one proxy process per active CLI invocation, while its identity, policy, callbacks,
and audit records are scoped to the containing run and node.

The proxy starts only the referenced real PM/Kanban MCP children, aggregates their
tools, and resolves policy with explicit tool names preferred over `"all"` and the
most restrictive match winning (`deny > approval > allow`). Unknown tools and bad or
missing manifests fail closed. Denied tools are omitted from `tools/list` and denied
again on direct `tools/call`; allowed calls forward; approval calls create a durable
pending record and poll until approved, rejected, or timed out. Audit callback writes
are deliberately best-effort so logging cannot break a tool call; approval outcomes
are appended durably by the gateway's approval ledger.

Iteration 5 scoped capabilities are random, in-memory, TTL-bound bearer tokens minted
for one `runId`, one `nodeId`, and a set of artifact prefixes (`pm`/`kanban`). They can
reach only those artifact APIs plus that node's pending-tool-call callback routes and
are revoked when the run terminates. They do not yet close over individual tool
names—the proxy is the per-tool enforcement boundary. There is no scoped-token route
to start, kill, guide, approve, reject, or administer schedules.

### 6.3 Unattended fail-closed layers

Scheduled execution applies four independent protections:

1. Manifest construction rewrites `approval` policies to `deny`.
2. The pending-tool-call registration route refuses unattended runs.
3. A workflow `human-approval` node fails immediately instead of parking.
4. If an app has Connections and scoped capability minting is unavailable or cannot
   produce an artifact prefix, `startRun()` refuses the run; it never falls back to
   the broad `GATEWAY_API_TOKEN`.

The normal stale-approval sweep remains recovery defense, not an unattended approval
mechanism.

## 7. Route surface and authentication

All routes are under `/api/agentic`. Upstream middleware requires a valid
`gw_session` cookie, open loopback mode, the configured broad artifact bearer, or—on
its narrow allowlist—a scoped MCP token. Non-GET writes also pass the gateway's normal
Origin/CSRF enforcement. Reads are Origin-exempt.

| Area            | Routes                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Agents          | `GET/POST /agents`; `GET/PATCH/DELETE /agents/:id`                                                  |
| Connections     | `GET/POST /connections`; `DELETE /connections/:id`; `GET /mcp-servers`                              |
| Catalog         | `GET/POST /apps`; `GET/PATCH/DELETE /apps/:id`; `PATCH /apps/:id/status`                            |
| Portability     | `GET /apps/:id/export`; `POST /apps/import`; `POST /apps/:id/clone`                                 |
| Runs            | `POST /apps/:id/run`; `GET /runs`; `GET/DELETE /runs/:id`                                           |
| Run interaction | `POST /runs/:id/nodes/:nodeId/guidance`; `POST .../approve`; `POST .../reject`                      |
| Proxy callbacks | `POST .../pending-tool-call`; `GET/POST .../pending-tool-call/:pendingId`; `POST .../tool-call-log` |
| Schedules       | `GET/POST /schedules`; `GET/PATCH/DELETE /schedules/:id`                                            |
| Target helper   | `GET /session-cwd?sessionId=...`                                                                    |

Schedule create/patch/delete is explicitly `isHumanCookieSession()`-only; schedule
reads retain cookie-or-bearer behavior. Guidance and approve/reject are also
human-cookie-only. The scoped run/node bearer can use only PM/Kanban prefixes and its
own pending-tool-call registration/poll endpoints.

The broad configured `GATEWAY_API_TOKEN` remains accepted by the generic Agentic gate
for CRUD, start, and `DELETE /runs/:id`; therefore the HTTP kill route is **not
strictly cookie-only in current code**. Human-only at the product/agent boundary means
there is no agent-service kill tool and a scoped token cannot kill, but operators must
treat the broad bearer as an administrative capability. The schedule design review
documents the same correction for “human-only start.” This distinction is essential
when deploying outside open loopback mode.

## 8. Security model

The security boundary is layered rather than delegated to model compliance:

- **Least-capability runtime tokens.** Normal Agentic MCP runs use per-run/per-node,
  artifact-prefix capabilities. Terminal completion revokes them. Unattended runs
  have no broad-token fallback.
- **Per-tool mediation.** The proxy applies deny/allow/approval on every call, omits
  denied tools from discovery, audits bounded argument previews, and cannot be
  bypassed through Claude ambient MCP because `--strict-mcp-config` is mandatory.
- **Human judgment.** Guidance, approval, rejection, and schedule mutation require a
  human cookie. Scoped agents cannot self-approve. Run kill is human-only with respect
  to the scoped agent capability and exposed UI, with the broad administrative bearer
  caveat described in §7.
- **Unattended fail-closed execution.** Approval policies become deny, approval
  callbacks and human gates refuse, and connected runs refuse without a scoped token.
- **Executable-definition pinning.** A schedule can run only the exact normalized,
  fingerprinted executable closure a human saved; drift refuses rather than silently
  adopting new prompts, policies, connections, or workflow.
- **Process containment.** Sandbox modes are code-clamped, concurrent branching
  forbids workspace writers, provider environments are curated, scratch material is
  private, and run teardown derives only `agrun-` names.

The remaining capability caveats are explicit: Codex does not have the local strict
proxy wiring; scoped tokens are artifact-prefix rather than per-tool; the broad
artifact bearer is administrative; and remote hosts receive no Agentic proxy. These
are deferred items, not guarantees supplied by the current architecture.

## 9. Frontend architecture

`apps/terminal/public/agentic/app.html` is a single dependency-free, self-contained
artifact document. It provides:

- an Agentic AI catalog with create/edit/status, export/import/clone, and open-run
  actions;
- reusable Agent and Connection libraries, including provider, sandbox, prompt,
  model, role, and tool-policy editing;
- team and workflow editing: built-in modes plus a form-based custom DAG builder,
  `agent-task`/`human-approval`/`router` nodes, the evaluation-router preset, plain /
  success-failure / labeled-default edges, retry and loop sub-forms, budget,
  schedules, and `objectiveTemplate`;
- a Run view with resolved target, persisted run history and re-attach, live polling,
  per-node logs/status/turns/branch/score/loop metadata, tool and human approval
  banners, guidance, spawn-budget progress, and cancellation.

`apps/terminal/src/features/terminal/components/agentic-dialog.tsx` is intentionally a
thin host seam: a terminal dialog containing `/agentic/app.html` in a same-origin
iframe with `allow-scripts allow-same-origin allow-forms allow-modals`. The sandbox is
for DOM/CSS/JS isolation and pluggability, not a security boundary. Same-origin fetch
carries the existing `gw_session` through the terminal's gateway proxy.

This mirrors the sibling `kanban-dialog.tsx` and `pm-dialog.tsx` convention: the React
host owns dialog framing, the artifact owns its UI and API interaction, and the
gateway-global artifact takes no terminal-session props. The DAG editor remains
form-based; a visual canvas is deferred.

## 10. Testing and delivery status

`apps/terminal-gateway/test/agentic-endpoints.js`, run by
`pnpm --filter @sparklab/terminal-gateway test:agentic`, is the integrated contract and
currently reports **437 checks** in the consolidated status. It covers CRUD,
validation, auth, tmux lifecycle, approvals, templates, DAGs, retries, routing,
evaluation, budgets, loops, schedules, and cleanup. `test/parse-result.js` exercises
the provider parser, including real stream-json envelope shapes.

The load-bearing tests are the ones that cross a crash boundary: completion while the
gateway is down, persist-before-spawn never-ran recovery and its cap,
restart-mid-retry, persisted router choices and skip closure, restart-preserved spawn
budget, restart after a committed loop phase without recounting a verdict, stale
approval resolution, schedule pre-fire claiming, fingerprint refusal, start-cap
reservation, and no leaked `agrun-` sessions. These tests defend D3 more directly than
happy-path endpoint counts do.

The shipped commit map is: retry `44fc3fd` (`06aafff` follow-up), router `be9b4b6`,
evaluation `6322d83`, budgets `f2d3cd0`, R8 parser `970b137`, loops `98d88fa`, and
schedules `8ff3998`. For the complete shipped table and the authoritative deferred
list—multi-turn agent chat, dynamic map-reduce, routable loop exhaustion, evaluation
datasets, full cron/event triggers, deeper schedule history, per-tool token closure,
remote proxy distribution, visual DAG canvas, marketplace, and branch merge—see
[AGENTIC-STATUS-AND-REMAINING.md](./AGENTIC-STATUS-AND-REMAINING.md).
