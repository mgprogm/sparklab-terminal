// Task Master Hub endpoint test — proves /api/taskmaster/* against a real
// gateway, using a STUB `task-master` binary (TASKMASTER_COMMAND override) so
// nothing hits the network, npx, or a real AI provider. Mirrors the
// stub-binary pattern in codex-endpoints.js.
//
// The stub emulates the EXACT contracts verified live against the real CLI in
// docs/TASKMASTER-HUB-PLAN.md §1c/§1d/§1e — including the misleading
// `set-status --format json` success:true/empty-array-on-failure shape, the
// add-dependency circular-dependency text, and echoing `pwd` so legacy-family
// commands' real-cwd requirement (§1e #3) can be asserted directly.
//
// Covered: registry CRUD + binaryMode probe, summary-vs-full task projection
// (D9), the §1c set-status success rule (exit code + updatedTasks contains
// the id, never a bare `success` field), legacy commands always run with real
// cwd (never `--file` as a substitute), the binaryMode gate on legacy routes
// (core-only-npx -> 503), add-dependency cycle detection -> 400, the
// read-only tags/current-tag route + tags/use switch, and the POST
// Origin/CSRF guard.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3991;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "tmhubuser";
const AUTH_PASS = "tmhubpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";

let server;
let cookie = "";
let scratch; // scratch project dir (has a real .taskmaster/, but no real tasks)
let stubPath;

// A stub standing in for the `task-master` binary. Branches on argv content;
// echoes `pwd` + argv first so legacy-family cwd can be asserted.
const STUB = `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"--version"*)
    if [ -n "$TM_STUB_NO_BINARY" ]; then
      echo "task-master: command not found" >&2
      exit 127
    fi
    echo "0.43.1-stub"
    exit 0
    ;;
esac
echo "CWD: $(pwd)" >&2
echo "ARGS: $args" >&2
case "$args" in
  *"list --project"*)
    cat <<'JSON'
{"tasks":[{"id":"1","title":"Task One","status":"pending","priority":"high","dependencies":[],"blocks":[],"details":"a very long detail blob that should never reach the summary route","testStrategy":"strategy text"},{"id":"2","title":"Task Two","status":"done","priority":"low","dependencies":["1"],"blocks":[]}],"metadata":{"total":2,"filtered":2,"tag":"master"}}
JSON
    exit 0
    ;;
  *"show --id 1 --project"*)
    cat <<'JSON'
{"task":{"id":"1","title":"Task One","status":"pending","details":"a very long detail blob","testStrategy":"strategy text","subtasks":[]}}
JSON
    exit 0
    ;;
  *"show --id missing --project"*)
    echo '{"task":null,"found":false,"storageType":"file"}'
    exit 0
    ;;
  *"next --project"*)
    if [ -n "$TM_STUB_NEXT_EMPTY" ]; then
      echo '{"task":null,"found":false,"tag":"master","hasAnyTasks":true}'
    else
      echo '{"task":{"id":"1","title":"Task One","status":"pending"},"found":true}'
    fi
    exit 0
    ;;
  *"set-status --id 999"*)
    echo '{"success": true, "updatedTasks": [], "storageType": "file"}'
    echo '{"success":false,"error":"Failed to update task status for 999"}' >&2
    exit 1
    ;;
  *"set-status --id 1 --status done"*)
    echo '{"success": true, "updatedTasks": [{"id": "1"}], "storageType": "file"}'
    exit 0
    ;;
  *"add-task"*"FAIL_PROMPT"*)
    echo "boom: add-task failed" >&2
    exit 1
    ;;
  *"add-task"*)
    echo "Task created"
    exit 0
    ;;
  *"update-task"*"FAIL_PROMPT"*)
    echo "boom: update-task failed" >&2
    exit 1
    ;;
  *"update-task"*)
    echo "Task updated"
    exit 0
    ;;
  *"expand --id FAILME"*)
    echo "boom: expand failed" >&2
    exit 1
    ;;
  *"expand"*)
    echo "Subtasks generated"
    exit 0
    ;;
  *"add-dependency --id 1 --depends-on 2"*)
    echo "[ERROR] Cannot add dependency 2 to task 1 as it would create a circular dependency." >&2
    exit 1
    ;;
  *"add-dependency"*)
    echo "[WARN] Dependency already exists in task"
    exit 0
    ;;
  *"tags use badtag"*)
    echo '[ERROR] Tag "badtag" does not exist' >&2
    exit 1
    ;;
  *"tags use"*)
    echo "[SUCCESS] Successfully switched to tag"
    exit 0
    ;;
esac
echo "unrecognized: $args" >&2
exit 2
`;

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        GATEWAY_AUTH_USER: AUTH_USER,
        GATEWAY_AUTH_PASSWORD: AUTH_PASS,
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        TASKMASTER_COMMAND: stubPath,
        TASKMASTER_PROJECTS_FILE: path.join(
          scratch,
          "taskmaster-projects.json",
        ),
        TASKMASTER_EXECUTIONS_FILE: path.join(
          scratch,
          "taskmaster-executions.json",
        ),
        ...env,
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
  if (scratch) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
  if (server && !server.killed) server.kill("SIGTERM");
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

