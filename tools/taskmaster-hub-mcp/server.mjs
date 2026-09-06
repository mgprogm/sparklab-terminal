#!/usr/bin/env node
// Task Master Hub MCP server — a dependency-free Model Context Protocol
// (stdio) server that exposes the gateway's /api/taskmaster/* routes as MCP
// tools, so an MCP-capable client (Claude Code, OpenCode, …) can onboard its
// own project into a running Task Master Hub and then coordinate work through
// the claim layer. A near-copy of tools/notes-mcp/server.mjs.
//
// This is NOT task-master-ai's own MCP: it is a thin REST client of the Hub
// gateway. Every call hits the gateway with a scoped bearer (never a cookie),
// so the gateway stays the single enforcement point. Design + decisions:
// docs/TASKMASTER-HUB-MCP-PLAN.md.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per
// line). No SDK — initialize / tools/list / tools/call / ping only.
//
// Config (env):
//   TASKMASTER_HUB_API_TOKEN  scoped artifact bearer (falls back to GATEWAY_API_TOKEN)
//   TASKMASTER_HUB_BASE_URL    gateway/proxy base (default http://127.0.0.1:3107)
//   TASKMASTER_HUB_ACTOR       per-worker identity -> sent as the `x-pm-actor`
//                              header so this worker gets its own ownerChannel
//                              (Phase C). MUST match ^[\w.@:-]{1,64}$ or the
//                              gateway silently downgrades it to client:bearer;
//                              this server refuses to start on an invalid value.
//   TASKMASTER_HUB_SERVER_ID   server to register a project on (default "local")
//   TASKMASTER_HUB_ROLE/NAME/TOOL   claim display labels
//                              (default Developer / MCP agent / Task Master Hub MCP)
//   TASKMASTER_HUB_AGENT_ID    claim agentId (default: the actor value, else "mcp")
//
// Register with Claude Code / OpenCode: see README.md.

const BASE = (
  process.env.TASKMASTER_HUB_BASE_URL || "http://127.0.0.1:3107"
).replace(/\/+$/, "");
const TOKEN =
  process.env.TASKMASTER_HUB_API_TOKEN || process.env.GATEWAY_API_TOKEN || "";
const ACTOR = (process.env.TASKMASTER_HUB_ACTOR || "").trim();
const SERVER_ID = (process.env.TASKMASTER_HUB_SERVER_ID || "local").trim();
const ROLE = process.env.TASKMASTER_HUB_ROLE || "Developer";
const NAME = process.env.TASKMASTER_HUB_NAME || "MCP agent";
const TOOL = process.env.TASKMASTER_HUB_TOOL || "Task Master Hub MCP";
const AGENT_ID = (process.env.TASKMASTER_HUB_AGENT_ID || ACTOR || "mcp").trim();
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "taskmaster-hub", version: "1.0.0" };

// Fail loudly on a set-but-invalid actor rather than silently sharing a
// channel with every other misconfigured bearer caller (PLAN §2).
if (ACTOR && !/^[\w.@:-]{1,64}$/.test(ACTOR)) {
  process.stderr.write(
    `[taskmaster-hub-mcp] FATAL: TASKMASTER_HUB_ACTOR="${ACTOR}" is invalid ` +
      `(must match ^[\\w.@:-]{1,64}$). The gateway would silently downgrade ` +
      `it to client:bearer, defeating per-worker claim isolation. Fix it or ` +
      `unset it.\n`,
  );
  process.exit(1);
}

const CLAIM_PROTOCOL =
  "1. Inspect the task and its dependencies. " +
  "2. taskmaster_hub_claim the actionable task. " +
  "3. Do implementation work only while the claim is active. " +
  "4. taskmaster_hub_update_progress (working/blocked/review; blocked needs a note). " +
  "5. taskmaster_hub_set_status to review/done, then taskmaster_hub_release " +
  "(done/cancelled/deferred auto-release).";

