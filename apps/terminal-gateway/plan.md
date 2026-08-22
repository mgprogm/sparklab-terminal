# Plan — remaining work on `feat/agentic-ai-creator`

> **Scope:** the Agentic AI Creator (third pluggable artifact). If you meant a different
> subject (e.g. the uncommitted `browser-*` handoff workstream), say so — this plan is
> deliberately narrow so it's cheap to redirect.
> **Authoritative context:** `docs/AGENTIC-AI-CREATOR-PLAN.md` (v2 design),
> `docs/AGENTIC-RICHER-WORKFLOWS-II-PLAN.md` (Arc II), plus the impl-spec docs referenced
> per slice below.
> **Date:** 2026-07-29 · **Historical implementation branch:**
> `feat/agentic-ai-creator`. The feature is now integrated into `main`.

---

## 1. Where the branch stands (shipped)

All built, tested, committed on the branch, and deployed to local-prod:

- **v1** — iter1–7: CRUD store + schemas + routes + FE shell; run engine (`agent-runtime.js`,
  `agrun-` tmux jobs, pure `decide()` reducer over persisted `nodeExecutions[]`,
  boot-rediscovery); MCP proxy + approvals; per-run scoped MCP tokens; send-guidance;
  templates (export/clone/import).
- **Richer workflows** — iter8 custom agent-task DAGs; iter10 **retry** (per-node policy);
  iter11 **condition/router** (named branches, transitive skip).
- **Arc II core (all shipped)** — A1 **evaluation/self-critique** node (6322d83);
  B2 **cost/budget caps** → `budget_exhausted` (f2d3cd0); R8 **stream-json parser** (970b137);
  A2 **bounded iteration / revise-until** (98d88fa, real-claude `--resume` verified);
  B1 **scheduled runs** (8ff3998).
- **UI-coverage** — `objectiveTemplate` now exposed in the editor (6bf55b4); audit recorded
  complete (9c2e8a7).
- Test suite: `pnpm --filter @sparklab/terminal-gateway test:agentic` = **437 checks**.

The reducer discipline held across every slice: retry, router, eval, budget, and loop are all
**driver policies**, so `decide()` stays pure and restart-safe.

---

## 2. What's left (deferred Arc II)

Ordered by recommended sequence. Each states its **decide()-touch** and **persistence** cost
up front — that's the risk axis on this codebase.

### 2.1 Merge finish line — DO FIRST (blocking, low effort)

The branch is a large, well-tested body of work that is still **not on main**. Before adding
more surface:

- [ ] Open a PR `feat/agentic-ai-creator` → `main`; review the diff for the `browser-*`
      workstream leakage (see §4 — must NOT be swept into this merge).
- [ ] Confirm the local-prod **`GATEWAY_API_TOKEN` prereq**: it is currently UNSET, so agentic
      runs that use pm/kanban MCP connections won't work in prod (fail-closed-safe, not a bug).
      Decide: set it in prod-gateway env, or document runs-with-MCP-connections as unsupported
      until set. (Runs with no MCP connections already work via self-minted scoped tokens.)
- [x] Merge readiness gate completed; the feature is integrated into `main`.

### 2.2 A3 — agent-to-agent chat (HIGH effort, touches decide())

Multi-turn agent↔agent messaging within a run. Deferred with only a sketch in the Arc II plan.

- Decide()-touch: **likely yes** — a chat exchange is a new edge/interaction shape, not a plain
  DAG node. This is the riskiest remaining slice; treat like router/loop (design-review round +
  impl-spec + Codex-writes/Opus-controls).
- Persistence: message ledger must be restart-safe (append-only, like `nodeExecutions[]`).
- **Checkpoint with user before building.** Write a design-review doc first
  (`docs/AGENTIC-A3-*`), mirroring the loop/router precedent.

### 2.3 Dynamic-width map — A2's deferred half (MEDIUM effort)

A2 shipped **while-only** iteration; the deferred half is **map** (fan out N parallel copies of
a node over a runtime-computed list).

