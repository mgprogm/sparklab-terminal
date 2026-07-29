# B1 — scheduled runs — IMPLEMENTATION SPEC

Builds the design settled over three Codex review rounds
(`docs/AGENTIC-SCHEDULE-DESIGN-REVIEW.md` §2 + §7–§9). Reducer UNTOUCHED. The whole
risk surface is AUTH — read §1 first. `test:agentic` at 417.

## 1. Security invariants (load-bearing — do not soften)

- **Schedule mutation (create/patch/delete/enable) is `isHumanCookieSession()`-ONLY.**
  The generic `/api/agentic/*` gate accepts `GATEWAY_API_TOKEN`; a broad-bearer holder
  MUST get 403 on schedule writes (else it installs persistent autonomous execution).
  Reads (list/get) may stay cookie-or-bearer, Origin-exempt.
- **A scheduled run is `unattended` and fails closed on every approval:** proxy manifest
  maps approval→deny; the gateway pending-tool-call route refuses registration; a
  `human-approval` workflow node is failed immediately by the driver. NO pending record
  is ever created for an unattended run.
- **An unattended run NEVER uses the broad `GATEWAY_API_TOKEN`.** If the app has artifact
  connections but a scoped token can't be minted (`AGENT_MCP_SCOPED_TOKENS` off / zero
  prefixes), the unattended run fails closed at start.
- **A fire runs EXACTLY the human-approved executable closure or refuses** (fingerprint;
  §4), verified inside `startRun` (TOCTOU-safe).
- **The concurrency cap can never be exceeded** — a shared atomic start reservation (§3)
  covers both the human POST and the scheduler.

## 2. Schema (`shared-types`) + sidecar (`src/agentic-schedules.js`, NEW)

`AgenticScheduleSchema = { id, agenticId, serverId, cwd, objective, spec:
{every:"minute"|"hour"|"day", interval:int>=1 (<= AGENT_SCHEDULE_MAX_INTERVAL, default
cap 1000), atHour?:0-23, atMinute?:0-59}, enabled:boolean, defFingerprint:string,
lastFiredAt:number|null, nextFireAt:number|null, lastAttemptAt:number|null,
lastOutcome?:"started"|"capacity_skipped"|"target_error"|"definition_changed"|"overlap_skipped"|null,
lastError?:string|null, createdAt:number }`.
Sidecar mirrors `registry.js`: `data/agentic-schedules.json`, atomic write
(`AGENT_SCHEDULES_FILE` override), sync CRUD mutators. **On load, a parse error LOGS
LOUDLY** (`console.error`) — do NOT silently empty like registry. `count()` =
enabled-schedule count (for loop gating).
Time math (UTC, fixed anchor — no wall-clock drift, no DST):

- `computeNextFireAt(spec, fromMs)`: anchor = `createdAt`; return the smallest instant
  `> fromMs` on the recurrence lattice. `minute`: anchor + k*interval*60000. `hour`:
  the next instant whose UTC minute == (atMinute ?? 0) and hour offset from the anchor's
  hour is a multiple of `interval`. `day`: the next UTC day at (atHour ?? 0):(atMinute ?? 0) that is a multiple of `interval` days from the anchor day. **Field rules:** `minute`
  rejects `atHour`/`atMinute`; `hour` accepts `atMinute` only; `day` accepts `atHour` +
  `atMinute` (default 0/0). Reject out-of-range / interval<1 / interval>cap.

## 3. Start reservation (`server.js`, shared by human + scheduler) — R-F

Module-level `let startReservations = 0;`. At the TOP of `startRun`, BEFORE any `await`
(single-threaded ⇒ atomic):

```
if (agentic.listActiveRuns().length + startReservations >= AGENT_MAX_CONCURRENT_RUNS)
  throw agenticErr("too_many_runs", "...");   // replaces the current pre-async check
startReservations++;
let reservationHeld = true;
const releaseReservation = () => { if (reservationHeld) { reservationHeld = false; startReservations--; } };
try { ... existing startRun body ... }
finally { releaseReservation(); }   // fallback
```

