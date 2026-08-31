// Notes store for the OneNote-style pluggable Notes artifact (docs/NOTES-TOOL-PLAN.md).
//
// SPLIT STORE (D2) — deliberately different from kanban.js's single-file model:
//   - data/notes.json           the TREE only: notebooks -> sections -> page
//                               METADATA (title/tags/parentId/revs/timestamps)
//                               + the ordering arrays. Small; rewritten whole
//                               via the atomic writeFileSync(TMP)+renameSync
//                               pattern (same as kanban.js / registry.js).
//   - data/notes-pages/<id>.md  ONE file per page BODY (raw UTF-8 Markdown).
//                               A body save touches exactly one small file,
//                               also writeFileSync(TMP)+renameSync.
// Test overrides: NOTES_FILE (tree) + NOTES_PAGES_DIR (bodies).
//
// CONCURRENCY (D3): every mutator is FULLY SYNCHRONOUS (read -> modify ->
// writeFileSync, no await mid-method), so Node's single thread runs each to
// completion without interleaving — a read-modify-write is atomic and no mutex
// is needed (same reason kanban.js / registry.js need none). Cross-client
// staleness is caught by a TWO-TIER `rev`:
//   - page.rev      bumped ONLY on that page's title/body change; carried by
//                   updatePage({expectedRev}) -> coded "stale" on mismatch.
//   - notebook.rev  bumped on any STRUCTURAL change (section add/rename/reorder/
//                   delete, page add/move/delete); carried by moveSection /
//                   movePage({expectedRev}) -> coded "stale" on mismatch.
// Two revs so the agent appending to page A never 409s the human renaming a
// section, and vice-versa.
//
// WRITE-ORDERING ACROSS THE TWO FILES (D2 — must be exactly this):
//   - create page: write body file THEN splice id into section.pageIds
//                  (a crash leaves an orphan .md, swept on next load()).
//   - delete page: splice id out of the tree THEN unlink the body file(s)
//                  (a crash leaves an orphan .md, never a tree entry with no body).
//   - update body: bump page.rev in the tree FIRST, THEN write the body file
//                  (a crash leaves rev ahead of the body => the next writer is
//                   forced to 409 and reload — fail toward a FALSE CONFLICT,
//                   never a false accept).
//
// ORDERING + HIERARCHY (D5): Notebook.sectionIds[] and Section.pageIds[] are the
// SOLE order authorities. A page record carries NO sectionId and NO order;
// getNotebook() derives `sectionId` + `depth` per page but never persists them.
// `parentId` (nullable) is a pure containment/indent edge for the subpage tree —
// it does NOT encode order. movePage() moves a page AND its whole transitive
// subtree as one contiguous run in pageIds[]. `parentId` is cycle-checked on
// createPage / movePage (mirrors src/pm.js) -> coded "cycle".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
// Overridable for tests (mirrors KANBAN_FILE / SERVERS_FILE).
const FILE = process.env.NOTES_FILE || path.join(DATA_DIR, "notes.json");
const TMP = `${FILE}.tmp`;
const PAGES_DIR =
  process.env.NOTES_PAGES_DIR || path.join(DATA_DIR, "notes-pages");

// { notebooks: { [nbId]: Notebook } } where a stored Notebook is
// { id, name, tags[], rev, createdAt, updatedAt, sectionIds[],
//   sections: { [secId]: { id, name, pageIds[], createdAt, updatedAt } },
//   pages:    { [pgId]:  { id, title, tags[], parentId, rev, createdAt, updatedAt } } }.
// Page BODIES are NOT here — they live in PAGES_DIR/<pgId>.md.
let store = { notebooks: {} };

function now() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Coded error the gateway route layer maps to an HTTP status:
// not_found -> 404, stale -> 409, not_empty -> 422, cycle -> 400, else -> 400.
function err(code, message, details) {
  const e = new Error(message || code);
  e.code = code;
  if (details) e.details = details; // extra fields merged into the JSON error body
  return e;
}

// ---- Page-body file helpers (PAGES_DIR/<pageId>.md, atomic) ----

function pageBodyPath(pageId) {
  return path.join(PAGES_DIR, `${pageId}.md`);
}

