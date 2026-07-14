// Web terminal gateway (Phase 3: origin allowlist, token auth, bind config, limits).
//
// The gateway NEVER owns the job. tmux owns it. On WS attach we spawn a
// node-pty running `tmux attach-session`; on WS close we kill ONLY that pty,
// which detaches the tmux client. The tmux session and its child jobs keep
// running. The tmux session-terminating call appears in EXACTLY ONE place in
// this file: the DELETE /api/sessions/:id handler — the single intentional,
// user-confirmed job kill. Every tmux operation (list/attach/create/delete) is filtered to the
// `web-` name prefix so the gateway can never see or touch unrelated sessions.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { spawn as ptySpawn } from "node-pty";
import metadata from "./metadata.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 3007;
const HOST = process.env.HOST || "127.0.0.1";

// ---- A3: Security + deployment configuration ----
const GATEWAY_AUTH_TOKEN = process.env.GATEWAY_AUTH_TOKEN || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOWED_ORIGINS_RAW =
  process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:3007";
const ALLOWED_ORIGINS = new Set(
  ALLOWED_ORIGINS_RAW.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS) || 32;

// Open mode: auth fully disabled when token unset AND host is loopback.
// Token unset + non-loopback HOST is a configuration error — refuse to start.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const OPEN_MODE = !GATEWAY_AUTH_TOKEN;
if (OPEN_MODE && !LOOPBACK_HOSTS.has(HOST)) {
  console.error(
    `[gateway] FATAL: GATEWAY_AUTH_TOKEN is not set but HOST="${HOST}" is not a loopback address.`,
  );
  console.error(
    "[gateway] Either set GATEWAY_AUTH_TOKEN or bind to a loopback address (127.0.0.1, ::1, localhost).",
  );
  process.exit(1);
}
if (OPEN_MODE) {
  console.warn(
    "[gateway] WARNING: running in open mode (no auth). Ensure gateway is accessible from trusted hosts only.",
  );
}

// ---- A2: Auth sessions (in-memory, 30-day absolute expiry) ----
const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const authSessions = new Map(); // sid -> { expires: number }

function createAuthSession() {
  const sid = crypto.randomBytes(16).toString("hex");
  authSessions.set(sid, { expires: Date.now() + AUTH_SESSION_TTL_MS });
  return sid;
}

function validateAuthSession(sid) {
  if (!sid) return false;
  const session = authSessions.get(sid);
  if (!session) return false;
  if (session.expires < Date.now()) {
    authSessions.delete(sid);
    return false;
  }
  return true;
}

// ---- Cookie helpers ----
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) cookies[k] = v;
  }
  return cookies;
}

function buildSessionCookie(sid) {
  let cookie = `gw_session=${sid}; HttpOnly; SameSite=Strict; Path=/`;
  if (TRUST_PROXY) cookie += "; Secure";
  return cookie;
}

function clearSessionCookie() {
  return "gw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
}

// ---- Auth middleware ----
// Returns true when the request is authenticated (or in open mode).
function isAuthenticated(req) {
  if (OPEN_MODE) return true;
  const cookies = parseCookies(req);
  return validateAuthSession(cookies.gw_session);
}

