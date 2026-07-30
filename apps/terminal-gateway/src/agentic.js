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
//
// ITERATION 3 (this pass): the approval ledger for the per-run MCP proxy (D5).
// A nodeExecution gains an optional, PERSISTED `pendingToolCall` record (unlike
// `logTail`, which is display-only and injected by server.js on GET). A Run
// gains a bounded `toolCallLog[]` audit trail (cap TOOL_CALL_LOG_CAP, oldest
// trimmed). Status transitions: recordPendingToolCall flips the node AND the
// run to "waiting-approval" (already a reserved enum value never produced
// before now); resolvePendingToolCall (approve/reject/timeout) flips the node
// back to "running" (the underlying tmux job never stopped — it's still
// blocked inside the CLI's tool call) and flips the run back to "running" ONLY
// if no other node in it is still waiting-approval (parallel fan-out can park
// more than one node at once). approveAction/rejectAction stop throwing and
// resolve "the current pending record for this node" via resolvePendingToolCall.
// decide() is UNCHANGED — "waiting-approval" matches none of its branches, so a
// parked run is correctly neither reaped-as-running nor completed nor
// re-offered as ready (see decide()'s own comment for why).
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
const ORCH_MODES = new Set([
  "single",
  "supervisor",
  "sequential",
  "parallel",
  "custom",
]);

// Terminal statuses (used by the run-engine primitives below).
const NODE_TERMINAL = new Set(["done", "failed", "skipped"]);
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting-approval",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
const RUN_TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
// Fan-out cap for parallel groups — decide() returns at most this many toSpawn
// ids (minus the count already running), so a wide group spawns in waves. Same
// env name server.js reads for its own cap; the two share the value.
const AGENT_MAX_PARALLEL_FANOUT =
  Number(process.env.AGENT_MAX_PARALLEL_FANOUT) || 4;
const configuredRetryAttemptsCap = Number(process.env.AGENT_RETRY_MAX_ATTEMPTS);
const RETRY_MAX_ATTEMPTS_CAP =
  Number.isInteger(configuredRetryAttemptsCap) &&
  configuredRetryAttemptsCap >= 1
    ? configuredRetryAttemptsCap
    : 5;
const configuredRetryBackoffCap = Number(
  process.env.AGENT_RETRY_BACKOFF_MAX_MS,
);
const AGENT_RETRY_BACKOFF_MAX_MS =
  Number.isFinite(configuredRetryBackoffCap) && configuredRetryBackoffCap >= 0
    ? configuredRetryBackoffCap
    : 60_000;
const configuredLoopIterationsCap = Number(
  process.env.AGENT_LOOP_MAX_ITERATIONS,
);
const AGENT_LOOP_MAX_ITERATIONS =
  Number.isInteger(configuredLoopIterationsCap) &&
  configuredLoopIterationsCap >= 1
    ? configuredLoopIterationsCap
    : 8;
const configuredLoopBackoffCap = Number(process.env.AGENT_LOOP_BACKOFF_MAX_MS);
const AGENT_LOOP_BACKOFF_MAX_MS =
  Number.isFinite(configuredLoopBackoffCap) && configuredLoopBackoffCap >= 0
    ? configuredLoopBackoffCap
    : 60_000;
// Bound on Run.toolCallLog[] (iter3) — oldest entries trimmed on append, same
// "bounded" idiom as the push-notification history elsewhere in this repo.
const TOOL_CALL_LOG_CAP = 200;
const PENDING_DECISIONS = new Set(["approved", "rejected", "timed_out"]);

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

