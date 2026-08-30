/**
 * One isolated disposable Linux desktop, owned by one AgentLoop — the desktop
 * counterpart of `browser-runtime.ts`. See docs/VIRTUAL-COMPUTER.md.
 *
 * v1 (this spike): a per-chat Docker container built from the CUA desktop image
 * (`trycua/xfce-cua`), with `cua-driver mcp --direct` running inside it and
 * reached over stdio via `docker exec -i`. The MCP framing, lifecycle, and
 * teardown are the verifiable parts; the two places where the driver's on-wire
 * shape is still unconfirmed (the full-display capture tool name, and the
 * `get_accessibility_tree` field names) are marked TODO(spike) and parsed
 * tolerantly.
 *
 * Everything container-specific lives behind `spawnDocker` / the two private
 * `docker*` helpers so the tool layer and the frontend stay backend-agnostic
 * and a later VM/cloud backend is a swap behind `observe()` / `act()` / `stop()`.
 */
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { config, CAPS } from "./config.js";

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

export interface IndexedElement {
  index: number;
  role: string;
  name: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ComputerSnapshot {
  computerId: string;
  revision: number;
  viewport: { width: number; height: number };
  screenshot: { mediaType: "image/png" | "image/webp"; data: string };
  status: string;
}

export type ComputerTarget =
  | { elementIndex: number; snapshotId: string }
  | { windowId: string; x: number; y: number };

export type ComputerAction =
  | { kind: "click"; target: ComputerTarget }
  | { kind: "type_text"; target: ComputerTarget; text: string }
  | { kind: "press_key"; target: ComputerTarget; key: string }
  | {
      kind: "scroll";
      target: ComputerTarget;
      direction: "up" | "down" | "left" | "right";
      amount?: "line" | "page";
    };

export interface ComputerObserveResult {
  /** Model-facing text: viewport, indexed elements, current snapshotId. */
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
const MAX_VIEWPORT_EDGE = 4096;
const MAX_MCP_LINE_BYTES = 8 * 1024 * 1024;
const MAX_ELEMENTS = 200;
const MAX_ELEMENT_NAME = 200;
const START_ATTEMPTS = 8;
const ORPHAN_LABEL = "sparklab-cua";

/** cua-driver desktop-input family (docs/action-icon-catalog.md). */
const ACTION_TOOL: Record<ComputerAction["kind"], string> = {
  click: "click",
  type_text: "type_text",
  press_key: "press_key",
  scroll: "scroll",
};
// TODO(spike): confirm against the pinned driver. 0.15 catalog says
// `get_accessibility_tree`; the response field names below are best-effort.
const AX_TREE_TOOL = "get_accessibility_tree";

export class ComputerRuntime {
  readonly computerId = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private containerName: string | null = null;
  private nextId = 1;
  private revision = 0;
  private snapshotSeq = 0;
  private lastSnapshotId = "";
  private lastElements = new Map<number, IndexedElement>();
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
    const ids = (await run(["ps", "-aq", "--filter", `label=${ORPHAN_LABEL}`]))
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
    const captureContent = await this.call(
      config.cua.captureTool,
      { include_screenshot: true },
      signal,
    );
    let elements: IndexedElement[] = [];
    let driverSnapshotId = "";
    try {
      const axContent = await this.call(AX_TREE_TOOL, {}, signal);
      const parsed = parseAxTree(extractText(axContent));
      elements = parsed.elements;
      driverSnapshotId = parsed.snapshotId;
    } catch {
      // AX tree is best-effort in the spike; a capture-only observation still
      // lets the model fall back to window+pixel targeting.
    }
    const snapshotId = driverSnapshotId || `snap-${++this.snapshotSeq}`;
    this.lastSnapshotId = snapshotId;
    this.lastElements.clear();
    for (const el of elements.slice(0, MAX_ELEMENTS)) {
      this.lastElements.set(el.index, el);
    }
    // The capture response's screen dimensions are an unverified shape
    // (TODO(spike)). If they don't parse, ask the driver explicitly rather
    // than dropping the whole snapshot — a missing frame means no overlay at
    // all while the tool still reports success.
    let fallbackViewport: { width: unknown; height: unknown } | undefined;
    if (!parseViewport(extractText(captureContent))) {
      try {
        fallbackViewport = parseViewport(
          extractText(await this.call("get_screen_size", {}, signal)),
        );
      } catch {
        // leave undefined; buildSnapshot then returns undefined
      }
    }
    const snapshot = this.buildSnapshot(
      captureContent,
      "observed",
      fallbackViewport,
    );
    const elementText = JSON.stringify([...this.lastElements.values()]);
    this.counters.elementBytes = Buffer.byteLength(elementText);
    const lines = [
      snapshot
        ? `viewport ${snapshot.viewport.width}x${snapshot.viewport.height}`
        : "viewport unknown (no bounded screenshot)",
      `snapshotId ${snapshotId}`,
      this.lastElements.size
        ? `elements ${elementText}`
        : "elements [] (accessibility tree unavailable; use window+pixel targeting)",
    ];
    return { content: lines.join("\n"), snapshot, snapshotId };
  }