function agentsMdSnippet(projectId) {
  return (
    "## Task Master Hub\n\n" +
    `This project is registered with a Task Master Hub (project id \`${projectId}\`).\n` +
    "Before implementation work: claim the task via `taskmaster_hub_claim`, post\n" +
    "progress or a blocker, and release it (or set it done) when finished. A\n" +
    "claim is exclusive (409 if held), TTL-expiring (~30 min without a progress\n" +
    "update), and bound to this worker's auth channel (403 on a cross-channel\n" +
    "mutation). Do not edit `.taskmaster/tasks/tasks.json` directly.\n"
  );
}

// ---- REST helper --------------------------------------------------------
async function api(method, path, body) {
  if (!TOKEN)
    throw new Error(
      "TASKMASTER_HUB_API_TOKEN (or GATEWAY_API_TOKEN) is not set for the MCP server",
    );
  const headers = { authorization: `Bearer ${TOKEN}` };
  if (ACTOR) headers["x-pm-actor"] = ACTOR;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/taskmaster${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, ok: res.ok, json };
}

function must(res, action) {
  if (!res.ok) {
    const msg = (res.json && res.json.error) || `HTTP ${res.status}`;
    const code = res.json && res.json.code ? ` [${res.json.code}]` : "";
    throw new Error(`${action} failed: ${msg}${code}`);
  }
  return res.json;
}

const P = (id) => `/projects/${encodeURIComponent(id)}`;
const T = (id, taskId) =>
  `${P(id)}/tasks/${encodeURIComponent(String(taskId))}`;

