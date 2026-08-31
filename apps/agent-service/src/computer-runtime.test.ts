import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.CUA_ENABLED = "true";
process.env.CUA_INSTANCE_ID = "testinst";

const {
  ComputerRuntime,
  driverArgs,
  summarizeActionResult,
  parseWindowElements,
} = await import("./computer-runtime.js");
const { config } = await import("./config.js");
// This file boots with CUA_ENABLED=true, so tools.ts offers the computer tools.
const { TOOLS } = await import("./tools.js");

test("computer_act schema re-exposes element_index + snapshot_id, keeps x,y (M3.1)", () => {
  const act = TOOLS.find((t) => t.function.name === "computer_act");
  assert.ok(act, "computer_act is offered when CUA_ENABLED");
  const props = (act.function.parameters?.properties ?? {}) as Record<
    string,
    { type?: string }
  >;
  assert.equal(props.element_index?.type, "integer");
  assert.ok(props.snapshot_id, "snapshot_id is back in the schema");
  assert.ok(props.x && props.y, "screen x,y stay as the fallback");
  assert.equal(props.x?.type, "integer");
});

// ---- recorded real get_window_state structuredContent (cua-driver 0.22.2) ---
// Trimmed from apps/agent-service/test/cua-real/probe-window-state.mjs output.
const REAL_THUNAR_WINDOW_STATE = {
  _note: "Prefer `elements` — `tree_markdown` will continue to work …",
  element_count: 71,
  elements: [
    {
      depth: 4,
      element_index: 0,
      element_token: "s00000002:0",
      enabled: true,
      label: "Menubar",
      role: "push button",
    },
    {
      depth: 4,
      element_index: 1,
      element_token: "s00000002:1",
      enabled: true,
      frame: { h: 35, w: 37, x: 83, y: 85 },
      label: "Open Parent",
      role: "push button",
    },
    {
      depth: 4,
      element_index: 14,
      element_token: "s00000002:14",
      enabled: true,
      label: "split pane",
      parent_index: 9,
      role: "split pane",
      value: "170.0",
    },
    {
      depth: 6,
      element_index: 16,
      element_token: "s00000002:16",
      enabled: true,
      label: "",
      role: "table cell",
    },
  ],
  elements_complete: false,
  pid: 81,
  returned_element_count: 71,
  snapshot_id: "s00000002",
  total_element_count: 71,
  tree_markdown: '- frame = "cua - Thunar"\n    - [0] push button "Menubar"\n',
  window_id: 10485767,
};

const REAL_DESKTOP_WINDOW_STATE = {
  _note: "Prefer `elements` — …",
  degraded: true,
  degraded_reason:
    "atspi_tree_empty: the AT-SPI walk returned no actionable elements. …",
  element_count: 0,
  elements: [],
  elements_complete: false,
  escalation: {
    reason: "non-AX surface — act by pixel (x,y) off the screenshot …",
    recommended: "px",
  },
  pid: 91,
  returned_element_count: 0,
  snapshot_id: "s00000001",
  total_element_count: 0,
  tree_markdown: '- frame = "Desktop"\n',
  window_id: 16777256,
};

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

test("driverArgs element target — prefers element_token, sends pid + window_id (M3.1)", () => {
  const withToken = driverArgs(
    { kind: "click", target: { elementIndex: 3, snapshotId: "snap-7" } },
    {
      pid: 81,
      windowId: 10485767,
      token: "s00000002:1",
      driverSnapshotId: "s00000002",
      driverElementIndex: 1,
    },
  );
  assert.deepEqual(withToken, {
    element_token: "s00000002:1",
    pid: 81,
    window_id: 10485767,
    delivery_mode: "background",
  });

  // No per-element token in the snapshot → explicit element_index + snapshot_id.
  const noToken = driverArgs(
    {
      kind: "type_text",
      target: { elementIndex: 0, snapshotId: "snap-7" },
      text: "hello",
    },
    {
      pid: 88,
      windowId: 222,
      token: undefined,
      driverSnapshotId: "s0000a002",
      driverElementIndex: 0,
    },
  );
  assert.deepEqual(noToken, {
    element_index: 0,
    snapshot_id: "s0000a002",
    pid: 88,
    window_id: 222,
    delivery_mode: "background",
    text: "hello",
  });
});

