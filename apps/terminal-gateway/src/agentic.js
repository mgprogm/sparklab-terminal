// Agentic AI Creator store for the Creator artifact (docs/AGENTIC-AI-CREATOR-PLAN.md).
//
// A structural clone of pm.js / kanban.js with FOUR top-level collections:
// agents, connections, agenticAis, runs (plan §2). Same invariants: STATE in a
// gitignored data/agentic.json sidecar; module-level store; load() at bottom;
// atomic persist() (writeFileSync(TMP)+renameSync); every mutator is FULLY
// SYNCHRONOUS so a read-modify-write is atomic (no mutex). A monotonic `rev`
// gives optimistic concurrency on agents/agenticAis/connections edits (mirrors
// Kanban board / PM project rev). RUNS CARRY NO `rev` — only the gateway's own
// poll/marker/approval paths mutate a run, so there is no cross-client race
// (plan §2). An AgenticAI also carries a monotonic `version` bumped on every
// definition edit (D9); each Run snapshots the version it executed with.
//
// Ordering / structure authority is agentIds[] + workflow.edges (plan §2). A
// workflow is validated (dangling edge / bad entryNodeId / cycle → invalid_workflow)
// BEFORE the store is mutated, so a rejection always leaves the store clean.
//
// ITERATION 1: the CRUD surface only. startRun/advanceRun/killRun/approveAction/
// rejectAction are present but THROW — the run engine (tmux wrapper, the reducer
// over nodeExecutions[], the per-run MCP proxy) lands in a later iteration.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = process.env.AGENTIC_FILE || path.join(DATA_DIR, "agentic.json");
const TMP = `${FILE}.tmp`;

const RUNTIME_PROVIDERS = new Set(["codex-cli", "claude-cli"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
const POLICY_DISPOSITIONS = new Set(["allow", "deny", "approval"]);
const CONNECTION_TARGETS = new Set(["pm", "kanban"]);
const CONNECTION_SCOPES = new Set(["fixed", "runtime-selection"]);
const APP_STATUSES = new Set(["draft", "published", "paused", "archived"]);
const ORCH_MODES = new Set(["single", "supervisor", "sequential", "parallel"]);

// { agents:{[id]}, agenticAis:{[id]}, connections:{[id]}, runs:{[id]} }
let store = { agents: {}, agenticAis: {}, connections: {}, runs: {} };

function now() {
  return Date.now();
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
function err(code, message, details) {
  const e = new Error(message || code);
  // "not_found"|"bad_request"|"stale"|"invalid_workflow"|"backend_unavailable"
  e.code = code;
  if (details) e.details = details; // merged into the JSON error body
  return e;
}

// Idempotent backfill hook (mirrors pm.js). No-op today; kept so a future D9
// migration can run inside load() and persist exactly once when it changes state.
function migrate(_s) {
  return false;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store =
      parsed && typeof parsed === "object"
        ? {
            agents: parsed.agents || {},
            agenticAis: parsed.agenticAis || {},
            connections: parsed.connections || {},
            runs: parsed.runs || {},
          }
        : { agents: {}, agenticAis: {}, connections: {}, runs: {} };
  } catch {
    store = { agents: {}, agenticAis: {}, connections: {}, runs: {} };
  }
  if (migrate(store)) persist();
  return store;
}

function persist() {
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(TMP, FILE);
}

// Bump a rev-bearing record. NEVER call on a run (runs carry no rev, §2).
function touch(record) {
  record.rev += 1;
  record.updatedAt = now();
}

// ---- Field coercion / validation helpers ----
function requireName(name) {
  if (!name || typeof name !== "string")
    throw err("bad_request", "name required");
  return name;
}

function cleanToolPolicies(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw err("bad_request", "toolPolicies must be an array");
  return raw.map((p) => {
    if (!p || typeof p !== "object")
      throw err("bad_request", "each toolPolicy must be an object");
    if (!p.connectionId || typeof p.connectionId !== "string")
      throw err("bad_request", "toolPolicy.connectionId required");
    let tools;
    if (p.tools === "all") {
      tools = "all";
    } else if (Array.isArray(p.tools)) {
      tools = p.tools.map(String);
    } else {
      throw err("bad_request", 'toolPolicy.tools must be "all" or an array');
    }
    if (!POLICY_DISPOSITIONS.has(p.policy))
      throw err("bad_request", "toolPolicy.policy must be allow|deny|approval");
    return { connectionId: String(p.connectionId), tools, policy: p.policy };
  });
}

// Validate + normalize a workflow BEFORE mutating the store. Rejects a dangling
// edge, a bad entryNodeId, or a cycle → invalid_workflow (with the offending
// edge in details where relevant). An empty/absent workflow is allowed.
function resolveWorkflow(raw) {
  const wf = raw && typeof raw === "object" ? raw : {};
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  const entryNodeId = wf.entryNodeId != null ? String(wf.entryNodeId) : null;

  const cleanNodes = [];
  const nodeIds = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== "object" || !n.id || typeof n.id !== "string")
      throw err("invalid_workflow", "each node needs a string id");
    const id = String(n.id);
    if (nodeIds.has(id))
      throw err("invalid_workflow", `duplicate node id: ${id}`, { node: id });
    nodeIds.add(id);
    cleanNodes.push({
      id,
      type: n.type ? String(n.type) : "agent-task",
      ...(n.agentId != null ? { agentId: String(n.agentId) } : {}),
    });
  }

  const cleanEdges = [];
  const adj = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (!e || typeof e !== "object")
      throw err("invalid_workflow", "each edge must be an object");
    const from = String(e.from);
    const to = String(e.to);
    if (!nodeIds.has(from) || !nodeIds.has(to))
      throw err("invalid_workflow", `edge references unknown node`, {
        edge: { from, to },
      });
    cleanEdges.push({ from, to });
    adj.get(from).push(to);
  }

  if (entryNodeId != null && !nodeIds.has(entryNodeId))
    throw err("invalid_workflow", `entryNodeId not in nodes: ${entryNodeId}`, {
      entryNodeId,
    });

  // Cycle detection (DFS with a recursion stack).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...nodeIds].map((id) => [id, WHITE]));
  const visit = (id) => {
    color.set(id, GRAY);
    for (const nxt of adj.get(id)) {
      const c = color.get(nxt);
      if (c === GRAY)
        throw err("invalid_workflow", "workflow contains a cycle", {
          edge: { from: id, to: nxt },
        });
      if (c === WHITE) visit(nxt);
    }
    color.set(id, BLACK);
  };
  for (const id of nodeIds) if (color.get(id) === WHITE) visit(id);

  return { nodes: cleanNodes, edges: cleanEdges, entryNodeId };
}