function cleanBudget(raw) {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw err("bad_request", "budget must be an object");
  const budget = {};
  for (const key of ["maxSpawns", "maxWallClockMs"]) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] <= 0)
      throw err("bad_request", `budget.${key} must be a positive integer`);
    budget[key] = raw[key];
  }
  return budget;
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
    // WorkflowNode.type is closed to executable tasks, routers, and human gates.
    const type = n.type ? String(n.type) : "agent-task";
    if (type !== "agent-task" && type !== "human-approval" && type !== "router")
      throw err("invalid_workflow", `unsupported node type: ${type}`, {
        node: id,
      });
    let retryPolicy;
    if ((type === "agent-task" || type === "router") && n.retryPolicy != null) {
      if (
        !n.retryPolicy ||
        typeof n.retryPolicy !== "object" ||
        Array.isArray(n.retryPolicy)
      )
        throw err("invalid_workflow", "retryPolicy must be an object", {
          node: id,
        });
      const maxAttempts =
        n.retryPolicy.maxAttempts == null ? 1 : n.retryPolicy.maxAttempts;
      const backoffMs =
        n.retryPolicy.backoffMs == null ? 0 : n.retryPolicy.backoffMs;
      const retryOn =
        n.retryPolicy.retryOn == null ? "failure" : n.retryPolicy.retryOn;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
        throw err(
          "invalid_workflow",
          "retryPolicy.maxAttempts must be a positive integer",
          { node: id },
        );
      if (!Number.isInteger(backoffMs) || backoffMs < 0)
        throw err(
          "invalid_workflow",
          "retryPolicy.backoffMs must be a non-negative integer",
          { node: id },
        );
      if (retryOn !== "failure")
        throw err("invalid_workflow", 'retryPolicy.retryOn must be "failure"', {
          node: id,
        });
      retryPolicy = {
        maxAttempts: Math.min(maxAttempts, RETRY_MAX_ATTEMPTS_CAP),
        backoffMs: Math.min(backoffMs, AGENT_RETRY_BACKOFF_MAX_MS),
        retryOn,
      };
    }
    let loopPolicy;
    if (n.loopPolicy !== undefined) {
      if (type !== "agent-task")
        throw err(
          "invalid_workflow",
          "loopPolicy is only allowed on agent-task nodes",
          { node: id },
        );
      if (
        !n.loopPolicy ||
        typeof n.loopPolicy !== "object" ||
        Array.isArray(n.loopPolicy)
      )
        throw err("invalid_workflow", "loopPolicy must be an object", {
          node: id,
        });
      const maxIterations =
        n.loopPolicy.maxIterations == null ? 1 : n.loopPolicy.maxIterations;
      const until = n.loopPolicy.until == null ? "done" : n.loopPolicy.until;
      const backoffMs =
        n.loopPolicy.backoffMs == null ? 0 : n.loopPolicy.backoffMs;
      if (!Number.isInteger(maxIterations) || maxIterations < 1)
        throw err(
          "invalid_workflow",
          "loopPolicy.maxIterations must be a positive integer",
          { node: id },
        );
      if (typeof until !== "string" || !/^\S+$/.test(until))
        throw err(
          "invalid_workflow",
          "loopPolicy.until must be a single non-whitespace token",
          { node: id },
        );
      if (!Number.isInteger(backoffMs) || backoffMs < 0)
        throw err(
          "invalid_workflow",
          "loopPolicy.backoffMs must be a non-negative integer",
          { node: id },
        );
      loopPolicy = {
        maxIterations: Math.min(maxIterations, AGENT_LOOP_MAX_ITERATIONS),
        until,
        backoffMs: Math.min(backoffMs, AGENT_LOOP_BACKOFF_MAX_MS),
      };
    }
    cleanNodes.push({
      id,
      type,
      ...((type === "agent-task" || type === "router") && n.agentId != null
        ? { agentId: String(n.agentId) }
        : {}),
      ...(retryPolicy ? { retryPolicy } : {}),
      ...(loopPolicy ? { loopPolicy } : {}),
    });
  }

  const cleanEdges = [];
  const adj = new Map();
  const outEdges = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const id of nodeIds) outEdges.set(id, []);
  for (const e of edges) {
    if (!e || typeof e !== "object")
      throw err("invalid_workflow", "each edge must be an object");
    const from = String(e.from);
    const to = String(e.to);
    if (!nodeIds.has(from) || !nodeIds.has(to))
      throw err("invalid_workflow", `edge references unknown node`, {
        edge: { from, to },
      });
    const on = e.on == null || e.on === "" ? null : String(e.on);
    const when = e.when == null || e.when === "" ? null : String(e.when);
    if (on != null && when != null)
      throw err("invalid_workflow", "edge may set only one of on or when", {
        edge: { from, to },
      });
    if (on != null && on !== "success" && on !== "failure")
      throw err("invalid_workflow", "edge.on must be success|failure", {
        edge: { from, to },
      });
    if (when != null && !when.length)
      throw err("invalid_workflow", "edge.when must be non-empty", {
        edge: { from, to },
      });
    const cleanEdge = {
      from,
      to,
      ...(on != null ? { on } : {}),
      ...(when != null ? { when } : {}),
    };
    cleanEdges.push(cleanEdge);
    outEdges.get(from).push(cleanEdge);
    adj.get(from).push(to);
  }

  const nodesById = new Map(cleanNodes.map((n) => [n.id, n]));
  for (const [nodeId, outs] of outEdges) {
    const node = nodesById.get(nodeId);
    if (node.type === "router" && outs.length === 0)
      throw err("invalid_workflow", "router must have outgoing branches", {
        node: nodeId,
      });
    if (outs.length === 0) continue;

    const kinds = new Set(
      outs.map((e) =>
        e.on != null ? "on" : e.when != null ? "when" : "plain",
      ),
    );
    if (kinds.size !== 1)
      throw err("invalid_workflow", "node out-edges must use one label kind", {
        node: nodeId,
      });
    const kind = kinds.values().next().value;
    if (node.type === "router" && kind !== "when")
      throw err("invalid_workflow", "router out-edges must use when labels", {
        node: nodeId,
      });
    if (node.type !== "router" && kind === "when")
      throw err("invalid_workflow", "when edges require a router", {
        node: nodeId,
      });
    if (kind === "on") {
      if (node.type !== "agent-task")
        throw err("invalid_workflow", "on edges require an agent-task", {
          node: nodeId,
        });
      const labels = new Set();
      for (const edge of outs) {
        if (labels.has(edge.on))
          throw err("invalid_workflow", `duplicate on label: ${edge.on}`, {
            edge: { from: edge.from, to: edge.to },
          });
        labels.add(edge.on);
      }
    }
    if (kind === "when") {
      const labels = new Set();
      for (const edge of outs) {
        if (labels.has(edge.when))
          throw err("invalid_workflow", `duplicate when label: ${edge.when}`, {
            edge: { from: edge.from, to: edge.to },
          });
        labels.add(edge.when);
      }
      if (!labels.has("default"))
        throw err("invalid_workflow", "router requires a default branch", {
          node: nodeId,
        });
    }
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
      ...(n.retryPolicy != null ? { retryPolicy: { ...n.retryPolicy } } : {}),
      ...(n.loopPolicy != null ? { loopPolicy: { ...n.loopPolicy } } : {}),
    })),
    edges: (w.edges || []).map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.on != null ? { on: e.on } : {}),
      ...(e.when != null ? { when: e.when } : {}),
    })),
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
    ...(aa.budget != null ? { budget: { ...aa.budget } } : {}),
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
    ...(ne.turns > 1 ? { turns: ne.turns } : {}),
    ...(ne.error != null ? { error: ne.error } : {}),
    ...(ne.agentRunId != null ? { agentRunId: ne.agentRunId } : {}),
    ...(ne.parentNodeId != null ? { parentNodeId: ne.parentNodeId } : {}),
    ...(ne.startedAt != null ? { startedAt: ne.startedAt } : {}),
    ...(ne.finishedAt != null ? { finishedAt: ne.finishedAt } : {}),
    ...(ne.chosenEdges != null ? { chosenEdges: [...ne.chosenEdges] } : {}),
    // score is display-only metadata; decide() and routing/skip logic must never read it.
    ...(Number.isFinite(ne.score) ? { score: Number(ne.score) } : {}),
    // Bounded-loop fields are display-only; driver phase state stays off-wire.
    ...(ne.iterationCount > 1 ? { iterationCount: ne.iterationCount } : {}),
    ...(ne.loopExhausted === true ? { loopExhausted: true } : {}),
    ...(ne.lastVerdict != null ? { lastVerdict: ne.lastVerdict } : {}),
    // pendingToolCall IS persisted (iter3) — the current/last MCP tool-call
    // approval record for this node, or absent if none has ever been posted.
    ...(ne.pendingToolCall != null
      ? { pendingToolCall: { ...ne.pendingToolCall } }
      : {}),
    // logTail is a DISPLAY-ONLY passthrough injected by server.js on GET (a tail
    // of the step's out.log). It is NEVER persisted; the internal spawnAttempts
    // counter is likewise never shaped (it's read via getSpawnAttempts()).
    ...(ne.logTail != null ? { logTail: ne.logTail } : {}),
  };
}

