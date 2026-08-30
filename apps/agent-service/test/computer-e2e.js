/**
 * Virtual Computer (CUA) end-to-end test.
 *
 * Drives the REAL `ComputerRuntime` — real `spawn`, real stdio pipes, real
 * newline-delimited JSON-RPC — against a stub `docker` + stub `cua-driver mcp`
 * (test/cua-stub/). A live `trycua/xfce-cua` image is not needed here; this
 * covers the whole path that image would exercise: container start →
 * `docker exec -i` → MCP handshake → observe/act → bounded `computer_view`
 * frame (schema-validated) → teardown → orphan sweep.
 *
 * Run:  pnpm --filter @sparklab/agent-service test:computer-e2e
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stubDir = join(here, "cua-stub");
const workdir = mkdtempSync(join(tmpdir(), "cua-e2e-"));
const stubLog = join(workdir, "docker.log");

// Must be set before ./src/config.js is imported.
process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.CUA_ENABLED = "true";
process.env.CUA_DOCKER_BIN = join(stubDir, "docker");
process.env.CUA_STUB_LOG = stubLog;
delete process.env.CUA_HARDEN;
delete process.env.CUA_EGRESS_NETWORK;

const { ComputerRuntime } = await import("../src/computer-runtime.js");
const { AgentComputerViewSchema } = await import("@sparklab/shared-types");

const results = [];
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([true, name]);
      console.log(`PASS  ${name}`);
    })
    .catch((error) => {
      results.push([false, name]);
      console.log(`FAIL  ${name}\n      ${error.message}`);
    });

const readLog = () =>
  readFileSync(stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const rt = new ComputerRuntime(undefined, { label: "e2e-chat" });
let observeSnapshotRevision = 0;

try {
  await check(
    "observe() starts the desktop and returns a bounded snapshot",
    async () => {
      const result = await rt.observe();
      assert.ok(result.snapshot, "a snapshot is produced");
      assert.equal(result.snapshot.computerId, rt.computerId);
      assert.ok(result.snapshot.revision > 0);
      assert.deepEqual(result.snapshot.viewport, { width: 800, height: 600 });
      assert.equal(result.snapshot.screenshot.mediaType, "image/png");
      assert.ok(result.snapshot.screenshot.data.length > 0);
      assert.equal(
        result.snapshotId,
        "drv-e2e-1",
        "driver snapshot_id is threaded through",
      );
      assert.match(result.content, /viewport 800x600/);
      assert.match(result.content, /snapshotId drv-e2e-1/);
      assert.match(result.content, /"role":"button"/);
      observeSnapshotRevision = result.snapshot.revision;
    },
  );

  await check(
    "the emitted computer_view frame validates against the shared schema",
    async () => {
      const result = await rt.observe();
      const frame = { type: "computer_view", ...result.snapshot };
      AgentComputerViewSchema.parse(frame); // throws on any contract violation
      observeSnapshotRevision = result.snapshot.revision;
    },
  );

  await check(
    "act(click) reaches the driver and relays a confirmed ActionResult",
    async () => {
      const result = await rt.act({
        kind: "click",
        target: { elementIndex: 0, snapshotId: "drv-e2e-1" },
      });
      assert.match(result.content, /effect=confirmed/);
      assert.match(result.content, /delivery=background/);
      assert.match(
        result.content,
        /viewport 800x600/,
        "carries a fresh observation",
      );
      assert.ok(result.snapshot, "a fresh snapshot is published");
      assert.ok(result.snapshot.revision > observeSnapshotRevision);
    },
  );

  await check(
    "act() rejects a stale snapshotId locally, without a driver round-trip",
    async () => {
      const before = readLog().length;
      const result = await rt.act({
        kind: "click",
        target: { elementIndex: 0, snapshotId: "stale" },
      });
      assert.match(result.content, /^error: stale snapshotId/);
      assert.equal(readLog().length, before, "no new docker/driver activity");
    },
  );

  await check("act(type_text) never echoes the typed text", async () => {
    const result = await rt.act({
      kind: "type_text",
      target: { windowId: "w1", x: 5, y: 5 },
      text: "sup3r-s3cret",
    });
    assert.match(result.content, /^typed \[redacted\]/);
    assert.doesNotMatch(result.content, /sup3r-s3cret/);
  });

  await check(
    "stop() tears the container down (docker rm -f) and is idempotent",
    async () => {
      const lastRevision = observeSnapshotRevision;
      const revision = await rt.stop();
      assert.ok(
        revision > lastRevision,
        "close revision advances past the last snapshot",
      );
      assert.equal(rt.isClosed, true);
      await rt.stop(); // second call must not throw
      const rm = readLog().find((argv) => argv[0] === "rm" && argv[1] === "-f");
      assert.ok(rm, "docker rm -f was issued");
      assert.ok(
        rm.some((token) => token.startsWith("sparklab-cua-e2e-chat-")),
        "it targeted this runtime's container",
      );
    },
  );

  await check(
    "the driver was reached via `docker exec -i … cua-driver mcp --direct`",
    () => {
      const exec = readLog().find((argv) => argv[0] === "exec");
      assert.ok(exec, "a docker exec happened");
      assert.deepEqual(exec.slice(-3), ["cua-driver", "mcp", "--direct"]);
    },
  );

  await check(
    "`docker run` used the sweep label and NO hardening flags by default",
    () => {
      const run = readLog().find((argv) => argv[0] === "run");
      assert.ok(run, "a docker run happened");
      assert.ok(run.includes("--label") && run.includes("sparklab-cua=1"));
      assert.ok(
        !run.includes("--cap-drop"),
        "CUA_HARDEN unset → no --cap-drop",
      );
      assert.ok(!run.includes("no-new-privileges"));
    },
  );

  await check(
    "sweepOrphans() lists containers by the sweep label",
    async () => {
      await ComputerRuntime.sweepOrphans();
      const ps = readLog().find((argv) => argv[0] === "ps");
      assert.ok(ps, "docker ps was issued");
      assert.deepEqual(ps, ["ps", "-aq", "--filter", "label=sparklab-cua"]);
    },
  );
} finally {
  await rt.stop().catch(() => {});
  rmSync(workdir, { recursive: true, force: true });
}

const failed = results.filter(([ok]) => !ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exit(failed.length ? 1 : 0);