function readPageBody(pageId) {
  try {
    return fs.readFileSync(pageBodyPath(pageId), "utf8");
  } catch {
    return ""; // absent file => empty body (D2)
  }
}

function writePageBody(pageId, body) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const dst = pageBodyPath(pageId);
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, typeof body === "string" ? body : "", "utf8");
  fs.renameSync(tmp, dst);
}

function unlinkPageBody(pageId) {
  try {
    fs.unlinkSync(pageBodyPath(pageId));
  } catch {
    /* already gone — fine */
  }
}

// ---- load / persist ----

// Sweep PAGES_DIR for <id>.md files that no tree page references and unlink them
// (best-effort, logged to stderr) — the tail half of D2's crash-safety story.
function sweepOrphanPages() {
  let referenced;
  try {
    referenced = new Set();
    for (const nb of Object.values(store.notebooks)) {
      for (const pid of Object.keys(nb.pages || {})) referenced.add(pid);
    }
  } catch {
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(PAGES_DIR);
  } catch {
    return; // no pages dir yet
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (referenced.has(id)) continue;
    try {
      fs.unlinkSync(path.join(PAGES_DIR, name));
      process.stderr.write(`notes: swept orphan page body ${name}\n`);
    } catch {
      /* best-effort */
    }
  }
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    fs.mkdirSync(PAGES_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store =
      parsed && typeof parsed === "object" && parsed.notebooks
        ? { notebooks: parsed.notebooks }
        : { notebooks: {} };
  } catch {
    store = { notebooks: {} }; // missing / corrupt -> empty (never throw)
  }
  sweepOrphanPages();
  return store;
}

function persist() {
  fs.writeFileSync(TMP, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(TMP, FILE);
}

// ---- internal helpers ----

function requireNotebook(nbId) {
  const nb = store.notebooks[nbId];
  if (!nb) throw err("not_found", "notebook not found");
  return nb;
}

// Bump the structural rev + updatedAt on a mutation of `nb`.
function touch(nb) {
  nb.rev += 1;
  nb.updatedAt = now();
}

// Sections in their authoritative order (skips dangling ids in a corrupt store).
function orderedSections(nb) {
  return nb.sectionIds.map((id) => nb.sections[id]).filter(Boolean);
}

function sectionOfPage(nb, pageId) {
  return orderedSections(nb).find((s) => s.pageIds.includes(pageId));
}

// Depth of a page in the parentId forest (0 for a top-level page). Cycle-guarded.
function depthOfPage(nb, pageId) {
  let d = 0;
  const seen = new Set();
  let cur = nb.pages[pageId]?.parentId ?? null;
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    d += 1;
    cur = nb.pages[cur]?.parentId ?? null;
  }
  return d;
}

// Is `pid` a transitive child of `ancestorId` via parentId edges? Cycle-guarded.
function isDescendantOf(nb, pid, ancestorId) {
  const seen = new Set();
  let cur = nb.pages[pid]?.parentId ?? null;
  while (cur) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = nb.pages[cur]?.parentId ?? null;
  }
  return false;
}

// Would making `parentId` the parent of `pageId` create a parent-chain cycle?
// Walk up from parentId following parentId edges; a cycle exists if we reach
// pageId. Mirrors wouldParentCycle() in src/pm.js.
function wouldParentCycle(nb, pageId, parentId) {
  const seen = new Set();
  let cur = parentId;
  while (cur) {
    if (cur === pageId) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = nb.pages[cur]?.parentId ?? null;
  }
  return false;
}

// The moving run for `rootId` = the page itself plus every transitive child,
// taken IN the section's current pageIds order so relative order is preserved.
function collectSubtreeInOrder(nb, section, rootId) {
  return section.pageIds.filter(
    (id) => id === rootId || isDescendantOf(nb, id, rootId),
  );
}

// Index in section.pageIds just past `parentPageId` and its contiguous subtree —
// where a freshly created child page is spliced in (D2: "after the parent's subtree").
function subtreeEndIndex(nb, section, parentPageId) {
  const i = section.pageIds.indexOf(parentPageId);
  if (i < 0) return section.pageIds.length;
  let j = i + 1;
  while (
    j < section.pageIds.length &&
    isDescendantOf(nb, section.pageIds[j], parentPageId)
  ) {
    j += 1;
  }
  return j;
}

