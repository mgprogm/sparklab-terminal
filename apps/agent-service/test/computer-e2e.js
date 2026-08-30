/**
 * Virtual Computer (CUA) end-to-end test.
 *
 * Default (stub) mode: drives the REAL `ComputerRuntime` — real `spawn`, real
 * stdio pipes, real newline-delimited JSON-RPC — against a stub `docker` + stub
 * `cua-driver mcp` (test/cua-stub/). No image needed.
 *
 *   pnpm --filter @sparklab/agent-service test:computer-e2e
 *
 * Real mode (`CUA_E2E_REAL=1`): same runtime, same assertions, but against a
 * real desktop container. Needs Docker + the image built from
 * test/cua-real/Dockerfile:
 *
 *   docker build -t sparklab/cua-desktop:0.22.2 apps/agent-service/test/cua-real
 *   CUA_E2E_REAL=1 pnpm --filter @sparklab/agent-service test:computer-e2e
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REAL = !!process.env.CUA_E2E_REAL;
const here = dirname(fileURLToPath(import.meta.url));
const stubDir = join(here, "cua-stub");
const workdir = mkdtempSync(join(tmpdir(), "cua-e2e-"));
const stubLog = join(workdir, "docker.log");

// Must be set before ./src/config.js is imported.
process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";
process.env.CUA_ENABLED = "true";
// Deterministic per-instance sweep id (M2.3).
process.env.CUA_INSTANCE_ID = "e2e-instance";

const EGRESS_NET = REAL ? process.env.CUA_EGRESS_NETWORK || "" : "";
const HARDENED = REAL && process.env.CUA_HARDEN === "true";

if (REAL) {
  process.env.CUA_IMAGE ??= "sparklab/cua-desktop:0.22.2";
  process.env.CUA_DRIVER_USER ??= "cua";
  process.env.CUA_START_TIMEOUT_MS ??= "180000";
  process.env.CUA_SCREENSHOT_DIR ??= "/tmp";
  delete process.env.CUA_DOCKER_BIN; // real docker
  // CUA_EGRESS_NETWORK / CUA_HARDEN pass through from the caller.
} else {
  delete process.env.CUA_HARDEN;
  delete process.env.CUA_EGRESS_NETWORK;
  process.env.CUA_DOCKER_BIN = join(stubDir, "docker");
  process.env.CUA_STUB_LOG = stubLog;
  // Force a low desktop cap so the limiter check needs only 2 extra runtimes
  // (M2.2). Independent of the config default.
  process.env.MAX_CUA_DESKTOPS = "2";
}

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
      console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
    });

const readLog = () =>
  readFileSync(stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

console.log(
  `mode: ${REAL ? "REAL (" + process.env.CUA_IMAGE + ")" : "stub"}` +
    `${EGRESS_NET ? " egress=" + EGRESS_NET : ""}${HARDENED ? " hardened" : ""}\n`,
);

const rt = new ComputerRuntime(undefined, { label: "e2e-chat" });
let lastRevision = 0;

try {
  await check(
    "observe() starts the desktop and pulls a bounded snapshot",
    async () => {
      const result = await rt.observe();
      assert.ok(result.snapshot, "a snapshot is produced");
      assert.equal(result.snapshot.computerId, rt.computerId);
      assert.ok(result.snapshot.revision > 0);
      const { width, height } = result.snapshot.viewport;
      assert.ok(
        width > 0 && width <= 4096 && height > 0 && height <= 4096,
        `viewport ${width}x${height}`,
      );
      assert.equal(result.snapshot.screenshot.mediaType, "image/png");
      const bytes = Buffer.from(
        result.snapshot.screenshot.data,
        "base64",
      ).length;
      assert.ok(
        bytes > (REAL ? 1000 : 0),
        `screenshot decoded to ${bytes} bytes`,
      );
      assert.match(result.snapshotId, /^snap-\d+$/);
      assert.match(
        result.content,
        new RegExp(`snapshotId ${result.snapshotId}`),
      );
      assert.match(
        result.content,
        /xfce4-panel/,
        "window inventory is included",
      );
      lastRevision = result.snapshot.revision;
    },
  );

  if (EGRESS_NET) {
    await check(
      `the desktop container has NO route off-box (CUA_EGRESS_NETWORK=${EGRESS_NET})`,
      () => {
        const name = execFileSync(
          "docker",
          ["ps", "--filter", "label=sparklab-cua", "--format", "{{.Names}}"],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean)[0];
        assert.ok(name, "the runtime's container is running");
        // It is attached to the named network...
        const nets = execFileSync(
          "docker",
          ["inspect", name, "--format", "{{json .NetworkSettings.Networks}}"],
          { encoding: "utf8" },
        );
        assert.match(
          nets,
          new RegExp(EGRESS_NET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        // ...loopback still works (X-readiness relies on it)...
        execFileSync("docker", [
          "exec",
          name,
          "sh",
          "-lc",
          "curl -fsS -m 5 http://127.0.0.1:6901/vnc.html >/dev/null",
        ]);
        // ...and the public internet is unreachable.
        let reached = false;
        try {
          execFileSync(
            "docker",
            [
              "exec",
              name,
              "sh",
              "-lc",
              "curl -sS -m 6 -o /dev/null https://example.com",
            ],
            { stdio: "pipe" },
          );
          reached = true;
        } catch {
          // expected: no NAT on an --internal network
        }
        assert.equal(
          reached,
          false,
          "container reached the public internet — egress is NOT isolated",
        );
      },
    );
  }

  await check(
    "the emitted computer_view frame validates against the shared schema",
    async () => {
      const result = await rt.observe();
      AgentComputerViewSchema.parse({
        type: "computer_view",
        ...result.snapshot,
      });
      lastRevision = result.snapshot.revision;
    },
  );

  await check(
    "act(click) reaches the driver and relays an ActionResult (not refused)",
    async () => {
      const result = await rt.act({
        kind: "click",
        target: { x: 100, y: 100 },
      });
      assert.match(
        result.content,
        /effect=(confirmed|partial|unverifiable)/,
        result.content,
      );
      assert.doesNotMatch(result.content, /effect=refused/);
      assert.ok(result.snapshot, "a fresh snapshot is published");
      assert.ok(result.snapshot.revision > lastRevision);
      lastRevision = result.snapshot.revision;
    },
  );

  await check(
    "act() rejects a malformed target (no x,y) locally, without a driver round-trip",
    async () => {
      const before = REAL ? 0 : readLog().length;
      const result = await rt.act({
        kind: "click",
        // v1 has no element targeting; a target with no x,y is invalid and
        // must be refused by the runtime before any docker/driver call.
        target: {},
      });
      assert.match(result.content, /^error: target requires screen x \+ y/);
      if (!REAL)
        assert.equal(readLog().length, before, "no new docker/driver activity");
    },
  );

  await check("act(type_text) never echoes the typed text", async () => {
    const result = await rt.act({
      kind: "type_text",
      target: { x: 5, y: 5 },
      text: "sup3r-s3cret",
    });
    assert.match(result.content, /^typed \[redacted\]/);
    assert.doesNotMatch(result.content, /sup3r-s3cret/);
  });

  if (!REAL) {
    await check(
      "a 3rd concurrent desktop is refused by the limiter with no container spawned",
      async () => {
        // `rt` already holds desktop slot 1 (reserved on its first observe(),
        // released only in the finally). MAX_CUA_DESKTOPS=2, so extra1 takes
        // slot 2 and extra2's observe() must reject before any `docker run`.
        const runsBefore = readLog().filter((a) => a[0] === "run").length;
        const extra1 = new ComputerRuntime(undefined, { label: "limiter-a" });
        const extra2 = new ComputerRuntime(undefined, { label: "limiter-b" });
        try {
          await extra1.observe();
          await assert.rejects(
            () => extra2.observe(),
            /cua_desktop_limit_reached/,
            "the 3rd concurrent desktop is refused",
          );
          const runsAfter = readLog().filter((a) => a[0] === "run").length;
          assert.equal(
            runsAfter - runsBefore,
            1,
            "only extra1 spawned a container; the refused desktop spawned none",
          );
        } finally {
          await extra1.stop().catch(() => {});
          await extra2.stop().catch(() => {});
        }
      },
    );
  }

  await check("stop() tears the container down and is idempotent", async () => {
    const revision = await rt.stop();
    assert.ok(
      revision > lastRevision,
      "close revision advances past the last snapshot",
    );
    assert.equal(rt.isClosed, true);
    await rt.stop(); // must not throw
    if (REAL) {
      // The --rm container must be gone.
      const ps = execFileSync(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          "label=sparklab-cua",
          "--format",
          "{{.Names}}",
        ],
        { encoding: "utf8" },
      );
      assert.equal(ps.trim(), "", "no sparklab-cua container survives stop()");
    } else {
      // The limiter check above also stops its own throwaway runtimes, so match
      // the rm -f for THIS runtime's container specifically.
      const rm = readLog().find(
        (a) =>
          a[0] === "rm" &&
          a[1] === "-f" &&
          a.some((t) => t.startsWith("sparklab-cua-e2e-chat-")),
      );
      assert.ok(rm, "docker rm -f targeted this container");
    }
  });

  if (!REAL) {
    await check(
      "the driver was reached via `docker exec -i … cua-driver mcp --direct`",
      () => {
        const exec = readLog().find(
          (a) => a[0] === "exec" && a.includes("cua-driver"),
        );
        assert.ok(exec, "a docker exec for cua-driver happened");
        assert.deepEqual(exec.slice(-3), ["cua-driver", "mcp", "--direct"]);
        // The X-readiness probe ran first.
        assert.ok(
          readLog().some((a) => a[0] === "exec" && a.includes("sh")),
          "waitForXReady probed the container before spawning the driver",
        );
      },
    );
    await check(
      "`docker run` used both sweep labels and NO hardening flags by default",
      () => {
        const run = readLog().find((a) => a[0] === "run");
        assert.ok(run.includes("--label") && run.includes("sparklab-cua=1"));
        assert.ok(
          run.includes("sparklab-cua-instance=e2e-instance"),
          "the per-instance sweep label is applied (M2.3)",
        );
        assert.ok(
          !run.includes("--cap-drop") && !run.includes("no-new-privileges"),
        );
      },
    );
    await check(
      "sweepOrphans() lists containers scoped to this instance's sweep label",
      async () => {
        await ComputerRuntime.sweepOrphans();
        const ps = readLog().find((a) => a[0] === "ps");
        assert.deepEqual(ps, [
          "ps",
          "-aq",
          "--filter",
          "label=sparklab-cua-instance=e2e-instance",
        ]);
      },
    );
  }
} finally {
  await rt.stop().catch(() => {});
  rmSync(workdir, { recursive: true, force: true });
}

const failed = results.filter(([ok]) => !ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exit(failed.length ? 1 : 0);
