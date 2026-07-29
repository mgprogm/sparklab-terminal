// Unit tests for agent-runtime.parseResult (R8 — claude stream-json parsing).
//
// parseResult must extract the router/eval `BRANCH:` + `SCORE:` verdict from
// BOTH claude-cli `--output-format stream-json` (the agent text is buried inside
// JSON envelopes) AND plaintext (codex-cli + the test stub). Before R8 it only
// scanned plaintext, so real claude verdicts never parsed — router/eval would
// misfire in production. These cases pin both paths.
//
// The claude fixtures below mirror the REAL envelope shapes emitted by claude
// 2.1.220 (`{type:"system"|"assistant"|"result"|"rate_limit_event"}`), verified
// by capturing live `claude -p --output-format stream-json --verbose` output.
//
// Run: node test/parse-result.js   (or: pnpm --filter @sparklab/terminal-gateway test:parse)

import runtime from "../src/agent-runtime.js";

const { parseResult } = runtime;

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
function eq(a, b, msg) {
  assert(
    a === b,
    `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
  );
}

// ---- Real claude stream-json: verdict in BOTH the assistant turn and the final
// `result` message (the definitive final text). Noise lines must be ignored. ----
const CLAUDE_STREAM = [
  '{"type":"system","subtype":"hook_started","hook_name":"pre"}',
  '{"type":"system","subtype":"init","session_id":"7a4dfdf2-ba72-418f-9c6a-a7f4748017fc","tools":[],"apiKeySource":"none"}',
  '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"BRANCH: done\\nSCORE: 8"}]},"session_id":"7a4dfdf2"}',
  '{"type":"rate_limit_event","input_tokens":2}',
  '{"type":"result","subtype":"success","is_error":false,"result":"BRANCH: done\\nSCORE: 8","session_id":"7a4dfdf2","total_cost_usd":0.01}',
].join("\n");
{
  const r = parseResult(CLAUDE_STREAM, 0);
  eq(r.status, "done", "claude stream-json: status done on exit 0");
  eq(
    r.branch,
    "done",
    "claude stream-json: BRANCH parsed from result envelope",
  );
  eq(r.score, 8, "claude stream-json: SCORE parsed from result envelope");
  console.log(
    "  ok: real claude stream-json → BRANCH/SCORE extracted from result envelope",
  );
}

// ---- Claude stream WITHOUT a final result line (truncated log): fall back to
// the assistant text blocks. ----
const CLAUDE_ASSISTANT_ONLY = [
  '{"type":"system","subtype":"init","session_id":"s1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"working...\\nBRANCH: revise\\nSCORE: 3"}]}}',
].join("\n");
{
  const r = parseResult(CLAUDE_ASSISTANT_ONLY, 0);
  eq(r.branch, "revise", "claude assistant-only: BRANCH from assistant text");
  eq(r.score, 3, "claude assistant-only: SCORE from assistant text");
  console.log(
    "  ok: truncated claude stream (no result line) → falls back to assistant text",
  );
}

// ---- The `result` field is DEFINITIVE: an intermediate assistant turn says
// `revise`, the final result says `pass`. The final result must win. ----
const CLAUDE_CHANGED_MIND = [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"BRANCH: revise"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"actually looks good\\nBRANCH: pass"}]}}',
  '{"type":"result","subtype":"success","result":"BRANCH: pass"}',
].join("\n");
{
  const r = parseResult(CLAUDE_CHANGED_MIND, 0);
  eq(
    r.branch,
    "pass",
    "claude: final result field wins over intermediate assistant BRANCH",
  );
  console.log(
    "  ok: final result envelope is authoritative over intermediate turns",
  );
}

// ---- Plaintext (codex / the test stub): behavior MUST be identical to pre-R8.
// This is what the 350+ router/eval tests rely on. ----
{
  const r = parseResult(
    "STUB-PROVIDER-RAN\nBRANCH: go\nSCORE: 5\nSTUB-DONE-OK",
    0,
  );
  eq(r.branch, "go", "plaintext stub: BRANCH unchanged");
  eq(r.score, 5, "plaintext stub: SCORE unchanged");
  console.log("  ok: plaintext (codex/stub) path unchanged — regression-safe");
}

// ---- Plaintext with NO verdict → nulls. ----
{
  const r = parseResult("just some output\nno verdict here", 0);
  eq(r.branch, null, "plaintext no verdict: branch null");
  eq(r.score, null, "plaintext no verdict: score null");
  console.log("  ok: plaintext without verdict → null branch/score");
}

// ---- A plaintext log that happens to contain a coincidental JSON-parseable line
// (a bare number / string) must NOT lose the plaintext BRANCH scan. ----
{
  const r = parseResult('42\n"hello"\nBRANCH: fix\nSCORE: 1', 0);
  eq(
    r.branch,
    "fix",
    "coincidental-JSON plaintext: BRANCH still scanned from raw text",
  );
  eq(r.score, 1, "coincidental-JSON plaintext: SCORE still scanned");
  console.log(
    "  ok: coincidental JSON lines don't defeat the plaintext fallback",
  );
}

// ---- Last BRANCH wins within plaintext (existing semantics). ----
{
  const r = parseResult("BRANCH: first\nmore\nBRANCH: second", 0);
  eq(r.branch, "second", "plaintext: last BRANCH wins");
  console.log("  ok: last BRANCH wins (plaintext)");
}

// ---- Exit code drives status; parsing is independent. ----
{
  const r = parseResult(CLAUDE_STREAM, 7);
  eq(r.status, "failed", "nonzero exit → status failed");
  eq(r.branch, "done", "branch still parsed regardless of status");
  console.log("  ok: nonzero exit → failed, branch still parsed");
}

// ---- Robustness: empty / garbage / null must not throw. ----
{
  for (const bad of [
    "",
    null,
    undefined,
    "\n\n",
    "{not json",
    '{"type":"assistant"}',
  ]) {
    const r = parseResult(bad, 0);
    assert(
      r && r.branch === null && r.score === null,
      `garbage input tolerated: ${JSON.stringify(bad)}`,
    );
  }
  console.log(
    "  ok: empty/garbage/malformed input tolerated (no throw, null verdict)",
  );
}

console.log(`\nPASS (${checks} checks)`);