- Decide()-touch: **probably yes** — dynamic node count means the resolved workflow width isn't
  known at author time; the reducer currently assumes a static graph. Confirm whether this can
  be a driver-materialization policy (preferred, keeps decide() pure) or needs reducer support.
- Interaction: composes with budget (spawn cap must clamp the fan-out wave — the exact-cap wave
  clamp from B2 already exists) and with `parallel_write_forbidden` (map of workspace-write
  agents must stay banned).

### 2.4 Full 5-field cron (LOW–MEDIUM effort, does NOT touch decide())

B1 shipped **cron-lite** (`{every: minute|hour|day, interval, atHour?, atMinute?}`, UTC fixed
anchor). Extend to standard 5-field cron (min/hour/dom/month/dow).

- Track B (operational) — never touches `decide()`.
- Reuse B1's at-most-once machinery (pre-fire `nextFireAt` claim, tick reentrancy guard, boot
  catch-up). Keep schedule create/patch/delete **human-cookie-only** (bearer→403) per B1's
  security posture.
- Watch: DST / timezone handling if moving off pure-UTC; parser edge cases (ranges, steps,
  lists). Add a `test:agentic` block mirroring B1's time-math tests.

### 2.5 Event triggers (MEDIUM effort, does NOT touch decide())

Fire `startRun` on an event (webhook / file / upstream-run-completion) rather than a clock.

- Track B (operational). Same fail-closed approval posture as scheduled runs (unattended runs
  deny on any approval-required tool via B1's 4 layers).
- Design question: which event sources are in v1? Recommend a single narrow source first
  (e.g. an authenticated webhook route) rather than a generic bus. Checkpoint the source list
  with the user.

---

## 3. Cross-cutting invariants to preserve (do not regress)

- **`decide()` stays a pure reducer** over persisted `nodeExecutions[]`. New behavior lives in
  the driver (server.js) as policy, not as reducer logic or process-memory state. This is the
  load-bearing survivability property — 5 slices have now held it.
- **`agrun-` prefix only** for run tmux jobs (never `web-`; `tmuxKill()` is hard-constrained).
- **Fail-closed on approvals** for unattended (scheduled/event) runs; never fall back to the
  broad token; refuse on executable-definition drift (fingerprint verified TOCTOU-safe inside
  `startRun`).
- **Restart-safety per slice:** every new counter/flag (like `retryPending`, `loopPending`,
  `neverRanRecoveryCount`) must survive SIGKILL + boot-rediscovery without double-counting. Add
  a load-bearing restart test for each.
- **Codex-writes / Opus-controls** build model for risky slices: design-review doc → impl-spec →
  Codex implements → Opus writes/runs all tests, reviews, commits, deploys. Run Codex with
  `--sandbox danger-full-access` (its default bwrap sandbox fails `RTM_NEWADDR` in this nested
  env).

---

## 4. Out of scope for this plan (triage separately)

- **Uncommitted `browser-*` handoff workstream** — the working tree has modified/new files under
  `apps/agent-service/src/browser-*` and `apps/terminal/src/features/browser-handoff/*`. Per the
  project record these are a **separate concurrent workstream**, not part of the agentic branch's
  intent. They live outside this session's `apps/terminal-gateway` sandbox and were not reviewed
  here. **Action:** triage on their own (understand → test → commit-or-discard); keep them OUT of
  the agentic merge in §2.1.
- Also still deferred (from the plan docs, not Arc II): shared agent-library UI, template
  marketplace/registry, per-tool token closure residual, remote-host proxy distribution.

---

## 5. Recommended next action

1. **§2.1 merge finish line first** — get 437-check-green work onto main before widening surface,
   and resolve the `GATEWAY_API_TOKEN` prod prereq.
2. Then pick **§2.4 full cron** or **§2.5 event triggers** (Track B, low risk, no reducer touch)
   for the next shipped slice.
3. Defer **§2.2 A3** and **§2.3 map** until a design-review round; they touch `decide()` and
   warrant the full spec-first treatment.
