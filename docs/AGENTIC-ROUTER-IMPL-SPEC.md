# Router / Condition slice — implementation spec (Opus-authored, Codex-implemented)

Implements `docs/AGENTIC-RICHER-WORKFLOWS-PLAN.md` §2 (D-Route-1..3). This is the
authoritative contract; Codex implements each part against it, Opus reviews +
writes tests. **The reducer `decide()` must stay pure and re-derivable from
persisted state (D3-layer-2).**

## 0. Model recap

- Node types: `agent-task`, `human-approval`, **`router`** (NEW).
- Edge: `{from, to}` plus AT MOST ONE optional label:
  - `on: "success" | "failure"` — a **status** branch off an `agent-task`.
  - `when: "<label>"` — a **structured-output** branch off a `router`.
  - neither = **plain** (unlabeled) edge.

## 1. Schemas (`packages/shared-types/src/terminal.ts`)

- `WorkflowEdgeSchema`: add optional `on` (enum `["success","failure"]`) and
  optional `when` (non-empty string). A single edge may set at most one; both set
  ⇒ invalid (validated in `resolveWorkflow`, not necessarily zod).
- `WorkflowNodeSchema.type` enum: add `"router"`.
- `NodeExecutionSchema`: add optional `chosenEdges: string[]` (edge keys
  `"from->to"`). Shaped onto the wire (FE needs it for the Run view).

## 2. `resolveWorkflow` validation (`agentic.js`)

Add, WITHOUT changing the acyclic / dangling-edge / entryNode checks:

- Carry `on`/`when` through `cleanEdges` (only the set one; drop empties).
- Node type allowlist adds `router`. A `router` node keeps `agentId` (it runs an
  agent to emit a branch label) — treat exactly like `agent-task` for agent
  resolution.
- **Per source-node edge-label rules** (compute out-edges grouped by `from`):
  - A node's out-edges must be **homogeneous**: all plain, OR all `on`-labeled,
    OR all `when`-labeled. Mixing ⇒ `invalid_workflow`.
  - `on`-labeled: labels ∈ {success,failure}, each at most once. Only valid off a
    non-router node (`agent-task`). `on` off a `router` ⇒ invalid.
  - `when`-labeled (router): every `router` node with out-edges MUST include
    exactly one `when:"default"`; `when` labels unique per node; `when` edges
    only valid off a `router` node. A `router` with out-degree 0 ⇒ invalid
    (a router must branch).
  - A non-router node may NOT carry `when` edges; a `router` node may ONLY carry
    `when` edges (never plain/`on`).
- Error `code:"invalid_workflow"` (maps to 422, same as today), with a `node` or
  `edge` detail.

## 3. `decide(run, resolvedConfig)` rewrite (`agentic.js`) — THE load-bearing change

New return shape: `{ toSpawn, toSkip, running, terminal }` (adds `toSkip: string[]`).

Definitions computed from `nodeExecs` (persisted ledger) + `workflow` (frozen):

**Edge key:** `` `${from}->${to}` ``.

**Taken-edge set** — an edge `(u->v)` is _taken_ iff `u` is terminal and:

- `u.type === "router"`: `edgeKey ∈ (u.chosenEdges || [])` (driver-persisted).
- edge has `on:"success"`: `u.status === "done"`.
- edge has `on:"failure"`: `u.status === "failed"`.
- plain edge: `u.status === "done"`. (A failed plain node fail-fasts; see below.)
  An edge whose source is NOT terminal is neither taken nor untaken yet (pending).
  `u.type` comes from `workflow.nodes`, not the ledger.

**Fail-fast (refined):** the run is `terminal:"failed"` iff ∃ node `u` with
`status:"failed"` that has **no** out-edge labeled `on:"failure"` in `workflow`.
(A failed node WITH an `on:"failure"` edge is a _handled_ failure — it routes, it
does not fail the run. A failed `router` has only `when` edges ⇒ NOT handled ⇒
fail-fast. A failed plain node ⇒ fail-fast, exactly as today.)
When fail-fast: `return { toSpawn:[], toSkip:[], running, terminal:"failed" }`.

**Ready** — a pending node `v`:

- Let `ins` = in-edges to `v`. If `ins` is empty ⇒ ready (root/entry).
- Else ready iff **every** in-edge source is terminal (done|failed|skipped)
  AND **at least one** in-edge is _taken_.