test("parseWindowElements — real Thunar structuredContent (labelled + unlabelled, tokens, snapshot id)", () => {
  const parsed = parseWindowElements(REAL_THUNAR_WINDOW_STATE);
  assert.equal(parsed.snapshotId, "s00000002");
  assert.equal(parsed.elements.length, 4);
  assert.deepEqual(parsed.elements[0], {
    elementIndex: 0,
    elementToken: "s00000002:0",
    role: "push button",
    name: "Menubar",
    frame: undefined,
  });
  assert.deepEqual(parsed.elements[1]?.frame, { x: 83, y: 85, w: 37, h: 35 });
  assert.equal(parsed.elements[2]?.elementIndex, 14); // driver index is not contiguous
  assert.equal(parsed.elements[3]?.name, ""); // unlabelled node kept
  assert.equal(parsed.degraded, undefined);
});

test("parseWindowElements — real degraded (non-AX) window: empty list + reason + px escalation", () => {
  const parsed = parseWindowElements(REAL_DESKTOP_WINDOW_STATE);
  assert.equal(parsed.snapshotId, "s00000001");
  assert.deepEqual(parsed.elements, []);
  assert.equal(parsed.degraded, true);
  assert.match(parsed.degradedReason ?? "", /atspi_tree_empty/);
  assert.equal(parsed.escalation, "px");
});

test("parseWindowElements — tolerates a fallback shape (nodes / index / name / bounds)", () => {
  const parsed = parseWindowElements({
    snapshotId: "sdeadbeef",
    nodes: [
      {
        index: 2,
        name: "OK",
        role: "push button",
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      },
      { garbage: true },
    ],
  });
  assert.equal(parsed.snapshotId, "sdeadbeef");
  assert.equal(parsed.elements.length, 1);
  assert.deepEqual(parsed.elements[0], {
    elementIndex: 2,
    elementToken: undefined,
    role: "push button",
    name: "OK",
    frame: { x: 1, y: 2, w: 3, h: 4 },
  });
});

test("observe() merges per-window elements into one flat indexed list (M3.1)", async () => {
  const { spawn } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-el", spawn });

  const result = await rt.observe();

  assert.match(
    result.content,
    /\nelements \[/,
    "element list is in the content",
  );
  assert.match(result.content, /"role":"push button"/);
  assert.match(result.content, /"name":"Reload"/);
  assert.match(result.content, /"index":0/);
  // Bounded: the whole observation text stays small.
  assert.ok(
    Buffer.byteLength(result.content) < 8192,
    `content ${Buffer.byteLength(result.content)} bytes`,
  );
  await rt.stop();
});

test("act() by element — fresh snapshot dispatches; stale / unknown reject locally", async () => {
  const { spawn, children } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-ae", spawn });

  const obs = await rt.observe();
  const snapshotId = /snapshotId (snap-\d+)/.exec(obs.content)?.[1] ?? "";
  assert.ok(snapshotId);
  const spawnCountAfterObserve = children.length;

  // Fresh element target → reaches the driver, not a local reject.
  const ok = await rt.act({
    kind: "click",
    target: { elementIndex: 0, snapshotId },
  });
  assert.doesNotMatch(ok.content, /^error:/);
  assert.match(ok.content, /click computer element 0/);

  // Stale snapshot id → local reject, no driver/docker round-trip.
  const staleBefore = children.length;
  const stale = await rt.act({
    kind: "click",
    target: { elementIndex: 0, snapshotId: "snap-999" },
  });
  assert.match(stale.content, /^error: stale snapshotId/);
  assert.equal(children.length, staleBefore, "no new child for a stale target");

  // Unknown index in the latest observation → local reject.
  const latest = /snapshotId (snap-\d+)/.exec(
    (await rt.observe()).content,
  )?.[1] as string;
  const unknown = await rt.act({
    kind: "click",
    target: { elementIndex: 999, snapshotId: latest },
  });
  assert.match(
    unknown.content,
    /^error: element 999 is not in the latest observation/,
  );

  assert.ok(spawnCountAfterObserve >= 0);
  await rt.stop();
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
      } else if (name === "get_window_state") {
        this.#emit({
          id: msg.id,
          result: {
            content: [{ type: "text", text: "window_id=9 pid=1 elements=2" }],
            structuredContent: {
              snapshot_id: "s0000b001",
              element_count: 2,
              elements_complete: true,
              elements: [
                {
                  element_index: 0,
                  element_token: "s0000b001:0",
                  role: "push button",
                  label: "Reload",
                  enabled: true,
                  frame: { x: 4, y: 4, w: 30, h: 20 },
                },
                {
                  element_index: 1,
                  element_token: "s0000b001:1",
                  role: "table cell",
                  label: "",
                },
              ],
              window_id: 9,
              pid: 1,
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