// ---- Read shapes (deep-copied so callers can never mutate the store) ----
function shapeAgent(a) {
  return {
    id: a.id,
    name: a.name,
    runtimeProvider: a.runtimeProvider,
    role: a.role ?? null,
    systemPrompt: a.systemPrompt ?? "",
    sandboxMode: a.sandboxMode,
    toolPolicies: (a.toolPolicies || []).map((p) => ({
      connectionId: p.connectionId,
      tools: p.tools === "all" ? "all" : [...p.tools],
      policy: p.policy,
    })),
    model: a.model ?? null,
    rev: a.rev,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function shapeConnection(c) {
  return {
    id: c.id,
    targetType: c.targetType,
    scope: c.scope,
    targetId: c.targetId ?? null,
    createdAt: c.createdAt,
    ...(typeof c.rev === "number" ? { rev: c.rev } : {}),
  };
}

function shapeWorkflow(wf) {
  const w = wf || { nodes: [], edges: [], entryNodeId: null };
  return {
    nodes: (w.nodes || []).map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.agentId != null ? { agentId: n.agentId } : {}),
    })),
    edges: (w.edges || []).map((e) => ({ from: e.from, to: e.to })),
    entryNodeId: w.entryNodeId ?? null,
  };
}

function shapeAgenticAi(aa) {
  return {
    id: aa.id,
    name: aa.name,
    description: aa.description ?? "",
    objectiveTemplate: aa.objectiveTemplate ?? "",
    status: aa.status,
    orchestrationMode: aa.orchestrationMode,
    agentIds: [...(aa.agentIds || [])],
    connectionIds: [...(aa.connectionIds || [])],
    workflow: shapeWorkflow(aa.workflow),
    version: aa.version,
    rev: aa.rev,
    createdAt: aa.createdAt,
    updatedAt: aa.updatedAt,
  };
}

function shapeAgenticAiSummary(aa) {
  return {
    id: aa.id,
    name: aa.name,
    status: aa.status,
    orchestrationMode: aa.orchestrationMode,
    agentCount: (aa.agentIds || []).length,
    connectionCount: (aa.connectionIds || []).length,
    version: aa.version,
    updatedAt: aa.updatedAt,
  };
}

function shapeNodeExecution(ne) {
  return {
    nodeId: ne.nodeId,
    status: ne.status,
    ...(ne.agentRunId != null ? { agentRunId: ne.agentRunId } : {}),
    ...(ne.parentNodeId != null ? { parentNodeId: ne.parentNodeId } : {}),
    ...(ne.startedAt != null ? { startedAt: ne.startedAt } : {}),
    ...(ne.finishedAt != null ? { finishedAt: ne.finishedAt } : {}),
  };
}

