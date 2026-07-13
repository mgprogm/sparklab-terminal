// Web terminal gateway (Phase 1).
//
// The gateway NEVER owns the job. tmux owns it. On WS attach we spawn a
// node-pty running `tmux attach-session`; on WS close we kill ONLY that pty,
// which detaches the tmux client. The tmux session and its child jobs keep
// running. We never run `tmux kill-session` here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { spawn as ptySpawn } from 'node-pty';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3007;
const DEFAULT_SESSION = 'web-main';

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
  try {
    await tmux(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

// Ensure the session exists; create + configure it if not.
async function ensureSession(name) {
  if (await sessionExists(name)) return;
  await tmux(['new-session', '-d', '-s', name]);
  await tmux(['set-option', '-t', name, 'history-limit', '50000']).catch((e) =>
    console.warn(`[tmux] history-limit failed: ${e.message}`)
  );
  // status off is a server-global nicety; scope with -g and swallow errors.
  await tmux(['set-option', '-g', 'status', 'off']).catch((e) =>
    console.warn(`[tmux] status off failed: ${e.message}`)
  );
  // Prefer the most recently active client's size when multiple viewers attach.
  await tmux(['set-option', '-t', name, 'window-size', 'latest']).catch(() => {});
  await tmux(['set-option', '-t', name, 'aggressive-resize', 'on']).catch(() => {});
  console.log(`[tmux] created session "${name}"`);
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

const server = http.createServer(serveStatic);

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
  const sessionName = url.searchParams.get('session') || DEFAULT_SESSION;

  try {
    await ensureSession(sessionName);
  } catch (err) {
    console.error(`[attach] failed to ensure session "${sessionName}": ${err.message}`);
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
  console.log(`default tmux session: ${DEFAULT_SESSION}`);
});
