# Cost / budget caps (B2) — implementation spec (Opus-authored)

Implements `docs/AGENTIC-RICHER-WORKFLOWS-II-PLAN.md` §B2 (D-Budget-1..3). A run
can carry a budget; when it crosses the cap the DRIVER stops offering new spawns
and marks the run terminal `budget_exhausted` (distinct from `failed`). Track B:
**`decide()` is NOT touched — it stays pure and cost-blind (D-Budget-1).**
Checkpoint LIGHT-MEDIUM.

## D-Budget-2 resolved (what is actually measurable)

The engine captures **no** token/cost usage from the CLIs (verified: nothing in
agentic.js/server.js/agent-runtime.js reads token/usage). So **v1 budgets are
spawn-count + wall-clock ONLY** — both already precisely tracked. `maxTokens` /
`maxCostUsd` are **deferred** until the provider seam reports real usage; do NOT
add them to the schema (adding an unenforced budget field is worse than omitting
it — it reads as a guarantee we don't deliver). Document this like push docs its
"±poll interval": spawn caps are exact; wall-clock granularity is ±poll interval.

## D-Budget-1 — halt is driver-enforced, decide() cost-blind

- `spawnsUsed` = `sum(ne.spawnAttempts)` over the run's nodeExecutions. Already
  persisted (bumped by `recordSpawned`), so it is re-derivable across restart with
  NO new counter (this is what satisfies D-Budget-3 for free — a crash-loop can't
  reset it).
- wall-clock elapsed = `now() - run.startedAt` (run.startedAt already persisted).
- **let-finish, then halt** (D-Budget-1 recommended): in-flight (running) nodes are
  allowed to complete; the driver only refuses NEW spawns, then flips the run to
  `budget_exhausted` once nothing is running. Do NOT kill in-flight jobs.

## Backend

### `agentic.js`

1. `RUN_STATUSES` and `RUN_TERMINAL` both gain `"budget_exhausted"`.
2. `cleanBudget(raw)` helper: returns `undefined` if `raw` is null/absent;
   else an object with only the present, VALID keys: `maxSpawns` (positive
   integer) and `maxWallClockMs` (positive integer). Reject a non-object or a
   non-positive / non-integer value with `err("bad_request", ...)`. Ignore/strip
   any other keys (incl. maxTokens/maxCostUsd) so a forward-compat payload doesn't
   error but also isn't silently "enforced".
3. `createAgenticAi` / `updateAgenticAi`: validate via `cleanBudget(body.budget)`
   and store `aa.budget` (only when defined; `updateAgenticAi` allows clearing by
   explicit `budget: null`). `shapeAgenticAi`: emit `budget` when present.
4. `shapeRun`: add display-only derived fields — `spawnsUsed` (the sum above) and
   `budget` (a copy of `r.resolvedConfig?.budget ?? null`). Leave `shapeRunSummary`
   as-is. These are display-only.

   **`decide()` MUST NOT read budget/spawnsUsed — do not touch `decide()`.**

### `server.js`

5. `AGENT_DEFAULT_MAX_SPAWNS` env (optional): a **GLOBAL** default spawn cap
   (DECISION — pinned, not Codex's call). When set to a positive integer, EVERY
   run whose frozen budget omits `maxSpawns` — **including runs with no budget at
   all** — gets `maxSpawns = <env>`. It is a system-wide safety net. It is **OFF
   by default** (unset ⇒ no default ⇒ fully unbounded, exactly today's behavior).
   Never invent a wall-clock default. Document prominently in `.env.example` that
   setting this caps ALL runs' spawn count. (This is why test 4 must run with the
   env UNSET.)
6. `startRun`: freeze the budget into `resolvedConfig.budget` (D9) — from
   `app.budget`, with the `AGENT_DEFAULT_MAX_SPAWNS` fill-in per (5). If the result
   is empty, set `resolvedConfig.budget = undefined` (unset ⇒ unbounded).
7. `budgetExhausted(run, cfg)` helper (pure read):
   ```
   const b = cfg.budget; if (!b) return false;
   if (b.maxSpawns != null &&
       (run.nodeExecutions||[]).reduce((s,ne)=>s+(ne.spawnAttempts||0),0) >= b.maxSpawns) return true;
   if (b.maxWallClockMs != null && run.startedAt &&
       Date.now() - run.startedAt >= b.maxWallClockMs) return true;
   return false;
   ```
8. `advanceRun`: add the budget gate INSIDE the `while(changed)` loop, AFTER the
   `decision.toSkip` / `terminal==="failed"` / `terminal==="completed"` handling
   and BEFORE the `toSpawn` spawn loop:
   ```
   if (budgetExhausted(run, cfg)) {
     // in-flight = running OR waiting-approval: an approval-parked node (iter3
     // MCP tool-call / iter9 human gate) still owns a LIVE agrun- CLI job, so it
     // is NOT idle. Halting while one exists would both kill a run legitimately
     // waiting for a human AND orphan that tmux job (setRunStatus does not kill
     // jobs). Defer the halt until nothing is in flight — no killRunningJobs
     // needed because, by construction, nothing is running when we flip.
     const anyInFlight = (run.nodeExecutions || []).some(
       (ne) => ne.status === "running" || ne.status === "waiting-approval",
     );
     if (!anyInFlight) {
       agentic.setRunStatus(runId, "budget_exhausted", { finishedAt: Date.now() });
     }
     // else: let in-flight nodes finish/resolve (reap drains them on later ticks),
     // then a subsequent advance flips to budget_exhausted. Never spawn past the cap.
     break;
   }
   ```
   Ordering rationale: completed/failed are decided FIRST, so a run that actually
   finishes on the tick it crosses the cap is `completed`, not `budget_exhausted`
   (the cap only halts UNfinished work). `setRunStatus(budget_exhausted)` is
   terminal → its existing pending→skipped sweep abandons the unspawned nodes.
   Do NOT call `killRunningJobs` (let-finish).

8b. **Exact `maxSpawns` under parallel fan-out — clamp the wave.** The gate above
is a between-waves pre-check, so a wave of K parallel-ready nodes with
`spawnsUsed = maxSpawns - 1` would overshoot by K-1. Make the cap EXACT: in the
`toSpawn` spawn loop, when `cfg.budget?.maxSpawns != null`, spawn at most
`Math.max(0, maxSpawns - spawnsUsed)` nodes this wave (clamp the list; leftover
ready nodes stay pending and are abandoned as `skipped` when the next tick's
gate flips `budget_exhausted`). Sequential/single runs are unaffected (wave
size 1). Pin it with a parallel-fan-out test (below).

### `shared-types/src/terminal.ts`

9. `AgenticBudgetSchema = z.object({ maxSpawns: z.number().int().positive().optional(),
maxWallClockMs: z.number().int().positive().optional() })` — comment that
   token/cost budgets are deferred (D-Budget-2). Add `budget: AgenticBudgetSchema.optional()`
   to `AgenticAiSchema` + Create/Update AgenticAi request schemas.
10. Run terminal status enum (wherever `"completed"|"failed"|"cancelled"` live for
    the Run) gains `"budget_exhausted"`. `RunSchema` gains optional display-only
    `spawnsUsed: z.number()` and `budget: AgenticBudgetSchema.nullable().optional()`.

### Templates (export/import/clone)

11. `buildAgenticTemplate` / `importAgenticTemplate` carry `budget` through (one
    field spread, mirrors how they carry other app fields), so a cloned/imported
    app keeps its budget. Low risk; include it.

## Frontend (`public/agentic/app.html`)

- Team editor (the app-config surface that PATCHes name/mode/workflow): add a
  "Budget" section with two optional numeric inputs — **Max spawns** and
  **Max wall-clock (ms)** — included in the existing app PATCH as
  `budget: {maxSpawns?, maxWallClockMs?}` (omit a field when blank; send
  `budget: null` / omit entirely when both blank). Seed from the loaded app's
  `budget`. Match existing field styling.
- Run view: show `spawnsUsed` vs `budget.maxSpawns` (e.g. "spawns 3/4") and, when
  `run.status === "budget_exhausted"`, render that terminal state clearly (a badge
  like the failed/completed ones). Reuse existing run-meta/badge styling.

## Tests (Opus writes — `test/agentic-endpoints.js`)

1. **Spawn cap halts with `budget_exhausted` (not `failed`).** A sequential 4-node
   chain, `budget:{maxSpawns:2}`. After n0,n1 spawn+finish (spawnsUsed=2), n2 is
   blocked: run terminal `budget_exhausted`, n0/n1 `done`, n2/n3 `skipped`,
   `spawnsUsed===2`.
2. **Wall-clock cap + let-finish.** A 2-node chain, n0 `SLEEP=3`,
   `budget:{maxWallClockMs:1500}`. n0 is allowed to FINISH (`done`, not killed);
   then the run halts `budget_exhausted` with n1 `skipped`.
3. **Restart preserves spend (LOAD-BEARING, D-Budget-3).** A 6-node chain each
   `SLEEP=1`, `budget:{maxSpawns:4}`. Poll until spawnsUsed reaches 2, SIGKILL,
   reboot; assert the run resumes from 2 (NOT 0) and halts at exactly
   `spawnsUsed===4` with `budget_exhausted` and the tail nodes `skipped`.
4. **Unset budget ⇒ unbounded (regression), env in a KNOWN state.** With
   `AGENT_DEFAULT_MAX_SPAWNS` UNSET (the default in the test harness), a no-budget
   chain longer than any test cap runs to `completed`. (If a later test needs the
   env set, run it on a dedicated gateway so this one keeps the env unset.)
5. **Validation:** `budget:{maxSpawns:0}` or negative/non-integer ⇒ `400`
   bad_request at create; `maxTokens`/`maxCostUsd` in the payload are stripped (not
   enforced, not error) — assert an app created with them exposes no such field and
   the run is not capped by them.
6. **waiting-approval defers the halt (the #1 correctness guard).** A workflow
   `n0(agent-task) → g(human-approval) → n1(agent-task)`, `budget:{maxWallClockMs:1500}`.
   Let n0 finish and the run park at `g` (`waiting-approval`); WAIT past 1500ms.
   Assert the run status is STILL `waiting-approval` — NOT `budget_exhausted` (an
   unfixed `some(status==="running")` check would have wrongly halted, since a gate
   is not "running"). Then approve `g`; the run settles to `budget_exhausted`
   (n1 blocked, `skipped`) — proving the halt fires only once nothing is in flight.
   The end-of-suite tmux leak check confirms no orphaned agrun- job.
7. **Exact cap under parallel fan-out (the #2 guard).** A `parallel` app of 3
   agent-task nodes (each `SLEEP=1`), `budget:{maxSpawns:2}`. Assert EXACTLY 2 of
   the 3 spawn (`spawnsUsed===2`, not 3), the run ends `budget_exhausted`, and the
   third node is `skipped` — proving the wave clamp, not just the between-waves gate.

## `.env.example`

Add under the agentic block: `AGENT_DEFAULT_MAX_SPAWNS` (optional system-wide
default spawn cap; unset ⇒ no default, fully unbounded as today).
