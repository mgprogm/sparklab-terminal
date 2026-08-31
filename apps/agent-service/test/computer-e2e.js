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
 *
 * Checks: 19 in stub mode (M2 baseline 10 + M3.1: element list in observe(),
 * act() by { elementIndex, snapshotId }, stale-snapshot local reject + M3.2/M3.3:
 * act(double_click) by element, act(right_click) by x,y, act(hotkey), act(drag)
 * by two points, drag-with-element-target rejected locally, listWindows()
 * summary); real mode adds two more (right_click by x,y not a transport error;
 * click a real AT-SPI element or note zero-element degradation) plus the
 * optional CUA_EGRESS_NETWORK isolation check.
 *
 * M3.5 proxied-browsing variant (CUA_E2E_REAL=1 CUA_PROXY_BROWSING=true, skipped
 * otherwise): adds one check — the desktop still reaches X-readiness with
 * http_proxy set (no_proxy held), `curl -x <proxy> https://example.com` from
 * inside succeeds, and `curl -x <proxy> http://169.254.169.254/` is refused by
 * the SafeProxy. `curl --noproxy '*'` still reaching the internet (blocker #3)
 * is documented in-comment, not asserted.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// The M3.5 proxied-browsing check drives `docker exec … curl` against a
// SafeBrowserProxy running IN THIS PROCESS — so it must NOT use the synchronous
// execFileSync (it would block the event loop and the proxy could never accept
// the connection). Everything else in this file stays sync as before.
const execFileAsync = promisify(execFile);

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

// M3.5 — proxied-browsing real-mode variant (CUA_E2E_REAL=1 CUA_PROXY_BROWSING=true).
// It is mutually exclusive with an --internal egress network — config.ts throws
// at load if both are set — so drop any inherited CUA_EGRESS_NETWORK on this
// path BEFORE ../src/config.js is imported below.
const PROXY_BROWSING = REAL && process.env.CUA_PROXY_BROWSING === "true";
if (PROXY_BROWSING) delete process.env.CUA_EGRESS_NETWORK;

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
    `${EGRESS_NET ? " egress=" + EGRESS_NET : ""}${HARDENED ? " hardened" : ""}` +
    `${PROXY_BROWSING ? " proxy-browsing" : ""}\n`,
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

  if (PROXY_BROWSING) {
    await check(
      "M3.5: desktop reached X-readiness WITH http_proxy set, and curl routes " +
        "public HTTP(S) through the SafeProxy while private/metadata is refused",
      async () => {
        // The first observe() above already succeeded, which means
        // waitForXReady's in-container `curl 127.0.0.1:<novncPort>` worked
        // despite http_proxy being set — i.e. no_proxy=127.0.0.1,localhost
        // held. This is the load-bearing assertion: a wrong no_proxy would
        // send that probe at the proxy and the desktop would never start.
        const name = execFileSync(
          "docker",
          ["ps", "--filter", "label=sparklab-cua", "--format", "{{.Names}}"],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .filter(Boolean)[0];
        assert.ok(name, "the runtime's container is running");

        // The proxy URL the runtime injected (http://host.docker.internal:<port>).
        // Async from here on: the proxy lives in this process's event loop, so a
        // blocking execFileSync would deadlock its accept().
        const { stdout: proxyUrlRaw } = await execFileAsync("docker", [
          "exec",
          name,
          "sh",
          "-lc",
          'printf %s "$http_proxy"',
        ]);
        const proxyUrl = proxyUrlRaw.trim();
        assert.match(
          proxyUrl,
          /^http:\/\/host\.docker\.internal:\d+$/,
          `http_proxy in the container = ${proxyUrl}`,
        );

        // Allowed public destination through the SafeProxy → 2xx/3xx.
        const { stdout: okCode } = await execFileAsync("docker", [
          "exec",
          name,
          "sh",
          "-lc",
          `curl -sS -m 20 -o /dev/null -w '%{http_code}' -x ${proxyUrl} https://example.com`,
        ]);
        assert.match(
          okCode.trim(),
          /^(2|3)\d\d$/,
          `example.com via proxy → ${okCode.trim()}`,
        );

        // Link-local / cloud-metadata through the SafeProxy → refused (403,
        // "blocked by browser network policy"). NOT a 2xx.
        const { stdout: denied } = await execFileAsync("docker", [
          "exec",
          name,
          "sh",
          "-lc",
          `curl -sS -m 20 -o /dev/null -w '%{http_code}' -x ${proxyUrl} http://169.254.169.254/ || true`,
        ]);
        assert.doesNotMatch(
          denied.trim(),
          /^2\d\d$/,
          `169.254.169.254 via proxy must be refused (got ${denied.trim()})`,
        );

        // BLOCKER #3 (documented, not asserted): `curl --noproxy '*'
        // https://example.com` from inside STILL reaches the internet — the
        // container keeps a default route off-box; the proxy is honoured, not
        // enforced. This mode is not a containment boundary.
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

  // ---- M3.1: per-window element targeting -------------------------------
  let firstElementIndex = -1;
  let elementSnapshotId = "";

  await check(
    "observe() returns a flat indexed AT-SPI element list (M3.1)",
    async () => {
      const result = await rt.observe();
      const line = result.content
        .split("\n")
        .find((l) => l.startsWith("elements ["));
      assert.ok(line, "an `elements [...]` line is present");
      const list = JSON.parse(line.slice("elements ".length));
      assert.ok(Array.isArray(list) && list.length > 0, "list is non-empty");
      for (const e of list) {
        assert.equal(typeof e.index, "number");
        assert.equal(typeof e.role, "string");
        assert.equal(typeof e.name, "string");
        assert.ok("windowId" in e);
      }
      firstElementIndex = list[0].index;
      elementSnapshotId = /snapshotId (\S+)/.exec(result.content)?.[1] ?? "";
      assert.ok(elementSnapshotId, "the observation carries a snapshotId");
      lastRevision = result.snapshot.revision;
    },
  );

  await check(
    "act(click) by { elementIndex, snapshotId } is dispatched, not refused",
    async () => {
      const result = await rt.act({
        kind: "click",
        target: {
          elementIndex: firstElementIndex,
          snapshotId: elementSnapshotId,
        },
      });
      assert.match(result.content, /^click computer element \d+/);
      assert.match(
        result.content,
        /effect=(confirmed|partial|unverifiable)/,
        result.content,
      );
      assert.doesNotMatch(result.content, /effect=refused/);
      assert.ok(result.snapshot, "a fresh snapshot is published");
      lastRevision = result.snapshot.revision;
    },
  );

  await check(
    "act() rejects a stale snapshotId locally, without a driver round-trip",
    async () => {
      const before = REAL ? 0 : readLog().length;
      const result = await rt.act({
        kind: "click",
        target: { elementIndex: 0, snapshotId: "snap-does-not-exist" },
      });
      assert.match(result.content, /^error: stale snapshotId/);
      if (!REAL)
        assert.equal(readLog().length, before, "no new docker/driver activity");
    },
  );

  // ---- M3.2 / M3.3: extra action family + window listing ---------------

  await check(
    "act(double_click) by { elementIndex, snapshotId } is dispatched, not refused (M3.2)",
    async () => {
      const obs = await rt.observe();
      const snap = /snapshotId (\S+)/.exec(obs.content)?.[1] ?? "";
      const line = obs.content
        .split("\n")
        .find((l) => l.startsWith("elements ["));
      const list = line ? JSON.parse(line.slice("elements ".length)) : [];
      assert.ok(list.length > 0, "an element to target");
      const result = await rt.act({
        kind: "double_click",
        target: { elementIndex: list[0].index, snapshotId: snap },
      });
      assert.doesNotMatch(result.content, /^error:/);
      assert.match(result.content, /^double_click computer element \d+/);
      assert.match(result.content, /effect=(confirmed|partial|unverifiable)/);
      assert.doesNotMatch(result.content, /effect=refused/);
      lastRevision = result.snapshot?.revision ?? lastRevision;
    },
  );

  await check(
    "act(right_click) by screen x,y resolves a window and is dispatched, not refused (M3.2)",
    async () => {
      await rt.observe(); // populate the window list windowAtPoint() reads
      const result = await rt.act({
        kind: "right_click",
        target: { x: 100, y: 100 },
      });
      assert.doesNotMatch(result.content, /^error:/, result.content);
      assert.match(result.content, /effect=(confirmed|partial|unverifiable)/);
      assert.doesNotMatch(result.content, /effect=refused/);
      lastRevision = result.snapshot?.revision ?? lastRevision;
    },
  );

  await check(
    "act(hotkey, ['ctrl','l']) is dispatched, not refused (M3.2)",
    async () => {
      const result = await rt.act({ kind: "hotkey", keys: ["ctrl", "l"] });
      assert.match(result.content, /^hotkey computer ctrl\+l/);
      assert.doesNotMatch(result.content, /^error:/);
      assert.match(result.content, /effect=(confirmed|partial|unverifiable)/);
      lastRevision = result.snapshot?.revision ?? lastRevision;
    },
  );

  await check(
    "act(drag) between two screen points is dispatched, not refused (M3.2)",
    async () => {
      const result = await rt.act({
        kind: "drag",
        target: { x: 10, y: 20 },
        to: { x: 60, y: 80 },
      });
      assert.match(result.content, /^drag desktop @ 10,20 → 60,80/);
      assert.doesNotMatch(result.content, /^error:/);
      assert.match(result.content, /effect=(confirmed|partial|unverifiable)/);
      lastRevision = result.snapshot?.revision ?? lastRevision;
    },
  );

  await check(
    "act(drag) with an element target is rejected locally (M3.2)",
    async () => {
      const obs = await rt.observe();
      const snap = /snapshotId (\S+)/.exec(obs.content)?.[1] ?? "";
      const before = REAL ? 0 : readLog().length;
      const result = await rt.act({
        kind: "drag",
        target: { elementIndex: 0, snapshotId: snap },
        to: { x: 1, y: 2 },
      });
      assert.match(result.content, /^error: drag cannot target an element/);
      if (!REAL)
        assert.equal(
          readLog().length,
          before,
          "no driver round-trip for a rejected drag",
        );
    },
  );

  await check(
    "listWindows() returns a bounded windows + apps summary (M3.3)",
    async () => {
      const text = await rt.listWindows();
      assert.match(text, /windows \[/);
      assert.match(text, REAL ? /"app":/ : /Thunar/);
      assert.match(text, /apps \[/);
      assert.doesNotMatch(text, /screenshot/);
      assert.ok(
        Buffer.byteLength(text) < 16384,
        `summary ${Buffer.byteLength(text)} bytes`,
      );
    },
  );

  if (REAL) {
    await check(
      "REAL: right_click by screen x,y returns an ActionResult, not a transport error (M3.2)",
      async () => {
        await rt.observe();
        const result = await rt.act({
          kind: "right_click",
          target: { x: 640, y: 450 },
        });
        // foreground delivery — may be unverifiable, must not be a transport
        // error or a local rejection.
        assert.doesNotMatch(
          result.content,
          /^error: |error: computer /,
          result.content,
        );
        assert.match(result.content, /effect=(confirmed|partial|unverifiable)/);
      },
    );
  }

  if (REAL) {
    await check(
      "REAL: if a window exposes elements, act(click) on the first one is not refused / a transport error",
      async () => {
        const result = await rt.observe();
        const line = result.content
          .split("\n")
          .find((l) => l.startsWith("elements ["));
        const list = line ? JSON.parse(line.slice("elements ".length)) : [];
        if (list.length === 0) {
          console.log(
            "      (real desktop exposed ZERO AT-SPI elements — element targeting degrades to x,y; acceptable v1 outcome)",
          );
          return;
        }
        const snap = /snapshotId (\S+)/.exec(result.content)?.[1] ?? "";
        const act = await rt.act({
          kind: "click",
          target: { elementIndex: list[0].index, snapshotId: snap },
        });
        assert.doesNotMatch(act.content, /effect=refused|error: /, act.content);
        assert.match(act.content, /effect=(confirmed|partial|unverifiable)/);
      },
    );
  }

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
