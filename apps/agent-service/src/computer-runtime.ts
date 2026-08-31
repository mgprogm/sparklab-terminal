/**
 * One isolated disposable Linux desktop, owned by one AgentLoop — the desktop
 * counterpart of `browser-runtime.ts`. See docs/VIRTUAL-COMPUTER.md.
 *
 * v1: a per-chat Docker container from the CUA desktop image
 * (`sparklab/cua-desktop:0.22.2`, built from test/cua-real/Dockerfile over
 * `trycua/xfce-cua`), with `cua-driver mcp --direct` running inside it as user
 * `cua` on `DISPLAY=:1`, reached over stdio via `docker exec -i`.
 *
 * Verified against cua-driver 0.22.2 (test:computer-e2e CUA_E2E_REAL=1):
 *   - start: `docker run` → poll noVNC for X readiness → `docker exec` the
 *     driver → MCP `initialize`.
 *   - observe: `get_desktop_state({screenshot_out_file})` writes the PNG to a
 *     container path (no inline base64 for the desktop); the bytes are pulled
 *     back with `docker exec … base64 -w0` and the file deleted. Screen dims
 *     come from that response (fallback `get_screen_size`). `list_windows`
 *     gives the model a window inventory, and (M3.1) `get_window_state({pid,
 *     window_id, include_screenshot:false})` is called for up to MAX_WINDOWS
 *     on-screen windows to build ONE flat indexed element list.
 *   - act: an element target (`elementIndex` + `snapshotId` from the latest
 *     observe) is the preferred form for `click` / `double_click` / `right_click`
 *     / `type_text` — dispatched via the driver's `element_token` (per-element,
 *     per-window; supersession is per-window, so tokens collected across a whole
 *     observe stay live until the next observe). Screen-absolute
 *     `scope:"desktop"` x,y is the fallback (and the only form for `press_key` /
 *     `scroll`; `drag` is two x,y points; `hotkey` is a global chord). Delivery
 *     is `delivery_mode:"background"` (XTEST / XInput2, no focus steal) for every
 *     kind EXCEPT `double_click` / `right_click`: those two driver verbs have no
 *     focus-free X11 route (the 0.22.2 probe returned `background_unavailable`
 *     for every target form), so they use `delivery_mode:"foreground"` — a brief
 *     window activate + restore, a fidelity trade on a human-less disposable
 *     desktop, not a containment change.
 *
 * Everything container-specific lives behind the private `docker*` helpers so
 * the tool layer and the frontend stay backend-agnostic and a later VM/cloud
 * backend is a swap behind `observe()` / `act()` / `stop()`.
 */
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { config, CAPS } from "./config.js";
import { computerResources } from "./computer-resource-limiter.js";
import {
  computerPerformanceMetrics,
  type ComputerErrorClass,
} from "./computer-performance-metrics.js";

