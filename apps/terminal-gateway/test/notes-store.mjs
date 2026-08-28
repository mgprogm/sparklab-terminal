// Notes store self-test — exercises apps/terminal-gateway/src/notes.js directly
// (no gateway, no HTTP; the split tree/body store is the unit under test).
//
// Repo convention (mirrors test/*.js): real calls, plain `throw` asserts,
// PASS/FAIL per check, non-zero exit on any failure. A fresh NOTES_FILE +
// NOTES_PAGES_DIR temp dir is created BEFORE importing notes.js so its
// module-bottom load() targets the sandbox.
//
// Covers: notebook/section/page CRUD; the seeded section + page; getNotebook
// derived sectionId/depth; D2 update write-order (stale updatePage -> "stale",
// fresh accepted, body changes only after the rev bump is persisted — proven by
// sabotaging the body write and showing the old rev is then rejected);
// structural "stale" on movePage with a bad notebook rev; parentId cycle ->
// "cycle"; subtree contiguity on movePage; deletePage orphan vs cascade;
// deleteSection block ("not_empty") vs cascade; appendToPage additive over two
// sequential appends; search substring + snippet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notes-store-"));
const NOTES_FILE = path.join(TMP, "notes.json");
const PAGES_DIR = path.join(TMP, "notes-pages");
process.env.NOTES_FILE = NOTES_FILE;
process.env.NOTES_PAGES_DIR = PAGES_DIR;

const notes = (await import("../src/notes.js")).default;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`FAIL ${name}: ${e && e.stack ? e.stack : e}`);
    failed += 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function expectCode(fn, code, msg) {
  try {
    fn();
  } catch (e) {
    assert(
      e.code === code,
      `${msg || "wrong error"}: expected code ${code}, got ${e.code} (${e.message})`,
    );
    return e;
  }
  throw new Error(
    `${msg || "expected throw"}: expected a throw with code ${code}, got none`,
  );
}
function bodyPath(pageId) {
  return path.join(PAGES_DIR, `${pageId}.md`);
}

// --------------------------------------------------------------------------

check(
  "createNotebook seeds one 'Notes' section + one empty 'Untitled page'",
  () => {
    const nb = notes.createNotebook({ name: "Engineering", tags: ["work"] });
    assert(nb.id.startsWith("nb-"), "notebook id prefix");
    assert(nb.name === "Engineering", "name");
    assert(nb.rev === 1, "initial rev 1");
    assert(nb.sections.length === 1, "one section");
    assert(nb.sections[0].name === "Notes", "section name 'Notes'");
    assert(nb.sections[0].id.startsWith("sec-"), "section id prefix");
    assert(nb.pages.length === 1, "one page");
    assert(nb.pages[0].title === "Untitled page", "page title");
    assert(nb.pages[0].id.startsWith("pg-"), "page id prefix");
    assert(nb.pages[0].rev === 1, "page rev 1");
    assert(nb.pages[0].parentId === null, "page parentId null");
    assert(
      nb.sections[0].pageIds[0] === nb.pages[0].id,
      "page is in section.pageIds",
    );
    const pc = notes.getPage(nb.id, nb.pages[0].id);
    assert(pc.body === "", "seeded body empty");
    assert(
      fs.existsSync(bodyPath(nb.pages[0].id)),
      "seeded body .md file exists",
    );
  },
);

check("listNotebooks returns summaries with section/page counts", () => {
  const nb = notes.createNotebook({ name: "Summ" });
  const row = notes.listNotebooks().find((r) => r.id === nb.id);
  assert(row, "notebook present in list");
  assert(row.sectionCount === 1, "sectionCount 1");
  assert(row.pageCount === 1, "pageCount 1");
  assert(Array.isArray(row.tags), "tags array");
  assert(typeof row.updatedAt === "number", "updatedAt number");
});

