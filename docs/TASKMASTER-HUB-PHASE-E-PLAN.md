# Task Master Hub Phase E — design

> Status: **built (2026-09-06), uncommitted.** See
> [`TASKMASTER-HUB-PHASE-E-SPEC.md`](./TASKMASTER-HUB-PHASE-E-SPEC.md) for the
> as-built spec (two corrections vs. this plan: D2 needed zero gateway
> changes, and D4 could not reuse rollup data as this doc originally assumed —
> see the spec's header). Closes the four items still open in
> `docs/TASKMASTER-HUB-OPERATIONS.md`'s "Current limitations and roadmap"
> after Phase C + the Hub MCP (`docs/TASKMASTER-HUB-MCP-PLAN.md`). Four
> independent slices — no shared code path forces a build order, so they can
> ship separately (own commit, own verification) exactly like Phases A/B/C.
>
> **Post-build UI polish (2026-09-06, folded into the same commit):** four
> small, user-requested `app.html`-only follow-ups made after the D-sets
> above were verified, none touching the spec's locked decisions:
> (1) the board's `setInterval(refreshProjectData, 5000)` background poll
> was removed in favor of a manual **Refresh** button (`state.pollTimer`/
> `startPolling()`/the `keepPoll` parameter on `selectProject()` deleted
> outright — every call site already passed `false` for it); (2) the Add
> task and Project-rollup-and-search panels became collapsible
> (`localStorage`-persisted disclosure toggle, collapsed by default) to
> save vertical space; (3) `.topbar` changed from `flex-wrap: wrap` to
> `nowrap` + `overflow-x: auto` so it never wraps to a second line, with
> `overflow-y: hidden` alongside it — omitting `overflow-y` here is a real
> CSS-spec gotcha (an unset `overflow-y` computes to `auto` once `overflow-x`
> is anything but `visible`, so any sub-pixel vertical overflow silently
> opens an unwanted vertical scrollbar); (4) the "PM overview" metrics grid
> went from `repeat(3, minmax(100px, 1fr))` (wrapping 6 metrics into 2 rows)
> to `repeat(6, minmax(0, 1fr))` with ellipsis-truncated labels, fitting all
> six in one row. `docs/TASKMASTER-HUB-OPERATIONS.md`'s stale "5s poll"
> roadmap line was corrected alongside these.

## Why these four and not others

The roadmap in `TASKMASTER-HUB-OPERATIONS.md` had grown to include items the
Hub MCP already resolved (external-CLI claim access) and one item (bulk
status-change) that Phase B already shipped under a different name. What is
actually still open, re-verified against the code on 2026-09-06:

1. Per-chat role/name/tool selection in the Agent Chat UI (env-level only
   today — `AGENT_CHAT_ROLE`/`_NAME`/`_TOOL` in `apps/agent-service/src/config.ts:190-193`).
2. The claim preflight (`AgentLoop.activeTask`,
   `apps/agent-service/src/agent-loop.ts:72,621-624`) is a plain in-memory
   field with no reconstruction path after an agent-service restart.
3. `actorOf()` (`apps/terminal-gateway/src/server.js:353-365`) returns the
   same `user:<GATEWAY_AUTH_USER>` string for a human clicking in the Hub UI
   and for agent-service's own cookie-authed calls — so Phase C's
   `ownerChannel` guard cannot tell them apart, even though the Hub MCP's
   bearer callers already get this separation via `x-pm-actor`.
4. `state.taskFilter` (`apps/terminal/public/taskmaster-hub/app.html:776`) is
   an in-memory string, not persisted; there is no saved-filter concept and
   no cross-project search — only the per-project rollup strip
   (`app.html:741-1050`) exists today.

## D-set 1 — per-chat role picker

**Problem.** `AgentLoop.execute()` always sends `config.agentChat.identity*`
(`agent-loop.ts:719-724`) to `executeTool`, which becomes the claim's
`agentRole`/`agentName`/`agentTool`. One deployment, one identity for every
chat — a user running two chats as "frontend" and "backend" work has no way
to label them differently short of restarting agent-service with different
env vars.

**Design.** Thread identity the same way `model` and `reasoningEffort`
already are: a per-turn field on the client message, not new server-side
persistence.

- `packages/shared-types/src/agent.ts`: add an optional
  `identity: z.object({ role: z.string().max(64), name: z.string().max(64),
tool: z.string().max(64) }).optional()` to `AgentUserMessageSchema` (next to
  `model`/`reasoningEffort`, `agent.ts:122-136`).
- `agent-loop.ts`: `execute()` reads `this.pendingIdentity ?? config.agentChat`
  instead of the config block directly. `pendingIdentity` is set from the
  incoming user message's `identity` field each turn (mirroring how `model`
  is threaded per-turn already) and is **not** persisted server-side — it is
  a per-turn override, cheapest to reason about and consistent with the
  existing model-picker pattern.
