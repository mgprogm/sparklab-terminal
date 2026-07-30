# Bounded iteration ("revise-until-good") — A2 DESIGN REVIEW

> **Status: SHIPPED (commit 98d88fa, deployed). Design settled over 4 Codex review rounds (§7-§10); R8 parser (970b137) + A2 both built + verified. test:agentic 417; real-claude --resume smoke passed.** This was the HEAVY checkpoint the
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

---

## 7. Codex review — findings & resulting amendments (2026-07-29)

Codex reviewed this doc against the real code and returned **"not ready as an
implementation spec as-is."** It kept D-Loop-1 and D-Loop-2, but found real gaps.
Opus concurs with all of the below; they become build preconditions.

**Verdicts:** D-Loop-1 AGREE-w/-amendment · D-Loop-2 AGREE · **D-Loop-3 DISAGREE** ·
D-Loop-4 AGREE-w/-amendment · D-Loop-5 AGREE-w/-amendment · D-Loop-6 AGREE-w/-amendment.

### Amendments that change the design

- **A durable `loopPending` transition is required (D-Loop-1).** Retry is restart-safe
  because `recordRetryAttempt` persists `retryPending` BEFORE marker cleanup + respawn.
  The loop needs the same: persist `loopPending` (and the counted verdict) before
  clearing `exit.marker`, else a crash after counting a verdict but before clearing its
  marker can process that verdict twice / skip an iteration. **Add `loopPending`.**
- **A loop node is an `agent-task`, but `recordTerminalDone` parses `branch`/`score`
  ONLY for `type==="router"` (server.js).** So a loop node would discard its own
  verdict. **Fix: `recordTerminalDone` must parse for a loop node (agent-task with
  `loopPolicy`) too**, not just routers.
