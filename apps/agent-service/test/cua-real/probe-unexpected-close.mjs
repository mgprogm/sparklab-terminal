/**
 * Direct verification of the unexpected-close reservation-release fix,
 * against a REAL ComputerRuntime + REAL docker container — no chat/WS/agent
 * loop involved, so it's immune to the frontend/gateway flakiness that
 * derailed the live-UI attempt at this same check (2026-08-31).
 *
 * Starts one real desktop via ComputerRuntime.observe(), confirms the
 * process-wide computerResources reservation is at 1, then kills the
 * container OUT FROM UNDER the runtime with a raw `docker rm -f` (simulating
 * a crash / OOM / an operator's stray removal — NOT rt.stop()/dispose()),
 * and asserts:
 *   (a) onUnexpectedClose fires
 *   (b) the reservation returns to 0 (the actual bug this session found:
 *       it stayed leaked at 1 forever without the fix)
 *
 * Run (from apps/agent-service, so `tsx` resolves as a dependency):
 *   node --import tsx test/cua-real/probe-unexpected-close.mjs
 */
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.CUA_ENABLED = "true";
process.env.CUA_IMAGE ??= "sparklab/cua-desktop:0.22.2";
process.env.CUA_DRIVER_USER ??= "cua";
process.env.CUA_DRIVER_PERMISSION_MODE ??= "standard";

const { ComputerRuntime } = await import("../../src/computer-runtime.js");
const { computerResources } =
  await import("../../src/computer-resource-limiter.js");
const { spawnSync } = await import("node:child_process");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

const baseline = computerResources.snapshot().activeDesktops;
console.log("baseline activeDesktops:", baseline);

let events = [];
const rt = new ComputerRuntime((computerId, revision) => {
  events.push({ computerId, revision });
  console.log("onUnexpectedClose fired:", { computerId, revision });
});

console.log("starting a real desktop (observe())...");
const result = await rt.observe();
console.log("observe() ok:", !result.content.startsWith("error:"));
const afterStart = computerResources.snapshot().activeDesktops;
console.log("activeDesktops after observe():", afterStart);
if (afterStart !== baseline + 1) {
  console.error("FAIL: observe() did not reserve a slot as expected");
  process.exit(1);
}

const container = rt.computerId; // ComputerRuntime names containers by its id
// Find the real container name via `docker ps` (label-scoped), since the
// container name has a random suffix appended at start().
const ps = docker([
  "ps",
  "-a",
  "--filter",
  "label=sparklab-cua",
  "--format",
  "{{.Names}}",
]);
const names = ps.stdout.trim().split("\n").filter(Boolean);
console.log("live containers:", names);
if (names.length !== 1) {
  console.error(`FAIL: expected exactly 1 container, found ${names.length}`);
  process.exit(1);
}
const name = names[0];

console.log(`killing container ${name} externally (docker rm -f) ...`);
const rm = docker(["rm", "-f", name]);
console.log("docker rm -f exit code:", rm.status);

// Give the child process's own 'exit' event + the async dispose() chain time
// to run.
await new Promise((r) => setTimeout(r, 4000));

const afterKill = computerResources.snapshot().activeDesktops;
console.log("activeDesktops after external kill:", afterKill);
console.log("onUnexpectedClose events:", events.length);
console.log("rt.isClosed:", rt.isClosed);

const remaining = docker([
  "ps",
  "-a",
  "--filter",
  "label=sparklab-cua",
  "--format",
  "{{.Names}}",
]).stdout.trim();
console.log("remaining containers:", remaining || "(none)");

let ok = true;
if (events.length !== 1) {
  console.error("FAIL: onUnexpectedClose did not fire exactly once");
  ok = false;
}
if (!rt.isClosed) {
  console.error("FAIL: rt.isClosed is false — runtime never disposed");
  ok = false;
}
if (afterKill !== baseline) {
  console.error(
    `FAIL: reservation leaked — activeDesktops is ${afterKill}, expected ${baseline}`,
  );
  ok = false;
}
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
