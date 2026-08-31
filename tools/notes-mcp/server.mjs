#!/usr/bin/env node
// Notes MCP server — a dependency-free Model Context Protocol (stdio) server
// that exposes the gateway's /api/notes/* OneNote-style note tool as MCP
// tools, so an MCP-capable client (Claude Code, Codex, …) gets Notes tools
// automatically. A near-copy of tools/kanban-mcp/server.mjs.
//
// It is a thin REST client: every call hits the gateway with a scoped bearer
// (never a cookie), so it works from anywhere the gateway/proxy is reachable.
// The gateway stays the single enforcement point.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
// No SDK — the surface (initialize / tools/list / tools/call / ping) is small
// and stable enough to implement directly, matching this repo's dep-minimal
// ethos.
//
// Config (env):
//   NOTES_API_TOKEN    the gateway's scoped artifact bearer (falls back to
//                       GATEWAY_API_TOKEN — either works, docs/NOTES-TOOL-PLAN.md D8)
//   NOTES_BASE_URL      gateway/proxy base (default http://127.0.0.1:3107)
//
// Register with Claude Code:
//   claude mcp add notes -- node /abs/path/tools/notes-mcp/server.mjs \
//     -e NOTES_API_TOKEN=<token> -e NOTES_BASE_URL=https://sparklab.ap.loclx.io
// (see README.md for the exact syntax for your client)

const BASE = (process.env.NOTES_BASE_URL || "http://127.0.0.1:3107").replace(
  /\/+$/,
  "",
);
const TOKEN =
  process.env.NOTES_API_TOKEN || process.env.GATEWAY_API_TOKEN || "";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "notes", version: "1.0.0" };

