# Task Master Hub — Phase C implementation spec

> **Status: ready for implementation (2026-09-06).** Implements
> [`TASKMASTER-HUB-PHASE-C-PLAN.md`](./TASKMASTER-HUB-PHASE-C-PLAN.md)
> decisions without re-opening them. Dev may adjust line numbers and minor
> mechanics but **must not** change: the `ownerChannel`-not-`agentId` decision,
> the `"legacy"` wildcard semantics, or the env-only (never model-arg)
> identity rule.

---

## C1 — gateway `ownerChannel` binding

### 1. `apps/terminal-gateway/src/taskmaster-execution.js`

#### 1a. `claim()` signature change

| Position | Before      | After              |
| -------- | ----------- | ------------------ |
| 1        | `projectId` | `projectId`        |
| 2        | `taskId`    | `taskId`           |
| 3        | `agentId`   | `agentId`          |
| 4        | `agentName` | `agentName`        |
| 5        | `agentRole` | `agentRole`        |
| 6        | `agentTool` | `agentTool`        |
| 7        | _(none)_    | **`ownerChannel`** |

The record object literal (currently lines 87–98) gains one field:

```js
ownerChannel: ownerChannel || "legacy",
```

placed after `agentTool`. On a re-claim (the `existing` branch), the stored
`ownerChannel` is preserved — the new value is ignored:

```js
ownerChannel: existing?.ownerChannel || ownerChannel || "legacy",
```

#### 1b. `update()` and `release()` — signature and guard

Both gain an `ownerChannel` parameter as their **last** argument:

```
update(projectId, taskId, agentId, status, note, ownerChannel)
release(projectId, taskId, agentId, ownerChannel)
```

In both functions, immediately after the existing `agentId` mismatch check,
add the channel guard:

```js
if (
  x.ownerChannel !== "legacy" &&
  ownerChannel !== "legacy" &&
  x.ownerChannel !== ownerChannel
) {
  const e = new Error("owning auth channel does not match");
  e.code = "forbidden";
  throw e;
}
```

**`"legacy"` wildcard semantics** — the comparison rule:

| Stored `ownerChannel` | Incoming `ownerChannel` | Result                                    |
| --------------------- | ----------------------- | ----------------------------------------- |
| `"legacy"`            | any value               | **match** (wildcard on the stored side)   |
| any value             | `"legacy"`              | **match** (wildcard on the incoming side) |
| `"user:admin"`        | `"user:admin"`          | **match** (exact)                         |
| `"user:admin"`        | `"client:bearer"`       | **mismatch → 403**                        |
| `"client:mybot"`      | `"client:otherbot"`     | **mismatch → 403**                        |

`"legacy"` acts as a wildcard on **either** side: a stored `"legacy"` record
accepts any incoming channel, and a `"legacy"` incoming channel is accepted by
any stored value. This ensures that pre-existing records (backfilled as
`"legacy"` by `load()`) are never locked out, while every new claim gets a real
channel value and is thereafter locked.

Error on mismatch: `code: "forbidden"`, which the server.js error-to-HTTP
mapping already converts to HTTP **403**.

#### 1c. `releaseForTask()` and `expireStale()`

**No changes.** `releaseForTask()` intentionally has no owner check (anyone who
can move a Task Master task to a terminal status releases its claim — plan §2).
`expireStale()` operates on time, not ownership.

#### 1d. `load()` backfill

Inside the existing `load()` function, after the `if (!store.executions)`
guard, iterate all records and backfill:

```js
for (const x of Object.values(store.executions)) {
  if (!x.ownerChannel) x.ownerChannel = "legacy";
}
```

This is only-if-absent, matching the `pm.js` `migrate()` precedent.

### 2. `apps/terminal-gateway/src/server.js`

#### 2a. Claim route (POST `.../tasks/:taskId/claim`, ~line 3190)

Compute the channel before the `taskmasterExecution.claim()` call:

```js
const ownerChannel = actorOf(req);
```

Pass it as the 7th positional argument. The full call becomes:

```js
taskmasterExecution.claim(
  seg[1], // projectId
  seg[3], // taskId
  r.body.agentId.trim(), // agentId
  typeof r.body.agentName === "string"
    ? r.body.agentName.trim().slice(0, 120)
    : "", // agentName
  typeof r.body.agentRole === "string"
    ? r.body.agentRole.trim().slice(0, 60)
    : "", // agentRole
  typeof r.body.agentTool === "string"
    ? r.body.agentTool.trim().slice(0, 120)
    : "", // agentTool
  ownerChannel, // ownerChannel (NEW)
);
```

#### 2b. Execution route (PATCH/DELETE `.../tasks/:taskId/execution`, ~line 3248)

Compute the channel once, before the method branch:

```js
const ownerChannel = actorOf(req);
```

