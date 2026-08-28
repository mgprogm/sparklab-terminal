// Notes REST integration test — proves /api/notes/* against a real gateway
// with temp NOTES_FILE (tree) + NOTES_PAGES_DIR (bodies) sidecars (no tmux
// involved; Notes is gateway-global like Kanban/PM).
//
// Covers (docs/NOTES-TOOL-PLAN.md §7): tree CRUD + the seeded section/page on
// createNotebook; D2 two-file write ordering (a page's .md exists iff its id
// is in the tree, both gone after delete, an orphan .md is swept on the next
// load()); D3/D4 page-body rev (stale PATCH -> 409 {error,page} carrying the
// body, fresh -> 200); D3 structural rev (stale section/page move -> 409
// {error,notebook}; the two revs are independent of each other); D5 subtree
// move contiguity + parentId cycle rejection; deletePage orphan vs cascade;
// deleteSection block (422 not_empty) vs cascade; append additive +
// concurrent-safe; search substring/snippet/limit; CSRF; the shared artifact
// bearer (GATEWAY_API_TOKEN); 404s; 413. Runs with AUTH ENABLED like the
// kanban/pm endpoint tests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "notesuser";
const AUTH_PASS = "notespass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "http://evil.example.com";
const API_TOKEN = "notes-test-token-abc123";

let server;
let cookie = "";
let tmpDir = "";
let notesFile = "";
let pagesDir = "";
let checks = 0;

function envFor() {
  return {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    GATEWAY_AUTH_USER: AUTH_USER,
    GATEWAY_AUTH_PASSWORD: AUTH_PASS,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    NOTES_FILE: notesFile,
    NOTES_PAGES_DIR: pagesDir,
    GATEWAY_API_TOKEN: API_TOKEN,
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn("node", ["src/server.js"], {
      cwd: ROOT,
      env: envFor(),
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

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.killed) return resolve();
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
  });
}

function cleanup() {
  try {
    if (server && !server.killed) server.kill("SIGTERM");
  } catch {}
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
  checks++;
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
  if (res.status !== 204) fail(`login returned ${res.status}, expected 204`);
  const m = /gw_session=[^;]+/.exec(res.headers.get("set-cookie") || "");
  assert(m, "login did not return gw_session cookie");
  cookie = m[0];
}

function bodyPath(pageId) {
  return path.join(pagesDir, `${pageId}.md`);
}

