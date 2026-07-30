# Full 5-field cron for scheduled agentic runs — design & build plan

> **Scope:** §2.4 of `plan.md` — extend B1 scheduled runs from cron-lite
> (`{every, interval, atHour?, atMinute?}`) to standard 5-field cron.
> **Track:** B (operational) — **does NOT touch `decide()`**.
> **Branch:** `feat/agentic-ai-creator`. **Date:** 2026-07-29.

---

## 0. Key finding — the extension point is tiny

The schedule poll loop in `src/server.js` (`schedulePollTick`, ~line 3957) is
**spec-agnostic**: it only reads `schedule.nextFireAt` and re-derives it via
`schedules.computeNextFireAt(spec, now, createdAt)`. The routes, the at-most-once
claim (`nextFireAt` pre-fire + tick reentrancy guard), `activeRunsForSchedule`
one-run-per-schedule, boot catch-up, and human-cookie-only auth are **all
unchanged**. Full cron is therefore localized to **two functions** in
`src/agentic-schedules.js`: `validateSpec` and `computeNextFireAt`.

---

## 1. Design decisions

### D1 — Spec shape (backward-compatible discriminated union)

Keep the existing cron-lite form untouched; add a second form:

```jsonc
// cron-lite (unchanged — existing schedules keep working):
{ "every": "day", "interval": 1, "atHour": 9, "atMinute": 0 }

// new full cron:
{ "cron": "0 9 * * 1-5" }   // 09:00 UTC on weekdays
```

`validateSpec` branches on presence of `cron` (string) vs `every` (enum). Existing
`agentic-schedules.json` records load and fire identically — no migration.

### D2 — Dialect

- Standard **5 fields**: `minute hour day-of-month month day-of-week`.
- **UTC** (matches today's fixed-anchor UTC math).
- Per field: `*`, list `1,15`, range `1-5`, step `*/n` and `1-5/2`.
- Ranges (inclusive): minute `0-59`, hour `0-23`, dom `1-31`, month `1-12`,
  dow `0-6` **with `7` accepted as Sunday**.
- **Numbers only in v1** — no `JAN`/`MON` names (deferred, note in tool desc).

### D3 — Day-of-month / day-of-week semantics

**Vixie-cron OR**: when _both_ dom and dow are restricted (neither is `*`), a time
matches if **either** the dom OR the dow matches. If exactly one is restricted, only
that one constrains. This is the standard cron behavior and the classic gotcha —
stated explicitly and covered by a dedicated test.

### D4 — `computeNextFireAt` for cron

Return the first UTC minute **strictly after** `fromMs` whose components satisfy the
expression. Algorithm: forward scan at minute granularity, but **skip whole days**
when the candidate day fails month/dom/dow, and skip to the next candidate
hour/minute within a matching day. Cap the search at **4 years**; if no match, throw
`cron expression never matches` (guards impossible specs like `0 0 31 2 *`). No new
dependency. `anchorMs`/`createdAt` is irrelevant for cron (absolute wall-clock
schedule) and is ignored on this branch.

### D5 — Persistence / restart-safety

**Nothing new.** `nextFireAt` is already persisted and the poll loop is
spec-agnostic, so the at-most-once claim, boot catch-up, and crash recovery all carry
over. **Zero new counters, zero `decide()` change.**

### D6 — Frequency floor

Cron's own granularity (1 minute) is the floor — identical to cron-lite
`every:"minute", interval:1`. The existing `AGENT_SCHEDULE_MAX_INTERVAL` guard applies
only to the `interval` form; cron needs no analog (it can't express sub-minute).

---

## 2. Build checklist

### In this sandbox (`apps/terminal-gateway`) — fully testable via `test:agentic`

- [ ] `src/agentic-schedules.js`
  - [ ] `parseCronField(field, min, max, {sundayIsSeven})` → sorted match set (throws on bad token).
  - [ ] `parseCron(expr)` → `{minute, hour, dom, month, dow, domRestricted, dowRestricted}` (throws on ≠5 fields / out-of-range).
  - [ ] `validateSpec`: branch on `cron` vs `every`; return a normalized spec (echo `{cron}` verbatim once parsed-valid).
  - [ ] `computeNextFireAt`: add the cron branch (D4 scan); keep the three cron-lite branches byte-identical.
- [ ] `test/agentic-endpoints.js` — new cron block:
  - [ ] parse: `*`, list, range, `*/n`, `1-5/2`, `7`→Sunday; each field's bounds.
  - [ ] next-fire: `0 9 * * 1-5` from a known Tue → correct next weekday 09:00 UTC; wrap across month/year; Feb-29 handling.
  - [ ] **D3 DOM-DOW-OR**: `0 0 1 * 1` fires on the 1st **or** any Monday.
  - [ ] cap: `0 0 31 2 *` → throws `never matches`.
  - [ ] validation → **400**: 4-field / 6-field, `61` minute, `13` month, garbage token.
  - [ ] **regression**: an existing cron-lite spec still validates and computes the same `nextFireAt` (pin against current output).
  - [ ] create/update a schedule with a `cron` spec through the route; enable → poll fires once (reuse B1's harness).

### Outside this sandbox — needs a repo-root-scoped session

- [ ] `packages/shared-types/src/agent.ts` — `AgenticScheduleSpec` becomes a union of the
      cron-lite object and `{ cron: string }`; re-export from `index.ts`.
- [ ] FE schedule editor (`apps/terminal/.../agentic` app editor) — a cron-string input
      alongside the existing every/interval controls; emit the `{cron}` form.
- [ ] `docs/AGENTIC-SCHEDULE-IMPL-SPEC.md` — document the union + Vixie-OR + cap;
      `docs/TERMINAL-PROTOCOL.md` / `AGENT-PROTOCOL.md` schedule notes if present.

---

## 3. Invariants preserved

- `decide()` untouched (Track B).
- `agrun-` prefix only; unattended runs stay fail-closed on approvals; definition-drift
  fingerprint check unchanged.
- No new persisted counter → restart-safety inherited from B1 wholesale.
- cron-lite path byte-identical (regression-pinned) → existing schedules unaffected.

---

## 4. Recommended sequence

1. Build the two `agentic-schedules.js` functions + the `test:agentic` cron block here;
   get it green (independently valuable — the load-bearing, fully-testable core).
2. In a repo-root session: shared-types union + FE input + spec doc.
3. Full-gate (`test:agentic`, `test:parse`, typecheck, lint) → commit → deploy →
   live-FE smoke (mirror B1's headless-Chromium check).
