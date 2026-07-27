#!/usr/bin/env node
// PM (Project-Management) MCP server — a dependency-free Model Context Protocol
// (stdio) server that exposes the gateway's /api/pm/* project API as MCP tools,
// so an MCP-capable client (Claude Code, Codex, …) gets PM tools automatically.
//
// It is a thin REST client: every call hits the gateway with the scoped API
// token bearer (never a cookie), so it works from anywhere the gateway/proxy is
// reachable. The gateway stays the single enforcement point.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
// No SDK — the surface (initialize / tools/list / tools/call / ping) is small
// and stable enough to implement directly, matching this repo's dep-minimal
// ethos. Mirrors tools/kanban-mcp/server.mjs.
//
// Config (env):
//   GATEWAY_API_TOKEN  required — the gateway's API token (KANBAN_API_TOKEN is
//                      accepted as a legacy fallback, and still authorizes /api/pm)
//   PM_BASE_URL        gateway/proxy base (preferred; falls back to
//                      KANBAN_BASE_URL, default http://127.0.0.1:3107)
//
// Register with Claude Code:
//   claude mcp add pm -- node /abs/path/tools/pm-mcp/server.mjs \
//     -e GATEWAY_API_TOKEN=<token> -e PM_BASE_URL=https://sparklab.ap.loclx.io
// (see README.md for the exact syntax for your client)

const BASE = (
  process.env.PM_BASE_URL ||
  process.env.KANBAN_BASE_URL ||
  "http://127.0.0.1:3107"
).replace(/\/+$/, "");
const TOKEN =
  process.env.GATEWAY_API_TOKEN || process.env.KANBAN_API_TOKEN || "";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "pm", version: "1.0.0" };