**Skip** — a pending node `v` is skippable iff `ins` non-empty AND every in-edge
source is terminal AND **no** in-edge is taken (v is unreachable). Return these in
`toSkip`. (Transitive closure happens across driver `while(changed)` iterations:
skipping `v` makes v terminal with no taken out-edges, so its exclusive
successors become skippable next pass. decide need only emit one layer.)

**Completed:** after the fail-fast check, if every node is `done|failed|skipped`
⇒ `terminal:"completed"`. (Any _unhandled_ failed node already returned failed
above, so a `failed` node reaching here is a handled branch point.)

**Budget:** unchanged — `toSpawn` capped at `AGENT_MAX_PARALLEL_FANOUT - running`.
`toSkip` is NOT budget-capped (skipping is free/synchronous).

**Purity:** no mutation; `chosenEdges` read-only. Re-derivable after restart
because `chosenEdges` (router decisions) + `status` are all persisted.

**Regression guarantee:** for a workflow with NO labels and NO router nodes,
every done node's plain out-edges are taken and no node is ever skipped, so Ready
== "every predecessor done" and fail-fast/completed == today. Existing iter2/8/9
tests MUST stay green unchanged.

## 4. `recordNodeResult` (`agentic.js`)

Accept an optional `chosenEdges` param; when provided, persist `ne.chosenEdges =
[...]`. Everything else unchanged. Add `chosenEdges` to `shapeNodeExecution`
(emit only when present).

## 5. Driver: record chosenEdges + handle skips (`server.js`)