  async act(
    action: ComputerAction,
    signal?: AbortSignal,
  ): Promise<ComputerActResult> {
    const target = action.target;
    if ("elementIndex" in target) {
      if (target.snapshotId !== this.lastSnapshotId) {
        return {
          content:
            "error: stale snapshotId — call computer_observe again and use the new snapshotId",
        };
      }
      if (!this.lastElements.has(target.elementIndex)) {
        return {
          content: `error: element ${target.elementIndex} is not in the latest observation`,
        };
      }
    }
    const args = driverArgs(action);
    const actionContent = await this.call(
      ACTION_TOOL[action.kind],
      args,
      signal,
    );
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
    const actionText =
      action.kind === "type_text"
        ? "typed [redacted]"
        : `${action.kind} ${describeTarget(target)}`;
    return {
      content: `${actionText}\n${resultText}\n${observation}`,
      snapshot,
    };
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
    this.lastElements.clear();
    if (container) {
      await this.dockerCapture(["rm", "-f", container]).catch(() => undefined);
    }
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
    const startedAt = Date.now();
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
    await this.dockerCapture(runArgs);
    this.containerName = name;
    this.assertOpen();

    // TODO(spike): replace this retry loop with a real X-server / driver
    // readiness probe once the trycua/xfce-cua startup signal is confirmed.
    // For now: attempt the MCP handshake a few times while the container's
    // supervisor brings up Xvnc + the driver.
    let lastError: unknown;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
      this.assertOpen();
      try {
        await this.spawnDriverAndHandshake(name);
        this.counters.startMs = Date.now() - startedAt;
        this.counters.ready = true;
        return;
      } catch (error) {
        lastError = error;
        await this.teardownChild();
        await delay(
          Math.min(3_000, config.cua.startTimeoutMs / START_ATTEMPTS),
        );
      }
    }
    this.counters.startMs = Date.now() - startedAt;
    throw new Error(`cua-driver did not become ready: ${errMsg(lastError)}`);
  }

