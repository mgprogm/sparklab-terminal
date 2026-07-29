# B1 — scheduled runs — DESIGN REVIEW

> **Status: FOR REVIEW — not approved to build.** Arc II §B1 checkpoint (MEDIUM):
> the reducer is untouched, but automated start reverses a v1 safety posture (D7:
> start is human-only), so it needs sign-off before code. Grounded in current code
> on `feat/agentic-ai-creator`; `test:agentic` at 417 (retry+router+eval+budget+A2).

## 1. What B1 is

Fire an Agentic AI run on a time schedule ("every night") with no human present —
a thin trigger in front of the EXISTING `startRun`; the run engine is unchanged
(D-Sched-1). New sidecar `data/agentic-schedules.json` (atomic write, mirrors
`registry.js`/`push.js`), CRUD under `/api/agentic/schedules`, and a background
timer loop **gated on enabled-schedule count** (mirrors the push poll loop's
`isConfigured()||count()===0` gate — never runs when unused).

## 2. Decisions requiring sign-off (with recommendations)

### D-Sched-A — Is automated start acceptable at all? (the checkpoint itself)

Reverses D7 (human-only start). It becomes acceptable ONLY because the trigger is
a **scoped, server-side capability** — NOT a human cookie, NOT the broad
`GATEWAY_API_TOKEN`. Mechanically the scheduler calls the internal `startRun(...)`
directly (not over HTTP), so there is no ambient auth to leak; and the fired run's
MCP tool calls already self-mint iter5 per-run scoped tokens
(`AGENT_MCP_SCOPED_TOKENS` on by default). **Recommend: yes, with §D-Sched-B's
fail-closed approval policy.** Your call to confirm.

### D-Sched-B — Approval-tier tools in an unattended run. **[recommend: fail-closed FAST]**

No human is present to approve. Today an approval-tier MCP call would hold up to
`AGENT_MCP_APPROVAL_TIMEOUT_MS` (170s) then time out → reject — it _already_ fails
closed, but slowly. **Recommend: mark the fired run `unattended:true` (frozen on
the run); the approval path auto-DENIES an approval-tier call immediately for an
unattended run** (fail-closed fast, no 170s hold, never silent-approve). Options to
confirm: (a) auto-deny-fast [recommend]; (b) disallow — skip the fire if the app's
agents carry any approval-tier `toolPolicy`; (c) leave it to the 170s timeout.

### D-Sched-C — What does a schedule STORE, and the ephemeral-target problem? **[the real gap]**

`startRun` needs `{agenticAiId, sessionId, objective}` and resolves the target
**cwd + server from the live tmux session** at start. But tmux sessions are
ephemeral — a stored `sessionId` may be **gone** when the schedule fires days
later. Options:

- **(a) store `{agenticId, sessionId, objective}`; on fire, if the session is gone,
  the fire FAILS (recorded on the schedule as `lastError`, loop continues).**
  Simplest; honest best-effort, mirrors push's "missed during restart = best-effort."
- (b) store `{agenticId, serverId, cwd, objective}` and add a `startRun` path that
  takes an explicit cwd+server instead of resolving from a session — durable across
  session churn, but a new startRun entry shape.
- (c) auto-create a fresh throwaway session at fire time from a stored server+cwd.
  **Recommend (a) for v1** (smallest, honest), and document the ephemeral-target
  caveat loudly; (b) is the natural v2 if scheduled runs need to outlive sessions.
  Confirm.

### D-Sched-D — cron parser: dependency, hand-roll, or a simpler v1 spec? **[recommend: simpler spec, no cron parser in v1]**

There is NO cron dep, and hand-rolling a correct 5-field cron (ranges/steps/lists,
DST, month/day-of-week) fails subtly — the same "silent-wrong" hazard that justified
the `web-push` dep. Options:

- (a) add a tiny vetted cron dep (e.g. `cron-parser`) — one more dep, but correct.
- (b) hand-roll 5-field cron — risky, lots of edge cases to test.
- **(c) v1 schedule spec = a small, exact, dependency-free shape** instead of cron:
  `{ every: "day"|"hour"|"minute", interval: N, atMinute?, atHour? }` (e.g. daily at
  02:30, every 6 hours). Covers "run every night / every N hours" — the stated
  motivation — with trivially-correct `nextFireAt` math and no parser. Full cron is
  its own deferred slice.
  **Recommend (c)** — smallest correct thing that meets the motivation; the schema
  below assumes it. Confirm (or pick a dep if real cron is required now).

### D-Sched-E — Persistence / re-derivability (D-Sched-3). **[recommend as stated]**

