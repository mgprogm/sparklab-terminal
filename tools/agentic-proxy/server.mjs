#!/usr/bin/env node
// Agentic MCP proxy — a dependency-free, per-run mediating MCP (stdio) server
// that sits between an agentic-run CLI (claude/codex, spawned as an MCP
// client) and the REAL artifact MCP servers (tools/kanban-mcp,
// tools/pm-mcp). It is the D5 enforcement boundary: an agent-task CLI process
// reaches pm/kanban ONLY through this proxy, never directly and never
// unmediated. See docs/AGENTIC-AI-CREATOR-PLAN.md (D5) for the design.
//
// It is SPAWNED BY THE CLI ITSELF as an MCP server child, exactly the way
// kanban-mcp/pm-mcp are normally registered (agent-runtime.js configures the
// CLI's --mcp-config to point at this file). The gateway does NOT pre-spawn
// it and does not talk to it directly — it only serves the two small HTTP
// endpoints this proxy calls back into (pending-tool-call, tool-call-log).
//
// On startup it:
//   1. Reads a per-node policy manifest (JSON file dropped into the node's
//      scratchDir alongside prompt/system by the run engine, frozen at
//      run-start per the existing D9 resolvedConfig freeze point — see
//      buildMcpPolicyManifest in agent-runtime.js).
//   2. Spawns the REAL kanban-mcp/pm-mcp servers as ITS OWN stdio children —
//      one per distinct targetType present in the manifest (deduped; a
//      targetType referenced by two connections still gets exactly one
//      child process).
//   3. Aggregates each child's tools/list, resolves a policy (allow / deny /
//      approval) for every tool from the manifest's toolPolicies, and
//      exposes a filtered, annotated tools/list + a policy-enforcing
//      tools/call to whatever spawned this proxy.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0, both on the outer
// side (talking to the CLI) and the inner side (talking to each spawned
// child) — no SDK, matching tools/kanban-mcp/server.mjs's dep-minimal style.
//
// ---------------------------------------------------------------------------
// WIRE PROTOCOL CONTRACT (stable — downstream engineers depend on this exactly)
// ---------------------------------------------------------------------------
//
// Env vars read by this process:
//   GATEWAY_API_TOKEN     required to do anything useful — the bearer used
//                         both for this proxy's own callback POSTs to the
//                         gateway AND passed through to the spawned
//                         kanban-mcp/pm-mcp children (as KANBAN_API_TOKEN /
//                         GATEWAY_API_TOKEN respectively). NEVER present in
//                         the policy manifest file — it reaches this process
//                         only via its own MCP-server-launch env block (the
//                         CLI's mcp.json), matching HARD CONSTRAINT #1.
//   GATEWAY_BASE_URL      gateway base URL, e.g. http://127.0.0.1:3007.
//                         Falls back to the manifest's own "gatewayBaseUrl"
//                         field if the env var is unset, then to
//                         http://127.0.0.1:3007.
//   AGENTIC_RUN_ID        the run this node belongs to (falls back to the
//                         manifest's "runId").
//   AGENTIC_NODE_ID       this node's id within the run (falls back to the
//                         manifest's "nodeId").
//   AGENTIC_POLICY_FILE   absolute path to the policy manifest JSON. Missing
//                         or unparseable -> treated as {connections: []}
//                         (fail-closed: every tool resolves to "deny").
//
// Policy manifest shape (apps/terminal-gateway writes this; read-only here):
//   {
//     "connections": [
//       {
//         "connectionId": "conn-pm-1",
//         "targetType": "pm" | "kanban",
//         "toolPolicies": [
//           { "tools": ["pm_get_project", "pm_add_comment"], "policy": "allow" },
//           { "tools": "all", "policy": "approval" }
//         ]
//       }
//     ],
//     "gatewayBaseUrl": "http://127.0.0.1:3007",
//     "runId": "run-...",
//     "nodeId": "n0"
//   }
// `tools` is either "all" or an array of exact tool names. `policy` is one of
// "allow" | "deny" | "approval". Only "pm" and "kanban" targetTypes exist
// today (matches CONNECTION_TARGETS in agentic.js); any other targetType is
// simply never spawned, so its tools never appear.
//
// Policy resolution (per real tool T on targetType X), computed once at
// startup from the manifest + each child's real tools/list:
//   1. For each connection whose targetType === X, resolve that connection's
//      own verdict for T: an explicit-list match (tools array containing T)
//      beats a "tools":"all" catch-all within the SAME connection; if more
//      than one entry within a connection matches at the same specificity,
//      the most restrictive of those wins (deny > approval > allow).
//   2. Across all connections with a targetType === X that produced a
//      verdict, the most restrictive verdict wins overall.
//   3. If NO connection produces a verdict for T at all -> "deny" (fail-closed
//      default; an agent connected to an artifact but given zero policy
//      entries for a tool sees nothing for it).
// `connectionIds` attribution (used only for logs) lists every connection
// that contributed a verdict for T, not just the winning one.
//
// tools/list: tools resolved to "deny" are OMITTED entirely (never shown to
// the model as an option). Tools resolved to "allow"/"approval" are included
// with their real schema PLUS an injected
//   annotations: { readOnlyHint: true, destructiveHint: false,
//                  idempotentHint: false, openWorldHint: true }
// block, overwriting whatever (if any) annotations the real child returned.
// This is required for both `codex exec` (which unconditionally cancels any
// MCP tool call whose definition lacks readOnlyHint:true — its non-interactive
// harness cannot answer the human-only elicitation it otherwise raises) and
// `claude -p --permission-mode plan` (which blocks non-read-only-annotated
// tools outright) to even ATTEMPT the call. It is safe, not a bypass: this
// annotation only governs the CLI's own local harness gate over its MCP
// client; the real allow/deny/approval enforcement happens here, server-side,
// on every tools/call regardless of what tools/list advertised. See
// docs/AGENTIC-AI-CREATOR-PLAN.md D5 §0 Finding A for the full writeup.
//
// tools/call: "deny" -> isError:true, never forwarded to the child (defense
// in depth — a deny-tier tool is unreachable even if called by name directly,
// not just hidden from tools/list, per HARD CONSTRAINT #2). "allow" ->
// forwarded verbatim to the resolved child, result returned as-is. "approval"
// -> POSTs to the gateway to create a pending record, then polls for a
// decision (see below), forwarding only once "approved".
//
// Callback routes this proxy expects the gateway to expose under
// /api/agentic/runs/:runId/nodes/:nodeId/ (bearer-authed, same
// isArtifactBearerAuthorized gate as the rest of /api/agentic/*; NOT yet
// implemented as of this file landing — the APPROVALS engineer wires these):
//   POST /pending-tool-call
//     body {toolName, connectionId, argsPreview}
//     -> 201 {pendingId}
//     Creates the pending record, flips the node to "waiting-approval".
//   GET  /pending-tool-call/:pendingId
//     -> 200 {status: "pending"|"approved"|"rejected"|"timed_out", reason?}
//     -> 404 if pendingId is stale/unknown (treated the same as "pending"
//        by this proxy's poll loop — see below, it just keeps polling until
//        its own local timeout).
//   POST /pending-tool-call/:pendingId   (best-effort fast path only)
//     body {decision: "timed_out"}
//     Optional. Sent once, fire-and-forget, when THIS proxy's own local
//     poll loop times out, so the gateway's record can resolve immediately
//     instead of waiting for its own periodic sweep. Errors (including 404
//     if the gateway hasn't implemented this route yet) are swallowed —
//     the gateway-side reducer sweep (advanceRun's sweepStalePendingApprovals)
//     is the actual guarantee behind "a pending approval must always
//     resolve" (HARD CONSTRAINT #4), this POST is purely an optimization.
//   POST /tool-call-log
//     body {toolName, connectionId, targetType, disposition, argsPreview}
//     Fire-and-forget from this proxy's side (not awaited, errors swallowed)
//     — a log-append failure must never fail/block the actual tool call.
//     disposition is one of "allow" | "deny" | "approved" | "rejected" |
//     "timed_out" | "error" (the last for internal proxy-side failures, e.g.
//     the pending-tool-call POST itself failing).
//
// Poll loop: every ~1000ms, up to AGENT_MCP_APPROVAL_TIMEOUT_MS (env,
// default 170000 — the empirically-confirmed-safe ceiling from D5 §0 Finding
// B; both codex exec and claude -p held a 170s MCP tool-call response with no
// client-side abandonment). A network error while polling (e.g. the gateway
// mid-restart) is treated as "not yet decided" and the loop keeps going — it
// never gives up early on a transient error, only on the timeout deadline.
//
// argsPreview: JSON.stringify(args).slice(0, 512) — an internal audit log
// visible only to the same authenticated user who owns the run. No
// field-level redaction (deliberately out of scope; that complexity belongs
// to a different exposure channel, push-notification payloads leaving to
// Apple/Google — see docs/PUSH-NOTIFICATIONS-PLAN.md).
//
// Env vars this proxy sets on ITS OWN children (mirrors each MCP server's own
// documented config exactly):
//   kanban-mcp: KANBAN_API_TOKEN=<GATEWAY_API_TOKEN>, KANBAN_BASE_URL=<GATEWAY_BASE_URL>
//   pm-mcp:     GATEWAY_API_TOKEN=<GATEWAY_API_TOKEN>, PM_BASE_URL=<GATEWAY_BASE_URL>

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KANBAN_MCP_PATH = path.join(__dirname, "..", "kanban-mcp", "server.mjs");
const PM_MCP_PATH = path.join(__dirname, "..", "pm-mcp", "server.mjs");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "agentic-proxy", version: "1.0.0" };
const POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 170000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const RANK = { allow: 1, approval: 2, deny: 3 }; // higher = more restrictive
const VALID_POLICIES = new Set(["allow", "approval", "deny"]);