check(
  "notebook / section CRUD (rename + create + delete) bumps structural rev",
  () => {
    const nb0 = notes.createNotebook({ name: "CRUD" });
    const r0 = nb0.rev;
    const nb1 = notes.updateNotebook(nb0.id, { name: "CRUD-2", tags: ["x"] });
    assert(nb1.name === "CRUD-2" && nb1.tags[0] === "x", "notebook renamed");
    assert(nb1.rev === r0 + 1, "rev bumped on notebook update");
    const nb2 = notes.createSection(nb0.id, { name: "Meetings" });
    assert(nb2.sections.length === 2, "section added");
    assert(nb2.rev === r0 + 2, "rev bumped on section create");
    const secId = nb2.sections[1].id;
    const nb3 = notes.updateSection(nb0.id, secId, { name: "Meetings-2" });
    assert(nb3.sections[1].name === "Meetings-2", "section renamed");
    assert(nb3.rev === r0 + 3, "rev bumped on section rename");
    const ok = notes.deleteSection(nb0.id, secId, {});
    assert(ok === true, "empty section deleted");
    assert(notes.getNotebook(nb0.id).sections.length === 1, "section gone");
    expectCode(
      () => notes.updateNotebook("nb-does-not-exist", { name: "x" }),
      "not_found",
      "unknown notebook",
    );
  },
);

check(
  "page CRUD: create / update title / delete removes tree entry + body file",
  () => {
    const nb = notes.createNotebook({ name: "PageCRUD" });
    const secId = nb.sections[0].id;
    const pg = notes.createPage(nb.id, {
      sectionId: secId,
      title: "Draft",
      body: "hello",
    });
    assert(pg.id.startsWith("pg-"), "page id prefix");
    assert(pg.rev === 1 && pg.body === "hello", "created page rev/body");
    assert(fs.existsSync(bodyPath(pg.id)), "body file written on create");
    const nbAfter = notes.getNotebook(nb.id);
    assert(
      nbAfter.sections[0].pageIds.includes(pg.id),
      "id spliced into pageIds",
    );
    assert(
      nbAfter.pages.some((p) => p.id === pg.id),
      "page in tree",
    );

    const up = notes.updatePage(nb.id, pg.id, {
      title: "Draft-2",
      expectedRev: pg.rev,
    });
    assert(up.title === "Draft-2", "title updated");
    assert(up.rev === pg.rev + 1, "page rev bumped");
    assert(up.body === "hello", "body untouched when body omitted");

    const ok = notes.deletePage(nb.id, pg.id, {});
    assert(ok === true, "deletePage returns true");
    const nbGone = notes.getNotebook(nb.id);
    assert(
      !nbGone.sections[0].pageIds.includes(pg.id),
      "id removed from pageIds",
    );
    assert(!nbGone.pages.some((p) => p.id === pg.id), "page removed from tree");
    assert(!fs.existsSync(bodyPath(pg.id)), "body file unlinked after delete");
  },
);

check("getNotebook derives sectionId + depth from the parentId forest", () => {
  const nb = notes.createNotebook({ name: "Depth" });
  const secId = nb.sections[0].id;
  const p1 = notes.createPage(nb.id, { sectionId: secId, title: "P1" });
  const p2 = notes.createPage(nb.id, {
    sectionId: secId,
    title: "P2",
    parentId: p1.id,
  });
  const p3 = notes.createPage(nb.id, {
    sectionId: secId,
    title: "P3",
    parentId: p2.id,
  });
  const tree = notes.getNotebook(nb.id);
  const byId = Object.fromEntries(tree.pages.map((p) => [p.id, p]));
  assert(byId[p1.id].depth === 0, "p1 depth 0");
  assert(byId[p2.id].depth === 1, "p2 depth 1");
  assert(byId[p3.id].depth === 2, "p3 depth 2");
  assert(byId[p1.id].sectionId === secId, "p1 derived sectionId");
  assert(byId[p3.id].sectionId === secId, "p3 derived sectionId");
  // Render order = section order then pageIds order (parent before child here).
  const order = tree.pages.map((p) => p.id);
  assert(
    order.indexOf(p1.id) < order.indexOf(p2.id),
    "p1 before p2 in render order",
  );
  assert(
    order.indexOf(p2.id) < order.indexOf(p3.id),
    "p2 before p3 in render order",
  );
});

