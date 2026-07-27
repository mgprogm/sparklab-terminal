// Kanban REST integration test — proves /api/kanban/* against a real gateway
// with a temp KANBAN_FILE sidecar (no tmux involved; Kanban is gateway-global).
//
// Covers: board create (default 4 columns) / list summaries / get; card add
// with derived columnId; MOVE splice semantics (cross-column + same-column
// reorder, exact cardIds order, rev bump); optimistic concurrency (stale rev ->
// 409 + current board, fresh rev -> 200); concurrent writes don't lose/dup a
// card (synchronous mutators serialize); card edit + delete; board rename +
// delete; CSRF (foreign Origin -> 403 on writes, GET exempt); scoped bearer
// token (valid -> 200 without cookie, bad -> 401); and 404s / validation.
// Runs with AUTH ENABLED like the git/fs endpoint tests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3993;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "kbuser";
const AUTH_PASS = "kbpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "http://evil.example.com";
const API_TOKEN = "kb-test-token-abc123";

let server;
let cookie = "";
let kanbanFile = "";

function startServer() {
  return new Promise((resolve, reject) => {
    kanbanFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kanban-endpoints-")),
      "kanban.json",
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
        KANBAN_FILE: kanbanFile,
        KANBAN_API_TOKEN: API_TOKEN,
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
    if (kanbanFile)
      fs.rmSync(path.dirname(kanbanFile), { recursive: true, force: true });
  } catch {}
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
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

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT} (auth enabled, temp KANBAN_FILE)`);
  await login();
  console.log("logged in; cookie captured");

  // --- create board (default 4 columns) ---------------------------------
  let board;
  {
    const res = await req("POST", "/api/kanban/boards", {
      body: { name: "Checkout revamp", tags: ["frontend", "q3"] },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `create board -> ${res.status}, expected 201`);
    board = await res.json();
    assert(/^kb-/.test(board.id), `board id should start kb-, got ${board.id}`);
    assert(board.name === "Checkout revamp", "board name mismatch");
    assert(board.rev === 1, `new board rev=${board.rev}, expected 1`);
    assert(
      board.columns.length === 4,
      `expected 4 default columns, got ${board.columns.length}`,
    );
    assert(
      board.columns[0].name === "Backlog",
      "first column should be Backlog",
    );
    assert(
      Array.isArray(board.cards) && board.cards.length === 0,
      "new board should have no cards",
    );
    console.log(`  ok: create board -> ${board.id} (4 columns, rev 1)`);
  }
  const backlog = board.columns[0].id;
  const inProgress = board.columns[2].id;

  // --- list summaries ----------------------------------------------------
  {
    const res = await req("GET", "/api/kanban/boards");
    assert(res.status === 200, `list -> ${res.status}`);
    const j = await res.json();
    const row = j.boards.find((b) => b.id === board.id);
    assert(row, "created board missing from list");
    assert(
      row.columnCount === 4 && row.cardCount === 0,
      "summary counts wrong",
    );
    console.log(`  ok: list boards -> summary columnCount=4 cardCount=0`);
  }

  // --- add three cards to Backlog ---------------------------------------
  const cardIds = [];
  for (const title of ["c1", "c2", "c3"]) {
    const res = await req("POST", `/api/kanban/boards/${enc(board.id)}/cards`, {
      body: { title, columnId: backlog },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `add card ${title} -> ${res.status}`);
    const card = await res.json();
    assert(
      card.columnId === backlog,
      `card ${title} columnId should be backlog`,
    );
    cardIds.push(card.id);
  }
  console.log(`  ok: added 3 cards to Backlog`);

  // --- get board: Backlog order is [c1,c2,c3] ---------------------------
  {
    const res = await req("GET", `/api/kanban/boards/${enc(board.id)}`);
    assert(res.status === 200, `get -> ${res.status}`);
    const b = await res.json();
    const col = b.columns.find((c) => c.id === backlog);
    assert(
      JSON.stringify(col.cardIds) === JSON.stringify(cardIds),
      `Backlog order ${JSON.stringify(col.cardIds)} != ${JSON.stringify(cardIds)}`,
    );
    board = b;
  }

  // --- MOVE c1 -> In Progress @0 (cross-column) -------------------------
  {
    const res = await req("POST", `/api/kanban/cards/${enc(cardIds[0])}/move`, {
      body: {
        boardId: board.id,
        toColumnId: inProgress,
        toIndex: 0,
        rev: board.rev,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `move -> ${res.status}, expected 200`);
    const b = await res.json();
    const bl = b.columns.find((c) => c.id === backlog).cardIds;
    const ip = b.columns.find((c) => c.id === inProgress).cardIds;
    assert(
      JSON.stringify(bl) === JSON.stringify([cardIds[1], cardIds[2]]),
      `Backlog after move: ${JSON.stringify(bl)}`,
    );
    assert(
      JSON.stringify(ip) === JSON.stringify([cardIds[0]]),
      `In Progress after move: ${JSON.stringify(ip)}`,
    );
    assert(
      b.rev === board.rev + 1,
      `rev should bump, got ${b.rev} from ${board.rev}`,
    );
    board = b;
    console.log(`  ok: move c1 -> In Progress; splice correct; rev bumped`);
  }

  // --- stale move -> 409 + current board --------------------------------
  {
    const res = await req("POST", `/api/kanban/cards/${enc(cardIds[1])}/move`, {
      body: {
        boardId: board.id,
        toColumnId: inProgress,
        toIndex: 0,
        rev: board.rev - 1,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 409, `stale move -> ${res.status}, expected 409`);
    const j = await res.json();
    assert(
      j.error === "stale" && j.board && j.board.rev === board.rev,
      "409 should carry current board",
    );
    console.log(`  ok: stale rev move -> 409 (+ current board)`);
  }

  // --- same-column reorder: move c3 to Backlog index 0 ------------------
  {
    const res = await req("POST", `/api/kanban/cards/${enc(cardIds[2])}/move`, {
      body: {
        boardId: board.id,
        toColumnId: backlog,
        toIndex: 0,
        rev: board.rev,
      },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `reorder -> ${res.status}`);
    const b = await res.json();
    const bl = b.columns.find((c) => c.id === backlog).cardIds;
    assert(
      JSON.stringify(bl) === JSON.stringify([cardIds[2], cardIds[1]]),
      `reordered Backlog: ${JSON.stringify(bl)}`,
    );
    board = b;
    console.log(`  ok: same-column reorder -> [c3,c2]`);
  }

  // --- edit card ---------------------------------------------------------
  {
    const res = await req("PATCH", `/api/kanban/cards/${enc(cardIds[1])}`, {
      body: { boardId: board.id, title: "c2-edited", description: "hello" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `edit card -> ${res.status}`);
    const card = await res.json();
    assert(
      card.title === "c2-edited" && card.description === "hello",
      "card edit not applied",
    );
    console.log(`  ok: edit card title/description`);
  }

  // --- delete card (via ?boardId=) -> 204 -------------------------------
  {
    const res = await req(
      "DELETE",
      `/api/kanban/cards/${enc(cardIds[2])}?boardId=${enc(board.id)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 204, `delete card -> ${res.status}, expected 204`);
    const g = await (
      await req("GET", `/api/kanban/boards/${enc(board.id)}`)
    ).json();
    assert(
      !g.cards.some((c) => c.id === cardIds[2]),
      "deleted card still present",
    );
    board = g;
    console.log(`  ok: delete card -> 204, gone from board`);
  }

  // --- concurrent adds don't lose/dup a card ----------------------------
  {
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        req("POST", `/api/kanban/boards/${enc(board.id)}/cards`, {
          body: { title: `conc-${i}`, columnId: backlog },
          origin: ALLOWED_ORIGIN,
        }),
      ),
    );
    assert(
      results.every((r) => r.status === 201),
      "a concurrent add did not return 201",
    );
    const b = await (
      await req("GET", `/api/kanban/boards/${enc(board.id)}`)
    ).json();
    const titles = b.cards
      .map((c) => c.title)
      .filter((t) => t.startsWith("conc-"));
    const unique = new Set(titles);
    assert(
      titles.length === N && unique.size === N,
      `expected ${N} unique concurrent cards, got ${titles.length}/${unique.size}`,
    );
    // Every card id appears exactly once across all columns.
    const allIds = b.columns.flatMap((c) => c.cardIds);
    assert(
      new Set(allIds).size === allIds.length,
      "a card id is duplicated across columns",
    );
    console.log(
      `  ok: ${N} concurrent adds -> all present, none lost/duplicated`,
    );
  }

  // --- rename board ------------------------------------------------------
  {
    const res = await req("PATCH", `/api/kanban/boards/${enc(board.id)}`, {
      body: { name: "Checkout v2", tags: ["frontend"] },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `rename board -> ${res.status}`);
    const b = await res.json();
    assert(b.name === "Checkout v2", "board rename not applied");
    console.log(`  ok: rename board`);
  }

  // --- CSRF: foreign Origin -> 403 on write; GET exempt -----------------
  {
    const w = await req("POST", "/api/kanban/boards", {
      body: { name: "nope" },
      origin: FOREIGN_ORIGIN,
    });
    assert(
      w.status === 403,
      `foreign-origin write -> ${w.status}, expected 403`,
    );
    const g = await req("GET", "/api/kanban/boards", {
      origin: FOREIGN_ORIGIN,
    });
    assert(
      g.status === 200,
      `foreign-origin GET -> ${g.status}, expected 200 (exempt)`,
    );
    console.log(`  ok: CSRF -> write 403, GET exempt`);
  }

  // --- bearer token: valid without cookie -> 200; bad -> 401 ------------
  {
    const ok = await req("GET", "/api/kanban/boards", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert(
      ok.status === 200,
      `valid bearer (no cookie) -> ${ok.status}, expected 200`,
    );
    // Bearer can also write (POST, no Origin header -> CSRF guard is a no-op).
    const created = await req("POST", "/api/kanban/boards", {
      cookie: false,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      body: { name: "via-cli" },
    });
    assert(
      created.status === 201,
      `bearer write -> ${created.status}, expected 201`,
    );
    const bad = await req("GET", "/api/kanban/boards", {
      cookie: false,
      headers: { authorization: `Bearer wrong-token` },
    });
    assert(bad.status === 401, `bad bearer -> ${bad.status}, expected 401`);
    const none = await req("GET", "/api/kanban/boards", { cookie: false });
    assert(none.status === 401, `no auth -> ${none.status}, expected 401`);
    console.log(`  ok: bearer token -> valid 200/201, bad 401, none 401`);
  }

  // --- validation + 404s -------------------------------------------------
  {
    const noName = await req("POST", "/api/kanban/boards", {
      body: {},
      origin: ALLOWED_ORIGIN,
    });
    assert(
      noName.status === 400,
      `create w/o name -> ${noName.status}, expected 400`,
    );
    const missing = await req("GET", "/api/kanban/boards/kb-does-not-exist");
    assert(
      missing.status === 404,
      `unknown board -> ${missing.status}, expected 404`,
    );
    // No rev -> skips the staleness gate so we exercise the not-found path.
    const badMove = await req("POST", `/api/kanban/cards/nope/move`, {
      body: { boardId: board.id, toColumnId: "col-nope", toIndex: 0 },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      badMove.status === 404,
      `move unknown card -> ${badMove.status}, expected 404`,
    );
    console.log(`  ok: validation 400 + 404s`);
  }

  // --- delete board -> 204, then 404 ------------------------------------
  {
    const res = await req("DELETE", `/api/kanban/boards/${enc(board.id)}`, {
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 204, `delete board -> ${res.status}, expected 204`);
    const g = await req("GET", `/api/kanban/boards/${enc(board.id)}`);
    assert(g.status === 404, `deleted board get -> ${g.status}, expected 404`);
    console.log(`  ok: delete board -> 204, then 404`);
  }

  console.log("\nPASS: kanban-endpoints (16 checks)");
  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