function shapeRun(r) {
  const spawnsUsed = (r.nodeExecutions || []).reduce(
    (sum, ne) => sum + (ne.spawnAttempts || 0),
    0,
  );
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
    spawnsUsed,
    ...(r.budgetHalt === true ? { budgetHalt: true } : {}),
    budget:
      r.resolvedConfig?.budget != null ? { ...r.resolvedConfig.budget } : null,
    // Bounded audit log (iter3) — allow/deny/approved/rejected/timed_out
    // dispositions, oldest trimmed at TOOL_CALL_LOG_CAP. Always present
    // (defaults to []), matching shared-types' RunSchema default.
    toolCallLog: JSON.parse(JSON.stringify(r.toolCallLog || [])),
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
  const budget = cleanBudget(body.budget);
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
    ...(budget !== undefined ? { budget } : {}),
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
  const nextBudget =
    patch.budget !== undefined ? cleanBudget(patch.budget) : undefined;
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
  if (patch.budget !== undefined) {
    if (nextBudget === undefined) delete aa.budget;
    else aa.budget = nextBudget;
  }
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

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
}

// Hash only the complete executable closure. Schedule-owned target/objective
// fields deliberately stay outside this projection.
function fingerprintExecutableDefinition(agenticId) {
  const app = store.agenticAis[agenticId];
  if (!app) throw err("not_found", "agentic AI not found");

  const agentIds = [];
  const seenAgents = new Set();
  const addAgentId = (id) => {
    if (id == null || id === "") return;
    const normalized = String(id);
    if (!seenAgents.has(normalized)) {
      seenAgents.add(normalized);
      agentIds.push(normalized);
    }
  };
  for (const id of app.agentIds || []) addAgentId(id);
  for (const node of app.workflow?.nodes || []) addAgentId(node?.agentId);

  const agents = {};
  const connectionIds = [];
  const seenConnections = new Set();
  const addConnectionId = (id) => {
    if (id == null || id === "") return;
    const normalized = String(id);
    if (!seenConnections.has(normalized)) {
      seenConnections.add(normalized);
      connectionIds.push(normalized);
    }
  };
  for (const id of app.connectionIds || []) addConnectionId(id);

  for (const id of agentIds) {
    const agent = store.agents[id];
    if (!agent)
      throw err("bad_request", `agentic AI references unknown agent: ${id}`);
    agents[id] = {
      runtimeProvider: agent.runtimeProvider,
      systemPrompt: agent.systemPrompt,
      sandboxMode: agent.sandboxMode,
      model: agent.model,
      toolPolicies: agent.toolPolicies,
    };
    for (const policy of agent.toolPolicies || [])
      addConnectionId(policy?.connectionId);
  }

  const connections = {};
  for (const id of connectionIds) {
    const connection = store.connections[id];
    if (!connection)
      throw err(
        "bad_request",
        `agentic AI references unknown connection: ${id}`,
      );
    connections[id] = {
      targetType: connection.targetType,
      targetId: connection.targetId,
    };
  }

  const projection = {
    app: {
      orchestrationMode: app.orchestrationMode,
      objectiveTemplate: app.objectiveTemplate,
      workflow: {
        nodes: app.workflow?.nodes || [],
        edges: app.workflow?.edges || [],
      },
      agentIds: app.agentIds || [],
      connectionIds: app.connectionIds || [],
      budget: app.budget,
    },
    agents,
    connections,
  };
  const normalized = sortObjectKeys(projection);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
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
// approveAction/rejectAction are now REAL (iter3, per-run MCP proxy approval
// mediation, D5) — see the pending-tool-call section further down. startRun/
// advanceRun/killRun are NO LONGER store methods — the route handler calls the
// server.js drivers, not the store.

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
  scheduleId,
  unattended,
} = {}) {
  const ts = now();
  let seeded;
  if (Array.isArray(nodeExecutions) && nodeExecutions.length) {
    seeded = nodeExecutions.map((ne) => ({
      nodeId: String(ne.nodeId),
      status: "pending",
      turns: 1,
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
      turns: 1,
      parentNodeId: null,
    }));
  }
  let frozenResolvedConfig = resolvedConfig
    ? JSON.parse(JSON.stringify(resolvedConfig))
    : undefined;
  if (scheduleId !== undefined || unattended !== undefined) {
    frozenResolvedConfig = frozenResolvedConfig || {};
    if (scheduleId !== undefined)
      frozenResolvedConfig.scheduleId =
        scheduleId == null ? null : String(scheduleId);
    if (unattended !== undefined)
      frozenResolvedConfig.unattended = Boolean(unattended);
  }
  const run = {
    id: newId("run"),
    agenticAiId: String(agenticAiId),
    agenticAiVersion: Number(agenticAiVersion) || 0,
    resolvedConfig: frozenResolvedConfig,
    sessionId: sessionId != null ? String(sessionId) : null,
    objective: typeof objective === "string" ? objective : "",
    status: "running",
    nodeExecutions: seeded,
    toolCallLog: [],
    startedAt: ts,
    finishedAt: null,
  };
  store.runs[run.id] = run;
  persist();
  return shapeRun(run);
}

