import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.CUA_ENABLED = "true";
process.env.CUA_INSTANCE_ID = "testinst";

const { ComputerRuntime, driverArgs, summarizeActionResult } =
  await import("./computer-runtime.js");
const { config } = await import("./config.js");

// ---- pure helpers -------------------------------------------------------

test("driverArgs fixes background delivery and maps targets (0.22.2)", () => {
  // Pixel click → desktop-scope screen coordinates.
  const pixelClick = driverArgs({ kind: "click", target: { x: 10, y: 20 } });
  assert.equal(pixelClick.delivery_mode, "background");
  assert.deepEqual(
    { scope: pixelClick.scope, x: pixelClick.x, y: pixelClick.y },
    { scope: "desktop", x: 10, y: 20 },
  );

  // Pixel type_text → desktop scope, focused app, no x/y.
  const pixelType = driverArgs({
    kind: "type_text",
    target: { x: 10, y: 20 },
    text: "hello",
  });
  assert.equal(pixelType.scope, "desktop");
  assert.equal(pixelType.text, "hello");
  assert.equal(pixelType.x, undefined);

  const scroll = driverArgs({
    kind: "scroll",
    target: { x: 5, y: 5 },
    direction: "down",
  });
  assert.equal(scroll.direction, "down");
  assert.equal(scroll.by, "line");
});

test("summarizeActionResult surfaces effect, route, delivery, and refusal reason", () => {
  assert.equal(
    summarizeActionResult({
      effect: "confirmed",
      route: "accessibility",
      delivery: { mode: "background" },
    }),
    "effect=confirmed route=accessibility delivery=background",
  );
  assert.equal(
    summarizeActionResult({
      effect: "refused",
      code: "background_unavailable",
      escalation: { reason: "route_unavailable" },
    }),
    "effect=refused code=background_unavailable reason=route_unavailable",
  );
  assert.match(summarizeActionResult(null), /effect=unknown/);
});

// ---- lifecycle with an injected spawn seam ----------------------------
// Fakes the 0.22.2 contract: get_desktop_state writes a PNG to a container
// file and returns screen dims; the runtime pulls the bytes with
// `docker exec … base64`.

const FAKE_PNG_B64 = Buffer.from("fake-png").toString("base64");

class FakeChild extends EventEmitter {
  pid = 4321;
  exitCode: number | null = null;
  signalCode: string | null = null;
  captureCarriesDims = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  stdin = {
    writable: true,
    write: (chunk: string) => {
      this.written.push(chunk);
      queueMicrotask(() => this.#reply(chunk));
      return true;
    },
    end: () => {
      this.stdin.writable = false;
    },
  };
  kill() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
  #reply(chunk: string) {
    for (const line of chunk.split("\n").filter(Boolean)) {
      let msg: { id?: number; method?: string; params?: any };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue;
      if (msg.method === "initialize") {
        this.#emit({ id: msg.id, result: { protocolVersion: "2025-06-18" } });
        continue;
      }
      if (msg.method !== "tools/call") continue;
      const name = msg.params?.name as string;
      const path = msg.params?.arguments?.screenshot_out_file ?? "/tmp/x.png";
      if (name === "get_desktop_state") {
        this.#emit({
          id: msg.id,
          result: {
            content: [{ type: "text", text: `written to ${path}` }],
            structuredContent: this.captureCarriesDims
              ? {
                  screen_width: 1024,
                  screen_height: 768,
                  screenshot_file_path: path,
                  screenshot_mime_type: "image/png",
                }
              : { screenshot_file_path: path },
          },
        });
      } else if (name === "list_windows") {
        this.#emit({
          id: msg.id,
          result: {
            content: [{ type: "text", text: "1 window" }],
            structuredContent: {
              windows: [
                {
                  window_id: 9,
                  pid: 1,
                  title: "term",
                  app_name: "X",
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 20,
                },
              ],
            },
          },
        });
      } else if (name === "get_screen_size") {
        this.#emit({
          id: msg.id,
          result: {
            content: [{ type: "text", text: "1280x800" }],
            structuredContent: { width: 1280, height: 800, scale_factor: 1 },
          },
        });
      } else {
        this.#emit({
          id: msg.id,
          result: {
            content: [],
            structuredContent: {
              effect: "confirmed",
              route: "accessibility",
              delivery: { mode: "background" },
            },
          },
        });
      }
    }
  }
  #emit(obj: unknown) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
  }
}

