// Web terminal gateway (Phase 2: REST session management + multi-session).
//
// The gateway NEVER owns the job. tmux owns it. On WS attach we spawn a
// node-pty running `tmux attach-session`; on WS close we kill ONLY that pty,
// which detaches the tmux client. The tmux session and its child jobs keep
// running. The tmux session-terminating call appears in EXACTLY ONE place in
// this file: the DELETE /api/sessions/:id handler — the single intentional,
// user-confirmed job kill. Every tmux operation (list/attach/create/delete) is filtered to the
// `web-` name prefix so the gateway can never see or touch unrelated sessions.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { spawn as ptySpawn } from 'node-pty';
import metadata from './metadata.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3007;

const PREFIX = 'web-';
// Session ids must be web- prefixed and contain only hyphen-safe chars. This
// rejects hostile/typo path params before they ever reach tmux.
const ID_RE = /^web-[A-Za-z0-9-]+$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function tmux(args) {
  return execFileAsync('tmux', args);
}

async function sessionExists(name) {
  if (!ID_RE.test(name)) return false;
  try {
    await tmux(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

// Create + configure a new session. This is the only path that spawns a tmux
// session; attach never creates. Options mirror what Phase 1 applied.
async function createSession(id, cwd) {
  const args = ['new-session', '-d', '-s', id];
  if (cwd) args.push('-c', cwd);
  await tmux(args);
  await tmux(['set-option', '-t', id, 'history-limit', '50000']).catch((e) =>
    console.warn(`[tmux] history-limit failed: ${e.message}`)
  );
  // status off is a server-global nicety; scope with -g and swallow errors.
  await tmux(['set-option', '-g', 'status', 'off']).catch((e) =>
    console.warn(`[tmux] status off failed: ${e.message}`)
  );
  // Prefer the most recently active client's size when multiple viewers attach.
  await tmux(['set-option', '-t', id, 'window-size', 'latest']).catch(() => {});
  await tmux(['set-option', '-t', id, 'aggressive-resize', 'on']).catch(() => {});
  console.log(`[tmux] created session "${id}"`);
}

// List only web- prefixed sessions, joined with metadata.
async function listSessions() {
  let out = '';
  try {
    const res = await tmux([
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_created}\t#{pane_current_command}\t#{session_attached}',
    ]);
    out = res.stdout;
  } catch {
    // No server / no sessions => empty list.
    out = '';
  }
  const meta = metadata.list();
  const sessions = [];
  const liveIds = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, currentCommand, attached] = line.split('\t');
    if (!name || !name.startsWith(PREFIX)) continue;
    liveIds.push(name);
    const m = meta[name] || {};
    sessions.push({
      id: name,
      name: m.name || name,
      createdAt: m.createdAt || (created ? Number(created) * 1000 : null),
      tags: m.tags || [],
      currentCommand: currentCommand || '',
      attached: attached === '1',
    });
  }
  // Prune metadata for sessions tmux no longer knows about.
  metadata.pruneToExisting(liveIds);
  return sessions;
}

// ---- JSON helpers ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        tooBig = true;
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      resolve(data);
    });
    req.on('error', reject);
  });
}

