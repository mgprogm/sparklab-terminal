# Task Master Hub — operations and agent coordination

Task Master Hub is the shared PM surface for registered `claude-task-master`
projects. Task Master remains authoritative for tasks, task status, tags, and
same-project dependencies. The gateway invokes the real `task-master` CLI; it
does not edit `.taskmaster/tasks/tasks.json`.

## What is implemented

- The Terminal header opens a sandboxed Task Master Hub artifact at
  `/taskmaster-hub/app.html`.
- Projects can be registered by `{serverId, absolute path}` and the Hub lists
  tasks, detail, next work, current tag, dependencies, and status.
- The Hub adds, updates, expands, and links tasks through the real CLI when a
  binary is available.
- Agent Chat exposes Task Master read/write tools and has an execution layer:
  task claim, progress (`working`, `blocked`, `review`), release, conflict
  rejection, and stale-claim expiry (30 minutes by default).
- The overview shows totals for ready/in-progress/blocked/done work, active
  agents, and claims. A claimed task displays `role · agent name · tool ·
execution status`.

## Agent work protocol

Any agent — the in-app Agent Chat, or a Claude Code / Codex CLI / OpenCode /
Pi session at a terminal — working an implementation task must:

1. Discover the project and inspect the task and its dependencies.
2. Claim the actionable task (Agent Chat: `taskmaster_claim`; a terminal CLI:
   `POST /api/taskmaster/projects/:id/tasks/:taskId/claim`, or the
   `taskmaster-ai` MCP tool where the CLI exposes one).
3. Use implementation-capable tools only while that claim is active.
4. Post progress or a non-empty blocker note (`taskmaster_update_progress`
   / `PATCH .../execution`).
5. Move the Task Master task to review/done as appropriate, then release it
   (`DELETE .../execution`; reaching `done` via the status route releases it
   automatically).

Only the in-app Agent Chat is _technically forced_ through step 2: its
AgentLoop blocks `run_command`, `type_text`, `press_keys`, and `run_codex`
until a claim exists, and the claim is bound to the identity
`chat-<chatId>` (overridable label only — see "role-specific identity" in the
roadmap; model tool arguments never choose the owner). Terminal CLI sessions
are on their honour to follow the same five steps.

## Multiple agent tools on one backlog

Several agent tools can work the same Task Master project concurrently. The
coordination layer is the gateway execution sidecar, not any one CLI:

- **One shared entry point.** `AGENTS.md` §"Task Master Hub workflow" (repo
  root) is read by Claude Code, Codex, OpenCode, and Pi alike, so every tool
  picks up the claim-first rule without per-tool wiring.
- **Each tool identifies itself** when it claims. Set `agentId` to something
  stable and unique per worker, and `agentRole` / `agentName` / `agentTool`
  to human-readable labels — e.g. `FE · frontend agent · OpenCode`,
  `BE · backend agent · Pi`, `SA · architecture agent · Claude Code`. The
  overview panel and card chips show `role · name · tool · status` so a human
  can see who holds what.
- **Claims are exclusive and time-boxed.** A second claim on a held task
  returns **409**; a claim on a task with unmet dependencies or a terminal
  status also **409**s. A claim with no progress update for
  `TASKMASTER_CLAIM_TTL_MS` (default 30 min) auto-expires and is then free
  for any tool to take.
- **Cross-tool mutation is auth-channel-bound.** A claim records the gateway
  auth channel that created it (`ownerChannel`). `update`/`release` from a
  _different real channel_ (a scoped-bearer caller vs. the cookie-auth Hub
  UI, or a different `X-PM-Actor`) return **403**. Records created before
  this check carry `ownerChannel: "legacy"` and stay open to any channel.
  Bearer callers separate via `X-PM-Actor`; cookie-auth callers separate the
  same way since Phase E — Agent Chat sends `x-pm-actor: agent-chat` on its
  Task Master calls, so the cookie-auth Hub UI (no such header) and the
  cookie-auth Agent Chat are two distinct channels, not one shared channel.
- **How each tool reaches the backlog** — see
  [`TASKMASTER-AGENT-SETUP.md`](./TASKMASTER-AGENT-SETUP.md): MCP where the
  CLI supports it (interactive Claude Code, OpenCode), the Hub REST API or
  the `task-master` CLI otherwise (Pi, `codex exec`, the in-app `run_codex`).
- **Handoff** is just release + re-claim: finish your slice, move the task to
  `review`, release; the next tool claims it for the follow-up.

## Execution state versus Task Master state

