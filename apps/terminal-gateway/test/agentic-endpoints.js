// Agentic AI Creator REST integration test — proves /api/agentic/* against a real
// gateway with a temp AGENTIC_FILE sidecar. Two halves:
//
//   ITERATION 1 (CRUD, no tmux): agents / connections / AgenticAIs CRUD + rev +
//   optimistic-concurrency 409, workflow validation (dangling edge / cycle → 422),
//   mcp-servers, bearer auth, CSRF, 404s, 413 oversize body. Auth ENABLED.
//
//   ITERATION 2 (RUN ENGINE, real tmux + a STUB CLI): the run-lifecycle routes are
//   now ACTIVE (POST /apps/:id/run → 202, GET /runs/:id, DELETE /runs/:id → 204).
//   Covered here (docs/AGENTIC-AI-CREATOR-PLAN.md §7):
//     (g) referential integrity — deleting an agent/connection scrubs every
//         dangling ref (agentIds / workflow node agentId / connectionIds /
//         toolPolicies[].connectionId); closed node type (router → 422).
//     (b) end-to-end run — codex-cli AND claude-cli stub → done (exit 0) /
//         failed (exit non-zero); logTail surfaces the stub's stdout.
//     (h) run tmux sessions use the `agrun-` prefix and NEVER appear in
//         GET /api/sessions.
//     (c) DELETE /runs/:id kills the run's live agrun- tmux job + marks cancelled.
//     (f) config-freeze (D9) — editing the AgenticAI (and its agent) after a run
//         starts does NOT change the run's resolvedConfig / agenticAiVersion.
//     (a) THE LOAD-BEARING TEST — start a multi-step run mid-flight, SIGKILL the
//         gateway (simulated crash), boot a FRESH gateway at the SAME AGENTIC_FILE
//         + AGENT_RUNS_DIR, assert boot-rediscovery advances the run to completion
//         (n1 done is only reachable if the new gateway spawned it) — D3 layer-2.
//     (d) AGENT_MAX_CONCURRENT_RUNS exceeded → 429 too_many_runs.
//     (e) per-step AGENT_RUN_TIMEOUT_MS → the step is reaped as `failed`.
//
// The STUB CLI (CODEX_COMMAND / CLAUDE_COMMAND both point at it — mirrors
// test:codex's stub) reads the prompt on stdin, echoes known markers, and branches
// on sentinels embedded in the objective: `SLEEP=<n>` sleeps n seconds; `__FAIL__`
// exits non-zero. Never the real claude/codex binaries.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
// The per-run MCP proxy under test (iter3). Repo-root/tools/agentic-proxy.
const PROXY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "tools",
  "agentic-proxy",
  "server.mjs",
);
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "agenticuser";
const AUTH_PASS = "agentic-pass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "http://evil.example.com";
const API_TOKEN = "agentic-test-bearer-token-xyz";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let serverOut = "";
let cookie = "";
let tmpDir = ""; // holds AGENTIC_FILE, AGENT_RUNS_DIR, stub, session cwd
let agenticFile = "";
let runsDir = "";
let stubPath = "";
let sessDir = "";
let kanbanFile = ""; // temp KANBAN_FILE store (iter3 proxy tests — never the repo's)
let pmFile = ""; // temp PM_FILE store (iter3 — keeps pm.json isolated too)
let checks = 0;
let tmuxBefore = new Set();

// The STUB provider CLI. Stands in for BOTH codex and claude (their command envs
// both point here). Reads the prompt on stdin (codex: `- < prompt`; claude:
// `cat prompt | claude ...`), echoes known markers to stdout (captured into
// out.log by the wrapper), and branches on sentinels in the prompt. argv ignored.
const STUB = `#!/usr/bin/env bash
prompt="$(cat)"
echo "STUB-PROVIDER-RAN"
secs="$(printf '%s' "$prompt" | sed -n 's/.*SLEEP=\\([0-9][0-9]*\\).*/\\1/p' | head -n1)"
if [ -n "$secs" ]; then sleep "$secs"; fi
case "$prompt" in
  *__FAIL__*) echo "stub-failure-boom" >&2; exit 7 ;;
esac
echo "STUB-DONE-OK"
exit 0
`;

// All tmux session names right now (agrun- run jobs + web- targets included).
function tmuxSessions() {
  try {
    const out = execFileSync("tmux", ["ls", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}
function tmuxHasSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function tmuxKill(name) {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

// Start (or restart) the gateway. `env` overrides merge onto the run-engine base.
// The SAME AGENTIC_FILE + AGENT_RUNS_DIR + stub are always used so a restart
// rediscovers persisted runs from disk (the point of the load-bearing test).
function startServer(extraEnv = {}) {
  serverOut = "";
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        GATEWAY_AUTH_USER: AUTH_USER,
        GATEWAY_AUTH_PASSWORD: AUTH_PASS,
        GATEWAY_AUTH_PASSWORD_HASH: "",
        GATEWAY_AUTH_TOKEN: "",
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        AGENTIC_FILE: agenticFile,
        GATEWAY_API_TOKEN: API_TOKEN,
        KANBAN_API_TOKEN: "",
        // Isolate the artifact stores so the iter3 proxy tests (real kanban-mcp)
        // never touch the repo's real data/kanban.json / data/pm.json.
        KANBAN_FILE: kanbanFile,
        PM_FILE: pmFile,
        // ---- Run engine ----
        CODEX_COMMAND: stubPath,
        CLAUDE_COMMAND: stubPath,
        AGENT_RUNS_DIR: runsDir,
        AGENTIC_POLL_INTERVAL_MS: "400", // drain fast in the test
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    server.stdout.on("data", (d) => {
      serverOut += d.toString();
      if (!resolved && serverOut.includes("listening on")) {
        resolved = true;
        resolve();
      }
    });
    server.stderr.on("data", (d) => process.stderr.write(`[gw] ${d}`));
    setTimeout(() => {
      if (!resolved) reject(new Error("server did not start in time"));
    }, 8000);
  });
}
// Kill the current gateway and WAIT for the process to exit (so the next start
// doesn't hit EADDRINUSE on the shared port).
function stopServer(signal = "SIGTERM") {
  return new Promise((resolve) => {
    if (!server || server.killed || server.exitCode !== null) return resolve();
    server.once("exit", () => resolve());
    server.kill(signal);
  });
}

// A tiny in-test MCP client that drives tools/agentic-proxy/server.mjs DIRECTLY
// over its own stdin/stdout with newline-delimited JSON-RPC 2.0 — standing in
// for the CLI that normally spawns the proxy, WITHOUT running any real
// claude/codex binary. `request()` returns { id, promise } so an approval-tier
// tools/call (which the proxy holds open until the gateway decides) can be
// awaited AFTER the test drives the approve/reject/timeout route. The proxy
// reaps its own kanban-mcp/pm-mcp children only on stdin `end` (no signal
// handler), so `close()` ends stdin and awaits a clean exit — killing it would
// orphan the node grandchildren, which the tmux-only leak check can't catch.
const activeProxies = new Set();
class ProxyClient {
  constructor(env) {
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this._readyResolve = null;
    this.ready = new Promise((r) => (this._readyResolve = r));
    this.proc = spawn("node", [PROXY_PATH], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeProxies.add(this);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => {
      this.stderr += d;
      if (this._readyResolve && this.stderr.includes("[agentic-proxy] ready")) {
        this._readyResolve();
        this._readyResolve = null;
      }
    });
    this.exited = new Promise((r) =>
      this.proc.on("exit", (code) => {
        activeProxies.delete(this);
        r(code);
      }),
    );
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
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }
  // Returns { id, promise } — promise resolves with the full JSON-RPC message.
  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve) => this.pending.set(id, { resolve }));
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return { id, promise };
  }
  // Await a request and return its `result` (or throw on a JSON-RPC error).
  async call(method, params) {
    const msg = await this.request(method, params).promise;
    if (msg.error)
      throw new Error(`proxy ${method} error: ${msg.error.message}`);
    return msg.result;
  }
  // End stdin (the proxy's ONLY child-reaping path) and await a clean exit.
  async close() {
    try {
      this.proc.stdin.end();
    } catch {
      /* already gone */
    }
    return this.exited;
  }
}