check(
  "D2: updatePage stale rev rejected with 'stale' (current page + body), fresh rev accepted",
  () => {
    const nb = notes.createNotebook({ name: "Rev" });
    const secId = nb.sections[0].id;
    const pg = notes.createPage(nb.id, {
      sectionId: secId,
      title: "T",
      body: "v1",
    });
    // Stale: expectedRev one behind.
    const e = expectCode(
      () =>
        notes.updatePage(nb.id, pg.id, { body: "v2", expectedRev: pg.rev + 5 }),
      "stale",
      "stale updatePage",
    );
    assert(e.details && e.details.page, "stale error carries current page");
    assert(e.details.page.rev === pg.rev, "stale error page rev is current");
    assert(e.details.page.body === "v1", "stale error page carries the body");
    assert(
      notes.getPage(nb.id, pg.id).body === "v1",
      "body unchanged after stale reject",
    );
    // Fresh: correct expectedRev.
    const ok = notes.updatePage(nb.id, pg.id, {
      body: "v2",
      expectedRev: pg.rev,
    });
    assert(ok.rev === pg.rev + 1, "fresh updatePage bumps rev");
    assert(ok.body === "v2", "fresh updatePage writes body");
    assert(notes.getPage(nb.id, pg.id).body === "v2", "persisted body is v2");
  },
);

check(
  "D2: rev bump is PERSISTED before the body write — fail toward a false conflict",
  () => {
    const nb = notes.createNotebook({ name: "WriteOrder" });
    const secId = nb.sections[0].id;
    const pg = notes.createPage(nb.id, {
      sectionId: secId,
      title: "P",
      body: "orig",
    });
    // Sabotage the body write: replace <id>.md with a directory so renameSync fails.
    fs.unlinkSync(bodyPath(pg.id));
    fs.mkdirSync(bodyPath(pg.id));
    let threw = false;
    try {
      notes.updatePage(nb.id, pg.id, { body: "new", expectedRev: pg.rev });
    } catch {
      threw = true;
    }
    assert(threw, "updatePage throws when the body write fails");
    fs.rmdirSync(bodyPath(pg.id)); // clear the sabotage
    // Reload the tree from disk: the bumped rev must already be committed.
    notes.load();
    const after = notes.getPage(nb.id, pg.id);
    assert(
      after.rev === pg.rev + 1,
      `persisted rev should be ${pg.rev + 1}, got ${after.rev}`,
    );
    // A writer still holding the OLD rev is now rejected (never a false accept).
    expectCode(
      () => notes.updatePage(nb.id, pg.id, { body: "x", expectedRev: pg.rev }),
      "stale",
      "old rev after a crashed body write",
    );
    // The fresh rev still works.
    const ok = notes.updatePage(nb.id, pg.id, {
      body: "recovered",
      expectedRev: after.rev,
    });
    assert(ok.body === "recovered", "recovery write succeeds on the fresh rev");
  },
);

check(
  "movePage: structural 'stale' on a bad notebook rev; fresh rev succeeds",
  () => {
    const nb = notes.createNotebook({ name: "MoveRev" });
    const secA = nb.sections[0].id;
    const nb2 = notes.createSection(nb.id, { name: "B" });
    const secB = nb2.sections[1].id;
    const pg = notes.createPage(nb.id, { sectionId: secA, title: "Movable" });
    const cur = notes.getNotebook(nb.id).rev;
    expectCode(
      () =>
        notes.movePage(nb.id, pg.id, {
          toSectionId: secB,
          toIndex: 0,
          expectedRev: cur + 99,
        }),
      "stale",
      "movePage bad notebook rev",
    );
    const moved = notes.movePage(nb.id, pg.id, {
      toSectionId: secB,
      toIndex: 0,
      expectedRev: cur,
    });
    assert(moved.rev === cur + 1, "notebook rev bumped on move");
    const secBrow = moved.sections.find((s) => s.id === secB);
    const secArow = moved.sections.find((s) => s.id === secA);
    assert(secBrow.pageIds.includes(pg.id), "page now in section B");
    assert(!secArow.pageIds.includes(pg.id), "page no longer in section A");
  },
);

