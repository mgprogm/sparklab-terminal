# Agentic AI Creator — Richer Workflows Arc — Design & Implementation Plan

> Status: §1 Retry **SHIPPED** (2026-07-29, iteration 10) — per-node `retryPolicy`
> ({maxAttempts, backoffMs, retryOn:"failure"}) implemented as D-Retry-1..4
> specify: driver-owned retry (reducer never sees a mid-retry failure), off-wire
> `retryCount` distinct from `spawnAttempts`, both caps env-clamped
> (`AGENT_RETRY_MAX_ATTEMPTS`=5 / `AGENT_RETRY_BACKOFF_MAX_MS`=60000), FE retry
> sub-form in the custom-DAG builder, and 4 tests incl. the load-bearing
> crash-mid-retry (`test:agentic` now 288 checks). One fix beyond the plan:
> `shapeWorkflow` was dropping `retryPolicy` on every read (the run reads the
> shaped app), so the policy never reached the engine — now carried through
> (wire-shape pinned by a regression assertion). §2 Condition/Router remains
> **proposed — checkpoint with the user before build**.
> **Extends** `docs/AGENTIC-AI-CREATOR-PLAN.md` §8 ("Visual DAG builder /
> condition-router / retry / evaluation node types") and continues the
> **"richer workflows"** arc opened by iter8 (`315a343`, "custom agent-task
> DAGs (richer workflows, 1/N)"). Everything in the v2 plan's D1–D9 still holds;
> this document only adds node/edge semantics on top of the reducer that iter8
> already ships. Cross-link: v2 plan §8 should point here for the concrete
> retry / condition-router design.
>
> Scope: the two remaining slices the iter8 commit named explicitly — **retry
> (iter9)** and **condition/router (iter10)** — plus what stays deferred. The
> `human-approval` node type it also named has since landed end-to-end
> (`resolveWorkflow` accepts it, driver gates it via `gateApprovalNode`), so it
> is out of scope here except where routing interacts with it.

---

## 0. Grounding (verified against source, 2026-07-29)

Line references are to the current branch `feat/agentic-ai-creator`.

- **Accepted node types today** (`agentic.js` `resolveWorkflow`, ~L223): exactly
  `agent-task` and `human-approval`. Any other type is rejected at the **store
  boundary** with `422 invalid_workflow` (`test/agentic-endpoints.js:867` proves
  `router → 422`). So `retry`/`condition`/`router` are genuinely unbuilt — the
  gate is one allowlist line, by design ("so a 'router'/etc node can never reach
  the run engine", L221).
- **The reducer is pure and edge-driven** (`agentic.js` `decide`, ~L908). It
  walks the frozen `resolvedConfig.workflow` DAG and returns
  `{ toSpawn, running, terminal }`. Rules today:
  - `ready ⇔ status:"pending" AND every in-edge predecessor is done`;
  - `terminal:"failed" ⇔ ANY node failed` (fail-fast);
  - `terminal:"completed" ⇔ every node is done|skipped`;
  - fan-out capped at `AGENT_MAX_PARALLEL_FANOUT` minus currently-running.
    **Every out-edge is unconditional today** — this is the exact assumption
    condition/router must break (§2).
- **A retry seed already exists.** `recordSpawned` (~L800) increments a
  persisted `spawnAttempts` counter, and the server.js reap table respawns a
  "never-ran" node unless `attempts ≥ 2`. That machinery is crash-recovery
  today, but the counter + idempotent-respawn path are exactly what
  failure-retry builds on (§1).
- **iter8's workspace-write ban is blanket over branching.** `server.js`
  ~L3132–3137: any node with in/out-degree > 1, or > 1 entry, forbids
  `workspace-write` agents → `422 parallel_write_forbidden`. Rationale: parallel
  branches share one cwd. **This must be refined for routers** (§2, D-Route-3).
- **The workflow is DAG-shaped and cycle-checked** (`resolveWorkflow` DFS,
  ~L262). The acyclic invariant is enforced at save; nothing downstream tolerates
  a back-edge. This is why retry is a policy, not a loop-back node (§1).

---

## 1. Iteration 9 — Retry

**D-Retry-1 — Retry is a per-node POLICY on `agent-task`, not a node type.**

A `retry` _node type_ would force the reducer to model "loop back to an
already-`done` predecessor and run it again" — a back-edge — which fights the
acyclic invariant `resolveWorkflow` enforces and which `decide()`'s
`every node done|skipped → completed` rule would mis-read as completion. Instead,
an `agent-task` node carries an optional:

```jsonc
"retryPolicy": {
  "maxAttempts": 3,          // total attempts incl. the first; 1 = no retry (default)
  "backoffMs": 0,            // fixed delay before each respawn; 0 = immediate
  "retryOn": "failure"       // "failure" (nonzero exit / timeout). Only value in v1.
}
```

Validated in `resolveWorkflow` (clamp `maxAttempts` to a small ceiling, e.g.
`RETRY_MAX_ATTEMPTS_CAP=5`; `backoffMs` to `AGENT_RETRY_BACKOFF_MAX_MS`).
Absent policy ⇒ current behavior exactly (`maxAttempts:1`).

**D-Retry-2 — The driver retries; the reducer never sees a mid-retry failure.**

This keeps `decide()`'s `ANY failed → terminal:"failed"` fail-fast rule intact.
When an `agent-task`'s tmux job exits nonzero (or times out), the **server.js
reap path** — not the pure reducer — decides:

- If the node's `attempts < retryPolicy.maxAttempts`: DO NOT call
  `recordNodeResult(status:"failed")`. Instead clear the node's stale
  markers/log (same teardown `recordGuidanceTurn` already does), optionally wait
  `backoffMs`, and re-spawn via the existing `recordSpawned` path (which bumps
  `spawnAttempts`). The node stays `running` throughout, so the reducer never
  observes a transient failure.
- Only when attempts are exhausted does the reap path write
  `recordNodeResult(status:"failed")`, and fail-fast trips as it does today.

**D-Retry-3 — `spawnAttempts` is the single attempt counter; separate the two
respawn reasons.** Today `spawnAttempts` guards crash-recovery ("never-ran →
respawn unless attempts≥2"). Retry adds a _second_ legitimate respawn reason
(clean nonzero exit). Keep one counter but branch the reap table on **why** a
node is being reconsidered:

- never-ran-after-crash (no markers) → existing idempotent respawn, capped at 2
  as today;
- ran-and-failed (exit marker present, nonzero) → retry respawn, capped at
  `retryPolicy.maxAttempts`.
  Document that a crash _during_ a retry attempt is covered by the never-ran path
  and does not consume an extra retry budget beyond the cap. Persist a small
  per-node `retryCount` (distinct from `spawnAttempts`, which also counts
  crash-respawns) if the two need to be told apart for the UI; **NEVER shaped into
  shared-types** unless surfaced deliberately (mirror `spawnAttempts`'s off-wire
  treatment).

**D-Retry-4 — Whole-run bound unchanged.** `AGENT_RUN_TIMEOUT_MS` still bounds
each individual attempt; retries do not extend a single attempt's wall clock.

### Schemas (`packages/shared-types/src/terminal.ts`)

Add optional `retryPolicy` to `WorkflowNode` (`RetryPolicy` = `{maxAttempts,
backoffMs, retryOn}`), all fields optional/defaulted. Backward-compatible: an old
`agentic.json` loads unchanged.

### Frontend (`public/agentic/app.html`)

In the `custom`-mode DAG builder, each `agent-task` node gets a small "Retry"
sub-form (max attempts + backoff). Text-only, self-contained, PATCHes the same
`{workflow}` payload. No new view.

### Tests (`test/agentic-endpoints.js`)

- Stub backend that fails N-1 times then succeeds → run `completed`, node ran
  `maxAttempts` times (assert via `spawnAttempts`/`retryCount`).
- Stub that always fails → run `failed` after exactly `maxAttempts` attempts
  (fail-fast trips only once, not per-attempt).
- **Restart mid-retry**: kill gateway between attempt 2's failure and respawn,
  reboot, assert the node resumes retrying (never-ran path) and the cap still
  holds — the load-bearing D3-layer-2 assertion for this slice.
- `retryPolicy` absent ⇒ single attempt (regression guard).

---

## 2. Iteration 10 — Condition / Router (**checkpoint with the user before build**)

This is the slice that **rewrites `decide()`'s edge semantics**. iter8's own
commit flags it: "condition/router … DO touch the reducer." Three things must be
pinned; each is a real decision, not boilerplate.

**D-Route-1 — Condition against WHAT? Named branches, not a free-text evaluator.**

The only durable per-node signals today are `status` (`done`/`failed`) + `error`;
`logTail` is display-only and must not become a routing input. v1 scopes routing
to a **tractable, named contract** — two supported shapes, pick per node:

1. **Success/failure edges (labeled edges).** An `agent-task` (or a dedicated
   `router` node) may have out-edges labeled `on:"success"` / `on:"failure"`.
   The taken branch is chosen by the node's terminal `status`. This alone
   delivers "if the build fails, run the fixer; else run the reviewer" without
   any output parsing.
2. **Router node keyed by structured output.** A `router` node whose successor
   is named by the agent's _structured_ result via the existing
   `AgentRuntimeProvider.parseResult` seam (D6). Contract: the provider parses a
   single `branch` label from a constrained output (e.g. a final `BRANCH: <label>`
   line, or claude-cli structured JSON), matched against out-edges labeled
   `when:"<label>"`, with a mandatory `when:"default"` fallback edge. **No general
   expression language over free text** — the plan explicitly rejects that as
   unbounded and unverifiable.

`resolveWorkflow` gains: `router`/labeled-edge validation (every router needs a
`default` out-edge; labels unique per node; labeled and unlabeled out-edges not
mixed on one node). The acyclic + dangling-edge checks are unchanged.

**D-Route-2 — Untaken-branch skipping is the load-bearing reducer change.**

`decide()` completes when every node is `done|skipped` and offers any pending
node whose predecessors are all `done`. With conditional out-edges, if a router
takes branch A, **every node reachable only through branch B must become
`skipped`** — otherwise B either becomes ready and wrongly spawns, or sits
`pending` forever so the run never completes. Precise mechanism:

- When a router/labeled node reaches terminal status, the **driver** records the
  chosen edge(s) on the node execution (`chosenEdges:["nodeId→succ"]`, persisted).
- `decide()` is extended: a node is `ready` only if every predecessor is `done`
  **AND at least one _taken_ in-edge leads to it**. A node all of whose in-edges
  were _not taken_ by their (terminal) source is transitively **skippable**.
- Compute the skip set as a transitive closure: starting from each untaken edge,
  mark the target `skipped` **iff** it has no other live (taken-or-still-possible)
  in-edge, then propagate. A join node with one taken and one untaken in-edge
  stays live (it still runs). Persist the `skipped` transitions via the existing
  `recordNodeResult(status:"skipped")` path so `setRunStatus`'s pending→skipped
  cleanup and the completed-check stay consistent.
- This must be **pure and re-derivable**: on boot/restart the chosen edges are on
  disk (`chosenEdges`), so the reducer recomputes the same skip set — no
  in-memory routing state (D3-layer-2 invariant).

Write a dedicated diamond-with-router test proving the untaken subtree is skipped
and the run completes (mirrors iter8's diamond fan-out/join test).

**D-Route-3 — Refine iter8's workspace-write ban; do NOT inherit it blanket.**

iter8 forbids `workspace-write` on any branching graph because _parallel_ branches
run concurrently on one cwd. **Router branches are mutually exclusive — only one
runs** — so that reasoning does not apply. The safety check must distinguish:

- **Parallel fan-out** (a plain node with out-degree > 1, all edges unlabeled →
  all successors run concurrently): keep the `workspace-write` ban →
  `422 parallel_write_forbidden`.
- **Conditional branching** (a `router`/labeled node whose out-edges are
  mutually exclusive → at most one successor runs): `workspace-write` is
  **allowed**, because there is no concurrent write to the shared cwd.

Concretely, the degree-based check at `server.js` ~L3132 must key off _edge
labeling / node type_, not raw out-degree. A `router` node's out-degree > 1 is
safe; a plain agent-task's out-degree > 1 is not. Add a test asserting a
workspace-write agent behind a router does **not** 422, while behind a plain
fan-out it still does.

### Schemas

`WorkflowEdge` gains optional `on`/`when` label; `WorkflowNode.type` allowlist
adds `router`. `NodeExecution` gains optional `chosenEdges` (off-wire unless the
Run view needs it — decide per FE need).

### Frontend

DAG builder: a node can be marked `router`; edges from it get a label field
(`success`/`failure` or free `when` label + a required `default`). The Run view's
per-step ledger shows which branch was taken and greys out skipped nodes.

### Tests

- Router by structured output → correct branch runs, others skipped, run completes.
- Success/failure labeled edges → failure path runs the fixer, success path
  skipped (and vice-versa).
- Missing `default` edge on a router → `422 invalid_workflow` at save.
- Workspace-write behind a router allowed; behind plain fan-out still 422 (D-Route-3).
- Restart after the router decided but before successors spawned → boot
  rediscovers `chosenEdges`, resumes the correct branch (D3-layer-2).

---

## 3. Deliberately deferred (still, after this arc)

- **Evaluation / self-critique node types** and evaluation datasets — the third
  item in v2 §8's bullet; out of scope here.
- **Loops / iteration node types** (bounded `while`/`map-reduce`) — would
  require relaxing the acyclic invariant with an explicit iteration-count bound;
  a separate, larger decision. Retry-as-policy (§1) deliberately avoids opening
  this door.
- **General expression / DSL conditions over free-text agent output** — rejected
  in D-Route-1 as unbounded; named branches only.
- **Visual drag canvas** for the DAG builder — still form-based (iter8's "later
  polish"); unchanged.
- **Multi-turn agent-to-agent chat protocols** — still deferred (v2 §8).

---

## 4. Configuration (env) — additions

All optional; an unconfigured gateway behaves exactly per the defaults.

```bash
# ---- Retry (iter9) ----
# Hard ceiling on retryPolicy.maxAttempts, regardless of what a workflow requests.
# AGENT_RETRY_MAX_ATTEMPTS=5
# Hard ceiling on retryPolicy.backoffMs.
# AGENT_RETRY_BACKOFF_MAX_MS=60000

# ---- Condition/router (iter10) ----
# No new tunables anticipated; routing is structural, bounded by the existing
# per-step and whole-run limits. (Add here if a router-decision timeout proves
# necessary in implementation.)
```

---

## 5. Critical files (touched by this arc)

- `apps/terminal-gateway/src/agentic.js` — `resolveWorkflow` (accept `retryPolicy`,
  `router`, labeled edges + their validation); `decide()` (untaken-branch skip
  closure, D-Route-2); retry-vs-crash respawn branching helpers.
- `apps/terminal-gateway/src/server.js` — reap path (retry respawn, D-Retry-2/3);
  router decision + `chosenEdges` persist; refined workspace-write safety check
  (D-Route-3, ~L3132).
- `packages/shared-types/src/terminal.ts` (+ `index.ts`) — `RetryPolicy`, edge
  labels, `router` type, optional `chosenEdges`.
- `apps/terminal/public/agentic/app.html` — DAG-builder retry sub-form + router /
  labeled-edge authoring; Run view branch/skip display.
- `apps/terminal-gateway/test/agentic-endpoints.js` — retry, router, skip-closure,
  refined write-ban, and restart-mid-retry / restart-after-route tests.
- `apps/terminal-gateway/.env.example` — §4 additions.
- `docs/AGENTIC-AI-CREATOR-PLAN.md` — §8 bullet cross-links here once shipped.

---

## 6. Sequencing & checkpoints

1. **iter9 (retry)** — additive, reducer-light; ship first. Reuses the
   `spawnAttempts`/reap machinery. No user checkpoint needed beyond normal review.
2. **iter10 (condition/router)** — **checkpoint with the user before build**
   (mirrors v2 §6's checkpoints on genuinely new reducer/infra slices). This one
   changes `decide()`'s core edge semantics and the branching safety model; get
   sign-off on D-Route-1's contract (named branches, no expression evaluator) and
   D-Route-3 (write-ban refinement) before writing code.
