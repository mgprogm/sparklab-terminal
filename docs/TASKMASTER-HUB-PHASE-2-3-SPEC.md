# Task Master Hub — Phase 2 (agent-service tools) + Phase 3 (frontend artifact) spec

> Written by SA after Phase 0 (registry sidecar) + Phase 1 (gateway REST routes)
> landed on this branch, commit `5434cdc`. This spec is grounded in the actual
> committed code, not the paraphrase in `docs/TASKMASTER-HUB-PLAN.md` §4/§7 —
> every route path, status code, and response shape below was re-read directly
> from `apps/terminal-gateway/src/server.js`, `packages/shared-types/src/terminal.ts`,
> and `apps/terminal-gateway/test/taskmaster-endpoints.js`. Where this spec and
> the plan doc disagree in a small way, this spec wins (noted inline).
>
> Dev: build Phase 2 then Phase 3, in that order (tools before UI lets you
> smoke-test routes via the agent chat before writing HTML). QA will review
> against this file plus the plan doc's D1-D12/§1e.

---

## 0. Ground truth recap (read the actual code, not just this section)

Routes actually implemented in `handleTaskmaster` (`apps/terminal-gateway/src/server.js`,
~line 2940 on), confirmed by re-reading the route bodies:

| Route                                               | Method                                    | Success shape                                                                                                                      | Notable non-2xx                                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/taskmaster/projects`                          | GET                                       | `200 { projects: TaskMasterProject[] }`                                                                                            | —                                                                                                                                                                 |
| `/api/taskmaster/projects`                          | POST                                      | `201 TaskMasterProject`                                                                                                            | `400` no `.taskmaster/` at path, `400` bad/missing `serverId`/`path`                                                                                              |
| `/api/taskmaster/projects/:id`                      | DELETE                                    | `204` (no body)                                                                                                                    | `404` project not found                                                                                                                                           |
| `/api/taskmaster/projects/:id/tasks`                | GET                                       | `200 { tasks: TaskMasterTaskSummary[], metadata: object }` (D9 summary projection — no `details`/`testStrategy`)                   | `404` project, `502` unparseable CLI output                                                                                                                       |
| `/api/taskmaster/projects/:id/tasks/:taskId`        | GET                                       | `200 TaskMasterTask` (the task object directly, NOT wrapped in `{task}`)                                                           | `404` project OR task (`found:false`), `502`                                                                                                                      |
| `/api/taskmaster/projects/:id/next`                 | GET                                       | `200 TaskMasterNextResponse` (`{task, found, hasAnyTasks?}`, passthrough)                                                          | `404` project, `502`                                                                                                                                              |
| `/api/taskmaster/projects/:id/tasks/:taskId/status` | POST `{status}`                           | `200 TaskMasterTask` (re-fetched via `show`, full task object directly)                                                            | `400` bad status enum, `400` §1c failure (exit≠0 OR `updatedTasks` doesn't contain the id — **never trust bare `success`**), `404` project                        |
| `/api/taskmaster/projects/:id/tags`                 | GET                                       | `200 { currentTag: string }`                                                                                                       | `404` project (reads `.taskmaster/state.json` directly, D12 exception to D2)                                                                                      |
| `/api/taskmaster/projects/:id/tags/use`             | POST `{name}`                             | `200 { currentTag: string }`                                                                                                       | `400` missing name, `400` CLI exit≠0 (e.g. tag doesn't exist), `503` if `binaryMode !== "binary"`, `404` project                                                  |
| `/api/taskmaster/projects/:id/tasks`                | POST `{prompt, priority?, dependencies?}` | **`201 { tasks: TaskMasterTaskSummary[] }`** — the refreshed summary list, NOT the created task alone, NOT wrapped with `metadata` | `400` missing/blank prompt, `400` bad priority enum, `400` CLI exit≠0, `503` binaryMode gate, `404` project                                                       |
| `/api/taskmaster/projects/:id/tasks/:taskId`        | PATCH `{prompt}`                          | `200 TaskMasterTask` (full task object directly, re-fetched via `show`)                                                            | `400` missing/blank prompt, `400` CLI exit≠0, `503` binaryMode gate, `404` project                                                                                |
| `/api/taskmaster/projects/:id/tasks/:taskId/expand` | POST `{research?, num?}`                  | `200 TaskMasterTask` (full task object directly)                                                                                   | `400` CLI exit≠0, `503` binaryMode gate, `404` project                                                                                                            |
| `/api/taskmaster/projects/:id/dependencies`         | POST `{id, dependsOn}`                    | `200 TaskMasterTask` (full task object directly, re-fetched via `show`)                                                            | `400 {error, code:"dependency_cycle"}` when stderr matches `/circular dependency/i` (§1c), plain `400` for any other exit≠0, `503` binaryMode gate, `404` project |

Every route (except the two D12 tag routes, which are `binaryMode`-gated
separately) can also throw the shared coded errors caught at the bottom of
`handleTaskmaster` and mapped by `taskmasterErrorStatus`:
`taskmaster_unavailable` → **503**, `taskmaster_timeout` → **504** (body also
carries `code: "outcome_unknown"` for the legacy-family AI-mutation routes —
D11: the CLI may have already written state, caller must re-fetch, never
blindly retry), everything else uncoded → **400**.

`TaskMasterStatusSchema` values (exact, from `packages/shared-types/src/terminal.ts`
line ~1855): `pending | in-progress | done | deferred | cancelled | blocked | review`.
`TaskMasterPrioritySchema`: `low | medium | high`.

Auth/CSRF: identical to Kanban/PM/Notes — cookie or `isArtifactBearerAuthorized`
shared bearer, GET routes Origin-exempt, every POST/PATCH/DELETE gets the
Origin/CSRF guard.

---

## 1. Phase 2 — agent-service tools

Files to change (mirror the `pm_*`/`kanban_*` pattern exactly):

- `apps/agent-service/src/gateway-client.ts` — add a `// --- Task Master Hub ---`
  section near the PM section (~line 444) with one method per operation below.
