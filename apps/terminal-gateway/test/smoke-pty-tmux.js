// Step 1 smoke test: prove the architectural bet.
// A job spawned inside a tmux session must SURVIVE the pty (tmux client) dying.
// Also verifies node-pty hands us raw Buffers (encoding: null) so multibyte
// UTF-8 is never corrupted mid-pipeline.
import { spawn as ptySpawn } from 'node-pty';
import { execFileSync } from 'node:child_process';

const SESSION = 'smoke';

function tmux(args, { allowFail = false } = {}) {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8' });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function hasSession(name) {
  return tmux(['has-session', '-t', name], { allowFail: true }) !== null;
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  tmux(['kill-session', '-t', SESSION], { allowFail: true });
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Clean slate.
  tmux(['kill-session', '-t', SESSION], { allowFail: true });

  // Create a detached session (the "owner" of the job).
  tmux(['new-session', '-d', '-s', SESSION]);
  if (!hasSession(SESSION)) fail('could not create session');

  // Attach to it via a node-pty. encoding: null => onData yields Buffers.
  const pty = ptySpawn('tmux', ['attach-session', '-t', SESSION], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    encoding: null,
  });

  let sawBuffer = false;
  let output = Buffer.alloc(0);
  pty.onData((data) => {
    if (Buffer.isBuffer(data)) sawBuffer = true;
    output = Buffer.concat([output, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
  });

  // Give the attach a moment to draw, then run a command inside the session.
  await sleep(500);
  pty.write('echo hello_from_pty\n');
  await sleep(800);

  if (!sawBuffer) fail('node-pty onData did not yield a Buffer (encoding: null not honored)');
  if (!output.toString('utf8').includes('hello_from_pty')) {
    fail(`did not read back expected output. Got: ${JSON.stringify(output.toString('utf8').slice(-200))}`);
  }
  console.log('  - pty output contained hello_from_pty (raw Buffer confirmed)');

  // Kill ONLY the pty (this detaches the tmux client). Job must survive.
  pty.kill();
  await sleep(600);

  if (!hasSession(SESSION)) fail('tmux session died after pty was killed (job did NOT survive detach)');
  console.log('  - tmux session survived pty kill (job outlived its viewer)');

  // Clean up.
  tmux(['kill-session', '-t', SESSION], { allowFail: true });
  if (hasSession(SESSION)) fail('cleanup: session still present after kill-session');

  console.log('\nPASS: pty+tmux detach model works on this box.');
  process.exit(0);
}

main().catch((err) => fail(err.stack || String(err)));
