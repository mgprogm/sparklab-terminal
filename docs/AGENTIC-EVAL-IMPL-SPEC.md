# Eval / self-critique node (A1) — implementation spec (Opus-authored)

Implements `docs/AGENTIC-RICHER-WORKFLOWS-II-PLAN.md` §A1 (D-Eval-1..3). An eval
node **IS a router that judges** — it reuses the router seam wholesale. Per
D-Eval-1 ("the only additions are authoring ergonomics (FE) and an optional
structured verdict payload"), there is **NO new backend node type and NO reducer
change**. `decide()`, `resolveWorkflow`, and `retryPolicyForNode` are **NOT
TOUCHED** — that is the whole point: it makes the router regression class
impossible for this slice. Checkpoint is LIGHT.

Decision (Option P, advisor-confirmed): an eval node is a **plain `router` node**
authored via an FE "evaluation" template with verdict labels (`pass`/`revise`/
`default`). The only backend addition is a **display-only `SCORE`** — carried,
shaped, rendered, and read by NOTHING in routing/skip logic.

## Backend — SCORE only (display-only, D-Eval-2: NEVER a routing input)

1. `agent-runtime.js parseResult(logTail, exitCode)` → add `score` to the return:
   `{status, branch, score}`. `score` = the number in the LAST line matching
   `/^\s*SCORE:\s*(-?\d+(?:\.\d+)?)\s*$/im`, parsed with `Number`, else `null`.
   Keep it pure; `logTail` may be "". Do NOT change `status`/`branch` behavior.

2. `server.js recordTerminalDone` — the router branch already calls
   `parseResult(logTail, 0)`. Also read `score` from that SAME call and pass it
   (when it is a finite number) in the SAME `recordNodeResult(...)` that already
   writes `status:"done"` + `chosenEdges` (one persist, atomic). Non-router nodes
   are unchanged (no score).

3. `agentic.js recordNodeResult(runId, nodeId, {status, finishedAt, error,
chosenEdges, score})` — accept optional `score`; when `Number.isFinite(score)`
   persist `ne.score = Number(score)`. `shapeNodeExecution`: emit `score` when it
   is a finite number (mirror the `chosenEdges` conditional-spread pattern).
   Add a one-line comment: **score is display-only metadata — `decide()` and all
   routing/skip logic MUST never read it.**

4. `packages/shared-types/src/terminal.ts` — `NodeExecutionSchema` gains optional
   `score: z.number()` (display-only; document it).

**Explicitly DO NOT edit:** `decide()`, `resolveWorkflow`, `retryPolicyForNode`,
the workspace-write ban, or any edge/skip logic. An eval node is a router; those
paths already handle it.

## Frontend (`public/agentic/app.html`) — evaluation template + SCORE line

1. **Evaluation template action.** Add a builder button, e.g. "Add evaluation"
   (next to "Add node"), that inserts a `router` node pre-seeded as a judge:
   - append a new node `{type:"router", agentId: <first team agent>}`;
   - if ≥2 other nodes already exist to branch to, also append two out-edges from
     it: `{when:"pass", to:<a node>}` and `{when:"default", to:<another node>}`
     (reuse the existing edge-add + auto-`default` helpers); if <2 targets exist,
     just add the router node and let the author wire it (the existing router edge
     UI shows the `when` inputs). This is a convenience preset over the SAME router
     type — nothing new persists beyond `type:"router"` + `when` edges.
     Keep it self-contained, textContent-only, matching existing builder style.

2. **Run view SCORE line.** In `renderNode`, when `ne.score` is a finite number,
   append a `SCORE: <n>` line (near the existing "Branch: …"/chosenEdges line).
   No other Run-view change.

3. No `saveTeamWorkflow` change is needed beyond what router already emits (the
   template produces a normal `router` node with `when` edges).

## Tests (Opus writes — `test/agentic-endpoints.js`)

The routing/skip behavior of an eval node is ALREADY proven by the iter11 router
tests (an eval node is a router). The genuinely-new backend behavior is SCORE, so
that is where the new coverage concentrates:

1. **SCORE is display-only, never a routing input (the load-bearing guard).** A
   router node emits `BRANCH: pass` + `SCORE: 2`. Assert: it takes the `pass`
   branch (NOT influenced by the low score), the run routes/ completes on `pass`,
   AND `score:2` is persisted + returned on GET for that node. (A verdict-flavored
   reuse of the router structured-output shape, with a ≥2-node skipped branch to
   re-confirm the closure still holds for an eval-style node.)
2. **SCORE absent ⇒ no `score` field** (regression guard: plain router nodes and
   agent-tasks never gain a `score`).
3. Eval node exits nonzero ⇒ PROCESS failure (fail-fast, no branch/score) — a
   thin reuse of the router-fail shape, asserting a failing judge does not route.
   (Optional if router 6b already covers the mechanism — fold if redundant.)

## Stub CLI (tests)

Add a `SCORE=<n>` objective sentinel mirroring the existing `BRANCH=<label>`:
when present the stub echoes `SCORE: <n>` before `STUB-DONE-OK`. Charset limited
to digits / `.` / `-` so the sed capture is safe.
