// Session organization test — proves org/project fields on POST and PATCH:
//   POST /api/sessions  with org, project validation
//   PATCH /api/sessions/:id  rename, move, clears, validation
// REST level, no browser, real gateway + real tmux.
//
// Flow:
//   1. POST with project-but-no-org -> 400.
//   2. POST with invalid org (too long / contains /) -> 400.
//   3. POST happy path with org+project -> 201, fields persisted in GET.
//   4. PATCH rename -> 200, name changed.
//   5. PATCH move to different org/project -> 200, fields updated.
//   6. PATCH project:null clears project only.
//   7. PATCH org:null clears org AND project.
//   8. PATCH project-without-org on merged result -> 400.
//   9. PATCH unknown session -> 404.
//  10. PATCH invalid org -> 400.
//  11. DELETE, verify no orphans.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listWebSessions() {
  try {
    const out = execFileSync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("web-"));
  } catch {
    return [];
  }
}

let server;
const createdIds = [];
// Multi-server: ids are QUALIFIED (`<serverId>/web-<uuid>`). Direct tmux CLI
// needs the bare tmux name; REST paths need the "/" encoded to one segment.
const bare = (id) => (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id);

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
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
  for (const id of createdIds) {
    try {
      execFileSync("tmux", ["kill-session", "-t", bare(id)], {
        stdio: "ignore",
      });
    } catch {}
  }
  if (server && !server.killed) server.kill("SIGTERM");
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