**Release `releaseReservation()` IMMEDIATELY after the synchronous `createRunRecord()`**
(the run is now counted by `listActiveRuns()`), so the reservation does not linger
through `advanceRun` and cause false capacity skips. The `finally` is only a fallback for
the throw-before-createRunRecord paths.

## 4. Executable-definition fingerprint (`agentic.js`) — R-OMIT

`fingerprintExecutableDefinition(agenticId)`:

- Gather the closure: the app (orchestrationMode, **objectiveTemplate**, workflow
  nodes+edges, agentIds, connectionIds, budget) + EVERY referenced agent's full def
  (runtimeProvider, systemPrompt, sandboxMode, model, toolPolicies) — referenced =
  `app.agentIds` ∪ every `workflow.nodes[].agentId` (custom workflows reference agents
  via node agentId, not only agentIds) + EVERY referenced connection's {targetType,
  targetId}. **Reject (throw) if any referenced agent/connection is missing** — never
  hash a partial closure.
- Build an explicit normalized projection (only the fields above), **recursively sort
  object keys, preserve array order**, `JSON.stringify`, SHA-256 → hex.
  Used at schedule create/edit (store `defFingerprint`) and at fire.
  **NOT in the closure** (schedule-owned): `objective`, `serverId`/`cwd`, `unattended`.

## 5. `startRun` extensions (`server.js`)

- Second entry shape: `startRun({agenticAiId, serverId, cwd, objective, unattended,
scheduleId, expectedFingerprint})`. When `serverId`+`cwd` are given (scheduler path):
  validate the server is reachable + `cwd` is absolute, and freeze `serverId`+`cwd` into
  `resolvedConfig` DIRECTLY (skip the tmux-session→`pane_current_path` resolution the
  human `sessionId` path uses). The human path (`sessionId`) is unchanged.
- **Fingerprint verify (TOCTOU-safe):** when `expectedFingerprint` is provided, after the
  final target-resolution `await` and BEFORE resolving agents / `createRunRecord`,
  recompute `fingerprintExecutableDefinition(agenticAiId)`; if `!== expectedFingerprint`
  → throw `definition_changed`.
- **unattended:** when true, if the app has connections and a scoped token can't be minted
  → throw (fail closed, no broad-token fallback). Freeze `unattended:true` + `scheduleId`
  into the run record (`createRunRecord`).
- `runServer(run)` MUST resolve `run.resolvedConfig.serverId` (today it derives from
  `sessionId`) so a sessionless scheduled run targets the right server for spawn+cleanup.

## 6. Unattended fail-closed wiring (`server.js` + proxy) — R-B

1. Proxy manifest builder: when `resolvedConfig.unattended`, emit every approval-tier
   toolPolicy as `deny`.
2. Gateway pending-tool-call registration route (`POST …/nodes/:id/pending-tool-call`):
   if the run is unattended, respond with an immediate deny (do NOT `recordPendingToolCall`).
3. Reducer sweep: unchanged (recovery only).
4. The driver, where it would `gateApprovalNode` a `human-approval` node: if the run is
   unattended, instead `recordNodeResult(failed, "unattended: no human to approve")`
   (fail-fast). No pending record, ever.

## 7. Scheduler loop + routes (`server.js`)

- `activeRunsForSchedule(scheduleId)` (agentic.js): `listActiveRuns()` returns IDs →
  dereference via `getRun` and filter `r.resolvedConfig?.scheduleId === scheduleId`
  (or add a records-returning helper). Overlap = any active run for this schedule.