- **D-Loop-3 routing does NOT exist — DISAGREE.** `decide()` routes agent-tasks only by
  `done`/`failed`; `chosenEdges` is consulted only for routers; `resolveWorkflow`
  forbids `when` edges on agent-tasks; there is no inter-node data threading. So a
  downstream router **cannot** read `loopExhausted`. **Choose: (a) `loopExhausted` is
  DISPLAY-ONLY and the node always follows its plain success edges (recommended for
  v1 — keeps decide() untouched), or (b) add real `on: converged|exhausted` edge
  semantics — which DOES touch `resolveWorkflow` + `decide()` (drops A2 out of "reducer
  untouched").** Opus recommends **(a) display-only in v1**; defer routable-exhaustion.
- **`crashRespawns` was underspecified and would LOOSEN the cap (D-Loop-4).** Today the
  first never-ran observation permits one recovery, the second fails. "Increment on
  recovery, fail at ≥2" would permit TWO recoveries. **Use a persisted `neverRanCount`
  incremented atomically when reap sees no-session+no-markers; fail when it reaches 2
  (one recovery), else respawn — paired with `loopPending`.** (Codex confirmed the bug
  is real but only in the crash-in-spawn window — a restart merely after 2 healthy
  iterations does NOT fail, since exit/start markers route elsewhere.)
- **D-Loop-5 is more than a flag.** `spawnNode` mints a fresh UUID every call and never
  passes `resume`. The loop path must retrieve the persisted `providerSessionId`, keep
  it, call `buildInvocation({resume:true})`, AND send a continuation prompt ("revise the
  prior result; last verdict was revise") — resending the original objective is not a
  revision instruction. **Reject codex `loopPolicy` in v1 (fail-closed)** — a stateless
  repeat is too weak to call "revise-until-good."
- **D-Loop-6 needs coupling code, it does NOT "fall out."** A resumed claude iteration
  that exits nonzero currently goes `retryOrFailNode → spawnNode` → NEW session id +
  fresh non-resume → context lost. **The current iteration's invocation mode/session
  must be persisted so a retry repeats the SAME semantic iteration**; the `retryCount`
  reset needs an atomic mutator coordinated with `loopPending`.

### Cross-cutting issues Codex surfaced

- **⚠️ Latent issue in ALREADY-SHIPPED router/eval: `parseResult` reads plaintext
  `BRANCH:`/`SCORE:` lines, but claude runs with `--output-format stream-json`.** The
  tests only ever used a plaintext stub — the branch/score parsing has NEVER been proven
  against real claude output. This must be verified (structural parse of stream-json, or
  a real fixture proving standalone lines survive) — it affects router + eval today, not
  just A2. **Worth a follow-up regardless of A2.**
- **Budget-gate bypass.** `advanceRun` reaps BEFORE `budgetExhausted`. If the loop
  respawn happens inside `recordTerminalDone` (in reap), it spawns BEFORE the gate — so
  `maxSpawns` won't PREVENT it (only counts it after). The "B2 caps a runaway loop"
  claim in §5 is therefore only true up to a one-cycle overshoot. **Fix: the loop
  respawn must do a pre-spawn budget check, or be driver work processed after the gate.**
  (Note: retry respawns have the same one-cycle-overshoot property today.)
- **Persistence/tests underspecified:** define `iterationCount` initial semantics
  (esp. `maxIterations:1`); persist `lastVerdict` (the UI promises it, the schema
  omits it); `until` must be a bounded non-whitespace token compatible with
  `parseResult`; add phase-specific crash-recovery tests (crash before verdict persist /
  after persist before cleanup / after cleanup before recordSpawned / after recordSpawned
  before tmux — the single "restart between verdict and respawn" test is too coarse);
  add `maxIterations:1`, loop-under-`maxSpawns`, and a real claude stream-json fixture.

**Net:** D-Loop-1/2 stand; D-Loop-3 flips to display-only-in-v1 (keeps decide()
untouched); D-Loop-4/5/6 gain `loopPending` + `neverRanCount` + persisted per-iteration
invocation context + fail-closed codex. The budget-gate bypass and the claude
stream-json parsing question must be resolved before build. Opus will fold these into
the implementation spec once you confirm the D-Loop-3 direction (display-only vs. real
edge semantics) — the one remaining true fork.

---

## 8. Codex review — round 2 (Opus's resolutions re-reviewed, 2026-07-29)

Opus put the §7 resolutions (R1–R8) back to Codex. **Verdict: still NO-GO — direction
sound, but three resolutions have restart-safety errors that must be corrected first,
and R8 is a delivery dependency.** Per-resolution: R1 GO-w/-conditions · R2
GO-w/-conditions · **R3 GO** · **R4 NO-GO** · **R5 NO-GO** · **R6 GO** · **R7 NO-GO** ·
R8 GO-w/-conditions (but a ship blocker). Opus concurs with every point.

### The three corrections A2 must adopt before it can become a spec

- **R4 — `neverRanCount` alone is NOT restart-idempotent.** If reap persists
  `neverRanCount=1` then the gateway dies BEFORE the recovery respawn, reboot observes
  the same no-session+no-markers state, increments to 2, and fails — **consuming the
  one allowed recovery purely because of a restart** (the exact window the cap exists to
  survive). **Fix: pair it with a durable `neverRanPending` phase flag (cleared by
  `recordSpawned`)** so a reboot mid-recovery resumes the respawn without re-counting —
  same phase-flag discipline as `retryPending`/`loopPending`. This is the single most
  important defect. (So: EVERY respawn reason — crash-recovery, retry, loop — needs a
  `*Pending` phase flag; the counter alone is never enough.)
- **R5 — the per-iteration invocation record contradicts itself.** Iteration 1 is
  `mode:"fresh"` (no session yet); a retry of it must therefore stay `fresh`, but the
  resolution said retries "resume." **Fix: specify that `mode` flips `fresh→resume` only
  once a `providerSessionId` has actually been captured from a completed claude run;
  define retry behavior for a failure BEFORE the session exists; and `spawnNode` must
  stop minting a fresh UUID unconditionally and instead reconstruct the same iteration's
  prompt/session.**
- **R7 — "let the budget gate halt it next cycle" does NOT work.** After reap records the
  loop node `done(+loopExhausted)`, `advanceRun` runs `decide()` and hits
  `terminal:"completed"` **before** `budgetExhausted()` (the gate sits after
  completed/failed). A terminal/leaf loop would therefore **complete instead of
  budget_exhausted**. **Fix: the loop-stops-on-budget path must EXPLICITLY set the run
  `budget_exhausted` itself** (not rely on the next-cycle gate).

### Delivery dependency

- **R8 — the claude stream-json parser is a ship/acceptance BLOCKER, not just parallel
  work.** Real claude runs `--output-format stream-json`; `parseResult()` only matches
  standalone plaintext `BRANCH:` lines (proven only against the plaintext test stub).
  Without a real parser, **production loops never see `done` and always exhaust** — and
  the same gap already undermines shipped router + eval with real claude. Must be fixed
  as part of (or before) A2, with a real stream-json fixture test.

### Where this leaves A2

Design direction confirmed sound across two review rounds; the reducer stays untouched.
Remaining before an implementation spec: fold in R4 (`neverRanPending`), R5 (fresh→resume
state machine), R7 (explicit budget transition), and treat R8 (stream-json parse) as a
gating dependency. Recommended sequencing: **do R8 first** — it de-risks A2 AND
retroactively fixes router/eval against real claude — then build A2 with the three
corrections.

---

## 9. Codex review — round 3 (convergence check, 2026-07-29)

Big convergence: **F-R1, F-R2, F-R3, F-R6 = GO**; F-R5, F-R8 = GO-with-conditions
(need claude session-ID extraction); only **F-R4 and F-R7 remain NO-GO**, narrowed to
THREE precise questions. Codex: "direction sound; one focused design round warranted
for those three; R8 still lands first." The three:

1. **F-R4 needs a TWO-part durable recovery state.** A single `neverRanPending` flag is
   contradictory: if `recordSpawned` clears it, a recovered spawn that ALSO never-runs
   looks fresh and gets endless recoveries; if it never clears, a restart-before-respawn
   is indistinguishable from a genuine second observation. **Fix: persist BOTH
   `neverRanRecoveryCount` (committed recoveries, never cleared) AND `neverRanPending`
   (this recovery's respawn not yet performed, cleared by `recordSpawned`).** Reap
   never-ran: if `neverRanPending` set ⇒ resume respawn (don't recount); else if
   `neverRanRecoveryCount ≥ 1` ⇒ fail; else set pending + count=1 + respawn. Exactly one
   recovery, restart-idempotent.
2. **F-R7 must define what happens to CONCURRENT nodes when a loop respawn hits budget.**
   `setRunStatus("budget_exhausted")` from the loop path while sibling nodes are still
   `running` makes the run terminal → those nodes are no longer reaped (orphaned) — it
   does NOT reuse the existing gate's `anyInFlight` let-finish. **Fix: the loop-hits-
   budget path must either `killRunningJobs()` (immediate cancel) or set a deferred
   budget-halt intent that the existing gate finalizes with its let-finish +
   nothing-in-flight semantics** — not a unilateral terminal flip.
3. **F-R5/R8 must define claude session-ID extraction + persistence.** The fresh→resume
   machine needs the session ID, but `parseResult` returns only status/branch/score and
   failed attempts bypass it. **The R8 parser contract must expose claude's session ID
   from the stream-json (captured even on a NONZERO-exit stream, for the pre-session
   retry case) and persist it atomically with the terminal record.**

**Opus's proposed resolutions (to vet in the focused round):** (1) two-part
`neverRanRecoveryCount`+`neverRanPending` exactly as Codex specifies; (2) a persisted
`budgetHalt` intent set by the loop path, finalized by the existing gate (reusing its
`anyInFlight` let-finish; no unilateral flip, no orphans) — vet that it takes priority
over a same-tick `completed`; (3) extend the R8 parser to return `sessionId` (from the
final result message, captured on success AND failure), stored on the node's
`iterationInvocation`. **Net: the design is sound across 3 rounds; R8 lands first; then
these three state-machine points are settled and A2 becomes an implementation spec.**

---

## 10. Codex review — round 4 (FINAL: design settled) — 2026-07-29

**Final judgment: YES — after the R8 parser slice lands, the three questions are
settled enough to write the A2 implementation spec.** All six original decisions +
the eight resolutions are now GO / GO-with-conditions. Per item this round:

- **F-R4 — GO.** The two persisted fields (`neverRanRecoveryCount` +
  `neverRanPending`) replace the fragile `spawnAttempts - retryCount` arithmetic and
  are restart-idempotent; retry/loop respawns never enter the never-ran branch so they
  can't interfere.
- **F-R7 — GO-WITH-CONDITION.** The `budgetHalt`-before-`completed` ordering beats the
  single-node completed race and preserves B2 when `budgetHalt` is unset. **CONDITION:
  the node's `done+loopExhausted` result AND `run.budgetHalt=true` must be ONE atomic
  persisted mutation** (a single mutator) — else a crash between them can still yield
  `completed`. Active-run polling finalizes after siblings drain, no kill/orphan.
- **F-R5 — GO-WITH-CONDITION.** Session UUID is engine-controlled, so no stream-json
  extraction. **CONDITION: an `exit.marker` proves the wrapper ended, NOT that claude
  created a resumable session — so set `sessionEstablished=true` only after claude
  exits 0; NEVER `--resume` after a nonzero-only attempt; a fresh retry rotates to and
  persists a NEW UUID** (avoids both resume-of-nonexistent-session and
  reuse-of-possibly-created-session ambiguity).

**Both conditions are written here so they carry into the implementation spec.**

### Build sequence (approved direction)

1. **R8 — claude stream-json parser slice — ✅ SHIPPED (commit `970b137`, deployed).**
   `parseResult` now extracts BRANCH/SCORE structurally from claude stream-json (result →
   assistant-text → raw-plaintext preference), verified against genuine claude 2.1.220
   output; `test:parse` (21 checks); `test:agentic` still 381 (plaintext path
   byte-identical). Retroactively fixed shipped router + eval (only ever proven against
   the plaintext stub before). Session id stays engine-controlled.
2. **A2 implementation spec** folding in: D-Loop-1/2 (policy, while-only), F-R1
   (display-only `loopExhausted`), F-R2 (`loopPending`), F-R3 (parse loop in
   `recordTerminalDone`), F-R4 (two-part crash-recovery state), F-R5 (engine-controlled
   session + exit-0 establishment + UUID rotation), F-R6 (codex fail-closed at
   startRun), F-R7 (atomic `budgetHalt` intent + gate ordering).
3. Build A2 with the same Codex-writes / Opus-controls loop + the load-bearing
   restart/phase-crash tests §7 named.

> **STATUS UPDATE:** design SETTLED after four review rounds. **R8 prerequisite SHIPPED
> (970b137).** Next: write the A2 implementation spec (fold §10 conditions) and build.