// Run ids whose status is still active (running|queued|waiting-approval — iter3
// adds waiting-approval: a run parked on an MCP tool-call approval still has a
// live tmux job blocked inside the CLI, and MUST keep being tracked so the
// poll-loop/boot-rediscovery/sweep machinery below can resolve it). Drives the
// poll-loop gating and boot rediscovery. Pure read.
function listActiveRuns() {
  return Object.values(store.runs)
    .filter(
      (r) =>
        r.status === "running" ||
        r.status === "queued" ||
        r.status === "waiting-approval",
    )
    .map((r) => r.id);
}

function activeRunsForSchedule(scheduleId) {
  return listActiveRuns()
    .map((id) => getRun(id))
    .filter((run) => run?.resolvedConfig?.scheduleId === scheduleId);
}

// Raw node access for the server-side run driver. Internal fields such as the
// provider conversation id are deliberately kept out of shapeNodeExecution.
function getNode(runId, nodeId) {
  return findNode(findRun(runId), nodeId);
}

// Mark a node RUNNING and tie it to its tmux job. Increments an internal
// spawnAttempts counter (persisted to disk for restart-safety — the reap table's
// "never-ran → respawn unless attempts>=2" cap — but NEVER shaped/in shared-types).
// PERSISTS BEFORE the caller spawns tmux (ordering is load-bearing: a crash after
// this persist but before spawn leaves a "running" node with no session/markers,
// which the reap table re-spawns idempotently rather than losing).
function recordSpawned(
  runId,
  nodeId,
  { agentRunId, startedAt, providerSessionId } = {},
) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.status = "running";
  if (agentRunId != null) ne.agentRunId = String(agentRunId);
  if (providerSessionId != null)
    ne.providerSessionId = String(providerSessionId);
  if (!ne.turns) ne.turns = 1;
  ne.startedAt = startedAt != null ? Number(startedAt) : now();
  ne.finishedAt = null;
  ne.spawnAttempts = (ne.spawnAttempts || 0) + 1;
  if (ne.iterationCount == null) ne.iterationCount = 1;
  delete ne.retryPending;
  delete ne.loopPending;
  delete ne.neverRanPending;
  persist();
  return shapeRun(run);
}

