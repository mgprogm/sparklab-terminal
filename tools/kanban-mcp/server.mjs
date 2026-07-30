#!/usr/bin/env node
// Kanban MCP server — a dependency-free Model Context Protocol (stdio) server
// that exposes the gateway's /api/kanban/* board API as MCP tools, so an
// MCP-capable client (Claude Code, Codex, …) gets Kanban tools automatically.
//
// It is a thin REST client: every call hits the gateway with the scoped
// `KANBAN_API_TOKEN` bearer (never a cookie), so it works from anywhere the
// gateway/proxy is reachable. The gateway stays the single enforcement point.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
// No SDK — the surface (initialize / tools/list / tools/call / ping) is small
// and stable enough to implement directly, matching this repo's dep-minimal
// ethos.
//
// Config (env):
//   KANBAN_API_TOKEN   required — the gateway's KANBAN_API_TOKEN value
//   KANBAN_BASE_URL    gateway/proxy base (default http://127.0.0.1:3107)
//
// Register with Claude Code:
//   claude mcp add kanban -- node /abs/path/tools/kanban-mcp/server.mjs \
//     -e KANBAN_API_TOKEN=<token> -e KANBAN_BASE_URL=https://sparklab.ap.loclx.io
// (see README.md for the exact syntax for your client)

const BASE = (process.env.KANBAN_BASE_URL || "http://127.0.0.1:3107").replace(
  /\/+$/,
  "",
);
const TOKEN = process.env.KANBAN_API_TOKEN || "";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "kanban", version: "1.0.0" };

// ---- REST helper ----------------------------------------------------------
async function api(method, path, body) {
  if (!TOKEN) throw new Error("KANBAN_API_TOKEN is not set for the MCP server");
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/kanban${path}`, {
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
  async kanban_list_boards() {
    return must(await api("GET", "/boards"), "list boards");
  },
  async kanban_get_board({ board_id }) {
    if (!board_id) throw new Error("board_id is required");
    return must(
      await api("GET", `/boards/${encodeURIComponent(board_id)}`),
      "get board",
    );
  },
  async kanban_create_board({ name, tags, columns }) {
    if (!name) throw new Error("name is required");
    const body = { name };
    if (Array.isArray(tags)) body.tags = tags;
    if (Array.isArray(columns)) body.columns = columns;
    return must(await api("POST", "/boards", body), "create board");
  },
  async kanban_delete_board({ board_id }) {
    if (!board_id) throw new Error("board_id is required");
    const res = await api("DELETE", `/boards/${encodeURIComponent(board_id)}`);
    if (!res.ok) must(res, "delete board");
    return { deleted: board_id };
  },
  async kanban_add_card({ board_id, title, description, tags, column_id }) {
    if (!board_id) throw new Error("board_id is required");
    if (!title) throw new Error("title is required");
    const body = { title };
    if (description !== undefined) body.description = description;
    if (Array.isArray(tags)) body.tags = tags;
    if (column_id) body.columnId = column_id;
    return must(
      await api("POST", `/boards/${encodeURIComponent(board_id)}/cards`, body),
      "add card",
    );
  },
  async kanban_update_card({ board_id, card_id, title, description, tags }) {
    if (!board_id) throw new Error("board_id is required");
    if (!card_id) throw new Error("card_id is required");
    const body = { boardId: board_id };
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (Array.isArray(tags)) body.tags = tags;
    return must(
      await api("PATCH", `/cards/${encodeURIComponent(card_id)}`, body),
      "update card",
    );
  },
  // Auto-manages `rev` + retries once on a 409 stale, so the model never has to
  // track revisions. `to_index` defaults to the end of the target column.
  async kanban_move_card({ board_id, card_id, to_column_id, to_index }) {
    if (!board_id || !card_id || !to_column_id) {
      throw new Error("board_id, card_id and to_column_id are required");
    }
    const attempt = (board) => {
      const target = board.columns.find((c) => c.id === to_column_id);
      const idx = Number.isInteger(to_index)
        ? to_index
        : target
          ? target.cardIds.length
          : 0;
      return api("POST", `/cards/${encodeURIComponent(card_id)}/move`, {
        boardId: board_id,
        toColumnId: to_column_id,
        toIndex: idx,
        rev: board.rev,
      });
    };
    let board = must(
      await api("GET", `/boards/${encodeURIComponent(board_id)}`),
      "get board",
    );
    let res = await attempt(board);
    if (res.status === 409 && res.json && res.json.board) {
      res = await attempt(res.json.board); // reconcile with the server's fresh board, retry once
    }
    return must(res, "move card");
  },
};

// ---- Tool schemas (advertised to the client) ------------------------------
const TOOLS = [
  {
    name: "kanban_list_boards",
    description:
      "List all Kanban boards (id, name, tags, rev, column/card counts).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "kanban_get_board",
    description: "Get one board in full: columns (ordered cardIds) and cards.",
    inputSchema: {
      type: "object",
      properties: { board_id: { type: "string" } },
      required: ["board_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_create_board",
    description:
      "Create a board. Omitting columns seeds Backlog/To Do/In Progress/Done.",
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
    name: "kanban_delete_board",
    description: "Delete an entire board (irreversible).",
    inputSchema: {
      type: "object",
      properties: { board_id: { type: "string" } },
      required: ["board_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_add_card",
    description: "Add a card to a board (defaults to the first column).",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        column_id: { type: "string" },
      },
      required: ["board_id", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_update_card",
    description: "Edit a card's title/description/tags.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        card_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["board_id", "card_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kanban_move_card",
    description:
      "Move a card to another column (or reorder). Handles rev/409 automatically; to_index defaults to the column end.",
    inputSchema: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        card_id: { type: "string" },
        to_column_id: { type: "string" },
        to_index: { type: "integer", minimum: 0 },
      },
      required: ["board_id", "card_id", "to_column_id"],
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
  `[kanban-mcp] ready — base=${BASE}, token=${TOKEN ? "set" : "MISSING"}\n`,
);