check(
  "movePage: parentId cycle -> 'cycle' (moving a page under its own descendant)",
  () => {
    const nb = notes.createNotebook({ name: "Cycle" });
    const secId = nb.sections[0].id;
    const p1 = notes.createPage(nb.id, { sectionId: secId, title: "P1" });
    const p2 = notes.createPage(nb.id, {
      sectionId: secId,
      title: "P2",
      parentId: p1.id,
    });
    const rev = notes.getNotebook(nb.id).rev;
    expectCode(
      () =>
        notes.movePage(nb.id, p1.id, {
          toSectionId: secId,
          toIndex: 0,
          toParentId: p2.id,
          expectedRev: rev,
        }),
      "cycle",
      "move under own child",
    );
    // Self-parent is also a cycle.
    expectCode(
      () =>
        notes.movePage(nb.id, p1.id, {
          toSectionId: secId,
          toIndex: 0,
          toParentId: p1.id,
          expectedRev: rev,
        }),
      "cycle",
      "move under self",
    );
    // createPage with an unknown parent -> not_found (a fresh id can't cycle).
    expectCode(
      () =>
        notes.createPage(nb.id, {
          sectionId: secId,
          title: "X",
          parentId: "pg-nope",
        }),
      "not_found",
      "createPage unknown parent",
    );
  },
);

check(
  "movePage: the whole subtree moves as one contiguous run, order + parentId preserved",
  () => {
    const nb = notes.createNotebook({ name: "Subtree" });
    // Fresh empty sections — the seeded "Notes" section already holds a page.
    const nbA = notes.createSection(nb.id, { name: "A" });
    const secA = nbA.sections[nbA.sections.length - 1].id;
    const nb2 = notes.createSection(nb.id, { name: "B" });
    const secB = nb2.sections[nb2.sections.length - 1].id;
    const p1 = notes.createPage(nb.id, { sectionId: secA, title: "P1" });
    const p2 = notes.createPage(nb.id, {
      sectionId: secA,
      title: "P2",
      parentId: p1.id,
    });
    const p3 = notes.createPage(nb.id, {
      sectionId: secA,
      title: "P3",
      parentId: p1.id,
    });
    const p4 = notes.createPage(nb.id, { sectionId: secA, title: "P4" }); // sibling, not moving
    // secA pageIds now: [p1, p2, p3, p4]
    let tree = notes.getNotebook(nb.id);
    assert(
      JSON.stringify(tree.sections.find((s) => s.id === secA).pageIds) ===
        JSON.stringify([p1.id, p2.id, p3.id, p4.id]),
      "initial secA order",
    );
    const rev = tree.rev;
    tree = notes.movePage(nb.id, p1.id, {
      toSectionId: secB,
      toIndex: 0,
      expectedRev: rev,
    });
    const aIds = tree.sections.find((s) => s.id === secA).pageIds;
    const bIds = tree.sections.find((s) => s.id === secB).pageIds;
    assert(
      JSON.stringify(aIds) === JSON.stringify([p4.id]),
      "secA keeps only the non-moving sibling",
    );
    assert(
      JSON.stringify(bIds) === JSON.stringify([p1.id, p2.id, p3.id]),
      "subtree run contiguous + relative order kept in secB",
    );
    const byId = Object.fromEntries(tree.pages.map((p) => [p.id, p]));
    assert(byId[p1.id].parentId === null, "moved root reparented to null");
    assert(byId[p2.id].parentId === p1.id, "child p2 still under p1");
    assert(byId[p3.id].parentId === p1.id, "child p3 still under p1");
    assert(
      byId[p2.id].sectionId === secB && byId[p3.id].sectionId === secB,
      "children followed into secB",
    );
  },
);