// Resume a completed provider conversation as another turn on the same node.
function recordGuidanceTurn(runId, nodeId, { agentRunId, startedAt } = {}) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  if (ne.status !== "done")
    throw err("bad_request", "guidance is only allowed on a completed step");
  ne.status = "running";
  if (agentRunId != null) ne.agentRunId = String(agentRunId);
  ne.startedAt = startedAt != null ? Number(startedAt) : now();
  ne.finishedAt = null;
  delete ne.error;
  ne.turns = (ne.turns || 1) + 1;
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

// Failure retries are distinct from spawnAttempts: retryCount is the number of
// retry respawns committed after a ran-and-failed attempt. retryPending closes
// the crash window between committing that decision and recordSpawned(). Both
// fields are persisted but deliberately remain off the wire.
function recordRetryAttempt(runId, nodeId) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  if (!ne.retryPending) ne.retryCount = (ne.retryCount || 0) + 1;
  ne.retryPending = true;
  persist();
  return shapeRun(run);
}

function getRetryState(runId, nodeId) {
  const r = store.runs[runId];
  const ne = r && (r.nodeExecutions || []).find((n) => n.nodeId === nodeId);
  return {
    retryCount: ne && ne.retryCount ? ne.retryCount : 0,
    retryPending: Boolean(ne && ne.retryPending),
  };
}

// Bounded-loop iteration state mirrors retry state: commit the next iteration
// before respawning, then recordSpawned() clears the pending phase flag.
function commitLoopIteration(runId, nodeId, { verdict } = {}) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.loopPending = true;
  ne.iterationCount = (ne.iterationCount || 1) + 1;
  ne.retryCount = 0;
  ne.lastVerdict = String(verdict);
  persist();
  return shapeRun(run);
}

function getLoopState(runId, nodeId) {
  const r = store.runs[runId];
  const ne = r && (r.nodeExecutions || []).find((n) => n.nodeId === nodeId);
  return {
    iterationCount: ne && ne.iterationCount ? ne.iterationCount : 1,
    loopPending: Boolean(ne && ne.loopPending),
    lastVerdict: ne ? ne.lastVerdict : undefined,
    sessionEstablished: Boolean(ne && ne.sessionEstablished),
    iterationInvocation:
      ne && ne.iterationInvocation ? { ...ne.iterationInvocation } : undefined,
  };
}

function commitNeverRanRecovery(runId, nodeId) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.neverRanPending = true;
  ne.neverRanRecoveryCount = (ne.neverRanRecoveryCount || 0) + 1;
  persist();
  return shapeRun(run);
}