- `apps/agent-service/src/tools.ts` — add:
  - 9 tool definitions to the `TOOLS` array (put them after the PM/Notes block,
    before the closing `];`), in a `// --- Task Master Hub ---` section.
  - the 5 write tool names to `WRITE_TOOLS` (line ~24).
  - the 3 one-time tool names to `ONE_TIME_TOOLS` (line ~91).
  - a `case` per tool in `describeCall()` (~line 1645).
  - a `case` per tool in `executeTool()`'s big switch (~line 2115 area, after
    the PM cases and before the Notes cases, or after Notes — placement
    doesn't matter, grouping does).
- `apps/agent-service/src/tools.test.ts` — extend per §1.4 below.
- `packages/shared-types` types are already exported (`TaskMaster*` block) —
  import what you need in both files from `@sparklab/shared-types`, same as
  the existing `import type { PmProject, ... } from "@sparklab/shared-types"`
  block at the top of `gateway-client.ts`.

### 1.1 Approval tiers (final — matches D7, do not deviate)

| Tool                        | In `WRITE_TOOLS`? | In `ONE_TIME_TOOLS`? | Tier                                                    |
| --------------------------- | ----------------- | -------------------- | ------------------------------------------------------- |
| `taskmaster_list_projects`  | no                | no                   | read, auto                                              |
| `taskmaster_list`           | no                | no                   | read, auto                                              |
| `taskmaster_show`           | no                | no                   | read, auto                                              |
| `taskmaster_next`           | no                | no                   | read, auto                                              |
| `taskmaster_set_status`     | **yes**           | no                   | write, allow-always (routine)                           |
| `taskmaster_add_dependency` | **yes**           | no                   | write, allow-always (routine)                           |
| `taskmaster_add_task`       | **yes**           | **yes**              | write, one-time (invokes task-master's own AI provider) |
| `taskmaster_update_task`    | **yes**           | **yes**              | write, one-time (same reasoning)                        |
| `taskmaster_expand`         | **yes**           | **yes**              | write, one-time (same reasoning)                        |

Add a comment block above the `WRITE_TOOLS`/`ONE_TIME_TOOLS` entries mirroring
the existing PM/Notes comments' style (explain _why_ the split is what it is),
e.g.:

```ts
// Task Master Hub writes (D7 in docs/TASKMASTER-HUB-PLAN.md). set_status and
// add_dependency are routine/low-blast-radius and may be allowed-always;
// add_task/update_task/expand additionally invoke task-master's own AI
// provider and can rewrite substantial task content — same risk class as
// run_codex, coerced one-time.
```

### 1.2 gateway-client.ts methods

Add these imports to the existing `import type {...} from "@sparklab/shared-types"`
block:

```ts
TaskMasterProject,
TaskMasterTaskSummary,
TaskMasterTask,
TaskMasterListTasksResponse,
TaskMasterNextResponse,
```

Methods (exact signatures — follow the existing `json<T>`/`call()` helpers;
do NOT reimplement fetch/auth/CSRF handling):

```ts
// --- Task Master Hub ------------------------------------------------------
// REST-client-only (D7): every one of these calls the gateway's
// /api/taskmaster/* routes. Never reads data/taskmaster-projects.json or a
// project's .taskmaster/ tree directly.

async listTaskmasterProjects(): Promise<TaskMasterProject[]> {
  const r = await this.json<{ projects: TaskMasterProject[] }>(
    await this.call("/api/taskmaster/projects"),
  );
  return r.projects;
}

async listTaskmasterTasks(projectId: string): Promise<TaskMasterListTasksResponse> {
  return this.json<TaskMasterListTasksResponse>(
    await this.call(`/api/taskmaster/projects/${encodeURIComponent(projectId)}/tasks`),
  );
}

async getTaskmasterTask(projectId: string, taskId: string): Promise<TaskMasterTask> {
  return this.json<TaskMasterTask>(
    await this.call(
      `/api/taskmaster/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    ),
  );
}

async getTaskmasterNext(projectId: string): Promise<TaskMasterNextResponse> {
  return this.json<TaskMasterNextResponse>(
    await this.call(`/api/taskmaster/projects/${encodeURIComponent(projectId)}/next`),
  );
}