Pass it as the last argument to both calls:

- **PATCH**: `taskmasterExecution.update(seg[1], seg[3], r.body.agentId.trim(), r.body.status, ..., ownerChannel)` — the full positional list is `(projectId, taskId, agentId, status, note, ownerChannel)`.
- **DELETE**: `taskmasterExecution.release(seg[1], seg[3], r.body.agentId.trim(), ownerChannel)` — the full positional list is `(projectId, taskId, agentId, ownerChannel)`.

### 3. `packages/shared-types/src/terminal.ts`

There is currently **no** Zod schema for the Task Master execution record in
this file (execution records are plain JS objects from
`taskmaster-execution.js`). Add a new schema at the end of the `TaskMaster*`
block (after `AddTaskMasterDependencyRequestSchema`, before the file's closing
line), containing at minimum the `ownerChannel` field:

```ts
/** Gateway execution-record shape returned by the claim/update routes and
 *  the overview's `executions[]` array. Fields are gateway-set; the client
 *  never provides `ownerChannel`. */
export const TaskMasterExecutionRecordSchema = z
  .object({
    projectId: z.string(),
    taskId: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    agentRole: z.string(),
    agentTool: z.string(),
    status: z.string(),
    note: z.string(),
    claimedAt: z.number(),
    updatedAt: z.number(),
    /** Auth channel that created this claim. Gateway-set, read-only.
     *  `"legacy"` for records created before Phase C. */
    ownerChannel: z.string().optional(),
  })
  .passthrough();
export type TaskMasterExecutionRecord = z.infer<
  typeof TaskMasterExecutionRecordSchema
>;
```

`ownerChannel` is `.optional()` because pre-Phase-C JSON files on disk may not
have it (until the gateway loads and backfills in memory, the raw JSON lacks
the field). `.passthrough()` follows the block's existing tolerance posture.

**`index.ts` re-exports are untouched** — `packages/shared-types/src/index.ts`
already does `export * from "./terminal.js"`, so the new schema is
automatically re-exported.

### 4. Files that do NOT change

- `apps/terminal/public/taskmaster-hub/app.html` — the Hub UI sends `agentId`
  in request bodies as before; `ownerChannel` is gateway-derived, never
  client-supplied. The UI may optionally display `ownerChannel` from response
  payloads, but no change is required.
- `apps/agent-service/src/gateway-client.ts` — the gateway client sends the
  same claim/update/release bodies; `ownerChannel` is derived server-side from
  the auth cookie the gateway client already presents.

---

## C1 — test additions to `apps/terminal-gateway/test/taskmaster-endpoints.js`

### 5a. Spawn env addition

Add `GATEWAY_API_TOKEN` to the `startServer()` env block (line ~137) with a
sample value:

```js
GATEWAY_API_TOKEN: "test-tm-bearer-token-1234",
```

### 5b. `req()` extension

The current `req()` signature (line 186):

```js
async function req(method, pathname, { body, origin, headers } = {})
```

The signature stays the same. The existing `headers` pass-through already
supports arbitrary headers. Add a small **helper function** for bearer
requests that skips the cookie and sets the `Authorization` and optional
`X-PM-Actor` headers:

```js
async function bearerReq(method, pathname, { body, origin, actor } = {}) {
  const headers = {
    authorization: `Bearer test-tm-bearer-token-1234`,
  };
  if (actor) headers["x-pm-actor"] = actor;
  if (origin) headers["origin"] = origin;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  // No cookie — this simulates a pure bearer caller.
  return fetch(`${BASE}${pathname}`, { method, headers, body: payload });
}
```

This helper must NOT include `cookie` so it exercises the bearer auth path
where `actorOf()` returns `client:<actor>` or `client:bearer`.

### 5c. New assertion block

Add a new test block titled
`"execution ownerChannel binding — cross-channel rejection"` after the
existing `"execution claims + conflict guard + PM overview"` block. The four
cases:

#### Case 1: cookie-claim, then bearer-mutate → 403

A cookie-authed request claims a task (status 201). Then a bearer-authed
request sends a PATCH to the same task with the **same `agentId`** — must
return **403** because the stored `ownerChannel` is `user:<AUTH_USER>` but the
incoming channel is `client:bearer` (or `client:<actor>`).

```
Setup:  none (task 1 was released by the set-status done earlier; re-claim it)
Claim:  req("POST", `.../tasks/1/claim`, {body:{agentId:"owner-chan-a"}, origin})  → 201
Mutate: bearerReq("PATCH", `.../tasks/1/execution`,
          {body:{agentId:"owner-chan-a", status:"review"}, origin})                → 403
```

Assert: response status is 403. The body should contain `"forbidden"` or
`"channel"` in the error message.

#### Case 2: bearer actor A claim, then bearer actor B PATCH → 403

