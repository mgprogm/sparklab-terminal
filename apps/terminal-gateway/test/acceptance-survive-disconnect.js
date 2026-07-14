// Step 5 acceptance test — proves the pitch at the protocol level.
//
// 1. Start the gateway on a test port, spawning its own child process.
// 2. Attach over WS, start a 600s tick loop INSIDE the tmux session.
// 3. Confirm ticks stream; record the last tick; CLOSE the WS (browser closed).
// 4. Wait ~13s with NO connection. Confirm tmux session is still alive.
// 5. Reconnect a fresh WS; confirm the tick number jumped by ~=the gap
//    (loop kept counting while nobody watched) AND ticks keep arriving live.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3998;
// Phase 2 removed auto-create-on-attach, so the setup now creates the session
// via the REST API first, then attaches (create-then-attach). SESSION/URL are
// assigned once the POST returns the generated web-<uuid> id. Every assertion
// below (delta/timing/live-advance) is unchanged from Phase 1.
let SESSION = null;
let URL = null;
const BASE = `http://localhost:${PORT}`;
const GAP_MS = 13000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmuxHasSession(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('listening on')) resolve();
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', (d) => process.stderr.write(`[gw] ${d}`));
    setTimeout(() => reject(new Error('server did not start in time')), 8000);
  });
}

// Extract the highest TICK number seen in a decoded chunk of pty output.
function maxTick(text) {
  let max = null;
  const re = /TICK (\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (max === null || n > max) max = n;
  }
  return max;
}

function cleanup() {
  if (SESSION) {
    try { execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' }); } catch {}
  }
  if (server && !server.killed) server.kill('SIGTERM');
}

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

async function main() {
  await startServer();
  console.log(`gateway up on :${PORT}`);

  // Phase 2: create the session via REST first (no more auto-create-on-attach).
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phase1-acceptance' }),
  });
  if (res.status !== 201) fail(`POST /api/sessions returned ${res.status}, expected 201`);
  SESSION = (await res.json()).id;
  URL = `ws://localhost:${PORT}/attach?session=${SESSION}`;
  console.log(`created session ${SESSION} via REST`);

  // --- Connection #1: start the job and observe ticks ---
  const ws1 = new WebSocket(URL);
  ws1.binaryType = 'arraybuffer';

  let buf1 = '';
  await new Promise((resolve, reject) => {
    ws1.on('open', resolve);
    ws1.on('error', reject);
  });
  ws1.on('message', (data, isBinary) => {
    if (isBinary) buf1 += Buffer.from(data).toString('utf8');
  });

  // Let the shell settle, then start the loop.
  await sleep(700);
  ws1.send(Buffer.from('for i in $(seq 1 600); do echo TICK $i; sleep 1; done\n'), { binary: true });

  // Wait for ticks to actually stream.
  let before = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const t = maxTick(buf1);
    if (t !== null && t >= 3) { before = t; break; }
  }
  if (before === null) fail('never saw ticks stream on the first connection');
  console.log(`connection #1: ticks streaming, last tick before disconnect = ${before}`);

  // Close the WS = simulate the browser tab closing.
  const tClose = Date.now();
  ws1.close();
  await sleep(300);
  console.log('WS closed (browser "closed"). No viewer attached now.');

  // --- Gap: no connection. Job must keep running. ---
  await sleep(Math.floor(GAP_MS / 2));
  const aliveMidGap = tmuxHasSession(SESSION);
  console.log(`mid-gap tmux has-session -t ${SESSION}: ${aliveMidGap}`);
  if (!aliveMidGap) fail('tmux session died during the disconnect gap (job did NOT survive)');
  await sleep(GAP_MS - Math.floor(GAP_MS / 2));

  // --- Connection #2: fresh attach, read redraw + live stream ---
  const ws2 = new WebSocket(URL);
  ws2.binaryType = 'arraybuffer';
  let buf2 = '';
  await new Promise((resolve, reject) => {
    ws2.on('open', resolve);
    ws2.on('error', reject);
  });
  ws2.on('message', (data, isBinary) => {
    if (isBinary) buf2 += Buffer.from(data).toString('utf8');
  });

  // Read the redraw + a couple seconds of live stream.
  await sleep(2500);
  const afterFirst = maxTick(buf2);
  const tAfter = Date.now();
  if (afterFirst === null) fail('reconnect: no ticks in redraw/live stream');

  // Sample again to prove ticks are still arriving LIVE.
  await sleep(3000);
  const afterSecond = maxTick(buf2);
  ws2.close();

  const elapsedSec = Math.round((tAfter - tClose) / 1000);
  const delta = afterFirst - before;
  console.log(`connection #2: tick after reconnect = ${afterFirst}`);
  console.log(`later live sample = ${afterSecond}`);
  console.log(`\nbefore=${before}  after=${afterFirst}  delta=${delta}  (dead gap ~${elapsedSec}s of real time)`);

  // Assertions:
  // (a) the count advanced by roughly the gap duration — proves it kept
  //     counting while disconnected, not just replayed a stale buffer.
  if (delta < 8) fail(`tick advanced only ${delta}; expected ~${elapsedSec} (loop did not keep running)`);
  if (Math.abs(delta - elapsedSec) > 5) {
    fail(`delta ${delta} not within 5 of real gap ${elapsedSec}s — timing does not match a live-running loop`);
  }
  // (b) ticks are still arriving live after reconnect.
  if (!(afterSecond > afterFirst)) fail(`ticks not advancing live after reconnect (${afterFirst} -> ${afterSecond})`);

  console.log('\nPASS: job survived disconnect and kept running; reconnect resumed live streaming.');
  console.log(`  before=${before} -> after=${afterFirst} (+${delta} while disconnected ~${elapsedSec}s) -> live=${afterSecond}`);
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