async setTaskmasterStatus(
  projectId: string,
  taskId: string,
  status: string,
): Promise<TaskMasterTask> {
  return this.json<TaskMasterTask>(
    await this.call(
      `/api/taskmaster/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      },
    ),
  );
}

async addTaskmasterTask(
  projectId: string,
  body: { prompt: string; priority?: string; dependencies?: string[] },
): Promise<{ tasks: TaskMasterTaskSummary[] }> {
  return this.json<{ tasks: TaskMasterTaskSummary[] }>(
    await this.call(`/api/taskmaster/projects/${encodeURIComponent(projectId)}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async updateTaskmasterTask(
  projectId: string,
  taskId: string,
  body: { prompt: string },
): Promise<TaskMasterTask> {
  return this.json<TaskMasterTask>(
    await this.call(
      `/api/taskmaster/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

async expandTaskmasterTask(
  projectId: string,
  taskId: string,
  body: { research?: boolean; num?: number },
): Promise<TaskMasterTask> {
  return this.json<TaskMasterTask>(
    await this.call(
      `/api/taskmaster/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/expand`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

/**
 * add-dependency (legacy family) — the gateway returns 400 with
 * {error, code:"dependency_cycle"} specifically for the CLI's circular-
 * dependency rejection (§1c), distinct from any other 400. Special-cased
 * here (mirrors moveKanbanCard's 409-special-case pattern) so the tool
 * executor can surface "this would create a circular dependency" distinctly
 * instead of a generic gateway-error string.
 */
async addTaskmasterDependency(
  projectId: string,
  body: { id: string; dependsOn: string },
): Promise<
  | { cycle: false; task: TaskMasterTask }
  | { cycle: true; message: string }
> {
  const res = await this.call(
    `/api/taskmaster/projects/${encodeURIComponent(projectId)}/dependencies`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 400) {
    const b = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    if (b.code === "dependency_cycle") {
      return { cycle: true, message: b.error || "would create a circular dependency" };
    }
    throw new GatewayError(400, b.error || "bad request");
  }
  return { cycle: false, task: await this.json<TaskMasterTask>(res) };
}
```

Notes:

- `taskmaster_list_projects`/`_list`/`_show`/`_next` need no special-casing:
  the generic `json<T>` helper already throws `GatewayError(status, body.error)`
  on any non-2xx, and every gateway error body in the table above already has
  a human-readable `error` string (e.g. the exact 503 message is
  `"task-master CLI is not installed on this server (npx fallback does not
support this action, see TASKMASTER-HUB-PLAN.md §1e #5)"`). Do **not**
  add per-status branching for 404/503/504 beyond what `json<T>` already
  does — it would just duplicate the message the gateway already wrote.
  This satisfies the "clear task-master isn't installed" requirement for
  free.
- `setTaskmasterStatus`/`updateTaskmasterTask`/`expandTaskmasterTask` all
  return the **task object directly** — do not wrap in `{task: ...}`.
- `addTaskmasterTask` returns `{tasks: [...]}` (summary list) — the created
  task is NOT distinguishable from the rest of the list in this response;
  the executor should return the whole refreshed list so the model can find
  it (or note that a subsequent `taskmaster_list` call will show it).

### 1.3 Tool definitions (`tools.ts` — exact JSON schemas)

Add a comment header before the block: `// --- Task Master Hub -----------------------------------------------------`.

```ts
{
  type: "function",
  function: {
    name: "taskmaster_list_projects",
    description:
      "List all registered Task Master Hub projects (id, name, serverId, path, binaryMode). Read-only. Call this first to discover which projects exist before listing or mutating tasks in one.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_list",
    description:
      "List a project's tasks (summary: id, title, status, priority, dependencies, blocks, complexity, updatedAt — NOT the full details/testStrategy text). Read-only. Operates on the project's CURRENT tag only.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Task Master Hub project id (tmp-...)." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_show",
    description:
      "Get one task's full detail (title, status, details, testStrategy, subtasks). Read-only.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string", description: "Task id, e.g. \"3\" or \"3.2\" for a subtask." },
      },
      required: ["project_id", "task_id"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_next",
    description:
      "Get the next unblocked task to work on in a project's current tag. Read-only. The response distinguishes an empty tag (no tasks at all) from a tag whose tasks are all done/blocked — read hasAnyTasks alongside found.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_set_status",
    description:
      "Set a task's status. Requires user approval (routine — safe to allow-always).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in-progress", "done", "deferred", "cancelled", "blocked", "review"],
        },
      },
      required: ["project_id", "task_id", "status"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_add_dependency",
    description:
      "Make one task depend on another within the same project. Rejected with a circular-dependency error if it would create a cycle. Requires user approval (routine — safe to allow-always).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        id: { type: "string", description: "The task that will gain the dependency." },
        depends_on: { type: "string", description: "The task it will depend on." },
      },
      required: ["project_id", "id", "depends_on"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_add_task",
    description:
      "Add a new task by describing it in natural language — task-master's own AI provider expands the prompt into a structured task. This is an AI-mutation tool (same risk class as run_codex): it invokes the project's configured AI provider and can add substantial content. Requires user approval EVERY time (no allow-always).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Ids of existing tasks this new task depends on.",
        },
      },
      required: ["project_id", "prompt"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_update_task",
    description:
      "Rewrite/refine an existing task by describing the change in natural language — task-master's own AI provider applies it. AI-mutation tool, same risk class as run_codex. Requires user approval EVERY time (no allow-always).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
      },
      required: ["project_id", "task_id", "prompt"],
      additionalProperties: false,
    },
  },
},
{
  type: "function",
  function: {
    name: "taskmaster_expand",
    description:
      "Break a task into subtasks using task-master's own AI provider. Optional research mode uses a research-tier model where configured. AI-mutation tool, same risk class as run_codex. Requires user approval EVERY time (no allow-always).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        research: { type: "boolean", description: "Use task-master's research-tier model." },
        num: { type: "integer", minimum: 1, description: "Target subtask count; omit for the provider's default." },
      },
      required: ["project_id", "task_id"],
      additionalProperties: false,
    },
  },
},
```

`describeCall()` cases (style-matched to the existing `pm_*` one-liners):

```ts
case "taskmaster_list_projects":
  return "list Task Master Hub projects";
case "taskmaster_list":
  return `list tasks for project ${args.project_id ?? ""}`.trimEnd();
case "taskmaster_show":
  return `show task ${args.task_id ?? ""} in project ${args.project_id ?? ""}`.trimEnd();
case "taskmaster_next":
  return `get next task for project ${args.project_id ?? ""}`.trimEnd();
case "taskmaster_set_status":
  return `set task ${args.task_id ?? ""} to status ${args.status ?? ""}`.trimEnd();
case "taskmaster_add_dependency":
  return `make task ${args.id ?? ""} depend on ${args.depends_on ?? ""}`.trimEnd();
case "taskmaster_add_task":
  return `add task via AI prompt: ${truncate(String(args.prompt ?? ""))}`;
case "taskmaster_update_task":
  return `update task ${args.task_id ?? ""} via AI prompt: ${truncate(String(args.prompt ?? ""))}`;
case "taskmaster_expand":
  return `expand task ${args.task_id ?? ""}${args.research ? " (research)" : ""}${args.num ? ` into ~${args.num} subtasks` : ""}`.trimEnd();
```

`executeTool()` cases:

```ts
case "taskmaster_list_projects": {
  const projects = await gateway.listTaskmasterProjects();
  return JSON.stringify(projects);
}
case "taskmaster_list": {
  if (!args.project_id) return "error: project_id is required";
  const r = await gateway.listTaskmasterTasks(args.project_id);
  return JSON.stringify(r);
}
case "taskmaster_show": {
  if (!args.project_id || !args.task_id)
    return "error: project_id and task_id are required";
  const t = await gateway.getTaskmasterTask(args.project_id, args.task_id);
  return JSON.stringify(t);
}
case "taskmaster_next": {
  if (!args.project_id) return "error: project_id is required";
  const r = await gateway.getTaskmasterNext(args.project_id);
  return JSON.stringify(r);
}
case "taskmaster_set_status": {
  if (!args.project_id || !args.task_id || !args.status)
    return "error: project_id, task_id and status are required";
  const t = await gateway.setTaskmasterStatus(args.project_id, args.task_id, args.status);
  return JSON.stringify(t);
}
case "taskmaster_add_dependency": {
  if (!args.project_id || !args.id || !args.depends_on)
    return "error: project_id, id and depends_on are required";
  const r = await gateway.addTaskmasterDependency(args.project_id, {
    id: args.id,
    dependsOn: args.depends_on,
  });
  if (r.cycle) {
    return `error: this would create a circular dependency (${args.id} depends on ${args.depends_on}): ${r.message}`;
  }
  return JSON.stringify(r.task);
}
case "taskmaster_add_task": {
  if (!args.project_id || !args.prompt)
    return "error: project_id and prompt are required";
  const r = await gateway.addTaskmasterTask(args.project_id, {
    prompt: args.prompt,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.dependencies ? { dependencies: args.dependencies } : {}),
  });
  return JSON.stringify(r);
}
case "taskmaster_update_task": {
  if (!args.project_id || !args.task_id || !args.prompt)
    return "error: project_id, task_id and prompt are required";
  const t = await gateway.updateTaskmasterTask(args.project_id, args.task_id, {
    prompt: args.prompt,
  });
  return JSON.stringify(t);
}
case "taskmaster_expand": {
  if (!args.project_id || !args.task_id)
    return "error: project_id and task_id are required";
  const t = await gateway.expandTaskmasterTask(args.project_id, args.task_id, {
    ...(args.research === true ? { research: true } : {}),
    ...(Number.isInteger(args.num) ? { num: args.num } : {}),
  });
  return JSON.stringify(t);
}
```

The generic `catch (err)` at the bottom of `executeTool` (the existing
`if (err instanceof GatewayError) return \`error: gateway ${err.status}: ${err.message}\`;`)
handles every 404/503/504 case for all 9 tools with no further code — do not
add duplicate try/catch inside each case.

### 1.4 `tools.test.ts` additions

Extend the existing PM test block's pattern (`apps/agent-service/src/tools.test.ts`,
~line 446 `// ---- Project-management (PM) tools`). Add a new section
`// ---- Task Master Hub tools ----` after the PM block (or after Notes,
whichever is last — keep sections in file order of feature addition).

```ts
const TASKMASTER_READ_TOOLS = [
  "taskmaster_list_projects",
  "taskmaster_list",
  "taskmaster_show",
  "taskmaster_next",
];
const TASKMASTER_ROUTINE_WRITE_TOOLS = [
  "taskmaster_set_status",
  "taskmaster_add_dependency",
];
const TASKMASTER_ONE_TIME_WRITE_TOOLS = [
  "taskmaster_add_task",
  "taskmaster_update_task",
  "taskmaster_expand",
];
const TASKMASTER_TOOLS = [
  ...TASKMASTER_READ_TOOLS,
  ...TASKMASTER_ROUTINE_WRITE_TOOLS,
  ...TASKMASTER_ONE_TIME_WRITE_TOOLS,
];

test("all 9 Task Master Hub tools are exposed", () => {
  const names = toolNames();
  for (const t of TASKMASTER_TOOLS) {
    assert.ok(names.includes(t), `${t} missing from TOOLS`);
  }
});

test("every Task Master Hub tool has a closed parameters schema", () => {
  for (const name of TASKMASTER_TOOLS) {
    const tool = TOOLS.find((t) => t.function.name === name);
    assert.ok(tool, `${name} not found`);
    const params = tool.function.parameters as {
      type?: string;
      additionalProperties?: boolean;
    };
    assert.equal(params.type, "object", `${name} parameters not an object`);
    assert.equal(
      params.additionalProperties,
      false,
      `${name} must set additionalProperties:false`,
    );
  }
});

test("Task Master Hub reads are auto (NOT write tools)", () => {
  for (const t of TASKMASTER_READ_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), false, `${t} should NOT be a WRITE tool`);
    assert.equal(ONE_TIME_TOOLS.has(t), false, `${t} should NOT be one-time`);
  }
});

test("taskmaster_set_status and taskmaster_add_dependency are routine writes (allow-always ok)", () => {
  for (const t of TASKMASTER_ROUTINE_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
    assert.equal(ONE_TIME_TOOLS.has(t), false, `${t} should NOT be one-time`);
  }
});

test("taskmaster_add_task/update_task/expand are AI-mutation tools, coerced one-time (D7)", () => {
  for (const t of TASKMASTER_ONE_TIME_WRITE_TOOLS) {
    assert.equal(WRITE_TOOLS.has(t), true, `${t} should be a WRITE tool`);
    assert.equal(
      ONE_TIME_TOOLS.has(t),
      true,
      `${t} should be coerced one-time`,
    );
  }
});

test("taskmaster_list requires project_id (no gateway call when missing)", async () => {
  assert.equal(
    await executeTool("taskmaster_list", {}),
    "error: project_id is required",
  );
});

test("taskmaster_add_dependency requires project_id, id and depends_on", async () => {
  assert.equal(
    await executeTool("taskmaster_add_dependency", { project_id: "tmp-1" }),
    "error: project_id, id and depends_on are required",
  );
});
```

If the existing test file mocks `gateway` (check whether PM tests stub
`gateway.*` methods or just test the missing-argument short-circuit paths —
read the PM test block's imports/setup before deciding); if it does, add
matching mock entries for the new `gateway.listTaskmasterProjects` etc.
methods so a full-argument call path can also be asserted (at minimum, the
dependency-cycle branch: mock `addTaskmasterDependency` to resolve
`{cycle: true, message: "..."}` and assert `executeTool` returns a string
containing `"circular dependency"`).

---

## 2. Phase 3 — frontend artifact

### 2.1 Store slice (`apps/terminal/src/features/terminal/store.ts`)

Template — this is the exact PM equivalent (lines ~312-316 and ~509-510):

```ts
  /** Whether the Project management dialog is open. NOT persisted — like the
   * Kanban/file-explorer/settings modals, a persisted-open dialog would
   * flash on reload. */
  pmOpen: boolean;
  setPmOpen: (open: boolean) => void;
```

```ts
      pmOpen: false,
      setPmOpen: (open) => set({ pmOpen: open }),
```

Add, immediately after the `notesOpen`/`setNotesOpen` block (~line 333-334 /
518-519):

```ts
  /** Whether the Task Master Hub dialog is open. NOT persisted — like the
   * Kanban/PM/Agentic/Munder Difflin/Notes/file-explorer/settings modals, a
   * persisted-open dialog would flash on reload. */
  taskmasterHubOpen: boolean;
  setTaskmasterHubOpen: (open: boolean) => void;
```

```ts
      taskmasterHubOpen: false,
      setTaskmasterHubOpen: (open) => set({ taskmasterHubOpen: open }),
```

Do **not** add `taskmasterHubOpen` to the `partialize` object (~line 558) —
omission is what makes it ephemeral/persist-excluded, exactly like `pmOpen`/
`kanbanOpen`/`notesOpen` are already omitted there.

### 2.2 Header button + URL flag (`components/terminal-shell.tsx`)

**Icon collision check** — icons already imported/used in this file's header
row: `SquareKanban` (Kanban), `SquareGanttChart` (Project management), `Bot`
(Agentic AI Creator), `NotebookText` (Notes), `FolderTree` (Browse files),
`Globe2` (reopen browser view), `Monitor`, `ArrowLeftRight`, `Menu`.
`AppWindow` is imported only inside `munder-difflin-dialog.tsx` for that
dialog's own header — it is **not** used as a header-row button icon in
`terminal-shell.tsx` today (see note below). **Use `ListChecks`** (per the
plan) — it collides with nothing currently imported in this file.

> Discrepancy note for QA: `docs/TASKMASTER-HUB-PLAN.md` and the repo's
> CLAUDE.md memory both describe Munder Difflin as having "an always-enabled
> header button" in `terminal-shell.tsx`. Reading the actual file, only the
> `?munder-difflin` URL flag (`useUrlFlagSync`, line ~215) and the dialog
> mount (line ~810) exist — there is no header `<Button>` wired to
> `setMunderDifflinOpen` in the visible header-row block. This is a
> pre-existing discrepancy, NOT something to fix as part of this feature —
> flagging it only so Dev doesn't get confused looking for a 6th icon that
> isn't actually there, and so the "which icons are already used" audit above
> is trustworthy.

Add the import (alongside the existing lucide import block, ~line 32-42):

```ts
import {
  ArrowLeftRight,
  Bot,
  FolderTree,
  Globe2,
  ListChecks,
  Menu,
  Monitor,
  NotebookText,
  SquareGanttChart,
  SquareKanban,
} from "lucide-react";
```

Add the dialog import (alongside the other dialog imports, ~line 45-55,
alphabetical among them):

```ts
import { TaskmasterHubDialog } from "./taskmaster-hub-dialog";
```

Destructure the new store fields alongside the existing `pmOpen`/`setPmOpen`
etc. (~line 128-131):

```ts
    taskmasterHubOpen,
    setTaskmasterHubOpen,
```

Add the URL flag sync alongside the others (~line 210-216):

```ts
useUrlFlagSync("taskmaster", taskmasterHubOpen, setTaskmasterHubOpen);
```

Add the header button — always-enabled, matching the Kanban/PM/Agentic/Notes
buttons' exact structure (insert after the Notes `<Tooltip>` block, ~line
655, before the Munder Difflin comment):

```tsx
{
  /* Task Master Hub is gateway-global too — always enabled. */
}
<Tooltip>
  <TooltipTrigger asChild>
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label="Task Master Hub"
      onClick={() => setTaskmasterHubOpen(true)}
    >
      <ListChecks className="size-3.5" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>Task Master Hub</TooltipContent>
</Tooltip>;
```

Mount the dialog alongside the other dialogs near the bottom of the component
(next to `<PmDialog .../>`/`<NotesDialog .../>`):

```tsx
<TaskmasterHubDialog
  open={taskmasterHubOpen}
  onOpenChange={setTaskmasterHubOpen}
/>
```

### 2.3 `components/taskmaster-hub-dialog.tsx` (new)

Structural clone of `pm-dialog.tsx` — same sandbox string (D10/D11 lesson,
already baked into the plan and PM's own file):
`sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`. Size
`h-[85vh]`/`sm:max-w-6xl`, same as PM (no reason to deviate — Task Master
Hub's content, like PM's, is a task list/board + a detail panel, not a
near-fullscreen live view like Munder Difflin). Use the `ListChecks` icon in
the dialog header (matching PM's `SquareGanttChart` in its own header) and
point the iframe at `/taskmaster-hub/app.html`.

```tsx
"use client";

/**
 * TaskmasterHubDialog — thin host seam (mirrors PmDialog) for the pluggable
 * Task Master Hub artifact. The body is a single same-origin <iframe> at
 * /taskmaster-hub/app.html; all UI (project registry, task list/board,
 * detail panel) lives inside that self-contained document.
 *
 * sandbox="allow-scripts allow-same-origin allow-forms allow-modals" — see
 * pm-dialog.tsx's comment for why allow-forms/allow-modals are required
 * (D11 lesson from the PM tool: without them, the artifact's <form> submits
 * and window.confirm() dialogs are silently blocked).
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { ListChecks } from "lucide-react";

export function TaskmasterHubDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="border-border gap-1.5 border-b px-4 py-3 text-left">
          <div className="flex items-center gap-2">
            <ListChecks className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">
              Task Master Hub
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Dashboard over multiple claude-task-master projects. Every
            read/write shells out to the real task-master CLI.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src="/taskmaster-hub/app.html"
          title="Task Master Hub"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
```

### 2.4 `public/taskmaster-hub/app.html` (new)

Self-contained HTML/CSS/JS, zero external requests, structured exactly like
`public/pm/app.html`: one `<style>` block using the same CSS custom
properties (`--canvas`, `--canvas-soft`, `--hairline`, `--ink`, `--body`,
`--mute`, `--accent`, `--danger`, `--radius-*`, `--font` — copy the `:root`
block verbatim from `pm/app.html`'s `<style>`, add task-master-specific
status-color tokens, e.g. `--status-pending`, `--status-in-progress`,
`--status-done`, `--status-review`, `--status-other`, picking hues consistent
with the existing `--prio-*` tokens), an `api(method, path, body)` fetch
helper, `ApiError`, `showBanner`/`clearBanner`, `elem()` DOM helper, and the
same `textContent`-only convention. Copy `pm/app.html`'s `api()` function
verbatim except the base path: `fetch("/api/taskmaster" + path, opts)`.

**Do not build a second, unrelated design** — reuse PM's layout skeleton
(topbar + main content area + a slide-in/modal detail panel) and re-skin only
the domain-specific parts (status enum, task fields).

#### Top bar

- **Project switcher**: a `<select>` populated from `GET /api/taskmaster/projects`
  (`{projects: TaskMasterProject[]}`) — each option shows `project.name`
  (fallback to `project.path` if name is empty) plus a small badge/suffix
  when `project.binaryMode === "core-only-npx"` (e.g. "(read-only — no
  task-master binary on that server)") since every legacy-family action is
  unavailable for that project (503 from the gateway, D5) — grey out or
  visually mark those options rather than only discovering it after a failed
  action.
- **"Add project" form**: fields — `name` (optional text input), `serverId`
  (a `<select>` populated from `GET /api/servers`, which returns a **bare
  array** `ServerInfo[]`, NOT `{servers: [...]}` — read `apps/terminal/src/features/terminal/hooks/use-servers.ts`
  if unsure of the exact shape before wiring this; render `server.name`
  as the option label, `server.id` as the value, `local` is always present),
  `path` (text input, absolute path, placeholder like
  `/home/user/my-project`). Submits `POST /api/taskmaster/projects` with
  `{name, serverId, path}`. On success (`201`), refresh the project list and
  select the new project. On `400` (no `.taskmaster/` at that path, or bad
  input), show the inline error banner with the exact server message —
  `textContent` only.
- **Current-tag display + "switch tag" button**: once a project is selected,
  fetch `GET .../tags` (`{currentTag}`) and show it as a small label (e.g.
  "tag: master"). A "Switch tag" button opens a small inline form (name
  input) gated behind `window.confirm("Switch the active tag for this
project to \"<name>\"? This affects every tool (CLI, agent, this Hub)
using this project.")` per D12/§1b — this is shared mutable state, the
  confirm is load-bearing, not decorative. On confirm, `POST .../tags/use
{name}`; on success refresh the current-tag label AND the task list (a tag
  switch changes what `list`/`next` return); on `400` show the banner
  (e.g. "Tag doesn't exist"); on `503` show "task-master isn't installed on
  that server — tag switching isn't available."

#### Main view — task list, grouped by status

Fetch `GET .../tasks` → `{tasks: TaskMasterTaskSummary[], metadata}`. Group
into buckets, **not a forced 4-column Kanban** (per plan §5):

- `pending`
- `in-progress`
- `review`
- `done`
- **"Other"** (collapsed, filterable) — `deferred` + `cancelled` + `blocked`
  merged into one bucket with a small status chip per card so the original
  status is still visible; a toggle/filter control lets the user expand it
  or filter to just one of those three.

Each task card/row shows: `id`, `title`, a priority badge (`priority` may be
`null`/absent — render nothing rather than "null"), a dependency-count badge
(`dependencies.length`) and a "blocks N" badge (`blocks.length`) when
nonzero, and `complexity` when non-null. Click anywhere on the card to open
the detail panel.

**Polling (D9)**: while a project is selected and the dialog is open, poll
`GET .../tasks` every ~5000ms (`setInterval`/`setTimeout` loop — this is a
plain HTML doc, no TanStack Query available inside the iframe; mirror how
`pm/app.html` itself polls notifications — see `startNotifPolling()` around
line 2170 for the interval-management pattern to copy: clear on
project-switch and on dialog teardown). **Stop the poll when the dialog is
hidden/closed** — since the iframe stays mounted across close/reopen
(confirm this against how `pm-dialog.tsx`/`kanban-dialog.tsx` mount their
iframes — if the iframe unmounts on dialog close, polling naturally stops
with it; if it stays mounted like the file-explorer dialog, add a
`visibilitychange`/parent-`postMessage`-free approach: simplest is to check
`document.visibilityState` inside the poll tick and skip the fetch, or rely
on the iframe being torn down — verify empirically once built and note which
applies).

#### "Next task" tile

A small panel/card, refreshed alongside the main poll, calling `GET .../next`
→ `TaskMasterNextResponse` (`{task, found, hasAnyTasks?}`). **Two distinct
empty states, per §1d/D-whatever — do not collapse them into one "nothing to
do" message**:

- `found === true`: show the task's id/title with a "Set in-progress" quick
  action (calls `POST .../status {status:"in-progress"}`).
- `found === false && hasAnyTasks === false` (or `hasAnyTasks` absent/undefined):
  "This tag has no tasks yet." (genuinely empty tag)
- `found === false && hasAnyTasks === true`: "Every task is done or blocked —
  nothing is ready to start." (tasks exist, none are unblocked)

#### Detail panel

Opens on task click. **Always does a fresh `GET .../tasks/:taskId` fetch on
open** (D9 — the list route is summary-only, `details`/`testStrategy` are
only on `show`). While loading, show a lightweight loading state, not stale
summary data mislabeled as full detail.

Shows: title, status, full `details` (render as preformatted/monospace text
or basic line-broken text — do not attempt Markdown rendering, this artifact
has no bundler and PM's own precedent for its Markdown-shaped text fields is
plain preformatted display, not react-markdown), `testStrategy`, nested
`subtasks` (if present, list their id/title/status read-only — no subtask
CRUD in v1), and:

- **Status dropdown** — same 7-value enum, changing it calls
  `POST .../tasks/:taskId/status {status}`; on success, replace the detail
  panel's task with the response (already a full task) and refresh the list.
- **"Add dependency" mini-form** — one text input (`dependsOn` task id),
  submit calls `POST .../dependencies {id: <this task's id>, dependsOn}`.
  On `400` with `code === "dependency_cycle"` in the parsed body, show a
  **specific** banner ("This would create a circular dependency.") not the
  generic error text; on any other `400`, show the server's `error` text.
- **"Expand" button** with a research checkbox — calls
  `POST .../tasks/:taskId/expand {research}` (omit `research` key entirely
  when unchecked, matching the request schema's `.optional()`). On success,
  refresh the detail panel from the response (a full task) so newly-created
  subtasks appear immediately.
- **"Update via prompt" textarea + submit** — calls
  `PATCH .../tasks/:taskId {prompt}`. On success, replace the detail panel's
  task with the response.
- All three legacy-family actions above (add-dependency, expand, update via
  prompt) should be **disabled with an explanatory tooltip/inline note**
  when the selected project's `binaryMode !== "binary"` (mirrors the gateway
  giving `503` for these — better to grey the control than let the user hit
  a failed request every time). Status changes and the tag route stay
  enabled since `set-status` is core-family and the tag GET is a plain file
  read (only `tags/use` needs the same binaryMode gating as the legacy
  actions — see the route table in §0: `tags/use` is 503-gated on
  `binaryMode`, but `list`/`show`/`next`/`set-status` never are).

#### Error handling convention (applies everywhere in this file)

- Every non-2xx response renders an inline error banner (same DOM slot
  reused across actions, matching `pm/app.html`'s `showBanner`/`clearBanner`
  pattern) with the server's `error` string set via `.textContent`, **never**
  `.innerHTML` — this repo's established convention (see the "Safety" comment
  at the top of `pm/app.html`, line ~22) for any server-derived string,
  because the CLI's own stderr can end up in these messages (e.g. `add-task`
  failures bubble raw `capText()`-capped stderr) and must never be
  interpreted as HTML.
- A `504`/timeout response on `add_task`/`update_task`/`expand`/`add_dependency`
  carries `{code: "outcome_unknown"}` per D11 — surface this distinctly too:
  "Task Master may have already made this change — the request timed out
  before we could confirm. Refreshing the task list…" and then actually
  trigger an immediate re-fetch of the list/detail rather than leaving stale
  data on screen. Do **not** offer a "retry" button on this specific error —
  a retried AI mutation after a false timeout could duplicate content (D11's
  explicit warning).

#### Explicitly NOT in v1 (say so nowhere near ambiguous code, but do not build)

- No drag-and-drop (click-to-open only, no click-to-move-status-via-dropdown-
  on-the-card either — the status change lives in the detail panel).
- No real-time push/WebSocket — polling only (D9).
- No multi-tag view, no bulk operations, no cross-project dependency view
  (D6/§8 of the plan).
- No project deletion UI is required by this spec, but since
  `DELETE /api/taskmaster/projects/:id` already exists and is a pure
  registry-only removal (never touches the project's files), it's low-risk
  to add a small "Remove project" action (with a `window.confirm` — this is
  local-registry-only, not data-destructive, but still confirm since it's
  irreversible from the UI) next to the project switcher. Include it if time
  allows; not blocking QA sign-off if omitted (note it as a follow-up if
  skipped).

---

## 3. Testing expectations for Dev before handing to QA

- Run `pnpm --filter @sparklab/agent-service test` (or the project's exact
  test script name — check `package.json`) after the Phase 2 changes; the
  existing `tools.test.ts` suite plus your additions must pass.
- Run `pnpm --filter @sparklab/terminal-gateway test:taskmaster` — Phase 3
  makes no gateway changes, so this should be unaffected, but re-run it to
  confirm nothing was accidentally touched.
- Manually smoke-test the frontend artifact against a real gateway with a
  stubbed or real `task-master` binary (`TASKMASTER_COMMAND` env override if
  you don't have a real install handy) — register a project, list tasks, open
  a task, change its status, and confirm the polling loop stops when the
  dialog closes (watch Network tab request cadence).
- `pnpm typecheck` and `pnpm lint` across the touched workspaces before
  handing off.
