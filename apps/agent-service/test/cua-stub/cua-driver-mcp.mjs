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
    return {
      id,
      result: {
        content: [{ type: "text", text: "Found 1 window" }],
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