- Loop: `AGENT_SCHEDULE_POLL_INTERVAL_MS` (default 30000), gated on
  `schedules.count()>=1` (start on first enabled schedule, stop at zero, boot if any
  persisted — mirror the push loop). A module `let scheduleTicking=false` reentrancy
  guard (skip if already ticking). Each tick, SEQUENTIALLY (await each) for every enabled
  schedule with `now >= nextFireAt`:
  1. If `activeRunsForSchedule` non-empty → outcome `overlap_skipped`, advance nextFireAt,
     continue.
  2. **Claim:** advance+persist `nextFireAt` = computeNextFireAt(spec, now) BEFORE
     starting (a crash now loses this occurrence — accepted at-most-once).
  3. `try { await startRun({agenticAiId, serverId, cwd, objective, unattended:true,
scheduleId, expectedFingerprint: schedule.defFingerprint}); outcome "started"; }`
     `catch (e) { outcome = e.code==="too_many_runs" ? "capacity_skipped" :
e.code==="definition_changed" ? "definition_changed" : "target_error"; lastError=e.message; }`
     Always set `lastAttemptAt`, `lastOutcome`, persist.
  - Boot catch-up: on init (AFTER stores load + AFTER counting active runs), any enabled
    schedule with a past `nextFireAt` fires AT MOST ONCE via the same claim-then-start.
- Routes `/api/agentic/schedules`: `GET` (list) + `GET /:id` Origin-exempt; `POST`
  (create), `PATCH /:id`, `DELETE /:id` — **`isHumanCookieSession()`-only** + Origin/CSRF.
  Create/patch recompute + store `defFingerprint` and `nextFireAt`. Zod-validate the body.
- `.env.example`: `AGENT_SCHEDULES_FILE`, `AGENT_SCHEDULE_POLL_INTERVAL_MS=30000`,
  `AGENT_SCHEDULE_MAX_INTERVAL=1000`.

## 8. Frontend (`public/agentic/app.html`)

A "Schedule" section in the Agentic AI editor: spec fields (every/interval/atHour/
atMinute), enable toggle, next-fire + lastOutcome/lastError display, and a note that
editing the app requires re-saving the schedule (drift refuses). Self-contained; the
FE already carries the cookie so human-only writes work. (serverId+cwd seeded by
snapshotting the currently-selected session's resolved cwd at schedule-create.)

## 9. Tests (Opus — `test/agentic-endpoints.js`)

Per §7/§8 of the review + the mandatory list:

1. Schedule CRUD; **broad bearer (no cookie) CANNOT create/patch/enable/delete → 403**;
   scoped run token cannot reach schedule routes.
2. A due schedule fires EXACTLY ONE start (short interval; assert one run, lastFiredAt,
   nextFireAt advanced, outcome "started").
3. Missed-window catch-up fires AT MOST ONCE on boot (persist past nextFireAt, restart).
4. Disabled schedule never fires.
5. Unattended run never creates a pending approval record + never forwards an
   approval-tier tool (drive the proxy path); an unattended `human-approval` node fails
   immediately.
6. Definition drift: patch a referenced AGENT (no app-version bump) → next fire is
   REFUSED with outcome `definition_changed`, no run; re-save schedule re-pins → fires.
7. Overlap: a still-active prior run → next occurrence `overlap_skipped`.
8. Cap race / reservation: with `AGENT_MAX_CONCURRENT_RUNS` full, a fire is
   `capacity_skipped`; and the shared reservation prevents exceeding the cap.
9. Ephemeral/target error: unreachable server or bad cwd → `target_error`, loop survives.
10. Boot ordering: schedules init after stores load; active runs counted before catch-up.
    Full `test:agentic` stays green (scheduler idle unless a schedule exists).

## 10. Build stages (Codex writes, Opus reviews + tests)

1. shared-types `AgenticSchedule` + `src/agentic-schedules.js` sidecar (CRUD + time math
   - loud-corruption) + agentic.js helpers (`fingerprintExecutableDefinition`,
     `activeRunsForSchedule`, createRunRecord freezes scheduleId/unattended).
2. server.js: start reservation; startRun serverId+cwd path + fingerprint verify +
   unattended/no-broad-token + runServer(serverId); the 4-layer unattended fail-closed;
   the scheduler loop + routes (human-cookie-only) + boot init; .env.example.
3. FE schedule section.
4. Opus writes tests (§9).