// ---- A1: Origin helpers ----
// In open mode (loopback-only dev), origin enforcement is skipped so that
// non-browser clients (test scripts using the `ws` library, curl) can connect
// without a browser-set Origin header.  In auth mode the origin MUST be in the
// allowlist — absent counts as disallowed.
function isOriginAllowed(origin) {
  if (OPEN_MODE) return true; // no enforcement in open mode
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

// ---- A4: Rate limiting for /api/auth/login ----
const loginAttempts = new Map(); // ip -> { count: number, windowStart: number }
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;

function getClientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "0.0.0.0";
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.windowStart >= LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  record.count++;
  if (record.count > LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil(
      (record.windowStart + LOGIN_WINDOW_MS - now) / 1000,
    );
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

// ---- SHA-256 helper for timing-safe token compare ----
function sha256buf(str) {
  return crypto.createHash("sha256").update(str).digest();
}

const PREFIX = "web-";
// Session ids must be web- prefixed and contain only hyphen-safe chars. This
// rejects hostile/typo path params before they ever reach tmux.
const ID_RE = /^web-[A-Za-z0-9-]+$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function tmux(args) {
  return execFileAsync("tmux", args);
}

async function sessionExists(name) {
  if (!ID_RE.test(name)) return false;
  try {
    await tmux(["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

// Create + configure a new session. This is the only path that spawns a tmux
// session; attach never creates. Options mirror what Phase 1 applied.
async function createSession(id, cwd) {
  const args = ["new-session", "-d", "-s", id];
  if (cwd) args.push("-c", cwd);
  await tmux(args);
  await tmux(["set-option", "-t", id, "history-limit", "50000"]).catch((e) =>
    console.warn(`[tmux] history-limit failed: ${e.message}`),
  );
  // status off is a server-global nicety; scope with -g and swallow errors.
  await tmux(["set-option", "-g", "status", "off"]).catch((e) =>
    console.warn(`[tmux] status off failed: ${e.message}`),
  );
  // Prefer the most recently active client's size when multiple viewers attach.
  await tmux(["set-option", "-t", id, "window-size", "latest"]).catch(() => {});
  await tmux(["set-option", "-t", id, "aggressive-resize", "on"]).catch(
    () => {},
  );
  console.log(`[tmux] created session "${id}"`);
}

// List only web- prefixed sessions, joined with metadata.
async function listSessions() {
  let out = "";
  try {
    const res = await tmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created}\t#{pane_current_command}\t#{session_attached}",
    ]);
    out = res.stdout;
  } catch {
    // No server / no sessions => empty list.
    out = "";
  }
  const meta = metadata.list();
  const sessions = [];
  const liveIds = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, created, currentCommand, attached] = line.split("\t");
    if (!name || !name.startsWith(PREFIX)) continue;
    liveIds.push(name);
    const m = meta[name] || {};
    sessions.push({
      id: name,
      name: m.name || name,
      createdAt: m.createdAt || (created ? Number(created) * 1000 : null),
      tags: m.tags || [],
      currentCommand: currentCommand || "",
      attached: attached === "1",
    });
  }
  // Prune metadata for sessions tmux no longer knows about.
  metadata.pruneToExisting(liveIds);
  return sessions;
}

// ---- JSON helpers ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// A4: 64 KB body cap.
const BODY_LIMIT = 65_536;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > BODY_LIMIT) {
        const err = new Error("body too large");
        err.code = "BODY_TOO_LARGE";
        reject(err);
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---- A2: Auth route handlers ----
async function handleLogin(req, res) {
  const ip = getClientIp(req);
  const rateCheck = checkLoginRateLimit(ip);
  if (!rateCheck.allowed) {
    res.writeHead(429, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(rateCheck.retryAfter),
    });
    res.end(
      JSON.stringify({
        error: "too many attempts",
        retryAfter: rateCheck.retryAfter,
      }),
    );
    return;
  }

  let body = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch (err) {
    if (err.code === "BODY_TOO_LARGE") {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "request too large" }));
      return;
    }
    return sendJson(res, 400, { error: "malformed JSON body" });
  }

  if (typeof body.token !== "string") {
    return sendJson(res, 400, { error: "token is required" });
  }

  // Timing-safe comparison: hash both sides to equal length, then compare.
  const expected = sha256buf(GATEWAY_AUTH_TOKEN);
  const provided = sha256buf(body.token);
  const valid = crypto.timingSafeEqual(expected, provided);

  if (!valid) {
    return sendJson(res, 401, { error: "invalid token" });
  }

  const sid = createAuthSession();
  res.writeHead(204, { "set-cookie": buildSessionCookie(sid) });
  res.end();
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  if (cookies.gw_session) {
    authSessions.delete(cookies.gw_session);
  }
  res.writeHead(204, { "set-cookie": clearSessionCookie() });
  res.end();
}