function fakeSpawn(opts: { captureCarriesDims?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawn = ((_bin: string, args: string[]) => {
    const child = new FakeChild();
    child.captureCarriesDims = opts.captureCarriesDims !== false;
    children.push(child);
    const a = args;
    if (a[0] === "run") {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("container-abc123\n"));
        child.emit("exit", 0, null);
      });
    } else if (a[0] === "rm" || a[0] === "ps") {
      queueMicrotask(() => child.emit("exit", 0, null));
    } else if (a[0] === "exec") {
      let i = 1;
      while (i < a.length) {
        if (a[i] === "-i") i += 1;
        else if (a[i] === "-u" || a[i] === "-e") i += 2;
        else break;
      }
      const cmd = a[i + 1];
      if (cmd === "base64") {
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(FAKE_PNG_B64));
          child.emit("exit", 0, null);
        });
      } else if (cmd === "rm" || cmd === "sh") {
        // "sh" = the waitForXReady probe; always "ready" under test.
        queueMicrotask(() => child.emit("exit", 0, null));
      }
      // cmd === "cua-driver" → the long-lived MCP child, driven via stdin
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, children };
}

test("observe() starts a container, handshakes, pulls a bounded snapshot", async () => {
  const { spawn, children } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-1", spawn });

  const result = await rt.observe();

  assert.match(result.content, /viewport 1024x768/);
  assert.match(result.snapshotId, /^snap-\d+$/);
  assert.match(
    result.content,
    /"title":"term"/,
    "window inventory is included",
  );
  assert.ok(result.snapshot, "a snapshot is produced");
  assert.equal(result.snapshot?.computerId, rt.computerId);
  assert.equal(result.snapshot?.viewport.width, 1024);
  assert.equal(result.snapshot?.screenshot.mediaType, "image/png");
  assert.equal(result.snapshot?.screenshot.data, FAKE_PNG_B64);
  assert.ok((result.snapshot?.revision ?? 0) > 0);

  assert.ok(children[0], "a docker child was spawned");

  const revision = await rt.stop();
  assert.ok(revision > (result.snapshot?.revision ?? 0));
  assert.equal(rt.isClosed, true);
});

test("observe() falls back to get_screen_size when the capture carries no dims", async () => {
  const { spawn } = fakeSpawn({ captureCarriesDims: false });
  const rt = new ComputerRuntime(undefined, { label: "chat-vp", spawn });

  const result = await rt.observe();

  assert.ok(result.snapshot, "snapshot is not dropped");
  assert.equal(result.snapshot?.viewport.width, 1280);
  assert.equal(result.snapshot?.viewport.height, 800);
  assert.match(result.content, /viewport 1280x800/);
  await rt.stop();
});

test("act() rejects a malformed target (no x,y) locally, without a driver round-trip", async () => {
  const { spawn, children } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-2", spawn });
  await rt.observe();
  const spawnCountAfterObserve = children.length;

  const bad = await rt.act({
    kind: "click",
    // v1 has no element targeting — a target with no x,y is invalid.
    target: {} as unknown as { x: number; y: number },
  });
  assert.match(bad.content, /^error: target requires screen x \+ y/);
  assert.equal(
    children.length,
    spawnCountAfterObserve,
    "no new docker/driver child was spawned",
  );
  await rt.stop();
});

test("sweepOrphans() scopes the ps filter to this instance and rm -f's only its ids", async () => {
  assert.equal(config.cua.instanceId, "testinst");
  const calls: string[][] = [];
  const spawn = ((_bin: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push(args);
    queueMicrotask(() => {
      if (args[0] === "ps") {
        // Emulate `docker ps --filter` server-side filtering: only when the
        // instance-scoped label is asked for do we return this instance's ids.
        const scoped = args.includes(
          `label=sparklab-cua-instance=${config.cua.instanceId}`,
        );
        child.stdout.emit(
          "data",
          Buffer.from(
            scoped ? "mine-1\nmine-2\n" : "mine-1\nmine-2\nother-1\n",
          ),
        );
        child.emit("exit", 0);
      } else {
        child.emit("exit", 0);
      }
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  await ComputerRuntime.sweepOrphans(spawn);

  const ps = calls.find((a) => a[0] === "ps");
  assert.deepEqual(ps, [
    "ps",
    "-aq",
    "--filter",
    "label=sparklab-cua-instance=testinst",
  ]);
  const rm = calls.find((a) => a[0] === "rm");
  assert.deepEqual(
    rm,
    ["rm", "-f", "mine-1", "mine-2"],
    "only this instance's containers are removed",
  );
});

test("stop() is idempotent and issues docker rm -f", async () => {
  const { spawn, children } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-3", spawn });
  await rt.observe();
  await rt.stop();
  await rt.stop(); // no throw

  // one of the docker invocations after startup is `rm -f <name>`
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.isClosed, true);
});