check(
  "deletePage: 'orphan' (default) promotes direct children; 'cascade' removes the whole subtree",
  () => {
    function build() {
      const nb = notes.createNotebook({ name: "Del" });
      // Fresh empty section (the seeded "Notes" section already holds a page).
      const nbS = notes.createSection(nb.id, { name: "Work" });
      const secId = nbS.sections[nbS.sections.length - 1].id;
      const p1 = notes.createPage(nb.id, { sectionId: secId, title: "P1" });
      const p2 = notes.createPage(nb.id, {
        sectionId: secId,
        title: "P2",
        parentId: p1.id,
      });
      const p3 = notes.createPage(nb.id, {
        sectionId: secId,
        title: "P3",
        parentId: p1.id,
      });
      const p4 = notes.createPage(nb.id, {
        sectionId: secId,
        title: "P4",
        parentId: p2.id,
      });
      return { nb, secId, p1, p2, p3, p4 };
    }
    // orphan
    {
      const { nb, secId, p1, p2, p3, p4 } = build();
      notes.deletePage(nb.id, p1.id, { mode: "orphan" });
      const tree = notes.getNotebook(nb.id);
      const byId = Object.fromEntries(tree.pages.map((p) => [p.id, p]));
      assert(!byId[p1.id], "p1 gone");
      assert(
        byId[p2.id].parentId === null,
        "p2 promoted to p1's parentId (null)",
      );
      assert(byId[p3.id].parentId === null, "p3 promoted to null");
      assert(byId[p4.id].parentId === p2.id, "grandchild p4 still under p2");
      assert(!fs.existsSync(bodyPath(p1.id)), "p1 body unlinked");
      assert(fs.existsSync(bodyPath(p2.id)), "p2 body kept");
      assert(
        !tree.sections.find((s) => s.id === secId).pageIds.includes(p1.id),
        "p1 out of pageIds",
      );
    }
    // cascade
    {
      const { nb, secId, p1, p2, p3, p4 } = build();
      notes.deletePage(nb.id, p1.id, { mode: "cascade" });
      const tree = notes.getNotebook(nb.id);
      for (const p of [p1, p2, p3, p4]) {
        assert(
          !tree.pages.some((x) => x.id === p.id),
          `${p.title} removed from tree`,
        );
        assert(!fs.existsSync(bodyPath(p.id)), `${p.title} body unlinked`);
      }
      assert(
        tree.sections.find((s) => s.id === secId).pageIds.length === 0,
        "section emptied",
      );
    }
  },
);

check(
  "deleteSection: 'block' (default) -> 'not_empty' on a non-empty section; 'cascade' removes pages + bodies",
  () => {
    const nb = notes.createNotebook({ name: "SecDel" });
    const nb2 = notes.createSection(nb.id, { name: "Trash" });
    const secId = nb2.sections[1].id;
    const pg = notes.createPage(nb.id, {
      sectionId: secId,
      title: "doomed",
      body: "bye",
    });
    expectCode(
      () => notes.deleteSection(nb.id, secId, {}),
      "not_empty",
      "block on non-empty",
    );
    expectCode(
      () => notes.deleteSection(nb.id, secId, { mode: "block" }),
      "not_empty",
      "explicit block on non-empty",
    );
    assert(
      notes.getNotebook(nb.id).sections.some((s) => s.id === secId),
      "section still there after block",
    );
    const ok = notes.deleteSection(nb.id, secId, { mode: "cascade" });
    assert(ok === true, "cascade returns true");
    const tree = notes.getNotebook(nb.id);
    assert(
      !tree.sections.some((s) => s.id === secId),
      "section gone after cascade",
    );
    assert(
      !tree.pages.some((p) => p.id === pg.id),
      "section's page gone after cascade",
    );
    assert(!fs.existsSync(bodyPath(pg.id)), "page body unlinked after cascade");
  },
);

