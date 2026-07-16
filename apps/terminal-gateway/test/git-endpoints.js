// Git-summary endpoint integration test — proves GET /api/sessions/:id/git
// against a real gateway + real tmux + a real git work tree on the LOCAL server.
//
// Covers: a repo with a known mix of staged / unstaged / untracked files (exact
// counts), the branch name, a clean repo (changed:0), a detached HEAD (branch =
// short oid, detached:true), a non-git cwd (isRepo:false), and auth enforcement
// (no cookie -> 401). Runs with AUTH ENABLED like the fs-endpoints test.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "gituser";
const AUTH_PASS = "gitpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let cookie = "";
const createdTmux = [];
const scratches = [];

function startServer() {
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
  for (const id of createdTmux) {
    try {
      execFileSync("tmux", ["kill-session", "-t", id], { stdio: "ignore" });
    } catch {}
  }
  for (const s of scratches) {
    try {
      fs.rmSync(s, { recursive: true, force: true });
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
  const h = { ...(headers || {}) };
  if (cookie) h["cookie"] = cookie;
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
  if (res.status !== 204) fail(`login returned ${res.status}, expected 204`);
  const m = /gw_session=[^;]+/.exec(res.headers.get("set-cookie") || "");
  assert(m, "login did not return gw_session cookie");
  cookie = m[0];
}

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

// Create a session rooted at `cwd`; return the qualified id after the shell has
// settled so pane_current_path reflects the cwd.
async function makeSession(name, cwd) {
  const res = await req("POST", "/api/sessions", {
    body: { name, cwd },
    origin: ALLOWED_ORIGIN,
  });
  assert(
    res.status === 201,
    `POST /api/sessions -> ${res.status}, expected 201`,
  );
  const id = (await res.json()).id;
  createdTmux.push(id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);
  await sleep(700);
  return id;
}

function mkscratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratches.push(d);
  return d;
}

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT} (auth enabled)`);
  await login();
  console.log("logged in; cookie captured");

  // --- Repo with a known dirty state -------------------------------------
  // Commit 2 files, then: modify 1 (unstaged), stage a modification to another
  // (staged), add 1 new staged file (staged), leave 2 untracked. Result:
  //   staged: 2   unstaged: 1   untracked: 2   changed: 5
  const repo = mkscratch("git-endpoints-repo-");
  git(repo, "init", "-q", "-b", "work");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "a1\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "b1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "a2\n"); // unstaged mod
  fs.writeFileSync(path.join(repo, "b.txt"), "b2\n");
  git(repo, "add", "b.txt"); // staged mod
  fs.writeFileSync(path.join(repo, "c.txt"), "c1\n");
  git(repo, "add", "c.txt"); // staged new
  fs.writeFileSync(path.join(repo, "d.txt"), "d1\n"); // untracked
  fs.writeFileSync(path.join(repo, "e.txt"), "e1\n"); // untracked

  const repoId = await makeSession("git-repo", repo);
  console.log(`created session ${repoId} (dirty repo)`);

  {
    const res = await req("GET", `/api/sessions/${enc(repoId)}/git`);
    assert(res.status === 200, `git -> ${res.status}, expected 200`);
    const j = await res.json();
    assert(j.isRepo === true, `expected isRepo:true, got ${JSON.stringify(j)}`);
    assert(j.branch === "work", `branch=${j.branch}, expected "work"`);
    assert(j.detached === false, `detached=${j.detached}, expected false`);
    assert(j.staged === 2, `staged=${j.staged}, expected 2`);
    assert(j.unstaged === 1, `unstaged=${j.unstaged}, expected 1`);
    assert(j.untracked === 2, `untracked=${j.untracked}, expected 2`);
    assert(j.conflicted === 0, `conflicted=${j.conflicted}, expected 0`);
    assert(j.changed === 5, `changed=${j.changed}, expected 5`);
    console.log(
      `  ok: dirty repo -> branch=work staged=2 unstaged=1 untracked=2 changed=5`,
    );
  }

  // --- Clean repo --------------------------------------------------------
  const clean = mkscratch("git-endpoints-clean-");
  git(clean, "init", "-q", "-b", "main");
  git(clean, "config", "user.email", "t@example.com");
  git(clean, "config", "user.name", "Test");
  fs.writeFileSync(path.join(clean, "x.txt"), "x\n");
  git(clean, "add", "-A");
  git(clean, "commit", "-q", "-m", "init");
  const cleanId = await makeSession("git-clean", clean);
  {
    const res = await req("GET", `/api/sessions/${enc(cleanId)}/git`);
    assert(res.status === 200, `git(clean) -> ${res.status}`);
    const j = await res.json();
    assert(j.isRepo === true, "clean: expected isRepo:true");
    assert(j.branch === "main", `clean branch=${j.branch}, expected "main"`);
    assert(j.changed === 0, `clean changed=${j.changed}, expected 0`);
    console.log(`  ok: clean repo -> branch=main changed=0`);
  }

  // --- Detached HEAD -----------------------------------------------------
  git(clean, "checkout", "-q", "HEAD~0"); // detach at current commit
  const head = git(clean, "rev-parse", "HEAD").trim();
  {
    const res = await req("GET", `/api/sessions/${enc(cleanId)}/git`);
    const j = await res.json();
    assert(j.isRepo === true, "detached: expected isRepo:true");
    assert(j.detached === true, `detached flag=${j.detached}, expected true`);
    assert(
      j.branch === head.slice(0, 7),
      `detached branch=${j.branch}, expected short oid ${head.slice(0, 7)}`,
    );
    console.log(`  ok: detached HEAD -> detached:true branch=${j.branch}`);
  }

  // --- Non-git directory -> isRepo:false ---------------------------------
  const plain = mkscratch("git-endpoints-plain-");
  fs.writeFileSync(path.join(plain, "note.txt"), "hi\n");
  const plainId = await makeSession("git-plain", plain);
  {
    const res = await req("GET", `/api/sessions/${enc(plainId)}/git`);
    assert(res.status === 200, `git(non-repo) -> ${res.status}, expected 200`);
    const j = await res.json();
    assert(
      j.isRepo === false,
      `non-repo expected isRepo:false, got ${JSON.stringify(j)}`,
    );
    console.log(`  ok: non-git cwd -> isRepo:false`);
  }

  // --- Auth: no cookie -> 401 -------------------------------------------
  {
    const res = await fetch(`${BASE}/api/sessions/${enc(repoId)}/git`);
    assert(res.status === 401, `no-cookie git -> ${res.status}, expected 401`);
    console.log(`  ok: no-cookie -> 401`);
  }

  // --- Unknown session -> 404 -------------------------------------------
  {
    const res = await req("GET", `/api/sessions/${enc("local/web-nope")}/git`);
    assert(
      res.status === 404,
      `unknown session git -> ${res.status}, expected 404`,
    );
    console.log(`  ok: unknown session -> 404`);
  }

  console.log("\nPASS: git-endpoints (7 checks)");
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
