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

For implementation work, an in-app Agent Chat must:

1. Discover the project and inspect the task and its dependencies.
2. Claim the actionable task through `taskmaster_claim`.
3. Use implementation-capable terminal/Codex tools only while that claim is
   active.
4. Post progress or a non-empty blocker note through
   `taskmaster_update_progress`.
5. Move the Task Master task to review/done as appropriate, then release it.

The AgentLoop enforces step 2 for `run_command`, `type_text`, `press_keys`,
and `run_codex`. A claim is bound to the persisted Agent Chat identity
`chat-<chatId>`; model tool arguments never choose the owner identity.

Direct terminal sessions and external Claude Code/Codex CLI sessions are not
technically forced through Agent Chat. They must follow this same protocol via
the Hub API or Task Master CLI wrapper. An external integration should set its
real role and tool, for example `FE · frontend agent · Codex CLI` or
`SA · architecture agent · Claude Code`.

## Execution state versus Task Master state

Execution state is gateway sidecar metadata, never Task Master task content.
It records ownership, role, tool, progress note, and timestamps. Valid active
states are `working`, `blocked`, and `review`; blocked work requires a note.
Claims reject terminal tasks and tasks with incomplete dependencies. A task
set to `done`, `cancelled`, or `deferred` through the Hub releases its active
claim. Claims without a heartbeat/progress update expire after
`TASKMASTER_CLAIM_TTL_MS` (default 30 minutes; `0` disables expiry).

## Current limitations and roadmap

- Agent Chat records the identity `Developer · Agent Chat` by default, now
  overridable per deployment via `AGENT_CHAT_ROLE` / `AGENT_CHAT_NAME` /
  `AGENT_CHAT_TOOL` (Phase C). The `id` (`chat-<chatId>`) stays per-chat and
  is never model-settable. Per-_chat_ role selection in the UI and external
  CLI claim wrappers remain to be added.
- The preflight grant is held in the running AgentLoop; it is not yet durable
  across an agent-service restart.
- **Resolved (Phase C):** each execution record is now bound to the gateway
  auth channel that created it (`ownerChannel`, derived from `actorOf(req)`);
  `update`/`release` reject a caller on a different real channel with 403.
  This closes the "direct artifact API callers can provide arbitrary
  execution labels" hole for the scoped-bearer case. **Limitation:** the
  gateway authenticates one user and agent-service calls it with that same
  cookie, so `ownerChannel` separates bearer ↔ cookie but _not_ a human
  clicking in the Hub UI from Agent Chat — both are the same cookie channel.
  Pre-Phase-C records load with `ownerChannel: "legacy"`, which matches any
  channel so they are never locked out. `releaseForTask()` (task status →
  `done`/`cancelled`/`deferred`) intentionally has no owner check.
- **Resolved (UI v2 Phase A):** the Hub detail panel offers human
  claim / mark-working / mark-blocked / mark-review / release controls
  (`agentId: "human"`), plus relative-time / stale-claim styling on claim
  chips.
- Task Master dependencies are per project. Cross-project dependency views,
  bulk operations, real-time push, and saved filters remain post-v1 work.

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