function getNeverRanState(runId, nodeId) {
  const r = store.runs[runId];
  const ne = r && (r.nodeExecutions || []).find((n) => n.nodeId === nodeId);
  return {
    neverRanRecoveryCount:
      ne && ne.neverRanRecoveryCount ? ne.neverRanRecoveryCount : 0,
    neverRanPending: Boolean(ne && ne.neverRanPending),
  };
}

function markSessionEstablished(runId, nodeId) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.sessionEstablished = true;
  persist();
  return shapeRun(run);
}

function setIterationInvocation(
  runId,
  nodeId,
  { mode, providerSessionId } = {},
) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.iterationInvocation = {
    mode: String(mode),
    providerSessionId: String(providerSessionId),
  };
  persist();
  return shapeRun(run);
}

function recordLoopBudgetHalt(runId, nodeId, { finishedAt } = {}) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.status = "done";
  ne.finishedAt = finishedAt != null ? Number(finishedAt) : now();
  ne.loopExhausted = true;
  run.budgetHalt = true;
  persist();
  return shapeRun(run);
}

// Park a ready human-approval gate without spawning an agent process. Persists.
function gateApprovalNode(runId, nodeId) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  if (ne.status !== "pending")
    throw err("bad_request", "human-approval node must be pending");
  ne.status = "waiting-approval";
  persist();
  return shapeRun(run);
}

// Record a node's TERMINAL result (done|failed|skipped) + finishedAt. Persists.
function recordNodeResult(
  runId,
  nodeId,
  {
    status,
    finishedAt,
    error,
    chosenEdges,
    score,
    loopExhausted,
    lastVerdict,
  } = {},
) {
  if (!NODE_TERMINAL.has(status))
    throw err("bad_request", "node status must be done|failed|skipped");
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  ne.status = status;
  ne.finishedAt = finishedAt != null ? Number(finishedAt) : now();
  if (typeof error === "string") ne.error = error.slice(0, 500);
  if (chosenEdges !== undefined) ne.chosenEdges = [...chosenEdges];
  if (Number.isFinite(score)) ne.score = Number(score);
  if (loopExhausted) ne.loopExhausted = true;
  if (lastVerdict !== undefined) ne.lastVerdict = String(lastVerdict);
  persist();
  return shapeRun(run);
}

// Set the run status (+ finishedAt when terminal). On a terminal run
// (completed|failed|cancelled|budget_exhausted) every still-pending node flips
// to skipped so the ledger has no dangling "pending" after the run ends.
// Persists.
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
  } else {
    run.finishedAt = null;
  }
  persist();
  return shapeRun(run);
}

// PURE reducer (no I/O). Recomputed from the persisted ledger + frozen workflow
// on every call, including router chosenEdges, so restart recovery is complete.
function decide(run, resolvedConfig) {
  const nodeExecs = (run && run.nodeExecutions) || [];
  const byId = new Map(nodeExecs.map((ne) => [ne.nodeId, ne]));
  const workflow = (resolvedConfig && resolvedConfig.workflow) || {};
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const ins = new Map();
  const outs = new Map();
  for (const ne of nodeExecs) ins.set(ne.nodeId, []);
  for (const node of nodes) outs.set(node.id, []);
  for (const e of edges) {
    if (ins.has(e.to)) ins.get(e.to).push(e);
    if (outs.has(e.from)) outs.get(e.from).push(e);
  }

  const running = nodeExecs
    .filter((ne) => ne.status === "running")
    .map((ne) => ne.nodeId);

  // A failure branch handles its source's final failure; all other failures
  // remain fail-fast, including failed routers and failed plain nodes.
  const unhandledFailure = nodeExecs.some(
    (ne) =>
      ne.status === "failed" &&
      !(outs.get(ne.nodeId) || []).some((edge) => edge.on === "failure"),
  );
  if (unhandledFailure)
    return { toSpawn: [], toSkip: [], running, terminal: "failed" };

  if (nodeExecs.every((ne) => NODE_TERMINAL.has(ne.status)))
    return { toSpawn: [], toSkip: [], running, terminal: "completed" };

  const takenEdges = new Set();
  for (const edge of edges) {
    const source = byId.get(edge.from);
    if (!source || !NODE_TERMINAL.has(source.status)) continue;
    const sourceNode = nodesById.get(edge.from);
    let taken;
    if (sourceNode && sourceNode.type === "router") {
      taken = (source.chosenEdges || []).includes(`${edge.from}->${edge.to}`);
    } else if (edge.on === "success") {
      taken = source.status === "done";
    } else if (edge.on === "failure") {
      taken = source.status === "failed";
    } else {
      taken = edge.when == null && source.status === "done";
    }
    if (taken) takenEdges.add(`${edge.from}->${edge.to}`);
  }

  const ready = [];
  const toSkip = [];
  for (const ne of nodeExecs) {
    if (ne.status !== "pending") continue;
    const incoming = ins.get(ne.nodeId) || [];
    if (incoming.length === 0) {
      ready.push(ne.nodeId);
      continue;
    }
    const sourcesTerminal = incoming.every((edge) => {
      const source = byId.get(edge.from);
      return source && NODE_TERMINAL.has(source.status);
    });
    if (!sourcesTerminal) continue;
    if (incoming.some((edge) => takenEdges.has(`${edge.from}->${edge.to}`)))
      ready.push(ne.nodeId);
    else toSkip.push(ne.nodeId);
  }
  const budget = Math.max(0, AGENT_MAX_PARALLEL_FANOUT - running.length);
  return {
    toSpawn: ready.slice(0, budget),
    toSkip,
    running,
    terminal: null,
  };
}

