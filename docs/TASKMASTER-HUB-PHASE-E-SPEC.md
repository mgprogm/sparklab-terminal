# Task Master Hub Phase E — implementation spec

> **Status: built (2026-09-06), uncommitted.** Verified independently: all
> D3/D1/D2 automated test suites re-run and pass (`test:taskmaster` 14/14
> blocks, `agent-service test` 210/210, `agent-service`/`terminal` typecheck
> clean, `test:pm` 37/37 regression-clean for the shared `actorOf()` change).
> Every diff reviewed by hand against this spec. Two known gaps, not closed:
> the `execute()` → `resolveExecutionIdentity()` one-line wiring (D1) is
> reviewed by eye but not exercised by an automated end-to-end test, and D4's
> spec §4d manual-browser check was not performed (no safe isolated dev stack
> was available to test against without side effects on the host's live
> deployment). Implements
> [`TASKMASTER-HUB-PHASE-E-PLAN.md`](./TASKMASTER-HUB-PHASE-E-PLAN.md)
> without re-opening its decisions. Dev may adjust line numbers and minor
> mechanics but **must not** change: the per-turn (not `history.ts`-persisted)
> identity model, the derive-don't-persist claim-preflight design, the
> taskmaster-only header scoping (never the shared `call()`), or the
> client-only scope of D4.
>
> Build order: **D3 → D1 → D2 → D4** (independent; no shared code path forces
> this order, but this is the safest sequence to land and verify one at a
> time). All line numbers below were read live against the current tree on
> 2026-09-06 — re-verify if any prior D-set's implementation has already
> shifted them before starting the next.
>
> **Two corrections vs. the plan doc**, found while grounding this spec in
> the live code (both resolve the plan's own "open questions"):
>
> - **D2's open question is resolved: no new gateway route is needed.**
>   `GET /api/taskmaster/projects/:id/overview` (`server.js:3153-3186`)
>   already returns `{ counts, executions }` where `executions` is the exact,
>   unfiltered output of `taskmasterExecution.list(projectId)` — full records
>   including `agentId`. `gateway-client.ts`'s existing
>   `getTaskmasterOverview()` (line 492) already wraps this route. D2 is
>   therefore 100% agent-service-side; zero gateway/shared-types changes.
> - **D4's plan text is wrong about reusing rollup data for cross-project
>   search.** `state.rollup` entries (`app.html:1026-1034`) carry only
>   aggregate `counts` (ready/inProgress/blocked/done) — never task titles or
>   ids. A cross-project task search needs its **own** parallel fetch (one
>   `GET .../tasks` per registered project, mirroring `refreshRollup()`'s own
>   parallel-`GET .../overview` pattern), not a read of the rollup's existing
>   data. Spec section D4 below reflects this correction.

---

## D3 — separate the Hub-UI-human channel from Agent Chat

### 3a. `apps/terminal-gateway/src/server.js` — `actorOf()`

Current function (lines 353-365):

```js
function actorOf(req) {
  const cookies = parseCookies(req);
  if (validateAuthSession(cookies.gw_session))
    return `user:${GATEWAY_AUTH_USER || "local"}`;
  if (isArtifactBearerAuthorized(req)) {
    const raw = String(req.headers["x-pm-actor"] || "").trim();
    if (raw && raw.length <= 64 && /^[\w.@:-]+$/.test(raw))
      return `client:${raw}`;
    return "client:bearer";
  }
  // Open mode (loopback dev) or agent-over-cookie fallthrough.
  return `user:${GATEWAY_AUTH_USER || "local"}`;
}
```

Replace with a version that reads the header once and applies it to whichever
branch matches, extracting the validation into a tiny local helper so it is
defined exactly once:

```js
function validPmActor(req) {
  const raw = String(req.headers["x-pm-actor"] || "").trim();
  return raw && raw.length <= 64 && /^[\w.@:-]+$/.test(raw) ? raw : null;
}

function actorOf(req) {
  const cookies = parseCookies(req);
  if (validateAuthSession(cookies.gw_session)) {
    const base = `user:${GATEWAY_AUTH_USER || "local"}`;
    const actor = validPmActor(req);
    return actor ? `${base}:${actor}` : base;
  }
  if (isArtifactBearerAuthorized(req)) {
    const actor = validPmActor(req);
    return actor ? `client:${actor}` : "client:bearer";
  }
  // Open mode (loopback dev) or agent-over-cookie fallthrough.
  const base = `user:${GATEWAY_AUTH_USER || "local"}`;
  const actor = validPmActor(req);
  return actor ? `${base}:${actor}` : base;
}
```

**Do not change** any call site of `actorOf(req)` — every existing caller
(PM `reporter`, notification recipient, the claim/execution routes) keeps
working unchanged; this only makes its return value more specific when the
new header happens to be present. `app.html`'s and every other unmarked
cookie caller's requests are unaffected (they still get the bare
`user:<GATEWAY_AUTH_USER>`).

