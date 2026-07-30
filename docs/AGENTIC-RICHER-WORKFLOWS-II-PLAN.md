# Agentic AI Creator — Richer Workflows, Arc II — Design & Roadmap

> Status: **PROPOSED — no slice built yet.** This document picks up the items
> that `docs/AGENTIC-RICHER-WORKFLOWS-PLAN.md` §3 ("Deliberately deferred — still,
> after this arc") pushed past the retry + router arc, plus the operational
> candidates from `docs/AGENTIC-AI-CREATOR-PLAN.md` §8. It does **not** modify the
> closed Arc I doc — that arc bounds itself explicitly. Cross-link: Arc I §3 and
> v2 §8 should point here once a slice from this doc ships.
>
> **Predecessor state (verified against the working tree, 2026-07-29):**
>
> - Arc I §1 **Retry** — SHIPPED (iteration 10, commit `44fc3fd`): per-node
>   `retryPolicy`, driver-owned, 298 checks. Done and committed.
> - Arc I §2 **Condition/Router** — **implemented in the working tree with tests,
>   commit pending.** `decide()` already returns `{toSpawn, toSkip, running,
terminal}`; `chosenEdges` persist through `recordNodeResult`/`shapeNodeExecution`;
>   `recordTerminalDone` centralizes the router decision at both reap done-sites;
>   `parseResult` returns `{status, branch}`; the FE authors `router`/labeled edges;
>   `test/agentic-endpoints.js` carries ~449 new lines across the 7 impl-spec
>   scenarios (`docs/AGENTIC-ROUTER-IMPL-SPEC.md` §8). This doc assumes the router
>   lands as specified. **Do not build any Arc II slice until router is committed
>   and green** — several slices below build directly on the skip-closure `decide()`.

---

## 0. The two axes (read this first)

"Richer" splits into two independent axes with different risk profiles. The doc is
organized as two tracks, **not** one iteration sequence — do not linearize them.

- **Track A — graph semantics** (touches the pure reducer `decide()` and/or
  `resolveWorkflow`): evaluation/self-critique node, bounded iteration, agent-to-agent
  chat. High blast-radius, each needs the same "checkpoint before build" discipline
  router got.
- **Track B — operational** (touches the driver / reap / store, **never** `decide()`):
  scheduled & event-triggered runs, cost/token budgets. Lower reducer risk; the
  hazards are auth, idempotency, and slot accounting, not edge semantics.

**Load-bearing invariant, restated as a per-slice acceptance bar (D3-layer-2).**
Every slice below states _what it persists_ so that a gateway restart re-derives
identical run state from disk with no in-memory routing/loop/budget state. This is
the invariant that forced retry-as-policy and router-`chosenEdges`-on-disk; it is
non-negotiable and is called out in each slice, not just here.

Recommended order if the user wants a single next step: **A1 (eval node) first** —
it is the smallest, reuses the router seam wholesale, and breaks no invariant.

---

# Track A — Graph semantics

## A1. Evaluation / self-critique node (recommended next — iter11)

**Motivation.** Router + retry together _almost_ express "keep improving until the
output is good enough," but nothing today turns an agent's output into a routing
signal on quality (as opposed to process `status`). A self-critique node closes
that: an agent-task scores/judges a prior node's result and emits a verdict that a
router branches on ("good → ship; needs-work → revise").

**Disambiguation (do not conflate with v2 §8's "evaluation datasets").**

- **In scope here:** a _runtime_ self-critique **node** — branches the live run on a
  quality verdict of the current run's own output.
- **Out of scope (separate track, not this doc):** _evaluation datasets_ — offline,
  batch scoring of an agent _config_ against a fixture set. Different feature,
  different data model, no `decide()` involvement. Leave it deferred.

**D-Eval-1 — An eval node is a `router` specialization, not a new reducer concept.**
The router seam already parses one `branch` label from constrained output
(`parseResult → {status, branch}`, `BRANCH: <label>` sentinel; `recordTerminalDone`
persists `chosenEdges`) and `decide()` already skips the untaken subtree. An eval
node is a `router` whose agent is prompted to _judge_ rather than _route_, emitting
`BRANCH: pass` / `BRANCH: revise` (or a small fixed verdict set). **Reuse the router
machinery verbatim** — no new edge-taking rule, no new skip logic. The only additions
are authoring ergonomics (§A1 FE) and an optional structured verdict payload.

**D-Eval-2 — Verdict is a bounded enum, echoing D-Route-1's rejection of free-text.**
The verdict label set is author-declared and finite (e.g. `{pass, revise, reject}`),
matched to `when:"<label>"` edges with the mandatory `when:"default"`. No numeric
score comparison expression language in v1 (that would reintroduce the free-text
evaluator D-Route-1 rejected). A numeric score MAY be _displayed_ (parsed from a
second `SCORE: <n>` sentinel, display-only, never a routing input) — mark it clearly
non-load-bearing if added.

**D-Eval-3 — Persistence / re-derivability (acceptance bar).** Nothing new beyond
router: the chosen verdict edge is `chosenEdges` on the node execution, already
persisted in one `recordNodeResult` write. A restart re-derives the same branch.
The verdict node is `done` on exit 0 regardless of verdict (a judgment completing is
success); a nonzero exit is a _process_ failure → the existing retry/fail-fast path.

**Schemas.** None new required if verdicts ride existing `when` edges. Optionally a
display-only `score` on `NodeExecution` (off-wire unless the Run view surfaces it —
decide per FE need, mirror `chosenEdges`).

**Frontend.** DAG builder: a node-type affordance "evaluation" that is a router with a
verdict-oriented label preset and a hint that a `default` edge is required. Run view:
show the verdict taken (already shown as `chosenEdges`); render a `SCORE:` if parsed.

**Tests.** (a) eval node emits `revise` → the revise subtree runs, the `pass` subtree
is skipped, run completes (reuses the router transitive-skip test shape); (b) eval
node exits nonzero → treated as process failure (retry if policy'd, else fail-fast);
(c) missing `default` → `422 invalid_workflow` (already covered by router validation —
assert it applies to the eval preset).

**Checkpoint:** LIGHT. This is additive over a committed router; normal review suffices.

---

## A2. Bounded iteration — "revise-until-good" (iter12; **CHECKPOINT BEFORE BUILD**)

This is the hard slice. The payoff of A1 is a _loop_: eval says `revise` → run the
reviser → eval again → up to N times → give up or ship. Doing that naively wants a
**back-edge**, which fights three things at once: `resolveWorkflow`'s acyclic DFS
(enforced at save), `decide()`'s `every node done|skipped → completed` rule (a
re-runnable done node breaks it), and D3-layer-2 (loop position must survive restart).

**D-Loop-1 — Iteration is a driver-owned POLICY, not a back-edge node. (Leading
design; the reader must argue _against_ this, not for a loop node.)** This repo has
twice chosen "hard thing = driver-owned policy that keeps the reducer pure and the
DAG acyclic": retry-as-policy (Arc I D-Retry-1, which said so _explicitly to avoid
opening the loops door_) and router-`chosenEdges`. Apply it a third time. A
`revise-until` construct is a **loop group**: a small, statically-declared cluster of
nodes `{worker, evaluator}` with a policy `{maxIterations, until:"<verdict>"}`. The
driver, on the evaluator emitting a non-terminal verdict, **respawns the loop group's
worker as a new iteration** (same idempotent respawn machinery as retry: clear stale
markers, bump a persisted counter, re-materialize the prompt) — the reducer never
sees a back-edge, the DAG stays acyclic, and `decide()` treats an in-progress loop
group as one `running` node cluster.

- The loop group is declared at authoring time as a bounded region (leading option:
  a single node carrying `loopPolicy`, whose _own_ re-invocation is gated by an
  inline verdict; or a 2-node worker+evaluator pair tagged with a shared `loopId`).
  Recommend the **single-node inline form first** (`agent-task` + `loopPolicy
{maxIterations, backoffMs}` where the agent both works and self-judges via
  `BRANCH: continue|done`) — it is the smallest superset of retry and needs no new
  grouping primitive. The worker+evaluator pair is a later ergonomic layer.
- `maxIterations` is env-clamped exactly like `retryPolicy.maxAttempts`
  (`AGENT_LOOP_MAX_ITERATIONS`, small ceiling). Exhaustion without reaching `until`
  is a terminal outcome: recommend **`done` with a persisted `loopExhausted:true`
  flag** (the loop _ran_, it just didn't converge) rather than `failed`, so a
  downstream router can branch on "converged vs. gave up" — but this is a real
  decision to confirm at the checkpoint.

**D-Loop-2 — The genuinely hard part is dynamic-width map, NOT the while-loop. Name
it, scope it out of v1.** A `while`-style bounded loop is tractable as a policy
(fixed node set, a counter). **Map-reduce is not**: the fan-out width is
_data-dependent_ — how many parallel children depends on a list the agent produces
at _runtime_, unknown at `resolveWorkflow` time, which fights the "static DAG,
validated once at save" model the whole engine rests on. That means dynamic node
materialization at runtime, dynamic budget accounting, and a skip/join closure over
nodes that did not exist at save. **v1 of this slice ships the bounded `while` policy
only; dynamic-width map is explicitly deferred to its own future slice** with its own
checkpoint. Do not lump them.

**D-Loop-3 — Persistence / re-derivability (acceptance bar).** Persist a per-node
`iterationCount` (distinct from `retryCount` and `spawnAttempts` — three counters now;
document why each exists, mirror the off-wire treatment). On restart the driver reads
`iterationCount` + the last iteration's markers and either resumes waiting on the
in-flight iteration or, if the last iteration completed with a non-terminal verdict
and count `< max`, respawns the next — identical to how retry recovers mid-attempt.
No in-memory loop state. Write the load-bearing restart-mid-iteration test (mirrors
Arc I's restart-mid-retry test — that test is the template).

**D-Loop-4 — Interaction with existing policies (specify for tests, likely no code).**
Retry and loop are orthogonal driver policies on the same node: retry handles
_process failure_ within one iteration; loop handles _verdict-driven re-invocation_
across iterations. A single iteration that fails is retried per `retryPolicy`; only
its final (post-retry) success feeds the verdict that the loop policy reads. Nail the
ordering in tests, add no new coupling code if the existing reap sequencing already
yields it.

**Schemas.** `WorkflowNode` gains optional `loopPolicy` = `{maxIterations, until,
backoffMs}` (all optional/defaulted; absent ⇒ current single-shot behavior).
Backward-compatible.

**Frontend.** DAG builder: a "Loop" sub-form on a node (max iterations + the `until`
verdict), sibling to the existing retry sub-form. Run view: show iteration N / max and
the last verdict.

**Tests.** worker converges on iteration 2 → run completes, `iterationCount==2`;
never converges → stops at `maxIterations` with `loopExhausted:true` (confirm outcome
at checkpoint); restart mid-iteration resumes and the cap holds; `loopPolicy` absent ⇒
single shot (regression).

**Checkpoint:** HEAVY — same bar as router. Get sign-off on D-Loop-1 (policy vs.
loop-node), D-Loop-2 (while-only, map deferred), and the D-Loop-1 exhaustion outcome
_before writing code_.

---

## A3. Multi-turn agent-to-agent chat (deferred within Track A — sketch only)

v2 §8 and Arc I §3 both keep this deferred; it stays deferred here. Sketch of the
shape so a future arc has a starting point, **not a build spec**: iter6 already
added human→agent guidance via claude-cli `--resume` within the survivable batch
model (no interactive panes). Agent→agent chat is the generalization: node B's
objective is materialized from node A's result and B can `--resume`-ping A for a
bounded number of turns. The hard parts are (a) a turn/token bound so two agents
can't loop forever (reuse the A2 counter discipline), (b) codex-cli has no resume so
it is fail-closed exactly as guidance is, and (c) it must stay batch/survivable — no
live bidirectional stream. Defer until A1/A2 land and there is a concrete use case.

---

# Track B — Operational (does NOT touch `decide()`)

## B1. Scheduled & event-triggered runs

**Motivation.** Today a run starts only via a human `POST …/start` (D7: start is
human-only by design). "Richer" operationally means "run this Agentic AI every night"
or "run when X happens" without a human present.

**D-Sched-1 — A scheduler is a thin trigger in front of the existing start path, not a
new run mode.** It calls the same internal start that the human POST calls; the run
engine is unchanged. The schedule store is a new sidecar (`data/agentic-schedules.json`,
atomic write, mirrors `registry.js`/`push.js` conventions), with CRUD routes under
`/api/agentic/schedules`. A background timer loop (gated on schedule count, like the
push poll loop is gated on subscription count — never runs when unused) fires due
schedules.

**D-Sched-2 — Auth is the whole risk surface. D7 said start is human-only; a scheduler
is a _deliberate, narrow_ exception.** The trigger must run with an explicit,
scoped, server-side capability — NOT a human cookie, NOT the broad
`GATEWAY_API_TOKEN`. Recommend: schedules execute under the same scoped-token
discipline as iter5's per-run MCP tokens, minted for exactly "start run R of Agentic
AI X." Confirm at checkpoint that automated start is acceptable at all (it reverses a
v1 safety posture) and, if so, whether approval-gated tool calls inside a scheduled
run are auto-denied (safest default), queued for later human approval, or the run is
disallowed from having approval-tier tools entirely. **Recommend: a scheduled run may
only use auto-tier tools; any approval-tier call fails closed** — no human is present
to approve, and silently auto-approving would breach the approval model.

**D-Sched-3 — Persistence / re-derivability (acceptance bar).** Schedules live on
disk; `lastFiredAt` / `nextFireAt` persisted so a restart does not double-fire or skip
a window. On boot, a schedule whose window was missed during downtime fires **at most
once** (catch-up, not backfill-N) — document this the way push documents "a job
finishing during a gateway-restart window is missed, best-effort by design."

**D-Sched-4 — Event triggers are a superset; scope v1 to cron only.** Time-based (cron)
is tractable and self-contained. "Run when a PM task moves to Done" / "when a file
appears" needs an event bus this system does not have. v1 = cron schedules only;
event triggers deferred with their own checkpoint.

**Schemas.** `AgenticSchedule = {id, agenticId, cron, enabled, lastFiredAt,
nextFireAt}` in shared-types. New CRUD routes Origin/CSRF-guarded (writes), reads
Origin-exempt, mirroring existing artifact route conventions.

**Frontend.** A "Schedule" section in the Agentic AI editor (cron field + enable
toggle + next-fire display). Self-contained artifact, same as the rest.

**Tests.** schedule CRUD; a due schedule fires exactly one start; missed-window
catch-up fires at most once; a scheduled run with an approval-tier tool fails closed
(D-Sched-2); disabled schedule never fires.

**Checkpoint:** MEDIUM — the reducer is untouched, but D-Sched-2 reverses a v1 safety
posture (human-only start). Get sign-off on automated start + the approval-tier policy
before building.

---

## B2. Cost / token budgets

**Motivation.** A misconfigured loop or a wide fan-out can burn unbounded model
spend. v2 §8 lists cost/token budgets as a candidate; A2 (loops) makes this urgent
rather than nice-to-have — ship B2 _with or before_ A2.

**D-Budget-1 — Budget is a driver/reap-enforced cap, not a reducer concept.** `decide()`
stays pure and cost-blind. The driver accumulates a per-run `tokensUsed` / `costUsd`
(and/or a wall-clock/attempt count as a cheap proxy if token accounting from the CLIs
is unreliable — verify what `claude`/`codex` stream back before promising token
precision) and, when a run crosses its budget, stops offering new spawns and marks the
run terminal with a distinct outcome `budget_exhausted` (NOT `failed` — the run was
halted by policy, and the distinction matters exactly like router's handled-failure vs.
fail-fast). In-flight nodes are allowed to finish (or are killed — confirm at
checkpoint; recommend let-finish, then halt).

**D-Budget-2 — Accounting granularity is the honest-caveat surface.** Be explicit about
what can actually be measured. If the CLIs do not reliably report tokens, v1 budgets
are **attempt/spawn-count and wall-clock** caps (precise, already tracked) and _token_
budgets are deferred until the provider seam exposes real usage — do not promise
dollar-accurate budgets the plumbing can't deliver. Document the granularity the way
push documents "±poll interval."

**D-Budget-3 — Persistence / re-derivability (acceptance bar).** `tokensUsed`/counters
persist on the run so a restart resumes with the budget already partly spent, never
resetting to zero (a reset would let a crash-loop bypass the cap). This is the
load-bearing test: crash after half the budget, reboot, assert the cap still trips at
the original total.

**Schemas.** Optional `budget = {maxTokens?, maxCostUsd?, maxWallClockMs?,
maxSpawns?}` on the Agentic AI (or per-run override); `budget_exhausted` added to the
run terminal-status enum.

**Frontend.** Budget fields in the editor; Run view shows spend vs. budget and the
`budget_exhausted` terminal state.

**Tests.** run halts at the budget with `budget_exhausted` (not `failed`); in-flight
node finishes then halt (or kill, per checkpoint); restart preserves spend (load-
bearing); unset budget ⇒ unbounded as today (regression).

**Checkpoint:** LIGHT-MEDIUM — reducer untouched; the only real decisions are D-Budget-2
(what's actually measurable) and let-finish-vs-kill.

---

## 3. Sequencing recommendation

1. **Commit the router** (Arc I §2) — prerequisite; A1 builds on its skip-closure.
2. **A1 — evaluation/self-critique node** — smallest, additive, light checkpoint.
3. **B2 — budgets** — ship before/with loops so A2 can't burn unbounded spend.
4. **A2 — bounded iteration (while-only)** — heavy checkpoint; the hard slice.
5. **B1 — scheduled runs (cron-only)** — independent; medium checkpoint on auto-start.
6. Deferred beyond this arc: dynamic-width map (A2's hard half), event triggers
   (B1's hard half), token-precise budgets (if the CLI seam can't measure), and
   agent-to-agent chat (A3).

Tracks A and B are independent — B2/B1 can proceed in parallel with A1/A2 by whoever
is free, since they never touch `decide()`.

---

## 4. Configuration (env) — anticipated additions

All optional; an unconfigured gateway behaves exactly per current defaults.

```bash
# ---- A2 bounded iteration ----
# AGENT_LOOP_MAX_ITERATIONS=8        # hard ceiling on loopPolicy.maxIterations
# AGENT_LOOP_BACKOFF_MAX_MS=60000    # ceiling on loopPolicy.backoffMs (mirrors retry)

# ---- B1 scheduled runs ----
# AGENT_SCHEDULES_FILE=...           # override sidecar path (mirrors PUSH_SUBSCRIPTIONS_FILE)
# AGENT_SCHEDULE_POLL_INTERVAL_MS=30000

# ---- B2 budgets ----
# AGENT_DEFAULT_MAX_SPAWNS=...       # optional system-wide default cap
# (token/cost budgets gated on what the provider seam can actually measure — D-Budget-2)
```

---

## 5. Critical files (anticipated, per slice)

- **A1 eval node:** `public/agentic/app.html` (authoring preset + verdict display).
  Reducer/driver: none new beyond router. Optional display-only `score` in
  shared-types + `shapeNodeExecution`.
- **A2 loops:** `agentic.js` (`resolveWorkflow` accept+clamp `loopPolicy`; `decide()`
  treats a looping group as `running` — verify no change needed); `server.js` (reap:
  iteration respawn + `iterationCount`, mirrors retry); shared-types (`loopPolicy`,
  `loopExhausted`); `app.html` (loop sub-form); tests incl. restart-mid-iteration.
- **B1 scheduling:** new `src/agentic-schedules.js` sidecar; `server.js`
  (`/api/agentic/schedules` CRUD + timer loop, gated on count); scoped-token mint for
  automated start; shared-types (`AgenticSchedule`); `app.html` (schedule section).
- **B2 budgets:** `server.js` (driver accounting + halt); `agentic.js` (persist
  counters on the run; `budget_exhausted` terminal status — confirm `decide()` stays
  cost-blind, halt decided in the driver); shared-types (`budget`, terminal enum);
  `app.html` (budget fields + spend display).
- `.env.example` — §4 additions per slice.
- `docs/AGENTIC-RICHER-WORKFLOWS-PLAN.md` §3 + `docs/AGENTIC-AI-CREATOR-PLAN.md` §8 —
  cross-link here as each slice ships.
