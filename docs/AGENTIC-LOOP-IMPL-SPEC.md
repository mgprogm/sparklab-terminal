# A2 — bounded iteration ("revise-until") — IMPLEMENTATION SPEC

Builds the design settled across four Codex review rounds in
`docs/AGENTIC-LOOP-DESIGN-REVIEW.md` (§2 decisions, §7–§10 conditions). The R8
stream-json parser prerequisite is SHIPPED (`970b137`). **`decide()` is NOT touched
— iteration is a driver policy, exactly like retry.** This is the hardest slice; build
in the staged order in §6 and review each stage.

## 0. The construct

A single `agent-task` node carries `loopPolicy {maxIterations, until, backoffMs}`. The
agent works AND self-judges, ending its output with `BRANCH: <verdict>` (parsed by the
R8-hardened `parseResult`). Each finished iteration (exit 0):

- `branch === until` → **converged** → node `done` (loop stops; plain out-edges fire).
- `branch !== until` AND `iterationCount < maxIterations` → **respawn next iteration**.
- `iterationCount >= maxIterations` → **exhausted** → node `done` + `loopExhausted:true`
  (display-only; F-R1 — it does NOT route, plain out-edges fire identically).
  A **nonzero exit** is a process failure → the EXISTING `retryOrFailNode` (retry runs
  WITHIN an iteration; only a post-retry exit-0 produces a verdict — F-R6/D-Loop-6).

## 1. Counters & phase flags (the load-bearing state; all OFF-wire except where noted)

Three respawn reasons, each with its own counter + `*Pending` phase flag (a counter
alone is never restart-safe — §8/§10):

| field                   | meaning                                                        | set/increment                                               | cleared by                          |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| `iterationCount`        | current iteration # (1-based)                                  | `recordSpawned` sets 1 if unset; `commitLoopIteration` ++   | never                               |
| `loopPending`           | a loop iteration was committed, respawn not yet done           | `commitLoopIteration`                                       | `recordSpawned`                     |
| `retryCount`            | retry respawns **within the current iteration**                | `recordRetryAttempt` (unchanged)                            | reset to 0 by `commitLoopIteration` |
| `retryPending`          | (existing) retry committed, respawn not done                   | `recordRetryAttempt`                                        | `recordSpawned`                     |
| `neverRanRecoveryCount` | committed crash-in-spawn recoveries                            | `commitNeverRanRecovery`                                    | never                               |
| `neverRanPending`       | crash-recovery committed, respawn not done                     | `commitNeverRanRecovery`                                    | `recordSpawned`                     |
| `sessionEstablished`    | a claude attempt for this node reached exit 0 (session exists) | `recordTerminalDone`/`markSessionEstablished` on any exit-0 | never                               |
| `iterationInvocation`   | `{mode:"fresh"                                                 | "resume", providerSessionId}` for the current iteration     | `spawnNode` (see §4)                | never (overwritten) |

**On-wire (shaped, for the Run view; mirror `chosenEdges`/`score`):** `iterationCount`
(when >1), `loopExhausted` (when true), `lastVerdict` (when present). Everything else
stays off-wire like `spawnAttempts`/`retryCount` today.

`recordSpawned` must clear ALL THREE pending flags: `delete ne.retryPending;
delete ne.loopPending; delete ne.neverRanPending;` and set `iterationCount` to 1 if unset.

## 2. Schemas (`packages/shared-types/src/terminal.ts`)

- `LoopPolicySchema = z.object({ maxIterations: z.number().int().min(1).default(1),
until: z.string().regex(/^\S+$/).default("done"), backoffMs: z.number().int().min(0).default(0) })`
  — comment: `until` must be a single non-whitespace token (matches parseResult's
  `BRANCH: <\S+>`).
- `WorkflowNodeSchema.loopPolicy: LoopPolicySchema.optional()`.
- `NodeExecutionSchema`: optional `iterationCount: z.number().int()`,
  `loopExhausted: z.boolean()`, `lastVerdict: z.string()` (all display-only).

## 3. `agentic.js`

- Env caps (module const, mirror `RETRY_MAX_ATTEMPTS_CAP`): `AGENT_LOOP_MAX_ITERATIONS`
  (default 8), `AGENT_LOOP_BACKOFF_MAX_MS` (default 60000).
- `resolveWorkflow`: parse/validate/clamp `loopPolicy` (agent-task ONLY — reject on
  router/human-approval with `invalid_workflow`). Clamp `maxIterations` to the cap,
  `backoffMs` to the cap; `until` must match `/^\S+$/`. Carry through `cleanNodes` (like
  `retryPolicy`). shapeWorkflow carries `loopPolicy` through.