Two different bearer callers (different `X-PM-Actor` values) try to touch the
same execution.

```
Release: req("DELETE", `.../tasks/1/execution`,
           {body:{agentId:"owner-chan-a"}, origin})                               → 204
Claim:   bearerReq("POST", `.../tasks/1/claim`,
           {body:{agentId:"bearer-agent"}, origin, actor:"botA"})                 → 201
Mutate:  bearerReq("PATCH", `.../tasks/1/execution`,
           {body:{agentId:"bearer-agent", status:"review"}, origin, actor:"botB"}) → 403
```

Assert: the PATCH returns 403.

#### Case 3: same-channel happy path still 200/204

The same bearer actor that claimed can update and release.

```
Update:  bearerReq("PATCH", `.../tasks/1/execution`,
           {body:{agentId:"bearer-agent", status:"review"}, origin, actor:"botA"}) → 200
Release: bearerReq("DELETE", `.../tasks/1/execution`,
           {body:{agentId:"bearer-agent"}, origin, actor:"botA"})                  → 204
```

Assert: 200 and 204 respectively.

#### Case 4: legacy record (no `ownerChannel`) still updatable by same agentId

Seed a record **without** `ownerChannel` by writing the executions JSON file
directly before this sub-block. The file path is
`path.join(scratch, "taskmaster-executions.json")` (the same path passed via
`TASKMASTER_EXECUTIONS_FILE`). Write a minimal valid store:

```js
fs.writeFileSync(
  path.join(scratch, "taskmaster-executions.json"),
  JSON.stringify({
    executions: {
      [`${projectId}:1`]: {
        projectId,
        taskId: "1",
        agentId: "legacy-agent",
        agentName: "Legacy",
        agentRole: "Developer",
        agentTool: "Agent Chat",
        status: "working",
        note: "",
        claimedAt: Date.now(),
        updatedAt: Date.now(),
        // No ownerChannel — simulates a pre-Phase-C record.
      },
    },
    events: [],
  }),
);
```

Then **restart the gateway** (`server.kill("SIGTERM")`, wait for exit, call
`startServer()`, `login()`) so it re-`load()`s from disk and backfills
`ownerChannel: "legacy"`. After restart:

```
Update: bearerReq("PATCH", `.../tasks/1/execution`,
          {body:{agentId:"legacy-agent", status:"review"}, origin, actor:"anybot"}) → 200
```

Assert: returns 200, proving the `"legacy"` wildcard lets any channel through.

After the legacy test, clean up by releasing the execution so later tests
(if any) start clean.

### 5d. Open-mode trap note

These four assertions are only meaningful when `GATEWAY_AUTH_USER` and
`GATEWAY_AUTH_PASSWORD` are set, which the harness already does. The
`env -u GATEWAY_AUTH_USER -u GATEWAY_AUTH_PASSWORD -u GATEWAY_AUTH_PASSWORD_HASH`
prefix in the verification command (§8 below) strips leaked shell vars; it does
NOT put the gateway into open mode (the harness's own spawn env explicitly sets
them).

Print `console.log("  ok: execution ownerChannel binding — cross-channel
rejection + legacy wildcard");` after the block passes.

---

## C2 — config-driven Agent Chat identity

### 6a. `apps/agent-service/src/config.ts`

Add a new config block inside the `config` object literal, after the `codex`
block and before `port`. Match the file's existing style (`optional()` helper,
inline comment):

```ts
// Agent Chat identity labels sent with Task Master Hub execution claims.
// Customize to distinguish concurrent agents (e.g. "BE" / "backend agent").
// The `id` field (`chat-<chatId>`) is per-chat, not user-settable, and stays
// unforgeable — these labels are display-only.
agentChat: {
  identityRole: optional("AGENT_CHAT_ROLE", "Developer"),
  identityName: optional("AGENT_CHAT_NAME", "Agent Chat"),
  identityTool: optional("AGENT_CHAT_TOOL", "Agent Chat"),
},
```

### 6b. `apps/agent-service/src/agent-loop.ts`

Replace the hardcoded object literal at ~line 719–724:

**Before:**

```ts
const result = await executeTool(tool, args, signal, {
  id: `chat-${this.chatId}`,
  name: "Agent Chat",
  role: "Developer",
  tool: "Agent Chat",
});
```

**After:**

```ts
const result = await executeTool(tool, args, signal, {
  id: `chat-${this.chatId}`,
  name: config.agentChat.identityName,
  role: config.agentChat.identityRole,
  tool: config.agentChat.identityTool,
});
```

The `config` import already exists at the top of the file. `id` stays
`chat-${this.chatId}` — per-chat, not user-settable.

### 6c. `apps/agent-service/.env.example`