function shapeRun(r) {
  return {
    id: r.id,
    agenticAiId: r.agenticAiId,
    agenticAiVersion: r.agenticAiVersion,
    ...(r.resolvedConfig
      ? { resolvedConfig: JSON.parse(JSON.stringify(r.resolvedConfig)) }
      : {}),
    sessionId: r.sessionId ?? null,
    objective: r.objective ?? "",
    status: r.status,
    nodeExecutions: (r.nodeExecutions || []).map(shapeNodeExecution),
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
  };
}

function shapeRunSummary(r) {
  return {
    id: r.id,
    agenticAiId: r.agenticAiId,
    agenticAiVersion: r.agenticAiVersion,
    status: r.status,
    objective: r.objective ?? "",
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
  };
}

// ---- Agent CRUD ----
function listAgents() {
  return Object.values(store.agents)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(shapeAgent);
}
function getAgent(id) {
  const a = store.agents[id];
  return a ? shapeAgent(a) : undefined;
}
function createAgent(body = {}) {
  const name = requireName(body.name);
  if (!RUNTIME_PROVIDERS.has(body.runtimeProvider))
    throw err("bad_request", "runtimeProvider must be codex-cli|claude-cli");
  const sandboxMode = body.sandboxMode ?? "read-only";
  if (!SANDBOX_MODES.has(sandboxMode))
    throw err("bad_request", "sandboxMode must be read-only|workspace-write");
  const toolPolicies = cleanToolPolicies(body.toolPolicies);
  const ts = now();
  const agent = {
    id: newId("ag"),
    name,
    runtimeProvider: body.runtimeProvider,
    role: typeof body.role === "string" && body.role ? body.role : null,
    systemPrompt:
      typeof body.systemPrompt === "string" ? body.systemPrompt : "",
    sandboxMode,
    toolPolicies,
    model: typeof body.model === "string" && body.model ? body.model : null,
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  store.agents[agent.id] = agent;
  persist();
  return shapeAgent(agent);
}
function updateAgent(id, patch = {}, expectedRev) {
  const a = store.agents[id];
  if (!a) throw err("not_found", "agent not found");
  if (expectedRev !== undefined && expectedRev !== a.rev)
    throw err("stale", "agent revision is stale");
  if (patch.name !== undefined) a.name = requireName(patch.name);
  if (patch.runtimeProvider !== undefined) {
    if (!RUNTIME_PROVIDERS.has(patch.runtimeProvider))
      throw err("bad_request", "runtimeProvider must be codex-cli|claude-cli");
    a.runtimeProvider = patch.runtimeProvider;
  }
  if (patch.role !== undefined) a.role = patch.role ? String(patch.role) : null;
  if (patch.systemPrompt !== undefined)
    a.systemPrompt = String(patch.systemPrompt);
  if (patch.sandboxMode !== undefined) {
    if (!SANDBOX_MODES.has(patch.sandboxMode))
      throw err("bad_request", "sandboxMode must be read-only|workspace-write");
    a.sandboxMode = patch.sandboxMode;
  }
  if (patch.toolPolicies !== undefined)
    a.toolPolicies = cleanToolPolicies(patch.toolPolicies);
  if (patch.model !== undefined)
    a.model = patch.model ? String(patch.model) : null;
  touch(a);
  persist();
  return shapeAgent(a);
}
function deleteAgent(id) {
  if (!store.agents[id]) return false;
  delete store.agents[id];
  persist();
  return true;
}

// ---- Connection CRUD (POST/DELETE only — no PATCH, plan §3) ----
function listConnections() {
  return Object.values(store.connections)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(shapeConnection);
}
function getConnection(id) {
  const c = store.connections[id];
  return c ? shapeConnection(c) : undefined;
}
function createConnection(body = {}) {
  if (!CONNECTION_TARGETS.has(body.targetType))
    throw err("bad_request", "targetType must be pm|kanban");
  const scope = body.scope ?? "fixed";
  if (!CONNECTION_SCOPES.has(scope))
    throw err("bad_request", "scope must be fixed|runtime-selection");
  const conn = {
    id: newId("conn"),
    targetType: body.targetType,
    scope,
    targetId: body.targetId != null ? String(body.targetId) : null,
    createdAt: now(),
    rev: 1,
  };
  store.connections[conn.id] = conn;
  persist();
  return shapeConnection(conn);
}
function deleteConnection(id) {
  if (!store.connections[id]) return false;
  delete store.connections[id];
  persist();
  return true;
}

// ---- Agentic AI CRUD ----
function listAgenticAis() {
  return Object.values(store.agenticAis)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(shapeAgenticAiSummary);
}
function getAgenticAi(id) {
  const aa = store.agenticAis[id];
  return aa ? shapeAgenticAi(aa) : undefined;
}
function createAgenticAi(body = {}) {
  const name = requireName(body.name);
  const orchestrationMode = body.orchestrationMode ?? "single";
  if (!ORCH_MODES.has(orchestrationMode))
    throw err(
      "bad_request",
      "orchestrationMode must be single|supervisor|sequential|parallel",
    );
  // Validate workflow BEFORE mutating so a rejection leaves the store clean.
  const workflow = resolveWorkflow(body.workflow);
  const ts = now();
  const aa = {
    id: newId("aa"),
    name,
    description: typeof body.description === "string" ? body.description : "",
    objectiveTemplate:
      typeof body.objectiveTemplate === "string" ? body.objectiveTemplate : "",
    status: "draft",
    orchestrationMode,
    agentIds: Array.isArray(body.agentIds) ? body.agentIds.map(String) : [],
    connectionIds: Array.isArray(body.connectionIds)
      ? body.connectionIds.map(String)
      : [],
    workflow,
    version: 1,
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  store.agenticAis[aa.id] = aa;
  persist();
  return shapeAgenticAi(aa);
}
// A definition edit (D9): bumps `version` in addition to `rev`. Status changes
// go through setAgenticAiStatus and do NOT bump version.
function updateAgenticAi(id, patch = {}, expectedRev) {
  const aa = store.agenticAis[id];
  if (!aa) throw err("not_found", "agentic AI not found");
  if (expectedRev !== undefined && expectedRev !== aa.rev)
    throw err("stale", "agentic AI revision is stale");
  // Validate a new workflow BEFORE mutating.
  let nextWorkflow;
  if (patch.workflow !== undefined)
    nextWorkflow = resolveWorkflow(patch.workflow);
  if (patch.orchestrationMode !== undefined) {
    if (!ORCH_MODES.has(patch.orchestrationMode))
      throw err(
        "bad_request",
        "orchestrationMode must be single|supervisor|sequential|parallel",
      );
    aa.orchestrationMode = patch.orchestrationMode;
  }
  if (patch.name !== undefined) aa.name = requireName(patch.name);
  if (patch.description !== undefined)
    aa.description = String(patch.description);
  if (patch.objectiveTemplate !== undefined)
    aa.objectiveTemplate = String(patch.objectiveTemplate);
  if (patch.agentIds !== undefined)
    aa.agentIds = Array.isArray(patch.agentIds)
      ? patch.agentIds.map(String)
      : [];
  if (patch.connectionIds !== undefined)
    aa.connectionIds = Array.isArray(patch.connectionIds)
      ? patch.connectionIds.map(String)
      : [];
  if (nextWorkflow !== undefined) aa.workflow = nextWorkflow;
  aa.version += 1; // D9 — definition edit
  touch(aa);
  persist();
  return shapeAgenticAi(aa);
}
// "Publish" (D8): a status-field mutation. Bumps rev, NOT version.
function setAgenticAiStatus(id, status, expectedRev) {
  const aa = store.agenticAis[id];
  if (!aa) throw err("not_found", "agentic AI not found");
  if (expectedRev !== undefined && expectedRev !== aa.rev)
    throw err("stale", "agentic AI revision is stale");
  if (!APP_STATUSES.has(status))
    throw err("bad_request", "status must be draft|published|paused|archived");
  aa.status = status;
  touch(aa);
  persist();
  return shapeAgenticAi(aa);
}
function deleteAgenticAi(id) {
  if (!store.agenticAis[id]) return false;
  delete store.agenticAis[id];
  persist();
  return true;
}

// ---- Runs (read-only in iteration 1) ----
function listRuns() {
  return Object.values(store.runs)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .map(shapeRunSummary);
}
function getRun(id) {
  const r = store.runs[id];
  return r ? shapeRun(r) : undefined;
}

// ---- Run engine (STUBS — implemented in a later iteration) ----
const NOT_IMPLEMENTED = "not implemented until iter2 (run engine)";
function startRun() {
  throw err("bad_request", NOT_IMPLEMENTED);
}
function advanceRun() {
  throw err("bad_request", NOT_IMPLEMENTED);
}
function killRun() {
  throw err("bad_request", NOT_IMPLEMENTED);
}
function approveAction() {
  throw err("bad_request", NOT_IMPLEMENTED);
}
function rejectAction() {
  throw err("bad_request", NOT_IMPLEMENTED);
}

load();

export default {
  load,
  // Agents
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  // Connections
  listConnections,
  getConnection,
  createConnection,
  deleteConnection,
  // Agentic AIs
  listAgenticAis,
  getAgenticAi,
  createAgenticAi,
  updateAgenticAi,
  setAgenticAiStatus,
  deleteAgenticAi,
  // Runs (read-only in iter1)
  listRuns,
  getRun,
  // Run engine stubs (iter2)
  startRun,
  advanceRun,
  killRun,
  approveAction,
  rejectAction,
};