- New mutators (sync/atomic, mirror the retry mutators):
  - `commitLoopIteration(runId, nodeId, {verdict})`: ONE persist — `ne.loopPending=true`;
    `ne.iterationCount=(ne.iterationCount||1)+1`; `ne.retryCount=0` (fresh per-iteration
    retry budget, F-R6); `ne.lastVerdict=String(verdict)`. (Node stays `running`.)
  - `getLoopState(runId,nodeId)` → `{iterationCount, loopPending, lastVerdict,
sessionEstablished, iterationInvocation}`.
  - `commitNeverRanRecovery(runId,nodeId)`: ONE persist — `ne.neverRanPending=true`;
    `ne.neverRanRecoveryCount=(ne.neverRanRecoveryCount||0)+1`.
  - `getNeverRanState(runId,nodeId)` → `{neverRanRecoveryCount, neverRanPending}`.
  - `markSessionEstablished(runId,nodeId)`: `ne.sessionEstablished=true`; persist.
  - `setIterationInvocation(runId,nodeId,{mode,providerSessionId})`: persist the record.
  - `recordLoopBudgetHalt(runId,nodeId,{finishedAt})`: ONE persist (F-R7 atomicity) —
    set the NODE `status="done"`, `finishedAt`, `loopExhausted=true` AND the RUN
    `run.budgetHalt=true`. Returns shapeRun.
- `recordNodeResult`: add optional `loopExhausted` (persist `ne.loopExhausted=true` when
  passed).
- `shapeNodeExecution`: emit `iterationCount` (when >1), `loopExhausted` (when true),
  `lastVerdict` (when present). Do NOT emit loopPending/neverRan*/sessionEstablished/
  iterationInvocation.
- `RUN_STATUSES`/`RUN_TERMINAL` already include `budget_exhausted` (B2); no change. The
  `budgetHalt` flag is a plain run field (not a status).
- **`decide()` UNTOUCHED.** A looping node is `running` throughout; the reducer never
  sees a back-edge.

## 4. `server.js`

### 4a. startRun — codex fail-closed (F-R6)