- **Do not** touch `history.ts`'s `<chatId>.meta.json`. That file is
  documented as an _immutable_ ownership record (`history.ts:1-3`, written
  with `flag: "wx"`, `history.ts:93-96`) binding a chat to its terminal
  forever; adding a mutable identity field there would break that invariant
  and its write-once semantics. If "remember my last-picked identity per
  chat across a reload" is wanted later, that is a **client-side**
  concern — persist it in the existing frontend agent-chat store
  (already localStorage-backed for other composer state), keyed by `chatId`,
  and resend it every turn. Not required for this slice; the picker can
  default to `config.agentChat.identity*` and let the user re-pick per chat
  session, same as the model picker already does per browser session.
- Frontend: `composer.tsx` gains a small identity popover next to the
  existing model picker (same `DropdownMenu`/trigger-chip pattern already
  used there, `composer.tsx:390-495`) with three text inputs
  (Role/Name/Tool), pre-filled from a new `agent_capabilities` field
  (`AgentCapabilitiesSchema`, `agent.ts:269-272`) reporting the deployment's
  configured defaults so the picker never starts blank.
- **Out of scope for this slice** (call out explicitly, don't silently
  drop): the composer identity fields are free text, not validated against
  anything — a user could type a role that collides with another chat's.
  That's fine; identity strings are display-only per the MCP plan's own
  §2 note ("These are display/`agentId` only; the security boundary is the
  token + channel, never these strings") and the same holds for Agent Chat.

## D-set 2 — durable claim preflight

**Problem.** `this.activeTask` (`agent-loop.ts:72`) is set on a successful
`taskmaster_claim` and cleared on `taskmaster_release`/terminal status; it
lives only in the running `AgentLoop` instance. An agent-service restart
mid-task loses it — the loop reconstructs history from `history.ts`'s JSONL
on reconnect, but nothing today re-derives `activeTask` from that history or
from the gateway.

**Design — derive it from the gateway on demand, add no new store.** The
gateway's execution sidecar (`taskmaster-execution.js`) is already the
single source of truth for "who holds what claim" (that is the entire point
of the `ownerChannel` design). Duplicating that into a second, agent-service-
owned persistence file would create exactly the kind of drift the codebase's
sidecar-store pattern (Kanban/PM/Notes: one store, one owner) avoids
elsewhere. Instead:

- Add `gateway.findActiveClaim(agentId): Promise<{projectId, taskId} | null>`
  to `gateway-client.ts`'s taskmaster block (near the existing
  `taskmasterOverview`/`taskmasterList*` calls, `gateway-client.ts:453+`).
  It lists registered projects (`GET /api/taskmaster/projects`, already
  wrapped) and, for each, calls the existing per-project claim listing that
  backs the overview endpoint, returning the first match where
  `agentId === "chat-<chatId>"`. (If the current overview response doesn't
  already expose enough to filter by `agentId` without a second call per
  project, add a narrow `GET /api/taskmaster/projects/:id/claims` route
  that returns `taskmaster-execution.js`'s existing `list(projectId)`
  verbatim — that function already exists, `taskmaster-execution.js:69`, it
  is just not routed today.)