// ---- REST API ----
// Returns true if it handled the request.
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','sessions', maybe id]

  // POST /api/sessions
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'sessions') {
    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: 'body must be a JSON object' });
      }
    } catch {
      return sendJson(res, 400, { error: 'malformed JSON body' });
    }

    let cwd;
    if (body.cwd != null) {
      if (typeof body.cwd !== 'string') {
        return sendJson(res, 400, { error: 'cwd must be a string' });
      }
      try {
        if (!fs.statSync(body.cwd).isDirectory()) {
          return sendJson(res, 400, { error: 'cwd is not a directory' });
        }
        cwd = body.cwd;
      } catch {
        return sendJson(res, 400, { error: 'cwd does not exist' });
      }
    }

    if (body.name != null && typeof body.name !== 'string') {
      return sendJson(res, 400, { error: 'name must be a string' });
    }

    // crypto.randomUUID() is already hyphen-safe (no dots/colons).
    const id = `${PREFIX}${crypto.randomUUID()}`;
    try {
      await createSession(id, cwd);
    } catch (err) {
      console.error(`[api] create failed: ${err.message}`);
      return sendJson(res, 500, { error: `failed to create session: ${err.message}` });
    }
    const createdAt = Date.now();
    const name = body.name || id;
    metadata.upsert(id, { name, createdAt });
    return sendJson(res, 201, { id, name, createdAt });
  }

  // GET /api/sessions
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'sessions') {
    try {
      const sessions = await listSessions();
      return sendJson(res, 200, sessions);
    } catch (err) {
      console.error(`[api] list failed: ${err.message}`);
      return sendJson(res, 500, { error: 'failed to list sessions' });
    }
  }

  // DELETE /api/sessions/:id
  if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'sessions') {
    const id = decodeURIComponent(parts[2]);
    if (!ID_RE.test(id)) {
      return sendJson(res, 400, { error: 'invalid session id' });
    }
    if (!(await sessionExists(id))) {
      return sendJson(res, 404, { error: 'session not found' });
    }
    try {
      // THE ONE INTENTIONAL KILL. This is the only place the gateway terminates
      // a tmux session; it actually kills the running job, so the UI confirms
      // first. Everywhere else we only detach (pty.kill).
      await tmux(['kill-session', '-t', id]);
    } catch (err) {
      console.error(`[api] delete failed: ${err.message}`);
      return sendJson(res, 500, { error: 'failed to kill session' });
    }
    metadata.remove(id);
    console.log(`[api] deleted session "${id}"`);
    res.writeHead(204);
    res.end();
    return true;
  }

  // Unknown /api/* route.
  sendJson(res, 404, { error: 'not found' });
  return true;
}

// ---- Static file serving ----
function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(PUBLIC_DIR, pathname);
  // Prevent path traversal outside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Route /api/* before static.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(`[api] unhandled: ${err.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }
  serveStatic(req, res);
});

// ---- WebSocket attach endpoint ----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/attach') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionName = url.searchParams.get('session') || '';

  // Attach only ever attaches to an EXISTING web- session. It never creates.
  // A bad prefix or missing session is a client error, not a reason to spawn a
  // new tmux session (that would bypass POST and leak sessions on typos).
  if (!ID_RE.test(sessionName)) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: `invalid session id "${sessionName}"` }));
    }
    ws.close();
    return;
  }
  if (!(await sessionExists(sessionName))) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: `session "${sessionName}" does not exist` }));
    }
    ws.close();
    return;
  }

  // Spawn the pty that attaches to tmux. encoding: null => onData yields raw
  // Buffers, so multibyte UTF-8 is never decoded/corrupted mid-pipeline.
  const pty = ptySpawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    encoding: null,
  });
  console.log(`[attach] session="${sessionName}" pty=${pty.pid} client attached`);

  let torndown = false;
  const teardown = (why) => {
    if (torndown) return;
    torndown = true;
    // The ONLY kill on disconnect: our own pty (detaches the tmux client).
    // We NEVER kill the tmux session — that is what keeps jobs alive.
    try {
      pty.kill();
    } catch {}
    console.log(`[teardown] session="${sessionName}" pty=${pty.pid} killed (${why}); tmux session left running`);
  };

  // pty output -> WS as BINARY frames.
  const onData = pty.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data), { binary: true });
  });

  // If the shell inside the session exits, the attach pty exits too.
  const onExit = pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      ws.close();
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Keystrokes: pipe straight into the pty.
      pty.write(data);
      return;
    }
    // Text frame: JSON control message.
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      try {
        pty.resize(msg.cols, msg.rows);
      } catch {}
    } else if (msg.type === 'ping') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    onData.dispose();
    onExit.dispose();
    teardown('ws close');
  });
  ws.on('error', (err) => {
    onData.dispose();
    onExit.dispose();
    teardown(`ws error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`web-terminal gateway listening on http://localhost:${PORT}`);
});