After agent resolution, for every node with `loopPolicy` whose resolved agent is
`codex-cli` → `throw agenticErr("invalid_workflow", "loopPolicy requires claude-cli
(codex has no resume)", {node})`. (Mirrors the existing codex-guidance/connection
fail-closed. resolveWorkflow can't see the provider; startRun is the boundary.)

### 4b. `recordTerminalDone` (exit 0) — add the loop decision (before the router branch)

For a node with `loopPolicy`:

1. `const { branch } = agentRuntime.parseResult(logTail, 0)` (R8-hardened). If claude,
   `agentic.markSessionEstablished(run.id, nodeId)`.
2. `lastVerdict = branch ?? ""`.
3. if `branch === node.loopPolicy.until` → `recordNodeResult(done, {})` (+ persist
   lastVerdict — fold into recordNodeResult or a small setter). Converged.
4. else if `getLoopState().iterationCount >= node.loopPolicy.maxIterations` →
   `recordNodeResult(done, {loopExhausted:true})` (+ lastVerdict). Exhausted.
5. else (continue): **budget check first (F-R7)** — if `budgetExhausted(run, cfg)` →
   `agentic.recordLoopBudgetHalt(run.id, nodeId, {finishedAt})` and RETURN (no respawn;
   the advanceRun budgetHalt gate finalizes). else → `await loopRespawn(run, cfg,
nodeId, branch)`.
   Router nodes and plain agent-tasks: unchanged (mutually exclusive — loopPolicy is
   agent-task-only and a loop node has no `when` edges).

### 4c. `loopRespawn(run, cfg, nodeId, verdict)` (new; sibling of `retryOrFailNode`)

`agentic.commitLoopIteration(run.id, nodeId, {verdict})` → clear the node's stale
markers (`start.marker`/`exit.marker`/`out.log`, same as retry) → wait
`loopPolicy.backoffMs` → re-check the run is still active + node still running (kill/
cancel race, same guard retry uses) → `await spawnNode(run, cfg, nodeId)`.

### 4d. `spawnNode` — iteration-aware session + prompt (F-R5)

Replace the unconditional `providerSessionId = randomUUID()` for claude with:

```
let providerSessionId, resume = false;
if (agent.runtimeProvider === "claude-cli") {
  const ls = agentic.getLoopState(run.id, nodeId);
  const inv = ls.iterationInvocation;
  if (ls.sessionEstablished && inv?.providerSessionId) {
    providerSessionId = inv.providerSessionId; resume = true;   // resume established session
  } else {
    providerSessionId = crypto.randomUUID(); resume = false;    // fresh / rotate on pre-session retry
  }
}
```

Persist the chosen invocation BEFORE spawn: `agentic.setIterationInvocation(run.id,
nodeId, {mode: resume?"resume":"fresh", providerSessionId})`. Pass `resume` +
`agentSessionId: providerSessionId` to `buildInvocation`. **Prompt:** when `resume` is
true, `composePromptText` must produce the continuation prompt "revise the prior result;
last verdict was `<lastVerdict>`. …(original objective)" instead of the plain objective —
thread `lastVerdict` + `resume` into `composePromptText(run, cfg, {nodeId})`. (A
non-loop node: unchanged — no loopState, fresh session as today.)

### 4e. reap never-ran branch (F-R4) — replace the crash cap

Current: `if (retryPending) retryOrFailNode; else if (spawnAttempts-retryCount>=2) fail;
else spawnNode`. New, integrated:

```
const rs = agentic.getRetryState(run.id, nodeId);
if (rs.retryPending) { await retryOrFailNode(run, cfg, nodeId); changed=true; continue; }
const ls = agentic.getLoopState(run.id, nodeId);
if (ls.loopPending) { await spawnNode(run, cfg, nodeId); changed=true; continue; } // resume committed iteration (markers already cleared)
const nr = agentic.getNeverRanState(run.id, nodeId);
if (nr.neverRanPending) { await spawnNode(run, cfg, nodeId); changed=true; continue; } // resume committed recovery
if (nr.neverRanRecoveryCount >= 1) { recordNodeResult(failed); changed=true; continue; } // one recovery spent
agentic.commitNeverRanRecovery(run.id, nodeId); await spawnNode(run, cfg, nodeId); changed=true;
```

(This removes the `spawnAttempts - retryCount` arithmetic entirely — R8/§10 F-R4.) Note
`loopPending`-resume respawns without re-reading the verdict (markers were cleared when
the iteration was committed — F-R2).

### 4f. advanceRun budgetHalt gate (F-R7) — AFTER `terminal==="failed"`, BEFORE `terminal==="completed"`

```
if (run.budgetHalt) {
  const anyInFlight = (run.nodeExecutions||[]).some(ne => ne.status==="running" || ne.status==="waiting-approval");
  if (!anyInFlight) { agentic.setRunStatus(runId, "budget_exhausted", {finishedAt:Date.now()}); revokeScopedMcpTokensForRun(runId); }
  break;   // else let in-flight finish; a later tick re-checks
}
```

This beats the single-node completed race; B2 preserved because `budgetHalt` is set ONLY
by `recordLoopBudgetHalt`. The existing B2 gate (after completed) is unchanged.

## 5. `.env.example` + Frontend

- `.env.example`: `AGENT_LOOP_MAX_ITERATIONS=8`, `AGENT_LOOP_BACKOFF_MAX_MS=60000`.
- FE (`public/agentic/app.html`): a "Loop" sub-form on an agent-task node (max
  iterations + `until` verdict + backoff), sibling to the retry sub-form; emit
  `loopPolicy` when non-default. Run view: show "iteration N/max" (from `iterationCount`
  - the policy), the `lastVerdict`, and a "loop exhausted" marker when `loopExhausted`.

## 6. Build stages (Codex writes, Opus reviews each)

1. **Schemas** (shared-types) — LoopPolicy + NodeExecution fields.
2. **agentic.js** — env caps, resolveWorkflow validation, the mutators, shape, clearing
   all pending flags in recordSpawned. (decide() untouched — assert its hash unchanged.)
3. **server.js** — startRun fail-closed, recordTerminalDone loop decision, loopRespawn,
   spawnNode session/prompt, reap never-ran rewrite, advanceRun budgetHalt gate.
4. **FE** — loop sub-form + run-view display.
5. **Opus writes tests** (§7).

## 7. Tests (Opus — `test/agentic-endpoints.js`, stub is claude-cli)

The stub must emit `BRANCH:` per invocation; drive per-invocation verdict via the
existing FAILFILE-style persistent counter (a new `LOOPFILE`/verdict-by-count sentinel).

1. **Converges on iteration 2** → run completed, node `iterationCount===2`, no
   `loopExhausted`. (Stub: invocation 1 emits `BRANCH: revise`, invocation 2 `BRANCH: done`.)
2. **Never converges** → stops at `maxIterations`, node `done`+`loopExhausted:true`, run
   completed (F-R1 display-only); exactly `maxIterations` invocations.
3. **`loopPolicy` absent ⇒ single shot** (regression).
4. **LOAD-BEARING restart mid-iteration** → SIGKILL after iteration 2's verdict committed
   (`loopPending` set) but before respawn; reboot resumes the iteration (no verdict
   recount, no skipped iteration) and converges. Hand-craft the persisted state like the
   retry restart-spawn test, OR time it via backoffMs. Assert final iterationCount + done.
5. **crash cap decoupled (F-R4)** → a healthy ≥3-iteration loop does NOT trip the
   `neverRanRecoveryCount>=1` cap; AND a genuine crash-in-spawn still fails after exactly
   one recovery regardless of iteration/retry count (hand-crafted never-ran state:
   neverRanRecoveryCount=1, no pending, no markers ⇒ fail; with neverRanPending ⇒ resume).
6. **retry × loop (F-R6)** → an iteration that exits nonzero once then succeeds retries
   WITHIN the iteration (retryCount, reset next iteration) then loops; retries don't leak
   across iterations.
7. **loop × budget (F-R7)** → a loop under `maxSpawns` halts `budget_exhausted` (not
   completed) via `budgetHalt`, even as a single leaf node; and with a concurrent running
   sibling, no orphaned agrun job (let-finish).
8. **codex loopPolicy → startRun 400/invalid_workflow** (F-R6 fail-closed).
9. **maxIterations:1** ⇒ exactly one invocation, done+loopExhausted if not `until` on the
   first shot (define the boundary explicitly).
   Full `test:agentic` must stay green (all prior 381) — loop is agent-task-only + opt-in.