### 3b. `apps/agent-service/src/gateway-client.ts` — scoped header

Add a private wrapper immediately above the `// --- Task Master Hub` section
comment (currently line 451):

```ts
/**
 * Task Master Hub calls only. Adds x-pm-actor so the gateway's actorOf()
 * (server.js) can separate Agent Chat's cookie-authed calls from a human
 * clicking in the Hub UI, which sends no such header — both are otherwise
 * the same auth cookie (Phase E §D3). Deliberately NOT folded into the
 * shared call() used by fs/git/servers/PM/Kanban/Notes routes: this header
 * would also perturb their own actorOf()-derived reporter/notification
 * labels, which is out of scope here.
 */
private async taskmasterCall(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-pm-actor", "agent-chat");
  return this.call(path, { ...init, headers });
}
```

Then, **mechanically replace every `this.call(` with `this.taskmasterCall(`**
inside the Task Master Hub method block only — from `listTaskmasterProjects`
through `addTaskmasterDependency` (current lines 456-664). That is exactly
these 13 call sites, one per method: `listTaskmasterProjects` (458),
`listTaskmasterTasks` (468), `getTaskmasterTask` (479), `getTaskmasterNext`
(487), `getTaskmasterOverview` (495), `claimTaskmasterTask` (507),
`updateTaskmasterExecution` (531), `releaseTaskmasterExecution` (551),
`setTaskmasterStatus` (568), `addTaskmasterTask` (584),
`updateTaskmasterTask` (601), `expandTaskmasterTask` (618),
`addTaskmasterDependency` (643). **Do not touch `this.call(` anywhere else in
the file** (PM, Kanban, Notes, fs, git, servers, sessions, etc. all keep
calling the plain `this.call`).

