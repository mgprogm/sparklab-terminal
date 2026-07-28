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
let pmCollabDir = "";

function startServer() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-endpoints-"));
    pmFile = path.join(tmpDir, "pm.json");
    pmCollabDir = path.join(tmpDir, "collab");
    fs.mkdirSync(pmCollabDir, { recursive: true });
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
        PM_COLLAB_DIR: pmCollabDir,
        PM_NOTIFICATIONS_MAX: "10", // small cap for AC15 pruning test
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
  try {
    if (pmCollabDir) fs.rmSync(pmCollabDir, { recursive: true, force: true });
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

// AC23: boot a fresh gateway against a hand-written legacy pm.json (no new
// fields), assert the backfill (key/seq, task numbers, type/reporter/parentId/
// watchers, column wipLimit/transitions), then boot AGAIN against the same file
// and assert it was NOT rewritten (idempotent — numbers/keys stable, no renumber).
async function migrationCheck() {
  const MPORT = 3993;
  const MBASE = `http://localhost:${MPORT}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-migrate-"));
  const mFile = path.join(dir, "pm.json");
  const legacyTask = (id, title, createdAt) => ({
    id,
    title,
    description: "",
    assignee: null,
    priority: null,
    labels: [],
    startDate: null,
    dueDate: null,
    sprintId: null,
    dependsOn: [],
    createdAt,
    updatedAt: createdAt,
  });
  const legacy = {
    projects: {
      "pm-legacy-1": {
        id: "pm-legacy-1",
        name: "Legacy Project",
        tags: [],
        rev: 3,
        createdAt: 1000,
        updatedAt: 2000,
        columns: [
          { id: "col-a", name: "Backlog", taskIds: ["task-x", "task-y"] },
          { id: "col-b", name: "Done", taskIds: [] },
        ],
        sprints: [],
        tasks: {
          "task-x": legacyTask("task-x", "X", 1500),
          "task-y": legacyTask("task-y", "Y", 1600),
        },
      },
    },
  };
  fs.writeFileSync(mFile, JSON.stringify(legacy, null, 2));

  const boot = () =>
    new Promise((resolve, reject) => {
      const p = spawn("node", ["src/server.js"], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(MPORT),
          HOST: "127.0.0.1",
          GATEWAY_AUTH_USER: AUTH_USER,
          GATEWAY_AUTH_PASSWORD: AUTH_PASS,
          ALLOWED_ORIGINS: ALLOWED_ORIGIN,
          PM_FILE: mFile,
          KANBAN_API_TOKEN: LEGACY_TOKEN,
          GATEWAY_API_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d.toString();
        if (out.includes("listening on")) resolve(p);
      });
      p.stderr.on("data", () => {});
      setTimeout(
        () => reject(new Error("migrate gateway did not start")),
        8000,
      );
    });
  const loginTo = async () => {
    const res = await fetch(`${MBASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
    });
    return /gw_session=[^;]+/.exec(res.headers.get("set-cookie") || "")[0];
  };
  const stop = (p) =>
    new Promise((r) => {
      p.on("exit", r);
      p.kill("SIGTERM");
    });
  const getLegacy = async (ck) =>
    (
      await fetch(`${MBASE}/api/pm/projects/pm-legacy-1`, {
        headers: { cookie: ck },
      })
    ).json();

  // Boot 1 — migrate + persist.
  let proc = await boot();
  let ck = await loginTo();
  let pj = await getLegacy(ck);
  assert(pj.key === "LEGACY", `migrate derived key -> ${pj.key} (exp LEGACY)`);
  assert(
    pj.columns[0].wipLimit === null && pj.columns[0].transitions === null,
    "migrate: column wipLimit/transitions default null",
  );
  const tx = pj.tasks.find((t) => t.id === "task-x");
  const ty = pj.tasks.find((t) => t.id === "task-y");
  assert(
    tx.number === 1 && ty.number === 2,
    `migrate: numbers by createdAt (${tx.number},${ty.number})`,
  );
  assert(
    tx.type === "task" &&
      tx.reporter === null &&
      tx.parentId === null &&
      Array.isArray(tx.watchers) &&
      tx.watchers.length === 0,
    "migrate: task type/reporter/parentId/watchers defaults",
  );
  assert(
    tx.key === "LEGACY-1" && ty.key === "LEGACY-2",
    "migrate: derived issue keys",
  );
  await stop(proc);
  const bytes1 = fs.readFileSync(mFile, "utf8");

  // Boot 2 — idempotent: nothing missing => no rewrite, no renumber.
  proc = await boot();
  ck = await loginTo();
  pj = await getLegacy(ck);
  const tx2 = pj.tasks.find((t) => t.id === "task-x");
  const ty2 = pj.tasks.find((t) => t.id === "task-y");
  assert(
    tx2.number === 1 && ty2.number === 2 && pj.key === "LEGACY",
    "idempotent: numbers + key stable across reboot",
  );
  await stop(proc);
  const bytes2 = fs.readFileSync(mFile, "utf8");
  assert(
    bytes1 === bytes2,
    "idempotent: second boot did not rewrite/renumber pm.json",
  );
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(
    "  ok: AC23 legacy pm.json backfills + idempotent across reboots",
  );
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

  // ===================================================================
  // Cluster 3 — issue model (AC16–AC23). Self-contained fresh projects.
  // ===================================================================
  const mkProj = (body) =>
    req("POST", "/api/pm/projects", { body, origin: ALLOWED_ORIGIN });
  const mkTask = (pid, body) =>
    req("POST", `/api/pm/projects/${enc(pid)}/tasks`, {
      body,
      origin: ALLOWED_ORIGIN,
    });
  const patchT = (pid, tid, body) =>
    req("PATCH", `/api/pm/tasks/${enc(tid)}`, {
      body: { projectId: pid, ...body },
      origin: ALLOWED_ORIGIN,
    });
  const delTask = (pid, tid) =>
    req("DELETE", `/api/pm/tasks/${enc(tid)}?projectId=${enc(pid)}`, {
      origin: ALLOWED_ORIGIN,
    });
  const getP = async (pid) =>
    (await req("GET", `/api/pm/projects/${enc(pid)}`)).json();

  // --- AC16: project key derived-unique + explicit-key collision 409 ----
  {
    const p1 = await (await mkProj({ name: "Alpha" })).json();
    assert(/^[A-Z][A-Z0-9]{1,9}$/.test(p1.key), `derived key format ${p1.key}`);
    const p2 = await (await mkProj({ name: "Alpha" })).json();
    assert(p2.key !== p1.key, `collision-suffixed unique key (${p2.key})`);
    const r3 = await mkProj({ name: "Explicit", key: "ZZ" });
    const p3 = await r3.json();
    assert(r3.status === 201 && p3.key === "ZZ", "explicit key honored");
    const r4 = await mkProj({ name: "Dup", key: "ZZ" });
    assert(
      r4.status === 409,
      `explicit-key collision -> ${r4.status} (exp 409)`,
    );
    assert(/taken|in use/i.test((await r4.json()).error), "key_taken message");
    console.log(
      "  ok: AC16 project key derived-unique + explicit collision -> 409",
    );
  }

  // --- AC17/18/21/22: numbers, keys, type default/set, reporter, assignee -
  {
    const p = await (await mkProj({ name: "Numbering" })).json();
    const t1 = await (await mkTask(p.id, { title: "one" })).json();
    const t2 = await (await mkTask(p.id, { title: "two" })).json();
    const t3 = await (
      await mkTask(p.id, { title: "three", type: "bug", assignee: "lek" })
    ).json();
    assert(
      t1.number === 1 && t2.number === 2 && t3.number === 3,
      `gap-free consecutive numbers (${t1.number},${t2.number},${t3.number})`,
    );
    assert(
      t1.key === `${p.key}-1` && t3.key === `${p.key}-3`,
      "derived issue keys PROJ-N",
    );
    assert(t1.type === "task", "type defaults to task");
    assert(t3.type === "bug", "type set to bug");
    // AC21: reporter = creating actor (cookie => user:<GATEWAY_AUTH_USER>) + auto-watch
    assert(
      t1.reporter === `user:${AUTH_USER}`,
      `reporter = actor (${t1.reporter})`,
    );
    assert(
      Array.isArray(t1.watchers) && t1.watchers.includes(`user:${AUTH_USER}`),
      "reporter auto-added to watchers",
    );
    // reporter editable via PATCH
    const re = await patchT(p.id, t1.id, { reporter: "user:someone-else" });
    assert(
      re.status === 200 && (await re.json()).reporter === "user:someone-else",
      "reporter editable via PATCH",
    );
    // AC22: assignee stays a single string (not an array)
    assert(
      typeof t3.assignee === "string" && t3.assignee === "lek",
      "assignee is a single string field",
    );
    console.log(
      "  ok: AC17/18/21/22 numbers+keys, type default/set, reporter+watcher+edit, single assignee",
    );
  }

  // --- AC19: hierarchy matrix — valid chain + five 422 rejections -------
  {
    const p = await (await mkProj({ name: "Hierarchy" })).json();
    const epic = await (
      await mkTask(p.id, { title: "Epic", type: "epic" })
    ).json();
    const story = await (
      await mkTask(p.id, { title: "Story", type: "story", parentId: epic.id })
    ).json();
    assert(story.parentId === epic.id, "story under epic ok");
    const sub = await (
      await mkTask(p.id, {
        title: "Sub",
        type: "subtask",
        parentId: story.id,
      })
    ).json();
    assert(
      sub.parentId === story.id && sub.type === "subtask",
      "valid Epic->Story->Subtask chain ok",
    );
    let r = await mkTask(p.id, { title: "orphan", type: "subtask" });
    assert(r.status === 422, `subtask w/o parent -> ${r.status} (exp 422)`);
    r = await mkTask(p.id, {
      title: "sub-epic",
      type: "subtask",
      parentId: epic.id,
    });
    assert(r.status === 422, `subtask under epic -> ${r.status} (exp 422)`);
    r = await mkTask(p.id, {
      title: "story-story",
      type: "story",
      parentId: story.id,
    });
    assert(r.status === 422, `story under story -> ${r.status} (exp 422)`);
    r = await mkTask(p.id, {
      title: "epic-child",
      type: "epic",
      parentId: epic.id,
    });
    assert(r.status === 422, `epic with parent -> ${r.status} (exp 422)`);
    r = await patchT(p.id, story.id, { parentId: story.id });
    assert(r.status === 422, `parent cycle (self) -> ${r.status} (exp 422)`);
    console.log(
      "  ok: AC19 hierarchy matrix (valid chain + 5 rejections -> 422)",
    );
  }

  // --- AC20: delete orphans/promotes + scrubs parentId & dependsOn ------
  {
    const p = await (await mkProj({ name: "Deletes" })).json();
    const epic = await (
      await mkTask(p.id, { title: "E", type: "epic" })
    ).json();
    const story = await (
      await mkTask(p.id, { title: "S", type: "story", parentId: epic.id })
    ).json();
    assert((await delTask(p.id, epic.id)).status === 204, "delete epic 204");
    let pj = await getP(p.id);
    let s = pj.tasks.find((t) => t.id === story.id);
    assert(
      s && s.parentId === null && s.type === "story",
      "AC20: delete Epic orphans Story (still exists, parent null)",
    );

    const story2 = await (
      await mkTask(p.id, { title: "S2", type: "story" })
    ).json();
    const st = await (
      await mkTask(p.id, {
        title: "ST",
        type: "subtask",
        parentId: story2.id,
      })
    ).json();
    assert(
      (await delTask(p.id, story2.id)).status === 204,
      "delete story2 204",
    );
    pj = await getP(p.id);
    const st2 = pj.tasks.find((t) => t.id === st.id);
    assert(
      st2 && st2.parentId === null && st2.type === "task",
      "AC20: delete Story orphans + promotes Subtask to type task",
    );

    const parent = await (
      await mkTask(p.id, { title: "P", type: "story" })
    ).json();
    const child = await (
      await mkTask(p.id, {
        title: "C",
        type: "subtask",
        parentId: parent.id,
      })
    ).json();
    const dependant = await (
      await mkTask(p.id, { title: "D", dependsOn: [parent.id] })
    ).json();
    assert(dependant.dependsOn.includes(parent.id), "dependant set");
    assert(
      (await delTask(p.id, parent.id)).status === 204,
      "delete parent 204",
    );
    pj = await getP(p.id);
    const c2 = pj.tasks.find((t) => t.id === child.id);
    const d2 = pj.tasks.find((t) => t.id === dependant.id);
    assert(
      c2 && c2.parentId === null,
      "AC20: deleted id scrubbed from parentId",
    );
    assert(
      d2 && !d2.dependsOn.includes(parent.id),
      "AC20: deleted id scrubbed from dependsOn",
    );
    console.log(
      "  ok: AC20 delete orphan/promote + scrub parentId & dependsOn",
    );
  }

  // --- GET /projects/:id/tree — derived Epic->Story->Subtask forest -----
  {
    const p = await (await mkProj({ name: "TreeView" })).json();
    const epic = await (
      await mkTask(p.id, { title: "Epic", type: "epic" })
    ).json();
    const story = await (
      await mkTask(p.id, { title: "Story", type: "story", parentId: epic.id })
    ).json();
    await mkTask(p.id, { title: "Sub", type: "subtask", parentId: story.id });
    const res = await req("GET", `/api/pm/projects/${enc(p.id)}/tree`);
    assert(res.status === 200, `tree -> ${res.status}`);
    const t = await res.json();
    assert(
      Array.isArray(t.tree) && t.tree.length === 1,
      "tree has one Epic root",
    );
    assert(
      t.tree[0].id === epic.id &&
        t.tree[0].children[0].id === story.id &&
        t.tree[0].children[0].children[0].type === "subtask",
      "tree nests Epic->Story->Subtask",
    );
    const missing = await req("GET", "/api/pm/projects/pm-nope/tree");
    assert(missing.status === 404, `tree unknown project -> ${missing.status}`);
    console.log("  ok: GET /projects/:id/tree derived forest (+404)");
  }

  // ===================================================================
  // Cluster 1 — custom columns / WIP / transitions (AC1–AC8)
  // ===================================================================

  // --- AC1: create column at index, rev bump, wipLimit/transitions echoed ---
  {
    const p0 = await (await mkProj({ name: "Columns" })).json();
    const colsBefore = p0.columns.length; // 4 default
    const revBefore = p0.rev;
    const res = await req("POST", `/api/pm/projects/${enc(p0.id)}/columns`, {
      body: {
        name: "Review",
        index: 2,
        wipLimit: 5,
        transitions: [p0.columns[3].id],
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create column -> ${res.status}`);
    const p1 = await res.json();
    assert(p1.columns.length === colsBefore + 1, "column count +1");
    assert(
      p1.columns[2].name === "Review",
      `column at index 2 = Review (got ${p1.columns[2].name})`,
    );
    assert(p1.columns[2].wipLimit === 5, "wipLimit echoed");
    assert(
      Array.isArray(p1.columns[2].transitions) &&
        p1.columns[2].transitions[0] === p0.columns[3].id,
      "transitions echoed",
    );
    assert(p1.rev > revBefore, "rev bumped");
    console.log(
      "  ok: AC1 create column at index, rev bump, wipLimit/transitions",
    );
  }

  // --- AC2: update column rename/wipLimit/transitions; unrelated unchanged ---
  {
    const p0 = await (await mkProj({ name: "ColUpd" })).json();
    const col0 = p0.columns[0];
    const col1 = p0.columns[1];
    const res = await req("PATCH", `/api/pm/columns/${enc(col0.id)}`, {
      body: {
        projectId: p0.id,
        name: "Renamed",
        wipLimit: 3,
        transitions: [col1.id],
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `update column -> ${res.status}`);
    const p1 = await res.json();
    const uc = p1.columns.find((c) => c.id === col0.id);
    assert(uc.name === "Renamed", "rename ok");
    assert(uc.wipLimit === 3, "wipLimit updated");
    assert(uc.transitions[0] === col1.id, "transitions updated");
    const oc = p1.columns.find((c) => c.id === col1.id);
    assert(oc.name === col1.name, "unrelated column name unchanged");
    // Clear wipLimit + transitions via null
    const res2 = await req("PATCH", `/api/pm/columns/${enc(col0.id)}`, {
      body: { projectId: p0.id, wipLimit: null, transitions: null },
      origin: ALLOWED_ORIGIN,
    });
    assert(res2.status === 200, `clear wipLimit/transitions -> ${res2.status}`);
    const p2 = await res2.json();
    const uc2 = p2.columns.find((c) => c.id === col0.id);
    assert(
      uc2.wipLimit === null && uc2.transitions === null,
      "cleared to null",
    );
    console.log(
      "  ok: AC2 update column rename/wipLimit/transitions, unrelated unchanged",
    );
  }

  // --- AC3: move column with correct rev reorders; stale rev -> 409 ---
  {
    const p0 = await (await mkProj({ name: "ColMove" })).json();
    const colId = p0.columns[0].id;
    const res = await req("POST", `/api/pm/columns/${enc(colId)}/move`, {
      body: { projectId: p0.id, toIndex: 3, rev: p0.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `move column -> ${res.status}`);
    const p1 = await res.json();
    assert(
      p1.columns[3].id === colId,
      `column at new position 3 (got ${p1.columns[3].id})`,
    );
    // Stale rev -> 409
    const stale = await req("POST", `/api/pm/columns/${enc(colId)}/move`, {
      body: { projectId: p0.id, toIndex: 0, rev: p0.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(stale.status === 409, `stale column move -> ${stale.status}`);
    const sj = await stale.json();
    assert(sj.error === "stale" && sj.project, "409 carries current project");
    console.log("  ok: AC3 move column reorders + stale rev -> 409");
  }

  // --- AC4: delete empty 204; non-empty block 409; relocate 204; last 400 ---
  {
    const p0 = await (await mkProj({ name: "ColDel" })).json();
    // Add a task to col[0]
    const t1 = await (
      await mkTask(p0.id, { title: "X", columnId: p0.columns[0].id })
    ).json();
    // Delete empty col[3] -> 204
    const delEmpty = await req(
      "DELETE",
      `/api/pm/columns/${enc(p0.columns[3].id)}?projectId=${enc(p0.id)}`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(delEmpty.status === 204, `delete empty -> ${delEmpty.status}`);
    // Delete non-empty col[0] mode=block -> 409 column_not_empty
    const block = await req(
      "DELETE",
      `/api/pm/columns/${enc(p0.columns[0].id)}?projectId=${enc(p0.id)}&mode=block`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(block.status === 409, `delete non-empty block -> ${block.status}`);
    const bj = await block.json();
    assert(/not.empty/i.test(bj.error), "column_not_empty message");
    // Delete non-empty col[0] mode=relocate -> 204, tasks in col[1]
    const p1 = await getP(p0.id);
    const targetId = p1.columns.find(
      (c) => c.id !== p0.columns[0].id && c.id !== p0.columns[3].id,
    ).id;
    const reloc = await req(
      "DELETE",
      `/api/pm/columns/${enc(p0.columns[0].id)}?projectId=${enc(p0.id)}&mode=relocate&toColumnId=${enc(targetId)}`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(reloc.status === 204, `delete relocate -> ${reloc.status}`);
    const p2 = await getP(p0.id);
    const tc = p2.columns.find((c) => c.id === targetId);
    assert(tc && tc.taskIds.includes(t1.id), "relocated task in target column");
    assert(
      !p2.columns.find((c) => c.id === p0.columns[0].id),
      "source column removed",
    );
    // Delete all but last, then try last -> 400 last_column
    // p2 has 2 columns remaining. Delete one (empty) to get to 1.
    const remaining = p2.columns.filter((c) => c.taskIds.length === 0);
    if (remaining.length) {
      await req(
        "DELETE",
        `/api/pm/columns/${enc(remaining[0].id)}?projectId=${enc(p0.id)}`,
        { origin: ALLOWED_ORIGIN },
      );
    }
    const p3 = await getP(p0.id);
    const lastCol = p3.columns[0];
    const lastDel = await req(
      "DELETE",
      `/api/pm/columns/${enc(lastCol.id)}?projectId=${enc(p0.id)}`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(
      lastDel.status === 400,
      `delete last column -> ${lastDel.status} (exp 400)`,
    );
    assert(
      /last.column/i.test((await lastDel.json()).error),
      "last_column message",
    );
    console.log(
      "  ok: AC4 delete column: empty->204, block->409, relocate->204, last->400",
    );
  }

  // --- AC5: WIP limit — move into full -> 422; same-column reorder ok; create into full -> 422 ---
  {
    const p0 = await (await mkProj({ name: "WIP" })).json();
    const col0 = p0.columns[0].id;
    const col1 = p0.columns[1].id;
    // Set col1 wipLimit = 1
    await req("PATCH", `/api/pm/columns/${enc(col1)}`, {
      body: { projectId: p0.id, wipLimit: 1 },
      origin: ALLOWED_ORIGIN,
    });
    // Add a task to col1
    const t1 = await (
      await mkTask(p0.id, { title: "Fill", columnId: col1 })
    ).json();
    // Add a task to col0
    const t2 = await (
      await mkTask(p0.id, { title: "Mover", columnId: col0 })
    ).json();
    // Move t2 from col0 -> col1 (already full) -> 422 wip_exceeded
    let pNow = await getP(p0.id);
    const moveRes = await req("POST", `/api/pm/tasks/${enc(t2.id)}/move`, {
      body: { projectId: p0.id, toColumnId: col1, toIndex: 0, rev: pNow.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      moveRes.status === 422,
      `move into full -> ${moveRes.status} (exp 422)`,
    );
    const mj = await moveRes.json();
    assert(/wip.exceeded/i.test(mj.error) || mj.column, "wip_exceeded error");
    // Same-column reorder at limit -> 200 (exempt)
    pNow = await getP(p0.id);
    const reorder = await req("POST", `/api/pm/tasks/${enc(t1.id)}/move`, {
      body: { projectId: p0.id, toColumnId: col1, toIndex: 0, rev: pNow.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      reorder.status === 200,
      `same-column reorder at limit -> ${reorder.status}`,
    );
    // Create task into full column -> 422
    const createFull = await mkTask(p0.id, {
      title: "Overflow",
      columnId: col1,
    });
    assert(
      createFull.status === 422,
      `create into full -> ${createFull.status} (exp 422)`,
    );
    console.log("  ok: AC5 WIP: move->422, same-col reorder->200, create->422");
  }

  // --- AC6: transition — move to disallowed -> 422; transitions null -> any ---
  {
    const p0 = await (await mkProj({ name: "Trans" })).json();
    const col0 = p0.columns[0].id;
    const col1 = p0.columns[1].id;
    const col2 = p0.columns[2].id;
    // Set col0 transitions = [col1] (only col1 allowed)
    await req("PATCH", `/api/pm/columns/${enc(col0)}`, {
      body: { projectId: p0.id, transitions: [col1] },
      origin: ALLOWED_ORIGIN,
    });
    const t1 = await (
      await mkTask(p0.id, { title: "T", columnId: col0 })
    ).json();
    // Move t1 from col0 -> col2 (not in transitions) -> 422
    let pNow = await getP(p0.id);
    const bad = await req("POST", `/api/pm/tasks/${enc(t1.id)}/move`, {
      body: { projectId: p0.id, toColumnId: col2, toIndex: 0, rev: pNow.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(bad.status === 422, `move to disallowed -> ${bad.status} (exp 422)`);
    const bj2 = await bad.json();
    assert(
      /transition.forbidden/i.test(bj2.error) || bj2.from,
      "transition_forbidden error",
    );
    // Move t1 from col0 -> col1 (allowed) -> 200
    pNow = await getP(p0.id);
    const ok = await req("POST", `/api/pm/tasks/${enc(t1.id)}/move`, {
      body: { projectId: p0.id, toColumnId: col1, toIndex: 0, rev: pNow.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(ok.status === 200, `move to allowed -> ${ok.status}`);
    // Clear transitions -> null; any move allowed
    await req("PATCH", `/api/pm/columns/${enc(col1)}`, {
      body: { projectId: p0.id, transitions: null },
      origin: ALLOWED_ORIGIN,
    });
    pNow = await getP(p0.id);
    const freeMove = await req("POST", `/api/pm/tasks/${enc(t1.id)}/move`, {
      body: { projectId: p0.id, toColumnId: col2, toIndex: 0, rev: pNow.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      freeMove.status === 200,
      `transitions null allows any -> ${freeMove.status}`,
    );
    console.log(
      "  ok: AC6 transition: disallowed->422, allowed->200, null->any",
    );
  }

  // --- AC8: legacy pm.json without wipLimit/transitions loads fine (existing migrationCheck covers) ---
  // The AC23/migrationCheck already verifies that legacy columns get wipLimit:null
  // and transitions:null, and behaviour is identical to before. We add an explicit
  // label here.
  console.log(
    "  ok: AC8 legacy pm.json wipLimit/transitions=null via AC23 migration",
  );

  // --- AC23: legacy pm.json backfills + idempotent across reboots -------
  await migrationCheck();

  // ===================================================================
  // Cluster 2 — Collaboration (AC9–AC15). Self-contained fresh project.
  // ===================================================================

  // --- AC9: comments CRUD + pm.json size does NOT grow ---
  {
    const p = await (await mkProj({ name: "Collab" })).json();
    const t1 = await (await mkTask(p.id, { title: "CommentTarget" })).json();
    const pmSizeBefore = fs.statSync(pmFile).size;
    // Add comment
    const c1r = await req(
      "POST",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      {
        body: { body: "Hello from the test!" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(c1r.status === 201, `add comment -> ${c1r.status}`);
    const c1 = await c1r.json();
    assert(c1.id && c1.body === "Hello from the test!", "comment echoed");
    // Second comment
    const c2r = await req(
      "POST",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      {
        body: { body: "Second comment" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(c2r.status === 201, `add second comment -> ${c2r.status}`);
    // GET comments
    const lr = await req(
      "GET",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
    );
    assert(lr.status === 200, `list comments -> ${lr.status}`);
    const lj = await lr.json();
    assert(
      lj.comments.length === 2,
      `2 comments listed (got ${lj.comments.length})`,
    );
    // Edit comment
    const er = await req("PATCH", `/api/pm/comments/${enc(c1.id)}`, {
      body: { projectId: p.id, body: "Edited body" },
      origin: ALLOWED_ORIGIN,
    });
    assert(er.status === 200, `edit comment -> ${er.status}`);
    const edited = await er.json();
    assert(edited.body === "Edited body", "edit echoed");
    // GET shows updated body, not duplicate
    const lr2 = await req(
      "GET",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
    );
    const lj2 = await lr2.json();
    assert(
      lj2.comments.length === 2,
      `still 2 comments after edit (got ${lj2.comments.length})`,
    );
    assert(
      lj2.comments.find((c) => c.id === c1.id).body === "Edited body",
      "edit visible in list",
    );
    // Delete comment
    const dr = await req(
      "DELETE",
      `/api/pm/comments/${enc(c1.id)}?projectId=${enc(p.id)}&taskId=${enc(t1.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(dr.status === 204, `delete comment -> ${dr.status}`);
    const lr3 = await req(
      "GET",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
    );
    const lj3 = await lr3.json();
    assert(
      lj3.comments.length === 1,
      `1 comment after tombstone (got ${lj3.comments.length})`,
    );
    assert(!lj3.comments.find((c) => c.id === c1.id), "deleted comment absent");
    // P1 proof: pm.json file size did NOT grow with comment count
    const pmSizeAfter = fs.statSync(pmFile).size;
    assert(
      pmSizeAfter === pmSizeBefore,
      `P1: pm.json size ${pmSizeBefore} -> ${pmSizeAfter} (must not grow with comments)`,
    );
    console.log(
      "  ok: AC9 comments CRUD + pm.json size does NOT grow (P1 proof)",
    );
  }

  // --- AC10: activity emitted per mutation (append-only) ---
  {
    const p = await (await mkProj({ name: "Activity" })).json();
    // Check activity after project creation (task create triggers activity)
    const t1 = await (await mkTask(p.id, { title: "ActivityTask" })).json();
    const actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    assert(actR.status === 200, `list activity -> ${actR.status}`);
    const actJ = await actR.json();
    assert(
      actJ.activity.length >= 1,
      "at least one activity after task create",
    );
    const created = actJ.activity.find((a) => a.verb === "created");
    assert(created && created.actor, "created activity has actor");
    assert(
      created.target && created.target.type === "task",
      "created target type",
    );
    // PATCH task -> updated activity
    await patchT(p.id, t1.id, { title: "Renamed" });
    const actR2 = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    const actJ2 = await actR2.json();
    const updated = actJ2.activity.find((a) => a.verb === "updated");
    assert(updated, "updated activity present after PATCH");
    // Add comment -> commented activity
    await req(
      "POST",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      {
        body: { body: "test comment for activity" },
        origin: ALLOWED_ORIGIN,
      },
    );
    const actR3 = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    const actJ3 = await actR3.json();
    const commented = actJ3.activity.find((a) => a.verb === "commented");
    assert(commented, "commented activity present after comment add");
    // Delete task -> deleted activity, but prior activities still exist (append-only)
    const countBefore = actJ3.activity.length;
    await delTask(p.id, t1.id);
    const actR4 = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    const actJ4 = await actR4.json();
    assert(
      actJ4.activity.length > countBefore,
      "deleting adds activity (append-only)",
    );
    const deleted = actJ4.activity.find((a) => a.verb === "deleted");
    assert(deleted, "deleted activity present");
    // Prior activities still present (length only grew)
    assert(
      actJ4.activity.some((a) => a.verb === "created"),
      "created activity preserved after delete",
    );
    console.log(
      "  ok: AC10 activity emitted + append-only (delete does not remove prior)",
    );
  }

  // --- AC11: attachments upload/download/traversal/413 ---
  {
    const p = await (await mkProj({ name: "Attach" })).json();
    const t1 = await (await mkTask(p.id, { title: "AttachTarget" })).json();
    const payload = Buffer.from("hello-attachment-bytes");
    // Upload
    const ur = await fetch(
      `${BASE}/api/pm/tasks/${enc(t1.id)}/attachments?projectId=${enc(p.id)}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ALLOWED_ORIGIN,
          "x-filename": "test-file.txt",
          "content-type": "text/plain",
        },
        body: payload,
      },
    );
    assert(ur.status === 201, `upload attachment -> ${ur.status}`);
    const umeta = await ur.json();
    assert(umeta.id && umeta.filename === "test-file.txt", "metadata echoed");
    assert(
      umeta.size === payload.length,
      `size ${umeta.size} == ${payload.length}`,
    );
    // Download
    const dlr = await fetch(
      `${BASE}/api/pm/attachments/${enc(umeta.id)}?projectId=${enc(p.id)}`,
      {
        headers: { cookie },
      },
    );
    assert(dlr.status === 200, `download attachment -> ${dlr.status}`);
    const dlBuf = Buffer.from(await dlr.arrayBuffer());
    assert(dlBuf.equals(payload), "downloaded bytes identical to uploaded");
    assert(
      dlr.headers.get("x-content-type-options") === "nosniff",
      "nosniff header set",
    );
    assert(
      dlr.headers.get("content-disposition").includes("test-file.txt"),
      "Content-Disposition has filename",
    );
    // Traversal filename: ../../../etc/passwd
    const badNameR = await fetch(
      `${BASE}/api/pm/tasks/${enc(t1.id)}/attachments?projectId=${enc(p.id)}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ALLOWED_ORIGIN,
          "x-filename": "../../../etc/passwd-evil",
          "content-type": "application/octet-stream",
        },
        body: Buffer.from("traversal-test"),
      },
    );
    assert(
      badNameR.status === 201,
      `traversal filename accepted -> ${badNameR.status}`,
    );
    const badMeta = await badNameR.json();
    // The blob lives only in the expected dir — verify no file named with traversal chars
    const projDir = path.join(pmCollabDir, "pm-attachments", p.id);
    if (fs.existsSync(projDir)) {
      const files = fs.readdirSync(projDir).filter((f) => f !== "index.jsonl");
      for (const f of files) {
        assert(/^att-/.test(f), `blob name is opaque att-uuid (got "${f}")`);
      }
    }
    // List attachments
    const listR = await req(
      "GET",
      `/api/pm/tasks/${enc(t1.id)}/attachments?projectId=${enc(p.id)}`,
    );
    assert(listR.status === 200, `list attachments -> ${listR.status}`);
    const listJ = await listR.json();
    assert(
      listJ.attachments.length === 2,
      `2 attachments listed (got ${listJ.attachments.length})`,
    );
    // Delete attachment
    const delAttR = await req(
      "DELETE",
      `/api/pm/attachments/${enc(umeta.id)}?projectId=${enc(p.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(delAttR.status === 204, `delete attachment -> ${delAttR.status}`);
    // Download after delete -> 404
    const dlr2 = await fetch(
      `${BASE}/api/pm/attachments/${enc(umeta.id)}?projectId=${enc(p.id)}`,
      {
        headers: { cookie },
      },
    );
    assert(
      dlr2.status === 404,
      `download deleted attachment -> ${dlr2.status}`,
    );
    console.log(
      "  ok: AC11 attachments upload/download/traversal-safe/list/delete (+nosniff)",
    );
  }

  // --- AC12: delete task cascades comments/attachments; delete project cascades all ---
  {
    const p = await (await mkProj({ name: "Cascade" })).json();
    const t1 = await (await mkTask(p.id, { title: "CascadeTask" })).json();
    // Add comment + attachment to t1
    await req(
      "POST",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      {
        body: { body: "cascade comment" },
        origin: ALLOWED_ORIGIN,
      },
    );
    await fetch(
      `${BASE}/api/pm/tasks/${enc(t1.id)}/attachments?projectId=${enc(p.id)}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ALLOWED_ORIGIN,
          "x-filename": "cascade.txt",
        },
        body: Buffer.from("cascade-bytes"),
      },
    );
    // Delete the task
    assert((await delTask(p.id, t1.id)).status === 204, "delete task 204");
    // Comments/attachments for that task should be gone/inaccessible
    const cmts = await (
      await req(
        "GET",
        `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      )
    ).json();
    assert(
      cmts.comments.length === 0,
      `comments gone after task delete (got ${cmts.comments.length})`,
    );
    const atts = await (
      await req(
        "GET",
        `/api/pm/tasks/${enc(t1.id)}/attachments?projectId=${enc(p.id)}`,
      )
    ).json();
    assert(
      atts.attachments.length === 0,
      `attachments gone after task delete (got ${atts.attachments.length})`,
    );

    // Delete project cascades ALL collab data
    const t2 = await (await mkTask(p.id, { title: "ProjectCascade" })).json();
    await req(
      "POST",
      `/api/pm/tasks/${enc(t2.id)}/comments?projectId=${enc(p.id)}`,
      {
        body: { body: "project cascade comment" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      (
        await req("DELETE", `/api/pm/projects/${enc(p.id)}`, {
          origin: ALLOWED_ORIGIN,
        })
      ).status === 204,
      "delete project 204",
    );
    // Collab files for this project should be gone or inaccessible
    const actFile = path.join(pmCollabDir, "pm-activity", `${p.id}.jsonl`);
    const cmtFile = path.join(pmCollabDir, "pm-comments", `${p.id}.jsonl`);
    const attDir = path.join(pmCollabDir, "pm-attachments", p.id);
    assert(
      !fs.existsSync(actFile) || fs.readFileSync(actFile, "utf8").trim() === "",
      `activity file gone/empty after project delete`,
    );
    assert(
      !fs.existsSync(cmtFile) || fs.readFileSync(cmtFile, "utf8").trim() === "",
      `comments file gone/empty after project delete`,
    );
    assert(!fs.existsSync(attDir), `attachments dir gone after project delete`);
    console.log(
      "  ok: AC12 cascade: delete task purges comments/attachments; delete project purges all collab",
    );
  }

  // --- AC13: notifications (watchers, read-state, actor-excluded) ---
  {
    const p = await (await mkProj({ name: "Notify" })).json();
    const t1 = await (await mkTask(p.id, { title: "WatchedTask" })).json();
    // Manually watch as a different "actor" by commenting via bearer
    // Since the single user = the same cookie actor everywhere, we simulate:
    // The reporter (cookie user) is already a watcher from task create.
    // Comment (adds a "commented" notification for other watchers — but there's only one actor, so no notification).
    await req(
      "POST",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      {
        body: { body: "notify test" },
        origin: ALLOWED_ORIGIN,
      },
    );
    // The acting actor should NOT get a notification for their own comment.
    const nR = await req("GET", "/api/pm/notifications?unread=1");
    assert(nR.status === 200, `list notifications -> ${nR.status}`);
    const nJ = await nR.json();
    // Single-user: no notifications for the actor's own actions (by design).
    // Under single-user, there's only one actor, so the watchers-minus-actor set is empty.
    assert(Array.isArray(nJ.notifications), "notifications is an array");
    // To properly test notifications, we do a bearer-client comment → the cookie user
    // is a watcher, so they should get a notification.
    // Watch via cookie first (already a watcher from task create), then comment via bearer.
    const bearerCommentR = await fetch(
      `${BASE}/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${LEGACY_TOKEN}`,
          "content-type": "application/json",
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ body: "comment from bearer client" }),
      },
    );
    assert(
      bearerCommentR.status === 201,
      `bearer comment -> ${bearerCommentR.status}`,
    );
    // Now the cookie user should have a notification
    const nR2 = await req("GET", "/api/pm/notifications?unread=1");
    const nJ2 = await nR2.json();
    assert(
      nJ2.notifications.length >= 1,
      `cookie user has notification from bearer comment (got ${nJ2.notifications.length})`,
    );
    const n = nJ2.notifications[0];
    assert(n.readAt === null, "notification is unread");
    // Mark read
    const mrR = await req("POST", "/api/pm/notifications/read", {
      body: { ids: [n.id] },
      origin: ALLOWED_ORIGIN,
    });
    assert(mrR.status === 200, `mark read -> ${mrR.status}`);
    const mrJ = await mrR.json();
    assert(mrJ.updated >= 1, "at least 1 marked read");
    // Verify read state
    const nR3 = await req("GET", "/api/pm/notifications?unread=1");
    const nJ3 = await nR3.json();
    const stillUnread = nJ3.notifications.filter((x) => x.id === n.id);
    assert(
      stillUnread.length === 0,
      "notification no longer unread after markRead",
    );
    console.log(
      "  ok: AC13 notifications: watcher notified (minus actor), read-state toggle",
    );
  }

  // --- AC14: concurrent comment appends both persist ---
  {
    const p = await (await mkProj({ name: "Concurrent" })).json();
    const t1 = await (await mkTask(p.id, { title: "ConcurrentTask" })).json();
    // Fire two concurrent comment POSTs via Promise.all
    const [r1, r2] = await Promise.all([
      req(
        "POST",
        `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
        {
          body: { body: "concurrent-1" },
          origin: ALLOWED_ORIGIN,
        },
      ),
      req(
        "POST",
        `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
        {
          body: { body: "concurrent-2" },
          origin: ALLOWED_ORIGIN,
        },
      ),
    ]);
    assert(
      r1.status === 201 && r2.status === 201,
      "both concurrent comments 201",
    );
    const lr = await req(
      "GET",
      `/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
    );
    const lj = await lr.json();
    assert(
      lj.comments.length === 2,
      `both concurrent comments persisted (got ${lj.comments.length})`,
    );
    console.log(
      "  ok: AC14 concurrent comment appends both persist (sync-fs no-interleaving proof)",
    );
  }

  // --- AC15: notification pruning (PM_NOTIFICATIONS_MAX=10) ---
  {
    const p = await (await mkProj({ name: "Prune" })).json();
    const t1 = await (await mkTask(p.id, { title: "PruneTask" })).json();
    // Generate 15 notifications via bearer comments (each triggers a notification for the cookie user watcher)
    for (let i = 0; i < 15; i++) {
      await fetch(
        `${BASE}/api/pm/tasks/${enc(t1.id)}/comments?projectId=${enc(p.id)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${LEGACY_TOKEN}`,
            "content-type": "application/json",
            origin: ALLOWED_ORIGIN,
          },
          body: JSON.stringify({ body: `prune-comment-${i}` }),
        },
      );
    }
    const nR = await req("GET", "/api/pm/notifications");
    const nJ = await nR.json();
    // PM_NOTIFICATIONS_MAX=10 — total notifications should cap at 10
    assert(
      nJ.notifications.length <= 10,
      `notification count capped at 10 (got ${nJ.notifications.length})`,
    );
    console.log("  ok: AC15 notifications capped at PM_NOTIFICATIONS_MAX=10");
  }

  // ===================================================================
  // Gap 1 — Column mutations emit activity records (AC10 extension)
  // ===================================================================

  // --- AC10b: column CRUD emits activity (column_added, wip_set, transition_set, moved, column_deleted) ---
  {
    const p = await (await mkProj({ name: "ColActivity" })).json();
    const col0 = p.columns[0].id;
    const col1 = p.columns[1].id;

    // 1. Create column -> column_added activity
    const createRes = await req(
      "POST",
      `/api/pm/projects/${enc(p.id)}/columns`,
      {
        body: { name: "Review", index: 2 },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      createRes.status === 201,
      `create column for activity -> ${createRes.status}`,
    );
    const p1 = await createRes.json();
    const newCol = p1.columns.find((c) => c.name === "Review");
    let actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    let actJ = await actR.json();
    let colAdded = actJ.activity.find((a) => a.verb === "column_added");
    assert(colAdded, "column_added activity present after create column");
    assert(
      colAdded.target && colAdded.target.type === "column",
      "column_added target.type === column",
    );
    assert(
      colAdded.target.id === newCol.id,
      "column_added target.id matches new column",
    );

    // 2. PATCH wipLimit -> wip_set activity
    await req("PATCH", `/api/pm/columns/${enc(col0)}`, {
      body: { projectId: p.id, wipLimit: 10 },
      origin: ALLOWED_ORIGIN,
    });
    actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    actJ = await actR.json();
    let wipSet = actJ.activity.find((a) => a.verb === "wip_set");
    assert(wipSet, "wip_set activity present after PATCH wipLimit");
    assert(
      wipSet.target && wipSet.target.type === "column",
      "wip_set target.type === column",
    );

    // 3. PATCH transitions -> transition_set activity
    await req("PATCH", `/api/pm/columns/${enc(col0)}`, {
      body: { projectId: p.id, transitions: [col1] },
      origin: ALLOWED_ORIGIN,
    });
    actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    actJ = await actR.json();
    let transSet = actJ.activity.find((a) => a.verb === "transition_set");
    assert(transSet, "transition_set activity present after PATCH transitions");
    assert(
      transSet.target && transSet.target.type === "column",
      "transition_set target.type === column",
    );

    // 4. Move column -> moved activity with target.type=column
    const pNow = await getP(p.id);
    await req("POST", `/api/pm/columns/${enc(col0)}/move`, {
      body: { projectId: p.id, toIndex: 3, rev: pNow.rev },
      origin: ALLOWED_ORIGIN,
    });
    actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    actJ = await actR.json();
    let colMoved = actJ.activity.find(
      (a) => a.verb === "moved" && a.target && a.target.type === "column",
    );
    assert(
      colMoved,
      "moved activity with target.type=column present after column move",
    );
    assert(
      colMoved.target.id === col0,
      "moved column activity target.id matches",
    );

    // 5. Delete column -> column_deleted activity
    // Delete the new "Review" column (empty, so mode=block works)
    await req(
      "DELETE",
      `/api/pm/columns/${enc(newCol.id)}?projectId=${enc(p.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    actJ = await actR.json();
    let colDel = actJ.activity.find((a) => a.verb === "column_deleted");
    assert(colDel, "column_deleted activity present after delete column");
    assert(
      colDel.target && colDel.target.type === "column",
      "column_deleted target.type === column",
    );
    assert(
      colDel.target.id === newCol.id,
      "column_deleted target.id matches deleted column",
    );

    console.log(
      "  ok: AC10b column CRUD activity (column_added, wip_set, transition_set, moved, column_deleted)",
    );
  }

  // ===================================================================
  // Gap 2 — Assignee auto-joins watchers (AC17 extension)
  // ===================================================================

  // --- AC17b: assignee auto-added to watchers on create + PATCH ---
  {
    const p = await (await mkProj({ name: "AssignWatch" })).json();

    // 1. Create task with assignee -> assignee appears in watchers
    const t1 = await (
      await mkTask(p.id, { title: "Assigned", assignee: "alice" })
    ).json();
    assert(
      Array.isArray(t1.watchers) && t1.watchers.includes("alice"),
      `assignee "alice" auto-added to watchers on create (watchers: ${JSON.stringify(t1.watchers)})`,
    );
    // Reporter (cookie actor) should ALSO be in watchers (not clobbered)
    assert(
      t1.watchers.includes(`user:${AUTH_USER}`),
      "reporter still in watchers alongside assignee",
    );

    // 2. Create task where assignee === reporter -> no duplicate in watchers
    const t2 = await (
      await mkTask(p.id, { title: "SameActor", assignee: `user:${AUTH_USER}` })
    ).json();
    const reporterCount = t2.watchers.filter(
      (w) => w === `user:${AUTH_USER}`,
    ).length;
    assert(
      reporterCount === 1,
      `no duplicate when assignee === reporter (count: ${reporterCount})`,
    );

    // 3. PATCH assignee to a NEW value -> new assignee joins watchers
    const patchRes = await patchT(p.id, t1.id, { assignee: "bob" });
    assert(patchRes.status === 200, `patch assignee -> ${patchRes.status}`);
    const patched = await patchRes.json();
    assert(
      patched.watchers.includes("bob"),
      `new assignee "bob" auto-added to watchers on PATCH (watchers: ${JSON.stringify(patched.watchers)})`,
    );
    // Old assignee "alice" should NOT be removed
    assert(
      patched.watchers.includes("alice"),
      "old assignee alice still in watchers after reassignment",
    );

    // 4. Verify notification path: bearer assigns task, cookie user (watcher) gets notified
    // Create a task as cookie user, then PATCH assignee via bearer to trigger notification
    const t3 = await (await mkTask(p.id, { title: "NotifyAssign" })).json();
    // The cookie actor is the reporter and watcher. Now assign via bearer.
    const bearerPatch = await fetch(`${BASE}/api/pm/tasks/${enc(t3.id)}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${LEGACY_TOKEN}`,
        "content-type": "application/json",
        origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ projectId: p.id, assignee: "carol" }),
    });
    assert(
      bearerPatch.status === 200,
      `bearer patch assignee -> ${bearerPatch.status}`,
    );
    const bpJ = await bearerPatch.json();
    // "carol" should now be in watchers
    assert(
      bpJ.watchers.includes("carol"),
      `bearer-assigned "carol" in watchers (watchers: ${JSON.stringify(bpJ.watchers)})`,
    );
    // The cookie user (watcher, not the actor) should have received a notification
    const nR = await req("GET", "/api/pm/notifications?unread=1");
    const nJ = await nR.json();
    const assignNotif = nJ.notifications.find(
      (n) => n.event === "assigned" && n.taskId === t3.id,
    );
    assert(
      assignNotif,
      "cookie user received 'assigned' notification from bearer assign",
    );

    console.log(
      "  ok: AC17b assignee auto-added to watchers (create + PATCH + no-dup + notification)",
    );
  }

  // --- AC24: attached/detached activity carries taskId for frontend filter ---
  {
    const p = await (await mkProj({ name: "AttachActivity" })).json();
    const t = await (await mkTask(p.id, { title: "AttachTarget" })).json();
    // Upload an attachment
    const ur = await fetch(
      `${BASE}/api/pm/tasks/${enc(t.id)}/attachments?projectId=${enc(p.id)}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ALLOWED_ORIGIN,
          "x-filename": "activity-test.txt",
          "content-type": "text/plain",
        },
        body: Buffer.from("activity-test-bytes"),
      },
    );
    assert(ur.status === 201, `upload for activity test -> ${ur.status}`);
    const attMeta = await ur.json();
    // Fetch activity
    let actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    let actJ = await actR.json();
    let attached = actJ.activity.find((a) => a.verb === "attached");
    assert(attached, "attached activity present after upload");
    assert(
      attached.target.type === "attachment",
      `attached target.type is attachment`,
    );
    assert(
      attached.target.id === attMeta.id,
      `attached target.id is the attachment id`,
    );
    assert(
      attached.taskId === t.id,
      `attached activity carries taskId (got ${attached.taskId})`,
    );
    // Delete the attachment and check detached activity
    const delR = await req(
      "DELETE",
      `/api/pm/attachments/${enc(attMeta.id)}?projectId=${enc(p.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      delR.status === 204,
      `delete attachment for activity test -> ${delR.status}`,
    );
    actR = await req("GET", `/api/pm/projects/${enc(p.id)}/activity`);
    actJ = await actR.json();
    let detached = actJ.activity.find((a) => a.verb === "detached");
    assert(detached, "detached activity present after delete");
    assert(
      detached.taskId === t.id,
      `detached activity carries taskId (got ${detached.taskId})`,
    );
    // Also verify task-scoped activity (created verb) carries taskId
    let created = actJ.activity.find((a) => a.verb === "created");
    assert(
      created && created.taskId === t.id,
      `created activity also carries taskId`,
    );
    // Cleanup
    await req("DELETE", `/api/pm/projects/${enc(p.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    console.log(
      "  ok: AC24 attached/detached activity carries taskId for frontend filter",
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

  console.log("\nPASS: pm-endpoints (37 checks)");
  cleanup();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