**5a. Centralized terminal-DONE recording (CRITICAL — do not scatter).** The reap
records a node `done` in TWO twin sites (the "session lingering but exit.marker
present" branch AND the "no session, exitVal present" branch). BOTH must go
through ONE helper so a router can never be recorded `done` at one site without
its `chosenEdges` (that would leave the router with no taken out-edge → its whole
subtree wrongly skipped / the run stalls — the exact twin-site hazard the retry
crash-cap bug had). Add:

```
async function recordTerminalDone(run, cfg, nodeId) {
  const node = (cfg.workflow?.nodes || []).find(n => n.id === nodeId);
  if (node?.type === "router") {
    const logTail = await agenticNodeLogTail(run, nodeId);      // bounded read
    const { branch } = provider.parseResult(logTail, 0);        // D6 seam
    const outs = (cfg.workflow.edges || []).filter(e => e.from === nodeId);
    const match = outs.find(e => e.when === branch)
               || outs.find(e => e.when === "default");
    // resolveWorkflow guarantees a default exists, so `match` is defined.
    agentic.recordNodeResult(run.id, nodeId, {
      status: "done", finishedAt: Date.now(),
      chosenEdges: [`${match.from}->${match.to}`],              // single persist
    });
  } else {
    agentic.recordNodeResult(run.id, nodeId, { status: "done", finishedAt: Date.now() });
  }
}
```

Replace BOTH reap done-sites (the `code === 0` branches, ~L3005 and ~L3019) with
`await recordTerminalDone(run, cfg, nodeId)`. status + chosenEdges land in a
SINGLE `recordNodeResult` (one persist) so a crash can never split them
(D3-layer-2). Non-router nodes need no chosenEdges — `decide()` derives their
taken edges from `status` + labels. `provider` is the same
`AgentRuntimeProvider` the spawn path uses.

Failure sites are UNCHANGED: a nonzero exit / timeout still funnels through
`retryOrFailNode`, which records `failed` only on retry exhaustion. That is
correct for routing too (see §5d).

**5b. Skips.** In `advanceRun`, after `decide`, record every id in `toSkip` via
`agentic.recordNodeResult(runId, id, {status:"skipped", finishedAt})`, set
`changed=true`, and continue the loop (so the closure re-derives). Order relative
to spawn: process `toSkip` first, then `toSpawn`. `decide()` is called at EXACTLY
one site (`advanceRun`'s `while(changed)` loop) — no other caller reads its shape,
so adding `toSkip` is safe there.

**5d. Retry × routing (no new code; specified for tests).** Because
`retryOrFailNode` records `failed` only after attempts are exhausted:

- an `on:"failure"` agent-task with a `retryPolicy` retries first, and only its
  FINAL failure is recorded — `decide()` then sees a _handled_ failure and takes
  the failure branch (no fail-fast). "Retry exhausts, THEN routes."
- a `router` with a `retryPolicy` that keeps exiting nonzero retries, then on
  exhaustion records `failed` with no `chosenEdges` → fail-fast (its `default`
  edge is for label-mismatch on a SUCCESSFUL run, never for process failure).
  Both are emergent from the existing retry path + §3 decide; add tests, not code.

**5c. Workspace-write ban refinement (D-Route-3).** At the custom-mode ban
(~L3197): a node's out-edges are _parallel fan-out_ only if out-degree > 1 AND
the edges are **plain/unlabeled** (concurrent successors). A `router` node (or any
node whose out-edges are `on`/`when`-labeled) is **mutually exclusive** → NOT a
parallel writer. Refine `isBranching`/the ban so:

- keep 422 `parallel_write_forbidden` for: a node with >1 **plain** out-edge,
  OR >1 root (in-degree-0) node, OR a plain join (>1 plain in-edge feeding a
  node whose siblings run concurrently — keep the existing in-degree>1 rule ONLY
  when the contributing edges are plain).
- ALLOW workspace-write when branching is via labeled/router edges only.
  Simplest correct implementation: compute, per node, `plainOut` = count of
  unlabeled out-edges. `parallelFanout = any node with plainOut > 1`. Keep the
  multi-root check. For in-degree, only count **plain** in-edges toward the join
  concern. If neither parallel-fan-out nor multi-root nor plain-join ⇒ allow
  workspace-write. Add nothing new to the error code.

## 6. Runtime seam (`agent-runtime.js`)

Extend `parseResult(logTail, exitCode)` → `{status, branch}`:

- `status` unchanged (exit 0 → done else failed).
- `branch`: the label from the LAST line matching `/^\s*BRANCH:\s*(\S+)\s*$/im`
  in `logTail`, else `null`. Provider-agnostic (both codex + claude emit plain
  text we tail). Keep it a pure function; `logTail` may be "".

## 7. Frontend (`public/agentic/app.html`)

- DAG builder: node type select gains `router`. When a node is `router`, its
  out-edge rows get a `when` label text field and the UI must ensure a `default`
  edge exists (or show a hint). For a non-router node, offer an optional
  `on: success/failure` select per out-edge. Keep it form-based, text-only,
  self-contained; PATCH the same `{workflow}` payload.
- Run view: for each node show `chosenEdges` (which branch was taken) and render
  `status:"skipped"` nodes greyed/labelled "skipped".

## 8. Tests (Opus writes — `test/agentic-endpoints.js`)

Per plan §2 "### Tests":

1. Router by structured output → the matched branch runs, the other subtree is
   `skipped`, run `completed` (stub emits `BRANCH: <label>`). **The dead branch
   MUST be a CHAIN of ≥2 nodes (`b1→b2→join`)** so the test exercises the
   TRANSITIVE skip closure (skipped `b1` ⇒ its plain out-edge untaken ⇒ `b2`
   skipped), not just a single-node skip. The join must have one live + one dead
   in-edge and MUST still run.
2. `on:success`/`on:failure` labeled edges → failure path runs the fixer +
   success subtree skipped (stub `__FAIL__`), and the success case (vice-versa).
   Assert the failed `on:failure` node does NOT fail-fast the run.
3. Router missing `default` → `422 invalid_workflow` at save. Also: mixed
   labeled+plain out-edges on one node → 422; `on` off a router → 422.
4. Workspace-write behind a router → allowed (201/202); behind a plain fan-out →
   still `422 parallel_write_forbidden` (D-Route-3).
5. Restart after the router decided but before successors spawned → boot
   rediscovers `chosenEdges`, resumes the correct branch, others skipped
   (D3-layer-2 load-bearing).
6. **Retry × routing (advisor #3):** (a) an `on:"failure"` node with
   `retryPolicy{maxAttempts:2}` that always fails → retries once, then routes to
   the failure branch (run completes via the fixer, NOT failed); (b) a `router`
   with `retryPolicy` that always exits nonzero → fail-fasts after exhausting
   (never takes `default`).
7. Regression: existing diamond / sequential / human-approval tests unchanged
   (they carry no labels/routers, so decide() behaves identically).

## 9. Stub CLI addition (tests)

Add a `BRANCH=<label>` sentinel: when present in the objective, the stub echoes
`BRANCH: <label>` to stdout before `STUB-DONE-OK` so a router picks that branch.