// ---- REST helper ----------------------------------------------------------
async function api(method, path, body) {
  if (!TOKEN)
    throw new Error(
      "NOTES_API_TOKEN (or GATEWAY_API_TOKEN) is not set for the MCP server",
    );
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/notes${path}`, {
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

// ---- Tool implementations -------------------------------------------------
const IMPL = {
  async notes_list() {
    return must(await api("GET", "/notebooks"), "list notebooks");
  },
  async notes_get_notebook({ notebook_id }) {
    if (!notebook_id) throw new Error("notebook_id is required");
    return must(
      await api("GET", `/notebooks/${encodeURIComponent(notebook_id)}`),
      "get notebook",
    );
  },
  async notes_get_page({ notebook_id, page_id }) {
    if (!notebook_id || !page_id)
      throw new Error("notebook_id and page_id are required");
    return must(
      await api(
        "GET",
        `/notebooks/${encodeURIComponent(notebook_id)}/pages/${encodeURIComponent(page_id)}`,
      ),
      "get page",
    );
  },
  async notes_search({ query, limit }) {
    if (!query) throw new Error("query is required");
    const params = new URLSearchParams({ q: query });
    if (Number.isInteger(limit)) params.set("limit", String(limit));
    return must(await api("GET", `/search?${params}`), "search notes");
  },
  async notes_create_notebook({ name, tags }) {
    if (!name) throw new Error("name is required");
    const body = { name };
    if (Array.isArray(tags)) body.tags = tags;
    return must(await api("POST", "/notebooks", body), "create notebook");
  },
  async notes_delete_notebook({ notebook_id }) {
    if (!notebook_id) throw new Error("notebook_id is required");
    const res = await api(
      "DELETE",
      `/notebooks/${encodeURIComponent(notebook_id)}`,
    );
    if (!res.ok) must(res, "delete notebook");
    return { deleted: notebook_id };
  },
  async notes_create_section({ notebook_id, name }) {
    if (!notebook_id || !name)
      throw new Error("notebook_id and name are required");
    return must(
      await api(
        "POST",
        `/notebooks/${encodeURIComponent(notebook_id)}/sections`,
        { name },
      ),
      "create section",
    );
  },
  async notes_delete_section({ notebook_id, section_id, mode }) {
    if (!notebook_id || !section_id)
      throw new Error("notebook_id and section_id are required");
    const params = new URLSearchParams({ notebookId: notebook_id });
    if (mode) params.set("mode", mode);
    const res = await api(
      "DELETE",
      `/sections/${encodeURIComponent(section_id)}?${params}`,
    );
    if (!res.ok) must(res, "delete section");
    return { deleted: section_id };
  },
  async notes_create_page({ notebook_id, section_id, title, parent_id, body }) {
    if (!notebook_id) throw new Error("notebook_id is required");
    if (!section_id && !parent_id)
      throw new Error("either section_id or parent_id is required");
    const reqBody = {};
    if (section_id) reqBody.sectionId = section_id;
    if (title !== undefined) reqBody.title = title;
    if (parent_id !== undefined) reqBody.parentId = parent_id;
    if (body !== undefined) reqBody.body = body;
    return must(
      await api(
        "POST",
        `/notebooks/${encodeURIComponent(notebook_id)}/pages`,
        reqBody,
      ),
      "create page",
    );
  },
  async notes_append_to_page({ notebook_id, page_id, markdown }) {
    if (!notebook_id || !page_id || !markdown)
      throw new Error("notebook_id, page_id and markdown are required");
    return must(
      await api("POST", `/pages/${encodeURIComponent(page_id)}/append`, {
        notebookId: notebook_id,
        markdown,
      }),
      "append to page",
    );
  },
  // Auto-manages `rev` + retries once on a 409 stale, so the model never has
  // to track revisions (D4 — safe here: movePage is a re-derived splice).
  async notes_move_page({
    notebook_id,
    page_id,
    to_section_id,
    to_index,
    to_parent_id,
  }) {
    if (!notebook_id || !page_id || !to_section_id) {
      throw new Error("notebook_id, page_id and to_section_id are required");
    }
    const attempt = (rev) => {
      const body = {
        notebookId: notebook_id,
        toSectionId: to_section_id,
        toIndex: Number.isInteger(to_index) ? to_index : 0,
        rev,
      };
      if (to_parent_id !== undefined) body.toParentId = to_parent_id;
      return api("POST", `/pages/${encodeURIComponent(page_id)}/move`, body);
    };
    let notebook = must(
      await api("GET", `/notebooks/${encodeURIComponent(notebook_id)}`),
      "get notebook",
    );
    let res = await attempt(notebook.rev);
    if (res.status === 409 && res.json && res.json.notebook) {
      res = await attempt(res.json.notebook.rev); // reconcile + retry once
    }
    return must(res, "move page");
  },
  // NEVER auto-retried (D4 — a page-body PATCH is a blind overwrite; a
  // silent retry against a fresh rev would discard whatever the other writer
  // just saved). A 409 is surfaced to the caller as an error.
  async notes_update_page({ notebook_id, page_id, title, body, tags }) {
    if (!notebook_id || !page_id)
      throw new Error("notebook_id and page_id are required");
    if (title === undefined && body === undefined && tags === undefined)
      throw new Error("at least one of title/body/tags is required");
    const page = must(
      await api(
        "GET",
        `/notebooks/${encodeURIComponent(notebook_id)}/pages/${encodeURIComponent(page_id)}`,
      ),
      "get page",
    );
    const reqBody = { notebookId: notebook_id, rev: page.rev };
    if (title !== undefined) reqBody.title = title;
    if (body !== undefined) reqBody.body = body;
    if (Array.isArray(tags)) reqBody.tags = tags;
    const res = await api(
      "PATCH",
      `/pages/${encodeURIComponent(page_id)}`,
      reqBody,
    );
    if (res.status === 409) {
      throw new Error(
        `update page failed: page changed concurrently (stale rev); NOT overwritten`,
      );
    }
    return must(res, "update page");
  },
  async notes_delete_page({ notebook_id, page_id, mode }) {
    if (!notebook_id || !page_id)
      throw new Error("notebook_id and page_id are required");
    const params = new URLSearchParams({ notebookId: notebook_id });
    if (mode) params.set("mode", mode);
    const res = await api(
      "DELETE",
      `/pages/${encodeURIComponent(page_id)}?${params}`,
    );
    if (!res.ok) must(res, "delete page");
    return { deleted: page_id };
  },
};

// ---- Tool schemas (advertised to the client) ------------------------------
const TOOLS = [
  {
    name: "notes_list",
    description:
      "List all Notes notebooks (id, name, tags, rev, section/page counts).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "notes_get_notebook",
    description:
      "Get one notebook in full: ordered sections and a flat, render-order array of all pages (derived sectionId + indent depth), no bodies.",
    inputSchema: {
      type: "object",
      properties: { notebook_id: { type: "string" } },
      required: ["notebook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_get_page",
    description: "Get one page's metadata, current rev, and Markdown body.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        page_id: { type: "string" },
      },
      required: ["notebook_id", "page_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_search",
    description:
      "Case-insensitive substring search over page titles/bodies across all notebooks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_create_notebook",
    description:
      'Create a notebook. Seeds one section "Notes" with one empty "Untitled page".',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_delete_notebook",
    description:
      "Delete an entire notebook and every page in it (irreversible).",
    inputSchema: {
      type: "object",
      properties: { notebook_id: { type: "string" } },
      required: ["notebook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_create_section",
    description: "Add a new section to a notebook (appended at the end).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        name: { type: "string" },
      },
      required: ["notebook_id", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_delete_section",
    description:
      'Delete a section. mode "block" (default) refuses a non-empty section; "cascade" deletes it and every page in it.',
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        section_id: { type: "string" },
        mode: { type: "string", enum: ["block", "cascade"] },
      },
      required: ["notebook_id", "section_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_create_page",
    description:
      "Create a page. Provide section_id for a top-level page, or parent_id for a subpage (it then joins the parent's section).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        section_id: { type: "string" },
        title: { type: "string" },
        parent_id: { type: "string" },
        body: { type: "string" },
      },
      required: ["notebook_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_append_to_page",
    description:
      "Append Markdown to the end of a page's body (server-atomic, cannot clobber — no revision to manage).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        page_id: { type: "string" },
        markdown: { type: "string" },
      },
      required: ["notebook_id", "page_id", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_move_page",
    description:
      "Move a page (and its subpages) to another section/position, optionally reparenting it. Handles rev/409 automatically (retries once).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        page_id: { type: "string" },
        to_section_id: { type: "string" },
        to_index: { type: "integer", minimum: 0 },
        to_parent_id: { type: "string" },
      },
      required: ["notebook_id", "page_id", "to_section_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_update_page",
    description:
      "Replace a page's title/body/tags wholesale (blind overwrite). Fetches the current rev itself; on a concurrent change the update is rejected and surfaced as an error — it is NEVER retried. Prefer notes_append_to_page when you only need to add content.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        page_id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["notebook_id", "page_id"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_delete_page",
    description:
      'Delete a page. mode "orphan" (default) promotes its children to its own parent; "cascade" deletes the whole subtree.',
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        page_id: { type: "string" },
        mode: { type: "string", enum: ["orphan", "cascade"] },
      },
      required: ["notebook_id", "page_id"],
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
  `[notes-mcp] ready — base=${BASE}, token=${TOKEN ? "set" : "MISSING"}\n`,
);