  private async spawnDriverAndHandshake(container: string): Promise<void> {
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    const child = spawnFn(
      config.cua.dockerBin,
      ["exec", "-i", container, "cua-driver", "mcp", "--direct"],
      {
        env: {
          ...process.env,
          CUA_DRIVER_PERMISSION_MODE: config.cua.driverPermissionMode,
          ...(config.cua.capabilityManifestFile
            ? {
                CUA_DRIVER_CAPABILITY_MANIFEST_FILE:
                  config.cua.capabilityManifestFile,
                CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: "1",
              }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    ) as ChildProcessWithoutNullStreams;
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
    let response: McpResponse;
    try {
      response = await withAbortAndTimeout(
        this.request("tools/call", { name, arguments: args }),
        signal,
        CAPS.computerActionTimeoutMs,
      );
    } catch (error) {
      this.counters.callErrors++;
      await this.dispose();
      throw error;
    }
    if (response.error) {
      this.counters.callErrors++;
      throw new Error(response.error.message || "cua-driver MCP error");
    }
    const result = response.result;
    if (
      !result ||
      (!result.content && result.structuredContent === undefined)
    ) {
      this.counters.callErrors++;
      throw new Error("cua-driver returned a malformed result");
    }
    if (result.isError) {
      this.counters.callErrors++;
      throw new Error(extractText(result.content ?? []) || "cua-driver error");
    }
    const content = result.content ?? [];
    if (result.structuredContent !== undefined) {
      content.push({
        type: "structured",
        text: JSON.stringify(result.structuredContent),
      });
    }
    return content;
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

  private dockerCapture(args: string[]): Promise<string> {
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(config.cua.dockerBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve(out.trim());
        else
          reject(
            new Error(`docker ${args[0]} failed (${code}): ${err.trim()}`),
          );
      });
    });
  }

  // ---- snapshot assembly ------------------------------------------------

  private buildSnapshot(
    content: McpContent[],
    status: string,
    fallbackViewport?: { width: unknown; height: unknown },
  ): ComputerSnapshot | undefined {
    const image = content.find(
      (item) => item.type === "image" && item.data && item.mimeType,
    );
    if (!image?.data || !image.mimeType) return undefined;
    const mediaType =
      image.mimeType === "image/webp" ? "image/webp" : "image/png";
    const bytes = Buffer.byteLength(image.data, "base64");
    if (bytes <= 0 || bytes > MAX_SCREENSHOT_BYTES) return undefined;
    const dims = parseViewport(extractText(content)) ??
      fallbackViewport ?? { width: 0, height: 0 };
    const width = boundedDimension(dims.width);
    const height = boundedDimension(dims.height);
    // A capture without parseable dimensions still ships as a 1x1-bounded
    // snapshot? No — the overlay needs real dims for aspect ratio. But we
    // must not silently drop the frame: observe() resolves this by falling
    // back to get_screen_size before calling here.
    if (!width || !height) return undefined;
    this.counters.screenshotBytes = bytes;
    return {
      computerId: this.computerId,
      revision: ++this.revision,
      viewport: { width, height },
      screenshot: { mediaType, data: image.data },
      status,
    };
  }
}

// ---- pure helpers (unit-tested) -----------------------------------------

export function driverArgs(action: ComputerAction): Record<string, unknown> {
  const target = action.target;
  const base =
    "elementIndex" in target
      ? { element_index: target.elementIndex, snapshot_id: target.snapshotId }
      : { window_id: target.windowId, x: target.x, y: target.y };
  const delivery = { delivery_mode: "background" as const };
  switch (action.kind) {
    case "click":
      return { ...base, ...delivery };
    case "type_text":
      return { ...base, ...delivery, text: action.text };
    case "press_key":
      return { ...base, ...delivery, key: action.key };
    case "scroll":
      return {
        ...base,
        ...delivery,
        direction: action.direction,
        unit: action.amount ?? "line",
      };
  }
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

/**
 * TODO(spike): the real `get_accessibility_tree` response shape is unverified.
 * This accepts the two most likely forms — a bare array of nodes, or
 * `{ snapshot_id, elements: [...] }` — and ignores anything it cannot map.
 */
export function parseAxTree(text: string): {
  snapshotId: string;
  elements: IndexedElement[];
} {
  const json = tryJson(text);
  if (!json) return { snapshotId: "", elements: [] };
  const container = json as Record<string, unknown>;
  const rawList = Array.isArray(json)
    ? json
    : Array.isArray(container.elements)
      ? (container.elements as unknown[])
      : Array.isArray(container.nodes)
        ? (container.nodes as unknown[])
        : [];
  const snapshotId =
    typeof container.snapshot_id === "string"
      ? container.snapshot_id
      : typeof container.snapshotId === "string"
        ? container.snapshotId
        : "";
  const elements: IndexedElement[] = [];
  rawList.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const node = entry as Record<string, unknown>;
    const index =
      typeof node.index === "number"
        ? node.index
        : typeof node.element_index === "number"
          ? node.element_index
          : i;
    const role = pickString(node, ["role", "type", "class"]) || "unknown";
    const name = (
      pickString(node, ["name", "label", "title", "text"]) || ""
    ).slice(0, MAX_ELEMENT_NAME);
    const bounds = parseBounds(node.bounds ?? node.rect ?? node.bbox);
    elements.push(
      bounds ? { index, role, name, bounds } : { index, role, name },
    );
  });
  return { snapshotId, elements };
}

function parseBounds(value: unknown): IndexedElement["bounds"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  const num = (k: string): number =>
    typeof b[k] === "number" ? (b[k] as number) : NaN;
  const x = num("x");
  const y = num("y");
  const width = num("width");
  const height = num("height");
  if ([x, y, width, height].some((n) => Number.isNaN(n))) return undefined;
  return { x, y, width, height };
}

export function parseViewport(
  text: string,
): { width: unknown; height: unknown } | undefined {
  const json = tryJson(text);
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const vp = (obj.viewport ?? obj.screen ?? obj.size) as
    Record<string, unknown> | undefined;
  if (vp && (vp.width !== undefined || vp.height !== undefined))
    return { width: vp.width, height: vp.height };
  if (obj.width !== undefined || obj.height !== undefined)
    return { width: obj.width, height: obj.height };
  return undefined;
}

function pickStructured(content: McpContent[]): unknown {
  const structured = content.find((c) => c.type === "structured");
  return structured?.text ? tryJson(structured.text) : undefined;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof obj[k] === "string") return obj[k] as string;
  return "";
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

function describeTarget(target: ComputerTarget): string {
  return "elementIndex" in target
    ? `element ${target.elementIndex}`
    : `window ${target.windowId} @ ${target.x},${target.y}`;
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