// ---- manifest ---------------------------------------------------------
function loadManifest() {
  const file = process.env.AGENTIC_POLICY_FILE;
  if (!file) return { connections: [] };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.connections)
    ) {
      return { connections: [] };
    }
    return parsed;
  } catch {
    return { connections: [] }; // missing/unparseable -> fail-closed
  }
}

const MANIFEST = loadManifest();

const GATEWAY_API_TOKEN = process.env.GATEWAY_API_TOKEN || "";
const GATEWAY_BASE_URL = (
  process.env.GATEWAY_BASE_URL ||
  MANIFEST.gatewayBaseUrl ||
  "http://127.0.0.1:3007"
).replace(/\/+$/, "");
const RUN_ID = process.env.AGENTIC_RUN_ID || MANIFEST.runId || "";
const NODE_ID = process.env.AGENTIC_NODE_ID || MANIFEST.nodeId || "";
const TIMEOUT_MS =
  Number(process.env.AGENT_MCP_APPROVAL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

// ---- tiny in-process MCP client (talks to a spawned child over stdio) ----
class McpChildClient {
  constructor(label, cmd, args, env) {
    this.label = label;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    // FIX 6: spawn with a MINIMAL env — only PATH/HOME (so `node` resolves) plus
    // the explicit per-child overrides (KANBAN_API_TOKEN/PM_BASE_URL/…). Do NOT
    // spread the proxy's full process.env: it carries the CLI's ANTHROPIC_API_KEY
    // (and any other CLI secret), which kanban-mcp/pm-mcp have no need for and
    // must not receive.
    this.proc = spawn(cmd, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // FIX 2: a child (kanban-mcp/pm-mcp) can die AFTER init. Without these, the
    // next stdin write throws EPIPE as an UNCAUGHT exception and crashes the
    // whole proxy — leaving the CLI blocked forever. Swallow stdin errors, and
    // track `dead` so request() fails cleanly (isError tool result) instead of
    // writing to a dead pipe.
    this.dead = false;
    this.proc.stdin.on("error", () => {}); // EPIPE etc. must never be uncaught
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (d) =>
      process.stderr.write(`[agentic-proxy:${label}] ${d}`),
    );
    this.proc.on("error", (e) => {
      // spawn failure or later process-level error — treat as dead.
      this.dead = true;
      const err = new Error(`${label} MCP child error: ${e.message}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    this.proc.on("exit", (code) => {
      this.dead = true;
      const err = new Error(`${label} MCP child exited (code ${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "child error"));
        else resolve(msg.result);
      }
    }
    if (Buffer.byteLength(this.buf, "utf8") > MAX_LINE_BYTES) {
      this.buf = "";
      this.dead = true;
      const err = new Error(
        `${this.label} MCP child sent a line exceeding ${MAX_LINE_BYTES} bytes`,
      );
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.kill();
    }
  }

  request(method, params) {
    // FIX 2: if the child already died, fail fast with a clear rejection rather
    // than writing to a closed pipe. forwardToChild's caller (callTool) wraps
    // this in try/catch -> isError tool result, so the CLI gets a clean error
    // and the proxy stays up.
    if (this.dead)
      return Promise.reject(
        new Error(`${this.label} MCP child is not running`),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

function spawnChildFor(targetType) {
  if (targetType === "kanban") {
    return new McpChildClient("kanban", "node", [KANBAN_MCP_PATH], {
      KANBAN_API_TOKEN: GATEWAY_API_TOKEN,
      KANBAN_BASE_URL: GATEWAY_BASE_URL,
    });
  }
  if (targetType === "pm") {
    return new McpChildClient("pm", "node", [PM_MCP_PATH], {
      GATEWAY_API_TOKEN,
      PM_BASE_URL: GATEWAY_BASE_URL,
    });
  }
  return null; // unknown targetType — never spawned; its tools simply never appear
}

// ---- policy resolution --------------------------------------------------
// Resolve one connection's own verdict for tool `name`: explicit-list match
// beats a "tools":"all" catch-all within the same connection; ties within a
// specificity level resolve most-restrictive-wins.
function resolveConnectionVerdict(connection, name) {
  const policies = connection.toolPolicies || [];
  const explicit = policies.filter(
    (p) => Array.isArray(p.tools) && p.tools.includes(name),
  );
  const pool = explicit.length
    ? explicit
    : policies.filter((p) => p.tools === "all");
  if (!pool.length) return null;
  let chosen = pool[0].policy;
  for (const p of pool) if (RANK[p.policy] > RANK[chosen]) chosen = p.policy;
  return chosen;
}

// Build toolName -> { policy, connectionIds, targetType } for every real tool
// across every spawned child, given the manifest's connections.
function resolvePolicies(connections, toolsByTargetType) {
  const toolPolicy = {};
  for (const [targetType, tools] of Object.entries(toolsByTargetType)) {
    const relevant = connections.filter((c) => c.targetType === targetType);
    for (const tool of tools) {
      const name = tool.name;
      const candidates = [];
      for (const conn of relevant) {
        const verdict = resolveConnectionVerdict(conn, name);
        if (verdict)
          candidates.push({ policy: verdict, connectionId: conn.connectionId });
      }
      if (!candidates.length) {
        toolPolicy[name] = { policy: "deny", connectionIds: [], targetType };
        continue;
      }
      let chosenPolicy = candidates[0].policy;
      for (const c of candidates)
        if (RANK[c.policy] > RANK[chosenPolicy]) chosenPolicy = c.policy;
      toolPolicy[name] = {
        policy: chosenPolicy,
        connectionIds: candidates.map((c) => c.connectionId),
        targetType,
      };
    }
  }
  return toolPolicy;
}

// ---- gateway callbacks ----------------------------------------------------
function previewArgs(args) {
  try {
    return JSON.stringify(args ?? {}).slice(0, 512);
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gatewayFetch(pathname, init) {
  const res = await fetch(`${GATEWAY_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${GATEWAY_API_TOKEN}`,
      ...(init && init.body ? { "content-type": "application/json" } : {}),
      ...(init && init.headers),
    },
  });
  return res;
}

async function postPendingToolCall({ toolName, connectionId, argsPreview }) {
  const res = await gatewayFetch(
    `/api/agentic/runs/${encodeURIComponent(RUN_ID)}/nodes/${encodeURIComponent(NODE_ID)}/pending-tool-call`,
    {
      method: "POST",
      body: JSON.stringify({ toolName, connectionId, argsPreview }),
    },
  );
  if (!res.ok)
    throw new Error(`pending-tool-call POST failed: HTTP ${res.status}`);
  return res.json();
}

// Poll for a decision. Network errors (gateway unreachable mid-restart) are
// treated as "not yet decided" and never end the loop early — only the
// timeout deadline does.
async function pollForDecision(pendingId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await gatewayFetch(
        `/api/agentic/runs/${encodeURIComponent(RUN_ID)}/nodes/${encodeURIComponent(NODE_ID)}/pending-tool-call/${encodeURIComponent(pendingId)}`,
        { method: "GET" },
      );
      if (res.ok) {
        const json = await res.json();
        if (json && json.status && json.status !== "pending") return json;
      }
      // non-ok (incl. 404) or still "pending" -> keep polling
    } catch {
      // transient network error -> keep polling
    }
  }
  return { status: "timed_out" };
}

// Best-effort fast path only — the gateway's own reducer-side sweep is the
// real guarantee (HARD CONSTRAINT #4). Errors swallowed.
function postTimeoutNoticeFireAndForget(pendingId) {
  if (!pendingId) return;
  gatewayFetch(
    `/api/agentic/runs/${encodeURIComponent(RUN_ID)}/nodes/${encodeURIComponent(NODE_ID)}/pending-tool-call/${encodeURIComponent(pendingId)}`,
    { method: "POST", body: JSON.stringify({ decision: "timed_out" }) },
  ).catch(() => {});
}

// Fire-and-forget: never awaited by callers, never allowed to fail/block the
// actual tool call.
function logFireAndForget(entry) {
  gatewayFetch(
    `/api/agentic/runs/${encodeURIComponent(RUN_ID)}/nodes/${encodeURIComponent(NODE_ID)}/tool-call-log`,
    { method: "POST", body: JSON.stringify(entry) },
  ).catch(() => {});
}

// ---- runtime state, populated by main() before the stdin loop starts ----
const children = {}; // targetType -> McpChildClient
const toolSchema = {}; // toolName -> real tool definition (from the child)
const toolTargetType = {}; // toolName -> targetType
let toolPolicy = {}; // toolName -> { policy, connectionIds, targetType }
let cleaningUp = false;

function cleanupAndExit() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const child of Object.values(children)) child.kill();
  process.exit(0);
}

process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);

