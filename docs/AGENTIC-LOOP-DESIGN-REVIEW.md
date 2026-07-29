# Bounded iteration ("revise-until-good") — A2 DESIGN REVIEW

> **Status: FOR REVIEW — not approved to build.** This is the HEAVY checkpoint the
> Arc II plan (`docs/AGENTIC-RICHER-WORKFLOWS-II-PLAN.md` §A2) mandates _before_
> writing code. It asks for sign-off on the decisions in §2. Nothing is
> implemented; `test:agentic` is at 381 (retry + router + eval + budget shipped).

Opus authored this after building the four predecessor slices, so the references
below are to real, current code on `feat/agentic-ai-creator`.

---

## 1. What A2 is, in one paragraph

A1 (eval node) turns an agent's output into a quality verdict (`BRANCH: pass|revise`).
A2 closes the loop: **on `revise`, re-run the node; repeat until `pass` or a cap.**
The payoff is "keep improving until good enough, then stop." The danger is that the
obvious shape — a **back-edge** from evaluator back to worker — breaks three load-
bearing invariants at once:

1. `resolveWorkflow`'s acyclic DFS (cycles rejected at save, `agentic.js` ~L262).
2. `decide()`'s `every node done|skipped ⇒ completed` rule — a re-runnable `done`
   node makes "completed" ill-defined.
3. D3-layer-2 — the loop's position (which iteration) must survive a gateway restart
   with no in-memory state.

**The whole review turns on avoiding the back-edge.**

---

## 2. Decisions requiring your sign-off (each has a recommendation)

### D-Loop-1 — Iteration is a driver-owned POLICY, not a loop-node. **[recommend: POLICY]**

This repo has twice chosen "hard thing = driver policy that keeps the reducer pure
and the DAG acyclic": **retry-as-policy** (Arc I, which chose this _explicitly to
avoid opening the loops door_) and **router-`chosenEdges`**. A2 is the third instance.

- **Policy (recommended):** an `agent-task` node carries `loopPolicy {maxIterations,
until, backoffMs}`. The agent both works and self-judges, emitting `BRANCH:
<verdict>` (the **exact** `parseResult` seam A1/router already parse). On a
  non-`until` verdict the _driver_ respawns the node as the next iteration — the
  same idempotent machinery retry already uses (`retryOrFailNode`: clear markers,
  bump a persisted counter, re-materialize, respawn). The node stays `running`
  across iterations, so **`decide()` never sees a back-edge and is NOT touched.**