`lastFiredAt` + `nextFireAt` persisted. On boot, a schedule whose `nextFireAt`
passed during downtime fires **at most once** (catch-up, NOT backfill-N), then
recomputes `nextFireAt` from now. Document like push's "missed during restart =
best-effort."

### D-Sched-F — Concurrency / dedup. **[recommend as stated]**

A fire that would exceed `AGENT_MAX_CONCURRENT_RUNS` is **skipped + logged** (not
queued); `nextFireAt` still advances (no storm on the next tick). A schedule does
not fire again until its next window regardless of whether its prior run finished.

## 3. Design (assuming the recommendations)

- **Sidecar** `src/agentic-schedules.js` (new): load/persist `data/agentic-schedules.json`
  (atomic write, `AGENT_SCHEDULES_FILE` override), sync CRUD mutators (mirror
  `registry.js`). `nextFireAt` computed on create/update/fire.
- **Schema** `AgenticSchedule = {id, agenticId, sessionId, objective, spec:{every,
interval, atHour?, atMinute?}, enabled, lastFiredAt|null, nextFireAt|null,
lastError?|null, createdAt}`.
- **Routes** `/api/agentic/schedules` (list/get GET Origin-exempt; create/patch/delete
  writes Origin/CSRF-guarded; cookie auth — mirrors the artifact route conventions).
- **Timer loop** `AGENT_SCHEDULE_POLL_INTERVAL_MS` (default 30000), gated on
  enabled-schedule count (starts on first enabled schedule, stops at zero, boots if
  any persist). Each tick: for each enabled schedule with `now >= nextFireAt`: mint
  nothing extra (startRun self-scopes), call `startRun({agenticAiId, sessionId,
objective, unattended:true})`; on success set `lastFiredAt=now`, clear `lastError`;
  on throw set `lastError`; always recompute `nextFireAt`. Respect
  `AGENT_MAX_CONCURRENT_RUNS` (skip+log if full).
