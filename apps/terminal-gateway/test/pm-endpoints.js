// PM-tool REST integration test — proves /api/pm/* against a real gateway with a
// temp PM_FILE sidecar (no tmux; PM is gateway-global).
//
// Covers: project create (default 4 columns) / list / get; task create with
// fields (assignee/priority/dates) + derived columnId; MOVE splice + rev/409;
// DEPENDENCIES (set ok; cycle -> 400; task-delete scrubs dependsOn); SPRINTS
// (create; assign via PATCH; orthogonality with columns; delete nulls sprintId);
// date-less task accepted; CSRF; bearer via the LEGACY KANBAN_API_TOKEN (D10 —
// the deployed token must still authorize /api/pm); 404s / validation.
// Auth ENABLED, like the kanban/git tests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3992;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "pmuser";
const AUTH_PASS = "pmpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "http://evil.example.com";
// D10: set the LEGACY var only (no GATEWAY_API_TOKEN) — must still authorize /api/pm.
const LEGACY_TOKEN = "pm-test-legacy-token-xyz";

let server;
let cookie = "";
let pmFile = "";

function startServer() {
  return new Promise((resolve, reject) => {
    pmFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pm-endpoints-")),
      "pm.json",
    );
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        GATEWAY_AUTH_USER: AUTH_USER,
        GATEWAY_AUTH_PASSWORD: AUTH_PASS,
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        PM_FILE: pmFile,
        KANBAN_API_TOKEN: LEGACY_TOKEN, // legacy fallback (no GATEWAY_API_TOKEN)
        GATEWAY_API_TOKEN: "",
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
    if (pmFile)
      fs.rmSync(path.dirname(pmFile), { recursive: true, force: true });
  } catch {}
}
function fail(m) {
  console.error(`\nFAIL: ${m}`);
  cleanup();
  process.exit(1);
}
function assert(c, m) {
  if (!c) fail(m);
}
async function req(
  method,
  pathname,
  { body, origin, headers, cookie: useCookie = true } = {},
) {
  const h = { ...(headers || {}) };
  if (useCookie && cookie) h["cookie"] = cookie;
  if (origin) h["origin"] = origin;
  let payload;
  if (body !== undefined) {
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
  await startServer();
  await login();
  console.log(
    `gateway up on :${PORT} (auth enabled, temp PM_FILE, legacy token)`,
  );

  // --- create project (default 4 columns) -------------------------------
  let project;
  {
    const res = await req("POST", "/api/pm/projects", {
      body: { name: "Payments", tags: ["backend"] },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create project -> ${res.status}`);
    project = await res.json();
    assert(/^pm-/.test(project.id), "project id prefix");
    assert(project.columns.length === 4, "4 default columns");
    assert(project.rev === 1, "rev 1");
    assert(
      Array.isArray(project.tasks) && project.tasks.length === 0,
      "no tasks",
    );
    console.log(`  ok: create project ${project.id} (4 columns)`);
  }
  const backlog = project.columns[0].id;
  const inProgress = project.columns[2].id;

  // --- add tasks with fields --------------------------------------------
  const mk = async (title, extra = {}) => {
    const res = await req("POST", `/api/pm/projects/${enc(project.id)}/tasks`, {
      body: { title, columnId: backlog, ...extra },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `add task ${title} -> ${res.status}`);
    return res.json();
  };
  const a = await mk("Design API", {
    assignee: "lek",
    priority: "high",
    dueDate: 1750000000000,
  });
  const b = await mk("Implement", { priority: "medium" });
  assert(
    a.assignee === "lek" &&
      a.priority === "high" &&
      a.dueDate === 1750000000000,
    "task A fields echoed",
  );
  assert(a.columnId === backlog, "task A derived columnId = backlog");
  console.log(
    `  ok: 2 tasks with fields (assignee/priority/dueDate) + derived columnId`,
  );

  // --- date-less task accepted (Gantt "unscheduled" path) ---------------
  const c = await mk("No dates");
  assert(
    c.startDate === null && c.dueDate === null,
    "date-less task has null dates",
  );
  console.log(`  ok: date-less task accepted (startDate/dueDate null)`);

  // --- refresh rev, then MOVE a -> In Progress @0 -----------------------
  project = await (
    await req("GET", `/api/pm/projects/${enc(project.id)}`)
  ).json();
  {
    const res = await req("POST", `/api/pm/tasks/${enc(a.id)}/move`, {
      body: {
        projectId: project.id,
        toColumnId: inProgress,
        toIndex: 0,
        rev: project.rev,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `move -> ${res.status}`);
    const p = await res.json();
    assert(
      p.columns.find((x) => x.id === inProgress).taskIds.includes(a.id),
      "A now in In Progress",
    );
    assert(
      !p.columns.find((x) => x.id === backlog).taskIds.includes(a.id),
      "A left Backlog",
    );
    assert(p.rev === project.rev + 1, "rev bumped");
    project = p;
    console.log(`  ok: move task A Backlog -> In Progress (splice + rev bump)`);
  }

  // --- stale move -> 409 + current project ------------------------------
  {
    const res = await req("POST", `/api/pm/tasks/${enc(b.id)}/move`, {
      body: {
        projectId: project.id,
        toColumnId: inProgress,
        toIndex: 0,
        rev: project.rev - 1,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 409, `stale move -> ${res.status}`);
    const j = await res.json();
    assert(
      j.error === "stale" && j.project && j.project.rev === project.rev,
      "409 carries current project",
    );
    console.log(`  ok: stale rev move -> 409 (+ current project)`);
  }

  // --- dependencies: B depends on A (ok), then A->B cycle rejected ------
  {
    let res = await req("PATCH", `/api/pm/tasks/${enc(b.id)}`, {
      body: { projectId: project.id, dependsOn: [a.id] },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `set dep -> ${res.status}`);
    assert((await res.json()).dependsOn.includes(a.id), "B dependsOn A");
    // cycle: A dependsOn B  (A already <- B)
    res = await req("PATCH", `/api/pm/tasks/${enc(a.id)}`, {
      body: { projectId: project.id, dependsOn: [b.id] },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 400, `cycle dep -> ${res.status}, expected 400`);
    assert(/cycle/i.test((await res.json()).error), "cycle error message");
    // self-dependency rejected
    res = await req("PATCH", `/api/pm/tasks/${enc(a.id)}`, {
      body: { projectId: project.id, dependsOn: [a.id] },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 400, `self-dep -> ${res.status}, expected 400`);
    console.log(`  ok: dependencies — set ok, cycle -> 400, self-dep -> 400`);
  }

  // --- delete task A scrubs it from B.dependsOn -------------------------
  {
    const res = await req(
      "DELETE",
      `/api/pm/tasks/${enc(a.id)}?projectId=${enc(project.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 204, `delete task -> ${res.status}`);
    const p = await (
      await req("GET", `/api/pm/projects/${enc(project.id)}`)
    ).json();
    const bb = p.tasks.find((t) => t.id === b.id);
    assert(
      bb && !bb.dependsOn.includes(a.id),
      "A scrubbed from B.dependsOn after delete",
    );
    project = p;
    console.log(`  ok: delete task scrubs dependsOn (no dangling edge)`);
  }

  // --- sprints: create, assign via PATCH, orthogonality, delete ---------
  {
    let res = await req("POST", `/api/pm/projects/${enc(project.id)}/sprints`, {
      body: { name: "Sprint 1", startDate: 1750000000000 },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create sprint -> ${res.status}`);
    const sprint = await res.json();
    // put B in In Progress, then assign sprint — column must be unchanged
    project = await (
      await req("GET", `/api/pm/projects/${enc(project.id)}`)
    ).json();
    await req("POST", `/api/pm/tasks/${enc(b.id)}/move`, {
      body: {
        projectId: project.id,
        toColumnId: inProgress,
        toIndex: 0,
        rev: project.rev,
      },
      origin: ALLOWED_ORIGIN,
    });
    res = await req("PATCH", `/api/pm/tasks/${enc(b.id)}`, {
      body: { projectId: project.id, sprintId: sprint.id },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `assign sprint -> ${res.status}`);
    let bb = await res.json();
    assert(bb.sprintId === sprint.id, "B.sprintId set");
    assert(
      bb.columnId === inProgress,
      "B still In Progress after sprint assign (orthogonal)",
    );
    // delete sprint -> B.sprintId null, still In Progress
    res = await req(
      "DELETE",
      `/api/pm/sprints/${enc(sprint.id)}?projectId=${enc(project.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 204, `delete sprint -> ${res.status}`);
    const p = await (
      await req("GET", `/api/pm/projects/${enc(project.id)}`)
    ).json();
    bb = p.tasks.find((t) => t.id === b.id);
    assert(bb.sprintId === null, "B.sprintId nulled after sprint delete");
    assert(
      bb.columnId === inProgress,
      "B still In Progress after sprint delete",
    );
    console.log(`  ok: sprints — assign/orthogonality/delete-nulls-sprintId`);
  }

  // --- CSRF: foreign Origin -> 403 write; GET exempt --------------------
  {
    const w = await req("POST", "/api/pm/projects", {
      body: { name: "nope" },
      origin: FOREIGN_ORIGIN,
    });
    assert(w.status === 403, `foreign-origin write -> ${w.status}`);
    const g = await req("GET", "/api/pm/projects", { origin: FOREIGN_ORIGIN });
    assert(g.status === 200, `foreign-origin GET -> ${g.status}`);
    console.log(`  ok: CSRF -> write 403, GET exempt`);
  }

  // --- D10: legacy KANBAN_API_TOKEN authorizes /api/pm (no cookie) ------
  {
    const okr = await req("GET", "/api/pm/projects", {
      cookie: false,
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    assert(okr.status === 200, `legacy bearer -> ${okr.status}, expected 200`);
    const created = await req("POST", "/api/pm/projects", {
      cookie: false,
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      body: { name: "via-cli" },
    });
    assert(created.status === 201, `legacy bearer write -> ${created.status}`);
    const bad = await req("GET", "/api/pm/projects", {
      cookie: false,
      headers: { authorization: "Bearer wrong" },
    });
    assert(bad.status === 401, `bad bearer -> ${bad.status}`);
    console.log(
      `  ok: D10 — legacy KANBAN_API_TOKEN authorizes /api/pm (200/201), bad 401`,
    );
  }

  // --- validation + 404s -------------------------------------------------
  {
    const noName = await req("POST", "/api/pm/projects", {
      body: {},
      origin: ALLOWED_ORIGIN,
    });
    assert(noName.status === 400, `create w/o name -> ${noName.status}`);
    const missing = await req("GET", "/api/pm/projects/pm-nope");
    assert(missing.status === 404, `unknown project -> ${missing.status}`);
    console.log(`  ok: validation 400 + 404`);
  }

  // --- delete project -> 204, then 404 ----------------------------------
  {
    const res = await req("DELETE", `/api/pm/projects/${enc(project.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 204, `delete project -> ${res.status}`);
    const g = await req("GET", `/api/pm/projects/${enc(project.id)}`);
    assert(g.status === 404, `deleted project -> ${g.status}`);
    console.log(`  ok: delete project -> 204, then 404`);
  }

  console.log("\nPASS: pm-endpoints (14 checks)");
  cleanup();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