- `AgentLoop`'s constructor (or the first `execute()` call after a fresh
  instance is created for a resumed chat) calls this once and populates
  `this.activeTask` before the preflight check can block a legitimate
  in-progress task. Cheap: it only runs once per `AgentLoop` instance
  lifetime (i.e., once per reconnect/restart), not per turn.
- **Bounded cost, explicit trade-off to document**: with N registered
  projects this is up to N gateway round trips on the first turn after a
  restart. Acceptable at Hub scale (a handful of registered projects per
  deployment); revisit only if that stops being true.
- This also means: no new data file, no migration, no `ownerChannel`
  interaction — the fix is purely "ask the source of truth instead of
  trusting a memory var," which is more correct than durable local state
  would be anyway (the gateway's claim can outlive or be released by another
  channel while agent-service is down; deriving fresh avoids ever acting on
  a stale cached claim).

## D-set 3 — separate the Hub-UI-human channel from Agent Chat

**Problem.** `actorOf()` (`server.js:353-365`) only consults the
`x-pm-actor` header on the **bearer** branch. Both the Hub UI's own
`fetch("/api/taskmaster"+path, ...)` calls (`app.html:852`) and
agent-service's `gateway-client.ts` calls are cookie-authed, so both return
the bare `user:<GATEWAY_AUTH_USER>` string — Phase C's
`ownerChannel` guard (`taskmaster-execution.js:129-131`) sees them as the
same channel and can never 403 one against the other.

**Design — extend the existing header to the cookie branch too**, mirroring
exactly what the Hub MCP already does for bearer callers
(`TASKMASTER-HUB-MCP-PLAN.md` §2):

- `server.js`: in `actorOf()`, check `x-pm-actor` unconditionally (not only
  inside the `isArtifactBearerAuthorized` branch), and when present and
  valid, suffix it onto whichever prefix already applies:
  `user:<GATEWAY_AUTH_USER>:<actor>` for the cookie branch (parallel to the
  existing `client:<actor>` for bearer). Same validation regex already in
  place (`^[\w.@:-]+$`, ≤64 chars) — no new validation code, just a wider
  branch that calls it.
- `gateway-client.ts`: add `x-pm-actor: agent-chat` to the taskmaster call
  block only (not the shared generic `call()` used by fs/git/servers/PM/
  Kanban/Notes routes too — this is deliberately scoped to Task Master so it
  doesn't change `actorOf()`'s output for unrelated features' `reporter`/
  notification-recipient fields, which is out of scope for this plan and a
  needless behavior change elsewhere). Concretely, a small
  `taskmasterCall(path, init)` wrapper around the existing private `call()`
  that merges in the header, used by the taskmaster methods only.
- `app.html` sends nothing new — its unmarked cookie calls keep resolving to
  the bare `user:<GATEWAY_AUTH_USER>`, so a human claim
  (`agentId: "human"`) and an Agent Chat claim
  (`agentId: "chat-<chatId>"`) now also get **different real channels**
  (`user:admin` vs. `user:admin:agent-chat`), closing the gap the operations
  doc calls out.
- **Backward compatible by construction**: pre-Phase-C-style records already
  wildcard on `ownerChannel === "legacy"` (`taskmaster-execution.js:129-131`
  short-circuits when either side is `"legacy"`); this change only makes the
  cookie branch's _non-legacy_ value more specific, it doesn't change the
  legacy wildcard behavior at all.
- One coarse suffix (`agent-chat`, not `agent-chat:<chatId>`) is enough:
  cross-chat exclusivity already comes from `agentId` differing per chat in
  `claim()`'s first check (`taskmaster-execution.js:90`); the channel suffix
  only needs to separate "Agent Chat, whichever chat" from "a human in the
  Hub UI," which a single shared suffix does.
- Verification: extend `apps/terminal-gateway/test/taskmaster-endpoints.js`
  with a case sending `x-pm-actor` on a cookie-authed request and asserting
  the resulting `ownerChannel` carries the suffix, plus a 403 case
  (human-claimed task, agent-chat-suffixed update rejected) — same shape as
  the existing Phase C bearer-vs-cookie test, just cookie-vs-cookie-with-
  suffix this time.

