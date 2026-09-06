# Task Master Hub — Phase C plan (identity & credential binding)

> Status: **built and verified (2026-09-06), uncommitted → committed with this
> doc.** Implemented via an SA (`TASKMASTER-HUB-PHASE-C-SPEC.md`) →
> Developer (Codex CLI) pipeline. All four §6 verification commands green:
> `test:taskmaster` PASS (new `ok: execution ownerChannel binding` line),
> `@sparklab/agent-service` typecheck clean + 206/206 tests, `@sparklab/terminal`
> typecheck clean. Deviations: none material — see §8. Extends
> [`TASKMASTER-HUB-UI-V2-PLAN.md`](./TASKMASTER-HUB-UI-V2-PLAN.md) §4 "Phase C"
> (which deliberately deferred the design) and resolves two bullets from
> [`TASKMASTER-HUB-OPERATIONS.md`](./TASKMASTER-HUB-OPERATIONS.md) "Current
> limitations and roadmap". Phases A and B shipped (`2820b16..dd373fb`,
> committed on `main`, unpushed as of this writing).

## 1. What Phase C closes

From the operations-doc roadmap, in priority order:

- **C1 — credential-to-owner binding (security).** The claim/execution routes
  (`POST .../tasks/:taskId/claim`, `PATCH`/`DELETE .../tasks/:taskId/execution`)
  trust a fully client-supplied `agentId`. A scoped-bearer caller
  (`GATEWAY_API_TOKEN`/`KANBAN_API_TOKEN`) can therefore claim as any
  `agentId`, and — worse — send `PATCH`/`DELETE` with another agent's
  `agentId` and take over or release a claim it does not own. The gateway
  must bind an execution record to the **auth channel** that created it and
  reject cross-channel mutation.
- **C2 — role-specific Agent Chat identity.** `agent-loop.ts` hardcodes the
  claim identity to `Developer · Agent Chat`. Make the role/name/tool
  labels configurable so a deployment can run Agent Chat as, e.g.,
  `BE · backend agent · Agent Chat` and the Hub overview can tell concurrent
  agents apart.

## 2. Constraint that bounds the design (verified in source)

`actorOf(req)` (server.js:353) derives an advisory actor string from the auth
channel: `user:<GATEWAY_AUTH_USER>` for a cookie session, `client:<X-PM-Actor>`
(validated `^[\w.@:-]{1,64}$`) or `client:bearer` for a scoped-bearer request.
`/api/taskmaster/*` is in the bearer-authorized route set (server.js:6782).

The gateway authenticates a single user. **agent-service calls the gateway
with its own cookie under the same `GATEWAY_AUTH_USER`**, so channel binding
can separate **bearer ↔ cookie**, but it _cannot_ separate "human clicking in
the Hub UI" from "Agent Chat" — both are the same cookie. That is acceptable:
the roadmap bullet is specifically about _direct artifact API callers_
(the bearer case), and channel binding closes exactly that. The ops-doc
update must not overclaim intra-cookie separation.

Note also: `releaseForTask()` (the task-status → `done`/`cancelled`/`deferred`
path, server.js:3509) intentionally has **no owner check** — anyone able to
move a Task Master task to a terminal status releases its claim. Pre-existing,
left as-is, documented so it is not later mistaken for a regression.

## 3. Design

### C1 — `ownerChannel` on the execution record (gateway only)

Add a new **gateway-derived** field rather than reshaping `agentId`. This
keeps the blast radius to `taskmaster-execution.js` + two routes; `app.html`
and `gateway-client.ts` keep sending the same `agentId` and do not change.

- **`src/taskmaster-execution.js`**
  - `claim(projectId, taskId, agentId, agentName, agentRole, agentTool, ownerChannel)`
    — persist `ownerChannel` on the record.
  - Owner guard in `claim` (re-claim), `update`, `release`: require
    `agentId` match **and** `ownerChannel` match. A mismatch throws
    `code:"forbidden"` (→ 403), same as the existing wrong-`agentId` case.
  - `load()` backfill: a record without `ownerChannel` gets
    `ownerChannel:"legacy"` (only-if-absent, matching `pm.js migrate()`
    precedent). `"legacy"` compares equal to any channel so pre-existing
    claims are never locked out; every new claim gets a real channel.
  - `releaseForTask()` unchanged (see §2).
- **`src/server.js`** — claim route (~3195) and execution route (~3248):
  compute `const ownerChannel = actorOf(req);` and pass it through. No new
  helper needed.
- **`packages/shared-types/src/terminal.ts`** — add `ownerChannel: z.string()`
  (optional, documented gateway-set/read-only) to the execution record
  schema in the `TaskMaster*` block; re-export unchanged.
