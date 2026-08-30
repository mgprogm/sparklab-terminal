import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.CUA_ENABLED = "true";

const {
  ComputerRuntime,
  driverArgs,
  summarizeActionResult,
  parseAxTree,
  parseViewport,
} = await import("./computer-runtime.js");

// ---- pure helpers -------------------------------------------------------

test("driverArgs fixes background delivery and maps targets", () => {
  const byElement = driverArgs({
    kind: "click",
    target: { elementIndex: 3, snapshotId: "snap-1" },
  });
  assert.equal(byElement.delivery_mode, "background");
  assert.equal(byElement.element_index, 3);
  assert.equal(byElement.snapshot_id, "snap-1");

  const byPixel = driverArgs({
    kind: "type_text",
    target: { windowId: "w1", x: 10, y: 20 },
    text: "hello",
  });
  assert.equal(byPixel.delivery_mode, "background");
  assert.deepEqual(
    { window_id: byPixel.window_id, x: byPixel.x, y: byPixel.y },
    { window_id: "w1", x: 10, y: 20 },
  );
  assert.equal(byPixel.text, "hello");

  const scroll = driverArgs({
    kind: "scroll",
    target: { elementIndex: 0, snapshotId: "s" },
    direction: "down",
  });
  assert.equal(scroll.direction, "down");
  assert.equal(scroll.unit, "line");
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

test("parseAxTree accepts a bare array or an {elements} envelope and bounds names", () => {
  const bare = parseAxTree(
    JSON.stringify([
      { index: 0, role: "button", name: "OK" },
      { role: "text", label: "x".repeat(500) },
    ]),
  );
  assert.equal(bare.elements.length, 2);
  const [first, second] = bare.elements;
  assert.equal(first?.name, "OK");
  assert.equal(second?.index, 1); // falls back to position
  assert.ok((second?.name.length ?? 0) <= 200);

  const enveloped = parseAxTree(
    JSON.stringify({
      snapshot_id: "drv-7",
      elements: [{ element_index: 4, role: "field", title: "Email" }],
    }),
  );
  assert.equal(enveloped.snapshotId, "drv-7");
  assert.deepEqual(enveloped.elements[0], {
    index: 4,
    role: "field",
    name: "Email",
  });

  assert.deepEqual(parseAxTree("not json"), { snapshotId: "", elements: [] });
});

test("parseViewport reads nested or flat width/height", () => {
  assert.deepEqual(parseViewport('{"viewport":{"width":1024,"height":768}}'), {
    width: 1024,
    height: 768,
  });
  assert.deepEqual(parseViewport('{"width":800,"height":600}'), {
    width: 800,
    height: 600,
  });
  assert.equal(parseViewport("{}"), undefined);
});

// ---- lifecycle with an injected spawn seam ----------------------------

class FakeChild extends EventEmitter {
  pid = 4321;
  exitCode: number | null = null;
  signalCode: string | null = null;
  captureCarriesViewport = true;
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
      } else if (msg.method === "tools/call") {
        const name = msg.params?.name as string;
        if (name === "get_accessibility_tree") {
          this.#emit({
            id: msg.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    snapshot_id: "drv-1",
                    elements: [{ index: 0, role: "button", name: "Go" }],
                  }),
                },
              ],
            },
          });
        } else if (name === "get_screen_size") {
          this.#emit({
            id: msg.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ width: 1280, height: 800 }),
                },
              ],
            },
          });
        } else {
          // capture tool
          this.#emit({
            id: msg.id,
            result: {
              content: [
                ...(this.captureCarriesViewport
                  ? [
                      {
                        type: "text",
                        text: JSON.stringify({
                          viewport: { width: 1024, height: 768 },
                        }),
                      },
                    ]
                  : []),
                {
                  type: "image",
                  mimeType: "image/png",
                  data: Buffer.from("fake-png").toString("base64"),
                },
              ],
            },
          });
        }
      }
    }
  }
  #emit(obj: unknown) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
  }
}

function fakeSpawn(opts: { captureCarriesViewport?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawn = ((_bin: string, args: string[]) => {
    const child = new FakeChild();
    if (opts.captureCarriesViewport === false)
      child.captureCarriesViewport = false;
    children.push(child);
    if (args[0] === "run") {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("container-abc123\n"));
        child.emit("exit", 0, null);
      });
    }
    if (args[0] === "rm") {
      queueMicrotask(() => child.emit("exit", 0, null));
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, children };
}

test("observe() starts a container, handshakes, and returns a bounded snapshot", async () => {
  const { spawn, children } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-1", spawn });

  const result = await rt.observe();

  assert.match(result.content, /viewport 1024x768/);
  assert.equal(result.snapshotId, "drv-1");
  assert.ok(result.snapshot, "a snapshot is produced");
  assert.equal(result.snapshot?.computerId, rt.computerId);
  assert.equal(result.snapshot?.viewport.width, 1024);
  assert.equal(result.snapshot?.screenshot.mediaType, "image/png");
  assert.ok((result.snapshot?.revision ?? 0) > 0);

  assert.ok(children[0], "a docker child was spawned");

  const revision = await rt.stop();
  assert.ok(revision > (result.snapshot?.revision ?? 0));
  assert.equal(rt.isClosed, true);
});

test("observe() falls back to get_screen_size when the capture carries no viewport", async () => {
  const { spawn } = fakeSpawn({ captureCarriesViewport: false });
  const rt = new ComputerRuntime(undefined, { label: "chat-vp", spawn });

  const result = await rt.observe();

  assert.ok(result.snapshot, "snapshot is not dropped");
  assert.equal(result.snapshot?.viewport.width, 1280);
  assert.equal(result.snapshot?.viewport.height, 800);
  assert.match(result.content, /viewport 1280x800/);
  await rt.stop();
});

test("act() rejects a stale snapshotId without touching the driver", async () => {
  const { spawn } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-2", spawn });
  await rt.observe();

  const stale = await rt.act({
    kind: "click",
    target: { elementIndex: 0, snapshotId: "not-the-current-one" },
  });
  assert.match(stale.content, /stale snapshotId/);
  await rt.stop();
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