async function rest(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT}`);

  // --- 1. POST with project but no org -> 400 ---
  const r1 = await rest("POST", "/api/sessions", {
    name: "test-no-org",
    project: "checkout",
  });
  if (r1.status !== 400)
    fail(`project-without-org returned ${r1.status}, expected 400`);
  const r1Body = await r1.json();
  if (!r1Body.error.includes("project requires org"))
    fail(`expected "project requires org" error, got: ${r1Body.error}`);
  console.log("1. POST project-without-org -> 400 OK");

  // --- 2. POST with invalid org (too long / contains /) -> 400 ---
  const longOrg = "a".repeat(33);
  const r2a = await rest("POST", "/api/sessions", {
    name: "test-long",
    org: longOrg,
  });
  if (r2a.status !== 400)
    fail(`33-char org returned ${r2a.status}, expected 400`);

  const r2b = await rest("POST", "/api/sessions", {
    name: "test-slash",
    org: "acme/corp",
  });
  if (r2b.status !== 400)
    fail(`org with "/" returned ${r2b.status}, expected 400`);

  const r2c = await rest("POST", "/api/sessions", {
    name: "test-empty",
    org: "   ",
  });
  if (r2c.status !== 400)
    fail(`whitespace-only org returned ${r2c.status}, expected 400`);
  console.log("2. POST invalid org (long, slash, empty) -> 400 OK");

  // --- 3. POST happy path with org+project -> 201 ---
  const r3 = await rest("POST", "/api/sessions", {
    name: "org-test",
    org: "  Acme Corp  ",
    project: " checkout ",
  });
  if (r3.status !== 201) fail(`happy POST returned ${r3.status}, expected 201`);
  const s3 = await r3.json();
  createdIds.push(s3.id);
  if (s3.org !== "Acme Corp") fail(`org not trimmed: "${s3.org}"`);
  if (s3.project !== "checkout") fail(`project not trimmed: "${s3.project}"`);
  console.log(
    `3. POST happy path -> 201, org="${s3.org}" project="${s3.project}" OK`,
  );

  // Verify GET returns the fields.
  await sleep(300);
  const rList = await rest("GET", "/api/sessions");
  const list = await rList.json();
  const found = list.find((s) => s.id === s3.id);
  if (!found) fail("created session not in GET list");
  if (found.org !== "Acme Corp") fail(`GET org wrong: "${found.org}"`);
  if (found.project !== "checkout")
    fail(`GET project wrong: "${found.project}"`);
  console.log("   GET /api/sessions returns org+project OK");

  // --- 4. PATCH rename -> 200 ---
  const r4 = await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    name: "renamed-session",
  });
  if (r4.status !== 200)
    fail(`PATCH rename returned ${r4.status}, expected 200`);
  const s4 = await r4.json();
  if (s4.name !== "renamed-session") fail(`renamed name wrong: "${s4.name}"`);
  if (s4.org !== "Acme Corp") fail("rename changed org unexpectedly");
  if (s4.project !== "checkout") fail("rename changed project unexpectedly");
  console.log("4. PATCH rename -> 200 OK");

  // --- 5. PATCH move to different org/project -> 200 ---
  const r5 = await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    org: "NewOrg",
    project: "payments",
  });
  if (r5.status !== 200) fail(`PATCH move returned ${r5.status}, expected 200`);
  const s5 = await r5.json();
  if (s5.org !== "NewOrg") fail(`moved org wrong: "${s5.org}"`);
  if (s5.project !== "payments") fail(`moved project wrong: "${s5.project}"`);
  if (s5.name !== "renamed-session") fail("move changed name unexpectedly");
  console.log("5. PATCH move org/project -> 200 OK");

  // --- 6. PATCH project:null clears project only ---
  const r6 = await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    project: null,
  });
  if (r6.status !== 200)
    fail(`PATCH clear project returned ${r6.status}, expected 200`);
  const s6 = await r6.json();
  if (s6.project !== null) fail(`cleared project not null: "${s6.project}"`);
  if (s6.org !== "NewOrg") fail("clear project changed org unexpectedly");
  console.log("6. PATCH project:null clears project -> 200 OK");

  // --- 7. PATCH org:null clears org AND project ---
  // First restore a project so we can verify both clear.
  await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    project: "temp",
  });
  const r7 = await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    org: null,
  });
  if (r7.status !== 200)
    fail(`PATCH clear org returned ${r7.status}, expected 200`);
  const s7 = await r7.json();
  if (s7.org !== null) fail(`cleared org not null: "${s7.org}"`);
  if (s7.project !== null)
    fail(`clearing org did not clear project: "${s7.project}"`);
  console.log("7. PATCH org:null clears org AND project -> 200 OK");

  // --- 8. PATCH project-without-org on merged result -> 400 ---
  // Session currently has no org. Setting project without org should fail.
  const r8 = await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    project: "orphan",
  });
  if (r8.status !== 400)
    fail(`project-without-org PATCH returned ${r8.status}, expected 400`);
  console.log("8. PATCH project-without-org on merged -> 400 OK");

  // --- 9. PATCH unknown session -> 404 ---
  const ghost = "web-00000000-0000-0000-0000-000000000000";
  const r9 = await rest("PATCH", `/api/sessions/${ghost}`, { name: "x" });
  if (r9.status !== 404)
    fail(`PATCH ghost returned ${r9.status}, expected 404`);
  console.log("9. PATCH unknown session -> 404 OK");

  // --- 10. PATCH invalid org -> 400 ---
  // Restore org first.
  await rest("PATCH", `/api/sessions/${encodeURIComponent(s3.id)}`, {
    org: "Valid",
  });
  const r10 = await rest(
    "PATCH",
    `/api/sessions/${encodeURIComponent(s3.id)}`,
    {
      org: "bad/org",
    },
  );
  if (r10.status !== 400)
    fail(`PATCH invalid org returned ${r10.status}, expected 400`);
  console.log("10. PATCH invalid org -> 400 OK");

  // --- 11. DELETE, verify no orphans ---
  const rDel = await rest(
    "DELETE",
    `/api/sessions/${encodeURIComponent(s3.id)}`,
  );
  if (rDel.status !== 204) fail(`DELETE returned ${rDel.status}, expected 204`);
  await sleep(300);
  const orphans = listWebSessions().filter((s) =>
    createdIds.map(bare).includes(s),
  );
  if (orphans.length)
    fail(`orphan web- sessions remain: ${orphans.join(", ")}`);
  console.log("11. DELETE + cleanup OK");

  console.log(
    "\nPASS: session organization — POST/PATCH validation, rename, move, clears, 404s all correct.",
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