- **`apps/terminal-gateway/test/taskmaster-endpoints.js`** — the harness
  already runs the gateway auth-enabled and captures a cookie. Add
  `GATEWAY_API_TOKEN` to the spawn env so the bearer path is exercisable,
  then add checks:
  1. cookie-claim, then bearer `PATCH`/`DELETE` with the same `agentId` →
     **403** (cross-channel mutation blocked).
  2. bearer-claim (actor A via `X-PM-Actor`), then bearer `PATCH` as actor B →
     **403**.
  3. same-channel happy paths still return 200/204.
  4. a record with no `ownerChannel` in the executions file still
     accepts a same-`agentId` update (legacy backfill).
  - **Trap:** in _open_ mode `actorOf()` returns `user:...` for every request
    regardless of cookie/bearer, so these cases only mean something against
    an auth-mode (or token-configured) gateway. Keep them in the existing
    auth-enabled harness; do not add an open-mode variant that would pass
    vacuously. Run with `env -u GATEWAY_AUTH_USER -u GATEWAY_AUTH_PASSWORD
-u GATEWAY_AUTH_PASSWORD_HASH` per the `gateway-test-auth-env-leak` note.

### C2 — config-driven Agent Chat identity (agent-service only)

- **`apps/agent-service/src/config.ts`** — new optional block, e.g.
  `agentChat: { identityRole: process.env.AGENT_CHAT_ROLE || "Developer",
identityName: process.env.AGENT_CHAT_NAME || "Agent Chat",
identityTool: process.env.AGENT_CHAT_TOOL || "Agent Chat" }`.
- **`apps/agent-service/src/agent-loop.ts`** (~719-724) — replace the object
  literal with the config values. `id` stays `chat-${this.chatId}`
  (per-chat, not user-settable, unforgeable). **Invariant preserved:** the
  identity still never comes from model tool arguments — env only.
- **`apps/agent-service/.env.example`** — document the three vars.
- **Tests** — extend `agent-loop.test.ts` (or add a small focused test): with
  the env vars set, the `AgentIdentity` handed to `executeTool` carries the
  overridden role/name/tool; with them unset, the current defaults.
- **No frontend change.** A per-chat composer role picker is a separate UX
  decision, explicitly out of scope here (see §5).

## 4. Docs to update on completion

- `docs/TASKMASTER-HUB-OPERATIONS.md` — "Current limitations and roadmap":
  mark the credential-binding bullet resolved; note the intra-cookie
  limitation from §2; keep the "role-specific orchestration / external CLI
  claim wrappers" and "durable preflight grant" bullets open.
- `docs/TASKMASTER-HUB-UI-V2-PLAN.md` — Phase C status → built.
- This doc — status header → built, with a deviations section.

## 5. Explicitly deferred (not Phase C)

- **External CLI claim wrapper** — a `hook-notify.sh`-style script letting a
  direct `claude`/`codex` terminal session claim/progress/release via the
  Hub API with its real role/tool. Fully separable; add later if the manual
  protocol proves insufficient.
- **Durable preflight grant** — `AgentLoop.activeTask` is in-memory and lost
  on an agent-service restart. Independent concern, own change.
- **Composer role picker** — per-chat role selection in the Agent Chat UI,
  plus the per-chat settings channel to agent-service it would need.

## 6. Verification

```bash
env -u GATEWAY_AUTH_USER -u GATEWAY_AUTH_PASSWORD -u GATEWAY_AUTH_PASSWORD_HASH \
  pnpm --filter @sparklab/terminal-gateway test:taskmaster
pnpm --filter @sparklab/agent-service typecheck
pnpm --filter @sparklab/agent-service test
pnpm --filter @sparklab/terminal typecheck
```

Plus a manual dev-browser pass only if any Hub UI behavior around the
claimed-by chip changes (it should not — C1 is transparent to the client).

## 7. Build pipeline

SA wrote `docs/TASKMASTER-HUB-PHASE-C-SPEC.md` (acceptance-criteria-level,
per-file). Developer (Codex CLI) implemented C1 then C2 against that spec.
Coordinator ran the §6 verification, updated the docs, and committed.

## 8. Deviations from plan (as built)

- **No pre-existing execution-record Zod schema.** The plan said "add
  `ownerChannel` to the execution record schema"; none existed. Dev created
  `TaskMasterExecutionRecordSchema` (`.passthrough()`,
  `ownerChannel: z.string().optional()`) at the end of the `TaskMaster*`
  block. Nothing imports it yet — it documents the shape for future
  consumers.
- **`"legacy"` wildcard is symmetric.** SA resolved an ambiguity: a stored
  `"legacy"` matches any incoming channel _and_ an incoming `"legacy"`
  matches any stored channel. Guard is
  `x.ownerChannel !== "legacy" && ownerChannel !== "legacy" && x.ownerChannel !== ownerChannel`.
- **Re-claim preserves the original `ownerChannel`**
  (`existing?.ownerChannel || ownerChannel || "legacy"`) so a second claim
  from a different channel cannot launder ownership.
- **C2 identity test is a separate file**
  (`apps/agent-service/src/agent-chat-identity.test.ts`) that sets the env
  vars before the first `config.js` import, sidestepping the module cache;
  `agent-loop.test.ts` covers the defaults path.
- Test block placed immediately after the existing "execution claims"
  block; it opens by releasing that block's lingering `agent-a` claim on
  task 1.
