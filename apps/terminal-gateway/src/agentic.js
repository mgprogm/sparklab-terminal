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

// Terminal statuses (used by the run-engine primitives below).
const NODE_TERMINAL = new Set(["done", "failed", "skipped"]);
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting-approval",
  "completed",
  "failed",
  "cancelled",
]);
const RUN_TERMINAL = new Set(["completed", "failed", "cancelled"]);
// Fan-out cap for parallel groups — decide() returns at most this many toSpawn
// ids (minus the count already running), so a wide group spawns in waves. Same
// env name server.js reads for its own cap; the two share the value.
const AGENT_MAX_PARALLEL_FANOUT =
  Number(process.env.AGENT_MAX_PARALLEL_FANOUT) || 4;

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

// Referential-integrity guard (the write-side half of the delete-scrub below,
// mirrors pm.js validating a task's dependsOn against live task ids). Rejects an
// agentIds/connectionIds array that points at an id not in the store so a
// dangling reference can never be persisted in the first place. NOTE: workflow
// NODE agentIds are deliberately NOT validated here — a node may legitimately be
// authored before its agent is wired, and node-agentId resolution is startRun's
// job (iter2). Only the top-level agentIds/connectionIds arrays are checked.
function assertKnownIds(ids, collection, kind) {
  if (ids === undefined) return;
  if (!Array.isArray(ids)) throw err("bad_request", `${kind} must be an array`);
  for (const raw of ids) {
    const id = String(raw);
    if (!collection[id])
      throw err("bad_request", `${kind} references unknown id: ${id}`, {
        [kind]: id,
      });
  }
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

// Reject a toolPolicy whose connectionId does not resolve to a live connection
// (the write-side complement to deleteConnection's scrub below).
function assertKnownToolPolicyConnections(policies) {
  for (const p of policies) {
    if (!store.connections[p.connectionId])
      throw err(
        "bad_request",
        `toolPolicy references unknown connection: ${p.connectionId}`,
        { connectionId: p.connectionId },
      );
  }
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
    // WorkflowNode.type is CLOSED to "agent-task" in iter2 (matches shared-types
    // WorkflowNodeSchema.type = z.enum(["agent-task"])). Reject any other type at
    // the store boundary so a "router"/etc node can never reach the run engine.
    const type = n.type ? String(n.type) : "agent-task";
    if (type !== "agent-task")
      throw err("invalid_workflow", `unsupported node type: ${type}`, {
        node: id,
      });
    cleanNodes.push({
      id,
      type,
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
    // logTail is a DISPLAY-ONLY passthrough injected by server.js on GET (a tail
    // of the step's out.log). It is NEVER persisted; the internal spawnAttempts
    // counter is likewise never shaped (it's read via getSpawnAttempts()).
    ...(ne.logTail != null ? { logTail: ne.logTail } : {}),
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
  assertKnownToolPolicyConnections(toolPolicies);
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
  if (patch.toolPolicies !== undefined) {
    const next = cleanToolPolicies(patch.toolPolicies);
    assertKnownToolPolicyConnections(next);
    a.toolPolicies = next;
  }
  if (patch.model !== undefined)
    a.model = patch.model ? String(patch.model) : null;
  touch(a);
  persist();
  return shapeAgent(a);
}
// Delete an agent and SCRUB every dangling reference to it (mirrors pm.js
// scrubbing a deleted task's id out of every other task's dependsOn). For each
// AgenticAI we drop the id from agentIds[] and null the agentId on any
// workflow node that pointed at it — the node is KEPT (removing it would dangle
// its edges); a definition edit bumps version+rev. All scrubbing happens BEFORE
// the delete and there is exactly ONE persist() at the end (kept synchronous +
// atomic, per the store's no-mutex convention).
function deleteAgent(id) {
  if (!store.agents[id]) return false; // early-out ahead of any persist
  for (const aa of Object.values(store.agenticAis)) {
    let changed = false;
    if (Array.isArray(aa.agentIds) && aa.agentIds.includes(id)) {
      aa.agentIds = aa.agentIds.filter((x) => x !== id);
      changed = true;
    }
    const nodes = aa.workflow && aa.workflow.nodes;
    if (Array.isArray(nodes)) {
      for (const n of nodes) {
        if (n && n.agentId === id) {
          delete n.agentId; // clear the ref, keep the node (don't dangle edges)
          changed = true;
        }
      }
    }
    if (changed) {
      aa.version += 1; // D9 — definition edit
      touch(aa);
    }
  }
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
// Delete a connection and SCRUB every dangling reference to it: drop the id from
// each AgenticAI's connectionIds[] (a definition edit → version+rev) and from
// each Agent's toolPolicies[] (a plain rev bump — agents carry no version).
// One persist() at the end (synchronous + atomic, no mutex).
function deleteConnection(id) {
  if (!store.connections[id]) return false; // early-out ahead of any persist
  for (const aa of Object.values(store.agenticAis)) {
    if (Array.isArray(aa.connectionIds) && aa.connectionIds.includes(id)) {
      aa.connectionIds = aa.connectionIds.filter((x) => x !== id);
      aa.version += 1; // D9 — definition edit
      touch(aa);
    }
  }
  for (const a of Object.values(store.agents)) {
    if (
      Array.isArray(a.toolPolicies) &&
      a.toolPolicies.some((p) => p.connectionId === id)
    ) {
      a.toolPolicies = a.toolPolicies.filter((p) => p.connectionId !== id);
      touch(a); // rev bump only (agents carry no version)
    }
  }
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
  // Validate refs + workflow BEFORE mutating so a rejection leaves the store
  // clean. agentIds/connectionIds must resolve to live records (the write-side
  // complement to the delete-scrub in deleteAgent/deleteConnection).
  assertKnownIds(body.agentIds, store.agents, "agentIds");
  assertKnownIds(body.connectionIds, store.connections, "connectionIds");
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
  // Validate refs + a new workflow BEFORE mutating.
  assertKnownIds(patch.agentIds, store.agents, "agentIds");
  assertKnownIds(patch.connectionIds, store.connections, "connectionIds");
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

// ---------------------------------------------------------------------------
// Run engine — SYNC/ATOMIC store primitives + the PURE decide() reducer (iter2)
// ---------------------------------------------------------------------------
// DELIBERATE SPLIT (resolves the task's "implement startRun/advanceRun/killRun
// in the store" wording vs. hard-constraint #3 "agentic.js stays synchronous-
// atomic, no mutex"): the async tmux/marker I/O those drivers need CANNOT live
// in a synchronous mutator. So this file keeps ONLY pure/sync pieces —
//   - a PURE decide(run, resolvedConfig) reducer (no I/O; reads the persisted
//     nodeExecutions[] ledger, returns a decision object), and
//   - sync atomic recorders (createRunRecord/recordSpawned/recordNodeResult/
//     setRunStatus), each persisting exactly once (PM/kanban convention).
// The async orchestration (startRun/advanceRun/killRun, tmux spawn, marker reap,
// poll loop, boot rediscovery) lives in server.js, which composes these sync
// primitives with its tmux exec seam — keeping the gateway the single tmux
// enforcement point AND agentic.js a structural clone of pm.js.
//
// approveAction/rejectAction remain THROWING stubs (human-approval nodes are
// iter3). startRun/advanceRun/killRun are NO LONGER store methods — the route
// handler calls the server.js drivers, not the store.

function findRun(runId) {
  const r = store.runs[runId];
  if (!r) throw err("not_found", "run not found");
  return r;
}
function findNode(run, nodeId) {
  const ne = (run.nodeExecutions || []).find((n) => n.nodeId === nodeId);
  if (!ne) throw err("not_found", `node execution not found: ${nodeId}`);
  return ne;
}

// Insert a run-<uuid> with status:"running", startedAt, and a nodeExecutions[]
// pre-seeded one entry per frozen workflow node at status:"pending". The frozen
// resolvedConfig (agents+workflow+toolPolicies snapshot, D9) + agenticAiVersion
// are stored so a later agent/app edit can never change a running run. Persists
// once. `nodeExecutions` may be passed explicitly (server.js builds it from the
// resolved workflow); otherwise it is derived from resolvedConfig.workflow.nodes.
function createRunRecord({
  agenticAiId,
  sessionId,
  objective,
  resolvedConfig,
  agenticAiVersion,
  nodeExecutions,
} = {}) {
  const ts = now();
  let seeded;
  if (Array.isArray(nodeExecutions) && nodeExecutions.length) {
    seeded = nodeExecutions.map((ne) => ({
      nodeId: String(ne.nodeId),
      status: "pending",
      parentNodeId: ne.parentNodeId != null ? String(ne.parentNodeId) : null,
    }));
  } else {
    const nodes =
      (resolvedConfig &&
        resolvedConfig.workflow &&
        resolvedConfig.workflow.nodes) ||
      [];
    seeded = nodes.map((n) => ({
      nodeId: String(n.id),
      status: "pending",
      parentNodeId: null,
    }));
  }
  const run = {
    id: newId("run"),
    agenticAiId: String(agenticAiId),
    agenticAiVersion: Number(agenticAiVersion) || 0,
    resolvedConfig: resolvedConfig
      ? JSON.parse(JSON.stringify(resolvedConfig))
      : undefined,
    sessionId: sessionId != null ? String(sessionId) : null,
    objective: typeof objective === "string" ? objective : "",
    status: "running",
    nodeExecutions: seeded,
    startedAt: ts,
    finishedAt: null,
  };
  store.runs[run.id] = run;
  persist();
  return shapeRun(run);
}

// Run ids whose status is still active (running|queued; iter2 never produces
// waiting-approval). Drives the poll-loop gating and boot rediscovery. Pure read.
function listActiveRuns() {
  return Object.values(store.runs)
    .filter((r) => r.status === "running" || r.status === "queued")
    .map((r) => r.id);
}

// Mark a node RUNNING and tie it to its tmux job. Increments an internal
// spawnAttempts counter (persisted to disk for restart-safety — the reap table's
// "never-ran → respawn unless attempts>=2" cap — but NEVER shaped/in shared-types).
// PERSISTS BEFORE the caller spawns tmux (ordering is load-bearing: a crash after
// this persist but before spawn leaves a "running" node with no session/markers,
// which the reap table re-spawns idempotently rather than losing).
function recordSpawned(runId, nodeId, { agentRunId, startedAt } = {}) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.status = "running";
  if (agentRunId != null) ne.agentRunId = String(agentRunId);
  ne.startedAt = startedAt != null ? Number(startedAt) : now();
  ne.finishedAt = null;
  ne.spawnAttempts = (ne.spawnAttempts || 0) + 1;
  persist();
  return shapeRun(run);
}

// The internal (un-shaped) spawn-attempt counter for a node, 0 if none. Read by
// the server.js reap table; kept off the wire shape by design.
function getSpawnAttempts(runId, nodeId) {
  const r = store.runs[runId];
  if (!r) return 0;
  const ne = (r.nodeExecutions || []).find((n) => n.nodeId === nodeId);
  return ne && ne.spawnAttempts ? ne.spawnAttempts : 0;
}

// Record a node's TERMINAL result (done|failed|skipped) + finishedAt. Persists.
function recordNodeResult(runId, nodeId, { status, finishedAt } = {}) {
  if (!NODE_TERMINAL.has(status))
    throw err("bad_request", "node status must be done|failed|skipped");
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.status = status;
  ne.finishedAt = finishedAt != null ? Number(finishedAt) : now();
  persist();
  return shapeRun(run);
}

// Set the run status (+ finishedAt when terminal). On a terminal run
// (completed|failed|cancelled) every still-pending node flips to skipped so the
// ledger has no dangling "pending" after the run ends. Persists.
function setRunStatus(runId, status, { finishedAt } = {}) {
  if (!RUN_STATUSES.has(status))
    throw err("bad_request", `invalid run status: ${status}`);
  const run = findRun(runId);
  run.status = status;
  if (RUN_TERMINAL.has(status)) {
    const ts = finishedAt != null ? Number(finishedAt) : now();
    run.finishedAt = ts;
    for (const ne of run.nodeExecutions || []) {
      if (ne.status === "pending") {
        ne.status = "skipped";
        ne.finishedAt = ts;
      }
    }
  }
  persist();
  return shapeRun(run);
}

// PURE reducer (no I/O). Given the current ledger + frozen config, returns:
//   { toSpawn: [nodeId,…]  pending nodes whose EVERY in-edge predecessor is done,
//     running: [nodeId,…]  nodes currently running (caller reaps via tmux/markers),
//     terminal: null | "completed" | "failed" }
// Rules (walk the frozen resolvedConfig.workflow DAG):
//   - ready  ⇔ status:"pending" AND every predecessor (in-edge `from`) is done.
//              Entry / no-predecessor nodes are ready immediately — this uniformly
//              covers single, sequential, supervisor, and parallel.
//   - terminal:"failed"    ⇔ ANY node is failed (fail-fast).
//   - terminal:"completed" ⇔ every node is done|skipped.
//   - fan-out cap: at most AGENT_MAX_PARALLEL_FANOUT toSpawn ids MINUS the count
//     already running, so a wide parallel group spawns in waves.
// Recomputed fresh on every call — the ledger is the ONLY source of truth, so a
// gateway crash mid-advance is harmless (the next call re-derives from disk).
function decide(run, resolvedConfig) {
  const nodeExecs = (run && run.nodeExecutions) || [];
  const byId = new Map(nodeExecs.map((ne) => [ne.nodeId, ne]));
  const workflow = (resolvedConfig && resolvedConfig.workflow) || {};
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

  const preds = new Map();
  for (const ne of nodeExecs) preds.set(ne.nodeId, []);
  for (const e of edges) {
    if (preds.has(e.to)) preds.get(e.to).push(e.from);
  }

  const running = nodeExecs
    .filter((ne) => ne.status === "running")
    .map((ne) => ne.nodeId);

  // Fail-fast: any failed node terminates the whole run (the driver kills any
  // still-running siblings before flipping the run to failed).
  if (nodeExecs.some((ne) => ne.status === "failed"))
    return { toSpawn: [], running, terminal: "failed" };

  // Completed: every node terminal-and-not-failed (done|skipped). Empty ledger
  // is trivially complete.
  if (nodeExecs.every((ne) => ne.status === "done" || ne.status === "skipped"))
    return { toSpawn: [], running, terminal: "completed" };

  const ready = [];
  for (const ne of nodeExecs) {
    if (ne.status !== "pending") continue;
    const ps = preds.get(ne.nodeId) || [];
    const ok = ps.every((pid) => {
      const p = byId.get(pid);
      return p && p.status === "done";
    });
    if (ok) ready.push(ne.nodeId);
  }
  const budget = Math.max(0, AGENT_MAX_PARALLEL_FANOUT - running.length);
  return { toSpawn: ready.slice(0, budget), running, terminal: null };
}

// ---- Human-approval nodes (iter3) — still THROWING stubs ----
function approveAction() {
  throw err("bad_request", "approveAction is iter3 (human-approval nodes)");
}
function rejectAction() {
  throw err("bad_request", "rejectAction is iter3 (human-approval nodes)");
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
  // Runs (read + engine primitives)
  listRuns,
  getRun,
  // Run-engine sync primitives (iter2) — server.js composes these with tmux I/O.
  createRunRecord,
  listActiveRuns,
  recordSpawned,
  getSpawnAttempts,
  recordNodeResult,
  setRunStatus,
  decide,
  // Human-approval nodes (iter3) — throwing stubs.
  approveAction,
  rejectAction,
};
