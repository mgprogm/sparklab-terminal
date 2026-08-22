# Agentic AI Creator — status & remaining work

Consolidated status for the Agentic AI Creator (3rd pluggable artifact). The
feature was integrated into `main`; the historical implementation branch was
`feat/agentic-ai-creator`. At the time this status was consolidated,
`test:agentic` was at **437**.

## Shipped

### v1 (core platform)

- Store (`agentic.js`) + `/api/agentic/*` CRUD (agents, connections, agenticAIs, runs).
- Run engine: per-step detached tmux jobs (`agrun-` prefix), the pure `decide()`
  reducer over a persisted `nodeExecutions[]` ledger, boot rediscovery, gated poll loop,
  config-freeze (D9), concurrency cap.
- Provider seam (`agent-runtime.js`): codex-cli + claude-cli invocation builders.
- iter3 per-run MCP proxy + approval mediation; iter5 per-run scoped MCP tokens;
  iter6 "send guidance" (claude `--resume`); iter7 templates (export/import/clone);
  iter8 custom agent-task DAGs; iter9 human-approval nodes.

### Post-v1 / richer workflows (Arc I + Arc II)

| Slice                     | Commit                 | What                                                                                   |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| Arc I §1 Retry            | `44fc3fd` (+`06aafff`) | per-node `retryPolicy` (driver-owned)                                                  |
| Arc I §2 Router/condition | `be9b4b6`              | `router` node + `on:`/`when:` labeled edges + skip closure                             |
| Arc II A1 Eval node       | `6322d83`              | router-preset "evaluation" + display-only `SCORE`                                      |
| Arc II B2 Budgets         | `f2d3cd0`              | per-run `budget {maxSpawns, maxWallClockMs}` → `budget_exhausted`                      |
| R8 stream-json parser     | `970b137`              | parse `BRANCH`/`SCORE` from real claude stream-json (fixed router/eval vs real claude) |
| Arc II A2 Loop            | `98d88fa`              | per-node `loopPolicy` revise-until (driver-owned, claude `--resume`)                   |
| Arc II B1 Scheduled runs  | `8ff3998`              | cron-lite unattended schedules (human-cookie admin, fail-closed, fingerprint)          |

Design/review trail: `AGENTIC-AI-CREATOR-PLAN.md`, `AGENTIC-RICHER-WORKFLOWS-PLAN.md`,
`AGENTIC-RICHER-WORKFLOWS-II-PLAN.md`, and per-slice `AGENTIC-{ROUTER,EVAL,BUDGET,LOOP,SCHEDULE}-*.md`.

## Remaining / deferred (each needs its own checkpoint before build)

### Track A — graph semantics (touch `decide()` / `resolveWorkflow`)

- **A3 — multi-turn agent-to-agent chat.** Sketch only in `AGENTIC-RICHER-WORKFLOWS-II-PLAN.md`
  §A3. Hard parts: turn/token bound, codex has no resume (fail-closed like guidance),
  must stay batch/survivable (no live bidirectional stream). Deferred until a concrete
  use case.
- **Dynamic-width map-reduce** (A2's deferred half). Fan-out width is data-dependent →
  runtime node materialization + dynamic budget/skip/join over nodes that didn't exist at
  save. Fights the static-DAG-validated-once model. Its own future slice.
- **Routable loop exhaustion.** A2 ships `loopExhausted` as DISPLAY-ONLY; making a
  downstream router branch on converged-vs-exhausted needs `on: converged|exhausted` edge
  semantics that touch `resolveWorkflow` + `decide()`. Deferred.
- **Evaluation datasets** (offline batch scoring of an agent CONFIG against a fixture
  set) — distinct from the A1 runtime eval node; no `decide()` involvement. Deferred.

### Track B — operational (never touch `decide()`)

- **Full 5-field cron** for schedules (B1 ships cron-lite interval/daily UTC only). Needs a
  vetted cron dep or a carefully-tested parser + TZ semantics.
- **Event-triggered runs** ("run when a PM task moves to Done") — needs an event bus the
  system lacks. B1's own deferred half.
- **Schedule run-history** beyond `lastFiredAt`/`lastOutcome`.

### Cross-cutting / platform

- **Per-tool token closure** (iter5 residual): a scoped token bounds WHICH artifact, not
  WHICH tool; children never holding a gateway token is deferred.
- **Remote-host proxy distribution** (the per-run MCP proxy currently assumes local).
- **Visual DAG canvas** for the workflow builder (still form-based).
- **Marketplace / multi-artifact registry** for templates.

## Concurrent workstream note (2026-07-29)

During the B1 build, a SEPARATE workstream was modifying `apps/agent-service/browser-*`
and `apps/terminal/src/features/browser-handoff/*` (an interactive-browser / handoff
feature). Those are NOT part of the agentic-creator work and were left untouched/uncommitted.

## UI coverage audit (2026-07-29)

Audited `public/agentic/app.html` against every shipped backend feature. **Coverage is
complete** after one fix:

- Catalog/app: name, description, orchestrationMode, **objectiveTemplate** (added
  `6bf55b4` — was the only gap), budget, export/import/clone, schedules.
- Agents: runtimeProvider, sandboxMode, systemPrompt, role, model, toolPolicies.
- Connections: targetType/scope/targetId.
- Workflow builder: node types agent-task / human-approval / router / "Add evaluation"
  preset; edges plain / `on:success|failure` / `when:label`+default; retry sub-form;
  loop sub-form.
- Run view: status (incl. `budget_exhausted`), turns, error, `chosenEdges` (Branch),
  `score` (SCORE), `iterationCount`, `lastVerdict`, `loopExhausted`, logTail,
  pendingToolCall approval banner, spawns N/M, guidance, kill, human-approval gate.