function cleanup() {
  // Best-effort: end any still-open proxy's stdin so it reaps its MCP children
  // (they are node grandchildren the tmux-only sweep below would otherwise miss).
  for (const p of activeProxies) {
    try {
      p.proc.stdin.end();
    } catch {}
    try {
      p.proc.kill("SIGKILL");
    } catch {}
  }
  // Kill any tmux session this test created (agrun- run jobs + web- targets),
  // diffed against the pre-test snapshot so unrelated dev sessions are untouched.
  const after = tmuxSessions();
  for (const name of after) {
    if (tmuxBefore.has(name)) continue;
    if (name.startsWith("agrun-") || name.startsWith("web-")) tmuxKill(name);
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  if (server && !server.killed && server.exitCode === null)
    server.kill("SIGTERM");
}
function fail(m) {
  console.error(`\nFAIL: ${m}`);
  cleanup();
  process.exit(1);
}
function assert(c, m) {
  checks += 1;
  if (!c) fail(m);
}
async function req(
  method,
  pathname,
  { body, origin, headers, cookie: useCookie = true, rawBody } = {},
) {
  const h = { ...(headers || {}) };
  if (useCookie && cookie) h["cookie"] = cookie;
  if (origin) h["origin"] = origin;
  let payload;
  if (rawBody !== undefined) {
    h["content-type"] = "application/json";
    payload = rawBody;
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${BASE}${pathname}`, { method, headers: h, body: payload });
}
const enc = (id) => encodeURIComponent(id);
async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  if (res.status !== 204) fail(`login -> ${res.status}`);
  cookie = /gw_session=[^;]+/.exec(res.headers.get("set-cookie") || "")[0];
}

// Poll GET /runs/:id until `pred(run)` is true or the deadline elapses.
async function pollRun(runId, pred, { deadlineMs = 20000, label = "" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < deadlineMs) {
    const res = await req("GET", `/api/agentic/runs/${enc(runId)}`);
    if (res.status === 200) {
      last = await res.json();
      if (pred(last)) return last;
    }
    await sleep(200);
  }
  fail(
    `pollRun timeout ${label}: run ${runId} never satisfied predicate; last=${JSON.stringify(
      last,
    )}`,
  );
}
const nodeOf = (run, nodeId) =>
  (run.nodeExecutions || []).find((n) => n.nodeId === nodeId);

// Create a fresh runner app (N codex-cli agents unless overridden) and return
// its id. Agents are created fresh so referential-integrity tests can't touch it.
async function createRunnerApp({
  mode = "single",
  providers = ["codex-cli"],
} = {}) {
  const agentIds = [];
  for (let i = 0; i < providers.length; i++) {
    const res = await req("POST", "/api/agentic/agents", {
      body: {
        name: `runner-agent-${providers[i]}-${Date.now()}-${i}`,
        runtimeProvider: providers[i],
        sandboxMode: "read-only",
        systemPrompt: "",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `runner agent create -> ${res.status}`);
    agentIds.push((await res.json()).id);
  }
  const res = await req("POST", "/api/agentic/apps", {
    body: {
      name: `runner-app-${Date.now()}`,
      orchestrationMode: mode,
      agentIds,
    },
    origin: ALLOWED_ORIGIN,
  });
  assert(res.status === 201, `runner app create -> ${res.status}`);
  const app = await res.json();
  return { appId: app.id, agentIds };
}

async function main() {
  // ---- Unit check: claude-cli agent-task MCP routing (iter3, D5) -------------
  // claude -p otherwise does ambient MCP discovery from the run cwd's ~/.claude.json
  // project scope; an unhardened run would silently inherit that cwd's MCP servers
  // UNMEDIATED. iter3 pins --strict-mcp-config so ONLY the servers in the per-run
  // --mcp-config file are ever reachable, and:
  //   - LOCAL target  -> the file lists EXACTLY the agentic-proxy server (and no
  //     pm/kanban directly); all scoping/allow-deny-approval happens INSIDE the
  //     proxy via the policy manifest, so even a zero-connection agent reaches
  //     zero tools (deny-by-empty-manifest), never an ambient server.
  //   - REMOTE (ssh)  -> the proxy can't run on an arbitrary remote host, so the
  //     file is an EMPTY {"mcpServers":{}} (fail-closed, zero MCP) — matching
  //     iter2's posture, now uniform across providers.
  // Asserted at the source (no gateway needed) so it can never silently regress.
  {
    const rt = (await import("../src/agent-runtime.js")).default;
    const mkArgs = (server) => ({
      runId: "utR",
      nodeId: "utN",
      agent: {
        runtimeProvider: "claude-cli",
        sandboxMode: "workspace-write",
        systemPrompt: "SYS",
        toolPolicies: [],
      },
      cwd: "/tmp/ut-cwd",
      promptText: "UNIT-PROMPT-SENTINEL",
      scratchDir: "/tmp/ut-scratch/utR/utN",
      server,
      resolvedConnections: [],
    });

    // LOCAL: --mcp-config points at the proxy, nothing else.
    const local = rt.buildInvocation(mkArgs({ type: "local" }));
    const localWrap = local.files.find(
      (f) => f.relPath === "wrapper.sh",
    ).content;
    const localMcp = local.files.find((f) => f.relPath === "mcp.json");
    assert(
      localWrap.includes("--strict-mcp-config") &&
        localWrap.includes("--mcp-config"),
      "claude/local must pass --mcp-config + --strict-mcp-config",
    );
    let localCfg;
    assert(
      !!localMcp && (localCfg = JSON.parse(localMcp.content)) != null,
      "claude/local must ship a parseable mcp.json",
    );
    const localServers = Object.keys(localCfg.mcpServers || {});
    assert(
      localServers.length === 1 && localServers[0] === "agentic-proxy",
      "claude/local mcp.json must list EXACTLY the agentic-proxy server (no direct pm/kanban)",
    );
    assert(
      !/mcpServers[\s\S]*\b(pm|kanban)\b/.test(localMcp.content),
      "claude/local mcp.json must NOT reference pm/kanban servers directly (only via the proxy)",
    );
    assert(
      !local.tmuxArg.includes("UNIT-PROMPT-SENTINEL"),
      "prompt text must never appear on the tmux/argv command line",
    );

    // REMOTE: fail-closed empty config (no proxy reachable on the remote host).
    const remote = rt.buildInvocation(mkArgs({ type: "ssh" }));
    const remoteWrap = remote.files.find(
      (f) => f.relPath === "wrapper.sh",
    ).content;
    const remoteMcp = remote.files.find((f) => f.relPath === "mcp.json");
    assert(
      remoteWrap.includes("--strict-mcp-config"),
      "claude/remote must still pass --strict-mcp-config (fail-closed)",
    );
    assert(
      !!remoteMcp &&
        Object.keys(JSON.parse(remoteMcp.content).mcpServers || {}).length ===
          0,
      "claude/remote must ship an EMPTY mcp.json (zero MCP servers)",
    );
    // The remote mcp.json must not name the proxy either (no reachable MCP at all).
    assert(
      !/agentic-proxy/.test(remoteMcp.content),
      "claude/remote mcp.json must NOT reference the agentic-proxy (no proxy on a remote host)",
    );

    // codex-cli: iter3 leaves its invocation UNCHANGED — no proxy wiring on
    // EITHER target. It must ship no mcp.json and never name the proxy anywhere.
    const codexArgs = (server) => ({
      ...mkArgs(server),
      agent: {
        runtimeProvider: "codex-cli",
        sandboxMode: "read-only",
        systemPrompt: "SYS",
        toolPolicies: [],
      },
    });
    for (const t of ["local", "ssh"]) {
      const cx = rt.buildInvocation(codexArgs({ type: t }));
      assert(
        !cx.files.some((f) => f.relPath === "mcp.json"),
        `codex-cli/${t} must ship NO mcp.json (no proxy wiring)`,
      );
      const cxWrap = cx.files.find((f) => f.relPath === "wrapper.sh").content;
      assert(
        !/agentic-proxy/.test(cxWrap) && !cx.tmuxArg.includes("agentic-proxy"),
        `codex-cli/${t} wrapper must never reference the agentic-proxy`,
      );
    }

    console.log(
      `  ok: MCP routing (iter3 D5) — claude local->proxy-only+strict, claude remote->empty (no proxy), codex local+remote->no mcp/no proxy, prompt off-argv`,
    );
  }

  // ---- Unit: nodeExecution.error round-trips + truncates (iter4) -------------
  // iter4 surfaces a run node's setup-failure reason: spawnNode passes an `error`
  // string to recordNodeResult (buildInvocation/materialize/spawn failures) and
  // GET /runs/:id returns it. Assert the store contract at the source, on an
  // isolated AGENTIC_FILE, without needing to force a real spawn failure.
  {
    const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-unit-"));
    process.env.AGENTIC_FILE = path.join(unitDir, "agentic.json");
    const store = (await import("../src/agentic.js")).default;
    store.load();
    const run = store.createRunRecord({
      agenticAiId: "aa-unit",
      sessionId: "local/web-unit",
      objective: "o",
      resolvedConfig: { cwd: "/tmp", resolvedAgents: {} },
      agenticAiVersion: 1,
      nodeExecutions: [{ nodeId: "n0", status: "pending" }],
    });
    const longReason = "materialize failed: " + "x".repeat(1000);
    store.recordNodeResult(run.id, "n0", {
      status: "failed",
      finishedAt: Date.now(),
      error: longReason,
    });
    const got = store.getRun(run.id);
    const ne = (got.nodeExecutions || []).find((n) => n.nodeId === "n0");
    assert(ne && ne.status === "failed", "unit: node recorded failed");
    assert(
      ne.error && ne.error.startsWith("materialize failed: "),
      "unit: nodeExecution.error is surfaced in the shaped run",
    );
    assert(
      ne.error.length <= 500,
      "unit: nodeExecution.error truncated to <=500",
    );
    // A node with no error must NOT emit the key (shaper is conditional).
    const run2 = store.createRunRecord({
      agenticAiId: "aa-unit",
      sessionId: "local/web-unit",
      objective: "o",
      resolvedConfig: { cwd: "/tmp", resolvedAgents: {} },
      agenticAiVersion: 1,
      nodeExecutions: [{ nodeId: "n0", status: "pending" }],
    });
    store.recordNodeResult(run2.id, "n0", {
      status: "done",
      finishedAt: Date.now(),
    });
    const ne2 = (store.getRun(run2.id).nodeExecutions || []).find(
      (n) => n.nodeId === "n0",
    );
    assert(
      ne2 && ne2.error === undefined,
      "unit: a node with no failure reason omits the error key",
    );
    delete process.env.AGENTIC_FILE;
    fs.rmSync(unitDir, { recursive: true, force: true });
    console.log(
      `  ok: (iter4) nodeExecution.error round-trips + truncates; absent when unset`,
    );
  }

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-endpoints-"));
  agenticFile = path.join(tmpDir, "agentic.json");
  runsDir = path.join(tmpDir, "agentic-runs"); // absolute — required
  sessDir = path.join(tmpDir, "sess");
  stubPath = path.join(tmpDir, "provider-stub.sh");
  kanbanFile = path.join(tmpDir, "kanban.json"); // isolated artifact stores
  pmFile = path.join(tmpDir, "pm.json");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(stubPath, STUB, { mode: 0o755 });

  tmuxBefore = tmuxSessions();
  await startServer();
  await login();
  console.log(
    `gateway up on :${PORT} (auth enabled, temp AGENTIC_FILE + AGENT_RUNS_DIR, stub CLI, bearer)`,
  );

  // ======================================================================
  // ITERATION 1 — CRUD surface (unchanged)
  // ======================================================================

  // ---- Agents: create / list / get / patch / delete ---------------------
  let agent;
  {
    const bad = await req("POST", "/api/agentic/agents", {
      body: { name: "NoProvider" },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 400, `agent w/o provider -> ${bad.status} (exp 400)`);

    const res = await req("POST", "/api/agentic/agents", {
      body: {
        name: "Researcher",
        runtimeProvider: "codex-cli",
        role: "research",
        systemPrompt: "You research things.",
        sandboxMode: "read-only",
        model: "gpt-5.6-sol",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create agent -> ${res.status}`);
    agent = await res.json();
    assert(/^ag-/.test(agent.id), "agent id prefix ag-");
    assert(agent.runtimeProvider === "codex-cli", "runtimeProvider echoed");
    assert(agent.sandboxMode === "read-only", "sandboxMode echoed");
    assert(agent.rev === 1, "agent rev starts at 1");
    console.log(`  ok: create agent ${agent.id} (+ invalid-body 400)`);
  }
  {
    const res = await req("GET", "/api/agentic/agents");
    assert(res.status === 200, `list agents -> ${res.status}`);
    const j = await res.json();
    assert(
      Array.isArray(j.agents) && j.agents.some((a) => a.id === agent.id),
      "listed agent present",
    );
    const one = await req("GET", `/api/agentic/agents/${enc(agent.id)}`);
    assert(one.status === 200, `get agent -> ${one.status}`);
    assert((await one.json()).id === agent.id, "get agent id matches");
    console.log(`  ok: list + get agent`);
  }
  {
    const res = await req("PATCH", `/api/agentic/agents/${enc(agent.id)}`, {
      body: { role: "senior-research", sandboxMode: "workspace-write" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `patch agent -> ${res.status}`);
    const p = await res.json();
    assert(p.role === "senior-research", "role updated");
    assert(p.sandboxMode === "workspace-write", "sandboxMode updated");
    assert(p.rev === agent.rev + 1, `rev bumped (${p.rev})`);
    agent = p;
    console.log(`  ok: patch agent (rev ${agent.rev})`);
  }
  {
    const stale = await req("PATCH", `/api/agentic/agents/${enc(agent.id)}`, {
      body: { role: "x", expectedRev: agent.rev - 1 },
      origin: ALLOWED_ORIGIN,
    });
    assert(stale.status === 409, `stale agent patch -> ${stale.status}`);
    assert(/stale/i.test((await stale.json()).error), "409 stale message");
    const ok = await req("PATCH", `/api/agentic/agents/${enc(agent.id)}`, {
      body: { role: "y", expectedRev: agent.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(ok.status === 200, `matched-rev patch -> ${ok.status}`);
    agent = await ok.json();
    console.log(`  ok: agent optimistic concurrency (stale 409 / match 200)`);
  }

  // ---- Connections: create / list / delete (no patch, no get-by-id) -----
  let connection;
  {
    const bad = await req("POST", "/api/agentic/connections", {
      body: { targetType: "not-a-target" },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 400, `bad connection target -> ${bad.status}`);

    const res = await req("POST", "/api/agentic/connections", {
      body: { targetType: "pm", scope: "fixed" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create connection -> ${res.status}`);
    connection = await res.json();
    assert(/^conn-/.test(connection.id), "connection id prefix conn-");
    assert(connection.targetType === "pm", "targetType echoed");

    const list = await req("GET", "/api/agentic/connections");
    assert(list.status === 200, `list connections -> ${list.status}`);
    assert(
      (await list.json()).connections.some((c) => c.id === connection.id),
      "connection listed",
    );
    console.log(`  ok: create + list connection ${connection.id}`);
  }

  // ---- Apps: create / list / get / patch / delete + publish + version ---
  let app;
  {
    const res = await req("POST", "/api/agentic/apps", {
      body: {
        name: "Nightly Triage",
        description: "Triage the backlog",
        orchestrationMode: "single",
        agentIds: [agent.id],
        connectionIds: [connection.id],
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create app -> ${res.status}`);
    app = await res.json();
    assert(/^aa-/.test(app.id), "app id prefix aa-");
    assert(app.status === "draft", "app starts draft");
    assert(app.version === 1 && app.rev === 1, "app v1/rev1");
    assert(
      app.workflow &&
        Array.isArray(app.workflow.nodes) &&
        app.workflow.nodes.length === 0,
      "empty workflow default",
    );
    console.log(`  ok: create app ${app.id} (v1, draft)`);
  }
  {
    const list = await req("GET", "/api/agentic/apps");
    assert(list.status === 200, `list apps -> ${list.status}`);
    const summaries = (await list.json()).apps;
    const sum = summaries.find((s) => s.id === app.id);
    assert(sum, "app in catalog");
    assert(
      sum.agentCount === 1 && sum.connectionCount === 1,
      "summary counts derived",
    );
    assert(sum.workflow === undefined, "summary omits full workflow");
    const one = await req("GET", `/api/agentic/apps/${enc(app.id)}`);
    assert(one.status === 200, `get app -> ${one.status}`);
    assert((await one.json()).workflow !== undefined, "full app has workflow");
    console.log(`  ok: list (summary) + get (full) app`);
  }
  {
    const res = await req("PATCH", `/api/agentic/apps/${enc(app.id)}`, {
      body: {
        description: "Updated objective",
        orchestrationMode: "sequential",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `patch app -> ${res.status}`);
    const p = await res.json();
    assert(p.version === 2, `app version bumped to 2 (got ${p.version})`);
    assert(p.rev === app.rev + 1, `app rev bumped (${p.rev})`);
    assert(p.orchestrationMode === "sequential", "orchestrationMode updated");
    app = p;
    console.log(`  ok: patch app bumps version + rev (v${app.version})`);
  }
  {
    const versionBefore = app.version;
    const res = await req("PATCH", `/api/agentic/apps/${enc(app.id)}/status`, {
      body: { status: "published" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `publish -> ${res.status}`);
    const p = await res.json();
    assert(p.status === "published", "status flipped to published");
    assert(
      p.version === versionBefore,
      `version UNCHANGED by publish (${p.version} vs ${versionBefore})`,
    );
    assert(p.rev === app.rev + 1, "rev bumped by publish");
    app = p;
    const bad = await req("PATCH", `/api/agentic/apps/${enc(app.id)}/status`, {
      body: { status: "nonsense" },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 400, `bad status -> ${bad.status}`);
    const stale = await req(
      "PATCH",
      `/api/agentic/apps/${enc(app.id)}/status`,
      {
        body: { status: "paused", expectedRev: app.rev - 1 },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(stale.status === 409, `stale publish -> ${stale.status}`);
    console.log(
      `  ok: publish flips status + rev, NOT version (+ bad 400 / stale 409)`,
    );
  }
  {
    const stale = await req("PATCH", `/api/agentic/apps/${enc(app.id)}`, {
      body: { description: "z", expectedRev: app.rev - 1 },
      origin: ALLOWED_ORIGIN,
    });
    assert(stale.status === 409, `stale app patch -> ${stale.status}`);
    assert(/stale/i.test((await stale.json()).error), "app 409 stale message");
    console.log(`  ok: app definition-edit optimistic concurrency (409)`);
  }

  // ---- Workflow validation: dangling edge / cycle -> 422 ----------------
  {
    const okWf = await req("POST", "/api/agentic/apps", {
      body: {
        name: "GraphOK",
        workflow: {
          nodes: [
            { id: "n1", type: "agent-task", agentId: agent.id },
            { id: "n2", type: "agent-task", agentId: agent.id },
          ],
          edges: [{ from: "n1", to: "n2" }],
          entryNodeId: "n1",
        },
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(okWf.status === 201, `valid workflow -> ${okWf.status}`);
    const okApp = await okWf.json();
    assert(okApp.workflow.edges.length === 1, "valid workflow edge kept");

    const dangling = await req("POST", "/api/agentic/apps", {
      body: {
        name: "Dangling",
        workflow: {
          nodes: [{ id: "n1" }],
          edges: [{ from: "n1", to: "ghost" }],
          entryNodeId: "n1",
        },
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(dangling.status === 422, `dangling edge -> ${dangling.status}`);
    const dj = await dangling.json();
    assert(dj.edge && dj.edge.to === "ghost", "422 carries offending edge");

    const cyc = await req("POST", "/api/agentic/apps", {
      body: {
        name: "Cycle",
        workflow: {
          nodes: [{ id: "a" }, { id: "b" }],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
          entryNodeId: "a",
        },
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(cyc.status === 422, `cycle -> ${cyc.status}`);
    assert(/cycle/i.test((await cyc.json()).error), "cycle error message");

    const before = await (
      await req("GET", `/api/agentic/apps/${enc(okApp.id)}`)
    ).json();
    const badPatch = await req("PATCH", `/api/agentic/apps/${enc(okApp.id)}`, {
      body: {
        workflow: {
          nodes: [{ id: "x" }, { id: "y" }],
          edges: [
            { from: "x", to: "y" },
            { from: "y", to: "x" },
          ],
          entryNodeId: "x",
        },
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(badPatch.status === 422, `cycle patch -> ${badPatch.status}`);
    const after = await (
      await req("GET", `/api/agentic/apps/${enc(okApp.id)}`)
    ).json();
    assert(
      after.version === before.version && after.rev === before.rev,
      "rejected workflow patch did not mutate (version/rev unchanged)",
    );
    console.log(
      `  ok: workflow validation — valid 201, dangling+cycle 422, reject leaves store clean`,
    );
  }

  // ---- Closed WorkflowNode.type — non "agent-task" rejected (422) -------
  {
    const bad = await req("POST", "/api/agentic/apps", {
      body: {
        name: "RouterNode",
        workflow: {
          nodes: [{ id: "n1", type: "router", agentId: agent.id }],
          edges: [],
          entryNodeId: "n1",
        },
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 422, `router node type -> ${bad.status} (exp 422)`);
    assert(
      /unsupported node type/i.test((await bad.json()).error),
      "422 names the unsupported node type",
    );
    console.log(`  ok: WorkflowNode.type closed to agent-task (router -> 422)`);
  }

  // ---- GET /mcp-servers -> pm + kanban ----------------------------------
  {
    const res = await req("GET", "/api/agentic/mcp-servers");
    assert(res.status === 200, `mcp-servers -> ${res.status}`);
    const ids = (await res.json()).servers.map((s) => s.id).sort();
    assert(
      ids.length === 2 && ids[0] === "kanban" && ids[1] === "pm",
      `mcp-servers = pm + kanban (got ${ids.join(",")})`,
    );
    console.log(`  ok: GET /mcp-servers returns pm + kanban`);
  }

  // ---- Bearer-token auth (the external-CLI path) ------------------------
  {
    const g = await req("GET", "/api/agentic/agents", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert(g.status === 200, `bearer GET -> ${g.status}`);
    const w = await req("POST", "/api/agentic/agents", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      body: { name: "ViaCli", runtimeProvider: "claude-cli" },
    });
    assert(w.status === 201, `bearer write -> ${w.status}`);
    const bad = await req("GET", "/api/agentic/agents", {
      cookie: false,
      headers: { authorization: "Bearer wrong-token" },
    });
    assert(bad.status === 401, `bad bearer -> ${bad.status}`);
    const none = await req("GET", "/api/agentic/agents", { cookie: false });
    assert(none.status === 401, `no auth -> ${none.status}`);
    console.log(`  ok: bearer auth (GET 200, write 201, bad 401, none 401)`);
  }

  // ---- CSRF: foreign Origin -> 403 write; GET Origin-exempt -------------
  {
    const w = await req("POST", "/api/agentic/agents", {
      body: { name: "nope", runtimeProvider: "codex-cli" },
      origin: FOREIGN_ORIGIN,
    });
    assert(w.status === 403, `foreign-origin write -> ${w.status}`);
    const g = await req("GET", "/api/agentic/agents", {
      origin: FOREIGN_ORIGIN,
    });
    assert(g.status === 200, `foreign-origin GET -> ${g.status}`);
    console.log(`  ok: CSRF -> write 403, GET Origin-exempt`);
  }

  // ---- 404s for unknown ids ---------------------------------------------
  {
    const a = await req("GET", "/api/agentic/agents/ag-nope");
    assert(a.status === 404, `unknown agent -> ${a.status}`);
    const p = await req("GET", "/api/agentic/apps/aa-nope");
    assert(p.status === 404, `unknown app -> ${p.status}`);
    const dc = await req("DELETE", "/api/agentic/connections/conn-nope", {
      origin: ALLOWED_ORIGIN,
    });
    assert(dc.status === 404, `delete unknown connection -> ${dc.status}`);
    const da = await req("DELETE", "/api/agentic/agents/ag-nope", {
      origin: ALLOWED_ORIGIN,
    });
    assert(da.status === 404, `delete unknown agent -> ${da.status}`);
    console.log(`  ok: 404 for unknown agent/app/connection ids`);
  }

  // ---- 413 for an oversize body -----------------------------------------
  {
    const huge = JSON.stringify({
      name: "Huge",
      runtimeProvider: "codex-cli",
      systemPrompt: "x".repeat(70 * 1024),
    });
    let status = null;
    try {
      const res = await req("POST", "/api/agentic/agents", {
        rawBody: huge,
        origin: ALLOWED_ORIGIN,
      });
      status = res.status;
    } catch {
      status = "socket-reset";
    }
    assert(
      status === 413 || status === "socket-reset",
      `oversize body -> ${status} (exp 413 or socket reset, never 2xx)`,
    );
    console.log(`  ok: oversize body rejected (${status})`);
  }

  // ---- GET /runs read-only + unknown run 404 ----------------------------
  {
    const runs = await req("GET", "/api/agentic/runs");
    assert(runs.status === 200, `list runs -> ${runs.status}`);
    assert(Array.isArray((await runs.json()).runs), "runs list is an array");
    const rGet = await req("GET", "/api/agentic/runs/run-nope");
    assert(rGet.status === 404, `unknown run -> ${rGet.status}`);
    console.log(`  ok: GET /runs read-only (array), unknown run -> 404`);
  }

  // ---- (g) referential integrity: delete agent / connection scrubs refs -
  {
    const c = await req("POST", "/api/agentic/connections", {
      body: { targetType: "kanban", scope: "fixed" },
      origin: ALLOWED_ORIGIN,
    });
    const connId = (await c.json()).id;
    const a = await req("POST", "/api/agentic/agents", {
      body: {
        name: "ScrubMe",
        runtimeProvider: "codex-cli",
        toolPolicies: [{ connectionId: connId, tools: "all", policy: "allow" }],
      },
      origin: ALLOWED_ORIGIN,
    });
    const scrubAgent = await a.json();
    const p = await req("POST", "/api/agentic/apps", {
      body: {
        name: "ScrubApp",
        orchestrationMode: "single",
        agentIds: [scrubAgent.id],
        connectionIds: [connId],
        workflow: {
          nodes: [{ id: "n1", type: "agent-task", agentId: scrubAgent.id }],
          edges: [],
          entryNodeId: "n1",
        },
      },
      origin: ALLOWED_ORIGIN,
    });
    const scrubApp = await p.json();
    const vBefore = scrubApp.version;

    // Delete the agent -> scrub agentIds[] + null the node's agentId (node kept).
    const da = await req(
      "DELETE",
      `/api/agentic/agents/${enc(scrubAgent.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(da.status === 204, `delete scrub agent -> ${da.status}`);
    const afterAgent = await (
      await req("GET", `/api/agentic/apps/${enc(scrubApp.id)}`)
    ).json();
    assert(
      !afterAgent.agentIds.includes(scrubAgent.id),
      "deleted agent scrubbed from app.agentIds",
    );
    const node = afterAgent.workflow.nodes.find((n) => n.id === "n1");
    assert(node, "workflow node KEPT after agent delete (edges not dangled)");
    assert(
      node.agentId === undefined || node.agentId === null,
      "workflow node agentId cleared after agent delete",
    );
    assert(
      afterAgent.version === vBefore + 1,
      `agent-delete scrub bumped app version (${vBefore} -> ${afterAgent.version})`,
    );

    // Delete the connection -> scrub connectionIds[] + agent.toolPolicies[].
    const dc = await req("DELETE", `/api/agentic/connections/${enc(connId)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(dc.status === 204, `delete scrub connection -> ${dc.status}`);
    const afterConn = await (
      await req("GET", `/api/agentic/apps/${enc(scrubApp.id)}`)
    ).json();
    assert(
      !afterConn.connectionIds.includes(connId),
      "deleted connection scrubbed from app.connectionIds",
    );
    // A separate agent still referencing the connection has its policy scrubbed.
    const a2 = await req("POST", "/api/agentic/agents", {
      body: { name: "PolicyHolder", runtimeProvider: "codex-cli" },
      origin: ALLOWED_ORIGIN,
    });
    // (re-add a connection + policy, then delete, to prove toolPolicy scrub)
    const c2 = await req("POST", "/api/agentic/connections", {
      body: { targetType: "pm", scope: "fixed" },
      origin: ALLOWED_ORIGIN,
    });
    const conn2 = (await c2.json()).id;
    const holder = await a2.json();
    await req("PATCH", `/api/agentic/agents/${enc(holder.id)}`, {
      body: {
        toolPolicies: [{ connectionId: conn2, tools: "all", policy: "deny" }],
      },
      origin: ALLOWED_ORIGIN,
    });
    await req("DELETE", `/api/agentic/connections/${enc(conn2)}`, {
      origin: ALLOWED_ORIGIN,
    });
    const holderAfter = await (
      await req("GET", `/api/agentic/agents/${enc(holder.id)}`)
    ).json();
    assert(
      !holderAfter.toolPolicies.some((tp) => tp.connectionId === conn2),
      "deleted connection scrubbed from agent.toolPolicies",
    );
    // Clean up scrub fixtures.
    await req("DELETE", `/api/agentic/apps/${enc(scrubApp.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    await req("DELETE", `/api/agentic/agents/${enc(holder.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    console.log(
      `  ok: (g) referential integrity — agent/connection deletes scrub agentIds, node agentId, connectionIds, toolPolicies`,
    );
  }

  // ---- No tmux sessions spawned by any CRUD op --------------------------
  {
    const added = [...tmuxSessions()].filter((s) => !tmuxBefore.has(s));
    assert(
      added.length === 0,
      `CRUD spawned no tmux sessions (new: ${added.join(" | ")})`,
    );
    console.log(`  ok: CRUD phase spawned no tmux sessions`);
  }

  // ======================================================================
  // ITERATION 2 — RUN ENGINE (real tmux + stub CLI)
  // ======================================================================

  // Create ONE reusable target terminal session (a real web- tmux session).
  let targetSessionId;
  {
    const res = await req("POST", "/api/sessions", {
      body: { name: "agentic-run-target", cwd: sessDir },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create target session -> ${res.status}`);
    targetSessionId = (await res.json()).id;
    await sleep(700); // let the shell settle so pane_current_path resolves
    console.log(`  ok: created run target session ${targetSessionId}`);
  }

  // ---- GET /session-cwd — resolve the run's working directory up front -----
  // Same resolution + error mapping as startRun (parse -> ID_RE -> registry ->
  // serverExec display-message #{pane_current_path}). The FE shows this in the
  // Run view before Start run.
  {
    // Happy path: the real local target session resolves to an absolute cwd.
    const ok = await req(
      "GET",
      `/api/agentic/session-cwd?sessionId=${enc(targetSessionId)}`,
    );
    assert(ok.status === 200, `session-cwd ok -> ${ok.status} (exp 200)`);
    const body = await ok.json();
    assert(
      typeof body.cwd === "string" && body.cwd.startsWith("/"),
      `session-cwd returns an absolute cwd (got ${JSON.stringify(body.cwd)})`,
    );
    assert(body.sessionId === targetSessionId, "session-cwd echoes sessionId");
    assert(body.serverId === "local", "session-cwd reports serverId local");

    // Blank sessionId -> 400 (bad_request, ID_RE fails on "").
    const blank = await req("GET", "/api/agentic/session-cwd?sessionId=");
    assert(
      blank.status === 400,
      `session-cwd blank -> ${blank.status} (exp 400)`,
    );

    // Missing sessionId param entirely -> 400 (same ID_RE failure).
    const missing = await req("GET", "/api/agentic/session-cwd");
    assert(
      missing.status === 400,
      `session-cwd missing param -> ${missing.status} (exp 400)`,
    );

    // A well-formed but nonexistent web- session -> 502 (cwd_unresolved): passes
    // ID_RE + registry, but display-message finds no such tmux session. Matches
    // startRun's cwd-resolution failure code.
    const unknown = await req(
      "GET",
      "/api/agentic/session-cwd?sessionId=web-does-not-exist-xyz",
    );
    assert(
      unknown.status === 502,
      `session-cwd unknown session -> ${unknown.status} (exp 502 cwd_unresolved)`,
    );

    console.log(
      `  ok: GET /session-cwd (200 abs cwd; blank/missing -> 400; unknown web- -> 502)`,
    );
  }

  // ---- (b) end-to-end: codex-cli happy path (exit 0 -> done) + (h) prefix
  {
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "do the thing SLEEP=2" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start run -> ${res.status} (exp 202)`);
    const run = await res.json();
    assert(/^run-/.test(run.id), "run id prefix run-");
    assert(run.agenticAiId === appId, "run tied to app");
    assert(
      run.resolvedConfig && run.resolvedConfig.workflow,
      "run froze resolvedConfig",
    );
    // startRun awaits the first advance, so n0 is spawned+running by 202.
    const n0 = nodeOf(run, "n0");
    assert(
      n0 && n0.status === "running",
      `n0 running at 202 (got ${n0 && n0.status})`,
    );

    // (h) the run tmux session is live under the agrun- prefix and is NOT a web-
    //     session in GET /api/sessions.
    const agrun = `agrun-${run.id}-n0`;
    assert(tmuxHasSession(agrun), `agrun tmux session live: ${agrun}`);
    assert(!agrun.startsWith("web-"), "run session is NOT web- prefixed");
    const sess = await (await req("GET", "/api/sessions")).json();
    const ids = (sess.sessions || sess || []).map((s) => s.id || s);
    assert(
      !ids.some((id) => String(id).includes("agrun-")),
      `agrun- session must NOT appear in GET /api/sessions (got: ${ids.join(",")})`,
    );

    const done = await pollRun(run.id, (r) => r.status === "completed", {
      label: "codex happy path",
    });
    assert(nodeOf(done, "n0").status === "done", "n0 done after exit 0");
    assert(
      /STUB-PROVIDER-RAN/.test(nodeOf(done, "n0").logTail || "") &&
        /STUB-DONE-OK/.test(nodeOf(done, "n0").logTail || ""),
      "logTail surfaces the stub's stdout markers",
    );
    assert(!tmuxHasSession(agrun), "agrun tmux session gone after completion");
    console.log(
      `  ok: (b)+(h) codex-cli run -> completed, n0 done, logTail present, agrun- prefix + absent from /api/sessions`,
    );
  }

  // ---- (b) failure path: exit non-zero -> node failed + run failed ------
  {
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "boom __FAIL__" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start fail run -> ${res.status}`);
    const run = await res.json();
    const done = await pollRun(
      run.id,
      (r) => r.status === "failed" || r.status === "completed",
      { label: "codex fail path" },
    );
    assert(done.status === "failed", `run failed (got ${done.status})`);
    assert(nodeOf(done, "n0").status === "failed", "n0 failed after exit 7");
    assert(
      /stub-failure-boom/.test(nodeOf(done, "n0").logTail || ""),
      "failure logTail captured",
    );
    console.log(
      `  ok: (b) codex-cli exit non-zero -> node failed + run failed`,
    );
  }

  // ---- (b) claude-cli provider happy path (proves the second provider) --
  {
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["claude-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "claude does it" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start claude run -> ${res.status}`);
    const run = await res.json();
    const done = await pollRun(run.id, (r) => r.status === "completed", {
      label: "claude happy path",
    });
    assert(nodeOf(done, "n0").status === "done", "claude n0 done");
    assert(
      /STUB-DONE-OK/.test(nodeOf(done, "n0").logTail || ""),
      "claude logTail present (cat prompt | claude stub path)",
    );
    console.log(`  ok: (b) claude-cli provider run -> completed, n0 done`);
  }

  // ---- (c) DELETE /runs/:id kills the live agrun- job + marks cancelled --
  {
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "long job SLEEP=30" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start long run -> ${res.status}`);
    const run = await res.json();
    const agrun = `agrun-${run.id}-n0`;
    assert(tmuxHasSession(agrun), "long run agrun job live before DELETE");

    const del = await req("DELETE", `/api/agentic/runs/${enc(run.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(del.status === 204, `DELETE run -> ${del.status} (exp 204)`);
    await sleep(300);
    assert(!tmuxHasSession(agrun), "agrun tmux job killed by DELETE");
    const after = await (
      await req("GET", `/api/agentic/runs/${enc(run.id)}`)
    ).json();
    assert(after.status === "cancelled", `run cancelled (got ${after.status})`);
    assert(
      nodeOf(after, "n0").status === "skipped",
      "running node flipped to skipped on cancel",
    );
    console.log(`  ok: (c) DELETE run -> 204, agrun- killed, run cancelled`);
  }

  // ---- (f) config-freeze (D9): editing app+agent after start is invisible
  {
    const { appId, agentIds } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "freeze me SLEEP=30" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start freeze run -> ${res.status}`);
    const run = await res.json();
    const frozenVersion = run.agenticAiVersion;
    const frozenAgentPrompt =
      run.resolvedConfig.agents[agentIds[0]].systemPrompt;

    // Edit the app (definition edit -> version bump) AND the agent's systemPrompt.
    const pApp = await req("PATCH", `/api/agentic/apps/${enc(appId)}`, {
      body: { description: "edited after run started" },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      (await pApp.json()).version === frozenVersion + 1,
      "app version bumped by the post-start edit",
    );
    await req("PATCH", `/api/agentic/agents/${enc(agentIds[0])}`, {
      body: { systemPrompt: "MUTATED-AFTER-START" },
      origin: ALLOWED_ORIGIN,
    });

    // The run's frozen snapshot is untouched.
    const after = await (
      await req("GET", `/api/agentic/runs/${enc(run.id)}`)
    ).json();
    assert(
      after.agenticAiVersion === frozenVersion,
      `run agenticAiVersion frozen (${after.agenticAiVersion} vs ${frozenVersion})`,
    );
    assert(
      after.resolvedConfig.agents[agentIds[0]].systemPrompt ===
        frozenAgentPrompt,
      "run resolvedConfig agent systemPrompt frozen (not the mutated value)",
    );
    assert(
      after.resolvedConfig.agents[agentIds[0]].systemPrompt !==
        "MUTATED-AFTER-START",
      "run did NOT pick up the post-start agent edit",
    );
    // Kill the freeze run to free the slot.
    await req("DELETE", `/api/agentic/runs/${enc(run.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    await sleep(200);
    console.log(
      `  ok: (f) config-freeze — post-start app+agent edits invisible to the run`,
    );
  }

  // ---- (a) THE LOAD-BEARING TEST: crash mid-run, boot rediscovery -------
  {
    const { appId } = await createRunnerApp({
      mode: "sequential",
      providers: ["codex-cli", "codex-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: {
        sessionId: targetSessionId,
        objective: "survive restart SLEEP=5",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start restart run -> ${res.status}`);
    const run = await res.json();
    const runId = run.id;
    const n0Sess = `agrun-${runId}-n0`;
    const n1Sess = `agrun-${runId}-n1`;
    // 202 guarantees n0 spawned+running; n1 not yet (sequential, edge-gated).
    assert(nodeOf(run, "n0").status === "running", "n0 running at 202");
    assert(nodeOf(run, "n1").status === "pending", "n1 still pending at 202");
    assert(tmuxHasSession(n0Sess), "n0 agrun job live before crash");
    assert(!tmuxHasSession(n1Sess), "n1 NOT spawned before crash");

    // Simulate a CRASH: SIGKILL (not SIGTERM) the gateway while n0 sleeps.
    await stopServer("SIGKILL");
    // The detached tmux job must OUTLIVE the gateway (the whole point of D3/tmux).
    assert(
      tmuxHasSession(n0Sess),
      "n0 agrun job survived the gateway SIGKILL (tmux is the process owner)",
    );

    // Boot a FRESH gateway at the SAME AGENTIC_FILE + AGENT_RUNS_DIR + stub.
    await startServer();
    await login(); // in-memory sessions were lost on restart
    // Boot rediscovery should have logged (best-effort corroboration).
    const bootSawRun = /rediscovered at boot/.test(serverOut);

    // THE assertion: the run advances to completion under the NEW gateway. n1
    // done is ONLY reachable if the fresh gateway reaped n0 and spawned n1.
    const done = await pollRun(
      runId,
      (r) => r.status === "completed" || r.status === "failed",
      { deadlineMs: 40000, label: "restart rediscovery" },
    );
    assert(
      done.status === "completed",
      `run completed after restart (got ${done.status}; nodes ${JSON.stringify(
        done.nodeExecutions.map((n) => [n.nodeId, n.status]),
      )})`,
    );
    assert(nodeOf(done, "n0").status === "done", "n0 done after restart");
    assert(
      nodeOf(done, "n1").status === "done",
      "n1 done — spawned by the FRESH gateway via boot rediscovery (D3 layer 2)",
    );
    assert(!tmuxHasSession(n0Sess), "n0 agrun cleaned up post-completion");
    assert(!tmuxHasSession(n1Sess), "n1 agrun cleaned up post-completion");
    console.log(
      `  ok: (a) LOAD-BEARING — SIGKILL mid-run, fresh gateway rediscovered${
        bootSawRun ? " (logged)" : ""
      } + advanced n0->n1 to completion`,
    );
  }

  // Stop the restarted gateway before spinning dedicated-config gateways.
  await stopServer("SIGTERM");

  // ======================================================================
  // ITERATION 3 — PER-RUN MCP PROXY + APPROVAL MEDIATION (real kanban-mcp)
  // ======================================================================
  // Drives tools/agentic-proxy/server.mjs DIRECTLY over its own stdin/stdout
  // with JSON-RPC (NEVER a real claude/codex CLI). The proxy spawns the REAL
  // tools/kanban-mcp child, which hits the REAL gateway. Proves, against a real
  // MCP server (not a mock): deny-tier omitted from tools/list AND rejected
  // by-name (defense-in-depth, call-time enforcement), allow-tier forwarded to
  // the real server, approval-tier blocked until the gateway's
  // approve/reject/timeout routes resolve it, and the run's toolCallLog[]
  // records every disposition. A long-lived SLEEP-stub run supplies a real
  // run+node (n0) whose pending-tool-call/approve routes back the proxy.
  {
    // Fresh gateway with the DEFAULT per-step timeout (30m) so the SLEEP=300
    // borrow-run's node n0 is never reaped mid-test. Isolated KANBAN_FILE.
    await startServer();
    await login();

    // A real target session for the borrow-run.
    const sres = await req("POST", "/api/sessions", {
      body: { name: "iter3-proxy-target", cwd: sessDir },
      origin: ALLOWED_ORIGIN,
    });
    assert(sres.status === 201, `iter3 target session -> ${sres.status}`);
    const iter3Session = (await sres.json()).id;
    await sleep(700); // let the shell settle so pane_current_path resolves

    // A REAL Kanban board (through the gateway, bearer) — the proxy's live tool
    // target, isolated in the temp KANBAN_FILE store.
    const bres = await req("POST", "/api/kanban/boards", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      body: { name: "iter3-proxy-board" },
    });
    assert(bres.status === 201, `iter3 create board -> ${bres.status}`);
    const boardId = (await bres.json()).id;

    // A long-lived run so node n0 stays alive while we mediate MCP tool calls.
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const rres = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: {
        sessionId: iter3Session,
        objective: "hold for proxy mediation SLEEP=300",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(rres.status === 202, `iter3 borrow-run -> ${rres.status}`);
    const runId = (await rres.json()).id;
    {
      const r = await (
        await req("GET", `/api/agentic/runs/${enc(runId)}`)
      ).json();
      assert(nodeOf(r, "n0").status === "running", "iter3 n0 running at 202");
    }

    // Hand-written policy manifest: one allow-tier, one deny-tier, one
    // approval-tier tool on the kanban target (a throwaway file the test writes).
    const manifestPath = path.join(tmpDir, "iter3-policy.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        connections: [
          {
            connectionId: "conn-k",
            targetType: "kanban",
            toolPolicies: [
              { tools: ["kanban_get_board"], policy: "allow" },
              { tools: ["kanban_delete_board"], policy: "deny" },
              { tools: ["kanban_add_card"], policy: "approval" },
              // FIX 3: an INVALID policy string — only reachable via a corrupt /
              // hand-edited manifest (CRUD validates), must fail CLOSED (deny),
              // not fall through to approval/listed (fail-open).
              { tools: ["kanban_update_card"], policy: "bogus" },
            ],
          },
        ],
        gatewayBaseUrl: BASE,
        runId,
        nodeId: "n0",
      }),
    );

    const proxyEnv = (timeoutMs) => ({
      GATEWAY_API_TOKEN: API_TOKEN,
      GATEWAY_BASE_URL: BASE,
      AGENTIC_RUN_ID: runId,
      AGENTIC_NODE_ID: "n0",
      AGENTIC_POLICY_FILE: manifestPath,
      AGENT_MCP_APPROVAL_TIMEOUT_MS: String(timeoutMs),
      KANBAN_API_TOKEN: "",
    });
    const textOf = (r) =>
      (r && r.content && r.content[0] && r.content[0].text) || "";
    const parkPred = (r) => {
      const n = nodeOf(r, "n0");
      return !!(n && n.status === "waiting-approval" && n.pendingToolCall);
    };

    // ---- Proxy A: long approval hold — initialize/list/allow/deny/approve/reject
    const proxyA = new ProxyClient(proxyEnv(60000));
    await proxyA.ready;

    const initR = await proxyA.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "iter3-test", version: "1" },
    });
    assert(
      initR && initR.serverInfo && initR.serverInfo.name === "agentic-proxy",
      "proxy initialize -> ok (serverInfo agentic-proxy)",
    );

    // tools/list — deny EXCLUDED entirely; allow + approval present + annotated.
    const listR = await proxyA.call("tools/list", {});
    const listed = (listR.tools || []).map((t) => t.name);
    assert(
      listed.includes("kanban_get_board") && listed.includes("kanban_add_card"),
      "tools/list includes the allow + approval tiers",
    );
    assert(
      !listed.includes("kanban_delete_board"),
      "tools/list EXCLUDES the deny-tier tool entirely",
    );
    assert(
      (listR.tools || []).every(
        (t) => t.annotations && t.annotations.readOnlyHint === true,
      ),
      "listed tools carry the injected readOnlyHint:true annotation",
    );

    // allow-tier: forwarded to the REAL kanban server, real result returned.
    const getR = await proxyA.call("tools/call", {
      name: "kanban_get_board",
      arguments: { board_id: boardId },
    });
    assert(!getR.isError, "allow-tier kanban_get_board is not isError");
    assert(
      textOf(getR).includes(boardId) &&
        textOf(getR).includes("iter3-proxy-board"),
      "allow-tier returned the REAL board from the kanban server (forwarded)",
    );

    // deny-by-name (MANDATORY): call the deny-tier tool BY NAME anyway. It must
    // be rejected at call time (never forwarded) — proving defense in depth,
    // not mere list-omission. The board must still exist afterward.
    const denyR = await proxyA.call("tools/call", {
      name: "kanban_delete_board",
      arguments: { board_id: boardId },
    });
    assert(
      denyR.isError === true,
      "deny-by-name kanban_delete_board -> isError (call-time enforcement)",
    );
    assert(
      /not permitted/i.test(textOf(denyR)),
      "deny-by-name message names the block",
    );
    const stillThere = await req("GET", `/api/kanban/boards/${enc(boardId)}`, {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert(
      stillThere.status === 200,
      "deny-tier call was NOT forwarded — board still exists (defense in depth)",
    );
    // FIX 3 (fail-CLOSED on unknown policy): the kanban_update_card tool has an
    // invalid policy ("bogus") in the manifest. It must NOT appear in
    // tools/list, and a direct call must be rejected (isError, never forwarded)
    // — proving unknown resolves to deny, not the approval/allow fall-through.
    assert(
      !listed.includes("kanban_update_card"),
      "FIX3: unknown-policy tool EXCLUDED from tools/list (fail-closed)",
    );
    const bogusR = await proxyA.call("tools/call", {
      name: "kanban_update_card",
      arguments: { board_id: boardId, card_id: "nope", title: "x" },
    });
    assert(
      bogusR.isError === true,
      "FIX3: unknown-policy tool call -> isError (treated as deny)",
    );
    assert(
      /not permitted/i.test(textOf(bogusR)),
      "FIX3: unknown-policy call rejected with the deny message",
    );
    console.log(
      `  ok: (iter3) proxy initialize + tools/list (deny excluded, allow/approval annotated) + allow forwards real board + DENY-BY-NAME rejected, board intact + FIX3 unknown-policy fails closed`,
    );

    // approval-tier: APPROVE path — the call blocks until the gateway approves.
    {
      const { promise } = proxyA.request("tools/call", {
        name: "kanban_add_card",
        arguments: { board_id: boardId, title: "approved-card" },
      });
      await pollRun(runId, parkPred, { label: "approve-park" });
      const ap = await req(
        "POST",
        `/api/agentic/runs/${enc(runId)}/nodes/n0/approve`,
        { body: {}, origin: ALLOWED_ORIGIN },
      );
      assert(ap.status === 200, `approve route -> ${ap.status}`);
      const res = (await promise).result;
      assert(!res.isError, "approved kanban_add_card completed (not isError)");
      assert(
        /approved-card/.test(textOf(res)),
        "approved card really created on the real board (forwarded post-approval)",
      );
    }

    // approval-tier: REJECT path — the call blocks until the gateway rejects.
    {
      const { promise } = proxyA.request("tools/call", {
        name: "kanban_add_card",
        arguments: { board_id: boardId, title: "rejected-card" },
      });
      await pollRun(runId, parkPred, { label: "reject-park" });
      const rj = await req(
        "POST",
        `/api/agentic/runs/${enc(runId)}/nodes/n0/reject`,
        { body: { reason: "nope" }, origin: ALLOWED_ORIGIN },
      );
      assert(rj.status === 200, `reject route -> ${rj.status}`);
      const res = (await promise).result;
      assert(res.isError === true, "rejected kanban_add_card -> isError");
      assert(
        /rejected by human/i.test(textOf(res)),
        "reject message surfaced to the caller",
      );
    }
    console.log(
      `  ok: (iter3) approval mediation — APPROVE completes the real forwarded call, REJECT -> isError`,
    );

    // FIX 1 (self-approval defense): approve/reject are HUMAN-COOKIE-ONLY. A
    // bearer-only caller (the token the agent can read out of its own
    // --mcp-config) must be rejected 403 — even against any run/node path,
    // needing no parked node. The human path (cookie, exercised above) still
    // works. Proves the agent cannot self-approve its own gated tool call.
    {
      const ba = await req(
        "POST",
        `/api/agentic/runs/${enc(runId)}/nodes/n0/approve`,
        {
          body: {},
          cookie: false,
          headers: { authorization: `Bearer ${API_TOKEN}` },
        },
      );
      assert(
        ba.status === 403,
        `FIX1: bearer-only approve -> ${ba.status} (exp 403)`,
      );
      assert(
        /approval_requires_human/.test((await ba.json()).error || ""),
        "FIX1: bearer approve 403 names approval_requires_human",
      );
      const br = await req(
        "POST",
        `/api/agentic/runs/${enc(runId)}/nodes/n0/reject`,
        {
          body: { reason: "x" },
          cookie: false,
          headers: { authorization: `Bearer ${API_TOKEN}` },
        },
      );
      assert(
        br.status === 403,
        `FIX1: bearer-only reject -> ${br.status} (exp 403)`,
      );
      console.log(
        `  ok: (iter3/FIX1) bearer-only approve/reject rejected 403 (self-approval defense); human cookie path works`,
      );
    }

    await proxyA.close();
    assert(
      (await proxyA.exited) === 0,
      "proxy A exited cleanly on stdin end (kanban-mcp child reaped)",
    );

    // ---- Proxy B: short local timeout -> approval_pending_timeout ----
    const proxyB = new ProxyClient(proxyEnv(2500));
    await proxyB.ready;
    await proxyB.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "iter3-timeout", version: "1" },
    });
    {
      const { promise } = proxyB.request("tools/call", {
        name: "kanban_add_card",
        arguments: { board_id: boardId, title: "timeout-card" },
      });
      // Deliberately do NOT approve/reject — let the proxy's own ~2.5s hold lapse.
      const res = (await promise).result;
      assert(
        res.isError === true,
        "un-decided approval-tier call -> isError after the proxy timeout",
      );
      assert(
        /approval_pending_timeout/.test(textOf(res)),
        "proxy returns approval_pending_timeout on its local hold timeout",
      );
      // The disposition log + the best-effort timeout POST are BOTH
      // fire-and-forget — observe the timed_out entry BEFORE tearing the proxy
      // down (killing it first could race the POST out).
      await pollRun(
        runId,
        (r) => (r.toolCallLog || []).some((e) => e.disposition === "timed_out"),
        { label: "timeout-log" },
      );
    }
    await proxyB.close();
    assert((await proxyB.exited) === 0, "proxy B exited cleanly on stdin end");
    console.log(
      `  ok: (iter3) approval TIMEOUT -> approval_pending_timeout + timed_out logged`,
    );

    // ---- toolCallLog[] recorded EVERY disposition (allow/deny/approved/rejected/timed_out)
    const finalRun = await pollRun(
      runId,
      (r) => {
        const d = new Set((r.toolCallLog || []).map((e) => e.disposition));
        return ["allow", "deny", "approved", "rejected", "timed_out"].every(
          (x) => d.has(x),
        );
      },
      { label: "toolCallLog dispositions" },
    );
    const dispositions = new Set(
      (finalRun.toolCallLog || []).map((e) => e.disposition),
    );
    for (const d of ["allow", "deny", "approved", "rejected", "timed_out"]) {
      assert(
        dispositions.has(d),
        `run.toolCallLog recorded the '${d}' disposition`,
      );
    }
    console.log(
      `  ok: (iter3) run.toolCallLog recorded allow/deny/approved/rejected/timed_out (${finalRun.toolCallLog.length} entries)`,
    );

    // FIX 5 (cancel resolves a pending approval): park n0 on a FRESH pending
    // tool-call (via the proxy's bearer pending-tool-call route — no live proxy
    // needed), then cancel the run. killRun -> killRunningJobs must resolve that
    // pending ptc (disposition timed_out — the store has no "cancelled") BEFORE
    // marking the node skipped, so the cancelled run never leaves the impossible
    // shape (skipped node w/ status:"pending" ptc) and a post-cancel approve
    // can't appear to succeed against a live pending record.
    {
      const park = await req(
        "POST",
        `/api/agentic/runs/${enc(runId)}/nodes/n0/pending-tool-call`,
        {
          body: {
            toolName: "kanban_add_card",
            connectionId: "conn-k",
            argsPreview: "{}",
          },
          cookie: false,
          headers: { authorization: `Bearer ${API_TOKEN}` },
        },
      );
      assert(
        park.status === 201,
        `FIX5: park pending-tool-call -> ${park.status} (exp 201)`,
      );
      const parked = await (
        await req("GET", `/api/agentic/runs/${enc(runId)}`)
      ).json();
      assert(
        nodeOf(parked, "n0").status === "waiting-approval" &&
          nodeOf(parked, "n0").pendingToolCall.status === "pending",
        "FIX5: n0 parked (waiting-approval, ptc pending) before cancel",
      );
    }

    // Tear down the borrow-run — it MUST reach a terminal state, else block (d)'s
    // boot-rediscovery sees an active run against AGENT_MAX_CONCURRENT_RUNS=1 and
    // run A trips 429 instead of 202 (killRun treats waiting-approval as active).
    const del = await req("DELETE", `/api/agentic/runs/${enc(runId)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(del.status === 204, `iter3 delete borrow-run -> ${del.status}`);
    await sleep(300);
    const gone = await (
      await req("GET", `/api/agentic/runs/${enc(runId)}`)
    ).json();
    assert(
      gone.status === "cancelled",
      `iter3 borrow-run cancelled (got ${gone.status})`,
    );
    // FIX 5: the previously-parked n0 is now a CONSISTENT terminal shape —
    // skipped, and its pending ptc resolved to timed_out (NOT left "pending").
    {
      const n0 = nodeOf(gone, "n0");
      assert(
        n0.status === "skipped",
        `FIX5: cancelled-run n0 skipped (got ${n0.status})`,
      );
      assert(
        n0.pendingToolCall && n0.pendingToolCall.status === "timed_out",
        `FIX5: cancelled-run n0 ptc resolved timed_out (got ${n0.pendingToolCall && n0.pendingToolCall.status})`,
      );
    }
    const dsess = await req("DELETE", `/api/sessions/${enc(iter3Session)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(
      dsess.status === 204,
      `iter3 delete target session -> ${dsess.status}`,
    );
    await sleep(400);
    await stopServer("SIGTERM");
    console.log(
      `  ok: (iter3) borrow-run cancelled + target session removed (block-d rediscovery stays clean)`,
    );
  }

  // ---- (d) AGENT_MAX_CONCURRENT_RUNS exceeded -> 429 --------------------
  {
    await startServer({ AGENT_MAX_CONCURRENT_RUNS: "1" });
    await login();
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const a = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "hold a slot SLEEP=30" },
      origin: ALLOWED_ORIGIN,
    });
    assert(a.status === 202, `run A (fills cap) -> ${a.status}`);
    const runA = await a.json();
    const b = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: { sessionId: targetSessionId, objective: "over cap SLEEP=30" },
      origin: ALLOWED_ORIGIN,
    });
    assert(b.status === 429, `run B over cap -> ${b.status} (exp 429)`);
    assert(
      /too many|concurrent/i.test((await b.json()).error),
      "429 body names the concurrency cap",
    );
    // Free the slot.
    await req("DELETE", `/api/agentic/runs/${enc(runA.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    await sleep(300);
    await stopServer("SIGTERM");
    console.log(`  ok: (d) AGENT_MAX_CONCURRENT_RUNS cap -> 429 too_many_runs`);
  }

  // ---- (e) per-step AGENT_RUN_TIMEOUT_MS -> step reaped as failed -------
  {
    await startServer({ AGENT_RUN_TIMEOUT_MS: "1500" });
    await login();
    const { appId } = await createRunnerApp({
      mode: "single",
      providers: ["codex-cli"],
    });
    const res = await req("POST", `/api/agentic/apps/${enc(appId)}/run`, {
      body: {
        sessionId: targetSessionId,
        objective: "hang forever SLEEP=3600",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 202, `start hang run -> ${res.status}`);
    const run = await res.json();
    const agrun = `agrun-${run.id}-n0`;
    const done = await pollRun(
      run.id,
      (r) => r.status === "failed" || r.status === "completed",
      { deadlineMs: 15000, label: "timeout" },
    );
    assert(
      done.status === "failed",
      `hung run reaped to failed (got ${done.status})`,
    );
    assert(
      nodeOf(done, "n0").status === "failed",
      "timed-out step reaped as failed (no distinct timeout status in the model)",
    );
    await sleep(300);
    assert(
      !tmuxHasSession(agrun),
      "timed-out agrun job was killed by the reap",
    );
    console.log(
      `  ok: (e) per-step AGENT_RUN_TIMEOUT_MS -> step killed + reaped as failed`,
    );

    // Teardown the reusable target session via the (still-running) gateway, then
    // stop it — so the leak check below sees a truly clean tmux state.
    const delSess = await req(
      "DELETE",
      `/api/sessions/${enc(targetSessionId)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      delSess.status === 204,
      `delete target session -> ${delSess.status}`,
    );
    await sleep(400);
    await stopServer("SIGTERM");
  }

  // ---- Final: no agrun-/web- tmux sessions leaked -----------------------
  {
    const leaked = [...tmuxSessions()].filter(
      (s) =>
        !tmuxBefore.has(s) && (s.startsWith("agrun-") || s.startsWith("web-")),
    );
    assert(
      leaked.length === 0,
      `no agrun-/web- tmux sessions leaked (leaked: ${leaked.join(" | ")})`,
    );
    console.log(`  ok: no agrun-/web- tmux sessions leaked`);
  }

  cleanup();
  console.log(`\nPASS (${checks} checks)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