- **The case _against_ policy (argue this before agreeing):** a policy hides the
  loop from the DAG — the Gantt/graph view can't draw "worker→evaluator→worker",
  and a 2-node worker+evaluator loop is more legible than a single self-judging
  node. **Rebuttal:** legibility is an FE concern (the Run view shows "iteration
  N/max"), not a reducer concern; and the single-node form is a strict superset of
  retry we already trust. If we ever want the 2-node form it can be added later as
  an ergonomic layer over the same counter — it does **not** need a back-edge either
  (a `loopId` tag on the pair, driver respawns the pair's worker). Starting with the
  node-pair now buys legibility at the cost of a new grouping primitive before we've
  validated the counter mechanics.
- **Sub-decision (node form):** ship the **single-node inline form first** (agent
  works + self-judges via `BRANCH: continue|done`). Worker+evaluator pair = later.

### D-Loop-2 — while-only in v1; dynamic-width map DEFERRED. **[recommend: confirm]**

A bounded `while` (fixed node set + a counter) is tractable as a policy. **Map-reduce
is not** — its fan-out width is _data-dependent_ (how many children depends on a list
the agent emits at runtime, unknown at `resolveWorkflow` time). That means runtime
node materialization, dynamic budget/skip/join over nodes that didn't exist at save —
it fights the "static DAG validated once" model the whole engine rests on (and the B2
budget's `spawnsUsed` accounting, and the router skip-closure). **v1 ships `while`
only; map-reduce is its own future slice with its own checkpoint. Do not lump them.**

### D-Loop-3 — Exhaustion outcome: `done` + `loopExhausted:true`, or `failed`? **[recommend: done+flag]**

When iterations hit `maxIterations` without reaching `until`, the loop _ran_ — it
just didn't converge. Two options:

- **`done` + persisted `loopExhausted:true` (recommended):** a downstream router can
  branch on "converged vs. gave up" (e.g. `revise` never reached `pass` → ship the
  best-effort output but flag it, or route to a human gate). Composes with A1/router.
- **`failed`:** simpler, but conflates "didn't converge" with "process error," and a
  fail-fast would kill the run even though the work product exists.
- **Consequence either way:** `loopExhausted` is display-only + routable; it is NOT a
  new reducer concept (it rides `chosenEdges`/status the same way A1's `score` does).

### D-Loop-4 — The counter tangle (THE hard part). **[recommend: dedicated `crashRespawns` counter]**

This is the decision the plan under-weights and the one most likely to cause a
survivability bug — it touches the exact code that already produced two advisor-caught
bugs (the retry crash-cap `06aafff`, and `retryPolicyForNode` missing routers).

Today there are **two** respawn reasons, arbitrated in the reap "never-ran" branch by
`spawnAttempts - retryCount >= 2` (the `06aafff` fix — retry respawns bump
`spawnAttempts` so they're subtracted out). A2 adds a **third** respawn reason (loop
iteration), which ALSO bumps `spawnAttempts` via `recordSpawned`. So after 2 loop
iterations, `spawnAttempts - retryCount` reaches 2 and the crash-recovery cap **falsely
fails a healthy looping node.** Extending the arithmetic to
`spawnAttempts - retryCount - (iterationCount-1) >= 2` works but is fragile: it also
forces `retryCount` to stay _cumulative_, which then breaks per-iteration retry budget
(a fresh iteration should get a fresh `maxAttempts`, but cumulative `retryCount` would
carry spent retries into the next iteration).

**Recommendation — stop overloading `spawnAttempts` arithmetic; give each respawn
reason its own counter with one job:**

| counter                | increments when                           | caps against               | resets                 |
| ---------------------- | ----------------------------------------- | -------------------------- | ---------------------- |
| `crashRespawns` (NEW)  | reap "never-ran" idempotent recovery only | `>= 2` ⇒ fail              | never                  |
| `retryCount`           | a ran-and-failed attempt is retried       | `retryPolicy.maxAttempts`  | **per loop iteration** |
| `iterationCount` (NEW) | a converged-`revise` iteration respawns   | `loopPolicy.maxIterations` | never                  |

The crash cap becomes simply `crashRespawns >= 2` — decoupled from retry/loop, so
adding a third respawn reason can't corrupt it. `spawnAttempts` stays only as the
"persisted-before-spawn" ordering marker (diagnostic), no longer load-bearing for the
cap. This is a small, well-scoped refactor of the `06aafff` logic — but it edits
survivability code, so it needs your explicit OK. All three counters stay **off-wire**
(mirroring `spawnAttempts`/`retryCount` today).

### D-Loop-5 — Do iterations carry memory? (statefulness) **[recommend: claude `--resume`, codex stateless — confirm]**

"Revise-until-good" is far more useful if iteration N sees iteration N-1's work. The
engine already has the mechanism: **iter6 guidance** re-runs a claude node with
`--resume <sessionId>` so the agent keeps its history. Reuse it:

- **claude-cli loop iteration = `--resume`** (agent sees its prior output + its own
  `revise` verdict and actually improves). NB: this reuses guidance's `--resume`
  _invocation_ + the persisted `providerSessionId`, **not** guidance's state
  transition — guidance resumes a `done` node (done→running, `turns++`) whereas a
  loop node stays `running` across iterations (`iterationCount++`). The loop path is
  NOT `recordGuidanceTurn`; it is the new `loopOrDoneNode` respawn using the same CLI
  flag.
- **codex-cli has no resume** (already fail-closed for guidance). Two options:
  (a) **stateless re-run** (same prompt each iteration; a weaker "retry-until-verdict",
  honestly documented), or (b) **fail-closed** (reject `loopPolicy` on a codex node,
  like guidance does). Recommend **(a) stateless, documented** so codex loops still
  work for idempotent tasks; flag if you'd rather fail-closed for parity with guidance.

### D-Loop-6 — retry × loop composition (specify, mostly test-only). **[recommend: compose]**

Retry and loop are orthogonal: **retry** handles _process failure within one
iteration_; **loop** handles _verdict-driven re-invocation across iterations_. A single
iteration that exits nonzero is retried per `retryPolicy`; only its final (post-retry)
**success** produces the verdict the loop reads. With per-iteration `retryCount` reset
(D-Loop-4), this composition needs **no new coupling code** — it falls out of reap
ordering (retry intercepts nonzero exits before the loop ever sees a verdict). It is
nailed by tests, not code. (If you'd rather cut risk, the alternative is forbidding
`retryPolicy` + `loopPolicy` on one node in v1 — but D-Loop-4's dedicated counters
already make composition safe, so I don't recommend the cut.)

---

## 3. Design (assuming the recommendations above)

### Verdict & convergence (reuses A1/router seam, no new parse)

- The node emits `BRANCH: <verdict>` (already parsed by `agent-runtime.parseResult →
{status, branch, score}`). `loopPolicy.until` names the converged verdict (default
  `"done"`). Optional `SCORE:` still displays (A1).
- Reap done-site (`recordTerminalDone`, exit 0): if the node has `loopPolicy`:
  - `branch === until` ⇒ record `done` (converged; `iterationCount` frozen). Plain
    out-edges then fire normally.
  - `branch !== until` AND `iterationCount < maxIterations` ⇒ **loop respawn**: a new
    `loopOrDoneNode` helper (sibling to `retryOrFailNode`) clears markers, bumps
    `iterationCount`, resets `retryCount`, waits `backoffMs`, respawns (claude:
    `--resume`; codex: fresh). Node stays `running`.
  - `iterationCount >= maxIterations` ⇒ record `done` + `loopExhausted:true` (D-Loop-3).
- A **nonzero** exit is still a process failure → `retryOrFailNode` (unchanged);
  retry runs _before_ any verdict is read (D-Loop-6).

### `decide()` — NOT touched

A looping node is `running` throughout (between iterations too), exactly like a
retrying node. `decide()` stays pure/cost-blind/back-edge-free. **This is the design's
whole point** — same win as retry, router, eval, budget: the reducer is never the
thing that changes.

### Schemas (`shared-types`)

`WorkflowNodeSchema` gains optional `loopPolicy = {maxIterations: int≥1, until:
non-empty string (default "done"), backoffMs: int≥0}` — all optional; absent ⇒ current
single-shot behavior (backward-compatible). Off-wire `iterationCount`/`loopExhausted`
surface on `NodeExecution` only for the Run view (mirror `chosenEdges`/`score`).

### `resolveWorkflow`

Validate + clamp `maxIterations` to `AGENT_LOOP_MAX_ITERATIONS` (default 8, mirrors
`retryPolicy.maxAttempts`/`RETRY_MAX_ATTEMPTS_CAP`); clamp `backoffMs` to
`AGENT_LOOP_BACKOFF_MAX_MS` (default 60000). `until` non-empty. `loopPolicy` allowed on
`agent-task` (and `router`? — a self-judging loop IS router-like; **recommend
agent-task only in v1**, since a router already branches and a loop self-judges to
continue/converge, not route). No decide()/edge changes.

### Frontend (`public/agentic/app.html`)

A "Loop" sub-form on a node (max iterations + `until` verdict + backoff), sibling to
the existing retry sub-form. Run view: "iteration N/max" + last verdict + a
`loopExhausted` marker. Reuses the retry-sub-form and score/chosenEdges rendering
patterns.

### Env (`.env.example`)

`AGENT_LOOP_MAX_ITERATIONS=8`, `AGENT_LOOP_BACKOFF_MAX_MS=60000` (both optional,
mirror the retry caps).

---

## 4. Tests (Opus writes, mirroring the retry/router load-bearing tests)

1. **Converges on iteration 2** → run `completed`, `iterationCount===2`. (Stub emits
   `BRANCH: revise` on invocation 1, `BRANCH: done` on invocation 2 — reuse the
   FAILFILE-style persistent counter to drive per-invocation behavior.)
2. **Never converges** → stops at `maxIterations` with `loopExhausted:true` and the
   run terminal per D-Loop-3; assert exactly `maxIterations` invocations.
3. **LOAD-BEARING restart mid-iteration** → SIGKILL between iteration 2's verdict and
   the iteration-3 respawn; reboot re-derives `iterationCount` and converges — the
   direct analog of Arc I's restart-mid-retry test (that test is the template).
4. **`loopPolicy` absent ⇒ single shot** (regression).
5. **retry × loop ordering (D-Loop-6)** → an iteration that fails once then succeeds
   with `revise` retries WITHIN the iteration (retryCount, reset next iteration) then
   loops; a converged run shows the right `iterationCount` with retries not leaking
   across iterations.
6. **crash cap decoupled (D-Loop-4)** → a healthy 3+ iteration loop does NOT trip the
   `crashRespawns>=2` cap (the bug the refactor prevents); and a genuine crash-in-spawn
   still fails after 2 crash respawns regardless of iteration/retry count.

---

## 5. Blast radius & why this is HEAVY

- **Touches survivability code** (`retryOrFailNode`, the reap never-ran branch, the
  `06aafff` crash cap) — the D-Loop-4 counter refactor is the real risk, not the loop
  itself. Mitigated by test #6 + the restart test #3.
- **Reuses, does not invent:** verdict parse (A1), respawn machinery (retry),
  `--resume` invocation + `providerSessionId` (guidance), clamps (retry). `decide()`
  untouched. That containment is what keeps a HEAVY slice tractable.
- **Budget × loop is a clean, positive interaction** (this is _why the plan sequenced
  B2 before A2_): a `while` loop spawns once per iteration, so B2's `maxSpawns`
  already caps a runaway loop as a **second safety net beneath `maxIterations`** — a
  loop that somehow keeps going still halts at `budget_exhausted`. No new code; the
  B2 gate counts loop spawns like any other.
- **Deferred out of v1 (explicit):** dynamic-width map (D-Loop-2), worker+evaluator
  2-node form (D-Loop-1), loopPolicy on router nodes, codex `--resume` (impossible).

---

## 6. The sign-off checklist (what I need from you before building)

1. **D-Loop-1** — policy (single-node inline `loopPolicy`), not a loop-node?
2. **D-Loop-2** — while-only, map-reduce deferred?
3. **D-Loop-3** — exhaustion = `done`+`loopExhausted:true` (vs `failed`)?
4. **D-Loop-4** — the dedicated `crashRespawns` counter refactor (vs the fragile
   arithmetic extension)? **This is the one that edits survivability code.**
5. **D-Loop-5** — claude `--resume` stateful iterations + codex stateless (vs
   fail-closed codex)?
6. **D-Loop-6** — compose retry × loop (vs forbid both on one node in v1)?

Answer these (or amend) and I'll turn this into an implementation spec + build it with
the same Codex-writes / Opus-controls loop.
