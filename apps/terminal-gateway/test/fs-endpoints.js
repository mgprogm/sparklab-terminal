// File Explorer fs/* integration test — proves the six gateway routes against a
// real gateway + real tmux + a real scratch filesystem on the LOCAL server:
//   GET    /api/sessions/:id/fs/list?path=&showHidden=
//   GET    /api/sessions/:id/fs/read?path=
//   GET    /api/sessions/:id/fs/download?path=
//   POST   /api/sessions/:id/fs/upload?path=      (raw body)
//   POST   /api/sessions/:id/fs/mkdir             ({path})
//   PATCH  /api/sessions/:id/fs/entry             ({from,to,overwrite?})
//   DELETE /api/sessions/:id/fs/entry?path=&recursive=
//
// Runs the gateway with AUTH ENABLED (so the Origin/CSRF check is live — it is
// exempt in open mode) and logs in for a cookie. All requests carry the cookie;
// write requests carry an allowed Origin except the one forbidden-origin probe.
//
// The load-bearing assertion: files named with a space, a single quote, and a
// newline must list, read, and round-trip through upload/download intact — this
// validates NUL-record parsing + single-argv-element quoting end to end.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "fsuser";
const AUTH_PASS = "fspass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const FS_READ_CAP = 256 * 1024;
const FS_UPLOAD_CAP = 8 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let cookie = "";
const createdTmux = [];
let scratch;

function listWebSessions() {
  try {
    const out = execFileSync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      {
        encoding: "utf8",
      },
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("web-"));
  } catch {
    return [];
  }
}

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

