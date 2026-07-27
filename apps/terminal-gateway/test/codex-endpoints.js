// Codex CLI endpoint test — proves POST /api/sessions/:id/codex against a real
// gateway + real tmux, using a STUB `codex` binary (CODEX_COMMAND override) so
// nothing hits the network or a real Codex account. The stub emulates
// `codex exec [flags] -` (prompt on stdin) and echoes its argv + prompt so the
// test can assert the EXACT invocation the gateway built.
//
// Covered: read-only default, workspace-write passthrough, cwd rooting (-C),
// prompt-via-stdin, sandbox clamp (danger-full-access -> 400), missing prompt
// (400), non-zero exit (200 + exitCode + output), not-installed (503), timeout
// (504), auth (401), bad session id (404), and the POST Origin/CSRF guard (403).
//
// The gateway runs with AUTH ENABLED (Origin/CSRF live) and CODEX_TIMEOUT_MS set
// low so the timeout case is fast; normal stub calls return in milliseconds.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const AUTH_USER = "codexuser";
const AUTH_PASS = "codexpass-secret";
const ALLOWED_ORIGIN = "http://localhost:3000";
const CODEX_TIMEOUT_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let cookie = "";
const createdTmux = [];
let scratch;
let stubPath;

// A stub that stands in for the `codex` binary. It reads the prompt from stdin
// (as `codex exec -` does), echoes its args + prompt, and branches on sentinels.
const STUB = `#!/usr/bin/env bash
prompt="$(cat)"
echo "ARGS: $*"
echo "PROMPT: $prompt"
case "$prompt" in
  UNAVAILABLE*) echo "codex: command not found" >&2; exit 127 ;;
  TIMEOUT*)     sleep 5 ;;
  FAIL*)        echo "boom failure" >&2; exit 3 ;;
  ENV*)         printenv ;;
esac
echo "codex-stub ok"
exit 0
`;