async function main() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-endpoints-"));
  notesFile = path.join(tmpDir, "notes.json");
  pagesDir = path.join(tmpDir, "notes-pages");

  await startServer();
  console.log(`gateway up on :${PORT} (auth enabled, temp NOTES_FILE)`);
  await login();
  console.log("logged in; cookie captured");

  // --- create notebook: seeds one section "Notes" + one "Untitled page" ---
  let nb;
  {
    const res = await req("POST", "/api/notes/notebooks", {
      body: { name: "Engineering", tags: ["work"] },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res.status === 201,
      `create notebook -> ${res.status}, expected 201`,
    );
    nb = await res.json();
    assert(/^nb-/.test(nb.id), `notebook id should start nb-, got ${nb.id}`);
    assert(nb.rev === 1, `new notebook rev=${nb.rev}, expected 1`);
    assert(nb.sections.length === 1, "should seed exactly one section");
    assert(nb.sections[0].name === "Notes", 'seeded section should be "Notes"');
    assert(nb.pages.length === 1, "should seed exactly one page");
    assert(
      nb.pages[0].title === "Untitled page",
      'seeded page should be titled "Untitled page"',
    );
    assert(
      nb.pages[0].depth === 0,
      "seeded page should be top-level (depth 0)",
    );
    assert(
      nb.pages[0].sectionId === nb.sections[0].id,
      "seeded page's derived sectionId should match the seeded section",
    );
    console.log(
      `  ok: create notebook -> ${nb.id} (seeded section+page, rev 1)`,
    );
  }
  const seededSectionId = nb.sections[0].id;
  const seededPageId = nb.pages[0].id;

  // --- D2: seeded page's body file exists ---------------------------------
  {
    assert(
      fs.existsSync(bodyPath(seededPageId)),
      "seeded page should have a .md body file",
    );
    console.log(`  ok: D2 seeded page body file exists`);
  }

  // --- list summaries ------------------------------------------------------
  {
    const res = await req("GET", "/api/notes/notebooks");
    assert(res.status === 200, `list -> ${res.status}`);
    const j = await res.json();
    const row = j.notebooks.find((n) => n.id === nb.id);
    assert(row, "created notebook missing from list");
    assert(
      row.sectionCount === 1 && row.pageCount === 1,
      "summary counts wrong",
    );
    console.log(`  ok: list notebooks -> summary sectionCount=1 pageCount=1`);
  }

  // --- create a second section ---------------------------------------------
  let secB;
  {
    const res = await req(
      "POST",
      `/api/notes/notebooks/${enc(nb.id)}/sections`,
      { body: { name: "Meetings" }, origin: ALLOWED_ORIGIN },
    );
    assert(res.status === 201, `create section -> ${res.status}`);
    nb = await res.json();
    secB = nb.sections.find((s) => s.name === "Meetings");
    assert(secB, "new section missing from notebook");
    assert(nb.rev === 2, `notebook rev should bump to 2, got ${nb.rev}`);
    console.log(`  ok: create section "Meetings" -> notebook rev 2`);
  }

  // --- rename section --------------------------------------------------------
  {
    const res = await req("PATCH", `/api/notes/sections/${enc(secB.id)}`, {
      body: { notebookId: nb.id, name: "Meeting notes" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `rename section -> ${res.status}`);
    nb = await res.json();
    assert(
      nb.sections.find((s) => s.id === secB.id).name === "Meeting notes",
      "section rename not applied",
    );
    console.log(`  ok: rename section`);
  }

  // --- create a page in the new section, with a body ------------------------
  let pageA;
  {
    const res = await req("POST", `/api/notes/notebooks/${enc(nb.id)}/pages`, {
      body: {
        sectionId: secB.id,
        title: "Kickoff",
        body: "# Kickoff\n\nAgenda TBD.",
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create page -> ${res.status}`);
    pageA = await res.json();
    assert(pageA.title === "Kickoff", "page title mismatch");
    assert(pageA.body === "# Kickoff\n\nAgenda TBD.", "page body mismatch");
    assert(pageA.rev === 1, `new page rev=${pageA.rev}, expected 1`);
    console.log(`  ok: create page "Kickoff" in section "Meeting notes"`);
  }

  // --- D2 write ordering: create -> .md exists AND id spliced into pageIds --
  {
    assert(fs.existsSync(bodyPath(pageA.id)), "new page .md should exist");
    const g = await (
      await req("GET", `/api/notes/notebooks/${enc(nb.id)}`)
    ).json();
    const sec = g.sections.find((s) => s.id === secB.id);
    assert(
      sec.pageIds.includes(pageA.id),
      "new page id should be in section.pageIds",
    );
    nb = g;
    console.log(`  ok: D2 create-page ordering: .md exists AND id in pageIds`);
  }

  // ============================================================
  // D3/D4: page-body rev — stale PATCH -> 409 {error,page}; fresh -> 200
  // ============================================================
  {
    const stale = await req("PATCH", `/api/notes/pages/${enc(pageA.id)}`, {
      body: { notebookId: nb.id, body: "stale write", rev: pageA.rev - 1 },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      stale.status === 409,
      `stale page PATCH -> ${stale.status}, expected 409`,
    );
    const staleJson = await stale.json();
    assert(
      staleJson.error === "stale",
      "stale PATCH should report error:stale",
    );
    assert(
      staleJson.page && staleJson.page.id === pageA.id,
      "stale 409 should carry the current page",
    );
    assert(
      staleJson.page.body === "# Kickoff\n\nAgenda TBD.",
      "stale 409's page should carry the CURRENT (unmodified) body",
    );
    console.log(`  ok: D3/D4 stale page PATCH -> 409 {error:"stale", page}`);

    const fresh = await req("PATCH", `/api/notes/pages/${enc(pageA.id)}`, {
      body: {
        notebookId: nb.id,
        title: "Kickoff notes",
        body: "# Kickoff\n\nAgenda: intros, scope, next steps.",
        rev: pageA.rev,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      fresh.status === 200,
      `fresh page PATCH -> ${fresh.status}, expected 200`,
    );
    pageA = await fresh.json();
    assert(pageA.title === "Kickoff notes", "title not applied");
    assert(pageA.rev === 2, `page rev should bump to 2, got ${pageA.rev}`);
    console.log(`  ok: D3/D4 fresh page PATCH -> 200, rev bumped to 2`);
  }

  // --- rev is REQUIRED on PATCH /pages/:id (route enforces presence) -------
  {
    const res = await req("PATCH", `/api/notes/pages/${enc(pageA.id)}`, {
      body: { notebookId: nb.id, title: "no rev" },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res.status === 400,
      `PATCH page w/o rev -> ${res.status}, expected 400`,
    );
    console.log(`  ok: PATCH page without rev -> 400`);
  }

  // ============================================================
  // D3: two revs are INDEPENDENT — a page-body update does not bump the
  // notebook's structural rev, so a concurrent structural move using the
  // OLD notebook rev still succeeds.
  // ============================================================
  {
    const nbRevBefore = nb.rev;
    const appendRes = await req(
      "POST",
      `/api/notes/pages/${enc(pageA.id)}/append`,
      {
        body: { notebookId: nb.id, markdown: "- follow-up: send notes" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(appendRes.status === 200, `append -> ${appendRes.status}`);
    pageA = await appendRes.json();
    assert(pageA.rev === 3, `page rev should bump to 3, got ${pageA.rev}`);

    // The notebook's structural rev must be UNCHANGED by a page-body write.
    const nbAfterAppend = await (
      await req("GET", `/api/notes/notebooks/${enc(nb.id)}`)
    ).json();
    assert(
      nbAfterAppend.rev === nbRevBefore,
      `notebook rev should be unaffected by a page-body write: ${nbAfterAppend.rev} != ${nbRevBefore}`,
    );

    // A structural move using the OLD (== still current) notebook rev
    // succeeds — proving the page-body write above never touched it.
    const moveRes = await req(
      "POST",
      `/api/notes/sections/${enc(secB.id)}/move`,
      {
        body: { notebookId: nb.id, toIndex: 0, rev: nbRevBefore },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      moveRes.status === 200,
      `structural move w/ pre-append notebook rev -> ${moveRes.status}, expected 200 (independent revs)`,
    );
    nb = await moveRes.json();
    assert(
      nb.sections[0].id === secB.id,
      "Meeting notes section should now be first",
    );
    console.log(`  ok: D3 page.rev and notebook.rev are independent`);
  }

  // ============================================================
  // D3: structural rev — stale section move -> 409 {error,notebook}
  // ============================================================
  {
    const res = await req(
      "POST",
      `/api/notes/sections/${enc(seededSectionId)}/move`,
      {
        body: { notebookId: nb.id, toIndex: 0, rev: nb.rev - 1 },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      res.status === 409,
      `stale section move -> ${res.status}, expected 409`,
    );
    const j = await res.json();
    assert(j.error === "stale", "stale move should report error:stale");
    assert(
      j.notebook && j.notebook.rev === nb.rev,
      "409 should carry the current notebook",
    );
    console.log(`  ok: D3 stale section move -> 409 {error:"stale", notebook}`);

    const fresh = await req(
      "POST",
      `/api/notes/sections/${enc(seededSectionId)}/move`,
      {
        body: { notebookId: nb.id, toIndex: 0, rev: nb.rev },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(fresh.status === 200, `fresh section move -> ${fresh.status}`);
    nb = await fresh.json();
    assert(
      nb.sections[0].id === seededSectionId,
      "Notes section should now be first",
    );
    console.log(`  ok: D3 fresh section move -> 200`);
  }

  // ============================================================
  // D5: subtree move — a page with a child moves contiguously across
  // sections and keeps relative order + parentId.
  // ============================================================
  let parentPage, childPage;
  {
    const pr = await req("POST", `/api/notes/notebooks/${enc(nb.id)}/pages`, {
      body: { sectionId: seededSectionId, title: "Parent" },
      origin: ALLOWED_ORIGIN,
    });
    assert(pr.status === 201, `create parent page -> ${pr.status}`);
    parentPage = await pr.json();

    const cr = await req("POST", `/api/notes/notebooks/${enc(nb.id)}/pages`, {
      body: {
        sectionId: seededSectionId,
        title: "Child",
        parentId: parentPage.id,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(cr.status === 201, `create child page -> ${cr.status}`);
    childPage = await cr.json();
    assert(childPage.parentId === parentPage.id, "child parentId mismatch");
    assert(
      childPage.depth === 1,
      `child depth should be 1, got ${childPage.depth}`,
    );

    const g = await (
      await req("GET", `/api/notes/notebooks/${enc(nb.id)}`)
    ).json();
    nb = g;
  }
  {
    // Move the parent (with its child) into "Meeting notes" @ index 0.
    const res = await req(
      "POST",
      `/api/notes/pages/${enc(parentPage.id)}/move`,
      {
        body: {
          notebookId: nb.id,
          toSectionId: secB.id,
          toIndex: 0,
          rev: nb.rev,
        },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 200, `subtree move -> ${res.status}`);
    nb = await res.json();
    const targetSec = nb.sections.find((s) => s.id === secB.id);
    assert(
      targetSec.pageIds[0] === parentPage.id &&
        targetSec.pageIds[1] === childPage.id,
      `subtree should land contiguously [parent,child], got ${JSON.stringify(targetSec.pageIds.slice(0, 2))}`,
    );
    const movedChild = nb.pages.find((p) => p.id === childPage.id);
    assert(
      movedChild.parentId === parentPage.id,
      "child parentId should survive the subtree move",
    );
    assert(
      movedChild.sectionId === secB.id,
      "child's derived sectionId should follow the parent",
    );
    console.log(`  ok: D5 subtree move — parent+child land contiguously`);
  }

  // --- D5: parentId cycle -> 400 --------------------------------------------
  {
    const res = await req(
      "POST",
      `/api/notes/pages/${enc(parentPage.id)}/move`,
      {
        body: {
          notebookId: nb.id,
          toSectionId: secB.id,
          toIndex: 0,
          toParentId: childPage.id, // descendant -> cycle
          rev: nb.rev,
        },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 400, `cycle move -> ${res.status}, expected 400`);
    console.log(`  ok: D5 parentId cycle (movePage) -> 400`);

    const createCycle = await req(
      "POST",
      `/api/notes/notebooks/${enc(nb.id)}/pages`,
      {
        body: { sectionId: secB.id, title: "x", parentId: "does-not-exist" },
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      createCycle.status === 404,
      `createPage w/ unknown parentId -> ${createCycle.status}, expected 404`,
    );
    console.log(`  ok: createPage with unknown parentId -> 404`);
  }

  // ============================================================
  // deletePage: orphan (default) promotes children; cascade removes subtree
  // ============================================================
  {
    // orphan: delete the parent, child should be promoted to top-level.
    const res = await req(
      "DELETE",
      `/api/notes/pages/${enc(parentPage.id)}?notebookId=${enc(nb.id)}`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(res.status === 204, `delete page (orphan) -> ${res.status}`);
    assert(
      !fs.existsSync(bodyPath(parentPage.id)),
      "parent .md should be gone",
    );
    assert(
      fs.existsSync(bodyPath(childPage.id)),
      "child .md should survive an orphan delete",
    );
    const g = await (
      await req("GET", `/api/notes/notebooks/${enc(nb.id)}`)
    ).json();
    const survivor = g.pages.find((p) => p.id === childPage.id);
    assert(survivor, "child page should still exist after orphan delete");
    assert(
      survivor.parentId === null,
      `orphaned child's parentId should be promoted to null, got ${survivor.parentId}`,
    );
    nb = g;
    console.log(`  ok: deletePage orphan (default) promotes children`);
  }
  {
    // cascade: create a fresh parent+child, delete parent with cascade.
    const pr = await req("POST", `/api/notes/notebooks/${enc(nb.id)}/pages`, {
      body: { sectionId: secB.id, title: "P2" },
      origin: ALLOWED_ORIGIN,
    });
    const p2 = await pr.json();
    const cr = await req("POST", `/api/notes/notebooks/${enc(nb.id)}/pages`, {
      body: { sectionId: secB.id, title: "C2", parentId: p2.id },
      origin: ALLOWED_ORIGIN,
    });
    const c2 = await cr.json();
    const del = await req(
      "DELETE",
      `/api/notes/pages/${enc(p2.id)}?notebookId=${enc(nb.id)}&mode=cascade`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(del.status === 204, `delete page (cascade) -> ${del.status}`);
    assert(!fs.existsSync(bodyPath(p2.id)), "parent .md should be gone");
    assert(
      !fs.existsSync(bodyPath(c2.id)),
      "cascade should also remove the child's .md",
    );
    const g = await (
      await req("GET", `/api/notes/notebooks/${enc(nb.id)}`)
    ).json();
    assert(
      !g.pages.some((p) => p.id === c2.id),
      "cascaded child should be gone from the tree",
    );
    nb = g;
    console.log(`  ok: deletePage cascade removes the whole subtree`);
  }

  // ============================================================
  // deleteSection: block (422 not_empty) vs cascade
  // ============================================================
  {
    // secB is non-empty (still has "Kickoff notes" + others) -> block.
    const res = await req(
      "DELETE",
      `/api/notes/sections/${enc(secB.id)}?notebookId=${enc(nb.id)}`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(
      res.status === 422,
      `delete non-empty section (block) -> ${res.status}, expected 422`,
    );
    const j = await res.json();
    assert(
      j.error && /not_empty|page/.test(j.error),
      "422 body should explain not_empty",
    );
    console.log(`  ok: deleteSection block on non-empty -> 422 not_empty`);

    // cascade removes the section AND its pages' bodies.
    const remainingPageIds = nb.sections.find((s) => s.id === secB.id).pageIds;
    const del = await req(
      "DELETE",
      `/api/notes/sections/${enc(secB.id)}?notebookId=${enc(nb.id)}&mode=cascade`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(del.status === 204, `delete section (cascade) -> ${del.status}`);
    for (const pid of remainingPageIds) {
      assert(
        !fs.existsSync(bodyPath(pid)),
        `cascaded page ${pid} .md should be gone`,
      );
    }
    const g = await (
      await req("GET", `/api/notes/notebooks/${enc(nb.id)}`)
    ).json();
    assert(
      !g.sections.some((s) => s.id === secB.id),
      "cascaded section should be gone",
    );
    nb = g;
    console.log(`  ok: deleteSection cascade -> 204, section+pages gone`);
  }

  // ============================================================
  // append: additive, no rev, concurrent-safe (no lost update)
  // ============================================================
  {
    const target = nb.pages.find((p) => p.id === seededPageId);
    const before = target.rev;
    const [r1, r2] = await Promise.all([
      req("POST", `/api/notes/pages/${enc(seededPageId)}/append`, {
        body: { notebookId: nb.id, markdown: "line A" },
        origin: ALLOWED_ORIGIN,
      }),
      req("POST", `/api/notes/pages/${enc(seededPageId)}/append`, {
        body: { notebookId: nb.id, markdown: "line B" },
        origin: ALLOWED_ORIGIN,
      }),
    ]);
    assert(
      r1.status === 200 && r2.status === 200,
      "both concurrent appends should succeed",
    );
    const g = await (
      await req(
        "GET",
        `/api/notes/notebooks/${enc(nb.id)}/pages/${enc(seededPageId)}`,
      )
    ).json();
    assert(
      g.rev === before + 2,
      `page rev should bump twice (${before}->${g.rev})`,
    );
    assert(
      g.body.includes("line A"),
      "appended content A missing (lost update)",
    );
    assert(
      g.body.includes("line B"),
      "appended content B missing (lost update)",
    );
    console.log(
      `  ok: concurrent appends -> both land, rev bumps twice, no lost update`,
    );
  }

  // ============================================================
  // search: substring, snippet, limit
  // ============================================================
  {
    const res = await req("GET", `/api/notes/search?q=${enc("line A")}`);
    assert(res.status === 200, `search -> ${res.status}`);
    const j = await res.json();
    assert(Array.isArray(j.results), "search should return a results array");
    const hit = j.results.find((h) => h.pageId === seededPageId);
    assert(hit, "search should find the page containing the appended text");
    assert(
      typeof hit.snippet === "string" && hit.snippet.length > 0,
      "search hit should carry a snippet",
    );
    console.log(`  ok: search finds substring match with snippet`);

    const limited = await req("GET", `/api/notes/search?q=e&limit=1`);
    const lj = await limited.json();
    assert(
      lj.results.length <= 1,
      `limit=1 should cap results, got ${lj.results.length}`,
    );
    console.log(`  ok: search respects limit`);
  }

  // --- CSRF: foreign/missing Origin -> 403 on writes; GET exempt -----------
  {
    const w = await req("POST", "/api/notes/notebooks", {
      body: { name: "nope" },
      origin: FOREIGN_ORIGIN,
    });
    assert(
      w.status === 403,
      `foreign-origin write -> ${w.status}, expected 403`,
    );
    const g = await req("GET", "/api/notes/notebooks", {
      origin: FOREIGN_ORIGIN,
    });
    assert(
      g.status === 200,
      `foreign-origin GET -> ${g.status}, expected 200 (exempt)`,
    );
    console.log(`  ok: CSRF -> write 403 on foreign Origin, GET exempt`);
  }

  // --- bearer token: valid GATEWAY_API_TOKEN (no cookie) -> 200/201 --------
  {
    const ok = await req("GET", "/api/notes/notebooks", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert(
      ok.status === 200,
      `valid bearer (no cookie) -> ${ok.status}, expected 200`,
    );

    const created = await req("POST", "/api/notes/notebooks", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      body: { name: "via-cli" },
    });
    assert(
      created.status === 201,
      `bearer write -> ${created.status}, expected 201`,
    );

    const bad = await req("GET", "/api/notes/notebooks", {
      cookie: false,
      headers: { authorization: `Bearer wrong-token` },
    });
    assert(bad.status === 401, `bad bearer -> ${bad.status}, expected 401`);

    const none = await req("GET", "/api/notes/notebooks", { cookie: false });
    assert(none.status === 401, `no auth -> ${none.status}, expected 401`);

    // The bearer must NOT be accepted on a non-artifact prefix.
    const wrongPrefix = await req("GET", "/api/sessions", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert(
      wrongPrefix.status === 401,
      `bearer on non-artifact prefix -> ${wrongPrefix.status}, expected 401`,
    );
    console.log(
      `  ok: bearer token -> valid 200/201, bad 401, none 401, wrong-prefix 401`,
    );
  }

  // --- validation + 404s -----------------------------------------------------
  {
    const noName = await req("POST", "/api/notes/notebooks", {
      body: {},
      origin: ALLOWED_ORIGIN,
    });
    assert(
      noName.status === 400,
      `create w/o name -> ${noName.status}, expected 400`,
    );

    const missing = await req("GET", "/api/notes/notebooks/nb-does-not-exist");
    assert(
      missing.status === 404,
      `unknown notebook -> ${missing.status}, expected 404`,
    );

    const missingPage = await req(
      "GET",
      `/api/notes/notebooks/${enc(nb.id)}/pages/pg-does-not-exist`,
    );
    assert(
      missingPage.status === 404,
      `unknown page -> ${missingPage.status}, expected 404`,
    );

    const badMove = await req("POST", `/api/notes/pages/nope/move`, {
      body: { notebookId: nb.id, toSectionId: "nope", toIndex: 0, rev: nb.rev },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      badMove.status === 404,
      `move unknown page -> ${badMove.status}, expected 404`,
    );
    console.log(`  ok: validation 400 + 404s`);
  }

  // --- 413: oversized body (server may 413 the response OR reset the
  // socket mid-upload — both are an acceptable rejection; only a 2xx is a
  // failure) ------------------------------------------------------------
  {
    const huge = "x".repeat(3 * 1024 * 1024); // BODY_LIMIT (64KB) well under 3MB
    let status = null;
    try {
      const res = await req("POST", "/api/notes/notebooks", {
        body: { name: "big", tags: [huge] },
        origin: ALLOWED_ORIGIN,
      });
      status = res.status;
    } catch {
      status = "socket-reset";
    }
    assert(
      status === 413 || status === "socket-reset",
      `oversized body -> ${status} (expected 413 or socket reset, never 2xx)`,
    );
    console.log(`  ok: oversized body rejected (${status})`);
  }

  // --- delete notebook -> 204, then 404; bodies gone ------------------------
  {
    const remaining = nb.pages.map((p) => p.id);
    const res = await req("DELETE", `/api/notes/notebooks/${enc(nb.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res.status === 204,
      `delete notebook -> ${res.status}, expected 204`,
    );
    const g = await req("GET", `/api/notes/notebooks/${enc(nb.id)}`);
    assert(
      g.status === 404,
      `deleted notebook get -> ${g.status}, expected 404`,
    );
    for (const pid of remaining) {
      assert(
        !fs.existsSync(bodyPath(pid)),
        `deleted notebook page ${pid} .md should be gone`,
      );
    }
    console.log(`  ok: delete notebook -> 204, then 404, bodies swept`);
  }

  // ============================================================
  // D2 crash-safety simulation: an orphan .md with no tree reference is
  // swept on the next load() (server restart, same NOTES_FILE/NOTES_PAGES_DIR).
  // ============================================================
  {
    await stopServer();
    fs.mkdirSync(pagesDir, { recursive: true });
    const orphanId = "pg-orphan-simulated";
    fs.writeFileSync(bodyPath(orphanId), "this body has no tree entry", "utf8");
    assert(
      fs.existsSync(bodyPath(orphanId)),
      "orphan .md should exist before restart",
    );

    await startServer();
    await login(); // fresh process -> fresh session
    assert(
      !fs.existsSync(bodyPath(orphanId)),
      "orphan .md should be swept by load() on gateway restart",
    );
    console.log(`  ok: D2 orphan .md swept by load() on restart`);

    // The gateway should still be healthy after the sweep.
    const health = await req("GET", "/api/notes/notebooks");
    assert(
      health.status === 200,
      `notebooks list after restart -> ${health.status}`,
    );
  }

  console.log(`\nPASS: notes-endpoints (${checks} checks)`);
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