// ---------------------------------------------------------------------------
// Pending MCP tool-call approvals (iter3, D5) — the per-run proxy's ledger.
// SYNC/ATOMIC only: no I/O, no polling/timeout logic (that's server.js's/the
// proxy's job — see docs cited at the top of this file's iter3 comment).
// ---------------------------------------------------------------------------

// Append one entry to a run's bounded toolCallLog[] (cap TOOL_CALL_LOG_CAP,
// oldest trimmed). Internal helper shared by appendToolCallLog (called
// directly for allow/deny dispositions) and resolvePendingToolCall (called for
// approved/rejected/timed_out). Does NOT persist — callers persist once.
function pushToolCallLog(run, entry = {}) {
  if (!Array.isArray(run.toolCallLog)) run.toolCallLog = [];
  run.toolCallLog.push({
    id: newId("tcl"),
    nodeId: entry.nodeId != null ? String(entry.nodeId) : null,
    toolName: entry.toolName != null ? String(entry.toolName) : "",
    connectionId:
      entry.connectionId != null ? String(entry.connectionId) : null,
    targetType: entry.targetType != null ? String(entry.targetType) : null,
    disposition: entry.disposition != null ? String(entry.disposition) : "",
    argsPreview: entry.argsPreview != null ? String(entry.argsPreview) : "",
    at: now(),
  });
  if (run.toolCallLog.length > TOOL_CALL_LOG_CAP) {
    run.toolCallLog.splice(0, run.toolCallLog.length - TOOL_CALL_LOG_CAP);
  }
}

// Register a NEW pending MCP tool-call approval on a node: generates a
// pendingId, sets node.pendingToolCall (status:"pending"), flips the node AND
// (unless the run is already terminal — defensive; should not happen in
// practice, the run's tmux job would already be dead) the run to
// "waiting-approval". Called by the proxy's POST .../pending-tool-call route.
// Persists once. Returns { pendingId }.
function recordPendingToolCall(
  runId,
  nodeId,
  { toolName, connectionId, argsPreview } = {},
) {
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  const pendingId = newId("ptc");
  ne.pendingToolCall = {
    id: pendingId,
    toolName: toolName != null ? String(toolName) : "",
    connectionId: connectionId != null ? String(connectionId) : null,
    argsPreview: argsPreview != null ? String(argsPreview) : "",
    status: "pending",
    createdAt: now(),
    decidedAt: null,
    reason: null,
  };
  ne.status = "waiting-approval";
  if (!RUN_TERMINAL.has(run.status)) run.status = "waiting-approval";
  persist();
  return { pendingId };
}

// Read a pending tool-call record's current disposition. Returns undefined
// (→ 404 at the route) if the id doesn't match the node's CURRENT pending
// record (superseded/never existed) — matches plan §(e)'s GET route contract.
function getPendingToolCall(runId, nodeId, pendingId) {
  const run = store.runs[runId];
  if (!run) return undefined;
  const ne = (run.nodeExecutions || []).find((n) => n.nodeId === nodeId);
  const ptc = ne && ne.pendingToolCall;
  if (!ptc || ptc.id !== pendingId) return undefined;
  return { status: ptc.status, reason: ptc.reason ?? null };
}