// ---- REST helper ----------------------------------------------------------
async function api(method, path, body) {
  if (!TOKEN)
    throw new Error(
      "GATEWAY_API_TOKEN (or KANBAN_API_TOKEN) is not set for the MCP server",
    );
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/pm${path}`, {
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
    throw new Error(`${action} failed: ${msg}`);
  }
  return res.json;
}

// Map optional snake_case task fields → the REST body (camelCase). Only keys the
// caller actually provided are copied, so PATCH stays a partial update.
function taskFields(args, body) {
  if (args.title !== undefined) body.title = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.assignee !== undefined) body.assignee = args.assignee;
  if (args.priority !== undefined) body.priority = args.priority;
  if (Array.isArray(args.labels)) body.labels = args.labels;
  if (args.start_date !== undefined) body.startDate = args.start_date;
  if (args.due_date !== undefined) body.dueDate = args.due_date;
  if (args.sprint_id !== undefined) body.sprintId = args.sprint_id;
  if (args.column_id !== undefined) body.columnId = args.column_id;
  if (Array.isArray(args.depends_on)) body.dependsOn = args.depends_on;
  return body;
}

// ---- Tool implementations -------------------------------------------------
const IMPL = {
  async pm_list_projects() {
    return must(await api("GET", "/projects"), "list projects");
  },
  async pm_get_project({ project_id }) {
    if (!project_id) throw new Error("project_id is required");
    return must(
      await api("GET", `/projects/${encodeURIComponent(project_id)}`),
      "get project",
    );
  },
  async pm_create_project({ name, tags, columns }) {
    if (!name) throw new Error("name is required");
    const body = { name };
    if (Array.isArray(tags)) body.tags = tags;
    if (Array.isArray(columns)) body.columns = columns;
    return must(await api("POST", "/projects", body), "create project");
  },
  async pm_delete_project({ project_id }) {
    if (!project_id) throw new Error("project_id is required");
    const res = await api(
      "DELETE",
      `/projects/${encodeURIComponent(project_id)}`,
    );
    if (!res.ok) must(res, "delete project");
    return { deleted: project_id };
  },
  async pm_add_task(args) {
    const { project_id, title } = args;
    if (!project_id) throw new Error("project_id is required");
    if (!title) throw new Error("title is required");
    const body = taskFields(args, { title });
    return must(
      await api(
        "POST",
        `/projects/${encodeURIComponent(project_id)}/tasks`,
        body,
      ),
      "add task",
    );
  },
  async pm_update_task(args) {
    const { project_id, task_id } = args;
    if (!project_id) throw new Error("project_id is required");
    if (!task_id) throw new Error("task_id is required");
    const body = taskFields(args, { projectId: project_id });
    return must(
      await api("PATCH", `/tasks/${encodeURIComponent(task_id)}`, body),
      "update task",
    );
  },
  // Auto-manages `rev` + retries once on a 409 stale, so the model never has to
  // track revisions. `to_index` defaults to the end of the target column.
  async pm_move_task({ project_id, task_id, to_column_id, to_index }) {
    if (!project_id || !task_id || !to_column_id) {
      throw new Error("project_id, task_id and to_column_id are required");
    }
    const attempt = (project) => {
      const target = project.columns.find((c) => c.id === to_column_id);
      const idx = Number.isInteger(to_index)
        ? to_index
        : target
          ? target.taskIds.length
          : 0;
      return api("POST", `/tasks/${encodeURIComponent(task_id)}/move`, {
        projectId: project_id,
        toColumnId: to_column_id,
        toIndex: idx,
        rev: project.rev,
      });
    };
    let project = must(
      await api("GET", `/projects/${encodeURIComponent(project_id)}`),
      "get project",
    );
    let res = await attempt(project);
    if (res.status === 409 && res.json && res.json.project) {
      res = await attempt(res.json.project); // reconcile with the server's fresh project, retry once
    }
    return must(res, "move task");
  },
  async pm_add_sprint({ project_id, name, start_date, end_date }) {
    if (!project_id) throw new Error("project_id is required");
    if (!name) throw new Error("name is required");
    const body = { name };
    if (start_date !== undefined) body.startDate = start_date;
    if (end_date !== undefined) body.endDate = end_date;
    return must(
      await api(
        "POST",
        `/projects/${encodeURIComponent(project_id)}/sprints`,
        body,
      ),
      "add sprint",
    );
  },
};

// ---- Tool schemas (advertised to the client) ------------------------------
const PRIORITY = { type: "string", enum: ["low", "medium", "high", "urgent"] };
// Shared optional task fields (dates are epoch ms numbers).
const TASK_FIELD_PROPS = {
  description: { type: "string" },
  assignee: { type: "string" },
  priority: PRIORITY,
  labels: { type: "array", items: { type: "string" } },
  start_date: { type: "integer", description: "epoch milliseconds" },
  due_date: { type: "integer", description: "epoch milliseconds" },
  sprint_id: { type: "string" },
  column_id: { type: "string" },
  depends_on: { type: "array", items: { type: "string" } },
};

const TOOLS = [
  {
    name: "pm_list_projects",
    description:
      "List all projects (id, name, tags, rev, column/task/sprint counts).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pm_get_project",
    description:
      "Get one project in full: columns (ordered taskIds), tasks, and sprints.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "pm_create_project",
    description:
      "Create a project. Omitting columns seeds Backlog/To Do/In Progress/Done.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        columns: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "pm_delete_project",
    description: "Delete an entire project (irreversible).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "pm_add_task",
    description:
      "Add a task to a project (defaults to the first column). Optional: assignee, priority, labels, start/due dates (epoch ms), sprint, column, and dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        title: { type: "string" },
        ...TASK_FIELD_PROPS,
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "pm_update_task",
    description:
      "Edit a task's fields (partial update): title, description, assignee, priority, labels, start/due dates (epoch ms), sprint, column, and dependencies.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        title: { type: "string" },
        ...TASK_FIELD_PROPS,
      },
      required: ["project_id", "task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "pm_move_task",
    description:
      "Move a task to another column (or reorder). Handles rev/409 automatically; to_index defaults to the target column's end.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        task_id: { type: "string" },
        to_column_id: { type: "string" },
        to_index: { type: "integer", minimum: 0 },
      },
      required: ["project_id", "task_id", "to_column_id"],
      additionalProperties: false,
    },
  },
  {
    name: "pm_add_sprint",
    description:
      "Create a sprint in a project. Optional start/end dates (epoch ms).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        start_date: { type: "integer", description: "epoch milliseconds" },
        end_date: { type: "integer", description: "epoch milliseconds" },
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
  // Notifications (no id) need no response.
  if (id === undefined || id === null) return;

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

// Newline-delimited JSON on stdin.
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
  `[pm-mcp] ready — base=${BASE}, token=${TOKEN ? "set" : "MISSING"}\n`,
);