export type SpawnFn = typeof nodeSpawn;

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpResponse {
  id?: number;
  result?: {
    content?: McpContent[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { message?: string };
}

export interface ComputerSnapshot {
  computerId: string;
  revision: number;
  viewport: { width: number; height: number };
  screenshot: { mediaType: "image/png" | "image/webp"; data: string };
  status: string;
}

// M3.1: an element target (from the latest observe's flat indexed list) is the
// preferred form; a screen-absolute desktop point is the fallback.
export type ComputerTarget =
  { elementIndex: number; snapshotId: string } | { x: number; y: number };

/** One row of the flat indexed element list observe() hands the model. */
export interface ComputerElement {
  index: number;
  role: string;
  name: string;
  windowId: number;
}

/** What observe() stashes per synthetic index so act() can dispatch it. */
interface StoredElement {
  windowId: number;
  pid: number;
  driverElementToken?: string;
  driverSnapshotId: string;
  driverElementIndex: number;
  role: string;
  name: string;
}

/** Driver-side handle for one element, passed into driverArgs(). */
export interface DriverElementRef {
  pid: number;
  windowId: number;
  token?: string;
  driverSnapshotId: string;
  driverElementIndex: number;
}

export type ComputerAction =
  | { kind: "click"; target: ComputerTarget }
  | { kind: "double_click"; target: ComputerTarget }
  | { kind: "right_click"; target: ComputerTarget }
  | { kind: "type_text"; target: ComputerTarget; text: string }
  | { kind: "press_key"; target: ComputerTarget; key: string }
  | {
      kind: "scroll";
      target: ComputerTarget;
      direction: "up" | "down" | "left" | "right";
      amount?: "line" | "page";
    }
  // A pointer drag from a start point to an end point. Both ends are
  // screen-absolute x,y (no element target); dispatched at scope:"desktop".
  | { kind: "drag"; target: ComputerTarget; to: { x: number; y: number } }
  // A global modifier+key chord. No target — hotkey is delivered to whatever
  // the desktop last focused (route:"global_input").
  | { kind: "hotkey"; keys: string[] };

export interface ComputerObserveResult {
  /**
   * Model-facing text: viewport, current snapshotId, window inventory, and the
   * flat indexed element list (M3.1).
   */
  content: string;
  snapshot?: ComputerSnapshot;
  snapshotId: string;
}

export interface ComputerActResult {
  /** Model-facing text: the driver ActionResult, then a fresh observation. */
  content: string;
  snapshot?: ComputerSnapshot;
}

const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
// Upper bound on the base64 TEXT for a MAX_SCREENSHOT_BYTES payload
// (4 chars per 3 bytes, rounded up, plus a little slack). The base64 read is
// capped at this so `docker exec … base64` output can't accumulate unbounded.
const MAX_SCREENSHOT_B64_BYTES = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4;
const MAX_VIEWPORT_EDGE = 4096;
const MAX_MCP_LINE_BYTES = 8 * 1024 * 1024;
// On-screen windows visited for element extraction per observe (M3.1). Distinct
// from MAX_ELEMENTS — also caps the `list_windows` inventory shown to the model.
const MAX_WINDOWS = 12;
// Cap on the merged, flat indexed element list across all visited windows.
const MAX_ELEMENTS = 200;
// Passed to the driver as get_window_state({max_elements}) to bound the AT-SPI
// walk, and applied again when slicing one window's contribution to the merge.
const MAX_WINDOW_ELEMENTS = 80;
const MAX_ELEMENT_NAME = 200;
const MAX_ELEMENT_ROLE = 60;
// hotkey chord bounds (M3.2). The driver additionally requires >= 2 keys
// (modifier(s) + one non-modifier); act() / parseComputerAction enforce that up
// front so the model never spends an approval on a guaranteed rejection.
const MAX_HOTKEY_KEYS = 8;
const MAX_HOTKEY_KEY_LEN = 16;
// Upper bound on the running-app inventory listWindows() hands the model (M3.3).
const MAX_APPS = 40;
const START_ATTEMPTS = 8;
const ORPHAN_LABEL = "sparklab-cua";
// Per-instance sweep label (M2.3). sweepOrphans() filters on THIS so a second
// agent-service instance — or a boot while another instance holds a live
// desktop — never removes a container it does not own. The bare ORPHAN_LABEL is
// still applied for the human-facing `docker ps --filter label=sparklab-cua`.
const ORPHAN_INSTANCE_LABEL = "sparklab-cua-instance";

/** cua-driver desktop-input family (verified against 0.22.2). */
const ACTION_TOOL: Record<ComputerAction["kind"], string> = {
  click: "click",
  double_click: "double_click",
  right_click: "right_click",
  type_text: "type_text",
  press_key: "press_key",
  scroll: "scroll",
  drag: "drag",
  hotkey: "hotkey",
};

export class ComputerRuntime {
  readonly computerId = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private containerName: string | null = null;
  private releaseSession: (() => void) | null = null;
  private nextId = 1;
  private revision = 0;
  private snapshotSeq = 0;
  // M3.1: the flat indexed element list from the LATEST observe(), and the
  // synthetic snapshot id it was minted under. act() validates an element
  // target against both before any driver round-trip. A fresh observe() (incl.
  // the one act() runs after every action) replaces the map and the id, which
  // is what makes stale element targets fail closed.
  private lastElements = new Map<number, StoredElement>();
  private lastSnapshotId = "";
  // M3.2: on-screen window rectangles from the LATEST observe(), used to resolve
  // the pid + window_id a screen-absolute double_click / right_click must carry
  // (those driver tools have no `scope:"desktop"` form and require a window).
  // Cleared at the top of observe() so a stale point target fails closed.
  private lastWindows: Array<{
    pid: number;
    windowId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
  }> = [];
  private pending = new Map<
    number,
    { resolve: (r: McpResponse) => void; reject: (e: Error) => void }
  >();
  private starting: Promise<void> | null = null;
  private disposing: Promise<number> | null = null;
  private closed = false;
  private counters = {
    startMs: 0,
    ready: false,
    calls: 0,
    callErrors: 0,
    screenshotBytes: 0,
    elementBytes: 0,
  };

  constructor(
    private readonly onUnexpectedClose?: (
      computerId: string,
      revision: number,
    ) => void,
    private readonly opts: { label?: string; spawn?: SpawnFn } = {},
  ) {}

  /**
   * Remove any desktop containers left behind by a hard crash of this service
   * (graceful paths already `docker rm -f` their own). Call once at boot when
   * CUA is enabled. Best-effort: a failure here never blocks startup.
   */
  static async sweepOrphans(spawn: SpawnFn = nodeSpawn): Promise<void> {
    if (!config.cua.enabled) return;
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        let out = "";
        try {
          const child = spawn(config.cua.dockerBin, args, {
            stdio: ["ignore", "pipe", "ignore"],
          });
          child.stdout?.on("data", (c: Buffer) => {
            out += c.toString("utf8");
          });
          child.once("error", () => resolve(""));
          child.once("exit", () => resolve(out));
        } catch {
          resolve("");
        }
      });
    const ids = (
      await run([
        "ps",
        "-aq",
        "--filter",
        `label=${ORPHAN_INSTANCE_LABEL}=${config.cua.instanceId}`,
      ])
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length) await run(["rm", "-f", ...ids]);
  }

  get isActive(): boolean {
    return this.child !== null || this.starting !== null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  metrics(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }

  async observe(signal?: AbortSignal): Promise<ComputerObserveResult> {
    // Fail closed: drop the previous observe's element map + snapshot id up
    // front, so if get_desktop_state throws/aborts before a fresh id is minted,
    // a replayed element target hits the staleness check locally rather than
    // being dispatched against a stale token (QA M3.1 #7).
    this.lastElements = new Map();
    this.lastSnapshotId = "";
    this.lastWindows = [];
    // 0.22.2: get_desktop_state writes the PNG to a file INSIDE the container
    // (no inline base64 for the desktop) and returns its screen dimensions.
    const shotPath = `${config.cua.screenshotDir.replace(/\/+$/, "")}/cua-${randomUUID()}.png`;
    const capture = await this.call(
      "get_desktop_state",
      { screenshot_out_file: shotPath },
      signal,
    );
    const meta = asRecord(pickStructured(capture)) ?? {};
    let width = boundedDimension(meta.screen_width ?? meta.screenshot_width);
    let height = boundedDimension(meta.screen_height ?? meta.screenshot_height);
    if (!width || !height) {
      try {
        const size =
          asRecord(
            pickStructured(await this.call("get_screen_size", {}, signal)),
          ) ?? {};
        width = boundedDimension(size.width);
        height = boundedDimension(size.height);
      } catch {
        // leave 0/0 — no snapshot, text-only observation
      }
    }

    let data = "";
    try {
      data = await this.readContainerFileBase64(shotPath);
    } catch {
      // no bytes → no overlay frame this turn
    } finally {
      void this.execInContainer(["rm", "-f", shotPath]).catch(() => undefined);
    }

    // Window inventory for the model. Filter to on-screen, real-geometry
    // windows FIRST and slice to MAX_WINDOWS, so the shown inventory is exactly
    // the set the element walk below visits — element windowIds never point at
    // a window the model can't see in `windows [...]` (QA M3.1 #3).
    let visibleWindows: Array<Record<string, unknown>> = [];
    let windowsText = "windows unavailable";
    try {
      const wins = asRecord(
        pickStructured(await this.call("list_windows", {}, signal)),
      );
      const rawList = Array.isArray(wins?.windows) ? wins.windows : [];
      visibleWindows = rawList
        .map((w) => asRecord(w) ?? {})
        .filter(
          (w) =>
            w.is_on_screen !== false &&
            toInt(w.pid) !== undefined &&
            toInt(w.window_id) !== undefined &&
            !isOffscreenGeometry(w),
        )
        .slice(0, MAX_WINDOWS);
      windowsText = `windows ${JSON.stringify(
        visibleWindows.map(summarizeWindow),
      )}`;
    } catch {
      // keep default
    }
    // Stash window rectangles for windowAtPoint() (M3.2). Same set the model
    // sees in `windows [...]`, so a resolved pid/window_id is always a window
    // the model could name.
    this.lastWindows = visibleWindows
      .map((w) => ({
        pid: toInt(w.pid) ?? 0,
        windowId: toInt(w.window_id) ?? 0,
        x: finiteNum(w.x) ?? 0,
        y: finiteNum(w.y) ?? 0,
        width: finiteNum(w.width) ?? 0,
        height: finiteNum(w.height) ?? 0,
        zIndex: finiteNum(w.z_index) ?? 0,
      }))
      .filter((w) => w.pid && w.windowId && w.width > 0 && w.height > 0);

    // M3.1 — per-window AT-SPI elements merged into ONE flat indexed list.
    // get_window_state supersession is per-window (verified against 0.22.2), so
    // element_tokens collected across the whole walk stay live together until
    // the next observe(). include_screenshot:false is required or every window
    // re-embeds a PNG and blows the byte bound.
    const elements: ComputerElement[] = [];
    const elementMap = new Map<number, StoredElement>();
    const degradedWindows: Array<{ windowId: number; reason: string }> = [];
    let synthetic = 0;
    for (const w of visibleWindows) {
      if (elements.length >= MAX_ELEMENTS) break;
      const pid = toInt(w.pid);
      const windowId = toInt(w.window_id);
      if (pid === undefined || windowId === undefined) continue;
      try {
        const parsed = parseWindowElements(
          pickStructured(
            await this.call(
              "get_window_state",
              {
                pid,
                window_id: windowId,
                include_screenshot: false,
                max_elements: MAX_WINDOW_ELEMENTS,
              },
              signal,
            ),
          ),
        );
        if (parsed.degraded && parsed.degradedReason)
          degradedWindows.push({ windowId, reason: parsed.degradedReason });
        // Labelled elements first so an arbitrary cut keeps the buttons, not a
        // pile of empty table cells.
        const ordered = [
          ...parsed.elements.filter((e) => e.name),
          ...parsed.elements.filter((e) => !e.name),
        ].slice(0, MAX_WINDOW_ELEMENTS);
        for (const e of ordered) {
          if (elements.length >= MAX_ELEMENTS) break;
          const index = synthetic++;
          const name = e.name.slice(0, MAX_ELEMENT_NAME);
          const role = e.role.slice(0, MAX_ELEMENT_ROLE);
          elements.push({ index, role, name, windowId });
          elementMap.set(index, {
            windowId,
            pid,
            driverElementToken: e.elementToken,
            driverSnapshotId: parsed.snapshotId,
            driverElementIndex: e.elementIndex,
            role,
            name,
          });
        }
      } catch {
        // skip a window whose get_window_state errors
      }
    }
    this.lastElements = elementMap;

    const elementsJson = JSON.stringify(elements);
    if (elements.length) {
      const elementBytes = Buffer.byteLength(elementsJson);
      this.counters.elementBytes = elementBytes;
      computerPerformanceMetrics.computerElements(elementBytes);
    }

    const snapshotId = `snap-${++this.snapshotSeq}`;
    this.lastSnapshotId = snapshotId;

    let snapshot: ComputerSnapshot | undefined;
    const bytes = data ? Buffer.byteLength(data, "base64") : 0;
    if (bytes > 0) computerPerformanceMetrics.computerScreenshot(bytes);
    if (data && bytes > 0 && bytes <= MAX_SCREENSHOT_BYTES && width && height) {
      this.counters.screenshotBytes = bytes;
      snapshot = {
        computerId: this.computerId,
        revision: ++this.revision,
        viewport: { width, height },
        screenshot: { mediaType: "image/png", data },
        status: "observed",
      };
    }
    const lines = [
      snapshot
        ? `viewport ${width}x${height}`
        : `viewport ${width || "?"}x${height || "?"} (no screenshot bytes)`,
      `snapshotId ${snapshotId}`,
      windowsText,
      `elements ${elementsJson}`,
    ];
    if (degradedWindows.length)
      lines.push(
        `elements-degraded ${JSON.stringify(degradedWindows.slice(0, MAX_WINDOWS))} — act by screen x,y in these windows`,
      );
    lines.push(
      "target computer_act by element_index + snapshotId from the list above (click / type_text); fall back to screen-absolute x,y when no element matches, and always for press_key / scroll",
    );
    return { content: lines.join("\n"), snapshot, snapshotId };
  }

  private execInContainer(cmd: string[], maxBytes?: number): Promise<string> {
    if (!this.containerName)
      return Promise.reject(new Error("computer runtime has no container"));
    return this.dockerCapture(["exec", this.containerName, ...cmd], maxBytes);
  }

  private async readContainerFileBase64(path: string): Promise<string> {
    // Cap the accumulated base64 stdout so an oversized screenshot file can't
    // grow the buffer without bound before observe()'s decoded-bytes check.
    const out = await this.execInContainer(
      ["base64", "-w0", path],
      MAX_SCREENSHOT_B64_BYTES,
    );
    const b64 = out.replace(/\s+/g, "");
    if (!b64) throw new Error("empty screenshot file");
    return b64;
  }

  async act(
    action: ComputerAction,
    signal?: AbortSignal,
  ): Promise<ComputerActResult> {
    // hotkey is global — no target. Validate the chord locally: the driver
    // rejects < 2 keys (invalid_arguments) so a one-key chord must never reach
    // it and spend an approval.
    if (action.kind === "hotkey") {
      const keys = action.keys;
      if (
        !Array.isArray(keys) ||
        keys.length < 2 ||
        keys.length > MAX_HOTKEY_KEYS ||
        keys.some(
          (k) =>
            typeof k !== "string" ||
            k.length === 0 ||
            k.length > MAX_HOTKEY_KEY_LEN,
        )
      )
        return {
          content: `error: hotkey requires a chord of 2-${MAX_HOTKEY_KEYS} short key names (modifier(s) + one non-modifier key, e.g. ["ctrl","l"])`,
        };
      return this.dispatch(
        ACTION_TOOL.hotkey,
        driverArgs(action),
        `hotkey computer ${keys.join("+")}`,
        signal,
      );
    }

    const target = action.target;
    let element: DriverElementRef | undefined;
    let pointWindow: { pid: number; windowId: number } | undefined;
    // click / type_text / double_click / right_click may target an element;
    // press_key / scroll / drag are pixel-only.
    const elementKinds = new Set([
      "click",
      "type_text",
      "double_click",
      "right_click",
    ]);
    if ("elementIndex" in target) {
      // Element target — validate against the LATEST observation before any
      // driver round-trip. A stale snapshot id or an unknown index is a spent
      // approval otherwise (M1 fix #1).
      if (target.snapshotId !== this.lastSnapshotId)
        return {
          content: "error: stale snapshotId — call computer_observe again",
        };
      const stored = this.lastElements.get(target.elementIndex);
      if (!stored)
        return {
          content: `error: element ${target.elementIndex} is not in the latest observation`,
        };
      if (!elementKinds.has(action.kind))
        return {
          content: `error: ${action.kind} cannot target an element — supply screen x,y`,
        };
      element = {
        pid: stored.pid,
        windowId: stored.windowId,
        token: stored.driverElementToken,
        driverSnapshotId: stored.driverSnapshotId,
        driverElementIndex: stored.driverElementIndex,
      };
    } else if (
      typeof target?.x !== "number" ||
      typeof target?.y !== "number" ||
      Number.isNaN(target.x) ||
      Number.isNaN(target.y)
    ) {
      // Pixel target — reject a malformed one locally, before any driver call.
      return {
        content:
          "error: target requires screen x + y or element_index + snapshot_id",
      };
    } else if (
      action.kind === "double_click" ||
      action.kind === "right_click"
    ) {
      // double_click / right_click have no `scope:"desktop"` form — they must
      // carry a pid + window_id. Resolve the front-most observed window under
      // the point; fail closed if there is no observation to resolve against.
      pointWindow = this.windowAtPoint(target.x, target.y);
      if (!pointWindow)
        return {
          content:
            "error: no observed window contains those coordinates — call computer_observe first",
        };
    }

    if (action.kind === "drag") {
      const to = action.to;
      if (
        !to ||
        typeof to.x !== "number" ||
        typeof to.y !== "number" ||
        Number.isNaN(to.x) ||
        Number.isNaN(to.y)
      )
        return { content: "error: drag requires a destination to_x + to_y" };
    }

    const args = driverArgs(action, element, pointWindow);
    const actionText =
      action.kind === "type_text"
        ? "typed [redacted]"
        : action.kind === "drag"
          ? `drag desktop @ ${(target as { x: number }).x},${(target as { y: number }).y} → ${action.to.x},${action.to.y}`
          : "elementIndex" in target
            ? `${action.kind} computer element ${target.elementIndex}`
            : `${action.kind} desktop @ ${target.x},${target.y}`;
    return this.dispatch(ACTION_TOOL[action.kind], args, actionText, signal);
  }

  /**
   * Dispatch one already-validated driver call, then re-observe (which
   * supersedes every element token) and stitch the model-facing text.
   */
  private async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    actionText: string,
    signal?: AbortSignal,
  ): Promise<ComputerActResult> {
    const actionContent = await this.call(toolName, args, signal);
    // The driver returns the ActionResult as structuredContent (0.15); older
    // builds put a JSON blob in text. `isError` (transport failure) is already
    // handled in `call()`.
    const resultText = summarizeActionResult(
      pickStructured(actionContent) ?? tryJson(extractText(actionContent)),
    );
    let observation = "";
    let snapshot: ComputerSnapshot | undefined;
    try {
      const next = await this.observe(signal);
      observation = next.content;
      snapshot = next.snapshot;
    } catch (error) {
      observation = `re-observation failed: ${errMsg(error)}`;
    }
    return {
      content: `${actionText}\n${resultText}\n${observation}`,
      snapshot,
    };
  }

  /**
   * Front-most window from the LATEST observe() whose rectangle contains the
   * point (largest z-index wins; ties break to the smaller window). Used to
   * carry a pid + window_id on a screen-absolute double_click / right_click.
   */
  private windowAtPoint(
    x: number,
    y: number,
  ): { pid: number; windowId: number } | undefined {
    const hits = this.lastWindows.filter(
      (w) => x >= w.x && x < w.x + w.width && y >= w.y && y < w.y + w.height,
    );
    if (!hits.length) return undefined;
    hits.sort(
      (a, b) => b.zIndex - a.zIndex || a.width * a.height - b.width * b.height,
    );
    const top = hits[0]!;
    return { pid: top.pid, windowId: top.windowId };
  }

  /**
   * M3.3 — a bounded text inventory of open windows + running apps, no
   * screenshot and no `computer_view` frame. The cheap analogue of
   * `browser_list_tabs`.
   */
  async listWindows(signal?: AbortSignal): Promise<string> {
    let windowsText = "windows unavailable";
    try {
      const wins = asRecord(
        pickStructured(await this.call("list_windows", {}, signal)),
      );
      const rawList = Array.isArray(wins?.windows) ? wins.windows : [];
      const visible = rawList
        .map((w) => asRecord(w) ?? {})
        .filter(
          (w) =>
            w.is_on_screen !== false &&
            toInt(w.pid) !== undefined &&
            toInt(w.window_id) !== undefined &&
            !isOffscreenGeometry(w),
        )
        .slice(0, MAX_WINDOWS)
        .map(summarizeWindow);
      windowsText = `windows ${JSON.stringify(visible)}`;
    } catch {
      // keep default
    }
    let appsText = "apps unavailable";
    try {
      const apps = asRecord(
        pickStructured(await this.call("list_apps", {}, signal)),
      );
      const rawApps = Array.isArray(apps?.apps) ? apps.apps : [];
      const running = rawApps
        .map((a) => asRecord(a) ?? {})
        .filter((a) => a.running !== false && typeof a.name === "string")
        .slice(0, MAX_APPS)
        .map((a) => ({
          name: String(a.name).slice(0, MAX_ELEMENT_NAME),
          pid: toInt(a.pid),
        }));
      appsText = `apps ${JSON.stringify(running)}`;
    } catch {
      // keep default
    }
    return [windowsText, appsText].join("\n");
  }

  dispose(): Promise<number> {
    if (!this.disposing) this.disposing = this.doDispose();
    return this.disposing;
  }

  /** Alias matching docs/VIRTUAL-COMPUTER.md's runtime interface. */
  stop(): Promise<number> {
    return this.dispose();
  }

  // ---- lifecycle -----------------------------------------------------------

  private async doDispose(): Promise<number> {
    this.closed = true;
    const revision = ++this.revision;
    const child = this.child;
    const container = this.containerName;
    this.child = null;
    this.containerName = null;
    this.starting = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // stdin may already be gone
      }
      killProcessGroup(child, "SIGTERM");
      await waitForExit(child, 2_000);
    }
    this.rejectPending(new Error("computer runtime closed"));
    if (container) {
      await this.dockerCapture(["rm", "-f", container]).catch(() => undefined);
    }
    // Release the desktop reservation only after the container is actually gone,
    // so a fast-cycling caller can't reserve slot N+1 while container N is still
    // being removed (mirrors browser-runtime.ts). No-op guard covers the case
    // where reserveSession() itself threw and start() never got a slot.
    this.releaseSession?.();
    this.releaseSession = null;
    return revision;
  }

  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = this.start().catch(async (error) => {
      await this.dispose();
      throw error;
    });
    return this.starting.finally(() => {
      this.starting = null;
    });
  }

  private async start(): Promise<void> {
    this.assertOpen();
    if (!config.cua.enabled)
      throw new Error("computer tools are disabled: set CUA_ENABLED=true");
    // `bounded` admits ONLY what the capability manifest lists and fails every
    // call closed without one. config.ts defaults the path to the image-baked
    // manifest under bounded mode; if it is still unresolved, refuse to start
    // before any `docker run`.
    if (
      config.cua.driverPermissionMode === "bounded" &&
      !config.cua.capabilityManifestFile
    )
      throw new Error(
        "CUA_DRIVER_PERMISSION_MODE=bounded requires a capability manifest",
      );
    const startedAt = Date.now();
    // Hard cap on concurrent desktops (M2.2). Throws `cua_desktop_limit_reached`
    // BEFORE any `docker run`; the ensureStarted().catch -> dispose() path then
    // releases nothing (guarded) so no half-started state leaks.
    this.releaseSession = computerResources.reserveSession();
    const name = `sparklab-cua-${sanitizeLabel(this.opts.label)}-${randomUUID().slice(0, 8)}`;
    const runArgs = [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      // Sweep tag: a detached container survives a hard crash of this service
      // (it is not in the child's process group). ComputerRuntime.sweepOrphans()
      // removes anything still carrying this label at the next boot.
      "--label",
      `${ORPHAN_LABEL}=1`,
      // Per-instance sweep scope (M2.3): sweepOrphans() only removes containers
      // carrying THIS instance's id.
      "--label",
      `${ORPHAN_INSTANCE_LABEL}=${config.cua.instanceId}`,
      // Opt-in only: these can break a sudo/gosu privilege-drop entrypoint in a
      // full desktop image; unverified against trycua/xfce-cua.
      ...(config.cua.harden
        ? ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        : []),
      ...(config.cua.egressNetwork
        ? ["--network", config.cua.egressNetwork]
        : []),
      config.cua.image,
    ];
    // One bounded-concurrency slot for the whole cold-start sequence — the
    // `docker run`, the X-readiness poll, and every driver-spawn retry (M2.2).
    const releaseLaunch = await computerResources.acquireLaunch();
    try {
      const desktopStartedAt = Date.now();
      let desktopReady = false;
      try {
        await this.dockerCapture(runArgs);
        this.containerName = name;
        this.assertOpen();

        // The desktop image's supervisor brings up Xtigervnc + XFCE + noVNC
        // asynchronously. The driver connects to X at startup and fails closed
        // if the display isn't listening yet, so wait for X BEFORE spawning it.
        // The image's own HEALTHCHECK polls the same noVNC endpoint.
        await this.waitForXReady(name, config.cua.startTimeoutMs);
        this.assertOpen();
        desktopReady = true;
      } finally {
        computerPerformanceMetrics.desktopReady(
          Date.now() - desktopStartedAt,
          desktopReady,
        );
      }

      let lastError: unknown;
      for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
        this.assertOpen();
        // Recorded per attempt: `failures` counts failed cold-start attempts,
        // not desktops.
        const driverStartedAt = Date.now();
        try {
          await this.spawnDriverAndHandshake(name);
          computerPerformanceMetrics.driverReady(
            Date.now() - driverStartedAt,
            true,
          );
          this.counters.startMs = Date.now() - startedAt;
          this.counters.ready = true;
          return;
        } catch (error) {
          computerPerformanceMetrics.driverReady(
            Date.now() - driverStartedAt,
            false,
          );
          lastError = error;
          await this.teardownChild();
          await delay(1_000);
        }
      }
      this.counters.startMs = Date.now() - startedAt;
      throw new Error(`cua-driver did not become ready: ${errMsg(lastError)}`);
    } finally {
      releaseLaunch();
    }
  }

  private async waitForXReady(
    container: string,
    timeoutMs: number,
  ): Promise<void> {
    // A stub `docker` returns exit 0 for any `exec`, so this resolves on the
    // first probe under test; against a real image it polls until noVNC (and
    // therefore Xvnc) is up.
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      this.assertOpen();
      try {
        await this.dockerCapture([
          "exec",
          container,
          "sh",
          "-lc",
          `curl -fsS http://127.0.0.1:${config.cua.novncPort}/vnc.html >/dev/null`,
        ]);
        return;
      } catch (error) {
        lastErr = errMsg(error);
        await delay(2_000);
      }
    }
    throw new Error(`X session not ready after ${timeoutMs}ms: ${lastErr}`);
  }

  private async spawnDriverAndHandshake(container: string): Promise<void> {
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    // `docker exec` does NOT forward the host env into the container, so the
    // driver's config must ride explicit `-e` flags, not the child's env.
    const execArgs = [
      "exec",
      "-i",
      ...(config.cua.driverUser ? ["-u", config.cua.driverUser] : []),
      "-e",
      `HOME=${config.cua.driverHome}`,
      "-e",
      `DISPLAY=${config.cua.display}`,
      "-e",
      `CUA_DRIVER_PERMISSION_MODE=${config.cua.driverPermissionMode}`,
      ...(config.cua.capabilityManifestFile
        ? [
            "-e",
            `CUA_DRIVER_CAPABILITY_MANIFEST_FILE=${config.cua.capabilityManifestFile}`,
            "-e",
            "CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED=1",
          ]
        : []),
      container,
      config.cua.driverCmd,
      "mcp",
      "--direct",
    ];
    const child = spawnFn(config.cua.dockerBin, execArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.once("error", (error) => this.rejectPending(error));
    child.once("exit", (code, signalName) => {
      const unexpected = this.child === child && !this.closed;
      if (unexpected) {
        this.child = null;
        this.onUnexpectedClose?.(this.computerId, ++this.revision);
      }
      this.rejectPending(
        new Error(`cua-driver exited (${code ?? signalName ?? "unknown"})`),
      );
    });
    child.stderr.on("data", () => undefined);
    let stdout = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_MCP_LINE_BYTES) {
        void this.dispose();
        return;
      }
      let newline = stdout.indexOf(0x0a);
      while (newline >= 0) {
        this.handleLine(stdout.subarray(0, newline).toString("utf8"));
        stdout = stdout.subarray(newline + 1);
        newline = stdout.indexOf(0x0a);
      }
    });
    await withAbortAndTimeout(
      this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sparklab-agent-service", version: "0.1.0" },
      }),
      undefined,
      15_000,
    );
    this.notify("notifications/initialized", {});
  }

  private async teardownChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    killProcessGroup(child, "SIGTERM");
    await waitForExit(child, 1_000);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("computer runtime closed during startup");
  }

  // ---- MCP transport -----------------------------------------------------

  private async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpContent[]> {
    await this.ensureStarted();
    this.counters.calls++;
    const callStartedAt = Date.now();
    let ok = false;
    try {
      let response: McpResponse;
      try {
        response = await withAbortAndTimeout(
          this.request("tools/call", { name, arguments: args }),
          signal,
          CAPS.computerActionTimeoutMs,
        );
      } catch (error) {
        this.recordCallError(error);
        await this.dispose();
        throw error;
      }
      if (response.error) {
        const error = new Error(
          response.error.message || "cua-driver MCP error",
        );
        this.recordCallError(error);
        throw error;
      }
      const result = response.result;
      if (
        !result ||
        (!result.content && result.structuredContent === undefined)
      ) {
        const error = new Error("cua-driver returned a malformed result");
        this.recordCallError(error);
        throw error;
      }
      if (result.isError) {
        const error = new Error(
          extractText(result.content ?? []) || "cua-driver error",
        );
        this.recordCallError(error);
        throw error;
      }
      const content = result.content ?? [];
      if (result.structuredContent !== undefined) {
        content.push({
          type: "structured",
          text: JSON.stringify(result.structuredContent),
        });
      }
      ok = true;
      return content;
    } finally {
      computerPerformanceMetrics.computerCall(Date.now() - callStartedAt, ok);
    }
  }

  /** Per-instance counter + label-free coarse class into the /health singleton. */
  private recordCallError(error: unknown): void {
    this.counters.callErrors++;
    computerPerformanceMetrics.computerError(classifyError(error));
  }

  private request(method: string, params: unknown): Promise<McpResponse> {
    const child = this.child;
    if (!child?.stdin.writable)
      return Promise.reject(new Error("computer runtime is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    } catch {
      // best-effort
    }
  }

  private handleLine(line: string): void {
    let response: McpResponse;
    try {
      response = JSON.parse(line) as McpResponse;
    } catch {
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private dockerCapture(args: string[], maxBytes?: number): Promise<string> {
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(config.cua.dockerBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let overflowed = false;
      child.stdout?.on("data", (c: Buffer) => {
        if (overflowed) return;
        out += c.toString("utf8");
        if (maxBytes !== undefined && out.length > maxBytes) {
          overflowed = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          reject(
            new Error(`docker ${args[0]} output exceeded ${maxBytes} bytes`),
          );
        }
      });
      child.stderr?.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      child.once("error", (e) => {
        if (!overflowed) reject(e);
      });
      child.once("exit", (code) => {
        if (overflowed) return;
        if (code === 0) resolve(out.trim());
        else
          reject(
            new Error(`docker ${args[0]} failed (${code}): ${err.trim()}`),
          );
      });
    });
  }
}

// ---- pure helpers (unit-tested) -----------------------------------------

/**
 * Map a structured ComputerAction to 0.22.2 driver-tool arguments.
 *
 * Delivery is `delivery_mode:"background"` (XTEST / XInput2 master pointer, no
 * focus steal — verified against 0.22.2) for every kind EXCEPT `double_click` /
 * `right_click`: those two driver verbs have no focus-free route on X11 (the
 * real 0.22.2 probe returned `background_unavailable` for both element and x,y
 * targets), so they escalate to `delivery_mode:"foreground"` — a brief activate
 * of the target window, then the prior foreground is restored. `drag` /
 * `hotkey` are dispatched at `scope:"desktop"` with no window; `drag` must NOT
 * carry a pid/window_id (`invalid_action_target` when combined with desktop
 * scope).
 *
 * When `element` is supplied (an element target, `click` / `type_text` /
 * `double_click` / `right_click`) the driver is addressed by its per-element
 * `element_token` (which carries `snapshot_id:element_index`), falling back to
 * explicit `element_index + snapshot_id` if the snapshot carried no tokens.
 * `pid` + `window_id` are always sent alongside — the driver rejects
 * `element_token` without a `pid` ("Missing required integer field: pid").
 * `pointWindow` carries the same pid/window_id resolved from the last observe
 * for a screen-absolute `double_click` / `right_click`. `press_key` / `scroll`
 * and every pixel target stay `scope:"desktop"` screen-absolute;
 * element-targeted `press_key` / `scroll` under background delivery always
 * return `background_unavailable` on X11.
 */
export function driverArgs(
  action: ComputerAction,
  element?: DriverElementRef,
  pointWindow?: { pid: number; windowId: number },
): Record<string, unknown> {
  // hotkey — global chord. No target, no element.
  if (action.kind === "hotkey")
    return {
      scope: "desktop",
      keys: action.keys,
      delivery_mode: "background",
    };
  // drag — two screen points at desktop scope; a pid/window_id here is refused.
  if (action.kind === "drag") {
    const from = action.target as { x: number; y: number };
    return {
      from_x: from.x,
      from_y: from.y,
      to_x: action.to.x,
      to_y: action.to.y,
      scope: "desktop",
      delivery_mode: "background",
    };
  }

  const t = action.target;

  // double_click / right_click — foreground delivery; needs a window handle
  // (element target OR a pointWindow resolved from the last observe).
  if (action.kind === "double_click" || action.kind === "right_click") {
    const fg = { delivery_mode: "foreground" as const };
    if ("elementIndex" in t && element) {
      const handle = element.token
        ? { element_token: element.token }
        : {
            element_index: element.driverElementIndex,
            snapshot_id: element.driverSnapshotId,
          };
      return {
        ...handle,
        pid: element.pid,
        window_id: element.windowId,
        ...fg,
      };
    }
    if ("x" in t && pointWindow)
      return {
        x: t.x,
        y: t.y,
        pid: pointWindow.pid,
        window_id: pointWindow.windowId,
        ...fg,
      };
    // act() validates both arms before calling; defensive fallthrough only.
    return { ...("x" in t ? { x: t.x, y: t.y } : {}), ...fg };
  }

  const delivery = { delivery_mode: "background" as const };
  if ("elementIndex" in t && element) {
    const handle = element.token
      ? { element_token: element.token }
      : {
          element_index: element.driverElementIndex,
          snapshot_id: element.driverSnapshotId,
        };
    const win = { pid: element.pid, window_id: element.windowId };
    return action.kind === "type_text"
      ? { ...handle, ...win, ...delivery, text: action.text }
      : { ...handle, ...win, ...delivery };
  }
  // Pixel / desktop-focus arm.
  const point =
    "x" in t ? { scope: "desktop", x: t.x, y: t.y } : { scope: "desktop" };
  const focusScope = { scope: "desktop" };
  switch (action.kind) {
    case "click":
      return { ...point, ...delivery };
    case "type_text":
      // Desktop-scope typing lands in the focused app; no x,y.
      return { ...focusScope, ...delivery, text: action.text };
    case "press_key":
      return { ...focusScope, ...delivery, key: action.key };
    case "scroll":
      return {
        ...point,
        ...delivery,
        direction: action.direction,
        by: action.amount ?? "line",
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function summarizeWindow(value: unknown): unknown {
  const w = asRecord(value) ?? {};
  return {
    window_id: w.window_id,
    pid: w.pid,
    title:
      typeof w.title === "string"
        ? w.title.slice(0, MAX_ELEMENT_NAME)
        : w.title,
    app: w.app_name,
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
  };
}

export function summarizeActionResult(result: unknown): string {
  if (!result || typeof result !== "object")
    return "effect=unknown (no structured ActionResult)";
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  parts.push(`effect=${typeof r.effect === "string" ? r.effect : "unknown"}`);
  if (typeof r.route === "string") parts.push(`route=${r.route}`);
  const delivery = r.delivery as Record<string, unknown> | undefined;
  if (delivery && typeof delivery.mode === "string")
    parts.push(`delivery=${delivery.mode}`);
  if (typeof r.code === "string") parts.push(`code=${r.code}`);
  const escalation = r.escalation as Record<string, unknown> | undefined;
  if (escalation && typeof escalation.reason === "string")
    parts.push(`reason=${escalation.reason}`);
  return parts.join(" ");
}

/** One element as `parseWindowElements` normalises it (pre-merge). */
export interface RawElement {
  /** The driver's own per-window element index (NOT contiguous, NOT 0-based). */
  elementIndex: number;
  /** `snapshot_id:element_index`; preferred dispatch handle. */
  elementToken?: string;
  role: string;
  /** From `label` / `name` / `title`; may be empty. */
  name: string;
  /** Window-relative; present on some elements only. */
  frame?: { x: number; y: number; w: number; h: number };
}

export interface ParsedWindowState {
  /** `^s[0-9a-f]{8}$` — the driver's per-get_window_state snapshot id. */
  snapshotId: string;
  elements: RawElement[];
  degraded?: boolean;
  degradedReason?: string;
  elementsComplete?: boolean;
  /** `escalation.recommended` — e.g. "px" for a non-AX (canvas) surface. */
  escalation?: string;
}

/**
 * Tolerant parser for ONE `get_window_state` `structuredContent`
 * (cua-driver 0.22.2). Real shape:
 *   { snapshot_id: "s00000002",
 *     elements: [{ element_index, element_token: "s00000002:0", role,
 *                  label?, enabled?, frame?: {x,y,w,h}, depth?, parent_index?,
 *                  value? }, ...],
 *     element_count, total_element_count, returned_element_count,
 *     elements_complete, tree_markdown, _note,
 *     degraded?, degraded_reason?, escalation?: { reason, recommended } }
 * Fallback shapes: `tree` / `nodes` for the array; `snapshotId` for the id;
 * `index`, `token`, `name` / `title`, `bounds` {x,y,width,height} per element.
 */
export function parseWindowElements(
  structuredContent: unknown,
): ParsedWindowState {
  const sc = asRecord(structuredContent) ?? {};
  const snapshotId =
    typeof sc.snapshot_id === "string"
      ? sc.snapshot_id
      : typeof sc.snapshotId === "string"
        ? sc.snapshotId
        : "";
  const rawArray = Array.isArray(sc.elements)
    ? sc.elements
    : Array.isArray(sc.tree)
      ? sc.tree
      : Array.isArray(sc.nodes)
        ? sc.nodes
        : [];
  const elements: RawElement[] = [];
  for (const item of rawArray) {
    const e = asRecord(item);
    if (!e) continue;
    const idxRaw = e.element_index ?? e.index ?? e.id;
    const elementIndex =
      typeof idxRaw === "number" && Number.isInteger(idxRaw)
        ? idxRaw
        : elements.length;
    const role =
      typeof e.role === "string"
        ? e.role
        : typeof e.role_name === "string"
          ? e.role_name
          : "";
    const nameRaw = e.label ?? e.name ?? e.title ?? e.text ?? "";
    const name = typeof nameRaw === "string" ? nameRaw : "";
    const token =
      typeof e.element_token === "string"
        ? e.element_token
        : typeof e.token === "string"
          ? e.token
          : undefined;
    const fr = asRecord(e.frame) ?? asRecord(e.bounds);
    let frame: RawElement["frame"];
    if (fr) {
      const x = finiteNum(fr.x);
      const y = finiteNum(fr.y);
      const w = finiteNum(fr.w ?? fr.width);
      const h = finiteNum(fr.h ?? fr.height);
      if (
        x !== undefined &&
        y !== undefined &&
        w !== undefined &&
        h !== undefined
      )
        frame = { x, y, w, h };
    }
    if (!role && !name && !token) continue;
    elements.push({ elementIndex, elementToken: token, role, name, frame });
  }
  const escalationRec = asRecord(sc.escalation);
  return {
    snapshotId,
    elements,
    degraded: sc.degraded === true || undefined,
    degradedReason:
      typeof sc.degraded_reason === "string" ? sc.degraded_reason : undefined,
    elementsComplete:
      typeof sc.elements_complete === "boolean"
        ? sc.elements_complete
        : undefined,
    escalation:
      escalationRec && typeof escalationRec.recommended === "string"
        ? escalationRec.recommended
        : undefined,
  };
}

function finiteNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * Skip windows we should not spend a `get_window_state` round-trip on:
 * fully parked off-screen (`list_windows` still reports `is_on_screen:true` for
 * a 3x3 panel helper at -9999,-9999) or degenerately tiny.
 */
function isOffscreenGeometry(w: Record<string, unknown>): boolean {
  const x = finiteNum(w.x);
  const y = finiteNum(w.y);
  const width = finiteNum(w.width);
  const height = finiteNum(w.height);
  if ((x !== undefined && x <= -9999) || (y !== undefined && y <= -9999))
    return true;
  if (width !== undefined && height !== undefined && width * height < 100)
    return true;
  return false;
}

function pickStructured(content: McpContent[]): unknown {
  const structured = content.find((c) => c.type === "structured");
  return structured?.text ? tryJson(structured.text) : undefined;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractText(content: McpContent[]): string {
  return content
    .filter((c) => c.type !== "image" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .slice(0, 200_000);
}

function boundedDimension(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : 0;
  return n > 0 && n <= MAX_VIEWPORT_EDGE ? n : 0;
}

function sanitizeLabel(label: string | undefined): string {
  return (
    (label ?? "chat").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "chat"
  );
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coarse, label-free bucket for the /health error counters (M2.4). */
function classifyError(error: unknown): ComputerErrorClass {
  if (error instanceof DOMException && error.name === "AbortError")
    return "aborted";
  const m = errMsg(error).toLowerCase();
  if (m.includes("abort")) return "aborted";
  if (m.includes("timed out") || m.includes("timeout")) return "timeout";
  if (
    m.includes("malformed") ||
    m.includes("mcp error") ||
    m.includes("cua-driver error")
  )
    return "protocol";
  return "transport";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(
      () => reject(new Error("computer action timed out")),
      ms,
    );
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}

function killProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signalName: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signalName);
  } catch {
    try {
      child.kill(signalName);
    } catch {
      // already gone
    }
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(
      () => killProcessGroup(child, "SIGKILL"),
      timeoutMs,
    );
    const giveUp = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve();
    }, timeoutMs + 1_000);
    const onExit = () => {
      clearTimeout(killTimer);
      clearTimeout(giveUp);
      resolve();
    };
    child.once("exit", onExit);
    killTimer.unref?.();
    giveUp.unref?.();
  });
}