## D-set 4 — saved filters + cross-project task search

This is explicitly the lowest-priority item (the operations doc's own
wording: "remain post-v1 work"), scoped small on purpose.

- **Saved filter presets.** `state.taskFilter` becomes
  `localStorage`-backed per browser (key `taskmasterHub.savedFilters`, an
  array of `{name, query}`), with a small "Save current filter" / preset
  dropdown next to the existing `#task-filter` input
  (`app.html:2153-2154`). Client-only, no gateway route, no schema change —
  same pattern already used elsewhere in this repo for per-viewer UI state
  (e.g. sidebar collapse state in the main terminal app).
- **Cross-project search**, scoped to what's actually informative without a
  cross-project dependency model (which does not exist in Task Master and
  is explicitly out of scope — deps are per-project, per
  `TASKMASTER-HUB-OPERATIONS.md`'s "Execution state versus Task Master
  state" section): reuse the existing rollup infrastructure
  (`state.rollup`/`el.rollupStrip`, `app.html:783,997-1020`), which already
  fetches every registered project's overview in parallel. Add a text input
  above the rollup strip that filters the **already-fetched** rollup rows'
  task titles/ids client-side — no new backend calls, since the rollup
  already holds per-project summaries once refreshed. This gives "which
  registered projects have a task matching X" without inventing a
  cross-project dependency graph the underlying tool doesn't have.
- **Not doing**: an actual cross-project dependency edge (Task Master has no
  such concept — a fabricated one would drift from what `task-master show`
  reports and violate the project's own rule that Task Master stays
  authoritative for dependencies) and real-time push (still absent
  everywhere in this codebase's PM-family artifacts; each already polls at
  a fixed interval, and Task Master Hub's own 5s poll — noted in
  `TASKMASTER-HUB-UI-V2-PLAN.md` — remains the pattern here too).

## Build order

No dependency between D-sets. Suggested order by risk/value:
D3 (small, closes a real security-adjacent gap) → D1 (small, pure UX
addition) → D2 (small but touches the preflight gate, wants careful testing
of the restart case) → D4 (cosmetic, do last or skip).

## Verification checklist (per slice, mirrors Phases A-C's own bar)

- D1: `agent-service` unit test asserting a per-turn `identity` overrides
  `config.agentChat.*` in the `executeTool` call, and a fallback test when
  omitted. Manual composer smoke (two chats, two identities, both visible
  in Hub claim chips).
- D2: unit test constructing an `AgentLoop` against a gateway stub that
  reports an existing claim for `chat-<chatId>`, asserting `execute()`
  allows `run_command` on the very first call (no prior `taskmaster_claim`
  in this instance's own history). Live test: claim a task, kill and
  restart agent-service, confirm the same chat can continue without
  re-claiming and a _different_ chat is still blocked.
- D3: `test:taskmaster` gains the cookie+`x-pm-actor` case described above.
  Live prod-gateway spot check optional (matches Phase C's own verification
  depth).
- D4: manual browser check only (matches every other Hub UI-only change in
  this project's history — Phase A/B's own verification was live-browser,
  no Playwright suite exists for this artifact).

## Open questions for whoever builds this

- D1: should the identity popover persist per-chat client-side (so a reload
  keeps the picked role), or reset to defaults each session like the model
  picker does today? Plan above assumes the latter (simplest, consistent);
  flag if the user wants the former — it's a small addition (localStorage
  keyed by `chatId`, sent every turn) but changes the "no new persistence"
  framing slightly (still client-side only, so still no backend change).
- D2: confirm whether `GET .../overview` already returns enough per-claim
  detail to filter by `agentId` without a new route, or whether adding the
  narrow `GET /api/taskmaster/projects/:id/claims` route is needed — this
  wants a quick read of the overview handler in `server.js` before writing
  code, not assumed here.