function handleMe(req, res) {
  if (isAuthenticated(req)) {
    return sendJson(res, 200, { authenticated: true });
  }
  return sendJson(res, 401, { error: "unauthorized" });
}

// ---- REST API ----
// Returns true if it handled the request.
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ['api', 'auth'|'sessions', ...]

  // A1: Origin check for state-changing REST when Origin header is present (CSRF guard).
  if (
    (req.method === "POST" || req.method === "DELETE") &&
    req.headers.origin
  ) {
    if (!isOriginAllowed(req.headers.origin)) {
      return sendJson(res, 403, { error: "forbidden origin" });
    }
  }

  // A2: Auth routes — no session cookie required.
  if (parts[1] === "auth") {
    if (req.method === "POST" && parts[2] === "login") {
      await handleLogin(req, res);
      return true;
    }
    if (req.method === "POST" && parts[2] === "logout") {
      await handleLogout(req, res);
      return true;
    }
    if (req.method === "GET" && parts[2] === "me") {
      handleMe(req, res);
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  // A2: All other /api/* routes require a valid session (or open mode).
  if (!isAuthenticated(req)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  // POST /api/sessions
  if (req.method === "POST" && parts.length === 2 && parts[1] === "sessions") {
    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "body must be a JSON object" });
      }
    } catch (err) {
      if (err.code === "BODY_TOO_LARGE") {
        res.writeHead(413, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: "request too large" }));
        return true;
      }
      return sendJson(res, 400, { error: "malformed JSON body" });
    }

    let cwd;
    if (body.cwd != null) {
      if (typeof body.cwd !== "string") {
        return sendJson(res, 400, { error: "cwd must be a string" });
      }
      try {
        if (!fs.statSync(body.cwd).isDirectory()) {
          return sendJson(res, 400, { error: "cwd is not a directory" });
        }
        cwd = body.cwd;
      } catch {
        return sendJson(res, 400, { error: "cwd does not exist" });
      }
    }

    if (body.name != null && typeof body.name !== "string") {
      return sendJson(res, 400, { error: "name must be a string" });
    }

    // crypto.randomUUID() is already hyphen-safe (no dots/colons).
    const id = `${PREFIX}${crypto.randomUUID()}`;
    try {
      await createSession(id, cwd);
    } catch (err) {
      console.error(`[api] create failed: ${err.message}`);
      return sendJson(res, 500, {
        error: `failed to create session: ${err.message}`,
      });
    }
    const createdAt = Date.now();
    const name = body.name || id;
    metadata.upsert(id, { name, createdAt });
    return sendJson(res, 201, { id, name, createdAt });
  }

  // GET /api/sessions
  if (req.method === "GET" && parts.length === 2 && parts[1] === "sessions") {
    try {
      const sessions = await listSessions();
      return sendJson(res, 200, sessions);
    } catch (err) {
      console.error(`[api] list failed: ${err.message}`);
      return sendJson(res, 500, { error: "failed to list sessions" });
    }
  }

  // DELETE /api/sessions/:id
  if (
    req.method === "DELETE" &&
    parts.length === 3 &&
    parts[1] === "sessions"
  ) {
    const id = decodeURIComponent(parts[2]);
    if (!ID_RE.test(id)) {
      return sendJson(res, 400, { error: "invalid session id" });
    }
    if (!(await sessionExists(id))) {
      return sendJson(res, 404, { error: "session not found" });
    }
    try {
      // THE ONE INTENTIONAL KILL. This is the only place the gateway terminates
      // a tmux session; it actually kills the running job, so the UI confirms
      // first. Everywhere else we only detach (pty.kill).
      await tmux(["kill-session", "-t", id]);
    } catch (err) {
      console.error(`[api] delete failed: ${err.message}`);
      return sendJson(res, 500, { error: "failed to kill session" });
    }
    metadata.remove(id);
    console.log(`[api] deleted session "${id}"`);
    res.writeHead(204);
    res.end();
    return true;
  }

  // Unknown /api/* route.
  sendJson(res, 404, { error: "not found" });
  return true;
}