A single coarse value (`"agent-chat"`, not per-chat) is correct here — see
plan §D3's rationale: cross-chat exclusivity already comes from `agentId`
differing per chat (`taskmaster-execution.js:90`'s first check), so the
channel only needs to separate "Agent Chat, any chat" from "a human in the
Hub UI."

### 3c. New test cases — `apps/terminal-gateway/test/taskmaster-endpoints.js`

Insert a new block immediately after the existing Phase C block (which ends
at line 560, `console.log("  ok: execution ownerChannel binding — ...")`),
before the `// GET next` block (line 562). Follow the exact
setup→action→assert style of the Phase C cases directly above it (read
lines 400-560 as your template — same file, same test run, same
`projectId`/`req()`/`bearerReq()` helpers already in scope). `req()` already
supports arbitrary extra headers via its existing `headers` option
(`taskmaster-endpoints.js:187-197`) — no helper changes needed, just pass
`headers: { "x-pm-actor": "agent-chat" }` on a cookie (`req`) call.

```js
// ===========================================================================
// D3: cookie-channel separation — Hub-UI-human vs. Agent-Chat-over-cookie
// ===========================================================================
{
  // Case 1: a human (plain cookie, no x-pm-actor) claims; a cookie request
  // WITH x-pm-actor: agent-chat tries to mutate the same agentId -> 403.
  const d3c1claim = await req(
    "POST",
    `/api/taskmaster/projects/${projectId}/tasks/1/claim`,
    { body: { agentId: "human-claim" }, origin: ALLOWED_ORIGIN },
  );
  assert(
    d3c1claim.status === 201,
    `d3 case1 claim -> ${d3c1claim.status}, expected 201`,
  );
  const d3c1patch = await req(
    "PATCH",
    `/api/taskmaster/projects/${projectId}/tasks/1/execution`,
    {
      body: { agentId: "human-claim", status: "review" },
      origin: ALLOWED_ORIGIN,
      headers: { "x-pm-actor": "agent-chat" },
    },
  );
  assert(
    d3c1patch.status === 403,
    `d3 case1 cookie+actor PATCH -> ${d3c1patch.status}, expected 403`,
  );

  // Case 2 (symmetric): a cookie+x-pm-actor:agent-chat claim cannot be
  // mutated by a plain cookie (no actor) request either.
  const d3c2rel = await req(
    "DELETE",
    `/api/taskmaster/projects/${projectId}/tasks/1/execution`,
    { body: { agentId: "human-claim" }, origin: ALLOWED_ORIGIN },
  );
  assert(
    d3c2rel.status === 204,
    `d3 case2 pre-release -> ${d3c2rel.status}, expected 204`,
  );
  const d3c2claim = await req(
    "POST",
    `/api/taskmaster/projects/${projectId}/tasks/1/claim`,
    {
      body: { agentId: "agent-chat-claim" },
      origin: ALLOWED_ORIGIN,
      headers: { "x-pm-actor": "agent-chat" },
    },
  );
  assert(
    d3c2claim.status === 201,
    `d3 case2 claim -> ${d3c2claim.status}, expected 201`,
  );
  const d3c2patch = await req(
    "PATCH",
    `/api/taskmaster/projects/${projectId}/tasks/1/execution`,
    {
      body: { agentId: "agent-chat-claim", status: "review" },
      origin: ALLOWED_ORIGIN,
    },
  );
  assert(
    d3c2patch.status === 403,
    `d3 case2 plain-cookie PATCH -> ${d3c2patch.status}, expected 403`,
  );

  // Case 3: same channel (cookie + x-pm-actor:agent-chat both times) still
  // works end to end.
  const d3c3patch = await req(
    "PATCH",
    `/api/taskmaster/projects/${projectId}/tasks/1/execution`,
    {
      body: { agentId: "agent-chat-claim", status: "review" },
      origin: ALLOWED_ORIGIN,
      headers: { "x-pm-actor": "agent-chat" },
    },
  );
  assert(
    d3c3patch.status === 200,
    `d3 case3 same-channel PATCH -> ${d3c3patch.status}, expected 200`,
  );
  const d3c3del = await req(
    "DELETE",
    `/api/taskmaster/projects/${projectId}/tasks/1/execution`,
    {
      body: { agentId: "agent-chat-claim" },
      origin: ALLOWED_ORIGIN,
      headers: { "x-pm-actor": "agent-chat" },
    },
  );
  assert(
    d3c3del.status === 204,
    `d3 case3 same-channel DELETE -> ${d3c3del.status}, expected 204`,
  );
}
console.log(
  "  ok: D3 cookie-channel separation — Hub-UI-human vs. Agent-Chat-over-cookie",
);
```

Leave task 1 released (case 3 already does this) so later blocks in the file
start clean, matching the Phase C block's own cleanup discipline.

### 3d. Files confirmed unchanged (D3)

| File                                               | Why                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/terminal/public/taskmaster-hub/app.html`     | Sends no `x-pm-actor`; keeps resolving to the bare `user:<name>` channel — this is the point |
| `packages/shared-types/*`                          | `x-pm-actor` is a raw header, not part of any request-body schema                            |
| `apps/agent-service/src/tools.ts`, `agent-loop.ts` | The header is added transport-side in `gateway-client.ts`, invisible to callers              |

### 3e. Verification

```bash
env -u GATEWAY_AUTH_USER -u GATEWAY_AUTH_PASSWORD -u GATEWAY_AUTH_PASSWORD_HASH \
  pnpm --filter @sparklab/terminal-gateway test:taskmaster
pnpm --filter @sparklab/agent-service typecheck
pnpm --filter @sparklab/agent-service test
```

---

## D1 — per-chat role/name/tool picker

### 1a. `packages/shared-types/src/agent.ts` — schema addition

`AgentUserMessageSchema` (lines 122-141). Add an `identity` field next to
`openrouterModelId`:

```ts
export const AgentUserMessageSchema = z.object({
  type: z.literal("user_message"),
  text: z.string(),
  activeSessionId: z.string().optional(),
  model: AgentModelSchema.optional(),
  reasoningEffort: AgentReasoningEffortSchema.optional(),
  openrouterModelId: z.string().min(1).max(200).optional(),
  /**
   * Per-turn override of the Task Master Hub claim identity labels
   * (`agentRole`/`agentName`/`agentTool`). Display/claim-label only — the
   * claim's `agentId` stays `chat-<chatId>`, server-derived, never
   * client-settable; the security boundary is the auth channel (D3), never
   * these strings. Omit to keep the deployment's `AGENT_CHAT_*` env
   * defaults for this turn.
   */
  identity: z
    .object({
      role: z.string().max(64),
      name: z.string().max(64),
      tool: z.string().max(64),
    })
    .optional(),
});
```

Also add the deployment defaults to `AgentCapabilitiesSchema` (lines
269-276) so the composer never starts its picker blank:

```ts
export const AgentCapabilitiesSchema = z.object({
  type: z.literal("agent_capabilities"),
  models: z.array(AgentModelSchema).min(1),
  reasoningEfforts: z.array(AgentReasoningEffortSchema).min(1),
  defaultModel: AgentModelSchema,
  defaultReasoningEffort: AgentReasoningEffortSchema,
  /** This deployment's AGENT_CHAT_ROLE/_NAME/_TOOL — the picker's defaults. */
  defaultIdentity: z.object({
    role: z.string(),
    name: z.string(),
    tool: z.string(),
  }),
});
```

### 1b. `apps/agent-service/src/index.ts` — thread the field through

`agent_capabilities` is sent from a block near line 300-310 (the same block
constructing `{ reasoningEfforts: [...] }` you found at line 305). Read that
block fully and add `defaultIdentity` there, sourced from `config.agentChat`:

```ts
defaultIdentity: {
  role: config.agentChat.identityRole,
  name: config.agentChat.identityName,
  tool: config.agentChat.identityTool,
},
```

In the `user_message` case (lines 152-159), pass the new field through as a
6th argument:

```ts
case "user_message":
  void run.handleUserMessage(
    msg.data.text,
    msg.data.activeSessionId,
    msg.data.model,
    msg.data.reasoningEffort,
    msg.data.openrouterModelId,
    msg.data.identity,
  );
  break;