// ---- read shapes (deep copies — callers can never mutate the store) ----

function shapeSection(section) {
  return {
    id: section.id,
    name: section.name,
    pageIds: [...section.pageIds],
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
}

// Page tree metadata + DERIVED sectionId/depth (D5) — no body.
function shapePageMeta(nb, page, sectionId) {
  return {
    id: page.id,
    title: page.title,
    tags: [...page.tags],
    parentId: page.parentId ?? null,
    rev: page.rev,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    sectionId: sectionId ?? sectionOfPage(nb, page.id)?.id ?? null,
    depth: depthOfPage(nb, page.id),
  };
}

// Page metadata + body (reads the .md). Returned by getPage / createPage /
// updatePage / appendToPage.
function shapePageContent(nb, page, sectionId) {
  return { ...shapePageMeta(nb, page, sectionId), body: readPageBody(page.id) };
}

// Full notebook tree: ordered sections, a FLAT pages array in render order
// (section order, then each section's pageIds order) each with derived
// sectionId + depth. No bodies.
function shapeNotebook(nb) {
  const sections = orderedSections(nb);
  const pages = [];
  for (const sec of sections) {
    for (const pid of sec.pageIds) {
      const p = nb.pages[pid];
      if (p) pages.push(shapePageMeta(nb, p, sec.id));
    }
  }
  return {
    id: nb.id,
    name: nb.name,
    tags: [...nb.tags],
    rev: nb.rev,
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
    sections: sections.map(shapeSection),
    pages,
  };
}

function shapeSummary(nb) {
  return {
    id: nb.id,
    name: nb.name,
    tags: [...nb.tags],
    rev: nb.rev,
    updatedAt: nb.updatedAt,
    sectionCount: nb.sectionIds.length,
    pageCount: Object.keys(nb.pages).length,
  };
}

// ---- reads ----

function listNotebooks() {
  return Object.values(store.notebooks)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(shapeSummary);
}

function getNotebook(nbId) {
  const nb = store.notebooks[nbId];
  return nb ? shapeNotebook(nb) : undefined;
}

function getPage(nbId, pageId) {
  const nb = store.notebooks[nbId];
  if (!nb) return undefined;
  const page = nb.pages[pageId];
  return page ? shapePageContent(nb, page) : undefined;
}

// Case-insensitive substring over page titles + bodies (D2 note: reads N body
// files). Returns [{notebookId, notebookName, sectionId, pageId, title, snippet}].
function search(q, { limit = 20 } = {}) {
  const needle = String(q ?? "").toLowerCase();
  const cap = Math.max(1, Math.min(Number(limit) || 20, 100));
  const out = [];
  if (!needle) return out;
  for (const nb of Object.values(store.notebooks)) {
    for (const sec of orderedSections(nb)) {
      for (const pid of sec.pageIds) {
        const page = nb.pages[pid];
        if (!page) continue;
        const title = page.title || "";
        const body = readPageBody(pid);
        const hayTitle = title.toLowerCase();
        const hayBody = body.toLowerCase();
        if (!hayTitle.includes(needle) && !hayBody.includes(needle)) continue;
        out.push({
          notebookId: nb.id,
          notebookName: nb.name,
          sectionId: sec.id,
          pageId: pid,
          title,
          snippet: makeSnippet(title, body, hayTitle, hayBody, needle),
        });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

// A short context window around the first match. Prefers the body; falls back to
// the title when the match is title-only. Whitespace-collapsed, ellipsised.
function makeSnippet(title, body, hayTitle, hayBody, needle) {
  const bi = hayBody.indexOf(needle);
  if (bi >= 0) {
    const start = Math.max(0, bi - 40);
    const end = Math.min(body.length, bi + needle.length + 40);
    let s = body.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) s = `…${s}`;
    if (end < body.length) s = `${s}…`;
    return s;
  }
  // Title-only match.
  void hayTitle;
  return title.replace(/\s+/g, " ").trim();
}

// ---- notebook mutators (synchronous => atomic; each persists) ----

// Seeds one section "Notes" + one empty page "Untitled page" (OneNote-like
// first-open).
function createNotebook({ name, tags = [] } = {}) {
  if (!name || typeof name !== "string")
    throw err("bad_request", "name required");
  const ts = now();
  const nb = {
    id: newId("nb"),
    name,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
    sectionIds: [],
    sections: {},
    pages: {},
  };
  const sec = {
    id: newId("sec"),
    name: "Notes",
    pageIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
  const page = {
    id: newId("pg"),
    title: "Untitled page",
    tags: [],
    parentId: null,
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  // D2 create order: body first, then splice into the tree.
  writePageBody(page.id, "");
  nb.sections[sec.id] = sec;
  nb.sectionIds.push(sec.id);
  nb.pages[page.id] = page;
  sec.pageIds.push(page.id);
  store.notebooks[nb.id] = nb;
  persist();
  return shapeNotebook(nb);
}

function updateNotebook(nbId, { name, tags } = {}) {
  const nb = requireNotebook(nbId);
  if (name !== undefined) {
    if (!name || typeof name !== "string")
      throw err("bad_request", "name must be a non-empty string");
    nb.name = name;
  }
  if (tags !== undefined)
    nb.tags = Array.isArray(tags) ? tags.map(String) : nb.tags;
  touch(nb); // structural rev
  persist();
  return shapeNotebook(nb);
}

function deleteNotebook(nbId) {
  const nb = store.notebooks[nbId];
  if (!nb) return false;
  const pageIds = Object.keys(nb.pages);
  delete store.notebooks[nbId];
  persist(); // tree first
  for (const pid of pageIds) unlinkPageBody(pid); // then bodies (D2)
  return true;
}

// ---- section mutators ----

function createSection(nbId, { name } = {}) {
  const nb = requireNotebook(nbId);
  if (!name || typeof name !== "string")
    throw err("bad_request", "section name required");
  const ts = now();
  const sec = {
    id: newId("sec"),
    name,
    pageIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
  nb.sections[sec.id] = sec;
  nb.sectionIds.push(sec.id);
  touch(nb); // structural rev
  persist();
  return shapeNotebook(nb);
}

function updateSection(nbId, secId, { name } = {}) {
  const nb = requireNotebook(nbId);
  const sec = nb.sections[secId];
  if (!sec) throw err("not_found", "section not found");
  if (name !== undefined) {
    if (!name || typeof name !== "string")
      throw err("bad_request", "section name must be a non-empty string");
    sec.name = name;
    sec.updatedAt = now();
  }
  touch(nb); // structural rev
  persist();
  return shapeNotebook(nb);
}

// Reorder a section. `expectedRev` is the NOTEBOOK rev (D3) — a mismatch is a
// structural stale conflict.
function moveSection(nbId, secId, { toIndex, expectedRev } = {}) {
  const nb = requireNotebook(nbId);
  if (expectedRev !== undefined && expectedRev !== nb.rev)
    throw err("stale", "notebook revision is stale", {
      notebook: shapeNotebook(nb),
    });
  const from = nb.sectionIds.indexOf(secId);
  if (from < 0) throw err("not_found", "section not found");
  const [id] = nb.sectionIds.splice(from, 1);
  const idx = Math.max(0, Math.min(Number(toIndex) || 0, nb.sectionIds.length));
  nb.sectionIds.splice(idx, 0, id);
  touch(nb);
  persist();
  return shapeNotebook(nb);
}

// "block" (default) — refuse a non-empty section with coded "not_empty" (-> 422).
// "cascade" — delete the section's pages + their body files.
function deleteSection(nbId, secId, { mode = "block" } = {}) {
  const nb = requireNotebook(nbId);
  const sec = nb.sections[secId];
  if (!sec) throw err("not_found", "section not found");
  if (sec.pageIds.length > 0 && mode !== "cascade")
    throw err(
      "not_empty",
      `section "${sec.name}" still has ${sec.pageIds.length} page(s)`,
    );
  const pageIds = [...sec.pageIds];
  // Tree first (D2).
  delete nb.sections[secId];
  const si = nb.sectionIds.indexOf(secId);
  if (si >= 0) nb.sectionIds.splice(si, 1);
  for (const pid of pageIds) delete nb.pages[pid];
  touch(nb); // structural rev
  persist();
  // Then bodies.
  for (const pid of pageIds) unlinkPageBody(pid);
  return true;
}

// ---- page mutators ----

// D2 order: write the body file THEN splice the id into section.pageIds.
// `parentId` (optional) sets a containment edge; the new page joins the parent's
// section and is spliced in right after the parent's subtree. `parentId` is
// cycle-checked (mirrors src/pm.js).
function createPage(nbId, { sectionId, title, parentId, body } = {}) {
  const nb = requireNotebook(nbId);

  let parent = null;
  if (parentId != null) {
    parent = nb.pages[String(parentId)];
    if (!parent) throw err("not_found", "parent page not found");
  }

  let section;
  if (parent) {
    section = sectionOfPage(nb, parent.id);
    if (!section) throw err("not_found", "parent page is not in any section");
    if (sectionId != null && String(sectionId) !== section.id)
      throw err("bad_request", "sectionId does not match the parent's section");
  } else {
    if (sectionId == null) throw err("bad_request", "sectionId required");
    section = nb.sections[String(sectionId)];
    if (!section) throw err("not_found", "section not found");
  }

  const id = newId("pg");
  // Cycle check (a fresh id has no descendants, so this only ever trips on a
  // genuinely impossible input — kept to mirror src/pm.js exactly).
  if (parent && wouldParentCycle(nb, id, parent.id))
    throw err("cycle", "parent cycle");

  const ts = now();
  const page = {
    id,
    title: typeof title === "string" && title ? title : "Untitled page",
    tags: [],
    parentId: parent ? parent.id : null,
    rev: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  // D2: body first...
  writePageBody(id, typeof body === "string" ? body : "");
  // ...then the tree.
  nb.pages[id] = page;
  const insertAt = parent
    ? subtreeEndIndex(nb, section, parent.id)
    : section.pageIds.length;
  section.pageIds.splice(insertAt, 0, id);
  touch(nb); // structural rev
  persist();
  return shapePageContent(nb, page, section.id);
}

// Per-page rev optimistic concurrency. D2: bump page.rev in the tree + persist
// FIRST, THEN write the body file — fail toward a FALSE CONFLICT, never a false
// accept. A stale expectedRev throws coded "stale" carrying the current page
// (body included); the route layer maps that to 409 and NO client auto-retries
// it (D4).
function updatePage(nbId, pageId, { title, body, tags, expectedRev } = {}) {
  const nb = requireNotebook(nbId);
  const page = nb.pages[pageId];
  if (!page) throw err("not_found", "page not found");
  if (expectedRev !== undefined && expectedRev !== page.rev)
    throw err("stale", "page revision is stale", {
      page: shapePageContent(nb, page),
    });
  if (title === undefined && body === undefined && tags === undefined)
    throw err("bad_request", "nothing to update");
  if (title !== undefined) {
    if (!title || typeof title !== "string")
      throw err("bad_request", "title must be a non-empty string");
    page.title = title;
  }
  if (tags !== undefined)
    page.tags = Array.isArray(tags) ? tags.map(String) : page.tags;
  page.rev += 1;
  page.updatedAt = now();
  // Tree (with the bumped rev) is committed BEFORE the body write.
  persist();
  if (body !== undefined) writePageBody(pageId, body);
  return shapePageContent(nb, page);
}

// Server-atomic + additive: read body, append "\n\n"+markdown, write, bump
// page.rev. NO expectedRev — an append cannot clobber (D9). Same D2 ordering:
// rev bump + persist precede the body write.
function appendToPage(nbId, pageId, { markdown } = {}) {
  const nb = requireNotebook(nbId);
  const page = nb.pages[pageId];
  if (!page) throw err("not_found", "page not found");
  if (typeof markdown !== "string" || markdown.length === 0)
    throw err("bad_request", "markdown required");
  const existing = readPageBody(pageId);
  const next = existing ? `${existing}\n\n${markdown}` : markdown;
  page.rev += 1;
  page.updatedAt = now();
  persist();
  writePageBody(pageId, next);
  return shapePageContent(nb, page);
}

// Move a page AND its whole transitive subtree as ONE contiguous run in
// pageIds[] (D5). `toParentId` (optional) is cycle-checked. `expectedRev` is the
// NOTEBOOK rev — a mismatch is a structural stale conflict. Returns the notebook.
function movePage(
  nbId,
  pageId,
  { toSectionId, toIndex, toParentId, expectedRev } = {},
) {
  const nb = requireNotebook(nbId);
  if (expectedRev !== undefined && expectedRev !== nb.rev)
    throw err("stale", "notebook revision is stale", {
      notebook: shapeNotebook(nb),
    });
  const page = nb.pages[pageId];
  if (!page) throw err("not_found", "page not found");
  const source = sectionOfPage(nb, pageId);
  if (!source) throw err("not_found", "page is not in any section");
  const target =
    toSectionId != null ? nb.sections[String(toSectionId)] : source;
  if (!target) throw err("not_found", "target section not found");

  const moving = collectSubtreeInOrder(nb, source, pageId);
  const movingSet = new Set(moving);

  let newParentId = null;
  if (toParentId != null) {
    newParentId = String(toParentId);
    if (movingSet.has(newParentId))
      throw err("cycle", "cannot move a page under itself or its own subtree");
    if (!nb.pages[newParentId])
      throw err("not_found", "target parent not found");
    if (!target.pageIds.includes(newParentId))
      throw err("bad_request", "target parent is not in the target section");
    if (wouldParentCycle(nb, pageId, newParentId))
      throw err("cycle", "parent cycle");
  }

  // Splice the run out of the source section.
  for (const id of moving) {
    const i = source.pageIds.indexOf(id);
    if (i >= 0) source.pageIds.splice(i, 1);
  }
  // Reparent the moved root only; descendants keep their parentId.
  page.parentId = newParentId;
  // Clamp the destination index into the target section (post-removal length)
  // and splice the run back in as one contiguous block.
  const idx = Math.max(
    0,
    Math.min(Number(toIndex) || 0, target.pageIds.length),
  );
  target.pageIds.splice(idx, 0, ...moving);

  touch(nb); // structural rev
  persist();
  return shapeNotebook(nb);
}

// "orphan" (default) — promote direct children: a child's parentId becomes the
// deleted page's parentId. "cascade" — delete the whole subtree. D2 order:
// splice out of the tree THEN unlink the body file(s).
function deletePage(nbId, pageId, { mode = "orphan" } = {}) {
  const nb = requireNotebook(nbId);
  const page = nb.pages[pageId];
  if (!page) throw err("not_found", "page not found");
  const section = sectionOfPage(nb, pageId);

  let toUnlink;
  if (mode === "cascade") {
    const subtree = section
      ? collectSubtreeInOrder(nb, section, pageId)
      : [pageId];
    for (const id of subtree) {
      delete nb.pages[id];
      if (section) {
        const i = section.pageIds.indexOf(id);
        if (i >= 0) section.pageIds.splice(i, 1);
      }
    }
    toUnlink = subtree;
  } else {
    const grandParentId = page.parentId ?? null;
    for (const p of Object.values(nb.pages)) {
      if ((p.parentId ?? null) === pageId) p.parentId = grandParentId;
    }
    delete nb.pages[pageId];
    if (section) {
      const i = section.pageIds.indexOf(pageId);
      if (i >= 0) section.pageIds.splice(i, 1);
    }
    toUnlink = [pageId];
  }
  touch(nb); // structural rev
  persist();
  for (const id of toUnlink) unlinkPageBody(id);
  return true;
}

load();

export default {
  load,
  listNotebooks,
  getNotebook,
  getPage,
  search,
  createNotebook,
  updateNotebook,
  deleteNotebook,
  createSection,
  updateSection,
  moveSection,
  deleteSection,
  createPage,
  updatePage,
  appendToPage,
  movePage,
  deletePage,
};