// fetch wrapper: always sends the auth cookie; write methods may carry an Origin.
async function req(method, pathname, { body, origin, raw, headers } = {}) {
  const h = { ...(headers || {}) };
  if (cookie) h["cookie"] = cookie;
  if (origin) h["origin"] = origin;
  let payload;
  if (raw !== undefined) {
    payload = raw; // Buffer/Uint8Array raw body (upload)
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${BASE}${pathname}`, { method, headers: h, body: payload });
}

// Encode a session id (may contain "/") as ONE path segment, like real clients.
const enc = (id) => encodeURIComponent(id);
// Encode a filesystem path for a query string.
const qp = (p) => encodeURIComponent(p);

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  if (res.status !== 204) fail(`login returned ${res.status}, expected 204`);
  const setCookie = res.headers.get("set-cookie");
  assert(setCookie, "login did not return a set-cookie header");
  const m = /gw_session=[^;]+/.exec(setCookie);
  assert(m, `set-cookie had no gw_session: ${setCookie}`);
  cookie = m[0];
}

async function main() {
  // --- scratch fixture tree (the local gateway sees the same filesystem) ---
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fs-endpoints-"));
  const P = (name) => path.join(scratch, name);

  const HELLO = "hello world\nsecond line\n";
  fs.writeFileSync(P("hello.txt"), HELLO);
  fs.writeFileSync(P(".dotfile"), "hidden");
  fs.mkdirSync(P("emptydir"));
  fs.mkdirSync(P("fulldir"));
  fs.writeFileSync(path.join(P("fulldir"), "inner.txt"), "inner");
  // Oversized text file: CAP + 100 bytes of 'a'.
  const bigLen = FS_READ_CAP + 100;
  fs.writeFileSync(P("big.txt"), Buffer.alloc(bigLen, 0x61));
  // Binary fixture: full byte range incl. NUL and high bytes.
  const binBytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  fs.writeFileSync(P("data.bin"), binBytes);
  // Oversized binary (a NUL byte early, larger than the read cap): must report
  // binary:true, truncated:false (contract), and omit content.
  const bigBin = Buffer.alloc(FS_READ_CAP + 100, 0x41);
  bigBin[10] = 0x00;
  fs.writeFileSync(P("bigdata.bin"), bigBin);
  // Awkward names (the load-bearing quoting proof).
  const NAME_SPACE = "a file.txt";
  const NAME_QUOTE = "it's-mine.txt";
  const NAME_NL = "line1\nline2.txt";
  const SPACE_CONTENT = "space-content-123\n";
  const QUOTE_CONTENT = "quote-content-456\n";
  const NL_CONTENT = "newline-content-789\n";
  fs.writeFileSync(P(NAME_SPACE), SPACE_CONTENT);
  fs.writeFileSync(P(NAME_QUOTE), QUOTE_CONTENT);
  fs.writeFileSync(P(NAME_NL), NL_CONTENT);

  await startServer();
  console.log(`gateway up on :${PORT} (auth enabled)`);
  await login();
  console.log("logged in; cookie captured");

  // Auth is enforced: no cookie -> 401.
  {
    const res = await fetch(
      `${BASE}/api/sessions/local%2Fweb-x/fs/list?path=${qp(scratch)}`,
    );
    assert(
      res.status === 401,
      `no-cookie fs/list returned ${res.status}, expected 401`,
    );
  }

  // --- create a session rooted at the scratch dir (for the cwd-seed test) ---
  const resCreate = await req("POST", "/api/sessions", {
    body: { name: "fs-endpoints-test", cwd: scratch },
    origin: ALLOWED_ORIGIN,
  });
  assert(
    resCreate.status === 201,
    `POST /api/sessions -> ${resCreate.status}, expected 201`,
  );
  const id = (await resCreate.json()).id;
  const eid = enc(id);
  const tmuxName = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  createdTmux.push(tmuxName);
  console.log(`created session ${id}`);
  await sleep(700); // let the shell settle so pane_current_path is the cwd

  // =====================================================================
  // 1. list — cwd seed (no path param) returns the scratch dir's entries
  // =====================================================================
  {
    const res = await req("GET", `/api/sessions/${eid}/fs/list`);
    assert(
      res.status === 200,
      `fs/list (cwd seed) -> ${res.status}, expected 200`,
    );
    const j = await res.json();
    assert(
      path.resolve(j.path) === path.resolve(scratch),
      `cwd-seed listed "${j.path}", expected "${scratch}"`,
    );
    const names = j.entries.map((e) => e.name);
    assert(names.includes("hello.txt"), "cwd-seed list missing hello.txt");
    assert(
      !names.includes(".dotfile"),
      "cwd-seed list leaked .dotfile (hidden default)",
    );
    console.log(
      `  ok: cwd-seed list resolved ${j.path} (${j.entries.length} entries)`,
    );
  }

  // =====================================================================
  // 2. list — explicit path: types, sizes, mtime-in-ms, hidden filtering
  // =====================================================================
  let listByName = {};
  {
    const res = await req(
      "GET",
      `/api/sessions/${eid}/fs/list?path=${qp(scratch)}`,
    );
    assert(res.status === 200, `fs/list -> ${res.status}, expected 200`);
    const j = await res.json();
    for (const e of j.entries) listByName[e.name] = e;

    const hello = listByName["hello.txt"];
    assert(hello, "list missing hello.txt");
    assert(
      hello.type === "file",
      `hello.txt type=${hello.type}, expected file`,
    );
    assert(
      hello.size === Buffer.byteLength(HELLO),
      `hello.txt size=${hello.size}, expected ${Buffer.byteLength(HELLO)}`,
    );
    assert(
      typeof hello.mode === "string" && /^[0-7]{3,4}$/.test(hello.mode),
      `hello.txt mode="${hello.mode}" is not an octal string`,
    );
    // mtime must be epoch MILLISECONDS (>1e12), not seconds (~1.7e9).
    assert(
      typeof hello.mtime === "number" && hello.mtime > 1e12,
      `hello.txt mtime=${hello.mtime} is not epoch ms (seconds/ms bug?)`,
    );
    assert(
      Math.abs(hello.mtime - Date.now()) < 5 * 60 * 1000,
      `hello.txt mtime=${hello.mtime} not within 5min of now`,
    );

    const ed = listByName["emptydir"];
    assert(ed && ed.type === "dir", "emptydir not listed as dir");
    console.log(`  ok: types/size/mode correct; mtime in ms (${hello.mtime})`);

    // hidden default off already checked; showHidden=1 reveals .dotfile
    const resH = await req(
      "GET",
      `/api/sessions/${eid}/fs/list?path=${qp(scratch)}&showHidden=1`,
    );
    const jH = await resH.json();
    const namesH = jH.entries.map((e) => e.name);
    assert(namesH.includes(".dotfile"), "showHidden=1 did not reveal .dotfile");
    console.log(
      "  ok: hidden-file filtering (off by default, on with showHidden=1)",
    );
  }

  // =====================================================================
  // 3. LOAD-BEARING quoting proof — awkward names list + read intact
  // =====================================================================
  {
    for (const [name, content] of [
      ["a file.txt", SPACE_CONTENT],
      ["it's-mine.txt", QUOTE_CONTENT],
      ["line1\nline2.txt", NL_CONTENT],
    ]) {
      assert(
        Object.prototype.hasOwnProperty.call(listByName, name),
        `awkward name not listed intact: ${JSON.stringify(name)}`,
      );
      const abs = path.join(scratch, name);
      const res = await req(
        "GET",
        `/api/sessions/${eid}/fs/read?path=${qp(abs)}`,
      );
      assert(
        res.status === 200,
        `read ${JSON.stringify(name)} -> ${res.status}, expected 200`,
      );
      const j = await res.json();
      assert(
        j.content === content,
        `read ${JSON.stringify(name)} content mismatch: got ${JSON.stringify(j.content)}`,
      );
    }
    console.log(
      "  ok: space / single-quote / newline names list + read intact",
    );
  }

  // =====================================================================
  // 4. read — text exact, oversized truncated, binary omits content
  // =====================================================================
  {
    const resT = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp(P("hello.txt"))}`,
    );
    const jt = await resT.json();
    assert(jt.binary === false, "hello.txt flagged binary");
    assert(jt.truncated === false, "hello.txt flagged truncated");
    assert(jt.encoding === "utf-8", `hello.txt encoding=${jt.encoding}`);
    assert(jt.content === HELLO, "hello.txt content mismatch");
    assert(jt.size === Buffer.byteLength(HELLO), `hello.txt size=${jt.size}`);

    const resBig = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp(P("big.txt"))}`,
    );
    const jb = await resBig.json();
    assert(jb.truncated === true, "big.txt not flagged truncated");
    assert(jb.size === bigLen, `big.txt size=${jb.size}, expected ${bigLen}`);
    assert(
      Buffer.byteLength(jb.content) === FS_READ_CAP,
      `big.txt content is ${Buffer.byteLength(jb.content)} bytes, expected cap ${FS_READ_CAP}`,
    );

    const resBin = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp(P("data.bin"))}`,
    );
    const jbin = await resBin.json();
    assert(jbin.binary === true, "data.bin not flagged binary");
    assert(
      jbin.encoding === null,
      `data.bin encoding=${jbin.encoding}, expected null`,
    );
    assert(!("content" in jbin), "binary read must omit content");
    assert(jbin.size === binBytes.length, `data.bin size=${jbin.size}`);

    // Oversized binary: binary wins, truncated MUST be false, no content.
    const resBigBin = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp(P("bigdata.bin"))}`,
    );
    const jbb = await resBigBin.json();
    assert(jbb.binary === true, "bigdata.bin not flagged binary");
    assert(
      jbb.truncated === false,
      `bigdata.bin truncated=${jbb.truncated}, contract requires false for binary`,
    );
    assert(!("content" in jbb), "oversized binary read must omit content");
    assert(
      jbb.size === bigBin.length,
      `bigdata.bin size=${jbb.size}, expected ${bigBin.length}`,
    );
    console.log(
      "  ok: read text exact / oversized truncated at cap / binary no-content / oversized-binary truncated:false",
    );

    // reading a directory -> 400
    const resDir = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp(P("emptydir"))}`,
    );
    assert(
      resDir.status === 400,
      `read of a dir -> ${resDir.status}, expected 400`,
    );
  }

  // =====================================================================
  // 5. download — binary bytes round-trip EXACTLY
  // =====================================================================
  {
    const res = await req(
      "GET",
      `/api/sessions/${eid}/fs/download?path=${qp(P("data.bin"))}`,
    );
    assert(res.status === 200, `download -> ${res.status}, expected 200`);
    assert(
      (res.headers.get("content-type") || "").includes(
        "application/octet-stream",
      ),
      `download content-type=${res.headers.get("content-type")}`,
    );
    assert(
      (res.headers.get("content-disposition") || "").includes("attachment"),
      "download missing attachment Content-Disposition",
    );
    const got = Buffer.from(await res.arrayBuffer());
    assert(
      got.equals(binBytes),
      `download bytes differ (got ${got.length}, expected ${binBytes.length})`,
    );
    console.log(
      `  ok: download round-tripped ${got.length} binary bytes exactly`,
    );
  }

  // =====================================================================
  // 6. upload — raw body writes exact bytes to a name WITH A SPACE; cap 413
  // =====================================================================
  {
    const dest = P("uploaded file.bin"); // space in dest name
    const payload = Buffer.from(
      Array.from({ length: 300 }, (_, i) => (i * 7 + 3) % 256),
    );
    const res = await req(
      "POST",
      `/api/sessions/${eid}/fs/upload?path=${qp(dest)}`,
      {
        raw: payload,
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 200, `upload -> ${res.status}, expected 200`);
    const j = await res.json();
    assert(
      j.size === payload.length,
      `upload reported size=${j.size}, expected ${payload.length}`,
    );
    const onDisk = fs.readFileSync(dest);
    assert(
      onDisk.equals(payload),
      "uploaded bytes on disk differ from payload",
    );
    console.log(
      `  ok: upload wrote ${payload.length} exact bytes to a spaced name`,
    );

    // >8MB -> 413
    const tooBig = Buffer.alloc(FS_UPLOAD_CAP + 1024, 0x62);
    const resBig = await req(
      "POST",
      `/api/sessions/${eid}/fs/upload?path=${qp(P("toobig.bin"))}`,
      { raw: tooBig, origin: ALLOWED_ORIGIN },
    );
    assert(
      resBig.status === 413,
      `oversized upload -> ${resBig.status}, expected 413`,
    );
    assert(
      !fs.existsSync(P("toobig.bin")),
      "oversized upload should not have written a file",
    );
    console.log("  ok: upload > 8MB rejected with 413 (no file written)");
  }

  // =====================================================================
  // 7. mkdir — creates (201); re-create -> 409
  // =====================================================================
  {
    const newDir = P("made-dir");
    const res = await req("POST", `/api/sessions/${eid}/fs/mkdir`, {
      body: { path: newDir },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 201, `mkdir -> ${res.status}, expected 201`);
    assert(
      fs.existsSync(newDir) && fs.statSync(newDir).isDirectory(),
      "mkdir did not create the dir",
    );
    const res2 = await req("POST", `/api/sessions/${eid}/fs/mkdir`, {
      body: { path: newDir },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res2.status === 409,
      `mkdir re-create -> ${res2.status}, expected 409`,
    );
    console.log("  ok: mkdir creates (201) and 409s on re-create");
  }

  // =====================================================================
  // 8. rename — moves (200); clobber without overwrite -> 409; with -> 200
  // =====================================================================
  {
    const from = P("rename-src.txt");
    const to = P("rename-dst.txt");
    fs.writeFileSync(from, "RENAME");
    const res = await req("PATCH", `/api/sessions/${eid}/fs/entry`, {
      body: { from, to },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `rename -> ${res.status}, expected 200`);
    assert(
      !fs.existsSync(from) && fs.existsSync(to),
      "rename did not move the file",
    );

    // clobber without overwrite -> 409
    const from2 = P("rename-src2.txt");
    fs.writeFileSync(from2, "SRC2");
    const resClobber = await req("PATCH", `/api/sessions/${eid}/fs/entry`, {
      body: { from: from2, to }, // `to` already exists
      origin: ALLOWED_ORIGIN,
    });
    assert(
      resClobber.status === 409,
      `rename clobber -> ${resClobber.status}, expected 409`,
    );
    assert(
      fs.existsSync(from2),
      "refused rename should have left source in place",
    );

    // with overwrite:true -> 200
    const resOver = await req("PATCH", `/api/sessions/${eid}/fs/entry`, {
      body: { from: from2, to, overwrite: true },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      resOver.status === 200,
      `rename overwrite -> ${resOver.status}, expected 200`,
    );
    assert(
      fs.readFileSync(to, "utf8") === "SRC2",
      "overwrite rename did not replace contents",
    );
    console.log(
      "  ok: rename moves (200), refuses clobber (409), overwrites on flag (200)",
    );
  }

  // =====================================================================
  // 9. delete — file (200); non-empty dir refused w/o recursive (409); w/ (200)
  // =====================================================================
  {
    const f = P("delete-me.txt");
    fs.writeFileSync(f, "x");
    const res = await req(
      "DELETE",
      `/api/sessions/${eid}/fs/entry?path=${qp(f)}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(res.status === 200, `delete file -> ${res.status}, expected 200`);
    assert(!fs.existsSync(f), "delete did not remove the file");

    // non-empty dir without recursive -> 409
    const resNo = await req(
      "DELETE",
      `/api/sessions/${eid}/fs/entry?path=${qp(P("fulldir"))}`,
      {
        origin: ALLOWED_ORIGIN,
      },
    );
    assert(
      resNo.status === 409,
      `delete non-empty dir (no recursive) -> ${resNo.status}, expected 409`,
    );
    assert(
      fs.existsSync(P("fulldir")),
      "refused delete should have left the dir",
    );

    // with recursive=1 -> 200
    const resYes = await req(
      "DELETE",
      `/api/sessions/${eid}/fs/entry?path=${qp(P("fulldir"))}&recursive=1`,
      { origin: ALLOWED_ORIGIN },
    );
    assert(
      resYes.status === 200,
      `recursive delete -> ${resYes.status}, expected 200`,
    );
    assert(
      !fs.existsSync(P("fulldir")),
      "recursive delete did not remove the dir",
    );
    console.log(
      "  ok: delete file (200), refuses non-empty dir (409), recursive removes (200)",
    );
  }

  // =====================================================================
  // 10. Guards — bad session id, missing/relative path, nonexistent path
  // =====================================================================
  {
    const ghostQ = enc("local/web-00000000-0000-0000-0000-000000000000");
    const malformedQ = enc("local/not-a-session");
    for (const bad of [ghostQ, malformedQ]) {
      const routes = [
        ["GET", `/api/sessions/${bad}/fs/list?path=${qp(scratch)}`, {}],
        ["GET", `/api/sessions/${bad}/fs/read?path=${qp(P("hello.txt"))}`, {}],
        [
          "GET",
          `/api/sessions/${bad}/fs/download?path=${qp(P("hello.txt"))}`,
          {},
        ],
        [
          "POST",
          `/api/sessions/${bad}/fs/upload?path=${qp(P("z"))}`,
          { raw: Buffer.from("z"), origin: ALLOWED_ORIGIN },
        ],
        [
          "POST",
          `/api/sessions/${bad}/fs/mkdir`,
          { body: { path: P("z") }, origin: ALLOWED_ORIGIN },
        ],
        [
          "PATCH",
          `/api/sessions/${bad}/fs/entry`,
          { body: { from: P("a"), to: P("b") }, origin: ALLOWED_ORIGIN },
        ],
        [
          "DELETE",
          `/api/sessions/${bad}/fs/entry?path=${qp(P("z"))}`,
          { origin: ALLOWED_ORIGIN },
        ],
      ];
      for (const [m, u, opts] of routes) {
        const res = await req(m, u, opts);
        assert(
          res.status === 404,
          `${m} ${u.split("?")[0]} bad id -> ${res.status}, expected 404`,
        );
      }
    }
    console.log(
      "  ok: unknown + malformed session id -> 404 on all six routes",
    );

    // missing path -> 400 (list resolves cwd, so test read/download/upload/delete)
    const resNoPath = await req("GET", `/api/sessions/${eid}/fs/read`);
    assert(
      resNoPath.status === 400,
      `read missing path -> ${resNoPath.status}, expected 400`,
    );
    // relative path -> 400
    const resRel = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp("relative/x")}`,
    );
    assert(
      resRel.status === 400,
      `read relative path -> ${resRel.status}, expected 400`,
    );
    const resRelList = await req(
      "GET",
      `/api/sessions/${eid}/fs/list?path=${qp("relative/x")}`,
    );
    assert(
      resRelList.status === 400,
      `list relative path -> ${resRelList.status}, expected 400`,
    );
    const resMkRel = await req("POST", `/api/sessions/${eid}/fs/mkdir`, {
      body: { path: "relative/x" },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      resMkRel.status === 400,
      `mkdir relative path -> ${resMkRel.status}, expected 400`,
    );
    console.log("  ok: missing/relative path -> 400");

    // nonexistent absolute path -> 404
    const resGone = await req(
      "GET",
      `/api/sessions/${eid}/fs/read?path=${qp(P("does-not-exist"))}`,
    );
    assert(
      resGone.status === 404,
      `read nonexistent -> ${resGone.status}, expected 404`,
    );
    const resGoneList = await req(
      "GET",
      `/api/sessions/${eid}/fs/list?path=${qp(P("does-not-exist"))}`,
    );
    assert(
      resGoneList.status === 404,
      `list nonexistent -> ${resGoneList.status}, expected 404`,
    );
    console.log("  ok: nonexistent path -> 404");
  }

  // =====================================================================
  // 11. Origin/CSRF — a write with a forbidden Origin is 403 (before any fs op)
  // =====================================================================
  {
    const sentinel = P("csrf-should-not-exist");
    const res = await req("POST", `/api/sessions/${eid}/fs/mkdir`, {
      body: { path: sentinel },
      origin: "http://evil.example.com",
    });
    assert(
      res.status === 403,
      `forbidden-origin mkdir -> ${res.status}, expected 403`,
    );
    assert(
      !fs.existsSync(sentinel),
      "forbidden-origin mkdir still created the dir!",
    );
    console.log(
      "  ok: write with forbidden Origin -> 403 (CSRF guard fires, no fs op)",
    );
  }

  // --- teardown: DELETE the session, verify no orphan web- sessions ---
  const resDel = await req("DELETE", `/api/sessions/${eid}`, {
    origin: ALLOWED_ORIGIN,
  });
  assert(
    resDel.status === 204,
    `DELETE session -> ${resDel.status}, expected 204`,
  );
  await sleep(300);
  const orphans = listWebSessions().filter((s) => createdTmux.includes(s));
  assert(
    orphans.length === 0,
    `orphan web- sessions remain: ${orphans.join(", ")}`,
  );
  console.log("  ok: session deleted, no orphans");

  console.log(
    "\nPASS: fs endpoints — list (cwd-seed + explicit, hidden filter, ms mtime), " +
      "read (text/truncated/binary), download (exact bytes), upload (exact bytes + 413), " +
      "mkdir/rename/delete semantics, awkward-name quoting proof, guards (404/400), CSRF 403.",
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