// Resolve a pending tool-call approval: approved | rejected | timed_out.
// IDEMPOTENT — a mismatched/already-resolved pendingId is a silent no-op (this
// protects against the proxy's best-effort timeout POST racing the gateway's
// own reducer-side sweep, or a stale/duplicate call: hard-constraint #4's
// guarantee lives in the sweep, not here, so a race must never double-apply or
// throw). On a real resolution: flips the node back to "running" (the
// underlying tmux job never stopped — it's still blocked inside the CLI's tool
// call), flips the RUN back to "running" only if no OTHER node in it is still
// waiting-approval (parallel fan-out can park more than one node at once), and
// appends a toolCallLog entry. Persists once (no-op path does not persist).
function resolvePendingToolCall(runId, nodeId, pendingId, decision, reason) {
  if (!PENDING_DECISIONS.has(decision))
    throw err("bad_request", "decision must be approved|rejected|timed_out");
  const run = findRun(runId);
  const ne = findNode(run, nodeId);
  const ptc = ne.pendingToolCall;
  if (!ptc || ptc.id !== pendingId || ptc.status !== "pending") {
    return shapeRun(run); // idempotent no-op — see header comment
  }
  ptc.status = decision;
  ptc.decidedAt = now();
  ptc.reason = reason != null ? String(reason) : null;
  // Only un-park the node if it's STILL parked. A race is reachable (e.g. a
  // human approve/reject lands just after DELETE cancelled the run and
  // killRunningJobs already marked this node "skipped"): the pending record
  // must still resolve (hard-constraint #4) and get logged, but a terminal
  // node must never be resurrected to "running" underneath it.
  if (ne.status === "waiting-approval") ne.status = "running";
  const stillWaiting = (run.nodeExecutions || []).some(
    (n) => n.nodeId !== nodeId && n.status === "waiting-approval",
  );
  if (!stillWaiting && run.status === "waiting-approval") {
    run.status = "running";
  }
  pushToolCallLog(run, {
    nodeId,
    toolName: ptc.toolName,
    connectionId: ptc.connectionId,
    targetType: null, // not tracked on the pending record; see appendToolCallLog
    disposition: decision,
    argsPreview: ptc.argsPreview,
  });
  persist();
  return shapeRun(run);
}

// Append an allow/deny disposition straight to the audit log (no status
// transition involved — the node was never parked for these). Used directly
// by server.js when the proxy's fire-and-forget log POST lands. Persists once;
// a log-append failure must never block/fail the actual tool call, so the
// ROUTE (not this function) is responsible for swallowing errors.
function appendToolCallLog(runId, entry = {}) {
  const run = findRun(runId);
  pushToolCallLog(run, entry);
  persist();
  return shapeRun(run);
}

// The id of the node's current PENDING record, or throw (used by
// approveAction/rejectAction when the caller omits an explicit pendingId).
function currentPendingId(run, nodeId) {
  const ne = findNode(run, nodeId);
  if (!ne.pendingToolCall || ne.pendingToolCall.status !== "pending")
    throw err("bad_request", "no pending tool call for this node");
  return ne.pendingToolCall.id;
}

// ---- Human-approval actions (iter3) — human (FE) decision routes ----
// Both accept an optional explicit pendingId (defense-in-depth per plan §3);
// when omitted, resolve against "whatever's current" for the node.
function approveAction(runId, nodeId, { pendingId } = {}) {
  const run = findRun(runId);
  const pid = pendingId || currentPendingId(run, nodeId);
  return resolvePendingToolCall(runId, nodeId, pid, "approved", null);
}
function rejectAction(runId, nodeId, { pendingId, reason } = {}) {
  const run = findRun(runId);
  const pid = pendingId || currentPendingId(run, nodeId);
  return resolvePendingToolCall(runId, nodeId, pid, "rejected", reason);
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
  fingerprintExecutableDefinition,
  // Runs (read + engine primitives)
  listRuns,
  getRun,
  // Run-engine sync primitives (iter2) — server.js composes these with tmux I/O.
  createRunRecord,
  listActiveRuns,
  activeRunsForSchedule,
  getNode,
  recordSpawned,
  recordGuidanceTurn,
  getSpawnAttempts,
  recordRetryAttempt,
  getRetryState,
  commitLoopIteration,
  getLoopState,
  commitNeverRanRecovery,
  getNeverRanState,
  markSessionEstablished,
  setIterationInvocation,
  recordLoopBudgetHalt,
  gateApprovalNode,
  recordNodeResult,
  setRunStatus,
  decide,
  // Pending MCP tool-call approvals (iter3, D5) — server.js's proxy-facing and
  // human-facing routes compose these sync/atomic primitives.
  recordPendingToolCall,
  getPendingToolCall,
  resolvePendingToolCall,
  appendToolCallLog,
  approveAction,
  rejectAction,
};
