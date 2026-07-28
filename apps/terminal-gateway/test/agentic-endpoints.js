// Agentic AI Creator REST integration test (iteration 1) — proves /api/agentic/*
// against a real gateway with a temp AGENTIC_FILE sidecar (no tmux; the Creator
// artifact is gateway-global, and iter1 spawns NO runs).
//
// Covers (docs/AGENTIC-AI-CREATOR-PLAN.md §7, iter1 CRUD slice):
//   - Agents:      create / list / get / patch / delete (+ rev bump + stale 409)
//   - Connections: create / list / delete (NO patch, NO get-by-id — plan §3)
//   - Apps:        create / list / get / patch / delete (+ rev bump + stale 409)
//   - Publish:     PATCH /apps/:id/status flips status, bumps rev, NOT version;
//                  PATCH /apps/:id (definition edit) bumps BOTH version + rev (D9)
//   - Workflow validation: dangling edge / cycle -> 422 (with offending edge)
//   - GET /mcp-servers -> pm + kanban
//   - Auth:        cookie session AND scoped bearer token; bad bearer -> 401
//   - CSRF:        foreign Origin -> 403 on a write; GET Origin-exempt;
//                  missing Origin allowed (the bearer/CLI path)
//   - 404s for unknown ids; 413 for an oversize body
//   - Run routes are NOT active in iter1: GET /runs is read-only ([]), but
//     POST /apps/:id/run and DELETE /runs/:id fall through to 404 and spawn nothing.
// Auth ENABLED, like the kanban/pm tests.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "agenticuser";
const AUTH_PASS = "agentic-pass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "http://evil.example.com";
const API_TOKEN = "agentic-test-bearer-token-xyz";

let server;
let cookie = "";
let agenticFile = "";
let checks = 0;
let tmuxBefore = new Set();

// Snapshot current tmux session names (empty when no server is running). Used to
// assert iter1 spawns NO new tmux session — a before/after diff so unrelated,
// pre-existing dev sessions never trip the check.
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
    // `tmux ls` exits non-zero when no server is running — that's fine.
    return new Set();
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-endpoints-"));
    agenticFile = path.join(tmpDir, "agentic.json");
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        GATEWAY_AUTH_USER: AUTH_USER,
        GATEWAY_AUTH_PASSWORD: AUTH_PASS,
        // Neutralize any leaked parent-env auth vars that would change the mode.
        GATEWAY_AUTH_PASSWORD_HASH: "",
        GATEWAY_AUTH_TOKEN: "",
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        AGENTIC_FILE: agenticFile,
        GATEWAY_API_TOKEN: API_TOKEN, // scoped bearer for the CLI path
        KANBAN_API_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    server.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("listening on")) resolve();
    });
    server.stderr.on("data", (d) => process.stderr.write(`[gw] ${d}`));
    setTimeout(() => reject(new Error("server did not start in time")), 8000);
  });
}
function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  try {
    if (agenticFile)
      fs.rmSync(path.dirname(agenticFile), { recursive: true, force: true });
  } catch {}
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