// A gateway-only secret and a Codex-owned credential, both injected into the
// gateway's env. The curated child env must DROP the former and KEEP the latter.
const GATEWAY_SECRET = "GATEWAY_SECRET_SENTINEL_DO_NOT_LEAK";
const CODEX_OWN_CRED = "codex-own-credential-ok";

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
        CODEX_COMMAND: stubPath,
        CODEX_TIMEOUT_MS: String(CODEX_TIMEOUT_MS),
        // A gateway secret (must NOT reach the Codex child) and a Codex-owned
        // credential (must reach it) — see the env-isolation assertion below.
        VAPID_PRIVATE_KEY: GATEWAY_SECRET,
        OPENAI_API_KEY: CODEX_OWN_CRED,
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
  for (const dir of [scratch]) {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
  if (stubPath) {
    try {
      fs.rmSync(stubPath, { force: true });
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

const enc = (id) => encodeURIComponent(id);

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
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-endpoints-"));
  stubPath = path.join(scratch, "codex-stub.sh");
  fs.writeFileSync(stubPath, STUB, { mode: 0o755 });

  await startServer();
  console.log(`gateway up on :${PORT} (auth enabled, stub codex)`);
  await login();
  console.log("logged in; cookie captured");

  // auth: no cookie -> 401
  {
    const res = await fetch(`${BASE}/api/sessions/local%2Fweb-x/codex`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert(
      res.status === 401,
      `no-cookie codex -> ${res.status}, expected 401`,
    );
  }

  // create a session rooted at the scratch dir
  const resCreate = await req("POST", "/api/sessions", {
    body: { name: "codex-endpoints-test", cwd: scratch },
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

  const realScratch = fs.realpathSync(scratch);

  // =====================================================================
  // 1. read-only DEFAULT: exact invocation, cwd rooting, prompt via stdin
  // =====================================================================
  {
    const prompt = "explain how auth works";
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res.status === 200,
      `codex read-only -> ${res.status}, expected 200`,
    );
    const j = await res.json();
    assert(j.mode === "read-only", `mode=${j.mode}, expected read-only`);
    assert(j.exitCode === 0, `exitCode=${j.exitCode}, expected 0`);
    assert(
      fs.realpathSync(j.cwd) === realScratch,
      `cwd=${j.cwd}, expected ${scratch}`,
    );
    // The stub echoed the argv + prompt; assert the gateway built a safe call.
    assert(/(^|\s)exec(\s|$)/m.test(j.output), "invocation missing 'exec'");
    assert(
      j.output.includes("--sandbox read-only"),
      "missing --sandbox read-only",
    );
    assert(j.output.includes(`-C ${scratch}`), `missing -C ${scratch}`);
    assert(
      j.output.includes("--skip-git-repo-check"),
      "missing --skip-git-repo-check",
    );
    assert(
      j.output.includes(`PROMPT: ${prompt}`),
      "prompt was not delivered on stdin",
    );
    assert(typeof j.durationMs === "number", "durationMs missing");
    console.log(
      "  ok: read-only default; -C <cwd>, --sandbox read-only, --skip-git-repo-check, prompt via stdin",
    );
  }

  // =====================================================================
  // 2. workspace-write passthrough
  // =====================================================================
  {
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt: "add a test", mode: "workspace-write" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `codex ww -> ${res.status}, expected 200`);
    const j = await res.json();
    assert(
      j.mode === "workspace-write",
      `mode=${j.mode}, expected workspace-write`,
    );
    assert(
      j.output.includes("--sandbox workspace-write"),
      "missing --sandbox workspace-write",
    );
    console.log("  ok: workspace-write mode passed through to --sandbox");
  }

  // =====================================================================
  // 2b. env isolation — the Codex child gets NO gateway secrets, but keeps
  //     its own OPENAI_/CODEX_ credentials and agent-provided Azure config.
  // =====================================================================
  {
    const azureKey = "agent-azure-key-sentinel";
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt: "ENV dump please" },
      origin: ALLOWED_ORIGIN,
      headers: {
        "x-sparklab-codex-azure-endpoint": "https://azure.example.invalid",
        "x-sparklab-codex-azure-api-key": azureKey,
        "x-sparklab-codex-azure-api-version": "test-api-version",
        "x-sparklab-codex-azure-deployment": "test-deployment",
      },
    });
    assert(res.status === 200, `codex env -> ${res.status}, expected 200`);
    const out = (await res.json()).output;
    assert(
      !out.includes(GATEWAY_SECRET),
      "LEAK: gateway secret (VAPID_PRIVATE_KEY) reached the Codex child env!",
    );
    assert(
      out.includes(CODEX_OWN_CRED),
      "Codex's own OPENAI_API_KEY should be passed through but was not",
    );
    assert(
      out.includes(`AZURE_OPENAI_API_KEY=${azureKey}`),
      "agent-service Azure API key should reach the local Codex child",
    );
    assert(
      out.includes("AZURE_OPENAI_ENDPOINT=https://azure.example.invalid"),
      "agent-service Azure endpoint should reach the local Codex child",
    );
    assert(
      out.includes("AZURE_OPENAI_API_VERSION=test-api-version"),
      "agent-service Azure API version should reach the local Codex child",
    );
    assert(
      out.includes("GPT56SOL_DEPLOYMENT=test-deployment"),
      "agent-service Azure deployment should reach the local Codex child",
    );
    assert(/(^|\n)PATH=/.test(out), "PATH missing from the Codex child env");
    console.log(
      "  ok: env isolation — gateway secret dropped, Codex + agent Azure credentials kept",
    );
  }

  // =====================================================================
  // 3. sandbox CLAMP — dangerous/unknown modes rejected with 400
  // =====================================================================
  {
    for (const bad of ["danger-full-access", "full-auto", "yolo", 123]) {
      const res = await req("POST", `/api/sessions/${eid}/codex`, {
        body: { prompt: "x", mode: bad },
        origin: ALLOWED_ORIGIN,
      });
      assert(
        res.status === 400,
        `mode=${bad} -> ${res.status}, expected 400 (clamp)`,
      );
    }
    console.log(
      "  ok: danger-full-access / unknown modes rejected with 400 (never reachable)",
    );
  }

  // =====================================================================
  // 4. missing / empty prompt -> 400
  // =====================================================================
  {
    for (const body of [{}, { prompt: "" }, { prompt: "   " }]) {
      const res = await req("POST", `/api/sessions/${eid}/codex`, {
        body,
        origin: ALLOWED_ORIGIN,
      });
      assert(
        res.status === 400,
        `prompt=${JSON.stringify(body)} -> ${res.status}, expected 400`,
      );
    }
    console.log("  ok: missing/empty prompt -> 400");
  }

  // =====================================================================
  // 5. Codex exits non-zero -> 200 with exitCode + output (agent can read it)
  // =====================================================================
  {
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt: "FAIL please" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 200, `codex fail -> ${res.status}, expected 200`);
    const j = await res.json();
    assert(j.exitCode === 3, `exitCode=${j.exitCode}, expected 3`);
    assert(
      j.output.includes("boom failure"),
      "output missing stderr 'boom failure'",
    );
    console.log(
      "  ok: non-zero exit returns 200 + exitCode 3 + captured output",
    );
  }

  // =====================================================================
  // 6. not installed -> 503 codex_unavailable (clear, distinct error)
  // =====================================================================
  {
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt: "UNAVAILABLE now" },
      origin: ALLOWED_ORIGIN,
    });
    assert(
      res.status === 503,
      `codex unavailable -> ${res.status}, expected 503`,
    );
    const j = await res.json();
    assert(
      j.code === "codex_unavailable",
      `code=${j.code}, expected codex_unavailable`,
    );
    console.log("  ok: not-installed -> 503 codex_unavailable");
  }

  // =====================================================================
  // 7. timeout -> 504 codex_timeout (stub sleeps past CODEX_TIMEOUT_MS)
  // =====================================================================
  {
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt: "TIMEOUT hang" },
      origin: ALLOWED_ORIGIN,
    });
    assert(res.status === 504, `codex timeout -> ${res.status}, expected 504`);
    const j = await res.json();
    assert(
      j.code === "codex_timeout",
      `code=${j.code}, expected codex_timeout`,
    );
    console.log(`  ok: hung codex killed after ${CODEX_TIMEOUT_MS}ms -> 504`);
  }

  // =====================================================================
  // 8. bad session id -> 404
  // =====================================================================
  {
    for (const bad of [
      enc("local/web-00000000-0000-0000-0000-000000000000"),
      enc("local/not-a-session"),
    ]) {
      const res = await req("POST", `/api/sessions/${bad}/codex`, {
        body: { prompt: "x" },
        origin: ALLOWED_ORIGIN,
      });
      assert(res.status === 404, `bad id -> ${res.status}, expected 404`);
    }
    console.log("  ok: unknown + malformed session id -> 404");
  }

  // =====================================================================
  // 9. Origin/CSRF — a forbidden Origin is 403 (before any codex run)
  // =====================================================================
  {
    const res = await req("POST", `/api/sessions/${eid}/codex`, {
      body: { prompt: "x" },
      origin: "http://evil.example.com",
    });
    assert(
      res.status === 403,
      `forbidden-origin codex -> ${res.status}, expected 403`,
    );
    console.log("  ok: forbidden Origin -> 403 (CSRF guard fires)");
  }

  // teardown
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
    "\nPASS: codex endpoint — read-only default + workspace-write, cwd rooting (-C), " +
      "prompt via stdin, env isolation (gateway secret dropped), sandbox clamp (400), " +
      "missing prompt (400), non-zero exit (200+code), not-installed (503), timeout (504), " +
      "bad id (404), CSRF (403).",
  );
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
