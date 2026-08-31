/**
 * Stub `cua-driver mcp --direct` for the Virtual Computer end-to-end test.
 * Newline-delimited JSON-RPC over stdin/stdout. Answers exactly the tools
 * ComputerRuntime calls, with shapes matching the checkout's contract docs
 * (docs/action-result-contract.md, action-icon-catalog.md).
 */
import { createInterface } from "node:readline";

// A real 1x1 PNG (67 bytes decoded) — bounded, valid base64.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function toolResult(id, name, args) {
  if (name === "get_desktop_state") {
    // 0.22.2: writes the PNG to a container file, returns dims + the path.
    const path = (args && args.screenshot_out_file) || "/tmp/cua-stub-shot.png";
    return {
      id,
      result: {
        content: [
          {
            type: "text",
            text: `Desktop screenshot 800x600 written to ${path}`,
          },
        ],
        structuredContent: {
          display: "primary",
          platform: "linux",
          scale_factor: 1,
          screen_width: 800,
          screen_height: 600,
          screenshot_file_path: path,
          screenshot_mime_type: "image/png",
          screenshot_width: 800,
          screenshot_height: 600,
        },
      },
    };
  }
  if (name === "list_windows") {
    // Two on-screen windows so observe()'s per-window merge is exercised.
    return {
      id,
      result: {
        content: [{ type: "text", text: "Found 2 windows" }],
        structuredContent: {
          windows: [
            {
              window_id: 111,
              pid: 77,
              title: "xfce4-panel",
              app_name: "Xfce4-panel",
              x: 0,
              y: 0,
              width: 800,
              height: 27,
              is_on_screen: true,
              z_index: 1,
            },
            {
              window_id: 222,
              pid: 88,
              title: "cua - Thunar",
              app_name: "Thunar",
              x: 5,
              y: 56,
              width: 640,
              height: 480,
              is_on_screen: true,
              z_index: 2,
            },
          ],
        },
      },
    };
  }
  if (name === "get_window_state") {
    // 0.22.2 shape: per-window elements[] + a `^s[0-9a-f]{8}$` snapshot_id,
    // element_token = `${snapshot_id}:${element_index}` (per-element).
    const winId = args && args.window_id;
    if (winId === 111) {
      return {
        id,
        result: {
          content: [{ type: "text", text: "window_id=111 pid=77 elements=1" }],
          structuredContent: {
            snapshot_id: "s0000a001",
            element_count: 1,
            elements_complete: true,
            elements: [
              {
                depth: 3,
                element_index: 0,
                element_token: "s0000a001:0",
                enabled: true,
                label: "Applications",
                role: "toggle button",
                frame: { x: 0, y: 0, w: 102, h: 26 },
              },
            ],
            tree_markdown: '- [0] toggle button "Applications"\n',
            window_id: 111,
            pid: 77,
          },
        },
      };
    }
    if (winId === 222) {
      return {
        id,
        result: {
          content: [{ type: "text", text: "window_id=222 pid=88 elements=2" }],
          structuredContent: {
            snapshot_id: "s0000a002",
            element_count: 2,
            elements_complete: false,
            elements: [
              {
                depth: 4,
                element_index: 0,
                element_token: "s0000a002:0",
                enabled: true,
                label: "Home",
                role: "push button",
                frame: { x: 120, y: 85, w: 37, h: 35 },
              },
              // One unlabelled node — observe() orders labelled elements first.
              {
                depth: 5,
                element_index: 1,
                element_token: "s0000a002:1",
                enabled: true,
                label: "",
                role: "table cell",
              },
            ],
            tree_markdown: '- [0] push button "Home"\n- [1] table cell ""\n',
            window_id: 222,
            pid: 88,
          },
        },
      };
    }
    return {
      id,
      result: {
        content: [{ type: "text", text: "no such window" }],
        isError: true,
      },
    };
  }
  if (name === "list_apps") {
    // M3.3: listWindows() folds running apps in beside the window inventory.
    return {
      id,
      result: {
        content: [{ type: "text", text: "Found 3 app(s): 2 running" }],
        structuredContent: {
          apps: [
            { name: "Thunar", pid: 88, running: true },
            { name: "xfce4-panel", pid: 77, running: true },
            { name: "About Xfce", pid: 0, running: false },
          ],
        },
      },
    };
  }
  if (name === "get_screen_size") {
    return {
      id,
      result: {
        content: [{ type: "text", text: "Main display: 800x600 points @ 1x" }],
        structuredContent: { width: 800, height: 600, scale_factor: 1 },
      },
    };
  }
  if (
    [
      "click",
      "double_click",
      "right_click",
      "drag",
      "type_text",
      "press_key",
      "hotkey",
      "scroll",
    ].includes(name)
  ) {
    return {
      id,
      result: {
        content: [],
        structuredContent: {
          effect: "confirmed",
          route: "accessibility",
          delivery: { mode: "background" },
          evidence: [{ kind: "value_readback" }],
        },
      },
    };
  }
  return { id, result: { content: [], isError: true } };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof msg.id !== "number") return; // notification, e.g. notifications/initialized
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "cua-driver-stub", version: "0.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    send(toolResult(msg.id, msg.params?.name, msg.params?.arguments));
    return;
  }
  send({ id: msg.id, result: { content: [], isError: true } });
});