async function main() {
  tmuxBefore = tmuxSessions();
  await startServer();
  await login();
  console.log(
    `gateway up on :${PORT} (auth enabled, temp AGENTIC_FILE, bearer configured)`,
  );

  // ---- Agents: create / list / get / patch / delete ---------------------
  let agent;
  {
    // Missing runtimeProvider -> 400 (valid-body guard).
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
    // PATCH bumps rev.
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
    // Stale optimistic-concurrency: wrong expectedRev -> 409 (no record in body).
    const stale = await req("PATCH", `/api/agentic/agents/${enc(agent.id)}`, {
      body: { role: "x", expectedRev: agent.rev - 1 },
      origin: ALLOWED_ORIGIN,
    });
    assert(stale.status === 409, `stale agent patch -> ${stale.status}`);
    assert(/stale/i.test((await stale.json()).error), "409 stale message");
    // Correct expectedRev -> 200.
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
    // PATCH (definition edit, D9) bumps BOTH version and rev.
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
    // PATCH /status (publish) flips status, bumps rev, NOT version.
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
    // Bad status -> 400.
    const bad = await req("PATCH", `/api/agentic/apps/${enc(app.id)}/status`, {
      body: { status: "nonsense" },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 400, `bad status -> ${bad.status}`);
    // Stale publish -> 409.
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
    // App stale PATCH (definition edit) -> 409.
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
    // Valid workflow accepted.
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

    // Dangling edge -> 422 with offending edge in the body.
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

    // Cycle -> 422.
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

    // Cycle rejection on PATCH leaves the store clean (still fetchable, v unchanged).
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
    // Bearer GET, no cookie -> 200 (missing Origin is allowed).
    const g = await req("GET", "/api/agentic/agents", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert(g.status === 200, `bearer GET -> ${g.status}`);
    // Bearer write, no cookie, no Origin -> 201 (CSRF guard is a no-op w/o Origin).
    const w = await req("POST", "/api/agentic/agents", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      body: { name: "ViaCli", runtimeProvider: "claude-cli" },
    });
    assert(w.status === 201, `bearer write -> ${w.status}`);
    // Bad bearer, no cookie -> 401.
    const bad = await req("GET", "/api/agentic/agents", {
      cookie: false,
      headers: { authorization: "Bearer wrong-token" },
    });
    assert(bad.status === 401, `bad bearer -> ${bad.status}`);
    // No auth at all -> 401.
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

  // ---- Run routes NOT active in iter1 -----------------------------------
  {
    // GET /runs IS active (read-only) and empty.
    const runs = await req("GET", "/api/agentic/runs");
    assert(runs.status === 200, `list runs -> ${runs.status}`);
    assert(Array.isArray((await runs.json()).runs), "runs list is an array");
    const rGet = await req("GET", "/api/agentic/runs/run-nope");
    assert(rGet.status === 404, `unknown run -> ${rGet.status}`);
    // POST /apps/:id/run must NOT be wired -> 404 (cookie + allowed origin so
    // the CSRF/auth gate does not mask the fall-through 404).
    const start = await req("POST", `/api/agentic/apps/${enc(app.id)}/run`, {
      body: { objective: "do a thing" },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      start.status === 404,
      `start-run route -> ${start.status} (must be inactive in iter1)`,
    );
    // DELETE /runs/:id (kill) also not wired -> 404.
    const kill = await req("DELETE", "/api/agentic/runs/run-nope", {
      origin: ALLOWED_ORIGIN,
    });
    assert(kill.status === 404, `kill-run route -> ${kill.status}`);
    console.log(
      `  ok: run engine inactive — GET /runs read-only, run/kill routes 404`,
    );
  }

  // ---- 413 for an oversize body -----------------------------------------
  {
    // > BODY_LIMIT (64 KiB). readBody rejects at the cap and destroys the
    // socket, so the gateway may either send a clean 413 OR the socket close
    // may surface as a fetch network error — both prove the oversize body was
    // rejected (never processed into a 201). Accept either; forbid a 2xx.
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

  // ---- delete agent / connection / app (round out CRUD) -----------------
  {
    const da = await req("DELETE", `/api/agentic/agents/${enc(agent.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(da.status === 204, `delete agent -> ${da.status}`);
    assert(
      (await req("GET", `/api/agentic/agents/${enc(agent.id)}`)).status === 404,
      "deleted agent now 404",
    );
    const dc = await req(
      "DELETE",
      `/api/agentic/connections/${enc(connection.id)}`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(dc.status === 204, `delete connection -> ${dc.status}`);
    const dp = await req("DELETE", `/api/agentic/apps/${enc(app.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(dp.status === 204, `delete app -> ${dp.status}`);
    assert(
      (await req("GET", `/api/agentic/apps/${enc(app.id)}`)).status === 404,
      "deleted app now 404",
    );
    console.log(`  ok: delete agent/connection/app (204 + subsequent 404)`);
  }

  // ---- No NEW tmux sessions were spawned by iter1 -----------------------
  // Diff against the pre-test snapshot so unrelated, long-lived dev sessions
  // don't cause a false positive. iter1 has no route that reaches the run
  // engine, so nothing should be added.
  {
    const after = tmuxSessions();
    const added = [...after].filter((s) => !tmuxBefore.has(s));
    assert(
      added.length === 0,
      `iter1 spawned no new tmux sessions (new: ${added.join(" | ")})`,
    );
    console.log(`  ok: no new tmux sessions spawned by iter1`);
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