// ---- Static file serving ----
function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(PUBLIC_DIR, pathname);
  // Prevent path traversal outside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Route /api/* before static.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      console.error(`[api] unhandled: ${err.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  serveStatic(req, res);
});

// A4: Slow-loris / timeout guards.
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;

// ---- WebSocket attach endpoint ----
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/attach") {
    socket.destroy();
    return;
  }
  // A1: Origin check BEFORE handshake (CSWSH guard).
  // In open mode this is skipped so non-browser clients (test scripts, curl) work.
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws, req) => {
  // A2: Auth check post-handshake (upgrade already completed).
  // Close code 4001 is contractual — the frontend maps it to no-reconnect.
  if (!isAuthenticated(req)) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
    }
    ws.close(4001, "unauthorized");
    return;
  }

  // A4: Connection cap — over-cap connections are rejected post-handshake.
  // wss.clients already includes this new connection, so > MAX means we just exceeded it.
  if (wss.clients.size > MAX_WS_CONNECTIONS) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({ type: "error", message: "too many connections" }),
      );
    }
    ws.close(1013);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionName = url.searchParams.get("session") || "";

  // Attach only ever attaches to an EXISTING web- session. It never creates.
  // A bad prefix or missing session is a client error, not a reason to spawn a
  // new tmux session (that would bypass POST and leak sessions on typos).
  if (!ID_RE.test(sessionName)) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `invalid session id "${sessionName}"`,
        }),
      );
    }
    ws.close();
    return;
  }
  if (!(await sessionExists(sessionName))) {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `session "${sessionName}" does not exist`,
        }),
      );
    }
    ws.close();
    return;
  }

  // Spawn the pty that attaches to tmux. encoding: null => onData yields raw
  // Buffers, so multibyte UTF-8 is never decoded/corrupted mid-pipeline.
  const pty = ptySpawn("tmux", ["attach-session", "-t", sessionName], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    encoding: null,
  });
  console.log(
    `[attach] session="${sessionName}" pty=${pty.pid} client attached`,
  );

  let torndown = false;
  const teardown = (why) => {
    if (torndown) return;
    torndown = true;
    // The ONLY kill on disconnect: our own pty (detaches the tmux client).
    // We NEVER kill the tmux session — that is what keeps jobs alive.
    try {
      pty.kill();
    } catch {}
    console.log(
      `[teardown] session="${sessionName}" pty=${pty.pid} killed (${why}); tmux session left running`,
    );
  };

  // pty output -> WS as BINARY frames.
  const onData = pty.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data), { binary: true });
  });

  // If the shell inside the session exits, the attach pty exits too.
  const onExit = pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      ws.close();
    }
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Keystrokes: pipe straight into the pty.
      pty.write(data);
      return;
    }
    // Text frame: JSON control message.
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (
      msg.type === "resize" &&
      Number.isFinite(msg.cols) &&
      Number.isFinite(msg.rows)
    ) {
      try {
        pty.resize(msg.cols, msg.rows);
      } catch {}
    } else if (msg.type === "ping") {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "pong" }));
    }
  });

  ws.on("close", () => {
    onData.dispose();
    onExit.dispose();
    teardown("ws close");
  });
  ws.on("error", (err) => {
    onData.dispose();
    onExit.dispose();
    teardown(`ws error: ${err.message}`);
  });
});

// A3: Bind to HOST (default 127.0.0.1).
server.listen(PORT, HOST, () => {
  console.log(`web-terminal gateway listening on http://${HOST}:${PORT}`);
});