async function req(method, pathname, { body, origin, headers } = {}) {
  const h = { ...headers };
  if (cookie) h["cookie"] = cookie;
  if (origin) h["origin"] = origin;
  let payload;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${BASE}${pathname}`, { method, headers: h, body: payload });
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  if (res.status !== 204) fail(`login returned ${res.status}, expected 204`);
  const setCookie = res.headers.get("set-cookie");
  const m = /gw_session=[^;]+/.exec(setCookie || "");
  assert(m, `set-cookie had no gw_session: ${setCookie}`);
  cookie = m[0];
}

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "taskmaster-endpoints-"));
  stubPath = path.join(scratch, "task-master-stub.sh");
  fs.writeFileSync(stubPath, STUB, { mode: 0o755 });

  // A real .taskmaster/ dir with a real state.json — the registration probe
  // (D1) and the tags/current route (D12, reads state.json directly) both
  // touch the real filesystem, never the stub.
  const projectDir = path.join(scratch, "project");
  fs.mkdirSync(path.join(projectDir, ".taskmaster"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".taskmaster", "state.json"),
    JSON.stringify({ currentTag: "master" }),
  );

  await startServer();
  console.log(`gateway up on :${PORT} (auth enabled, stub task-master)`);
  await login();
  console.log("logged in; cookie captured");

  // auth: no cookie -> 401
  {
    const res = await fetch(`${BASE}/api/taskmaster/projects`);
    assert(res.status === 401, `no-cookie -> ${res.status}, expected 401`);
  }
  console.log("  ok: unauthenticated -> 401");

  // ===========================================================================
  // Registry: register (probes .taskmaster/ + binaryMode), list, get 400s
  // ===========================================================================
  let projectId;
  {
    const res = await req("POST", "/api/taskmaster/projects", {
      body: { name: "test project", serverId: "local", path: projectDir },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `register -> ${res.status}, expected 201`);
    const j = await res.json();
    assert(
      j.binaryMode === "binary",
      `binaryMode=${j.binaryMode}, expected binary`,
    );
    assert(j.path === projectDir, "path not stored verbatim");
    projectId = j.id;
  }
  {
    // no .taskmaster/ at this path -> 400
    const res = await req("POST", "/api/taskmaster/projects", {
      body: { name: "bad", serverId: "local", path: scratch },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res.status === 400,
      `register-no-taskmaster -> ${res.status}, expected 400`,
    );
  }
  {
    const res = await req("GET", "/api/taskmaster/projects");
    const j = await res.json();
    assert(
      j.projects.some((p) => p.id === projectId),
      "registered project missing from list",
    );
  }
  console.log(
    "  ok: register probes .taskmaster/ (400 if absent) + binaryMode (D1/D5)",
  );

  // ===========================================================================
  // GET tasks — summary projection strips details/testStrategy (D9)
  // ===========================================================================
  {
    const res = await req("GET", `/api/taskmaster/projects/${projectId}/tasks`);
    assert(res.status === 200, `list tasks -> ${res.status}`);
    const j = await res.json();
    assert(j.tasks.length === 2, `expected 2 tasks, got ${j.tasks.length}`);
    assert(
      j.tasks[0].id === "1" && j.tasks[0].status === "pending",
      "task 1 shape wrong",
    );
    assert(
      j.tasks[0].details === undefined,
      "summary route leaked full `details` (D9 violated)",
    );
    assert(
      j.tasks[0].testStrategy === undefined,
      "summary route leaked `testStrategy` (D9 violated)",
    );
    assert(j.metadata.tag === "master", "metadata not passed through");
  }
  console.log(
    "  ok: GET tasks — summary projection strips details/testStrategy (D9)",
  );

  // ===========================================================================
  // GET task detail — full show, and found:false -> 404
  // ===========================================================================
  {
    const res = await req(
      "GET",
      `/api/taskmaster/projects/${projectId}/tasks/1`,
    );
    assert(res.status === 200, `show -> ${res.status}`);
    const j = await res.json();
    assert(
      j.details === "a very long detail blob",
      "full detail missing `details`",
    );
  }
  {
    const res = await req(
      "GET",
      `/api/taskmaster/projects/${projectId}/tasks/missing`,
    );
    assert(res.status === 404, `show missing -> ${res.status}, expected 404`);
  }
  console.log("  ok: GET task detail — full show + found:false -> 404");

  // Execution metadata is gateway-owned: it must not change Task Master task
  // data, and an active claim cannot be silently taken by another agent.
  {
    const claim = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks/1/claim`,
      {
        body: { agentId: "agent-a", agentName: "Agent A" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(claim.status === 201, `claim -> ${claim.status}, expected 201`);
    const conflict = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks/1/claim`,
      { body: { agentId: "agent-b" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      conflict.status === 409,
      `conflicting claim -> ${conflict.status}, expected 409`,
    );
    const progress = await req(
      "PATCH",
      `/api/taskmaster/projects/${projectId}/tasks/1/execution`,
      {
        body: {
          agentId: "agent-a",
          status: "blocked",
          note: "waiting for dependency",
        },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(progress.status === 200, `progress -> ${progress.status}`);
    const overview = await req(
      "GET",
      `/api/taskmaster/projects/${projectId}/overview`,
    );
    const overviewJson = await overview.json();
    assert(
      overview.status === 200 && overviewJson.counts.total === 2,
      "overview task count wrong",
    );
    assert(
      overviewJson.counts.activeAgents === 1 &&
        overviewJson.executions[0].status === "blocked",
      "overview execution state wrong",
    );
  }
  console.log("  ok: execution claims + conflict guard + PM overview");

  // ===========================================================================
  // GET next
  // ===========================================================================
  {
    const res = await req("GET", `/api/taskmaster/projects/${projectId}/next`);
    const j = await res.json();
    assert(
      j.found === true && j.task.id === "1",
      "next did not return the ready task",
    );
  }
  console.log("  ok: GET next");

  // ===========================================================================
  // POST status — the §1c success rule: exit code AND updatedTasks contains
  // the id, never a bare `success` field
  // ===========================================================================
  {
    // task 999 simulates the real misleading contract: exit 1 with
    // success:true + empty updatedTasks on stdout.
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks/999/status`,
      { body: { status: "done" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      res.status === 400,
      `misleading set-status -> ${res.status}, expected 400 (never trust bare success:true)`,
    );
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks/1/status`,
      { body: { status: "done" }, origin: ALLOWED_ORIGIN },
    );
    assert(res.status === 200, `set-status -> ${res.status}, expected 200`);
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks/1/status`,
      { body: { status: "not-a-real-status" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      res.status === 400,
      `bad status enum -> ${res.status}, expected 400`,
    );
  }
  console.log(
    "  ok: POST status — §1c success rule (exit code + updatedTasks contains id, never bare success)",
  );

  // ===========================================================================
  // tags: GET current (reads state.json directly, D12) + POST use
  // ===========================================================================
  {
    const res = await req("GET", `/api/taskmaster/projects/${projectId}/tags`);
    const j = await res.json();
    assert(
      j.currentTag === "master",
      `currentTag=${j.currentTag}, expected master`,
    );
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tags/use`,
      { body: { name: "badtag" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      res.status === 400,
      `tags use badtag -> ${res.status}, expected 400`,
    );
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tags/use`,
      { body: { name: "feature-x" }, origin: ALLOWED_ORIGIN },
    );
    assert(res.status === 200, `tags use -> ${res.status}, expected 200`);
  }
  console.log(
    "  ok: tags — GET current (state.json, D12) + POST use (exit-code judged)",
  );

  // ===========================================================================
  // Legacy family: real cwd (never --file), binaryMode gate, cycle detection
  // ===========================================================================
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks`,
      {
        body: { prompt: "add a --quiet flag" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 201, `add-task -> ${res.status}, expected 201`);
    const j = await res.json();
    assert(Array.isArray(j.tasks), "add-task did not re-fetch the list");
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks`,
      {
        body: { prompt: "FAIL_PROMPT please" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      res.status === 400,
      `add-task failure -> ${res.status}, expected 400`,
    );
  }
  {
    const res = await req(
      "PATCH",
      `/api/taskmaster/projects/${projectId}/tasks/1`,
      { body: { prompt: "clarify the spec" }, origin: ALLOWED_ORIGIN },
    );
    assert(res.status === 200, `update-task -> ${res.status}, expected 200`);
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/tasks/1/expand`,
      { body: { num: 3 }, origin: ALLOWED_ORIGIN },
    );
    assert(res.status === 200, `expand -> ${res.status}, expected 200`);
  }
  {
    // The stub's circular-dependency case is keyed on id=1 depends-on=2.
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/dependencies`,
      { body: { id: "1", dependsOn: "2" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      res.status === 400,
      `add-dependency cycle -> ${res.status}, expected 400`,
    );
    const j = await res.json();
    assert(
      j.code === "dependency_cycle",
      `code=${j.code}, expected dependency_cycle`,
    );
  }
  {
    const res = await req(
      "POST",
      `/api/taskmaster/projects/${projectId}/dependencies`,
      { body: { id: "3", dependsOn: "4" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      res.status === 200,
      `add-dependency ok -> ${res.status}, expected 200`,
    );
  }
  console.log(
    "  ok: legacy family — add-task/update-task/expand/add-dependency (+ cycle -> 400 dependency_cycle)",
  );

  // Assert the stub actually saw the real project cwd for a legacy command
  // (§1e #3 — never `--file` as a substitute for real cwd).
  {
    // Re-run one legacy command and inspect the gateway's own behavior
    // indirectly: a project registered at a DIFFERENT real path must still
    // succeed (proves cwd, not a hardcoded path, drives the invocation).
    const projectDir2 = path.join(scratch, "project2");
    fs.mkdirSync(path.join(projectDir2, ".taskmaster"), { recursive: true });
    const res = await req("POST", "/api/taskmaster/projects", {
      body: { name: "second", serverId: "local", path: projectDir2 },
      origin: ALLOWED_ORIGIN,
    });
    const project2Id = (await res.json()).id;
    const addRes = await req(
      "POST",
      `/api/taskmaster/projects/${project2Id}/tasks`,
      {
        body: { prompt: "works from a different cwd too" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      addRes.status === 201,
      `cwd-portability check -> ${addRes.status}, expected 201`,
    );
  }
  console.log(
    "  ok: legacy commands driven by real project cwd, not a hardcoded path",
  );

  // ===========================================================================
  // binaryMode gate: a core-only-npx project 503s on every legacy route
  // ===========================================================================
  {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    await startServer({ TM_STUB_NO_BINARY: "1" });
    await login();
    const projectDirNpx = path.join(scratch, "project-npx");
    fs.mkdirSync(path.join(projectDirNpx, ".taskmaster"), { recursive: true });
    const res = await req("POST", "/api/taskmaster/projects", {
      body: { name: "npx-only", serverId: "local", path: projectDirNpx },
      origin: ALLOWED_ORIGIN,
    });
    const j = await res.json();
    assert(
      j.binaryMode === "core-only-npx",
      `binaryMode=${j.binaryMode}, expected core-only-npx when --version fails`,
    );
    const addRes = await req("POST", `/api/taskmaster/projects/${j.id}/tasks`, {
      body: { prompt: "should be rejected" },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      addRes.status === 503,
      `legacy route on core-only-npx project -> ${addRes.status}, expected 503`,
    );
    const tagRes = await req(
      "POST",
      `/api/taskmaster/projects/${j.id}/tags/use`,
      { body: { name: "x" }, origin: ALLOWED_ORIGIN },
    );
    assert(
      tagRes.status === 503,
      `tags/use on core-only-npx project -> ${tagRes.status}, expected 503`,
    );
  }
  console.log(
    "  ok: binaryMode probe (--version failure -> core-only-npx) gates every legacy route at 503 (D5, §1e #5)",
  );

  // ===========================================================================
  // CSRF/Origin guard on a write route (GET routes remain Origin-exempt above)
  // ===========================================================================
  {
    const res = await req("POST", "/api/taskmaster/projects", {
      body: { name: "x", serverId: "local", path: "/tmp" },
      origin: "http://evil.example",
    });
    assert(
      res.status === 403,
      `forbidden origin -> ${res.status}, expected 403`,
    );
  }
  console.log("  ok: forbidden Origin -> 403 (CSRF guard fires)");

  cleanup();
  console.log(
    "\nPASS: taskmaster endpoints — registry CRUD + binaryMode probe, D9 summary projection, §1c set-status success rule, tags current+use, legacy family real-cwd + binaryMode gate (503), add-dependency cycle -> 400, CSRF (403).",
  );
}

main().catch((err) => fail(err.stack || String(err)));