Add after the existing Codex CLI block (after the `CODEX_PROVIDER_MODE` line),
before any CUA/browser/handoff section:

```env
# Agent Chat identity labels for Task Master Hub execution claims. Default
# "Developer" / "Agent Chat" / "Agent Chat". Set these so the Hub overview can
# tell concurrent agents apart, e.g. AGENT_CHAT_ROLE=BE AGENT_CHAT_NAME="backend agent".
# AGENT_CHAT_ROLE=Developer
# AGENT_CHAT_NAME=Agent Chat
# AGENT_CHAT_TOOL=Agent Chat
```

### 6d. `apps/agent-service/src/agent-loop.test.ts`

Add **two** new tests at the end of the file. Use the file's existing
"set env then import" seam: environment variables are set at the module top
level (lines 4–6), then the module is dynamically imported. For tests that
need different env values, the pattern is to use `node:test`'s `test()` with
a fresh dynamic import.

However, since `config.ts` reads env at import time and is cached by the
module system, the simplest approach that matches the file's existing style
is to **test the config object directly** (import `config` and assert defaults)
and to **test with env set** by asserting the value through a separate `test()`
that reads the env vars the config would have consumed.

Recommended shape:

```ts
test("Agent Chat identity defaults match the hardcoded originals", async () => {
  // config is already imported (env was set at top of file with the required
  // Azure vars; AGENT_CHAT_* are unset → defaults).
  const { config } = await import("./config.js");
  assert.equal(config.agentChat.identityRole, "Developer");
  assert.equal(config.agentChat.identityName, "Agent Chat");
  assert.equal(config.agentChat.identityTool, "Agent Chat");
});

test("Agent Chat identity env overrides are respected", () => {
  // Since config.ts is already loaded and cached, verify the env-var plumbing
  // by checking that the optional() helper would produce the right value.
  // The real integration proof is: set the env vars, restart agent-service,
  // claim a task, and see the labels in the Hub overview.
  //
  // Alternatively, if the module cache is problematic, create a small
  // focused test file (e.g. agent-chat-identity.test.ts) that sets
  // AGENT_CHAT_ROLE/NAME/TOOL before the first import of config.ts.
  //
  // Minimum assertion: the config block exists and its keys are strings.
  const { config } = await import("./config.js");
  assert.equal(typeof config.agentChat.identityRole, "string");
  assert.equal(typeof config.agentChat.identityName, "string");
  assert.equal(typeof config.agentChat.identityTool, "string");
});
```

If the module-cache issue prevents testing the env override in the same file,
Dev should create a **separate** test file
`apps/agent-service/src/agent-chat-identity.test.ts` that sets the three env
vars **before** the first `import("./config.js")`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.AGENT_CHAT_ROLE = "BE";
process.env.AGENT_CHAT_NAME = "backend agent";
process.env.AGENT_CHAT_TOOL = "Codex CLI";

const { config } = await import("./config.js");

test("AGENT_CHAT_* env overrides produce the configured identity", () => {
  assert.equal(config.agentChat.identityRole, "BE");
  assert.equal(config.agentChat.identityName, "backend agent");
  assert.equal(config.agentChat.identityTool, "Codex CLI");
});
```

Either approach is acceptable; the key assertion is that the three env vars
flow through to the config object and that `agent-loop.ts` passes them (not
hardcoded strings) to `executeTool`.

---

## 7. Files confirmed unchanged

| File                                           | Why                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/terminal/public/taskmaster-hub/app.html` | Sends `agentId` as before; `ownerChannel` is gateway-derived                                                             |
| `apps/agent-service/src/gateway-client.ts`     | Sends cookie-authed requests; channel derived server-side                                                                |
| `apps/agent-service/src/tools.ts`              | `AgentIdentity` interface and `executeTool` default are untouched; the identity object is constructed in `agent-loop.ts` |
| `packages/shared-types/src/index.ts`           | Already re-exports `* from "./terminal.js"`                                                                              |

---

## 8. Verification commands

```bash
env -u GATEWAY_AUTH_USER -u GATEWAY_AUTH_PASSWORD -u GATEWAY_AUTH_PASSWORD_HASH \
  pnpm --filter @sparklab/terminal-gateway test:taskmaster
pnpm --filter @sparklab/agent-service typecheck
pnpm --filter @sparklab/agent-service test
pnpm --filter @sparklab/terminal typecheck
```

---

## 9. Docs to update on completion (coordinator, not Dev)

- `docs/TASKMASTER-HUB-OPERATIONS.md` — mark the credential-binding bullet
  resolved; note the intra-cookie limitation (plan §2).
- `docs/TASKMASTER-HUB-UI-V2-PLAN.md` — Phase C status → built.
- `docs/TASKMASTER-HUB-PHASE-C-PLAN.md` — status header → built, with
  deviations section.