// ---- Tool implementations ---------------------------------------------
const IMPL = {
  async taskmaster_hub_init({ path, server_id, name }) {
    const projectPath =
      typeof path === "string" && path.trim() ? path.trim() : process.cwd();
    const serverId =
      typeof server_id === "string" && server_id.trim()
        ? server_id.trim()
        : SERVER_ID;
    const cwdReported = !path;

    // Idempotency: return an existing registration for the same {serverId,path}.
    const existing = must(
      await api("GET", "/projects"),
      "list projects",
    ).projects.find((p) => p.serverId === serverId && p.path === projectPath);

    let project = existing;
    if (!project) {
      project = must(
        await api("POST", "/projects", {
          path: projectPath,
          serverId,
          ...(name ? { name } : {}),
        }),
        "register project",
      );
    }

    let currentTag = null;
    try {
      currentTag = must(
        await api("GET", `${P(project.id)}/tags`),
        "tags",
      ).currentTag;
    } catch {
      /* non-fatal */
    }

    return {
      project,
      alreadyRegistered: Boolean(existing),
      pathWasCwd: cwdReported,
      binaryMode: project.binaryMode,
      currentTag,
      identity: {
        agentId: AGENT_ID,
        role: ROLE,
        name: NAME,
        tool: TOOL,
        channel: ACTOR ? `client:${ACTOR}` : "client:bearer",
      },
      protocol: CLAIM_PROTOCOL,
      agentsMdSnippet: agentsMdSnippet(project.id),
    };
  },

  async taskmaster_hub_list_projects() {
    return must(await api("GET", "/projects"), "list projects");
  },
  async taskmaster_hub_overview({ project_id }) {
    req1(project_id, "project_id");
    return must(await api("GET", `${P(project_id)}/overview`), "overview");
  },
  async taskmaster_hub_list_tasks({ project_id }) {
    req1(project_id, "project_id");
    return must(await api("GET", `${P(project_id)}/tasks`), "list tasks");
  },
  async taskmaster_hub_get_task({ project_id, task_id }) {
    req2(project_id, task_id);
    return must(await api("GET", T(project_id, task_id)), "get task");
  },
  async taskmaster_hub_next({ project_id }) {
    req1(project_id, "project_id");
    return must(await api("GET", `${P(project_id)}/next`), "next task");
  },

  async taskmaster_hub_claim({ project_id, task_id }) {
    req2(project_id, task_id);
    return must(
      await api("POST", `${T(project_id, task_id)}/claim`, {
        agentId: AGENT_ID,
        agentName: NAME,
        agentRole: ROLE,
        agentTool: TOOL,
      }),
      "claim task",
    );
  },
  async taskmaster_hub_update_progress({ project_id, task_id, status, note }) {
    req2(project_id, task_id);
    if (!["working", "blocked", "review"].includes(status))
      throw new Error("status must be one of working, blocked, review");
    if (status === "blocked" && !(typeof note === "string" && note.trim()))
      throw new Error("a non-empty note is required for status 'blocked'");
    const body = { agentId: AGENT_ID, status };
    if (note !== undefined) body.note = note;
    return must(
      await api("PATCH", `${T(project_id, task_id)}/execution`, body),
      "update progress",
    );
  },
  async taskmaster_hub_release({ project_id, task_id }) {
    req2(project_id, task_id);
    const res = await api("DELETE", `${T(project_id, task_id)}/execution`, {
      agentId: AGENT_ID,
    });
    if (!res.ok) must(res, "release task");
    return { released: String(task_id) };
  },

  async taskmaster_hub_set_status({ project_id, task_id, status }) {
    req2(project_id, task_id);
    if (typeof status !== "string" || !status.trim())
      throw new Error("status is required");
    return must(
      await api("POST", `${T(project_id, task_id)}/status`, { status }),
      "set status",
    );
  },

  async taskmaster_hub_add_task({ project_id, prompt, priority }) {
    req1(project_id, "project_id");
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("prompt is required");
    const body = { prompt: prompt.trim() };
    if (priority !== undefined) body.priority = priority;
    return must(await api("POST", `${P(project_id)}/tasks`, body), "add task");
  },
  async taskmaster_hub_update_task({ project_id, task_id, prompt }) {
    req2(project_id, task_id);
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("prompt is required");
    return must(
      await api("PATCH", T(project_id, task_id), { prompt: prompt.trim() }),
      "update task",
    );
  },
  async taskmaster_hub_add_dependency({ project_id, id, depends_on }) {
    req1(project_id, "project_id");
    if (!id || !depends_on) throw new Error("id and depends_on are required");
    return must(
      await api("POST", `${P(project_id)}/dependencies`, {
        id: String(id),
        dependsOn: String(depends_on),
      }),
      "add dependency",
    );
  },
  async taskmaster_hub_expand({ project_id, task_id, num, research }) {
    req2(project_id, task_id);
    const body = {};
    if (Number.isInteger(num) && num > 0) body.num = num;
    if (research === true) body.research = true;
    return must(
      await api("POST", `${T(project_id, task_id)}/expand`, body),
      "expand task",
    );
  },

  async taskmaster_hub_current_tag({ project_id }) {
    req1(project_id, "project_id");
    return must(await api("GET", `${P(project_id)}/tags`), "current tag");
  },
  async taskmaster_hub_use_tag({ project_id, name }) {
    req1(project_id, "project_id");
    if (typeof name !== "string" || !name.trim())
      throw new Error("name is required");
    return must(
      await api("POST", `${P(project_id)}/tags/use`, { name: name.trim() }),
      "use tag",
    );
  },
};

function req1(v, label) {
  if (!v) throw new Error(`${label} is required`);
}
function req2(projectId, taskId) {
  if (!projectId || taskId === undefined || taskId === null || taskId === "")
    throw new Error("project_id and task_id are required");
}