function buildToolsList() {
  const out = [];
  for (const [name, schema] of Object.entries(toolSchema)) {
    const resolved = toolPolicy[name];
    // FIX 3 (fail-CLOSED): treat any policy not in {allow,approval,deny} as
    // deny. CRUD validates the store, so an unknown value is only reachable via
    // a corrupt/hand-edited manifest — it must never leak the tool into
    // tools/list (fail-open). Only a genuine allow/approval tool is listed.
    if (!resolved || !VALID_POLICIES.has(resolved.policy)) continue;
    if (resolved.policy === "deny") continue; // never listed (layer 1)
    out.push({
      ...schema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
  }
  return out;
}

async function forwardToChild(targetType, name, args) {
  const child = children[targetType];
  if (!child) throw new Error(`no child running for targetType ${targetType}`);
  return child.request("tools/call", { name, arguments: args });
}

async function callTool(name, args) {
  const resolved = toolPolicy[name];
  const targetType = toolTargetType[name] ?? resolved?.targetType ?? null;
  const preview = previewArgs(args);

  // FIX 3 (fail-CLOSED): a policy that is not exactly one of
  // allow/approval/deny (only reachable via a corrupt/hand-edited manifest) is
  // treated as deny — never forwarded, logged as deny. Combined with the deny
  // tier and the missing-policy default, this is the single fail-closed gate.
  if (
    !resolved ||
    !VALID_POLICIES.has(resolved.policy) ||
    resolved.policy === "deny"
  ) {
    // Defense in depth (HARD CONSTRAINT #2): rejected even if called by name
    // directly, never forwarded, regardless of whether it was ever listed.
    logFireAndForget({
      toolName: name,
      connectionId: resolved?.connectionIds?.[0] ?? null,
      targetType,
      disposition: "deny",
      argsPreview: preview,
    });
    return {
      content: [{ type: "text", text: `Tool not permitted: ${name}` }],
      isError: true,
    };
  }

  if (resolved.policy === "allow") {
    try {
      const result = await forwardToChild(targetType, name, args);
      logFireAndForget({
        toolName: name,
        connectionId: resolved.connectionIds[0] ?? null,
        targetType,
        disposition: "allow",
        argsPreview: preview,
      });
      return result;
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `Error forwarding to ${targetType}: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  // policy === "approval"
  const connectionId = resolved.connectionIds[0] ?? null;
  let pendingId;
  try {
    const created = await postPendingToolCall({
      toolName: name,
      connectionId,
      argsPreview: preview,
    });
    pendingId = created && created.pendingId;
  } catch (e) {
    logFireAndForget({
      toolName: name,
      connectionId,
      targetType,
      disposition: "error",
      argsPreview: preview,
    });
    return {
      content: [
        { type: "text", text: `Could not request approval: ${e.message}` },
      ],
      isError: true,
    };
  }

  const decision = await pollForDecision(pendingId, TIMEOUT_MS);

  if (decision.status === "approved") {
    try {
      const result = await forwardToChild(targetType, name, args);
      logFireAndForget({
        toolName: name,
        connectionId,
        targetType,
        disposition: "approved",
        argsPreview: preview,
      });
      return result;
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `Error forwarding to ${targetType}: ${e.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (decision.status === "rejected") {
    logFireAndForget({
      toolName: name,
      connectionId,
      targetType,
      disposition: "rejected",
      argsPreview: preview,
    });
    return {
      content: [
        {
          type: "text",
          text: `Rejected by human${decision.reason ? ": " + decision.reason : ""}`,
        },
      ],
      isError: true,
    };
  }

  // decision.status === "timed_out" (proxy-local timeout OR the gateway
  // already reported timed_out from its own reducer-side sweep)
  logFireAndForget({
    toolName: name,
    connectionId,
    targetType,
    disposition: "timed_out",
    argsPreview: preview,
  });
  postTimeoutNoticeFireAndForget(pendingId);
  return {
    content: [{ type: "text", text: "approval_pending_timeout" }],
    isError: true,
  };
}

// ---- outer JSON-RPC / MCP wiring (talking to whatever spawned this proxy) --
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
  if (id === undefined || id === null) return; // notification, no response

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
      return reply(id, { tools: buildToolsList() });
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!Object.prototype.hasOwnProperty.call(toolSchema, name)) {
        return reply(id, {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        });
      }
      try {
        return reply(id, await callTool(name, args));
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

function startStdinLoop() {
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
    if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) {
      buf = "";
      process.stderr.write(
        `[agentic-proxy] WARNING: dropped input line exceeding ${MAX_LINE_BYTES} bytes\n`,
      );
    }
  });
  process.stdin.on("end", cleanupAndExit);
}

// ---- startup: spawn needed children, aggregate tools/list, resolve policy -
async function main() {
  const neededTypes = new Set(
    (MANIFEST.connections || [])
      .map((c) => c.targetType)
      .filter((t) => t === "kanban" || t === "pm"),
  );

  const toolsByTargetType = {};
  for (const targetType of neededTypes) {
    const child = spawnChildFor(targetType);
    if (!child) continue;
    children[targetType] = child;
    try {
      await child.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: SERVER_INFO,
      });
      const listed = await child.request("tools/list", {});
      const tools = (listed && listed.tools) || [];
      toolsByTargetType[targetType] = tools;
      for (const tool of tools) {
        toolSchema[tool.name] = tool;
        toolTargetType[tool.name] = targetType;
      }
    } catch (e) {
      // A child that fails to come up contributes zero tools (fail-closed for
      // that targetType) rather than crashing the whole proxy.
      process.stderr.write(
        `[agentic-proxy] WARNING: ${targetType} child failed to initialize: ${e.message}\n`,
      );
      toolsByTargetType[targetType] = [];
    }
  }

  toolPolicy = resolvePolicies(MANIFEST.connections || [], toolsByTargetType);

  startStdinLoop();
  process.stderr.write(
    `[agentic-proxy] ready — run=${RUN_ID || "(unset)"} node=${NODE_ID || "(unset)"} ` +
      `token=${GATEWAY_API_TOKEN ? "set" : "MISSING"} children=${Object.keys(children).join(",") || "none"} ` +
      `tools=${Object.keys(toolPolicy).length}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(
    `[agentic-proxy] FATAL: ${e && e.stack ? e.stack : e}\n`,
  );
  process.exit(1);
});