- **`startRun` gains `unattended`** (frozen on the run's resolvedConfig/run record);
  the approval path (proxy pending-tool-call + the reducer approval sweep) auto-denies
  approval-tier calls for an unattended run (D-Sched-B). No decide() change.
- **Frontend**: a "Schedule" section in the Agentic AI editor (spec fields + enable
  toggle + next-fire display + lastError). Self-contained artifact.
- **Env**: `AGENT_SCHEDULES_FILE`, `AGENT_SCHEDULE_POLL_INTERVAL_MS=30000`.

## 4. Tests (Opus writes)

- Schedule CRUD (create/list/patch/delete; writes CSRF-guarded, reads Origin-exempt).
- A due schedule fires EXACTLY ONE start (advance a short-interval spec; assert one
  run created, `lastFiredAt` set, `nextFireAt` advanced).
- Missed-window catch-up fires AT MOST ONCE on boot (persist a past `nextFireAt`,
  restart, assert exactly one fire).
- Disabled schedule never fires.
- Unattended run + approval-tier tool ⇒ fail-closed (auto-deny fast, D-Sched-B).
- Ephemeral-target: schedule whose `sessionId` is gone ⇒ fire fails, `lastError` set,
  loop survives (D-Sched-C).
- Concurrency cap: fire skipped+logged when `AGENT_MAX_CONCURRENT_RUNS` full.

## 5. Explicitly deferred

Event triggers (D-Sched-4 — needs an event bus this system lacks); full 5-field cron
(if D-Sched-D picks the simpler spec); schedule "run history" beyond `lastFiredAt`.

## 6. Sign-off checklist

1. **D-Sched-A** — automated start acceptable (it reverses D7 human-only)?
2. **D-Sched-B** — unattended approval-tier policy: auto-deny-fast (vs disallow / timeout)?
3. **D-Sched-C** — store sessionId+objective, best-effort on a gone session (vs store cwd+server)?
4. **D-Sched-D** — v1 simple interval/daily spec (vs a cron dep / hand-rolled cron)?

---

## 7. Codex review — round 1 (2026-07-29): NOT ready as-is; amendments required

Codex reviewed against the code and returned **do not approve as-is** — direction
sound, but the auth model was overstated and D-Sched-B/C/E are underspecified in
safety-critical ways. Verdicts: A AGREE-w/-amend · B AGREE-w/-amend · **C DISAGREE**
· D AGREE-w/-amend · **E DISAGREE** · F AGREE-w/-amend. Opus concurs; these become
build preconditions.

### Corrected premise (important)

"Start is human-only (D7)" is **false in code**: the generic `/api/agentic/*` gate
accepts `GATEWAY_API_TOKEN`, and the run route does no `isHumanCookieSession()`
check — a broad bearer can ALREADY start a run. So B1's real security requirement
is NOT "guard start" but:

- **Schedule create/patch/delete/enable MUST be `isHumanCookieSession()`-only** (the
  generic bearer-or-cookie middleware does NOT enforce this; "cookie auth" in prose
  is insufficient). Otherwise any `GATEWAY_API_TOKEN` holder installs _persistent
  autonomous execution_ — the true escalation B1 introduces.

### Amendments (fold into the impl spec)

- **A — human-cookie-only schedule admin** (above) + unattended runs must NEVER fall
  back to the broad token: if a per-run scoped token can't be minted
  (`AGENT_MCP_SCOPED_TOKENS` off, or zero artifact prefixes), the unattended run
  fails closed rather than using `GATEWAY_API_TOKEN` (today `gatewayApiTokenForNode`
  starts from the broad token and only scopes when enabled + a prefix exists).
- **B — auto-deny enforced BEFORE any pending record, 4 layers:** (1) proxy manifest
  maps `approval`→`deny` when the run is `unattended`; (2) the gateway pending-tool-
  call route REFUSES registration for an unattended run; (3) the reducer sweep is
  recovery-only; (4) **the workflow driver immediately FAILS an `unattended`
  `human-approval` node** (iter9 gates otherwise park forever — no human, no
  timeout). Freeze `unattended` in `resolvedConfig`.
- **C — durable target, not a bare sessionId.** A gone session fails cleanly
  (`cwd_unresolved` before run creation — safe), BUT a tmux name can be REUSED for a
  different cwd ⇒ silent wrong-workspace run. Store `serverId + cwd` as the durable
  target (or store the expected cwd at create and REFUSE to fire if the live session
  resolves to a different cwd). Documenting "ephemeral" is not enough.
- **D — exact time semantics:** UTC-only v1; positive bounded intervals; validate
  `atHour`/`atMinute`; `nextFireAt` computed from a defined scheduled anchor (not
  drifting from wall-clock). "Daily at 02:30" is ambiguous until TZ is pinned (UTC).
- **E — at-most-once needs a pre-fire claim, not just persisted timestamps.** A crash
  after `startRun` creates the run but before the schedule update persists ⇒
  double-fire on restart; overlapping async ticks ⇒ double-fire. Fix: **advance +
  persist `nextFireAt` BEFORE calling `startRun`** (a crash then LOSES that
  occurrence — acceptable at-most-once), PLUS a per-tick reentrancy guard/mutex. Or
  persist an occurrence id into the Run and reconcile on boot.
- **F — cap race + overlap policy.** `startRun`'s `too_many_runs` check runs before
  async probing, so two concurrent starts can both pass ⇒ add a start reservation/
  mutex. Default **one active run per schedule** (don't start the next interval while
  the prior run is still active — concurrent writers on one cwd). Persist
  `lastAttemptAt` + an outcome enum (`started`|`capacity_skipped`|`target_error`) —
  a console log is inadequate observability.

### Other omissions to address

- **App-version pinning:** each fire currently resolves the live app def; a bearer
  holder could mutate a scheduled app after human approval. Pin the app `version` on
  the schedule (or make app mutation human-only) and freeze at fire.
- Sidecar corruption should **log loudly** (registry silently empties — unacceptable
  for schedules).
- **Boot ordering:** init schedules only AFTER stores load; count persisted active
  runs BEFORE any catch-up fire.

### Mandatory added tests

Broad bearer CANNOT create/modify/enable/delete a schedule; scoped run token cannot
reach schedule routes; unattended run never creates a pending approval record and
never forwards the tool; unattended `human-approval` node fails immediately; crash
between run-creation and schedule-persist does NOT duplicate; two overlapping ticks
fire once; reused `sessionId` with a different cwd is rejected; two concurrent starts
cannot exceed `AGENT_MAX_CONCURRENT_RUNS`; a still-active prior run skips the next
occurrence; scoped-tokens-disabled / zero-prefix does NOT hand an unattended run the
broad bearer.

**Net:** direction sound; before an implementation spec, resolve the human-cookie-only
schedule admin + no-broad-token-fallback (A), the 4-layer unattended enforcement incl.
human-approval nodes (B), durable `serverId+cwd` target (C), the pre-fire-claim + tick
mutex at-most-once (E), and the start-reservation + one-run-per-schedule + durable
outcome (F). The user must still sign off on **D-Sched-A: automated start acceptable
at all** (now correctly framed as "human-installed persistent autonomous execution").