// ---- Tool schemas (advertised to the client) ------------------------------
const projectOnly = {
  type: "object",
  properties: { project_id: { type: "string" } },
  required: ["project_id"],
  additionalProperties: false,
};
const projectTask = {
  type: "object",
  properties: {
    project_id: { type: "string" },
    task_id: { type: "string" },
  },
  required: ["project_id", "task_id"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "taskmaster_hub_init",
    description:
      "Onboard a project into the running Task Master Hub. Registers it (probes .taskmaster/ + binaryMode) and returns the project id, binaryMode, current tag, the claim protocol, this MCP's claim identity/auth-channel, and an AGENTS.md snippet to paste (this tool does NOT write any file). `path` defaults to the MCP process cwd, which is reported, not trusted — pass an explicit absolute path when the agent and gateway are not co-located.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        server_id: { type: "string" },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_list_projects",
    description: "List every project registered with the Hub.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_overview",
    description:
      "Task counts (total/ready/in-progress/blocked/done) plus the active agent claims for a project.",
    inputSchema: projectOnly,
  },
  {
    name: "taskmaster_hub_list_tasks",
    description:
      "List a project's tasks (summary projection: id, title, status, priority, dependencies, blocks — no details/testStrategy).",
    inputSchema: projectOnly,
  },
  {
    name: "taskmaster_hub_get_task",
    description:
      "Full detail for one task: details, testStrategy, subtasks, dependencies.",
    inputSchema: projectTask,
  },
  {
    name: "taskmaster_hub_next",
    description:
      "The next actionable task for a project (pending, all dependencies done).",
    inputSchema: projectOnly,
  },
  {
    name: "taskmaster_hub_claim",
    description:
      "Claim an actionable task for this worker before doing implementation work. 409 if already held by another worker or if dependencies are unmet. Uses this MCP's configured identity (TASKMASTER_HUB_ROLE/NAME/TOOL/AGENT_ID) and auth channel.",
    inputSchema: projectTask,
  },
  {
    name: "taskmaster_hub_update_progress",
    description:
      "Post progress on a task this worker holds: status working | blocked | review. 'blocked' requires a non-empty note. 403 if a different auth channel holds the claim.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        status: { type: "string", enum: ["working", "blocked", "review"] },
        note: { type: "string" },
      },
      required: ["project_id", "task_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_release",
    description:
      "Release this worker's claim on a task. 403 if a different auth channel holds it.",
    inputSchema: projectTask,
  },
  {
    name: "taskmaster_hub_set_status",
    description:
      "Set the Task Master task status (pending, in-progress, review, done, deferred, cancelled, blocked). Moving to done/cancelled/deferred also releases any active claim.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        status: { type: "string" },
      },
      required: ["project_id", "task_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_add_task",
    description:
      "Create a task from a natural-language prompt (task-master generates the content). Requires a real task-master binary on the project's server (503 otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        prompt: { type: "string" },
        priority: {
          type: "string",
          enum: ["low", "medium", "high", "urgent"],
        },
      },
      required: ["project_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_update_task",
    description:
      "Revise a task from a natural-language prompt. Binary-only (503 otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["project_id", "task_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_add_dependency",
    description:
      "Add a dependency edge: task `id` depends on task `depends_on`. A cycle is rejected (dependency_cycle). Binary-only (503 otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        id: { type: "string" },
        depends_on: { type: "string" },
      },
      required: ["project_id", "id", "depends_on"],
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_expand",
    description:
      "Break a task into subtasks (task-master generates them). `research` enables research mode; `num` requests a subtask count. Binary-only (503 otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        num: { type: "integer", minimum: 1 },
        research: { type: "boolean" },
      },
      required: ["project_id", "task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "taskmaster_hub_current_tag",
    description: "The project's current Task Master tag.",
    inputSchema: projectOnly,
  },
  {
    name: "taskmaster_hub_use_tag",
    description:
      "Switch the project's current Task Master tag. Binary-only (503 otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
  },
];

// ---- JSON-RPC / MCP wiring -------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const impl = IMPL[name];
      if (!impl)
        return reply(id, {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        });
      try {
        const result = await impl(args);
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        return reply(id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        });
      }
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => {
      if (msg && msg.id != null)
        replyError(msg.id, -32603, String((e && e.message) || e));
    });
  }
});
process.stdin.on("end", () => process.exit(0));
process.stderr.write(
  `[taskmaster-hub-mcp] ready — base=${BASE}, token=${
    TOKEN ? "set" : "MISSING"
  }, channel=${ACTOR ? `client:${ACTOR}` : "client:bearer"}\n`,
);