```

### 1c. `apps/agent-service/src/agent-run-manager.ts` — pass-through

`AgentRun.handleUserMessage` (lines 109-124) is a thin wrapper. Add the
parameter and forward it, importing the identity shape from shared-types
(or inlining the same three-string-field object type — prefer importing
`AgentUserMessage["identity"]` via `type { AgentUserMessage } from
"@sparklab/shared-types"` if that's cleaner in this file's existing import
style):

```ts
async handleUserMessage(
  text: string,
  activeSessionId?: string,
  model?: AgentModel,
  reasoningEffort?: AgentReasoningEffort,
  openrouterModelId?: string,
  identity?: { role: string; name: string; tool: string },
): Promise<void> {
  await this.loop.handleUserMessage(
    text,
    activeSessionId,
    model,
    reasoningEffort,
    openrouterModelId,
    identity,
  );
  await this.flush();
}
```

### 1d. `apps/agent-service/src/agent-loop.ts` — per-turn override, no new field

`handleUserMessage` (lines 206-218) gains the same 6th parameter:

```ts
async handleUserMessage(
  text: string,
  activeSessionId?: string,
  model: AgentModel = DEFAULT_MODEL,
  reasoningEffort: AgentReasoningEffort = "medium",
  openrouterModelId?: string,
  identity?: { role: string; name: string; tool: string },
): Promise<void> {
```

Do **not** add a new `private pendingIdentity` class field. Both call sites
of `this.execute(...)` (lines 431 and 436) are inside this same method's
`while` loop, in scope of the `identity` parameter — pass it straight
through as a 4th argument to `execute()`:

```ts
resultContent = await this.execute(tc.name, args, signal, identity);
```

(both call sites, lines 431 and 436).

`execute()`'s signature (lines 611-615) gains the same parameter, and the
identity object construction at lines 719-724 uses it with the config
fallback:

```ts
private async execute(
  tool: string,
  args: ToolArgs,
  signal: AbortSignal,
  identity?: { role: string; name: string; tool: string },
): Promise<string> {
  try {
    ...
    const result = await executeTool(tool, args, signal, {
      id: `chat-${this.chatId}`,
      name: identity?.name || config.agentChat.identityName,
      role: identity?.role || config.agentChat.identityRole,
      tool: identity?.tool || config.agentChat.identityTool,
    });
```

`id` stays `chat-${this.chatId}` unconditionally — never influenced by the
per-turn `identity` argument. This is exactly the "per-turn override, no new
persistence" design from the plan: a fresh `AgentLoop.handleUserMessage`
call with no `identity` behaves byte-identical to today.

### 1e. Frontend: `connection.ts` → `use-agent-chat.ts` → `agent-chat-panel.tsx` → `composer.tsx`

**`apps/terminal/src/features/agent-chat/connection.ts`** — `sendUserMessage`
(lines 189-204) gains the field and includes it in the raw frame:

```ts
sendUserMessage(
  text: string,
  activeSessionId?: string,
  model?: AgentModel,
  reasoningEffort?: AgentReasoningEffort,
  openrouterModelId?: string,
  identity?: { role: string; name: string; tool: string },
): void {
  this.sendRaw({
    type: "user_message",
    text,
    activeSessionId,
    model,
    reasoningEffort,
    openrouterModelId,
    identity,
  });
}
```

**`apps/terminal/src/features/agent-chat/use-agent-chat.ts`** — the
`sendUserMessage` callback (lines 132-149) gains the same parameter and
forwards it to `conn.sendUserMessage`.

**`apps/terminal/src/features/agent-chat/store.ts`** — add three persisted
fields + setters, matching the existing `model`/`reasoningEffort` pattern
exactly (state declared ~line 100-105, defaults set ~line 213-224, included
in `partialize` at line 554-564):

```ts
// In the state interface, near model/reasoningEffort:
identityRole: string;
identityName: string;
identityTool: string;
setIdentity: (role: string, name: string, tool: string) => void;

// In the store body, near the model/reasoningEffort defaults:
identityRole: "",
identityName: "",
identityTool: "",
setIdentity: (identityRole, identityName, identityTool) =>
  set({ identityRole, identityName, identityTool }),
```

Empty-string defaults are deliberate: they mean "use this deployment's
`AGENT_CHAT_*` env default," populated from the incoming `agent_capabilities`
frame's new `defaultIdentity` the same way `model`/`reasoningEffort` are
clamped against `agent_capabilities` in the existing `ingest` case
(`store.ts:262-269` — read that block and mirror it: when
`identityRole`/`identityName`/`identityTool` are all empty, seed them from
`frame.defaultIdentity`; do not overwrite a value the user already picked).

Add all three to `partialize` (line 554-564), alongside `model`:

```ts
identityRole: s.identityRole,
identityName: s.identityName,
identityTool: s.identityTool,
```

This makes the picker persist across a reload — the same behavior
`model`/`reasoningEffort` already have, deliberately chosen over a
per-`chatId`-keyed scheme (simpler, and consistent with how the model picker
already works: one browser-wide "last picked" value, not remembered
per-conversation).

**`apps/terminal/src/features/agent-chat/components/agent-chat-panel.tsx`**
— `handleSend` (lines 141-160) reads the identity fields from the store (the
same place `openrouterModelId` is already read and conditionally attached)
and adds them to the `sendUserMessage` call:

```ts
const identityRole = useAgentStore((s) => s.identityRole);
const identityName = useAgentStore((s) => s.identityName);
const identityTool = useAgentStore((s) => s.identityTool);

const handleSend = (
  text: string,
  target?: string,
  model?: AgentModel,
  reasoningEffort?: AgentReasoningEffort,
) => {
  addUserMessage(text);
  sendUserMessage(
    text,
    target,
    model,
    reasoningEffort,
    model === "openrouter-gpt-latest"
      ? (openrouterModelId ?? undefined)
      : undefined,
    identityRole || identityName || identityTool
      ? { role: identityRole, name: identityName, tool: identityTool }
      : undefined,
  );
};
```

(Add the `useAgentStore` selector calls near the file's existing
`openrouterModelId` selector, whichever line that lands on after D1's store
changes.)

**`apps/terminal/src/features/agent-chat/components/composer.tsx`** — a
new dropdown, placed in the composer footer next to the existing model
picker (same footer row as the `SlidersHorizontal` trigger button at
lines 390-404). Use `packages/ui/src/components/ui/input.tsx`'s `Input`
component (confirmed present in this repo) for the three text fields — this
is free text, not an enumerable list, so it deliberately does **not** reuse
the model picker's `DropdownMenuItem` list pattern; it is closer to the
OpenRouter search box's plain `<input>` treatment already in this same file
(lines ~415-421) than to the model list itself.

```tsx
import {
  User as UserIcon, // pick any lucide icon distinct from SlidersHorizontal
} from "lucide-react";
// ...
const identityRole = useAgentStore((s) => s.identityRole);
const identityName = useAgentStore((s) => s.identityName);
const identityTool = useAgentStore((s) => s.identityTool);
const setIdentity = useAgentStore((s) => s.setIdentity);
const identityPlaceholder = useAgentStore((s) => s.defaultIdentity); // if
// agent_capabilities' defaultIdentity is mirrored into the store as its
// own field (recommended: add `defaultIdentity: {role,name,tool}` to the
// store alongside identityRole/etc, set from the `agent_capabilities`
// ingest case, NOT persisted — ephemeral, always the current deployment's
// configured default).
```

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <button
      type="button"
      disabled={working || disabled}
      aria-label="Set claim identity for Task Master Hub"
      className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 min-w-0 shrink items-center gap-1 rounded-sm px-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
    >
      <UserIcon className="size-3 shrink-0" />
      <span className="max-w-32 truncate">
        {identityRole || identityPlaceholder.role}
      </span>
      <ChevronDown className="size-3 shrink-0" />
    </button>
  </DropdownMenuTrigger>
  <DropdownMenuContent
    align="start"
    className="flex min-w-56 flex-col gap-1.5 p-2"
  >
    <DropdownMenuLabel>Task Master Hub claim identity</DropdownMenuLabel>
    <Input
      value={identityRole}
      placeholder={identityPlaceholder.role}
      onChange={(e) => setIdentity(e.target.value, identityName, identityTool)}
      onKeyDown={(e) => e.stopPropagation()}
    />
    <Input
      value={identityName}
      placeholder={identityPlaceholder.name}
      onChange={(e) => setIdentity(identityRole, e.target.value, identityTool)}
      onKeyDown={(e) => e.stopPropagation()}
    />
    <Input
      value={identityTool}
      placeholder={identityPlaceholder.tool}
      onChange={(e) => setIdentity(identityRole, identityName, e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  </DropdownMenuContent>
</DropdownMenu>
```

`onKeyDown={(e) => e.stopPropagation()}` on each `Input` mirrors the existing
OpenRouter search input (line ~417) — it stops the dropdown's own keyboard
navigation from eating keystrokes meant for the text field.

### 1f. Tests

- `apps/agent-service/src/agent-loop.test.ts`: add a case asserting that a
  `handleUserMessage(..., { role: "BE", name: "backend agent", tool: "Codex CLI" })`
  call results in `executeTool` being invoked with that identity (mock/spy
  `executeTool` if the file already has a seam for it — check the file's
  existing test setup for how it currently asserts tool-execution args) and a
  second case asserting the config defaults are used when `identity` is
  omitted.
- Frontend: no existing test harness covers `composer.tsx` interactively per
  the repo's own testing posture for this feature area (Kanban/PM/Notes/
  Taskmaster Hub UI changes are manual-browser-verified, not Playwright'd,
  per every prior Phase A/B/C update) — verify by hand: two different chats,
  two different picked identities, both visible as distinct claim chips in
  the Hub overview.

### 1g. Files confirmed unchanged (D1)

| File                                | Why                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/agent-service/src/history.ts` | Identity is per-turn wire state, never written to `<chatId>.meta.json` — that file is immutable by design (`flag: "wx"`, lines 93-96); adding a mutable field there would break its write-once invariant |
| `apps/terminal-gateway/*`           | Identity labels reach the gateway exactly as before, via the existing claim/execution route bodies — no gateway change                                                                                   |
| `apps/agent-service/src/tools.ts`   | `AgentIdentity` interface and `executeTool`'s default parameter are untouched; the per-turn override happens in `agent-loop.ts` only                                                                     |

### 1h. Verification

```bash
pnpm --filter @sparklab/agent-service typecheck
pnpm --filter @sparklab/agent-service test
pnpm --filter @sparklab/terminal typecheck
```

---

## D2 — durable claim preflight

No gateway or shared-types changes (see the correction at the top of this
document). Entirely `apps/agent-service`.

### 2a. `apps/agent-service/src/gateway-client.ts` — `findActiveClaim`

Add near the end of the Task Master Hub block (after `addTaskmasterDependency`,
before the `// --- Project management (PM)` comment, i.e. after the current
line 664):

```ts
/**
 * Best-effort reconstruction of an already-held claim after a fresh
 * AgentLoop is constructed (a genuinely new chat, or — the case this
 * exists for — an agent-service restart losing the in-memory preflight
 * gate). Queries every registered project's overview, which already
 * returns full execution records including agentId
 * (taskmasterExecution.list(), server.js:3169) — no new gateway route.
 * Bounded by the number of registered Hub projects; acceptable at Hub
 * scale (see Phase E plan §D2).
 */
async findActiveClaim(
  agentId: string,
): Promise<{ projectId: string; taskId: string } | null> {
  const projects = await this.listTaskmasterProjects();
  for (const project of projects) {
    let overview: { executions?: Array<{ projectId: string; taskId: string; agentId: string }> };
    try {
      overview = (await this.getTaskmasterOverview(project.id)) as typeof overview;
    } catch {
      continue; // an unreachable/misconfigured project must not block preflight
    }
    const match = overview.executions?.find((x) => x.agentId === agentId);
    if (match) return { projectId: match.projectId, taskId: match.taskId };
  }
  return null;
}
```

Use `this.taskmasterCall`-backed methods here (already true once D3 lands,
since `listTaskmasterProjects`/`getTaskmasterOverview` are inside the
converted block) — no extra change needed if D3 is built first per the
suggested order.

### 2b. `apps/agent-service/src/agent-loop.ts` — populate `activeTask` at construction

The constructor (lines 74-87) currently does:

```ts
constructor(
  private send: Send,
  chatId: string,
  private readonly terminalSessionId: string,
  private readonly handoffs: BrowserHandoffBroker,
  private readonly user: string,
) {
  this.chatId = chatId;
  this.browser = this.newBrowserRuntime();
  this.computer = this.newComputerRuntime();
  this.ready = loadChat(chatId).then((history) => {
    this.history = history;
  });
}
```

Change `this.ready` to also resolve the active claim, in parallel with
loading history, without letting a gateway failure block the chat from
opening:

```ts
this.ready = Promise.all([
  loadChat(chatId).then((history) => {
    this.history = history;
  }),
  gateway
    .findActiveClaim(`chat-${chatId}`)
    .then((claim) => {
      this.activeTask = claim;
    })
    .catch(() => {
      // Fails closed: activeTask stays null, so the preflight gate still
      // requires a fresh taskmaster_claim. Never fail open on a gateway
      // hiccup during construction.
    }),
]).then(() => undefined);
```

This runs exactly once per `AgentLoop` instance — i.e. once per chat per
agent-service process lifetime, since `AgentRunManager.open()`
(`agent-run-manager.ts:244-285`) caches `AgentRun`/`AgentLoop` in `this.runs`
for the process's lifetime and only constructs a fresh one when that map
has no entry (a genuinely new chat, or exactly the post-restart case this
D-set targets). It is not re-run on every WS reconnect for an already-open
chat.

### 2c. Tests

`apps/agent-service/src/agent-loop.test.ts` (or a focused new file if the
existing one doesn't already stub `gateway`): construct an `AgentLoop` with
`gateway.findActiveClaim` mocked to resolve
`{ projectId: "p1", taskId: "5" }`, then assert that the very first call to
an implementation tool (`run_command` et al.) is **not** rejected with the
"Task Master preflight required" error — proving `activeTask` was populated
before any turn ran. A second case with `findActiveClaim` mocked to resolve
`null` (or reject) asserts the existing rejection still fires unchanged.

### 2d. Files confirmed unchanged (D2)

| File                      | Why                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/terminal-gateway/*` | No new route; existing overview route already exposes everything needed                  |
| `packages/shared-types/*` | No new schema; the overview response shape is already whatever the gateway returns today |

### 2e. Verification

```bash
pnpm --filter @sparklab/agent-service typecheck
pnpm --filter @sparklab/agent-service test
```

Live check (manual, matches the plan's own verification bar): claim a task
via Agent Chat, kill and restart the `agent-service` process, send another
message in the same chat, confirm no re-claim is demanded; open a second,
different chat and confirm it is still blocked until it claims.

---

## D4 — saved filters + cross-project task search

Entirely `apps/terminal/public/taskmaster-hub/app.html`. No backend, no
shared-types change. Match the file's existing conventions exactly: plain
DOM (`document.getElementById`, the `elem(tag, className, text)` helper at
line 889), `state.*`-keyed redraw functions, no framework.

### 4a. Saved filter presets

- New `localStorage` key: `"taskmasterHub.savedFilters"` — a JSON array of
  `{ name: string, query: string }`.
- New state: `state.savedFilters` (loaded once at startup from
  `localStorage`, wrapped in try/catch — corrupt/missing data means `[]`,
  never a thrown error).
- New DOM: a small `<select id="filter-presets">` + `<button id="save-filter">`
  placed immediately after the existing `#task-filter` input
  (`app.html:666-672`), inside the same `.topbar` div. Selecting a preset
  sets `el.taskFilter.value` and `state.taskFilter` and re-renders (reuse the
  existing input handler at lines 2153-2154 by calling it, or factor its body
  into a small `applyTaskFilter(value)` function called from both the input
  listener and the preset-select listener). Clicking "Save filter" prompts
  for a name (a plain `window.prompt`, consistent with this file's existing
  `window.confirm`-based delete confirmations elsewhere) and appends
  `{ name, query: state.taskFilter }` to `state.savedFilters`, persisting to
  `localStorage` and re-rendering the `<select>` options.

### 4b. Cross-project task search

This is **not** a filter over the existing rollup strip (see the correction
at the top of this document — rollup entries carry no task-level data). Add
a sibling panel:

- New DOM: a text input + button (e.g. `#cross-search-input` /
  `#cross-search-btn`) placed near the existing rollup panel
  (`#rollup-panel`, line 741), and a results container
  `#cross-search-results` (hidden until a search runs), styled like
  `.rollup-strip`/`.rollup-row` (reuse those classes rather than inventing
  new CSS — same visual language).
- New state: `state.crossSearchQuery`, `state.crossSearchResults` (array of
  `{ projectId, projectName, taskId, title }`), `state.crossSearchRunning`.
- New function `async function runCrossProjectSearch()`, modeled directly on
  `refreshRollup()` (lines 1023-1052): guard on `state.crossSearchRunning`,
  fire `Promise.all(state.projects.map(project => api("GET",
projectPath(project.id) + "/tasks")...))` in parallel (the same
  `listTaskmasterTasks`-equivalent route the rollup already proves reachable
  via `api()`), filter each project's returned tasks client-side against
  `state.crossSearchQuery` (case-insensitive substring on `id` and `title`,
  same predicate already used by the existing per-project filter at
  `app.html:1491-1494`), and accumulate matches tagged with
  `projectId`/`projectName` into `state.crossSearchResults`. Render each
  match as a row; clicking one calls the existing `selectProject(entry.id,
false)` (already used by rollup rows, line 1018) followed by setting
  `state.taskFilter` to the matched task's id so the destination project view
  opens already filtered to it.
- No new backend calls beyond the existing per-project `GET .../tasks` route
  the Hub already uses elsewhere (`app.html`'s existing task-list fetch path
  for the main board) — reuse `api()`, do not add a new endpoint.

### 4c. Files confirmed unchanged (D4)

| File                      | Why                                                       |
| ------------------------- | --------------------------------------------------------- |
| `apps/terminal-gateway/*` | No new routes; reuses existing `/tasks` and `/overview`   |
| `packages/shared-types/*` | No schema change; this is a client-only, best-effort read |
| `apps/agent-service/*`    | Not involved — Hub UI-only feature                        |

### 4d. Verification

Manual browser check only, matching this artifact's established
verification posture for every prior UI-only change (Phase A/B's own
verification was live-browser via the `dev-browser` skill, no Playwright
suite exists for this artifact): create 2+ registered projects with
distinguishable tasks, run a cross-project search matching a task in only
one, confirm the single correct result and click-through; save a filter
preset, reload the page, confirm it's still offered and reapplies correctly.

---

## Docs to update on completion (coordinator, not Dev)

- `docs/TASKMASTER-HUB-OPERATIONS.md` — mark all four roadmap bullets
  resolved (per-chat identity, durable preflight, channel separation, saved
  filters/search), updating the "Current limitations and roadmap" section.
- `docs/TASKMASTER-HUB-PHASE-E-PLAN.md` — status header → built, with a
  deviations section noting the two corrections above (no new D2 route; D4's
  search is a new fetch, not a rollup-data reuse).
- `docs/TASKMASTER-HUB-UI-V2-PLAN.md` — note D1/D4 as UI-side additions if
  that document's own status table references outstanding UI gaps.