Execution state is gateway sidecar metadata, never Task Master task content.
It records ownership, role, tool, progress note, and timestamps. Valid active
states are `working`, `blocked`, and `review`; blocked work requires a note.
Claims reject terminal tasks and tasks with incomplete dependencies. A task
set to `done`, `cancelled`, or `deferred` through the Hub releases its active
claim. Claims without a heartbeat/progress update expire after
`TASKMASTER_CLAIM_TTL_MS` (default 30 minutes; `0` disables expiry).

## Current limitations and roadmap

- **Resolved (Phase E):** Agent Chat identity can now be set per chat from
  the composer's identity picker (role/name/tool), sent per-turn — not
  persisted server-side, resets to the deployment's `AGENT_CHAT_*` defaults
  each session, same posture as the model picker. Env vars still set the
  deployment-wide default the picker starts from. The `id` (`chat-<chatId>`)
  stays per-chat and is never model- or client-settable.
- **Resolved (Phase E):** the Hub MCP (`docs/TASKMASTER-HUB-MCP-PLAN.md`)
  gives external CLIs (Claude Code, OpenCode) a claim wrapper via
  `taskmaster_hub_*` tools; Pi and `codex exec` use the REST API directly
  (`TASKMASTER-AGENT-SETUP.md`).
- **Resolved (Phase E):** the claim preflight (`AgentLoop.activeTask`) is now
  reconstructed from the gateway's execution sidecar on construction
  (`gateway.findActiveClaim()`), rather than trusted from in-memory state
  alone — an agent-service restart no longer loses in-progress claim
  context. Fails closed (requires a fresh `taskmaster_claim`) if the gateway
  is unreachable during reconstruction.
- **Resolved (Phase C):** each execution record is now bound to the gateway
  auth channel that created it (`ownerChannel`, derived from `actorOf(req)`);
  `update`/`release` reject a caller on a different real channel with 403.
  This closes the "direct artifact API callers can provide arbitrary
  execution labels" hole for the scoped-bearer case. Pre-Phase-C records
  load with `ownerChannel: "legacy"`, which matches any channel so they are
  never locked out. Two paths transfer ownership without a channel check,
  both by design: `releaseForTask()` (task status →
  `done`/`cancelled`/`deferred`) and TTL expiry (an `expired` claim leaves
  the active set, so the next `claim` starts fresh and any channel may take
  it).
- **Resolved (Phase E):** the gateway `actorOf()` channel derivation now
  honors `x-pm-actor` on cookie-authed calls too (previously bearer-only),
  and agent-service's Task Master calls send `x-pm-actor: agent-chat`. A
  human clicking in the Hub UI and Agent Chat now resolve to different real
  channels (`user:<name>` vs. `user:<name>:agent-chat`) even though both are
  cookie-authed, closing the one gap Phase C's own note called out. Scoped
  to Task Master calls only (a dedicated `taskmasterCall()` wrapper in
  `gateway-client.ts`), so PM/Kanban/Notes `reporter`/notification-actor
  labels are unaffected.
- **Resolved (UI v2 Phase A):** the Hub detail panel offers human
  claim / mark-working / mark-blocked / mark-review / release controls
  (`agentId: "human"`), plus relative-time / stale-claim styling on claim
  chips.
- **Resolved (Phase E):** saved filter presets (`localStorage`) and a
  cross-project task search (parallel per-project task fetch, client-side
  match) are in the Hub UI. Bulk status-change (Phase B) and the
  cross-project rollup strip (Phase B) were already shipped separately.
- Task Master dependencies remain strictly per project by design — there is
  no cross-project dependency edge, and the search above is a filter over
  independently-fetched project task lists, not a graph. Real-time push
  remains unimplemented.
- **Changed (post-Phase-E UI polish, 2026-09-06):** the board's background
  `setInterval(refreshProjectData, 5000)` poll was removed in favor of an
  explicit **Refresh** button — the Hub UI is now manual-refresh-only
  everywhere (main board, rollup strip, cross-project search all share this
  pattern). Selecting a project or switching tag still triggers one
  immediate load; only the periodic background re-fetch is gone. The Add
  task and Project-rollup-and-search panels are also now collapsible
  (disclosure toggle, `localStorage`-persisted, collapsed by default) to
  save vertical space.
- Full design + as-built deviations: `docs/TASKMASTER-HUB-PHASE-E-PLAN.md` +
  `docs/TASKMASTER-HUB-PHASE-E-SPEC.md`.

## Verification

Run focused checks while developing:

```bash
pnpm --filter @sparklab/agent-service typecheck
pnpm --filter @sparklab/agent-service test
pnpm --filter @sparklab/terminal-gateway test:taskmaster
pnpm --filter @sparklab/terminal typecheck
```

For production frontend changes, use `./build-prod.sh`, restart the affected
PM2 processes through `ecosystem.config.cjs`, and verify the local and public
page chunks match. See `docs/LOCAL-PROD.md`.