check(
  "appendToPage: additive over two sequential appends, no rev arg, page.rev bumps each time",
  () => {
    const nb = notes.createNotebook({ name: "Append" });
    const secId = nb.sections[0].id;
    const pg = notes.createPage(nb.id, {
      sectionId: secId,
      title: "Journal",
      body: "start",
    });
    const a1 = notes.appendToPage(nb.id, pg.id, { markdown: "- entry one" });
    assert(a1.rev === pg.rev + 1, "rev bumped after first append");
    assert(
      a1.body === "start\n\n- entry one",
      "first append concatenated with blank line",
    );
    const a2 = notes.appendToPage(nb.id, pg.id, { markdown: "- entry two" });
    assert(a2.rev === pg.rev + 2, "rev bumped after second append");
    assert(
      a2.body === "start\n\n- entry one\n\n- entry two",
      "second append is additive, order preserved",
    );
    assert(
      notes.getPage(nb.id, pg.id).body === a2.body,
      "persisted body matches",
    );
    // Append onto an empty body: no leading blank line.
    const empty = notes.createPage(nb.id, { sectionId: secId, title: "Fresh" });
    const ae = notes.appendToPage(nb.id, empty.id, { markdown: "first line" });
    assert(
      ae.body === "first line",
      "append onto empty body has no leading newlines",
    );
  },
);

check(
  "search: case-insensitive substring over title + body, with a snippet, limit respected",
  () => {
    const nb = notes.createNotebook({ name: "Searchable" });
    const secId = nb.sections[0].id;
    notes.createPage(nb.id, {
      sectionId: secId,
      title: "Deployment runbook",
      body: "The quick brown fox jumps over the lazy dog near the RELEASE gate.",
    });
    notes.createPage(nb.id, {
      sectionId: secId,
      title: "Grocery list",
      body: "milk, eggs, bread",
    });
    notes.createPage(nb.id, {
      sectionId: secId,
      title: "Another BROWN note",
      body: "no match term here",
    });

    const hits = notes.search("brown");
    assert(
      hits.length === 2,
      `expected 2 hits for 'brown', got ${hits.length}`,
    );
    const bodyHit = hits.find((h) => h.title === "Deployment runbook");
    assert(bodyHit, "body match found");
    assert(
      bodyHit.notebookId === nb.id && bodyHit.notebookName === "Searchable",
      "hit carries notebook id/name",
    );
    assert(bodyHit.sectionId === secId, "hit carries sectionId");
    assert(
      bodyHit.pageId && bodyHit.pageId.startsWith("pg-"),
      "hit carries pageId",
    );
    assert(/brown/i.test(bodyHit.snippet), "snippet contains the match");
    assert(!/\n/.test(bodyHit.snippet), "snippet is whitespace-collapsed");
    const titleHit = hits.find((h) => h.title === "Another BROWN note");
    assert(
      titleHit && titleHit.snippet.length > 0,
      "title-only match still yields a snippet",
    );

    // Case-insensitive, and limit.
    assert(
      notes.search("RELEASE").length === 1,
      "uppercase query matches lowercased body region",
    );
    assert(notes.search("").length === 0, "empty query returns nothing");
    notes.createPage(nb.id, {
      sectionId: secId,
      title: "brown extra",
      body: "brown",
    });
    assert(
      notes.search("brown", { limit: 1 }).length === 1,
      "limit:1 respected",
    );
  },
);

check("load(): sweeps orphan .md files the tree no longer references", () => {
  const nb = notes.createNotebook({ name: "Sweep" });
  const secId = nb.sections[0].id;
  const pg = notes.createPage(nb.id, {
    sectionId: secId,
    title: "keep",
    body: "keep me",
  });
  // A body file with no tree reference (simulates a crash after body write,
  // before the tree splice).
  const orphan = path.join(PAGES_DIR, "pg-orphan-xyz.md");
  fs.writeFileSync(orphan, "dangling", "utf8");
  assert(fs.existsSync(orphan), "orphan created");
  notes.load();
  assert(!fs.existsSync(orphan), "orphan .md swept by load()");
  assert(fs.existsSync(bodyPath(pg.id)), "referenced body file kept");
  assert(
    notes.getPage(nb.id, pg.id).body === "keep me",
    "referenced page still intact after load()",
  );
});

// --------------------------------------------------------------------------

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`,
);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1);
